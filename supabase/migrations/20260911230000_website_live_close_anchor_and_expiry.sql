begin;
set local lock_timeout='5s';

-- Live sessions have no Realtime hangup POST, so nothing ever wrote the
-- termination-attempt anchor and an unconfirmed close left the tenant wedged
-- behind website_interview_prior_settled for ever (2026-09-11, call e8168454).
-- This migration:
--   1. records the anchor (attempt id / request id / attempted_at) at the first
--      durable "close requested, not confirmed" receipt and protects
--      duration_seconds from a later zero-usage cleanup;
--   2. makes expiry receipts policy-aware: Realtime keeps its 60-minute rule,
--      Live is governed by the session's own persisted expires_at;
--   3. adds reconcile_live_session_expiry (404 session_id_not_found on the
--      attach probe after expires_at) and settle_unresolved_live_call_budget
--      (cost validated under the calls lock before the shared settlement RPC).
-- Nothing here marks a termination confirmed: only session.closed does that.

do $guard$ begin
 if to_regprocedure('public.record_website_live_termination(uuid,uuid,uuid,text,text,text,jsonb,jsonb)') is null then raise exception 'live_termination_contract_missing';end if;
 if to_regclass('public.browser_interview_expiry_receipts') is null then raise exception 'browser_expiry_receipts_contract_missing';end if;
 if to_regprocedure('public.settle_unresolved_call_budget(uuid,uuid,numeric,numeric,text,jsonb)') is null then raise exception 'unresolved_settlement_contract_missing';end if;
 if to_regprocedure('public.website_interview_prior_settled_before_stream_resume(uuid,uuid,uuid,bigint)') is null then raise exception 'live_expiry_gate_contract_missing';end if;
end $guard$;

create or replace function public.record_website_live_termination(p_owner uuid,p_call uuid,p_request uuid,p_session text,
 p_reason text,p_outcome text,p_usage jsonb,p_final_event jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tenant uuid;c public.calls;created text;finalized boolean:=false;resolved boolean:=false;voice_seconds numeric;observed_cost numeric;details jsonb;anchor uuid;begin
 tenant:=public.website_interview_scope(p_owner,p_call,p_request,false);
 select * into c from public.calls where id=p_call and tenant_id=tenant for update;
 if c.model is distinct from 'gpt-live-1' or not exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=6 and opening_mode_requested='live_managed_v1')
  or (c.openai_call_id is not null and c.openai_call_id is distinct from p_session)
  or (p_session is not null and length(btrim(p_session)) not between 1 and 512) then raise exception 'live_termination_identity_invalid';end if;
 if p_usage is null or jsonb_typeof(p_usage)<>'object' or octet_length(p_usage::text)>262000
  or coalesce(p_usage->>'creationState','') not in ('not_started','rejected','unknown','created')
  or jsonb_typeof(p_usage->'voiceSeconds') is distinct from 'number'
  or jsonb_typeof(p_usage->'totalObservedCostUsd') is distinct from 'number'
  or coalesce(p_outcome,'') not in ('ended','startup_error','killed_budget','killed_deadline','error')
  or p_reason is null or length(btrim(p_reason)) not between 1 and 200 then raise exception 'live_termination_invalid';end if;
 created:=p_usage->>'creationState';voice_seconds:=(p_usage->>'voiceSeconds')::numeric;observed_cost:=(p_usage->>'totalObservedCostUsd')::numeric;
 if voice_seconds<0 or voice_seconds>2147483647 or observed_cost<0 or observed_cost>1000000
  or (created in ('not_started','rejected') and p_session is not null) then raise exception 'live_usage_invalid';end if;
 if p_final_event is not null and p_final_event<>'null'::jsonb then
  if jsonb_typeof(p_final_event)<>'object' or not(p_final_event ?& array['eventId','sessionId','reason'])
   or p_final_event-array['eventId','sessionId','reason','seconds','expiresAt']<>'{}'
   or jsonb_typeof(p_final_event->'eventId') is distinct from 'string' or length(p_final_event->>'eventId') not between 1 and 512
   or p_final_event->>'sessionId' is distinct from p_session or p_session is null
   or coalesce(p_final_event->>'reason','') not in ('close_requested','expired','content','remote_hangup','connection_lost') then raise exception 'live_final_event_invalid';end if;
  finalized:=true;
  resolved:=coalesce(p_usage->'usageResolved'='true'::jsonb,false) and jsonb_typeof(p_final_event->'seconds')='number'
    and (p_final_event->>'seconds')::numeric=voice_seconds;
 end if;
 if created in ('not_started','rejected') then resolved:=true;end if;
 details:=p_usage||jsonb_build_object('finalEvent',p_final_event,'providerFinalized',finalized);
 if c.provider_termination_state='confirmed' then
  -- Late cleanup cannot downgrade a recorded final event or overwrite final usage.
  return jsonb_build_object('callId',c.id,'providerFinalized',true,'usageResolved',c.provider_usage_state='resolved','replayed',true);
 end if;
 -- First unconfirmed close on a created session: durable attempt anchor for expiry evidence.
 if not finalized and created='created' and p_session is not null and c.provider_termination_attempt_id is null then anchor:=gen_random_uuid();end if;
 update public.calls set
  openai_call_id=coalesce(c.openai_call_id,p_session),
  status=case when c.status<>'active' then c.status when p_outcome='startup_error' then 'error' else p_outcome end,
  ended_at=coalesce(c.ended_at,clock_timestamp()),
  duration_seconds=greatest(coalesce(c.duration_seconds,0),ceil(voice_seconds)::integer),
  cost_estimate_usd=greatest(coalesce(c.cost_estimate_usd,0),observed_cost),
  provider_termination_state=case when finalized then 'confirmed' when created in ('not_started','rejected') then 'not_required' else 'unknown' end,
  provider_termination_mode=case when p_session is null then null else 'hangup' end,
  provider_termination_reason=p_reason,provider_terminated_at=case when finalized then clock_timestamp() else null end,
  provider_termination_attempt_id=coalesce(c.provider_termination_attempt_id,anchor),
  provider_termination_request_id=coalesce(c.provider_termination_request_id,anchor::text),
  provider_termination_attempted_at=coalesce(c.provider_termination_attempted_at,case when anchor is null then null else clock_timestamp() end),
  provider_usage_state=case when resolved then 'resolved' else 'unknown' end,provider_usage_details=details
 where id=p_call and tenant_id=tenant;
 return jsonb_build_object('callId',p_call,'providerFinalized',finalized,'usageResolved',resolved,'replayed',false,
  'terminationAttemptId',coalesce(c.provider_termination_attempt_id,anchor));
end $$;
revoke all on function public.record_website_live_termination(uuid,uuid,uuid,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_website_live_termination(uuid,uuid,uuid,text,text,text,jsonb,jsonb) to service_role;

-- Policy-aware receipt window: Realtime keeps the 60-minute rule; a Live receipt
-- is only inserted by reconcile_live_session_expiry after the session's own
-- expires_at, so its window is the anchor itself.
do $receipt_check$ declare n text;begin
 select conname into n from pg_constraint where conrelid='public.browser_interview_expiry_receipts'::regclass and contype='c';
 if n is null then raise exception 'expiry_receipts_check_missing';end if;
 execute format('alter table public.browser_interview_expiry_receipts drop constraint %I',n);
 alter table public.browser_interview_expiry_receipts add constraint browser_interview_expiry_receipts_policy_check
  check ((policy='live_expires_at_and_attach_404_v1' and checked_at>=anchor_at) or (policy<>'live_expires_at_and_attach_404_v1' and checked_at>=anchor_at+interval '60 minutes'));
end $receipt_check$;

do $gate$ declare v_sql text;v_before text;v_after text;begin
 v_before:='and e.checked_at>=e.anchor_at+interval ''60 minutes''))';
 v_after:='and (e.policy=''live_expires_at_and_attach_404_v1'' and e.checked_at>=e.anchor_at or e.policy<>''live_expires_at_and_attach_404_v1'' and e.checked_at>=e.anchor_at+interval ''60 minutes'')))';
 select pg_get_functiondef('public.website_interview_prior_settled_before_stream_resume(uuid,uuid,uuid,bigint)'::regprocedure) into v_sql;
 if position(v_before in v_sql)=0 then raise exception 'live_expiry_gate_contract_missing';end if;
 execute replace(v_sql,v_before,v_after);
 select pg_get_functiondef('public.website_interview_prior_settled_before_stream_resume(uuid,uuid,uuid,bigint)'::regprocedure) into v_sql;
 if position(v_after in v_sql)=0 then raise exception 'live_expiry_gate_patch_failed';end if;
end $gate$;

create function public.reconcile_live_session_expiry(
 p_call uuid,p_provider_session_id text,p_checked_at timestamptz,p_http_status integer,
 p_error_code text,p_error_type text,p_evidence_reference text
) returns boolean language plpgsql security definer set search_path='' as $$
declare c public.calls;t public.tenants;b public.budget_reservations;prior public.browser_interview_expiry_receipts;tid uuid;
 checked_now timestamptz:=clock_timestamp();anchor_at timestamptz;attempt uuid;expires_at timestamptz;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode='42501';end if;
 select tenant_id into tid from public.calls where id=p_call;
 if tid is null then raise exception 'live_expiry_identity_mismatch';end if;
 perform pg_advisory_xact_lock(hashtextextended('ligou.company_discovery.onboarding_draft:'||tid::text,0));
 select * into t from public.tenants where id=tid for update;
 select * into c from public.calls where id=p_call for update;
 select * into b from public.budget_reservations where call_id=p_call and tenant_id=tid for update;
 if c.tenant_id is distinct from tid or p_provider_session_id is null or c.openai_call_id is distinct from p_provider_session_id
  or t.owner_user_id is null or c.test_memory_generation is distinct from t.test_memory_generation
  or c.channel is distinct from 'browser' or c.session_type is distinct from 'onboarding' then raise exception 'live_expiry_identity_mismatch';end if;
 if c.model is distinct from 'gpt-live-1' then raise exception 'live_expiry_model_unsupported';end if;
 if p_checked_at is null or p_http_status is distinct from 404 or p_error_code is distinct from 'session_id_not_found'
  or p_error_type is distinct from 'invalid_request_error' or p_evidence_reference is null
  or length(p_evidence_reference) not between 1 and 200 or p_evidence_reference !~ '^[a-zA-Z0-9:_./-]+$' then raise exception 'live_expiry_receipt_invalid';end if;
 select * into prior from public.browser_interview_expiry_receipts where call_id=p_call;
 if found then
  -- Every reconciliation tick probes again; the recorded receipt is never rewritten.
  if row(prior.provider_call_id,prior.owner_id,prior.generation,prior.termination_attempt_id,prior.anchor_at,prior.policy)
   is distinct from row(p_provider_session_id,t.owner_user_id,c.test_memory_generation,c.provider_termination_attempt_id,c.provider_termination_attempted_at,'live_expires_at_and_attach_404_v1')
   then raise exception 'live_expiry_receipt_conflict';end if;
  return true;
 end if;
 if p_checked_at>checked_now or p_checked_at<checked_now-interval '15 minutes' then raise exception 'live_expiry_receipt_invalid';end if;
 if c.provider_termination_state='confirmed' then raise exception 'live_expiry_not_applicable';end if;
 if c.status not in ('ended','error','killed_budget','killed_deadline') or c.ended_at is null or c.ended_at<c.started_at
  or c.provider_termination_state not in ('unknown','active') or b.call_id is null then raise exception 'live_expiry_not_terminal';end if;
 -- The request bound to this call (ready, cancel_requested or expired). A ready
 -- payload must name the same provider session.
 if not exists(select 1 from public.browser_session_requests r where r.call_id=c.id and r.tenant_id=c.tenant_id and r.user_id=t.owner_user_id
   and r.test_memory_generation=c.test_memory_generation and r.onboarding_protocol_version=6 and r.opening_mode_requested='live_managed_v1'
   and r.status in ('ready','cancel_requested','expired')
   and (r.opening_payload is null or r.opening_payload->'live'->>'sessionId'=p_provider_session_id))
  then raise exception 'live_expiry_anchor_missing';end if;
 attempt:=c.provider_termination_attempt_id;anchor_at:=c.provider_termination_attempted_at;
 if attempt is null then
  if anchor_at is not null or c.provider_termination_request_id is not null then raise exception 'live_expiry_anchor_missing';end if;
  attempt:=gen_random_uuid();anchor_at:=c.ended_at;   -- the durable terminal receipt is the conservative anchor
 end if;
 -- Live policy: the session's own persisted expires_at (Unix seconds) must have passed.
 if jsonb_typeof(c.provider_usage_details->'expiresAt') is distinct from 'number' then raise exception 'live_expiry_evidence_missing';end if;
 expires_at:=to_timestamp((c.provider_usage_details->>'expiresAt')::double precision);
 if p_checked_at<expires_at then raise exception 'live_expiry_not_elapsed';end if;
 if c.provider_termination_attempt_id is null then
  update public.calls set provider_termination_attempt_id=attempt,provider_termination_request_id=attempt::text,
   provider_termination_attempted_at=anchor_at,provider_termination_mode=coalesce(provider_termination_mode,'hangup') where id=c.id;
 end if;
 insert into public.browser_interview_expiry_receipts(call_id,tenant_id,owner_id,generation,provider_call_id,termination_attempt_id,anchor_at,checked_at,evidence_reference,policy)
 values(c.id,c.tenant_id,t.owner_user_id,c.test_memory_generation,c.openai_call_id,attempt,anchor_at,p_checked_at,p_evidence_reference,'live_expires_at_and_attach_404_v1');
 return true;
end $$;
revoke all on function public.reconcile_live_session_expiry(uuid,text,timestamptz,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.reconcile_live_session_expiry(uuid,text,timestamptz,integer,text,text,text) to service_role;

-- Settlement wrapper: the observed floor sent by the controller must equal the
-- persisted cost under the calls lock; the shared RPC keeps every other rule.
create function public.settle_unresolved_live_call_budget(p_tenant uuid,p_call uuid,p_estimated_cost numeric,p_minutes numeric,p_outcome text,p_detail jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare c public.calls;begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode='42501';end if;
 -- Same lock order as reconcile_live_session_expiry and settle_unresolved_call_budget: tenant first.
 perform 1 from public.tenants t where t.id=p_tenant for update;
 if not found then raise exception 'tenant_not_found' using errcode='P0002';end if;
 select * into c from public.calls where id=p_call and tenant_id=p_tenant for update;
 if c.id is null or c.model is distinct from 'gpt-live-1' then raise exception 'live_settlement_scope_invalid';end if;
 if not exists(select 1 from public.browser_interview_expiry_receipts e where e.call_id=p_call and e.policy='live_expires_at_and_attach_404_v1') then raise exception 'live_settlement_receipt_missing';end if;
 if p_estimated_cost is null or c.cost_estimate_usd is distinct from p_estimated_cost then raise exception 'live_settlement_cost_changed' using errcode='40001';end if;
 return public.settle_unresolved_call_budget(p_tenant,p_call,p_estimated_cost,p_minutes,p_outcome,p_detail);
end $$;
revoke all on function public.settle_unresolved_live_call_budget(uuid,uuid,numeric,numeric,text,jsonb) from public,anon,authenticated;
grant execute on function public.settle_unresolved_live_call_budget(uuid,uuid,numeric,numeric,text,jsonb) to service_role;

commit;
