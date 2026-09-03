-- Recover only an abandoned, stale subscription-quota ambiguity. The probe
-- is elected and receipted separately from customer jobs and ordinary quota
-- reservations; only measured terminal subscription usage can reopen quota.

begin;

alter table public.company_discovery_subscription_governors
  add column quota_unknown_since timestamp with time zone;

update public.company_discovery_subscription_governors
set quota_unknown_since = updated_at
where quota_state = 'unknown';

create or replace function public.sync_company_discovery_quota_unknown_since()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.quota_state = 'unknown' then
    new.quota_unknown_since := coalesce(old.quota_unknown_since, clock_timestamp());
  else
    new.quota_unknown_since := null;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_company_discovery_quota_unknown_since()
  from public, anon, authenticated, service_role;

create trigger company_discovery_quota_unknown_since_sync
  before update of quota_state
  on public.company_discovery_subscription_governors
  for each row execute function public.sync_company_discovery_quota_unknown_since();

alter table public.company_discovery_subscription_governors
  add constraint company_discovery_subscription_governors_unknown_since_check
  check (
    (quota_state = 'unknown' and quota_unknown_since is not null)
    or (quota_state <> 'unknown' and quota_unknown_since is null)
  );

create table public.company_discovery_subscription_quota_recovery_probes (
  id uuid primary key default gen_random_uuid(),
  credential_owner_id uuid not null,
  credential_generation bigint not null check (credential_generation > 0),
  expected_account_hash text not null
    check (expected_account_hash ~ '^[0-9a-f]{64}$'),
  recovery_generation bigint not null check (recovery_generation > 0),
  provider text not null default 'openai-codex'
    check (provider = 'openai-codex'),
  auth_kind text not null default 'chatgpt_subscription_oauth'
    check (auth_kind = 'chatgpt_subscription_oauth'),
  model text not null default 'gpt-5.6-sol'
    check (model = 'gpt-5.6-sol'),
  billing_basis text not null default 'chatgpt_subscription'
    check (billing_basis = 'chatgpt_subscription'),
  marginal_api_charge_usd numeric not null default 0
    check (marginal_api_charge_usd = 0),
  worker_id text not null check (length(worker_id) between 1 and 200),
  claim_token_hash bytea not null,
  status text not null default 'running'
    check (status in ('running','succeeded','ambiguous')),
  lease_until timestamp with time zone not null,
  observation jsonb,
  terminal_reason text check (terminal_reason in (
    'probe_succeeded',
    'probe_grant_failed',
    'probe_provider_failed',
    'probe_usage_ambiguous',
    'probe_context_changed',
    'probe_lease_expired'
  )),
  next_probe_at timestamp with time zone,
  claimed_at timestamp with time zone not null default now(),
  terminal_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  foreign key (credential_owner_id, credential_generation)
    references public.company_discovery_subscription_governors (
      credential_owner_id, credential_generation
    ),
  unique (credential_owner_id, credential_generation, recovery_generation),
  check (lease_until > claimed_at),
  check (
    (status = 'running'
      and observation is null
      and terminal_reason is null
      and next_probe_at is null
      and terminal_at is null)
    or (status = 'succeeded'
      and jsonb_typeof(observation) = 'object'
      and terminal_reason = 'probe_succeeded'
      and next_probe_at is null
      and terminal_at is not null)
    or (status = 'ambiguous'
      and jsonb_typeof(observation) = 'object'
      and terminal_reason is not null
      and terminal_reason <> 'probe_succeeded'
      and next_probe_at > terminal_at
      and terminal_at is not null)
  )
);

create unique index company_discovery_subscription_quota_one_running_probe
  on public.company_discovery_subscription_quota_recovery_probes (
    credential_owner_id, credential_generation
  ) where status = 'running';

create index company_discovery_subscription_quota_probe_backoff
  on public.company_discovery_subscription_quota_recovery_probes (
    credential_owner_id, credential_generation, next_probe_at desc
  ) where status = 'ambiguous';

create or replace function public.guard_company_discovery_quota_recovery_probe()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.status = 'running'
     and new.status in ('succeeded','ambiguous')
     and (to_jsonb(new) - array[
       'status','observation','terminal_reason','next_probe_at','terminal_at'
     ]::text[]) is not distinct from (to_jsonb(old) - array[
       'status','observation','terminal_reason','next_probe_at','terminal_at'
     ]::text[]) then
    return new;
  end if;
  raise exception using errcode = '55000',
    message = 'company_discovery_quota_recovery_probe_immutable';
end;
$$;

revoke all on function public.guard_company_discovery_quota_recovery_probe()
  from public, anon, authenticated, service_role;

create trigger company_discovery_subscription_quota_probe_guard
  before update or delete
  on public.company_discovery_subscription_quota_recovery_probes
  for each row execute function public.guard_company_discovery_quota_recovery_probe();

alter table public.company_discovery_subscription_quota_recovery_probes
  enable row level security;
alter table public.company_discovery_subscription_quota_recovery_probes
  force row level security;

revoke all on table public.company_discovery_subscription_quota_recovery_probes
  from public, anon, authenticated, service_role;
grant select on table public.company_discovery_subscription_quota_recovery_probes
  to service_role;

create or replace function public.claim_company_discovery_subscription_quota_recovery(
  p_worker_id text,
  p_credential_owner uuid,
  p_credential_generation bigint,
  p_expected_account_hash text,
  p_lease_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_governor public.company_discovery_subscription_governors;
  v_running public.company_discovery_subscription_quota_recovery_probes;
  v_probe_id uuid := gen_random_uuid();
  v_claim_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_generation bigint;
  v_now timestamp with time zone := clock_timestamp();
  v_not_before timestamp with time zone;
  v_lease_until timestamp with time zone;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
     or length(p_worker_id) > 200
     or p_credential_owner is null
     or p_credential_generation is null or p_credential_generation < 1
     or p_expected_account_hash is null
     or p_expected_account_hash !~ '^[0-9a-f]{64}$'
     or p_lease_seconds is null or p_lease_seconds not between 15 and 120 then
    raise exception using errcode = '22023',
      message = 'company_discovery_quota_recovery_claim_invalid';
  end if;

  select g.* into v_governor
  from public.company_discovery_subscription_governors g
  where g.credential_owner_id = p_credential_owner
    and g.credential_generation = p_credential_generation
  for update;
  if v_governor.credential_owner_id is null
     or v_governor.expected_account_hash is distinct from p_expected_account_hash then
    return null;
  end if;
  if not exists (
    select 1
    from public.company_discovery_subscription_bindings b
    join public.company_discovery_allowlist a
      on a.tenant_id = b.tenant_id
      and a.active
      and (a.expires_at is null or a.expires_at > v_now)
    join public.company_discovery_controls c
      on c.singleton and c.enabled
    where b.credential_owner_id = p_credential_owner
      and b.credential_generation = p_credential_generation
      and b.expected_account_hash = p_expected_account_hash
      and b.provider = 'openai-codex'
      and b.auth_kind = 'chatgpt_subscription_oauth'
      and b.model = 'gpt-5.6-sol'
      and b.active
  ) then
    return case when v_governor.quota_state = 'unknown'
      then jsonb_build_object('state', 'blocked') else null end;
  end if;

  select p.* into v_running
  from public.company_discovery_subscription_quota_recovery_probes p
  where p.credential_owner_id = p_credential_owner
    and p.credential_generation = p_credential_generation
    and p.status = 'running'
  order by p.recovery_generation desc
  limit 1
  for update;
  if v_running.id is not null then
    if v_running.lease_until > v_now then
      return jsonb_build_object('state', 'blocked');
    end if;
    update public.company_discovery_subscription_quota_recovery_probes
    set status = 'ambiguous',
        observation = jsonb_build_object(
          'request_sha256', null,
          'response_sha256', null,
          'request_bytes', 0,
          'response_bytes', 0,
          'input_tokens', null,
          'output_tokens', null,
          'total_tokens', null,
          'usage_complete', false,
          'terminal_complete', false
        ),
        terminal_reason = 'probe_lease_expired',
        next_probe_at = v_now + interval '1 hour',
        terminal_at = v_now
    where id = v_running.id and status = 'running';
    update public.company_discovery_subscription_governors
    set updated_at = v_now
    where credential_owner_id = p_credential_owner
      and credential_generation = p_credential_generation;
    return jsonb_build_object('state', 'blocked');
  end if;

  select greatest(
      coalesce(v_governor.window_ends_at, '-infinity'::timestamptz),
      coalesce(v_governor.quota_unknown_since + interval '1 hour',
        'infinity'::timestamptz),
      coalesce(max(p.next_probe_at), '-infinity'::timestamptz)
    ) into v_not_before
  from public.company_discovery_subscription_quota_recovery_probes p
  where p.credential_owner_id = p_credential_owner
    and p.credential_generation = p_credential_generation;
  if v_governor.quota_state <> 'unknown'
     or v_governor.quota_unknown_since is null
     or v_not_before > v_now
     or v_governor.active_requests <> 0
     or v_governor.reserved_requests <> 0
     or exists (
       select 1
       from public.company_discovery_subscription_reservations r
       where r.credential_owner_id = p_credential_owner
         and r.credential_generation = p_credential_generation
         and r.state = 'reserved'
     )
     or exists (
       select 1
       from public.worker_jobs j
       join public.company_discovery_subscription_bindings b
         on b.tenant_id = j.tenant_id
       where b.credential_owner_id = p_credential_owner
         and b.credential_generation = p_credential_generation
         and b.active
         and j.status in ('queued','running')
     )
     or exists (
       select 1
       from public.worker_attempts wa
       join public.worker_jobs j on j.id = wa.job_id
       join public.company_discovery_subscription_bindings b
         on b.tenant_id = j.tenant_id
       where b.credential_owner_id = p_credential_owner
         and b.credential_generation = p_credential_generation
         and b.active
         and (
           wa.claimed_at >= v_governor.window_started_at
           or exists (
             select 1
             from public.company_discovery_subscription_reservations rr
             where rr.attempt_id = wa.id
               and rr.credential_owner_id = p_credential_owner
               and rr.credential_generation = p_credential_generation
           )
         )
         and (wa.status = 'running' or wa.cleanup_state <> 'proved')
     ) then
    return case when v_governor.quota_state = 'unknown'
      then jsonb_build_object('state', 'blocked') else null end;
  end if;

  select coalesce(max(p.recovery_generation), 0) + 1
    into v_generation
  from public.company_discovery_subscription_quota_recovery_probes p
  where p.credential_owner_id = p_credential_owner
    and p.credential_generation = p_credential_generation;
  v_lease_until := v_now + make_interval(secs => p_lease_seconds);
  insert into public.company_discovery_subscription_quota_recovery_probes (
    id, credential_owner_id, credential_generation, expected_account_hash,
    recovery_generation, worker_id, claim_token_hash, lease_until,
    claimed_at, created_at
  ) values (
    v_probe_id, p_credential_owner, p_credential_generation,
    p_expected_account_hash, v_generation, btrim(p_worker_id),
    extensions.digest(v_claim_token, 'sha256'), v_lease_until, v_now, v_now
  );
  return jsonb_build_object(
    'probe_id', v_probe_id,
    'recovery_generation', v_generation,
    'claim_token', v_claim_token,
    'lease_until', v_lease_until,
    'deadline_at', v_lease_until,
    'credential_owner_id', p_credential_owner,
    'credential_generation', p_credential_generation,
    'expected_account_hash', p_expected_account_hash,
    'provider', 'openai-codex',
    'auth_kind', 'chatgpt_subscription_oauth',
    'model', 'gpt-5.6-sol'
  );
end;
$$;

revoke all on function public.claim_company_discovery_subscription_quota_recovery(text,uuid,bigint,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_company_discovery_subscription_quota_recovery(text,uuid,bigint,text,integer)
  to service_role;

create or replace function public.settle_company_discovery_subscription_quota_recovery(
  p_probe_id uuid,
  p_recovery_generation bigint,
  p_claim_token text,
  p_outcome text,
  p_terminal_reason text,
  p_observation jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_probe_identity public.company_discovery_subscription_quota_recovery_probes;
  v_probe public.company_discovery_subscription_quota_recovery_probes;
  v_governor public.company_discovery_subscription_governors;
  v_now timestamp with time zone := clock_timestamp();
  v_status text;
  v_reason text;
  v_next timestamp with time zone;
  v_safe boolean;
begin
  if p_probe_id is null
     or p_recovery_generation is null or p_recovery_generation < 1
     or p_claim_token is null or length(p_claim_token) <> 64
     or p_claim_token !~ '^[0-9a-f]{64}$'
     or p_outcome not in ('available','unknown')
     or p_terminal_reason not in (
       'probe_succeeded','probe_grant_failed','probe_provider_failed',
       'probe_usage_ambiguous','probe_context_changed','probe_lease_expired'
     )
     or jsonb_typeof(p_observation) <> 'object'
     or not (p_observation ?& array[
       'request_sha256','response_sha256','request_bytes','response_bytes',
       'input_tokens','output_tokens','total_tokens','usage_complete',
       'terminal_complete'
     ])
     or (p_observation - array[
       'request_sha256','response_sha256','request_bytes','response_bytes',
       'input_tokens','output_tokens','total_tokens','usage_complete',
       'terminal_complete'
     ]::text[]) <> '{}'::jsonb
     or not (
       p_observation->'request_sha256' = 'null'::jsonb
       or p_observation->>'request_sha256' ~ '^[0-9a-f]{64}$'
     )
     or not (
       p_observation->'response_sha256' = 'null'::jsonb
       or p_observation->>'response_sha256' ~ '^[0-9a-f]{64}$'
     )
     or jsonb_typeof(p_observation->'request_bytes') <> 'number'
     or (p_observation->>'request_bytes') !~ '^[0-9]+$'
     or (p_observation->>'request_bytes')::bigint not between 0 and 4096
     or jsonb_typeof(p_observation->'response_bytes') <> 'number'
     or (p_observation->>'response_bytes') !~ '^[0-9]+$'
     or (p_observation->>'response_bytes')::bigint not between 0 and 32768
     or jsonb_typeof(p_observation->'usage_complete') <> 'boolean'
     or jsonb_typeof(p_observation->'terminal_complete') <> 'boolean'
     or exists (
       select 1
       from jsonb_each(p_observation) item
       where item.key in ('input_tokens','output_tokens','total_tokens')
         and item.value <> 'null'::jsonb
         and (
           jsonb_typeof(item.value) <> 'number'
           or (item.value #>> '{}') !~ '^[0-9]+$'
           or (item.value #>> '{}')::numeric > 1000000
         )
     ) then
    raise exception using errcode = '22023',
      message = 'company_discovery_quota_recovery_settlement_invalid';
  end if;
  if p_outcome = 'available' and (
       p_terminal_reason <> 'probe_succeeded'
       or (p_observation->>'usage_complete')::boolean is not true
       or (p_observation->>'terminal_complete')::boolean is not true
       or p_observation->'request_sha256' = 'null'::jsonb
       or p_observation->'response_sha256' = 'null'::jsonb
       or p_observation->'input_tokens' = 'null'::jsonb
       or p_observation->'output_tokens' = 'null'::jsonb
       or p_observation->'total_tokens' = 'null'::jsonb
       or (p_observation->>'total_tokens')::bigint <>
          (p_observation->>'input_tokens')::bigint +
          (p_observation->>'output_tokens')::bigint
     ) then
    raise exception using errcode = '22023',
      message = 'company_discovery_quota_recovery_success_unproved';
  end if;

  -- Probe identity is immutable. Read it without a tuple lock, then acquire
  -- the same governor -> probe order used by the claim RPC before re-reading
  -- the probe under lock. This avoids a claim/settlement lock inversion.
  select p.* into v_probe_identity
  from public.company_discovery_subscription_quota_recovery_probes p
  where p.id = p_probe_id
    and p.recovery_generation = p_recovery_generation;
  if v_probe_identity.id is null then
    raise exception using errcode = '55000',
      message = 'company_discovery_quota_recovery_probe_not_current';
  end if;
  select g.* into v_governor
  from public.company_discovery_subscription_governors g
  where g.credential_owner_id = v_probe_identity.credential_owner_id
    and g.credential_generation = v_probe_identity.credential_generation
  for update;
  if v_governor.credential_owner_id is null then
    raise exception using errcode = '55000',
      message = 'company_discovery_subscription_governor_missing';
  end if;
  select p.* into v_probe
  from public.company_discovery_subscription_quota_recovery_probes p
  where p.id = p_probe_id
    and p.recovery_generation = p_recovery_generation
  for update;
  if v_probe.id is null
     or v_probe.credential_owner_id is distinct from v_governor.credential_owner_id
     or v_probe.credential_generation is distinct from v_governor.credential_generation
     or v_probe.expected_account_hash is distinct from v_governor.expected_account_hash then
    raise exception using errcode = '55000',
      message = 'company_discovery_quota_recovery_probe_not_current';
  end if;
  if v_probe.claim_token_hash is distinct from
       extensions.digest(p_claim_token, 'sha256') then
    raise exception using errcode = '42501',
      message = 'company_discovery_quota_recovery_claim_invalid';
  end if;
  if v_probe.status <> 'running' then
    if v_probe.observation is not distinct from p_observation
       and (
         (p_outcome = 'available' and v_probe.status = 'succeeded'
           and v_probe.terminal_reason = 'probe_succeeded')
         or (p_outcome = 'available' and p_terminal_reason = 'probe_succeeded'
           and v_probe.status = 'ambiguous'
           and v_probe.terminal_reason in (
             'probe_context_changed','probe_lease_expired'
           ))
         or (p_outcome = 'unknown' and v_probe.status = 'ambiguous'
           and v_probe.terminal_reason = p_terminal_reason)
       ) then
      return jsonb_build_object(
        'probe_id', v_probe.id,
        'recovery_generation', v_probe.recovery_generation,
        'status', v_probe.status,
        'quota_state', case when v_probe.status = 'succeeded'
          then 'available' else 'unknown' end,
        'next_probe_at', v_probe.next_probe_at,
        'governor_recovered', v_probe.status = 'succeeded'
      );
    end if;
    raise exception using errcode = '55000',
      message = 'company_discovery_quota_recovery_settlement_conflict';
  end if;
  v_safe := v_probe.lease_until > v_now
    and v_governor.quota_state = 'unknown'
    and v_governor.active_requests = 0
    and v_governor.reserved_requests = 0
    and not exists (
      select 1
      from public.company_discovery_subscription_reservations r
      where r.credential_owner_id = v_probe.credential_owner_id
        and r.credential_generation = v_probe.credential_generation
        and r.state = 'reserved'
    )
    and not exists (
      select 1
      from public.worker_jobs j
      join public.company_discovery_subscription_bindings b
        on b.tenant_id = j.tenant_id
      where b.credential_owner_id = v_probe.credential_owner_id
        and b.credential_generation = v_probe.credential_generation
        and b.active
        and j.status in ('queued','running')
    );
  if p_outcome = 'available' and v_safe then
    v_status := 'succeeded';
    v_reason := 'probe_succeeded';
    v_next := null;
  else
    v_status := 'ambiguous';
    v_reason := case
      when v_probe.lease_until <= v_now then 'probe_lease_expired'
      when p_outcome = 'available' then 'probe_context_changed'
      else p_terminal_reason
    end;
    v_next := v_now + interval '1 hour';
  end if;

  update public.company_discovery_subscription_quota_recovery_probes
  set status = v_status,
      observation = p_observation,
      terminal_reason = v_reason,
      next_probe_at = v_next,
      terminal_at = v_now
  where id = v_probe.id and status = 'running';
  if not found then
    raise exception using errcode = '40001',
      message = 'company_discovery_quota_recovery_race_lost';
  end if;

  if v_status = 'succeeded' then
    update public.company_discovery_subscription_governors
    set window_started_at = v_now,
        window_ends_at = v_now + interval '1 hour',
        settled_requests = 1,
        settled_input_bytes = (p_observation->>'request_bytes')::bigint,
        settled_output_bytes = (p_observation->>'response_bytes')::bigint,
        reserved_requests = 0,
        reserved_input_bytes = 0,
        reserved_output_bytes = 0,
        active_requests = 0,
        quota_state = 'available',
        cooldown_until = null,
        updated_at = v_now
    where credential_owner_id = v_probe.credential_owner_id
      and credential_generation = v_probe.credential_generation
      and quota_state = 'unknown'
      and active_requests = 0
      and reserved_requests = 0;
    if not found then
      raise exception using errcode = '40001',
        message = 'company_discovery_quota_recovery_race_lost';
    end if;
  else
    update public.company_discovery_subscription_governors
    set updated_at = v_now
    where credential_owner_id = v_probe.credential_owner_id
      and credential_generation = v_probe.credential_generation;
  end if;

  return jsonb_build_object(
    'probe_id', v_probe.id,
    'recovery_generation', v_probe.recovery_generation,
    'status', v_status,
    'quota_state', case when v_status = 'succeeded'
      then 'available' else 'unknown' end,
    'next_probe_at', v_next,
    'governor_recovered', v_status = 'succeeded'
  );
end;
$$;

revoke all on function public.settle_company_discovery_subscription_quota_recovery(uuid,bigint,text,text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.settle_company_discovery_subscription_quota_recovery(uuid,bigint,text,text,text,jsonb)
  to service_role;

commit;
