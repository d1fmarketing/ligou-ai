-- Operator-selected existing interview; every fixture and mutation is rolled back.
-- Supply ligou.recovery_test_interview as a session setting before this file.
begin;
set local statement_timeout='8s';
set local request.jwt.claim.role='service_role';
do $$declare i public.website_interviews; cid uuid:=gen_random_uuid(); rid uuid:=gen_random_uuid(); r jsonb; a jsonb; caught boolean; begin
 select * into i from public.website_interviews where interview_id=current_setting('ligou.recovery_test_interview')::uuid;
 if i.interview_id is null or i.state<>'unfinished' then raise exception 'fixture_interview_missing';end if;
 insert into public.calls(id,tenant_id,channel,session_type,status,model,test_memory_generation)
 values(cid,i.tenant_id,'browser','onboarding','active','gpt-realtime-2.1',i.generation);
 insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,test_memory_generation,onboarding_protocol_version,opening_mode_requested)
 values(rid,i.tenant_id,i.owner_id,'onboarding','v=0','processing',cid,i.generation,3,'application_tts_v1');
 r:=public.resolve_prepared_website_source(i.owner_id,cid,rid);
 if r->'resume'->>'interviewId' is distinct from i.interview_id::text or r->'resume'->>'priorCallId' is distinct from i.current_call_id::text then raise exception 'resolver_did_not_resume_same_interview';end if;
 caught:=false;
 begin
  insert into public.calls(tenant_id,channel,session_type,status,model,test_memory_generation)
   values(i.tenant_id,'browser','onboarding','active','gpt-realtime-2.1',i.generation);
  perform public.resolve_prepared_website_source(i.owner_id,cid,rid);
  raise exception 'competing_call_accepted';
 exception when others then if sqlerrm='interview_resume_source_not_settled' then caught:=true;else raise;end if;end;
 if not caught then raise exception 'competing_guard_not_tested';end if;
 caught:=false;
 begin perform public.attach_website_interview(i.owner_id,cid,rid,i.interview_id,gen_random_uuid());
 exception when others then if sqlerrm='interview_resume_source_changed' then caught:=true;else raise;end if;end;
 if not caught then raise exception 'wrong_lineage_accepted';end if;
 a:=public.attach_website_interview(i.owner_id,cid,rid,i.interview_id,i.current_call_id);
 if (a->'agenda')#-'{binding,callId}' is distinct from i.agenda#-'{binding,callId}' then raise exception 'agenda_progress_changed';end if;
 if a->'agenda'->'binding'->>'callId' is distinct from cid::text then raise exception 'new_call_not_bound';end if;
 if not exists(select 1 from public.website_interview_calls where call_id=cid and request_id=rid and interview_id=i.interview_id) then raise exception 'resume_lineage_missing';end if;
 perform public.attach_website_interview(i.owner_id,cid,rid,i.interview_id,i.current_call_id);
 raise notice 'resume_resolver_and_attach_passed';
end $$;
rollback;
