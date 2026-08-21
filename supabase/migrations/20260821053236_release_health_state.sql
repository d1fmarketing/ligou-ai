create or replace function public.release_health_state(p_tenant uuid, p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select jsonb_build_object('ok', true, 'tenant_id', t.id, 'tenant_slug', t.slug, 'status', t.status)
  into v_state
  from public.tenants t
  where t.id = p_tenant and t.slug = p_slug and t.status = 'active';
  if v_state is null then
    raise exception 'release_tenant_unavailable' using errcode = 'P0002';
  end if;
  return v_state;
end;
$$;

revoke all on function public.release_health_state(uuid,text) from public, anon, authenticated;
grant execute on function public.release_health_state(uuid,text) to service_role;
