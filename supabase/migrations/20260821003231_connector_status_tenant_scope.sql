create or replace function public.get_connector_status(p_tenant uuid)
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
  if v_user is null or p_tenant is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if not exists (
    select 1 from public.tenants t where t.id = p_tenant and t.owner_user_id = v_user
  ) then
    raise exception using errcode = '42501', message = 'not_tenant_owner';
  end if;

  return query
  select ca.provider, ca.account_email, ca.calendar_id, ca.status, ca.connected_at
  from public.connector_accounts ca
  where ca.tenant_id = p_tenant;
end;
$$;

revoke all on function public.get_connector_status(uuid) from public, anon;
grant execute on function public.get_connector_status(uuid) to authenticated;
drop function if exists public.get_connector_status();
