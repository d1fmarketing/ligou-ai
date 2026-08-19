-- F2: powers ledger (granular grants; colors are DERIVED language), action intents with server-issued idempotency,
-- outbox lease worker, receipts requiring read-back proof, bookings whose 'confirmed' only follows an accepted receipt.

-- ---------------------------------------------------------------- powers ledger
alter table public.tenants add column if not exists auth_epoch int not null default 1;

create table public.powers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  subject text not null check (subject in ('voice_agent','hermes')),
  capability text not null,          -- e.g. create_booking, quote, follow_up_sms, research
  resource text not null default '*',-- service_type or '*'
  conditions jsonb not null default '{}',  -- {geography:[], allowed_hours:{}, channel:[]}
  monetary_limit numeric,
  expires_at timestamptz,
  version int not null default 1,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid
);
create index powers_lookup_idx on public.powers (tenant_id, subject, capability) where revoked_at is null;

alter table public.powers enable row level security;
alter table public.powers force row level security;
create policy powers_owner_select on public.powers for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));

-- ---------------------------------------------------------------- action intents (+ built-in outbox lease)
create table public.action_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  call_id uuid references public.calls (id),
  case_id uuid references public.approval_cases (id),
  booking_id uuid,
  kind text not null check (kind in ('calendar_book','calendar_cancel','notify_owner')),
  payload jsonb not null,
  policy_snapshot jsonb not null default '{}',   -- rule ids, power id, price band, auth_epoch at authorization
  idempotency_key text not null unique,          -- server-issued sha256; never model-supplied
  status text not null check (status in ('authorized','queued','running','succeeded','failed','unknown','cancelled')) default 'authorized',
  attempts int not null default 0,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index intents_worker_idx on public.action_intents (status, next_attempt_at) where status in ('authorized','queued');

alter table public.action_intents enable row level security;
alter table public.action_intents force row level security;
create policy intents_owner_select on public.action_intents for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));

-- ---------------------------------------------------------------- receipts (accepted DEMANDS read-back proof)
create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  intent_id uuid references public.action_intents (id),
  call_id uuid,
  kind text not null check (kind in ('booking','booking_cancel','rule_change','power_change','notification')),
  outcome text not null check (outcome in ('accepted','failed','unknown')),
  external_id text,
  readback jsonb,                 -- reconciliation proof: the resource as read back from the provider
  payload_hash text,
  provider_request jsonb,         -- {request_id, at, latency_ms}
  detail jsonb,
  created_at timestamptz not null default now(),
  constraint receipts_accepted_proof check (
    outcome <> 'accepted' or (external_id is not null and readback is not null and payload_hash is not null)
  )
);
create trigger receipts_append_only before update or delete on public.receipts
  for each row execute function public.block_mutation();

alter table public.receipts enable row level security;
alter table public.receipts force row level security;
create policy receipts_owner_select on public.receipts for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));

-- ---------------------------------------------------------------- bookings
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  call_id uuid references public.calls (id),
  case_id uuid references public.approval_cases (id),
  intent_id uuid references public.action_intents (id),
  client_name text,
  contact text,
  service_type text not null,
  price_agreed numeric,
  slot_start timestamptz not null,
  slot_end timestamptz,
  status text not null default 'proposed'
    check (status in ('proposed','pending_approval','confirmed','failed','unknown','cancelled')),
  calendar_event_id text,
  receipt_id uuid references public.receipts (id),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index bookings_tenant_idx on public.bookings (tenant_id, created_at desc);
alter table public.bookings enable row level security;
alter table public.bookings force row level security;
create policy bookings_owner_select on public.bookings for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));

alter table public.action_intents
  add constraint intents_booking_fk foreign key (booking_id) references public.bookings (id);

-- ---------------------------------------------------------------- notifications (owner feed: usage alerts, summaries)
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  kind text not null check (kind in ('usage_70','usage_90','case_created','summary_ready','booking_confirmed','system')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
alter table public.notifications enable row level security;
alter table public.notifications force row level security;
create policy notifications_owner_all on public.notifications for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));

alter publication supabase_realtime add table public.bookings;
alter publication supabase_realtime add table public.notifications;

-- ---------------------------------------------------------------- hardened RPCs
-- Every definer function: search_path='' ; internal ownership/tenant checks; race-guarded updates; revoked from public/anon.

-- owner decides a case (approve once OR turn into rule). Guarded single-consumption.
create or replace function public.decide_case(
  p_case uuid, p_decision text, p_mode text default 'case',
  p_rule_text text default null, p_rule_structured jsonb default null,
  p_scope text default 'geral', p_duration text default 'permanente'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_case public.approval_cases; v_tenant uuid; v_rule_id uuid; v_rows int;
begin
  select c.* into v_case from public.approval_cases c
    join public.tenants t on t.id = c.tenant_id and t.owner_user_id = auth.uid()
    where c.id = p_case for update;
  if v_case.id is null then raise exception 'case_not_found_or_not_owner'; end if;
  if v_case.status <> 'pendente' then raise exception 'case_already_decided: %', v_case.status; end if;
  if p_decision not in ('aprovada','recusada') then raise exception 'invalid_decision'; end if;

  update public.approval_cases set
    status = p_decision,
    resolved_at = now(),
    resolved_by = auth.uid(),
    resolution = jsonb_build_object('mode', p_mode, 'scope', p_scope, 'duration', p_duration)
  where id = p_case and status = 'pendente';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'case_race_lost'; end if;

  if p_decision = 'aprovada' and p_mode = 'rule' then
    if p_rule_text is null then raise exception 'rule_text_required_for_rule_mode'; end if;
    insert into public.rules (tenant_id, origem, escopo, status, category, text, structured, related_call_id, approved_by, approved_at)
      values (v_case.tenant_id, 'escalacao', p_scope, 'aprovado',
              coalesce(p_rule_structured->>'category','escalacao'), p_rule_text, p_rule_structured,
              v_case.call_id, auth.uid(), now())
      returning id into v_rule_id;
  end if;

  insert into public.receipts (tenant_id, kind, outcome, external_id, readback, payload_hash, detail)
    values (v_case.tenant_id, 'rule_change', 'accepted', p_case::text,
            jsonb_build_object('case_status', p_decision, 'rule_id', v_rule_id),
            md5(coalesce(p_rule_text,'') || p_decision), jsonb_build_object('mode', p_mode));

  -- booking waiting on this case?
  update public.bookings set status = case when p_decision = 'aprovada' then 'proposed' else 'cancelled' end
    where case_id = p_case and status = 'pending_approval';

  return jsonb_build_object('case_id', p_case, 'status', p_decision, 'rule_id', v_rule_id);
end $$;
revoke all on function public.decide_case(uuid,text,text,text,jsonb,text,text) from public, anon;

-- owner decides a suggested rule (memória sugerida -> aprovada/rejeitada) as a NEW version
create or replace function public.decide_rule(p_rule uuid, p_decision text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_rule public.rules; v_new uuid;
begin
  select r.* into v_rule from public.rules r
    join public.tenants t on t.id = r.tenant_id and t.owner_user_id = auth.uid()
    where r.id = p_rule;
  if v_rule.id is null then raise exception 'rule_not_found_or_not_owner'; end if;
  if v_rule.status <> 'sugerido' then raise exception 'rule_not_pending: %', v_rule.status; end if;
  if p_decision not in ('aprovado','rejeitado') then raise exception 'invalid_decision'; end if;
  insert into public.rules (tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured, evidence_quote, related_call_id, approved_by, approved_at)
    values (v_rule.tenant_id, v_rule.rule_group_id, v_rule.version + 1, v_rule.origem, v_rule.escopo,
            p_decision, v_rule.category, v_rule.text, v_rule.structured, v_rule.evidence_quote, v_rule.related_call_id,
            auth.uid(), now())
    returning id into v_new;
  return v_new;
end $$;
revoke all on function public.decide_rule(uuid,text) from public, anon;

-- revoke an approved rule (new version, receipt)
create or replace function public.revoke_rule(p_rule uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_rule public.rules; v_new uuid;
begin
  select r.* into v_rule from public.rules r
    join public.tenants t on t.id = r.tenant_id and t.owner_user_id = auth.uid()
    where r.id = p_rule;
  if v_rule.id is null then raise exception 'rule_not_found_or_not_owner'; end if;
  if v_rule.status <> 'aprovado' then raise exception 'only_approved_can_be_revoked'; end if;
  insert into public.rules (tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured, approved_by, approved_at)
    values (v_rule.tenant_id, v_rule.rule_group_id, v_rule.version + 1, v_rule.origem, v_rule.escopo,
            'revogado', v_rule.category, v_rule.text, v_rule.structured, auth.uid(), now())
    returning id into v_new;
  insert into public.receipts (tenant_id, kind, outcome, external_id, readback, payload_hash, detail)
    values (v_rule.tenant_id, 'rule_change', 'accepted', v_new::text,
            jsonb_build_object('revoked_rule', p_rule), md5(p_rule::text || 'revogado'),
            jsonb_build_object('reason', p_reason));
  return v_new;
end $$;
revoke all on function public.revoke_rule(uuid,text) from public, anon;

-- power grant/revoke (revoke bumps auth_epoch -> invalidates issued capability tokens)
create or replace function public.grant_power(
  p_tenant uuid, p_subject text, p_capability text, p_resource text,
  p_conditions jsonb default '{}', p_monetary_limit numeric default null, p_expires timestamptz default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.tenants t where t.id = p_tenant and t.owner_user_id = auth.uid()) then
    raise exception 'not_tenant_owner';
  end if;
  insert into public.powers (tenant_id, subject, capability, resource, conditions, monetary_limit, expires_at, granted_by)
    values (p_tenant, p_subject, p_capability, p_resource, coalesce(p_conditions,'{}'::jsonb), p_monetary_limit, p_expires, auth.uid())
    returning id into v_id;
  insert into public.receipts (tenant_id, kind, outcome, external_id, readback, payload_hash)
    values (p_tenant, 'power_change', 'accepted', v_id::text, jsonb_build_object('op','grant','capability',p_capability), md5(v_id::text));
  return v_id;
end $$;
revoke all on function public.grant_power(uuid,text,text,text,jsonb,numeric,timestamptz) from public, anon;

create or replace function public.revoke_power(p_power uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  select p.tenant_id into v_tenant from public.powers p
    join public.tenants t on t.id = p.tenant_id and t.owner_user_id = auth.uid()
    where p.id = p_power and p.revoked_at is null;
  if v_tenant is null then raise exception 'power_not_found_or_not_owner'; end if;
  update public.powers set revoked_at = now(), revoked_by = auth.uid() where id = p_power;
  update public.tenants set auth_epoch = auth_epoch + 1 where id = v_tenant;
  insert into public.receipts (tenant_id, kind, outcome, external_id, readback, payload_hash)
    values (v_tenant, 'power_change', 'accepted', p_power::text, jsonb_build_object('op','revoke'), md5(p_power::text || 'revoke'));
end $$;
revoke all on function public.revoke_power(uuid) from public, anon;

-- worker lease claim (service-role only; skip-locked)
create or replace function public.claim_intent(p_worker text) returns setof public.action_intents
language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.action_intents ai set
    status = 'running', attempts = ai.attempts + 1, lease_until = now() + interval '90 seconds',
    last_error = null
  where ai.id = (
    select i.id from public.action_intents i
    where i.status in ('authorized','queued','unknown')
      and i.next_attempt_at <= now()
      and (i.lease_until is null or i.lease_until < now())
      and i.attempts < 5
    order by i.created_at
    for update skip locked
    limit 1
  )
  returning ai.*;
end $$;
revoke all on function public.claim_intent(text) from public, anon, authenticated;

-- seed initial powers for Rocha Plumbing (booking within table bands; emergency = AMARELO handled via cases)
insert into public.powers (tenant_id, subject, capability, resource, conditions, monetary_limit)
select 'a0000000-0000-4000-8000-000000000001', 'voice_agent', 'create_booking', s.service_type,
       jsonb_build_object('geography', array['Anaheim','Santa Ana','Irvine','Orange','Tustin','Costa Mesa'],
                          'allowed_hours', jsonb_build_object('days','mon-sat','open','08:00','close','18:00')),
       s.limit_usd
from (values
  ('plumbing_diagnostic', 129::numeric), ('drain_cleaning', 225::numeric), ('water_heater_repair', 450::numeric),
  ('water_heater_install', 750::numeric), ('leak_repair', 320::numeric), ('repipe_estimate', 0::numeric)
) as s(service_type, limit_usd);
insert into public.powers (tenant_id, subject, capability, resource)
values ('a0000000-0000-4000-8000-000000000001', 'hermes', 'research', '*'),
       ('a0000000-0000-4000-8000-000000000001', 'hermes', 'working_memory', '*'),
       ('a0000000-0000-4000-8000-000000000001', 'hermes', 'draft_follow_up', '*');
