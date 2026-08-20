-- Explicit tenant provisioning. Session bootstrap is read-only and must never
-- turn the first authenticated request into an owner-assignment race.
create or replace function public.provision_tenant_owner(p_tenant uuid, p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
begin
  if auth.role() <> 'service_role' then
    raise exception 'operator_authorization_required' using errcode = '42501';
  end if;
  if p_owner is null then
    raise exception 'owner_required' using errcode = '22023';
  end if;

  select t.* into v_tenant
  from public.tenants t
  where t.id = p_tenant
  for update;

  if v_tenant.id is null then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if v_tenant.owner_user_id is not null and v_tenant.owner_user_id <> p_owner then
    raise exception 'tenant_already_owned' using errcode = '23505';
  end if;

  if v_tenant.owner_user_id is null then
    update public.tenants t
    set owner_user_id = p_owner
    where t.id = p_tenant and t.owner_user_id is null;
  end if;

  return jsonb_build_object('tenant_id', p_tenant, 'owner_user_id', p_owner, 'provisioned', true);
end;
$$;

revoke all on function public.provision_tenant_owner(uuid,uuid) from public, anon, authenticated;
grant execute on function public.provision_tenant_owner(uuid,uuid) to service_role;
