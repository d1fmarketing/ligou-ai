begin;
create function pg_temp.check_sales(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'assertion_failed:%',label;end if;end;$$;
select pg_temp.check_sales(not has_function_privilege('anon','public.sales_reconcile_provider_expiry(uuid,text,timestamp with time zone,integer,text,text,text)','execute'),'anon cannot reconcile');
select pg_temp.check_sales(not has_function_privilege('authenticated','public.sales_reconcile_provider_expiry(uuid,text,timestamp with time zone,integer,text,text,text)','execute'),'owner cannot reconcile');
select pg_temp.check_sales(has_function_privilege('service_role','public.sales_reconcile_provider_expiry(uuid,text,timestamp with time zone,integer,text,text,text)','execute'),'service can reconcile');
select pg_temp.check_sales(not (select prosecdef from pg_proc where oid='public.sales_reconcile_provider_expiry(uuid,text,timestamp with time zone,integer,text,text,text)'::regprocedure),'invoker function');
select pg_temp.check_sales(not has_column_privilege('authenticated','public.sales_sessions','provider_expiry_evidence','select'),'expiry receipt stays private');
select pg_temp.check_sales((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.sales_sessions'::regclass),'FORCE RLS unchanged');
insert into auth.users(id) values('98000000-0000-4000-8000-000000000001') on conflict do nothing;
update public.sales_configuration set enabled=true,owner_user_id='98000000-0000-4000-8000-000000000001',heartbeat_at=clock_timestamp(),daily_budget_usd=15;
insert into public.sales_sessions(session_id,request_id,token_hash,visitor_hash,network_hash,status,offer_sdp,answer_sdp,provider_call_id,model,max_minutes,created_at,create_intent_at,expires_at,stop_requested,claim_token,lease_expires_at,reserved_cost_usd,observed_cost_usd,usage_state,provider_termination_state)
select ('98000000-0000-4000-8000-00000000000'||n)::uuid,('98000000-0000-4000-8000-00000000000'||n)::uuid,repeat('a',64),repeat('b',64),repeat('c',64),'quarantined','offer','answer',case when n=4 then null else 'rtc_expiry_'||n end,case when n=5 then 'other-model' else 'gpt-realtime-2.1' end,5,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours'+interval '1 second',clock_timestamp()-interval '115 minutes',true,gen_random_uuid(),clock_timestamp()+interval '30 seconds',1.5,.091033,'observed','unknown' from generate_series(1,5)n;
insert into public.sales_transcript_items(session_id,provider_item_id,role,text,context,created_at)
select session_id,'provider-first','assistant','Olá, sou uma IA da Ligou.','real',case when right(session_id::text,1)='2' then clock_timestamp()-interval '59 minutes' else created_at+interval '2 seconds' end from public.sales_sessions where session_id::text like '98000000%' and right(session_id::text,1)<>'3';
insert into public.sales_leads(session_id,fields,followup_consent) values('98000000-0000-4000-8000-000000000001','{"company":{"value":"ACME","evidence_item_ids":["existing"]}}',false);
set local role service_role;
do $$declare checked timestamptz:=clock_timestamp(); result jsonb; replay jsonb; before_fields jsonb; old_fence uuid; n integer; bad_call text; caught boolean;
begin
 select claim_token into old_fence from public.sales_sessions where session_id='98000000-0000-4000-8000-000000000001';
 select fields into before_fields from public.sales_leads where session_id='98000000-0000-4000-8000-000000000001';
 for n in 2..5 loop
  caught:=false;bad_call:='rtc_expiry_'||n;
  begin perform public.sales_reconcile_provider_expiry(('98000000-0000-4000-8000-00000000000'||n)::uuid,bad_call,checked,404,'call_id_not_found','invalid_request_error','test-invalid');
  exception when others then caught:=SQLERRM in ('provider_expiry_not_elapsed','provider_expiry_anchor_missing','provider_expiry_identity_mismatch','provider_expiry_model_unsupported');end;
  perform pg_temp.check_sales(caught,'reject 59min, missing transcript, unknown provider, unsupported model');
 end loop;
 for n in 1..4 loop
  caught:=false;
  begin perform public.sales_reconcile_provider_expiry('98000000-0000-4000-8000-000000000001','rtc_expiry_1',case n when 1 then checked+interval '1 minute' when 2 then checked-interval '16 minutes' else checked end,case when n=3 then 500 else 404 end,case when n=4 then 'not_found' else 'call_id_not_found' end,'invalid_request_error','test-invalid');
  exception when others then caught:=SQLERRM='provider_expiry_receipt_invalid';end;
  perform pg_temp.check_sales(caught,'reject future/stale/generic-error receipt');
 end loop;
 result:=public.sales_reconcile_provider_expiry('98000000-0000-4000-8000-000000000001','rtc_expiry_1',checked,404,'call_id_not_found','invalid_request_error','fixture-404');
 perform pg_temp.check_sales(result->>'status'='ended' and result->>'provider_termination_state'='expired','expiry differs from confirmed');
 replay:=public.sales_reconcile_provider_expiry('98000000-0000-4000-8000-000000000001','rtc_expiry_1',checked,404,'call_id_not_found','invalid_request_error','fixture-404');
 perform pg_temp.check_sales(result=replay,'exact replay idempotent');
 caught:=false;begin perform public.sales_reconcile_provider_expiry('98000000-0000-4000-8000-000000000001','rtc_expiry_1',checked,404,'call_id_not_found','invalid_request_error','different-receipt');exception when others then caught:=SQLERRM='provider_expiry_receipt_conflict';end;
 perform pg_temp.check_sales(caught,'different receipt cannot rewrite audit');
 perform pg_temp.check_sales((select reserved_cost_usd=1.5 and observed_cost_usd=.091033 and usage_state='observed' and claim_token is null and lease_expires_at is null and answer_sdp is null and offer_sdp='' and provider_expiry_evidence->>'source'='realtime_max_duration_60m_and_sideband_404' from public.sales_sessions where session_id='98000000-0000-4000-8000-000000000001'),'hold/usage preserved and stale worker fenced');
 perform pg_temp.check_sales((select fields=before_fields and not followup_consent from public.sales_leads where session_id='98000000-0000-4000-8000-000000000001'),'lead preserved');
 caught:=false;begin perform public.sales_worker_apply('98000000-0000-4000-8000-000000000001',old_fence,'termination','{"state":"unknown"}');exception when others then caught:=SQLERRM='stale_claim';end;
 perform pg_temp.check_sales(caught,'old worker cannot revive expired session');
end;$$;
reset role;
-- Remove only invalid fixtures from concurrency consideration; reconciliation above changed only the accepted row.
update public.sales_sessions set status='ended' where session_id::text like '98000000%' and right(session_id::text,1)<>'1';
update public.sales_sessions set usage_state='settled',observed_cost_usd=0 where session_id::text like '98000000%' and right(session_id::text,1)<>'1';
-- Keep the expired debt across UTC days.
update public.sales_sessions set created_at=clock_timestamp()-interval '2 days' where session_id='98000000-0000-4000-8000-000000000001';
update public.sales_configuration set daily_budget_usd=1.5,heartbeat_at=clock_timestamp();
set local role service_role;
do $$declare caught boolean:=false; fresh uuid:=gen_random_uuid();begin
 perform pg_temp.check_sales(public.sales_claim('expiry-test') is null,'expired is not reclaimed for more hangups');
 begin perform public.sales_admit(fresh,repeat('d',64),repeat('e',64),repeat('f',64),'v=0');exception when others then caught:=SQLERRM='daily_budget';end;
 perform pg_temp.check_sales(caught,'unsettled expired hold blocks money, not concurrency');
 update public.sales_configuration set daily_budget_usd=3;
 perform pg_temp.check_sales(public.sales_admit(fresh,repeat('d',64),repeat('e',64),repeat('f',64),'v=0')->>'status'='pending','expired frees one slot with sufficient budget');
end;$$;
rollback;
select 'sales_expiry_passed';
