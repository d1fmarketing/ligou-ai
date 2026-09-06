-- Post-call text summaries use the Hermes-owned ChatGPT/Codex subscription.
-- The database leases each call so concurrent controller loops cannot spend
-- shared subscription quota on the same transcript.

alter table public.calls
  add column if not exists summary_claim_token_hash bytea,
  add column if not exists summary_claimed_by text,
  add column if not exists summary_claimed_at timestamp with time zone,
  add column if not exists summary_lease_until timestamp with time zone,
  add column if not exists summary_retry_at timestamp with time zone;

alter table public.calls
  drop constraint if exists calls_summary_claim_shape,
  add constraint calls_summary_claim_shape check (
    (
      summary_claim_token_hash is null
      and summary_claimed_by is null
      and summary_claimed_at is null
      and summary_lease_until is null
    )
    or (
      summary_status = 'pending_ingest'
      and summary_claim_token_hash is not null
      and summary_claimed_by is not null
      and btrim(summary_claimed_by) <> ''
      and summary_claimed_at is not null
      and summary_lease_until > summary_claimed_at
    )
  );

alter table public.calls
  drop constraint if exists calls_summary_retry_shape,
  add constraint calls_summary_retry_shape check (
    summary_status = 'pending_ingest' or summary_retry_at is null
  );

create index if not exists calls_summary_subscription_claimable_idx
  on public.calls (ended_at, id)
  where summary_status = 'pending_ingest';

create or replace function public.claim_call_summary_subscription(
  p_worker_id text,
  p_lease_seconds integer
) returns table (
  call_id uuid,
  tenant_id uuid,
  tenant_slug text,
  transcript jsonb,
  test_memory_generation bigint,
  attempt_number integer,
  claim_token text,
  lease_until timestamp with time zone
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call public.calls;
  v_call_id uuid;
  v_tenant_id uuid;
  v_tenant_slug text;
  v_tenant_generation bigint;
  v_claim_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_now timestamp with time zone := clock_timestamp();
  v_lease_until timestamp with time zone;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
     or length(btrim(p_worker_id)) > 200
     or p_lease_seconds is null or p_lease_seconds not between 10 and 120 then
    raise exception using errcode = '22023',
      message = 'call_summary_subscription_claim_invalid';
  end if;

  -- A reset rotates the tenant generation. Old calls stay auditable but can
  -- never emit a notification into the new generation.
  update public.calls c
  set summary_status = 'failed',
      summary_claim_token_hash = null,
      summary_claimed_by = null,
      summary_claimed_at = null,
      summary_lease_until = null,
      summary_retry_at = null
  from public.tenants t
  where t.id = c.tenant_id
    and c.test_memory_generation <> t.test_memory_generation
    and c.summary_status = 'pending_ingest';

  update public.calls c
  set summary_status = 'failed',
      summary_claim_token_hash = null,
      summary_claimed_by = null,
      summary_claimed_at = null,
      summary_lease_until = null,
      summary_retry_at = null
  from public.tenants t
  where t.id = c.tenant_id
    and t.slug !~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'
    and c.summary_status = 'pending_ingest';

  -- A worker that crashed after its third subscription attempt cannot leave a
  -- call claimable forever. The expired lease becomes the terminal evidence.
  update public.calls
  set summary_status = 'failed',
      summary_claim_token_hash = null,
      summary_claimed_by = null,
      summary_claimed_at = null,
      summary_lease_until = null,
      summary_retry_at = null
  where summary_status = 'pending_ingest'
    and summary_attempts >= 3
    and (summary_lease_until is null or summary_lease_until <= v_now);

  v_now := clock_timestamp();
  select c.id, c.tenant_id, t.slug, t.test_memory_generation
    into v_call_id, v_tenant_id, v_tenant_slug, v_tenant_generation
  from public.calls c
  join public.tenants t on t.id = c.tenant_id
  where c.summary_status = 'pending_ingest'
    and c.ended_at is not null
    and jsonb_typeof(c.transcript) = 'array'
    and c.test_memory_generation = t.test_memory_generation
    and c.summary_attempts < 3
    and (c.summary_retry_at is null or c.summary_retry_at <= v_now)
    and (c.summary_lease_until is null or c.summary_lease_until <= v_now)
  order by c.ended_at, c.id
  limit 1
  for update of t skip locked;

  if v_call_id is null then return; end if;
  select c.* into v_call
  from public.calls c
  where c.id = v_call_id
    and c.tenant_id = v_tenant_id
    and c.summary_status = 'pending_ingest'
    and c.ended_at is not null
    and jsonb_typeof(c.transcript) = 'array'
    and c.test_memory_generation = v_tenant_generation
    and c.summary_attempts < 3
    and (c.summary_retry_at is null or c.summary_retry_at <= clock_timestamp())
    and (c.summary_lease_until is null or c.summary_lease_until <= clock_timestamp())
  for update;
  if v_call.id is null then return; end if;
  if v_tenant_slug is null or v_tenant_slug !~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'
     or v_tenant_generation is distinct from v_call.test_memory_generation then
    raise exception using errcode = '55000',
      message = 'call_summary_subscription_tenant_invalid';
  end if;
  v_now := clock_timestamp();
  v_lease_until := v_now + make_interval(secs => p_lease_seconds);

  update public.calls
  set summary_attempts = summary_attempts + 1,
      summary_claim_token_hash = extensions.digest(v_claim_token, 'sha256'),
      summary_claimed_by = btrim(p_worker_id),
      summary_claimed_at = v_now,
      summary_lease_until = v_lease_until,
      summary_retry_at = null
  where id = v_call.id;

  return query select
    v_call.id,
    v_call.tenant_id,
    v_tenant_slug,
    v_call.transcript,
    v_call.test_memory_generation,
    v_call.summary_attempts + 1,
    v_claim_token,
    v_lease_until;
end;
$$;

revoke all on function public.claim_call_summary_subscription(text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_call_summary_subscription(text,integer)
  to service_role;

create or replace function public.complete_call_summary_subscription(
  p_call_id uuid,
  p_expected_generation bigint,
  p_claim_token text,
  p_outcome text,
  p_summary_pt text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call public.calls;
  v_tenant_id uuid;
  v_tenant_generation bigint;
  v_next_status text;
  v_retry_at timestamp with time zone;
begin
  if p_call_id is null
     or p_expected_generation is null or p_expected_generation < 0
     or p_claim_token is null or length(p_claim_token) <> 64
     or p_claim_token !~ '^[0-9a-f]{64}$'
     or p_outcome is null or p_outcome not in ('ready', 'retry')
     or (p_outcome = 'ready' and (
       p_summary_pt is null or btrim(p_summary_pt) = '' or length(p_summary_pt) > 4000
     ))
     or (p_outcome = 'retry' and p_summary_pt is not null) then
    raise exception using errcode = '22023',
      message = 'call_summary_subscription_completion_invalid';
  end if;

  select c.tenant_id into v_tenant_id
  from public.calls c
  where c.id = p_call_id;
  if v_tenant_id is null then
    raise exception using errcode = '42501',
      message = 'call_summary_subscription_claim_not_current';
  end if;
  select t.test_memory_generation into v_tenant_generation
  from public.tenants t
  where t.id = v_tenant_id
  for update;
  select c.* into v_call
  from public.calls c
  where c.id = p_call_id
    and c.tenant_id = v_tenant_id
  for update;
  if v_call.id is null
     or v_call.summary_status <> 'pending_ingest'
     or v_call.summary_claim_token_hash is null
     or v_call.summary_claim_token_hash is distinct from
       extensions.digest(p_claim_token, 'sha256')
     or v_call.summary_lease_until is null
     or v_call.summary_lease_until <= clock_timestamp()
     or v_call.test_memory_generation is distinct from p_expected_generation then
    raise exception using errcode = '42501',
      message = 'call_summary_subscription_claim_not_current';
  end if;
  if v_tenant_generation is distinct from p_expected_generation then
    raise exception using errcode = '42501',
      message = 'call_summary_subscription_generation_stale';
  end if;

  v_next_status := case
    when p_outcome = 'ready' then 'ready'
    when v_call.summary_attempts >= 3 then 'failed'
    else 'pending_ingest'
  end;
  v_retry_at := case
    when v_next_status = 'pending_ingest' then clock_timestamp() + case
      when v_call.summary_attempts <= 1 then interval '15 seconds'
      when v_call.summary_attempts = 2 then interval '30 seconds'
      else interval '60 seconds'
    end
    else null
  end;

  update public.calls
  set summary_status = v_next_status,
      summary_pt = case when v_next_status = 'ready' then btrim(p_summary_pt) else null end,
      summary_claim_token_hash = null,
      summary_claimed_by = null,
      summary_claimed_at = null,
      summary_lease_until = null,
      summary_retry_at = v_retry_at
  where id = v_call.id;

  if v_next_status = 'ready' then
    insert into public.notifications (tenant_id, kind, payload)
    values (v_call.tenant_id, 'summary_ready', jsonb_build_object('call_id', v_call.id));
  end if;

  return jsonb_build_object(
    'call_id', v_call.id,
    'summary_status', v_next_status,
    'attempt_number', v_call.summary_attempts,
    'retry_at', v_retry_at,
    'test_memory_generation', p_expected_generation
  );
end;
$$;

revoke all on function public.complete_call_summary_subscription(uuid,bigint,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_call_summary_subscription(uuid,bigint,text,text,text)
  to service_role;
