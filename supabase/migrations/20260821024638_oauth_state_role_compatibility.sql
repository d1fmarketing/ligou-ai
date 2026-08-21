-- Forward-only compatibility for database-only Supabase stacks where auth.jwt() is not
-- installed. PostgREST sets request.jwt.claim.role for service-key calls, which is the
-- only role evidence this internal single-use state RPC needs.
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
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') <> 'service_role' then
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

revoke all on function public.consume_oauth_state(text,text,uuid,uuid,text)
from public, anon, authenticated;
grant execute on function public.consume_oauth_state(text,text,uuid,uuid,text) to service_role;
