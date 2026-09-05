begin;
create function pg_temp.check_sales_preflight(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'assertion_failed:%', label; end if; end;
$$;
insert into auth.users(id) values('98000000-0000-4000-8000-000000000099');
update public.sales_configuration set enabled=true,owner_user_id='98000000-0000-4000-8000-000000000099',heartbeat_at=clock_timestamp(),daily_budget_usd=1.5;
set local role service_role;
do $$
declare
 sid uuid:='98000000-0000-4000-8000-000000000001';
 next_id uuid:='98000000-0000-4000-8000-000000000002';
 known_id uuid:='98000000-0000-4000-8000-000000000003';
 attempt_id uuid:='98000000-0000-4000-8000-000000000004';
 claim uuid; result jsonb; before_state jsonb; after_state jsonb; caught boolean; i integer;
begin
 -- Acknowledged intent, followed by a no-ID stop before provider POST dispatch.
 perform public.sales_admit(sid,repeat('a',64),repeat('b',64),repeat('c',64),'v=0');
 result:=public.sales_claim('preflight-fixture');claim:=(result->>'claim_token')::uuid;
 perform public.sales_worker_apply(sid,claim,'create_intent','{"model":"gpt-realtime-2.1"}');
 perform public.sales_worker_apply(sid,claim,'quarantine','{"error":"stopped_before_provider_dispatch"}');
 select to_jsonb(s) into before_state from public.sales_sessions s where session_id=sid;
 caught:=false;
 begin perform public.sales_worker_apply(sid,claim,'fail','{}');
 exception when others then caught:=SQLERRM='ambiguous_failure_requires_quarantine';end;
 perform pg_temp.check_sales_preflight(caught,'unresolved intent cannot fail');
 select to_jsonb(s) into after_state from public.sales_sessions s where session_id=sid;
 perform pg_temp.check_sales_preflight(before_state=after_state,'blocked fail preserves unresolved row and hold');
 caught:=false;
 begin perform public.sales_admit(next_id,repeat('a',64),repeat('d',64),repeat('c',64),'v=0');
 exception when others then caught:=SQLERRM='global_busy';end;
 perform pg_temp.check_sales_preflight(caught,'unresolved intent retains global slot');

 -- Runtime has independently proved beforeAttempt never returned to POST.
 -- SQL trusts that existing service-only rejection operation; it cannot observe network dispatch.
 perform public.sales_worker_apply(sid,claim,'provider_rejected','{}');
 result:=public.sales_worker_apply(sid,claim,'fail','{}');
 perform pg_temp.check_sales_preflight(result->>'status'='error' and result->>'provider_termination_state'='not_started','zero-attempt terminal state');
 perform pg_temp.check_sales_preflight(result->>'usage_state'='settled' and (result->>'observed_cost_usd')::numeric=0 and (result->>'reserved_cost_usd')::numeric=1.5,'zero cost settles without rewriting nominal reservation');
 perform pg_temp.check_sales_preflight(result->>'provider_call_id' is null and result->>'create_intent_at' is null and result->>'offer_sdp'='' and (result->>'stop_requested')::boolean,'no provider authority remains');
 before_state:=result;
 result:=public.sales_worker_apply(sid,claim,'fail','{}');
 perform pg_temp.check_sales_preflight((result-'updated_at')=(before_state-'updated_at'),'fail replay preserves terminal receipt');
 result:=public.sales_public_session(sid,repeat('a',64),repeat('c',64),false);
 perform pg_temp.check_sales_preflight(result->>'status'='error' and result->>'provider_termination_state'='not_started' and not (result ? 'sdp') and not (result ? 'provider_call_id'),'current public recovery is terminal and private');

 -- Cross the capability action TTL without waiting; both status and end are receipt-only.
 update public.sales_sessions set expires_at=clock_timestamp()-interval '2 hours' where session_id=sid;
 select to_jsonb(s) into before_state from public.sales_sessions s where session_id=sid;
 for i in 0..1 loop
  result:=public.sales_public_session(sid,repeat('a',64),repeat('c',64),i=1);
  perform pg_temp.check_sales_preflight(result->>'status'='error' and result->>'provider_termination_state'='not_started' and not (result ? 'sdp'),'expired capability recovers no-provider receipt');
 end loop;
 select to_jsonb(s) into after_state from public.sales_sessions s where session_id=sid;
 perform pg_temp.check_sales_preflight(before_state=after_state,'expired receipt recovery changes nothing');

 -- Tight $1.50 budget proves zero-attempt cancellation releases its effective hold and slot.
 result:=public.sales_admit(next_id,repeat('a',64),repeat('d',64),repeat('c',64),'v=0');
 perform pg_temp.check_sales_preflight(result->>'status'='pending','new admission succeeds under one-reservation budget');
 perform public.sales_public_session(next_id,repeat('a',64),repeat('c',64),true);

 -- A known provider with observed, unfinalized usage can never use provider_rejected/fail.
 perform public.sales_admit(known_id,repeat('a',64),repeat('e',64),repeat('c',64),'v=0');
 result:=public.sales_claim('preflight-fixture');claim:=(result->>'claim_token')::uuid;
 perform public.sales_worker_apply(known_id,claim,'create_intent','{"model":"gpt-realtime-2.1"}');
 perform public.sales_worker_apply(known_id,claim,'provider_ready','{"model":"gpt-realtime-2.1","provider_call_id":"fixture-known-provider","answer_sdp":"private-answer"}');
 perform public.sales_worker_apply(known_id,claim,'usage','{"observed_cost_usd":0.12,"final":false}');
 perform public.sales_worker_apply(known_id,claim,'termination','{"state":"unknown"}');
 select to_jsonb(s) into before_state from public.sales_sessions s where session_id=known_id;
 caught:=false;
 begin perform public.sales_worker_apply(known_id,claim,'provider_rejected','{}');
 exception when others then caught:=SQLERRM='rejection_not_allowed';end;
 perform pg_temp.check_sales_preflight(caught,'known provider cannot clear intent');
 caught:=false;
 begin perform public.sales_worker_apply(known_id,claim,'fail','{}');
 exception when others then caught:=SQLERRM='ambiguous_failure_requires_quarantine';end;
 perform pg_temp.check_sales_preflight(caught,'known provider cannot fail');
 select to_jsonb(s) into after_state from public.sales_sessions s where session_id=known_id;
 perform pg_temp.check_sales_preflight(before_state=after_state,'blocked known-provider paths preserve uncertainty and usage');
 perform pg_temp.check_sales_preflight(after_state->>'provider_termination_state'='unknown' and after_state->>'usage_state'='observed' and (after_state->>'observed_cost_usd')::numeric=.12,'unknown provider usage remains observed');
 caught:=false;
 begin perform public.sales_admit(attempt_id,repeat('a',64),repeat('f',64),repeat('c',64),'v=0');
 exception when others then caught:=SQLERRM='global_busy';end;
 perform pg_temp.check_sales_preflight(caught,'known unresolved provider retains slot');

 perform public.sales_worker_apply(known_id,claim,'termination','{"state":"confirmed"}');
 caught:=false;
 begin perform public.sales_worker_apply(known_id,claim,'fail','{}');
 exception when others then caught:=SQLERRM='ambiguous_failure_requires_quarantine';end;
 perform pg_temp.check_sales_preflight(caught,'known confirmed provider cannot become not-started');
 caught:=false;
 begin perform public.sales_admit(attempt_id,repeat('a',64),repeat('f',64),repeat('c',64),'v=0');
 exception when others then caught:=SQLERRM='daily_budget';end;
 perform pg_temp.check_sales_preflight(caught,'confirmed provider with unfinalized usage retains financial hold');
end;$$;
reset role;
select pg_temp.check_sales_preflight(not has_function_privilege('anon','public.sales_worker_apply(uuid,uuid,text,jsonb)','execute'),'anon RPC remains denied');
select pg_temp.check_sales_preflight(not has_function_privilege('authenticated','public.sales_worker_apply(uuid,uuid,text,jsonb)','execute'),'authenticated RPC remains denied');
select pg_temp.check_sales_preflight(has_function_privilege('service_role','public.sales_worker_apply(uuid,uuid,text,jsonb)','execute'),'service RPC remains allowed');
select pg_temp.check_sales_preflight((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.sales_worker_apply(uuid,uuid,text,jsonb)'::regprocedure),'invoker and empty search path unchanged');
rollback;
select 'sales_preflight_regression_passed';
