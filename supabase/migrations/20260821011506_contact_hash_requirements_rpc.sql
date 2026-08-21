create or replace function public.get_contact_hash_requirements(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_requirements jsonb;
  v_requirement_count integer;
  v_row_count bigint;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_tenant is null then raise exception using errcode = '22023', message = 'tenant_required'; end if;

  with requirements as (
    select hash_algorithm, hash_key_version, count(*)::bigint as row_count
    from public.contact_opt_outs where tenant_id = p_tenant
    group by hash_algorithm, hash_key_version
    union all
    select hash_algorithm, hash_key_version, count(*)::bigint as row_count
    from public.communications where tenant_id = p_tenant
    group by hash_algorithm, hash_key_version
  ), combined as (
    select hash_algorithm, hash_key_version, sum(row_count)::bigint as row_count
    from requirements group by hash_algorithm, hash_key_version
  )
  select count(*)::integer, coalesce(sum(row_count), 0)::bigint,
         coalesce(jsonb_agg(jsonb_build_object(
           'algorithm', hash_algorithm, 'key_version', hash_key_version, 'row_count', row_count
         ) order by hash_algorithm, hash_key_version nulls first), '[]'::jsonb)
  into v_requirement_count, v_row_count, v_requirements
  from combined;

  if v_requirement_count > 64 then
    raise exception using errcode = '54000', message = 'too_many_contact_hash_versions';
  end if;
  return jsonb_build_object(
    'schema', 'ligou.contact-hash-requirements.v1',
    'requirements', v_requirements,
    'row_count', v_row_count
  );
end;
$$;

revoke all on function public.get_contact_hash_requirements(uuid) from public, anon, authenticated;
grant execute on function public.get_contact_hash_requirements(uuid) to service_role;
