-- Run before the existing cases, with independent effects rolled back afterward.
-- Application operation references are injected from the actual TS helper.
begin;
do $$declare c uuid:='9b000000-0000-4000-8000-000000000004';r uuid:='9b000000-0000-4000-8000-000000000005';
 o uuid:='9b000000-0000-4000-8000-000000000001';i public.website_interviews;proof jsonb;prior jsonb;refs text[];begin
 update browser_session_requests set onboarding_protocol_version=6,opening_mode_requested='live_managed_v1',status='ready',answer_sdp='live-fixture-answer',
  opening_mode_applied='live_managed_v1',opening_payload=jsonb_build_object('version',6,'live',jsonb_build_object('sessionId','live-fixture','callId',c,'interviewId',c,'revision',0,
    'sourceDigest',(select digest from website_interviews where interview_id=c))) where id=r;
 update calls set model='gpt-live-1',openai_call_id='live-fixture',provider_termination_state='active',provider_usage_state='unknown' where id=c;
 select * into i from website_interviews where interview_id=c;prior:=i.agenda;
 perform public.record_website_live_fragments(o,c,r,'live-fixture','[
  {"eventId":"event_EMprtp89IJG3fQjJgW3Kj","speaker":"owner","text":"Não autorizo descontos. ","startMs":100,"endMs":200},
  {"eventId":"event_EMprtP9ibMmap8NZdtgPz","speaker":"owner","text":"Exceções exigem aprovação.","startMs":100,"endMs":200}]');
 proof:=public.commit_website_live_decision(o,c,r,'live-fixture','__APP_MIXED_REFERENCE__',0,i.db_version,i.digest,'answer','exception',
  array['event_EMprtp89IJG3fQjJgW3Kj','event_EMprtP9ibMmap8NZdtgPz'],'Não há desconto automático. Qualquer exceção exige aprovação explícita do dono.');
 if proof->>'operationRef'<>'__APP_MIXED_REFERENCE__' or proof->>'revision'<>'1' then raise exception 'mixed_case_application_reference_rejected';end if;
 if (select source_text from website_interview_live_operations where call_id=c and operation_ref='__APP_MIXED_REFERENCE__')<>'Não autorizo descontos. Exceções exigem aprovação.' then raise exception 'identity_sort_changed_literal_arrival_order';end if;
 if (select agenda->'items'->0 from website_interviews where interview_id=c) is distinct from prior->'items'->0 then raise exception 'identity_fix_changed_unrelated_target';end if;
 select * into i from website_interviews where interview_id=c;
 perform public.record_website_live_fragments(o,c,r,'live-fixture','[
  {"eventId":"event_😀","speaker":"owner","text":"Mantendo a correção. ","startMs":300,"endMs":400},
  {"eventId":"event_\ue000","speaker":"owner","text":"Nenhum desconto automático.","startMs":300,"endMs":400}]');
 proof:=public.commit_website_live_decision(o,c,r,'live-fixture','__APP_UNICODE_REFERENCE__',1,i.db_version,i.digest,'correction','exception',
  array['event_😀','event_'||chr(57344)],'Correção confirmada: nenhum desconto automático.');
 if proof->>'operationRef'<>'__APP_UNICODE_REFERENCE__' or proof->>'revision'<>'2' then raise exception 'unicode_application_reference_rejected';end if;
 select source_event_ids into refs from website_interview_live_operations where call_id=c and operation_ref='__APP_UNICODE_REFERENCE__';
 if refs is distinct from array['event_'||chr(57344),'event_😀'] then raise exception 'unicode_utf8_order_mismatch';end if;
 if exists(select 1 from website_interview_approvals where call_id=c) then raise exception 'identity_fix_created_approval';end if;
end $$;
rollback;
select 'live_actual_mixed_case_and_unicode_identity_passed';
