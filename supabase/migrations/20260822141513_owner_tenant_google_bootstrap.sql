-- V0.2 M1 — one-button Google login: automatic owner tenant bootstrap,
-- connector handoff intents, and the calendar test receipt state machine.
-- Forward-only. Owner identity comes exclusively from auth.uid(); the browser
-- never supplies a user id or tenant id to any function in this file.

-- ---------------------------------------------------------------- tenants: lifecycle + safe defaults
alter table public.tenants drop constraint tenants_status_check;
alter table public.tenants add constraint tenants_status_check
  check (status in ('onboarding','provisioning','active','paused'));

alter table public.tenants add column operational_mode text not null default 'simulation_only'
  constraint tenants_operational_mode_check check (operational_mode in ('simulation_only','live'));

-- Marks tenants created by the self-service bootstrap. NULL for operator-provisioned
-- and legacy tenants. Slug stays display metadata; this column plus owner_user_id is
-- the authority pair for "one V0.2 tenant per owner".
alter table public.tenants add column bootstrap_origin text
  constraint tenants_bootstrap_origin_check check (bootstrap_origin in ('v0_2_google'));

create unique index tenants_one_v0_2_tenant_per_owner
  on public.tenants (owner_user_id)
  where bootstrap_origin = 'v0_2_google';

-- The live legacy cell tenant keeps its real operational mode truthful.
update public.tenants set operational_mode = 'live'
 where id = 'a0000000-0000-4000-8000-000000000001' and status = 'active';

-- ---------------------------------------------------------------- owner profile (safe metadata only)
create table public.owner_profiles (
  user_id uuid primary key references auth.users (id),
  email text,
  display_name text,
  avatar_url text,
  google_subject text,
  google_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.owner_profiles enable row level security;
alter table public.owner_profiles force row level security;

create policy owner_profiles_self_select on public.owner_profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

-- One Google identity can never map to two owner rows.
create unique index owner_profiles_google_subject_unique
  on public.owner_profiles (google_subject)
  where google_subject is not null;

revoke all on public.owner_profiles from public, anon, authenticated, service_role;
grant select on public.owner_profiles to authenticated;
grant select on public.owner_profiles to service_role;

-- ---------------------------------------------------------------- provisioning receipts (append-only)
create table public.tenant_provisioning_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  owner_user_id uuid not null,
  origin text not null check (origin in ('v0_2_google')),
  provider_subject text,
  provider_email text,
  details jsonb,
  created_at timestamptz not null default now()
);

alter table public.tenant_provisioning_receipts enable row level security;
alter table public.tenant_provisioning_receipts force row level security;

create policy tenant_provisioning_receipts_owner_select on public.tenant_provisioning_receipts
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

create trigger tenant_provisioning_receipts_append_only
  before update or delete on public.tenant_provisioning_receipts
  for each row execute function public.block_mutation();

revoke all on public.tenant_provisioning_receipts from public, anon, authenticated, service_role;
grant select on public.tenant_provisioning_receipts to authenticated;

-- ---------------------------------------------------------------- connector handoff intents (single-use)
create table public.connector_handoff_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null,
  kind text not null check (kind in ('login','reconnect')),
  nonce_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.connector_handoff_intents enable row level security;
alter table public.connector_handoff_intents force row level security;
-- Deliberately no policies: rows are reachable only through the definer RPCs below
-- and the service-role handoff function.

revoke all on public.connector_handoff_intents from public, anon, authenticated, service_role;
grant select, insert, update on public.connector_handoff_intents to service_role;

-- ---------------------------------------------------------------- calendar test receipt state
create table public.calendar_test_receipts (
  tenant_id uuid primary key references public.tenants (id),
  event_id text not null,
  summary text not null,
  start_iso text not null,
  end_iso text not null,
  time_zone text not null,
  outcome text not null default 'pending'
    check (outcome in ('pending','accepted','reconciliation_required','failed')),
  attempt_count integer not null default 0,
  readback jsonb,
  accepted_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calendar_test_receipts enable row level security;
alter table public.calendar_test_receipts force row level security;
-- Deliberately no policies: owner reads go through get_calendar_test_state().

revoke all on public.calendar_test_receipts from public, anon, authenticated, service_role;
grant select, insert, update on public.calendar_test_receipts to service_role;

-- ---------------------------------------------------------------- connector metadata: last provider success
alter table public.connector_accounts add column last_success_at timestamptz;

-- Forward repair: 20260821234000 revoked the quarantine table from anon/authenticated
-- but not from service_role, so database default privileges left service_role with
-- destructive grants the security gate forbids. Restore the intended select+insert set.
revoke truncate, references, trigger, update, delete
  on table public.legacy_unknown_receipt_quarantine from service_role;

-- ---------------------------------------------------------------- ensure_owner_tenant()
create function public.ensure_owner_tenant()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_role text;
  v_tenant public.tenants%rowtype;
  v_created boolean := false;
  v_id uuid;
  v_email text;
  v_meta jsonb;
  v_name text;
  v_avatar text;
  v_gsub text;
  v_gemail text;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    '');
  if v_role <> 'authenticated' then
    raise exception using errcode = '42501', message = 'authenticated_role_required';
  end if;

  -- Serialize per authenticated user: concurrent callbacks create at most one tenant.
  perform pg_advisory_xact_lock(hashtextextended('ligou.v0_2.owner_tenant:' || v_uid::text, 0));

  select lower(u.email), u.raw_user_meta_data into v_email, v_meta
  from auth.users u where u.id = v_uid;
  v_name := coalesce(
    nullif(trim(v_meta ->> 'name'), ''),
    nullif(trim(v_meta ->> 'full_name'), ''),
    nullif(split_part(coalesce(v_email, ''), '@', 1), ''),
    'Meu negócio');
  v_avatar := coalesce(nullif(trim(v_meta ->> 'avatar_url'), ''), nullif(trim(v_meta ->> 'picture'), ''));

  select i.provider_id, lower(nullif(i.identity_data ->> 'email', ''))
    into v_gsub, v_gemail
  from auth.identities i
  where i.user_id = v_uid and i.provider = 'google'
  order by i.created_at asc
  limit 1;

  select t.* into v_tenant
  from public.tenants t
  where t.owner_user_id = v_uid and t.bootstrap_origin = 'v0_2_google'
  order by t.created_at asc
  limit 1;

  if v_tenant.id is null then
    v_id := gen_random_uuid();
    insert into public.tenants
      (id, slug, name, vertical, owner_user_id, status, operational_mode, bootstrap_origin, languages)
    values
      (v_id,
       'ligou-' || substr(replace(v_id::text, '-', ''), 1, 12),
       v_name,
       null,
       v_uid,
       'onboarding',
       'simulation_only',
       'v0_2_google',
       '{pt,en}')
    returning * into v_tenant;
    v_created := true;

    -- Connector metadata begins as reconnect_required; activation happens only
    -- through the verified credential handoff.
    insert into public.connector_accounts (tenant_id, provider, status)
    values (v_tenant.id, 'google_calendar', 'reconnect_required')
    on conflict (tenant_id, provider) do nothing;

    insert into public.tenant_provisioning_receipts
      (tenant_id, owner_user_id, origin, provider_subject, provider_email, details)
    values
      (v_tenant.id, v_uid, 'v0_2_google', v_gsub, v_gemail,
       jsonb_build_object('status', v_tenant.status, 'operational_mode', v_tenant.operational_mode));
  end if;

  insert into public.owner_profiles as p
    (user_id, email, display_name, avatar_url, google_subject, google_email)
  values
    (v_uid, v_email, v_name, v_avatar, v_gsub, v_gemail)
  on conflict (user_id) do update set
    email = coalesce(excluded.email, p.email),
    display_name = coalesce(excluded.display_name, p.display_name),
    avatar_url = coalesce(excluded.avatar_url, p.avatar_url),
    google_subject = coalesce(excluded.google_subject, p.google_subject),
    google_email = coalesce(excluded.google_email, p.google_email),
    updated_at = now();

  return jsonb_build_object(
    'tenant_id', v_tenant.id,
    'created', v_created,
    'status', v_tenant.status,
    'operational_mode', v_tenant.operational_mode,
    'name', v_tenant.name,
    'timezone', v_tenant.timezone);
end;
$$;

revoke all on function public.ensure_owner_tenant() from public, anon, authenticated, service_role;
grant execute on function public.ensure_owner_tenant() to authenticated;

-- ---------------------------------------------------------------- handoff intent lifecycle
create function public.begin_connector_handoff(p_tenant uuid, p_kind text, p_nonce_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_role text;
  v_intent public.connector_handoff_intents%rowtype;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    '');
  if v_role <> 'authenticated' then
    raise exception using errcode = '42501', message = 'authenticated_role_required';
  end if;
  if p_tenant is null or p_kind is null or p_nonce_hash is null then
    raise exception using errcode = '22023', message = 'handoff_intent_invalid';
  end if;
  if p_kind not in ('login','reconnect') then
    raise exception using errcode = '22023', message = 'handoff_kind_invalid';
  end if;
  if p_nonce_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'handoff_nonce_hash_invalid';
  end if;
  if not exists (
    select 1 from public.tenants t
    where t.id = p_tenant and t.owner_user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_tenant_owner';
  end if;

  insert into public.connector_handoff_intents (tenant_id, user_id, kind, nonce_hash, expires_at)
  values (p_tenant, v_uid, p_kind, p_nonce_hash, clock_timestamp() + interval '10 minutes')
  returning * into v_intent;

  return jsonb_build_object('intent_id', v_intent.id, 'expires_at', v_intent.expires_at);
end;
$$;

revoke all on function public.begin_connector_handoff(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.begin_connector_handoff(uuid,text,text) to authenticated;

create function public.consume_connector_handoff(p_intent uuid, p_nonce_hash text, p_tenant uuid, p_user uuid)
returns table (kind text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_intent public.connector_handoff_intents%rowtype;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    '');
  if v_role <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_intent is null or p_nonce_hash is null or p_tenant is null or p_user is null then
    raise exception using errcode = '22023', message = 'handoff_intent_invalid';
  end if;

  select i.* into v_intent
  from public.connector_handoff_intents i
  where i.id = p_intent
  for update;

  if not found
    or v_intent.consumed_at is not null
    or v_intent.expires_at <= clock_timestamp()
    or v_intent.nonce_hash is distinct from p_nonce_hash
    or v_intent.tenant_id is distinct from p_tenant
    or v_intent.user_id is distinct from p_user
  then
    raise exception using errcode = 'P0001', message = 'handoff_intent_invalid';
  end if;

  update public.connector_handoff_intents i
  set consumed_at = clock_timestamp()
  where i.id = v_intent.id;

  return query select v_intent.kind;
end;
$$;

revoke all on function public.consume_connector_handoff(uuid,text,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.consume_connector_handoff(uuid,text,uuid,uuid) to service_role;

-- ---------------------------------------------------------------- calendar test attempt fence (at-most-once)
create function public.begin_calendar_test_attempt(
  p_tenant uuid,
  p_event_id text,
  p_summary text,
  p_start_iso text,
  p_end_iso text,
  p_time_zone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_row public.calendar_test_receipts%rowtype;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    '');
  if v_role <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_tenant is null or p_event_id is null or p_summary is null
     or p_start_iso is null or p_end_iso is null or p_time_zone is null then
    raise exception using errcode = '22023', message = 'calendar_test_invalid';
  end if;

  insert into public.calendar_test_receipts
    (tenant_id, event_id, summary, start_iso, end_iso, time_zone)
  values (p_tenant, p_event_id, p_summary, p_start_iso, p_end_iso, p_time_zone)
  on conflict (tenant_id) do nothing;

  select r.* into v_row
  from public.calendar_test_receipts r
  where r.tenant_id = p_tenant
  for update;

  if v_row.event_id is distinct from p_event_id then
    raise exception using errcode = 'P0001', message = 'calendar_test_event_identity_changed';
  end if;

  if v_row.outcome = 'accepted' then
    return jsonb_build_object('decision', 'accepted_exists', 'event_id', v_row.event_id,
      'summary', v_row.summary, 'start_iso', v_row.start_iso, 'end_iso', v_row.end_iso,
      'time_zone', v_row.time_zone);
  end if;

  if v_row.outcome = 'reconciliation_required'
     or (v_row.outcome = 'pending' and v_row.attempt_count > 0) then
    -- A prior provider write may have happened without a recorded result:
    -- at-most-once forbids another POST forever; only lookup reconciliation remains.
    update public.calendar_test_receipts r
    set outcome = 'reconciliation_required', updated_at = clock_timestamp()
    where r.tenant_id = p_tenant;
    return jsonb_build_object('decision', 'reconcile_only', 'event_id', v_row.event_id,
      'summary', v_row.summary, 'start_iso', v_row.start_iso, 'end_iso', v_row.end_iso,
      'time_zone', v_row.time_zone);
  end if;

  -- pending with zero attempts, or a definitively failed prior attempt: one POST allowed.
  update public.calendar_test_receipts r
  set attempt_count = r.attempt_count + 1,
      outcome = 'pending',
      summary = p_summary,
      start_iso = p_start_iso,
      end_iso = p_end_iso,
      time_zone = p_time_zone,
      last_error = null,
      updated_at = clock_timestamp()
  where r.tenant_id = p_tenant;

  return jsonb_build_object('decision', 'proceed', 'event_id', p_event_id,
    'summary', p_summary, 'start_iso', p_start_iso, 'end_iso', p_end_iso,
    'time_zone', p_time_zone);
end;
$$;

revoke all on function public.begin_calendar_test_attempt(uuid,text,text,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.begin_calendar_test_attempt(uuid,text,text,text,text,text) to service_role;

create function public.record_calendar_test_result(
  p_tenant uuid,
  p_outcome text,
  p_event_id text,
  p_readback jsonb,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_row public.calendar_test_receipts%rowtype;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    '');
  if v_role <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_tenant is null or p_outcome is null then
    raise exception using errcode = '22023', message = 'calendar_test_invalid';
  end if;
  if p_outcome not in ('accepted','reconciliation_required','failed') then
    raise exception using errcode = '22023', message = 'calendar_test_outcome_invalid';
  end if;

  select r.* into v_row
  from public.calendar_test_receipts r
  where r.tenant_id = p_tenant
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'calendar_test_attempt_missing';
  end if;

  if v_row.outcome = 'accepted' then
    if p_outcome = 'accepted' and p_event_id is not distinct from v_row.event_id then
      return jsonb_build_object('outcome', 'accepted', 'reused', true, 'event_id', v_row.event_id);
    end if;
    raise exception using errcode = 'P0001', message = 'calendar_test_receipt_final';
  end if;

  if p_outcome = 'accepted' then
    -- Accepted only with exact read-back proof; the caller verified field equality
    -- and this re-checks the invariants the receipt must carry.
    if p_readback is null
       or p_event_id is distinct from v_row.event_id
       or (p_readback ->> 'id') is distinct from v_row.event_id
       or (p_readback ->> 'summary') is distinct from v_row.summary
       or coalesce(p_readback ->> 'status', '') <> 'confirmed'
       or nullif(p_readback ->> 'start_iso', '') is null
       or nullif(p_readback ->> 'end_iso', '') is null
    then
      raise exception using errcode = 'P0001', message = 'calendar_test_readback_mismatch';
    end if;
    update public.calendar_test_receipts r
    set outcome = 'accepted',
        readback = p_readback,
        accepted_at = clock_timestamp(),
        last_error = null,
        updated_at = clock_timestamp()
    where r.tenant_id = p_tenant;
    return jsonb_build_object('outcome', 'accepted', 'reused', false, 'event_id', v_row.event_id);
  end if;

  update public.calendar_test_receipts r
  set outcome = p_outcome,
      last_error = left(coalesce(p_error, ''), 500),
      updated_at = clock_timestamp()
  where r.tenant_id = p_tenant;

  return jsonb_build_object('outcome', p_outcome, 'event_id', v_row.event_id);
end;
$$;

revoke all on function public.record_calendar_test_result(uuid,text,text,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.record_calendar_test_result(uuid,text,text,jsonb,text) to service_role;

-- ---------------------------------------------------------------- owner-facing calendar test state
create function public.get_calendar_test_state(p_tenant uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_uid uuid;
  v_row public.calendar_test_receipts%rowtype;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_tenant is null then
    raise exception using errcode = '22023', message = 'tenant_required';
  end if;
  if not exists (
    select 1 from public.tenants t
    where t.id = p_tenant and t.owner_user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_tenant_owner';
  end if;

  select r.* into v_row
  from public.calendar_test_receipts r
  where r.tenant_id = p_tenant;

  if not found then
    return jsonb_build_object('outcome', null);
  end if;

  return jsonb_build_object(
    'outcome', v_row.outcome,
    'event_id', v_row.event_id,
    'summary', v_row.summary,
    'start_iso', v_row.start_iso,
    'end_iso', v_row.end_iso,
    'time_zone', v_row.time_zone,
    'attempt_count', v_row.attempt_count,
    'accepted_at', v_row.accepted_at,
    'readback_summary', v_row.readback ->> 'summary',
    'readback_start_iso', v_row.readback ->> 'start_iso',
    'readback_end_iso', v_row.readback ->> 'end_iso',
    'last_error', v_row.last_error);
end;
$$;

revoke all on function public.get_calendar_test_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_calendar_test_state(uuid) to authenticated;

-- ---------------------------------------------------------------- connector status projection v3
drop function public.get_connector_status(uuid);

create function public.get_connector_status(p_tenant uuid)
returns table (
  provider text,
  account_email text,
  calendar_id text,
  status text,
  connected_at timestamptz,
  scopes text,
  last_success_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_uid uuid;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_tenant is null then
    raise exception using errcode = '22023', message = 'tenant_required';
  end if;
  if not exists (
    select 1 from public.tenants t
    where t.id = p_tenant and t.owner_user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_tenant_owner';
  end if;

  return query
  select c.provider, c.account_email, c.calendar_id, c.status, c.connected_at,
         c.scopes, c.last_success_at
  from public.connector_accounts c
  where c.tenant_id = p_tenant;
end;
$$;

revoke all on function public.get_connector_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_connector_status(uuid) to authenticated;
