begin;

-- Preserve the approved discovery/readiness projection verbatim. Only the
-- interview-completion predicate changes for a versioned website attempt.
do $patch$
declare
  v_sql text;
  v_old text := $old$  if v_tenant.status = 'active' or exists (
    select 1
    from public.receipts r
    join public.calls c on c.id = r.call_id and c.tenant_id = v_tenant.id
    where r.tenant_id = v_tenant.id
      and r.kind = 'onboarding_voice_approval'
      and r.outcome = 'accepted'
      and c.test_memory_generation = v_tenant.test_memory_generation
  ) then$old$;
  v_new text := $new$  if (
    not exists (
      select 1 from public.website_interview_preparations p
      where p.tenant_id = v_tenant.id and p.generation = v_tenant.test_memory_generation
    ) and (
      v_tenant.status = 'active' or exists (
        select 1 from public.receipts r
        join public.calls c on c.id = r.call_id and c.tenant_id = v_tenant.id
        where r.tenant_id = v_tenant.id and r.kind = 'onboarding_voice_approval'
          and r.outcome = 'accepted' and c.test_memory_generation = v_tenant.test_memory_generation
      )
    )
  ) or exists (
    select 1 from public.website_interview_preparations p
    join public.website_interviews i on i.preparation_id = p.id and i.tenant_id = p.tenant_id
    join public.website_interview_approvals a on a.interview_id = i.interview_id and a.call_id = i.current_call_id
    join public.calls c on c.id = i.current_call_id and c.tenant_id = i.tenant_id
    join public.budget_reservations b on b.call_id = c.id and b.tenant_id = c.tenant_id
    join public.receipts r on r.call_id = c.id and r.tenant_id = i.tenant_id
      and r.kind = 'website_interview' and r.external_id = 'website-terminal:' || c.id::text
    where p.tenant_id = v_tenant.id and p.owner_id = v_owner
      and p.generation = v_tenant.test_memory_generation
      and not exists (
        select 1 from public.website_interview_preparations newer
        where newer.tenant_id = p.tenant_id and newer.generation = p.generation
          and (newer.created_at, newer.id) > (p.created_at, p.id)
      )
      and i.state = 'complete' and i.generation = p.generation
      and c.test_memory_generation = p.generation and c.status = 'ended' and c.ended_at is not null
      and c.provider_termination_state = 'confirmed' and c.provider_termination_reason = 'agent_ended_session'
      and b.status = 'settled' and r.outcome = 'accepted'
      and r.readback->>'outcome' = 'complete'
      and r.readback->>'approvalReceiptId' = a.receipt_id::text
      and r.readback->>'callId' = c.id::text
      and r.readback->'providerConfirmed' = 'true'::jsonb
      and r.readback->'budgetSettled' = 'true'::jsonb
  ) then$new$;
begin
  select pg_get_functiondef('public.company_discovery_setup_status()'::regprocedure) into v_sql;
  if position(v_old in v_sql) = 0 then raise exception 'website_setup_completion_predicate_changed'; end if;
  v_sql := replace(v_sql, v_old, v_new);
  v_old := $old$      and c.status = 'active'
      and c.test_memory_generation = v_tenant.test_memory_generation
  ) then
    v_state := 'onboarding_in_progress';$old$;
  v_new := $new$      and c.status = 'active'
      and c.test_memory_generation = v_tenant.test_memory_generation
  ) or exists (
    select 1 from public.website_interviews i
    join public.website_interview_preparations p on p.id = i.preparation_id
    where i.tenant_id = v_tenant.id and i.generation = v_tenant.test_memory_generation
      and i.state = 'closing'
      and not exists (
        select 1 from public.website_interview_preparations newer
        where newer.tenant_id = p.tenant_id and newer.generation = p.generation
          and (newer.created_at, newer.id) > (p.created_at, p.id)
      )
      and not exists (
        select 1 from public.receipts r where r.tenant_id = i.tenant_id
          and r.call_id = i.current_call_id and r.kind = 'website_interview'
          and r.external_id = 'website-terminal:' || i.current_call_id::text
      )
  ) then
    v_state := 'onboarding_in_progress';$new$;
  if position(v_old in v_sql) = 0 then raise exception 'website_setup_in_progress_predicate_changed'; end if;
  v_sql := replace(v_sql, v_old, v_new);
  v_old := $old$    'schema_version', 'company_discovery.setup_status.v1',
    'state', v_state,$old$;
  v_new := $new$    'schema_version', 'company_discovery.setup_status.v1',
    'voice_protocol_version', case when exists (
      select 1 from public.website_interview_preparations p
      where p.tenant_id = v_tenant.id and p.owner_id = v_owner
        and p.generation = v_tenant.test_memory_generation
        and public.website_interview_source_valid(v_tenant.id, v_owner,
          p.draft_id, p.draft_hash, p.result_id, p.result_hash)
        and not exists (
          select 1 from public.website_interview_preparations newer
          where newer.tenant_id = p.tenant_id and newer.generation = p.generation
            and (newer.created_at, newer.id) > (p.created_at, p.id)
        )
    ) then 3 else 2 end,
    'state', v_state,$new$;
  if position(v_old in v_sql) = 0 then raise exception 'website_setup_protocol_projection_changed'; end if;
  v_sql := replace(v_sql, v_old, v_new);
  execute v_sql;
end;
$patch$;

commit;
