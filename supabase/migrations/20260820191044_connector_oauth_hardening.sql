-- Task 5: OAuth state proof, encrypted connector token wire format, and owner-only status.
-- This migration intentionally leaves legacy plaintext token bytes untouched. Those rows are
-- quarantined for an operator-approved reconnect; application code never selects the plaintext column.

alter table public.oauth_states
  add column if not exists nonce_hash text,
  add column if not exists redirect_uri text,
  add column if not exists expires_at timestamptz;

-- Pre-hardening state has no nonce or redirect proof and can never be accepted safely.
update public.oauth_states
set consumed_at = coalesce(consumed_at, clock_timestamp()),
    expires_at = coalesce(expires_at, created_at + interval '10 minutes')
where nonce_hash is null or redirect_uri is null or expires_at is null;

create or replace function public.consume_oauth_state(
  p_state text,
  p_nonce_hash text,
  p_tenant uuid,
  p_user uuid,
  p_redirect text
)
returns table (tenant_id uuid, user_id uuid, redirect_uri text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.oauth_states%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if current_user <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_state is null or p_nonce_hash is null or p_tenant is null or p_user is null or p_redirect is null then
    raise exception using errcode = '22023', message = 'oauth_state_invalid';
  end if;

  select os.* into v_state
  from public.oauth_states os
  where os.state = p_state
  for update;

  if not found
    or v_state.consumed_at is not null
    or v_state.expires_at is null
    or v_state.expires_at <= clock_timestamp()
    or v_state.nonce_hash is distinct from p_nonce_hash
    or v_state.tenant_id is distinct from p_tenant
    or v_state.user_id is distinct from p_user
    or v_state.redirect_uri is distinct from p_redirect
  then
    raise exception using errcode = 'P0001', message = 'oauth_state_invalid';
  end if;

  update public.oauth_states os
  set consumed_at = v_now
  where os.state = v_state.state;

  return query select v_state.tenant_id, v_state.user_id, v_state.redirect_uri;
end;
$$;

revoke all on function public.consume_oauth_state(text,text,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.consume_oauth_state(text,text,uuid,uuid,text) to service_role;

alter table public.connector_accounts
  alter column refresh_token drop not null,
  add column if not exists refresh_token_ciphertext text,
  add column if not exists refresh_token_iv text,
  add column if not exists token_key_version integer,
  add column if not exists token_account_ref text;

alter table public.connector_accounts
  drop constraint if exists connector_accounts_status_check;
alter table public.connector_accounts
  add constraint connector_accounts_status_check
  check (status in ('active','revoked','error','reconnect_required'));

-- Do not decrypt/re-encrypt or clear legacy material without the application key. Mark it unusable.
update public.connector_accounts
set status = 'reconnect_required',
    last_error = 'legacy_plaintext_reconnect_required',
    updated_at = clock_timestamp()
where refresh_token is not null and refresh_token_ciphertext is null;

alter table public.connector_accounts
  add constraint connector_accounts_active_encrypted_check
  check (
    status <> 'active'
    or (
      refresh_token is null
      and refresh_token_ciphertext is not null
      and refresh_token_iv is not null
      and token_key_version is not null
      and token_account_ref is not null
    )
  );

drop view if exists public.connector_status;

create or replace function public.get_connector_status()
returns table (
  provider text,
  account_email text,
  calendar_id text,
  status text,
  connected_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if not exists (
    select 1 from public.tenants t where t.owner_user_id = v_user
  ) then
    raise exception using errcode = '42501', message = 'not_tenant_owner';
  end if;

  return query
  select ca.provider, ca.account_email, ca.calendar_id, ca.status, ca.connected_at
  from public.connector_accounts ca
  join public.tenants t on t.id = ca.tenant_id
  where t.owner_user_id = v_user;
end;
$$;

revoke all on function public.get_connector_status() from public, anon;
grant execute on function public.get_connector_status() to authenticated;

revoke all on table public.oauth_states, public.connector_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.oauth_states, public.connector_accounts to service_role;
