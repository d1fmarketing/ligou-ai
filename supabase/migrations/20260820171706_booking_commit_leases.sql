-- Serialize final calendar commitment for each tenant/time range. The exclusion
-- is the database authority; worker-local mutexes cannot protect multiple EC2
-- processes. Unknown provider outcomes retain the lease for reconciliation.
create extension if not exists btree_gist with schema extensions;

alter table public.action_intents
  add column execution_mode text not null default 'write'
  check (execution_mode in ('write','reconcile'));

alter table public.fake_calendar_events
  add column if not exists booking_id uuid references public.bookings (id),
  add column if not exists status text not null default 'confirmed' check (status = 'confirmed'),
  add column if not exists account_id text not null default 'ligou-fake',
  add column if not exists calendar_id text,
  add column if not exists payload_hash text;

update public.fake_calendar_events f
set calendar_id = 'tenant:' || f.tenant_id::text
where f.calendar_id is null;

alter table public.fake_calendar_events alter column calendar_id set not null;

create table public.booking_slot_leases (
  intent_id uuid primary key references public.action_intents (id),
  booking_id uuid not null unique references public.bookings (id),
  tenant_id uuid not null references public.tenants (id),
  slot_start timestamptz not null,
  slot_end timestamptz not null check (slot_end > slot_start),
  slot_range tstzrange generated always as (tstzrange(slot_start, slot_end, '[)')) stored,
  state text not null default 'held' check (state in ('held','committed')),
  acquired_at timestamptz not null default now(),
  committed_at timestamptz,
  exclude using gist (tenant_id with =, slot_range with &&)
);
alter table public.booking_slot_leases enable row level security;
alter table public.booking_slot_leases force row level security;

create or replace function public.prepare_booking_provider_write(p_intent uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.action_intents;
  v_booking public.bookings;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  -- Consume Task 3's exact power/rule/epoch validator inside this same
  -- transaction, then hold the slot exclusion before returning to the worker.
  if not public.validate_booking_intent_authority(p_intent) then return false; end if;

  select ai.* into v_intent from public.action_intents ai where ai.id = p_intent for update;
  select b.* into v_booking from public.bookings b
  where b.id = v_intent.booking_id and b.tenant_id = v_intent.tenant_id for update;
  if v_intent.execution_mode <> 'write' or v_booking.id is null or v_booking.status <> 'proposed' then
    return false;
  end if;

  if exists (select 1 from public.booking_slot_leases l where l.intent_id = p_intent) then return true; end if;
  begin
    insert into public.booking_slot_leases (intent_id, booking_id, tenant_id, slot_start, slot_end)
    values (v_intent.id, v_booking.id, v_booking.tenant_id, v_booking.slot_start, v_booking.slot_end);
  exception when exclusion_violation then
    update public.action_intents ai set
      status = 'failed', last_error = 'slot_lease_conflict', finished_at = now(), lease_until = null
    where ai.id = v_intent.id and ai.status = 'running';
    update public.bookings b set status = 'failed'
    where b.id = v_booking.id and b.status = 'proposed';
    return false;
  end;
  return true;
end;
$$;

revoke all on function public.prepare_booking_provider_write(uuid) from public, anon, authenticated;
grant execute on function public.prepare_booking_provider_write(uuid) to service_role;

create or replace function public.release_booking_slot_lease(p_intent uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  delete from public.booking_slot_leases l where l.intent_id = p_intent and l.state = 'held';
end;
$$;

revoke all on function public.release_booking_slot_lease(uuid) from public, anon, authenticated;
grant execute on function public.release_booking_slot_lease(uuid) to service_role;

create or replace function public.commit_booking_slot_lease(p_intent uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  update public.booking_slot_leases l
  set state = 'committed', committed_at = coalesce(l.committed_at, now())
  where l.intent_id = p_intent;
end;
$$;

revoke all on function public.commit_booking_slot_lease(uuid) from public, anon, authenticated;
grant execute on function public.commit_booking_slot_lease(uuid) to service_role;

-- One authoritative booking receipt per intent, even if a worker process loses
-- its acknowledgement after the insert and the action is observed again.
create unique index receipts_one_booking_per_intent
  on public.receipts (intent_id) where kind = 'booking';

create or replace function public.claim_intent(p_worker text)
returns setof public.action_intents
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  update public.action_intents ai set
    status = 'failed', last_error = 'authority_stale_before_claim', finished_at = now(), lease_until = null
  where ai.status in ('authorized','queued','unknown')
    and ai.kind = 'calendar_book'
    and not (
      exists (
        select 1 from public.tenants t where t.id = ai.tenant_id
          and t.auth_epoch = (ai.policy_snapshot->>'auth_epoch')::integer
          and t.policy_epoch = (ai.policy_snapshot->>'policy_epoch')::integer
      )
      and exists (
        select 1 from public.powers p where p.id = (ai.policy_snapshot->>'power_id')::uuid
          and p.tenant_id = ai.tenant_id and p.revoked_at is null
      )
      and exists (
        select 1 from public.effective_rules er where er.id = (ai.policy_snapshot->>'rule_id')::uuid
          and er.tenant_id = ai.tenant_id
      )
    );

  return query
  with candidate as (
    select i.id, i.status as prior_status from public.action_intents i
    where (
      i.status in ('authorized','queued','unknown')
      or (i.status = 'running' and i.lease_until < now())
    )
      and i.next_attempt_at <= now()
      and (i.lease_until is null or i.lease_until < now())
      and i.attempts < 5
    order by i.created_at
    for update skip locked
    limit 1
  )
  update public.action_intents ai set
    status = 'running', attempts = ai.attempts + 1,
    lease_until = now() + interval '90 seconds', last_error = null,
    execution_mode = case when candidate.prior_status = 'unknown' then 'reconcile' else ai.execution_mode end
  from candidate where ai.id = candidate.id
  returning ai.*;
end;
$$;

revoke all on function public.claim_intent(text) from public, anon, authenticated;
grant execute on function public.claim_intent(text) to service_role;
