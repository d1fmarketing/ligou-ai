-- Real PostgreSQL operations in an isolated fixture. No provider/audio claim.
do $$declare c uuid:='9b000000-0000-4000-8000-000000000004';r uuid:='9b000000-0000-4000-8000-000000000005';
 o uuid:='9b000000-0000-4000-8000-000000000001';t uuid:='9b000000-0000-4000-8000-000000000003';
 i public.website_interviews;op text;result jsonb;again jsonb;caught boolean:=false;old_source jsonb;begin
 if to_regclass('public.website_interview_live_fragments') is null then raise exception 'live_fragment_store_missing';end if;
 update browser_session_requests set onboarding_protocol_version=6,opening_mode_requested='live_managed_v1',status='ready',answer_sdp='live-fixture-answer',
 opening_mode_applied='live_managed_v1',opening_payload=jsonb_build_object('version',6,'live',jsonb_build_object('callId',c,'interviewId',c,'revision',0,
 'sourceDigest',(select digest from website_interviews where interview_id=c),'sessionId','live-fixture')) where id=r;
 update calls set model='gpt-live-1',openai_call_id='live-fixture',provider_termination_state='active',provider_usage_state='unknown' where id=c;
 select * into i from website_interviews where interview_id=c;old_source:=i.agenda;
 perform public.record_website_live_fragments(o,c,r,'live-fixture','[
 {"eventId":"evt-z","speaker":"owner","text":"No domingo, ","startMs":100,"endMs":500},
 {"eventId":"evt-2","speaker":"assistant","text":"Uhum.","startMs":400,"endMs":600},
 {"eventId":"evt-a","speaker":"owner","text":"somente emergências.","startMs":100,"endMs":500}]');
 -- Explicit target is schedule although the old queue cursor is still area.
 op:='ligou-live-op:'||encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(1,t,c,c,'live-fixture','answer',jsonb_build_array('schedule'),jsonb_build_array('evt-a','evt-z'))),'sha256'),'hex');
 result:=public.commit_website_live_decision(o,c,r,'live-fixture',op,0,i.db_version,i.digest,'answer','schedule',array['evt-a','evt-z'],'Domingo: somente emergências.');
 if result->>'operationRef'<>op or (result->>'revision')::int<>1 then raise exception 'live_commit_receipt_missing';end if;
 if (select agenda->'items'->0 from website_interviews where interview_id=c) is distinct from old_source->'items'->0 then raise exception 'live_answer_retargeted_to_cursor';end if;
 if (select agenda->'items'->2->>'status' from website_interviews where interview_id=c)<>'answered' then raise exception 'live_target_not_saved';end if;
 if exists(select 1 from website_interview_owner_turns where call_id=c) then raise exception 'fake_provider_turn_created';end if;
 if (select source_text from website_interview_live_operations where call_id=c and operation_ref=op)<>'No domingo, somente emergências.' then raise exception 'live_literal_source_changed';end if;
 again:=public.commit_website_live_decision(o,c,r,'live-fixture',op,0,i.db_version,i.digest,'answer','schedule',array['evt-z','evt-a'],'Domingo: somente emergências.');
 if again->>'operationReceiptId'<>result->>'operationReceiptId' or not (again->>'replayed')::boolean then raise exception 'live_replay_duplicated';end if;
 begin perform public.commit_website_live_decision(o,c,r,'live-fixture',op,0,i.db_version,i.digest,'answer','schedule',array['evt-a','evt-z'],'Domingo: atendimento normal.');
 exception when others then caught:=sqlerrm='live_operation_conflict';end;
 if not caught then raise exception 'changed_replay_not_rejected';end if;
 caught:=false;
 begin perform public.record_website_live_fragments(o,c,r,'live-fixture','[{"eventId":"evt-z","speaker":"owner","text":"Outra fala","startMs":100,"endMs":500}]');
 exception when others then caught:=sqlerrm='live_fragment_conflict';end;
 if not caught then raise exception 'source_event_rewritten';end if;
 if (select count(*) from website_interview_live_operations where call_id=c)<>1 then raise exception 'unexpected_live_operations';end if;
 if exists(select 1 from website_interview_approvals where interview_id=c) then raise exception 'business_approval_fabricated';end if;
end $$;
select 'live_explicit_target_provenance_replay_passed';

do $$declare c uuid:='9b000000-0000-4000-8000-000000000004';r uuid:='9b000000-0000-4000-8000-000000000005';
 o uuid:='9b000000-0000-4000-8000-000000000001';t uuid:='9b000000-0000-4000-8000-000000000003';
 i public.website_interviews;op text;proof jsonb;caught boolean;refs text[];begin
 select * into i from website_interviews where interview_id=c;
 select operation_ref into op from website_interview_live_operations where call_id=c;
 proof:=public.read_website_live_operation(o,c,r,op);
 if proof->>'targetId'<>'schedule' or proof->>'providerSessionId'<>'live-fixture' or (proof->>'operationRevision')::int<>1 then raise exception 'live_lost_receipt_readback_failed';end if;
 caught:=false;
 begin perform public.read_website_live_operation('9b000000-0000-4000-8000-000000000002',c,r,op);
 exception when insufficient_privilege then caught:=true;end;
 if not caught then raise exception 'other_owner_read_allowed';end if;
 caught:=false;
 begin perform public.record_website_live_fragments(o,c,r,'wrong-session','[]');exception when insufficient_privilege then caught:=true;end;
 if not caught then raise exception 'other_provider_session_allowed';end if;
 -- Long streaming sessions emit more than 512 fragments. The batch bound does
 -- not impose a cumulative cap on evidence references for a business decision.
 perform public.record_website_live_fragments(o,c,r,'live-fixture',(select jsonb_agg(jsonb_build_object('eventId','long-'||n,'speaker','owner','text','x','startMs',2000+n,'endMs',2001+n)) from generate_series(1,512)n));
 perform public.record_website_live_fragments(o,c,r,'live-fixture','[{"eventId":"correction","speaker":"owner","text":"Corrigindo: domingo fechado.","startMs":3000,"endMs":4000}]');
 select array_agg(event_id order by event_id) into refs from website_interview_live_fragments where call_id=c and speaker='owner';
 if cardinality(refs)<=512 then raise exception 'long_fixture_missing';end if;
 op:='ligou-live-op:'||encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(1,t,c,c,'live-fixture','correction',jsonb_build_array('schedule'),to_jsonb(refs))),'sha256'),'hex');
 caught:=false;
 begin perform public.commit_website_live_decision(o,c,r,'live-fixture',op,0,i.db_version,i.digest,'correction','schedule',refs,'Domingo fechado.');
 exception when serialization_failure then caught:=true;end;
 if not caught then raise exception 'stale_revision_committed';end if;
 proof:=public.commit_website_live_decision(o,c,r,'live-fixture',op,1,i.db_version,i.digest,'correction','schedule',refs,'Domingo fechado.');
 if (proof->>'revision')::int<>2 or (select agenda->'items'->2->'evidence'->-1->>'text' from website_interviews where interview_id=c)<>'Domingo fechado.' then raise exception 'explicit_correction_failed';end if;
 if (select agenda->'items'->0->>'status' from website_interviews where interview_id=c)<>'open' then raise exception 'correction_modified_unrelated_target';end if;
end $$;
select 'live_scope_correction_long_session_passed';

-- Test actual SQL execution privileges, not just a JWT role string.
set role authenticated;
do $$begin
 begin perform public.read_website_live_operation('9b000000-0000-4000-8000-000000000001','9b000000-0000-4000-8000-000000000004','9b000000-0000-4000-8000-000000000005','unknown');
 raise exception 'authenticated_rpc_granted';exception when insufficient_privilege then null;end;
 begin perform 1 from public.website_interview_live_operations;raise exception 'authenticated_table_granted';exception when insufficient_privilege then null;end;
end $$;
reset role;
set role service_role;
select public.read_website_live_operation('9b000000-0000-4000-8000-000000000001','9b000000-0000-4000-8000-000000000004','9b000000-0000-4000-8000-000000000005','unknown') is null;
reset role;
select 'live_actual_roles_passed';

do $$declare c uuid:='9b000000-0000-4000-8000-000000000004';r uuid:='9b000000-0000-4000-8000-000000000005';
 o uuid:='9b000000-0000-4000-8000-000000000001';proof jsonb;snapshot jsonb;caught boolean:=false;begin
 select agenda into snapshot from website_interviews where interview_id=c;
 begin perform public.record_website_live_termination(o,c,r,'wrong-session','stop','ended','{"creationState":"created","voiceSeconds":10,"totalObservedCostUsd":0.03,"usageResolved":false}',null);
 exception when others then caught:=sqlerrm='live_termination_identity_invalid';end;
 if not caught then raise exception 'termination_wrong_session_allowed';end if;
 proof:=public.record_website_live_termination(o,c,r,'live-fixture','owner_requested_stop','ended','{"creationState":"created","voiceSeconds":10,"totalObservedCostUsd":0.03,"usageResolved":false}',null);
 if proof->>'providerFinalized'<>'false' or proof->>'usageResolved'<>'false' then raise exception 'socket_close_claimed_final';end if;
 if (select ended_at is null or provider_termination_state<>'unknown' or provider_usage_state<>'unknown' from calls where id=c) then raise exception 'incomplete_stop_missing';end if;
 -- A genuine closed event confirms termination even without final billing.
 proof:=public.record_website_live_termination(o,c,r,'live-fixture','owner_requested_stop','ended','{"creationState":"created","voiceSeconds":10,"totalObservedCostUsd":0.03,"usageResolved":false}',
 '{"eventId":"closed-actual-fixture","sessionId":"live-fixture","reason":"close_requested","seconds":null}');
 if proof->>'providerFinalized'<>'true' or proof->>'usageResolved'<>'false' then raise exception 'closed_missing_usage_blocked';end if;
 proof:=public.record_website_live_termination(o,c,r,'live-fixture','late_cleanup','error','{"creationState":"created","voiceSeconds":0,"totalObservedCostUsd":0,"usageResolved":false}',null);
 if proof->>'replayed'<>'true' or (select provider_termination_state<>'confirmed' or provider_usage_state<>'unknown' or cost_estimate_usd<>0.03 or status<>'ended' from calls where id=c) then raise exception 'late_cleanup_downgraded_proof';end if;
 if (select agenda from website_interviews where interview_id=c) is distinct from snapshot then raise exception 'stop_modified_business_data';end if;
 if exists(select 1 from website_interview_approvals where interview_id=c) then raise exception 'stop_approved_business_data';end if;
end $$;
select 'live_termination_usage_independence_passed';
