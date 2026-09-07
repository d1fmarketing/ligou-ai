begin;

-- A protocol-3 startup initializes the interview before creating Realtime. When
-- every provider response is a definitive rejection, server.ts records this
-- exact no-provider terminal state and settles any independently incurred TTS
-- cost. Permit the next Start to attach the unchanged interview; never invent a
-- provider identity/termination receipt or alter the failed attempt's history.
create or replace function public.website_interview_prior_settled_noninitial(
  p_tenant uuid,p_owner uuid,p_call uuid,p_generation bigint
) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_call public.calls; v_budget public.budget_reservations; begin
  select c.* into v_call from public.calls c where c.id=p_call and c.tenant_id=p_tenant for update;
  select b.* into v_budget from public.budget_reservations b where b.call_id=p_call and b.tenant_id=p_tenant for update;

  -- Preserve the existing confirmed-provider and recorded real-expiry branches.
  if coalesce(v_call.channel='browser' and v_call.session_type='onboarding' and v_call.test_memory_generation=p_generation
    and v_call.status in ('ended','error','killed_budget','killed_deadline') and v_call.ended_at is not null
    and (v_call.provider_termination_state='confirmed' or exists(select 1 from public.browser_interview_expiry_receipts e
      where e.call_id=v_call.id and e.tenant_id=p_tenant and e.owner_id=p_owner and e.generation=p_generation
        and e.provider_call_id=v_call.openai_call_id and e.termination_attempt_id=v_call.provider_termination_attempt_id
        and e.anchor_at=v_call.provider_termination_attempted_at and e.checked_at<=clock_timestamp()
        and e.checked_at>=e.anchor_at+interval '60 minutes'))
    and v_budget.status='settled' and exists(select 1 from public.browser_session_requests br where br.call_id=p_call
      and br.tenant_id=p_tenant and br.user_id=p_owner and br.test_memory_generation=p_generation),false)
  then return true; end if;

  if not coalesce(v_call.channel='browser' and v_call.session_type='onboarding' and v_call.test_memory_generation=p_generation
    and v_call.status='error' and v_call.ended_at is not null and v_call.duration_seconds=0
    and v_call.provider_termination_state='not_required' and v_call.provider_termination_reason='realtime_unavailable'
    and v_call.openai_call_id is null and v_call.provider_termination_mode is null
    and v_call.provider_termination_attempt_id is null and v_call.provider_termination_attempted_at is null
    and v_call.provider_terminated_at is null and v_call.transcript='[]'::jsonb
    and v_call.provider_usage_state='resolved' and v_call.cost_estimate_usd>=0
    and v_budget.status='settled' and v_budget.outcome='startup_error'
    and v_budget.final_cost_usd=v_call.cost_estimate_usd and v_budget.final_minutes=0 and v_budget.settled_at is not null,false)
  then return false; end if;

  return exists(
    select 1 from public.website_interviews i
    join public.tenants t on t.id=i.tenant_id and t.owner_user_id=i.owner_id and t.test_memory_generation=i.generation
    join public.website_interview_preparations p on p.id=i.preparation_id and p.tenant_id=i.tenant_id
      and p.owner_id=i.owner_id and p.generation=i.generation and p.consumed_call_id=i.interview_id and p.consumed_at is not null
    join public.website_interview_calls wc on wc.call_id=i.current_call_id and wc.interview_id=i.interview_id and wc.tenant_id=i.tenant_id
    join public.browser_session_requests br on br.id=wc.request_id and br.call_id=wc.call_id and br.tenant_id=wc.tenant_id
    join public.receipts initialized on initialized.tenant_id=i.tenant_id and initialized.call_id=i.interview_id
      and initialized.kind='website_interview' and initialized.outcome='accepted'
      and initialized.external_id='website-interview:'||i.interview_id::text||':initialize'
      and initialized.detail->>'preparationId'=p.id::text
    join public.receipts latest on latest.id=i.receipt_id and latest.tenant_id=i.tenant_id and latest.call_id=i.current_call_id
      and latest.kind='website_interview' and latest.outcome='accepted' and latest.payload_hash=i.digest
      and latest.readback->'agenda'=i.agenda
    where i.current_call_id=p_call and i.tenant_id=p_tenant and i.owner_id=p_owner and i.generation=p_generation
      and t.status='onboarding' and t.operational_mode='simulation_only' and i.state='unfinished'
      and i.parent_interview_id is null and i.amendment_request_receipt_id is null
      and br.user_id=p_owner and br.session_type='onboarding' and br.test_memory_generation=p_generation
      and br.onboarding_protocol_version=3 and br.opening_mode_requested='application_tts_v1'
      and br.status='error' and br.error='realtime_unavailable'
      and br.answer_sdp is null and br.opening_mode_applied is null and br.opening_payload is null
      and public.website_interview_source_valid(p_tenant,p_owner,p.draft_id,p.draft_hash,p.result_id,p.result_hash)
      and i.agenda->'binding'=jsonb_build_object('interviewId',i.interview_id,'callId',p_call,
        'draftId',p.draft_id,'draftHash',p.draft_hash,'sourceResultId',p.result_id,'sourceResultHash',p.result_hash)
      -- Attach changes only callId. Comparing against the append-only initial
      -- receipt also supports repeated empty rejections without resetting state.
      and i.agenda=jsonb_set(initialized.readback->'agenda','{binding,callId}',to_jsonb(p_call::text))
      and initialized.payload_hash=encode(extensions.digest(public.onboarding_canonical_json_v1(initialized.readback->'agenda'),'sha256'),'hex')
      and i.digest=encode(extensions.digest(public.onboarding_canonical_json_v1(i.agenda),'sha256'),'hex')
      and not exists(select 1 from public.website_interview_owner_turns ot
        join public.website_interview_calls history on history.call_id=ot.call_id where history.interview_id=i.interview_id)
      and not exists(select 1 from public.website_interview_fact_batches f where f.interview_id=i.interview_id)
      and not exists(select 1 from public.website_interview_summaries s where s.interview_id=i.interview_id)
      and not exists(select 1 from public.website_interview_approvals a where a.interview_id=i.interview_id)
      and not exists(select 1 from public.website_interview_amendment_requests a where a.interview_id=i.interview_id)
      and not exists(select 1 from public.website_interview_speech s where s.interview_id=i.interview_id
        and (s.status='played' or s.played_at is not null or s.played_receipt_id is not null))
      and not exists(select 1 from public.website_interviews newer where newer.tenant_id=p_tenant and newer.created_at>i.created_at)
      and not exists(select 1 from public.website_interview_preparations pending where pending.tenant_id=p_tenant and pending.consumed_call_id is null)
      -- Eligibility runs before Start; resolve/attach run after their one new
      -- bound call exists. A second attempt or an intervening failed call must
      -- never use this older attempt as authority to resume.
      and (select count(*) from public.calls active where active.tenant_id=p_tenant and active.status='active')<=1
      and not exists(select 1 from public.calls later where later.tenant_id=p_tenant and later.id<>p_call
        and (later.started_at>=v_call.started_at or later.status='active') and not coalesce(
          later.status='active' and later.started_at>=v_call.started_at and later.ended_at is null
          and later.channel='browser' and later.session_type='onboarding' and later.test_memory_generation=p_generation
          and later.openai_call_id is null and later.provider_termination_state='not_required'
          and later.provider_termination_attempt_id is null and later.provider_termination_attempted_at is null
          and later.transcript='[]'::jsonb
          and not exists(select 1 from public.website_interview_calls bound where bound.call_id=later.id)
          and exists(select 1 from public.browser_session_requests next_request where next_request.call_id=later.id
            and next_request.tenant_id=p_tenant and next_request.user_id=p_owner and next_request.session_type='onboarding'
            and next_request.test_memory_generation=p_generation and next_request.onboarding_protocol_version=3
            and next_request.opening_mode_requested='application_tts_v1' and next_request.status='processing'
            and next_request.answer_sdp is null and next_request.opening_mode_applied is null and next_request.opening_payload is null)
        ,false))
      and not exists(select 1 from public.browser_session_requests pending where pending.tenant_id=p_tenant
        and pending.call_id is null and pending.status in ('pending','processing','ready','cancel_requested'))
  );
end $$;

-- CREATE OR REPLACE retains the existing private helper's ACL. No new RPC or
-- grant, and no mutation of calls, reservations, interviews, or source rows.
commit;
