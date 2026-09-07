begin;
set local request.jwt.claim.role='service_role';
create function pg_temp.assert_ok(v boolean,label text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'assertion_failed:%',label;end if;end;$$;
select pg_temp.assert_ok(not has_table_privilege('authenticated','public.browser_interview_expiry_receipts','select') and not has_table_privilege('service_role','public.browser_interview_expiry_receipts','insert'),'private append-only receipt');
select pg_temp.assert_ok(not has_function_privilege('authenticated','public.reconcile_browser_interview_expiry(uuid,text,timestamptz,integer,text,text,text)','execute'),'owner cannot attest provider');
select pg_temp.assert_ok((select relforcerowsecurity from pg_class where oid='public.browser_interview_expiry_receipts'::regclass),'force RLS');
-- Reuse a real disposable fixture assembled by the runner; never run against production.
do $$declare tid uuid:='99000000-0000-4000-8000-000000000001'; oid uuid:='99000000-0000-4000-8000-000000000002'; cid uuid:='99000000-0000-4000-8000-000000000003'; checked timestamptz:=clock_timestamp(); n integer; caught boolean; before_call jsonb; before_budget jsonb; before_interview jsonb;
begin
 select to_jsonb(c) into before_call from public.calls c where id=cid;
 select to_jsonb(b) into before_budget from public.budget_reservations b where call_id=cid;
 select to_jsonb(i) into before_interview from public.website_interviews i where current_call_id=cid;
 perform pg_temp.assert_ok(not public.website_interview_prior_settled(tid,oid,cid,2),'unresolved call initially blocks');
 for n in 1..12 loop
  caught:=false;
  begin
   if n=1 then update calls set provider_termination_attempted_at=clock_timestamp()-interval '59 minutes' where id=cid;end if;
   if n=2 then update browser_session_requests set answer_sdp=null where call_id=cid;end if;
   if n=3 then update calls set model='unverified-model' where id=cid;end if;
   if n=4 then update calls set status='active' where id=cid;end if;
   if n=5 then update budget_reservations set status='active' where call_id=cid;end if;
   if n=6 then update calls set test_memory_generation=3 where id=cid;end if;
   if n=7 then update browser_session_requests set user_id='99000000-0000-4000-8000-000000000099' where call_id=cid;end if;
   perform public.reconcile_browser_interview_expiry(cid,case when n=8 then 'rtc_wrong' else 'rtc_fixture' end,
    case when n=9 then checked+interval '1 minute' when n=10 then checked-interval '16 minutes' else checked end,
    case when n=11 then 500 else 404 end,case when n=12 then 'not_found' else 'call_id_not_found' end,'invalid_request_error','fixture-404');
   raise exception 'unexpected_acceptance';
  exception when others then
   if sqlerrm='unexpected_acceptance' then raise;end if;
   caught:=sqlerrm like 'browser_expiry_%';
  end;
  perform pg_temp.assert_ok(caught,'reject invalid qualification '||n);
 end loop;
 perform pg_temp.assert_ok(public.reconcile_browser_interview_expiry(cid,'rtc_fixture',checked,404,'call_id_not_found','invalid_request_error','fixture-404'),'record expiry');
 perform pg_temp.assert_ok(public.reconcile_browser_interview_expiry(cid,'rtc_fixture',checked,404,'call_id_not_found','invalid_request_error','fixture-404'),'exact replay');
 caught:=false;begin perform public.reconcile_browser_interview_expiry(cid,'rtc_fixture',checked,404,'call_id_not_found','invalid_request_error','different');exception when others then caught:=sqlerrm='browser_expiry_receipt_conflict';end;
 perform pg_temp.assert_ok(caught,'conflicting receipt immutable');
 perform pg_temp.assert_ok(public.website_interview_prior_settled(tid,oid,cid,2),'same interview can resume');
 perform pg_temp.assert_ok(not public.website_interview_prior_settled(tid,oid,cid,3),'generation mismatch stays blocked');
 perform pg_temp.assert_ok(not public.website_interview_prior_settled(tid,'99000000-0000-4000-8000-000000000099',cid,2),'owner mismatch stays blocked');
 perform pg_temp.assert_ok((select to_jsonb(c)=before_call from calls c where id=cid),'provider state and entire call unchanged');
 perform pg_temp.assert_ok((select to_jsonb(b)=before_budget from budget_reservations b where call_id=cid),'budget unchanged');
 perform pg_temp.assert_ok((select to_jsonb(i)=before_interview from website_interviews i where current_call_id=cid),'interview and agenda unchanged');
end $$;
rollback;
select 'browser_interview_expiry_passed';
