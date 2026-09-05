begin;
create function pg_temp.check_sales_receipt(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'assertion_failed:%', label; end if; end;
$$;
create function pg_temp.sales_receipt_snapshot() returns jsonb language sql as $$
 select jsonb_build_object(
  'sessions',(select jsonb_agg(to_jsonb(s) order by session_id) from public.sales_sessions s),
  'cancellations',(select jsonb_agg(to_jsonb(c) order by session_id) from public.sales_cancellations c),
  'leads',(select jsonb_agg(to_jsonb(l) order by session_id) from public.sales_leads l),
  'transcripts',(select jsonb_agg(to_jsonb(t) order by id) from public.sales_transcript_items t),
  'usage',(select jsonb_agg(to_jsonb(u) order by session_id,provider_event_id) from public.sales_usage_events u),
  'configuration',(select to_jsonb(c) from public.sales_configuration c where singleton));
$$;
-- 1. Capability RPC privileges, private columns and RLS are unchanged.
select pg_temp.check_sales_receipt(not has_function_privilege('anon','public.sales_public_session(uuid,text,text,boolean)','execute'),'anon cannot execute');
select pg_temp.check_sales_receipt(not has_function_privilege('authenticated','public.sales_public_session(uuid,text,text,boolean)','execute'),'owner cannot execute');
select pg_temp.check_sales_receipt(has_function_privilege('service_role','public.sales_public_session(uuid,text,text,boolean)','execute'),'service can execute');
select pg_temp.check_sales_receipt((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.sales_public_session(uuid,text,text,boolean)'::regprocedure),'invoker and empty search path');
select pg_temp.check_sales_receipt(not has_column_privilege('authenticated','public.sales_sessions','provider_expiry_evidence','select'),'provider evidence remains private');
select pg_temp.check_sales_receipt(not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'sales_%' and c.relkind='r' and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege('service_role',c.oid,'delete,truncate,references,trigger'))),'FORCE RLS and minimal service grants');

insert into auth.users(id) values('97000000-0000-4000-8000-000000000099') on conflict do nothing;
update public.sales_configuration set enabled=false,owner_user_id='97000000-0000-4000-8000-000000000099',heartbeat_at=null;
insert into public.sales_sessions(session_id,request_id,token_hash,visitor_hash,network_hash,status,provider_termination_state,
 offer_sdp,answer_sdp,provider_call_id,create_intent_at,create_attempts,model,max_minutes,expires_at,created_at,
 reserved_cost_usd,observed_cost_usd,usage_state,error,provider_expiry_evidence)
select ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 repeat('a',64),repeat('b',64),repeat('c',64),status,termination,
 'private-offer-'||n,'private-answer-'||n,
 case when n in (3,4,5,6,12) then null else 'private-provider-'||n end,
 case when n in (3,4,5,6,12) then null else clock_timestamp()-interval '3 hours' end,
 case when n in (3,4,5,6,12) then 0 else 1 end,'gpt-realtime-2.1',5,
 clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 days',1.5,.107,'observed',
 case when n=2 then 'provider_session_expired' when n=4 then 'session_failed' else null end,
 case when n=2 then '{"receipt":{"evidence_reference":"private-expiry-proof"}}'::jsonb else null end
from (values
 (1,'ended','confirmed'),(2,'ended','expired'),(3,'ended','not_started'),(4,'error','not_started'),
 (5,'pending','not_started'),(6,'starting','not_started'),(7,'ready','requested'),(8,'ending','requested'),
 (9,'quarantined','unknown'),(10,'ended','unknown'),(11,'ended','requested'),
 (12,'quarantined','not_started'),(13,'ended','not_started'),(14,'error','unknown'),
 (15,'ready','confirmed'),(16,'error','expired')) as fixture(n,status,termination);
insert into public.sales_leads(session_id,fields,contact_confirmed,contact_confirmation,followup_consent,followup_consent_evidence)
select session_id,'{"email":{"value":"private@example.test","evidence_item_ids":["private-item"]}}',true,
 '{"private":"contact-evidence"}',true,'{"private":"consent-evidence"}' from public.sales_sessions where session_id::text like '97000000%';
insert into public.sales_transcript_items(session_id,provider_item_id,role,text,provider_usage)
select session_id,'private-item','user','Private customer transcript','{"private":"provider-usage"}' from public.sales_sessions where session_id::text like '97000000%';
insert into public.sales_usage_events(session_id,provider_event_id,provider_usage,observed_cost_usd)
select session_id,'private-usage-event','{"private":"usage-receipt"}',.107 from public.sales_sessions where session_id::text like '97000000%';
insert into public.sales_cancellations(session_id,token_hash,network_hash,created_at)
values('97000000-0000-4000-8000-000000000050',repeat('a',64),repeat('c',64),clock_timestamp()-interval '30 days');

set local role service_role;
do $$
declare before_state jsonb:=pg_temp.sales_receipt_snapshot(); result jsonb; expected jsonb; s public.sales_sessions;
 id uuid; n integer; action boolean; bad text; caught boolean;
begin
 -- 2. Closed provider receipts remain readable after TTL, even with admissions disabled.
 -- 3. Safe never-started and pre-create failure receipts also resolve the old capability.
 for n in 1..4 loop
  id:=('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  select * into s from public.sales_sessions where session_id=id;
  expected:=jsonb_strip_nulls(jsonb_build_object('session_id',id,'status',s.status,'max_minutes',5,
   'expires_at',s.expires_at,'provider_termination_state',s.provider_termination_state,'error',s.error));
  foreach action in array array[false,true] loop
   result:=public.sales_public_session(id,repeat('a',64),repeat('f',64),action);
   perform pg_temp.check_sales_receipt(result=expected,'exact terminal receipt allowlist without SDP/provider/lead/usage');
  end loop;
 end loop;
 -- 4. Old tombstones are token-bound receipts, without another admission or cancellation.
 id:='97000000-0000-4000-8000-000000000050';
 select jsonb_build_object('session_id',id,'status','ended','max_minutes',5,'expires_at',created_at,'provider_termination_state','not_started')
 into expected from public.sales_cancellations where session_id=id;
 foreach action in array array[false,true] loop
  perform pg_temp.check_sales_receipt(public.sales_public_session(id,repeat('a',64),repeat('f',64),action)=expected,'expired cancellation receipt is exact and replayable');
 end loop;
 -- 5. Missing, malformed and mismatched credentials still fail before any side effect.
 foreach id in array array['97000000-0000-4000-8000-000000000001'::uuid,'97000000-0000-4000-8000-000000000050'::uuid] loop
  foreach action in array array[false,true] loop
   foreach bad in array array[null::text,'',repeat('a',63),repeat('a',65),repeat('A',64),repeat('z',64),repeat('d',64)] loop
    caught:=false;
    begin perform public.sales_public_session(id,bad,repeat('c',64),action);
    exception when others then caught:=SQLERRM=case when bad=repeat('d',64) then 'session_not_found' else 'invalid_request' end; end;
    perform pg_temp.check_sales_receipt(caught,'invalid or wrong token remains rejected');
   end loop;
   caught:=false;
   begin perform public.sales_public_session(id,repeat('a',64),null,action);
   exception when others then caught:=SQLERRM='invalid_request'; end;
   perform pg_temp.check_sales_receipt(caught,'network validation remains required');
  end loop;
 end loop;
 caught:=false;
 begin perform public.sales_public_session(null,repeat('a',64),repeat('c',64));
 exception when others then caught:=SQLERRM='invalid_request'; end;
 perform pg_temp.check_sales_receipt(caught,'null session ID rejected');
 caught:=false;
 begin perform public.sales_public_session(gen_random_uuid(),repeat('a',64),repeat('c',64));
 exception when others then caught:=SQLERRM='session_not_found'; end;
 perform pg_temp.check_sales_receipt(caught,'unknown status never creates tombstone');
 -- 6. Expired active/quarantined/ambiguous/inconsistent rows cannot disclose SDP or accept end.
 for n in 5..16 loop
  id:=('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  foreach action in array array[false,true] loop
   caught:=false;
   begin perform public.sales_public_session(id,repeat('a',64),repeat('c',64),action);
   exception when others then caught:=SQLERRM='session_not_found'; end;
   perform pg_temp.check_sales_receipt(caught,'unresolved state cannot use expired capability');
  end loop;
 end loop;
 -- 7. Receipt recovery grants neither delayed start replay nor connection acknowledgement.
 for n in 1..4 loop
  id:=('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  caught:=false;
  begin perform public.sales_admit(id,repeat('a',64),repeat('b',64),repeat('c',64),'v=0');
  exception when others then caught:=SQLERRM='session_not_found'; end;
  perform pg_temp.check_sales_receipt(caught,'expired start replay rejected');
  caught:=false;
  begin perform public.sales_client_connected(id,repeat('a',64));
  exception when others then caught:=SQLERRM='session_not_found'; end;
  perform pg_temp.check_sales_receipt(caught,'expired connected rejected');
 end loop;
 caught:=false;
 begin perform public.sales_admit('97000000-0000-4000-8000-000000000050',repeat('a',64),repeat('b',64),repeat('c',64),'v=0');
 exception when others then caught:=SQLERRM='session_not_found'; end;
 perform pg_temp.check_sales_receipt(caught,'expired tombstone cannot authorize start');
 -- 8. Every row in all six sales tables is identical after reads, end replays and rejected actions.
 perform pg_temp.check_sales_receipt(pg_temp.sales_receipt_snapshot()=before_state,'no reservation, observed usage, settlement, admission, lead, transcript, configuration or tombstone mutation');
end;
$$;
reset role;

-- 9. Current ready capabilities retain normal SDP access and idempotent connected behavior.
update public.sales_sessions set expires_at=clock_timestamp()+interval '5 minutes',provider_termination_state='not_started' where session_id='97000000-0000-4000-8000-000000000007';
set local role service_role;
do $$declare id uuid:='97000000-0000-4000-8000-000000000007'; connected timestamptz;
begin
 perform pg_temp.check_sales_receipt(public.sales_public_session(id,repeat('a',64),repeat('c',64))->>'sdp'='private-answer-7','unexpired ready SDP retained');
 perform public.sales_client_connected(id,repeat('a',64));
 select client_connected_at into connected from public.sales_sessions where session_id=id;
 perform public.sales_client_connected(id,repeat('a',64));
 perform pg_temp.check_sales_receipt(connected is not null and (select client_connected_at=connected from public.sales_sessions where session_id=id),'connected stays idempotent');
end;
$$;
reset role;

-- 10. The existing end path inside TTL still ends safe pre-create requests without provider creation.
update public.sales_sessions set expires_at=clock_timestamp()-interval '1 minute' where session_id='97000000-0000-4000-8000-000000000005';
set local role service_role;
do $$declare result jsonb; begin
 result:=public.sales_public_session('97000000-0000-4000-8000-000000000005',repeat('a',64),repeat('c',64),true);
 perform pg_temp.check_sales_receipt(result->>'status'='ended' and not result ? 'sdp','in-TTL safe end retained');
 perform pg_temp.check_sales_receipt((select stop_requested and usage_state='settled' and offer_sdp='' and create_attempts=0 from public.sales_sessions where session_id='97000000-0000-4000-8000-000000000005'),'safe end retains original bookkeeping');
end;
$$;
reset role;

-- 11. Owner isolation survives the replaced RPC; private columns remain denied.
set local role authenticated;
set local request.jwt.claim.sub='97000000-0000-4000-8000-000000000099';
select pg_temp.check_sales_receipt((select count(*)=16 from public.sales_leads where session_id::text like '97000000%'),'owner can read own leads');
set local request.jwt.claim.sub='97000000-0000-4000-8000-000000000098';
select pg_temp.check_sales_receipt((select count(*)=0 from public.sales_leads),'other user cannot read leads');
reset role;

-- 12. An expired receipt frees no money: the old unsettled hold still governs new admission.
update public.sales_sessions set status='ended',usage_state='settled',observed_cost_usd=0 where session_id::text like '97000000%' and session_id<>'97000000-0000-4000-8000-000000000002';
update public.sales_configuration set enabled=true,heartbeat_at=clock_timestamp(),daily_budget_usd=1.5;
set local role service_role;
do $$declare fresh uuid:=gen_random_uuid(); caught boolean:=false; begin
 perform public.sales_public_session('97000000-0000-4000-8000-000000000002',repeat('a',64),repeat('c',64),true);
 begin perform public.sales_admit(fresh,repeat('d',64),repeat('e',64),repeat('f',64),'v=0');
 exception when others then caught:=SQLERRM='daily_budget'; end;
 perform pg_temp.check_sales_receipt(caught,'unsettled receipt retains prior-day monetary hold');
 update public.sales_configuration set daily_budget_usd=3;
 perform pg_temp.check_sales_receipt(public.sales_admit(fresh,repeat('d',64),repeat('e',64),repeat('f',64),'v=0')->>'status'='pending','normal admission works with actual budget headroom');
end;
$$;
rollback;
select 'sales_closed_receipts_passed';
