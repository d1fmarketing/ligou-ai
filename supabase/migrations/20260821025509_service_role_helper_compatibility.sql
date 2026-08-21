-- Forward-only database-only-stack compatibility for service RPCs that need only
-- PostgREST's authoritative request.jwt.claim.role setting.
create or replace function public.purge_ephemeral_call_data(
  p_transcript_before timestamptz,
  p_transient_before timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_transcripts integer := 0;
  v_browser_rows integer := 0;
  v_phone_rows integer := 0;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_transcript_before is null or p_transient_before is null
    or p_transcript_before > v_now or p_transient_before > v_now then
    raise exception using errcode = '22023', message = 'retention_cutoff_invalid';
  end if;

  update public.calls c
  set transcript = '[]'::jsonb,
      transcript_deleted_at = v_now
  where c.ended_at is not null
    and c.ended_at < p_transcript_before
    and c.transcript <> '[]'::jsonb
    and c.summary_status in ('ready', 'failed')
    and c.learning_status in ('done', 'skipped', 'failed');
  get diagnostics v_transcripts = row_count;

  delete from public.browser_session_requests b
  where b.created_at < p_transient_before
    and b.status in ('ready', 'error', 'expired');
  get diagnostics v_browser_rows = row_count;

  delete from public.phone_events p
  where p.created_at < p_transient_before
    and p.handled_at is not null
    and p.status in ('accepted', 'rejected', 'error');
  get diagnostics v_phone_rows = row_count;

  return jsonb_build_object(
    'transcripts_redacted', v_transcripts,
    'browser_rows_deleted', v_browser_rows,
    'phone_rows_deleted', v_phone_rows,
    'completed_at', v_now
  );
end;
$$;

revoke all on function public.purge_ephemeral_call_data(timestamptz,timestamptz)
from public, anon, authenticated;
grant execute on function public.purge_ephemeral_call_data(timestamptz,timestamptz) to service_role;

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
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') <> 'service_role' then
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

revoke all on function public.get_contact_hash_requirements(uuid)
from public, anon, authenticated;
grant execute on function public.get_contact_hash_requirements(uuid) to service_role;
