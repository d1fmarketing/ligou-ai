begin;
set local lock_timeout='5s';

-- Recovery consumes literal ASR already recorded while this call was active.
-- It cannot create an owner turn, reopen a call or change an approved draft.
create function public.website_interview_recorded_recovery_scope(p_owner uuid,p_call uuid,p_request uuid,p_item text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews;v_p public.website_interview_preparations;v_c public.calls;
  v_b public.budget_reservations;v_turn public.website_interview_owner_turns;v_prior public.receipts;begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request,false);
  select * into v_c from public.calls where id=p_call;
  select * into v_b from public.budget_reservations where call_id=p_call and tenant_id=v_i.tenant_id for update;
  if coalesce(v_c.status,'') not in ('ended','error','killed_budget','killed_deadline') or v_c.ended_at is null or v_c.provider_termination_state is distinct from 'confirmed'
    or v_c.openai_call_id is null or btrim(v_c.openai_call_id)=''
    or v_b.status is distinct from 'settled' or v_b.settled_at is null then
    raise exception using errcode='55000',message='interview_recovery_not_settled';end if;
  select * into v_p from public.website_interview_preparations where id=v_i.preparation_id;
  if v_i.owner_id is distinct from p_owner or v_i.generation is distinct from v_c.test_memory_generation
    or v_p.owner_id is distinct from p_owner or v_p.tenant_id is distinct from v_i.tenant_id or v_p.generation is distinct from v_i.generation
    or not exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=5 and opening_mode_requested='realtime_native_v1')
    or v_i.agenda->'binding' is distinct from jsonb_build_object('interviewId',v_i.interview_id,'callId',p_call,
      'draftId',v_p.draft_id,'draftHash',v_p.draft_hash,'sourceResultId',v_p.result_id,'sourceResultHash',v_p.result_hash)
    or not public.website_interview_source_valid(v_i.tenant_id,p_owner,v_p.draft_id,v_p.draft_hash,v_p.result_id,v_p.result_hash) then
    raise exception using errcode='42501',message='interview_recovery_source_changed';end if;
  if v_i.state in ('closing','complete') or v_i.parent_interview_id is not null or v_i.amendment_request_receipt_id is not null
    or exists(select 1 from public.website_interview_approvals where interview_id=v_i.interview_id)
    or exists(select 1 from public.website_interview_amendment_requests where interview_id=v_i.interview_id) then
    raise exception using errcode='42501',message='interview_recovery_already_approved';end if;
  if exists(select 1 from public.calls where tenant_id=v_i.tenant_id and id<>p_call and (status='active' or started_at>=v_c.started_at))
    or exists(select 1 from public.website_interview_preparations where tenant_id=v_i.tenant_id and consumed_call_id is null)
    or exists(select 1 from public.website_interviews where tenant_id=v_i.tenant_id and interview_id<>v_i.interview_id and created_at>=v_i.created_at)
    or exists(select 1 from public.browser_session_requests where tenant_id=v_i.tenant_id and call_id is null and status in ('pending','processing','ready','cancel_requested')) then
    raise exception using errcode='40001',message='interview_recovery_competing_attempt';end if;
  if p_item is null or length(btrim(p_item)) not between 1 and 400 then raise exception 'interview_recovery_turn_missing';end if;
  select * into v_turn from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item for update;
  if v_turn.tenant_id is distinct from v_i.tenant_id or v_turn.owner_text is null or v_turn.interpretation_text is not null
    or v_turn.created_at>v_c.ended_at then raise exception 'interview_recovery_turn_missing';end if;
  select * into v_prior from public.receipts where tenant_id=v_i.tenant_id and kind='website_interview'
    and external_id='website-interview:'||p_call::text||':turn:'||p_item;
  if v_prior.id is not null and (v_prior.call_id is distinct from p_call or v_prior.outcome<>'accepted'
    or v_prior.detail->'recordedRecovery' is distinct from 'true'::jsonb) then raise exception 'interview_recovery_turn_already_applied';end if;
  -- A first recovery can finish the queue. Its exact retry may read reviewing,
  -- but a new write may not use reviewing as recovery authority.
  if v_i.state is distinct from 'unfinished' and not(v_i.state='reviewing' and v_prior.id is not null) then
    raise exception 'interview_recovery_not_unfinished';end if;
  return v_i.tenant_id;
end $$;

-- Extend the single reducer after the context-timezone migration. Ordinary
-- callers retain their exact signature and always select the active-call path.
do $recorded_recovery_core$
declare v_sql text;v_before text;v_after text;begin
  select pg_get_functiondef('public.commit_website_interview_turn_provenance_core(uuid,uuid,uuid,bigint,bigint,text,text,jsonb,text,jsonb)'::regprocedure) into v_sql;
  v_before:='p_native_operation jsonb)';
  if position(v_before in v_sql)=0 then raise exception 'recorded_recovery_signature_prior_missing';end if;
  v_sql:=replace(v_sql,v_before,'p_native_operation jsonb, p_recorded_recovery boolean)');
  v_before:='v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);';
  v_after:=$new$if p_recorded_recovery is true then
    if p_native_operation is not null or p_proposal_kind is distinct from 'correction' then raise exception 'interview_recovery_operation_invalid';end if;
    v_tenant:=public.website_interview_recorded_recovery_scope(p_owner,p_call,p_request,p_item);
  else
    v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);
  end if;$new$;
  if position(v_before in v_sql)=0 then raise exception 'recorded_recovery_scope_prior_missing';end if;
  v_sql:=replace(v_sql,v_before,v_after);
  v_before:=$old$if v_prior.detail->'nativeOperation' is distinct from p_native_operation or$old$;
  v_after:=$new$if v_prior.detail->'recordedRecovery' is distinct from (case when p_recorded_recovery then 'true'::jsonb else null end)
      or v_prior.detail->'nativeOperation' is distinct from p_native_operation or$new$;
  if position(v_before in v_sql)=0 then raise exception 'recorded_recovery_replay_prior_missing';end if;
  v_sql:=replace(v_sql,v_before,v_after);
  v_before:=$old$case when p_native_operation is null then '{}'::jsonb else jsonb_build_object('nativeOperation',p_native_operation) end);$old$;
  v_after:=$new$case when p_native_operation is null then '{}'::jsonb else jsonb_build_object('nativeOperation',p_native_operation) end
      ||case when p_recorded_recovery then jsonb_build_object('recordedRecovery',true) else '{}'::jsonb end);$new$;
  if position(v_before in v_sql)=0 then raise exception 'recorded_recovery_receipt_prior_missing';end if;
  execute replace(v_sql,v_before,v_after);
end $recorded_recovery_core$;

create or replace function public.commit_website_interview_turn_provenance_core(p_owner uuid,p_call uuid,p_request uuid,p_revision bigint,p_store_version bigint,p_digest text,p_item text,p_agenda jsonb,p_proposal_kind text,p_native_operation jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
  return public.commit_website_interview_turn_provenance_core(p_owner,p_call,p_request,p_revision,p_store_version,p_digest,p_item,p_agenda,p_proposal_kind,p_native_operation,false);
end $$;

create function public.recover_website_interview_recorded_turn(p_owner uuid,p_call uuid,p_request uuid,p_revision bigint,p_store_version bigint,p_digest text,p_item text,p_agenda jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb;v_i public.website_interviews;v_r public.receipts;v_turn public.website_interview_owner_turns;
  v_batch public.website_interview_fact_batches;v_evidence jsonb;v_refs jsonb;begin
  v_result:=public.commit_website_interview_turn_provenance_core(p_owner,p_call,p_request,p_revision,p_store_version,p_digest,p_item,p_agenda,'correction',null,true);
  select * into v_i from public.website_interviews where interview_id=(v_result->'agenda'->'binding'->>'interviewId')::uuid;
  select * into v_r from public.receipts where tenant_id=v_i.tenant_id and kind='website_interview'
    and external_id='website-interview:'||p_call::text||':turn:'||p_item;
  select * into v_turn from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item;
  v_evidence:=jsonb_build_object('turnId',p_call::text||':'||p_item,'text',v_turn.owner_text);
  if exists(select 1 from jsonb_array_elements(p_agenda->'items') item where item->'evidence' @> jsonb_build_array(v_evidence) and item->>'status'<>'corrected')
    or exists(select 1 from jsonb_array_elements(p_agenda->'candidateOverrides') item where item->'evidence' @> jsonb_build_array(v_evidence)) then
    raise exception 'interview_recovery_correction_required';end if;
  select coalesce(jsonb_agg(distinct ref),'[]'::jsonb) into v_refs from jsonb_array_elements(p_agenda->'items') item,
    jsonb_array_elements(item->'coverageRefs') ref where item->'evidence' @> jsonb_build_array(v_evidence);
  -- Final approval lists fact-batch receipts. Add the recovery's provenance with
  -- an empty fact list; no interpretation, structured fact or approval is made.
  select * into v_batch from public.website_interview_fact_batches where call_id=p_call and provider_item_id=p_item;
  if v_batch.call_id is not null and (v_batch.tenant_id is distinct from v_i.tenant_id or v_batch.interview_id is distinct from v_i.interview_id
    or v_batch.agenda_receipt_id is distinct from v_r.id or v_batch.owner_text is distinct from v_turn.owner_text
    or v_batch.interpretation_text is not null or v_batch.coverage_refs is distinct from v_refs or v_batch.facts is distinct from '[]'::jsonb) then
    raise exception 'interview_recovery_batch_conflict';end if;
  if v_batch.call_id is null then
    insert into public.website_interview_fact_batches(call_id,provider_item_id,tenant_id,interview_id,agenda_receipt_id,owner_text,coverage_refs,facts)
      values(p_call,p_item,v_i.tenant_id,v_i.interview_id,v_r.id,v_turn.owner_text,v_refs,'[]');
  end if;
  return v_result||jsonb_build_object('operationReceiptId',v_r.id,'operationRevision',v_r.readback->'agenda'->'revision');
end $$;

revoke all on function public.website_interview_recorded_recovery_scope(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.commit_website_interview_turn_provenance_core(uuid,uuid,uuid,bigint,bigint,text,text,jsonb,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.commit_website_interview_turn_provenance_core(uuid,uuid,uuid,bigint,bigint,text,text,jsonb,text,jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function public.recover_website_interview_recorded_turn(uuid,uuid,uuid,bigint,bigint,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.recover_website_interview_recorded_turn(uuid,uuid,uuid,bigint,bigint,text,text,jsonb) to service_role;
commit;
