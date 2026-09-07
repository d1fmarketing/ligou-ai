begin;
set local lock_timeout='5s';

-- Status readers acquire the parent before speech. Take the final-strength
-- locks in that order before DDL can hold speech and later upgrade the parent.
lock table public.website_interviews in access exclusive mode;
lock table public.website_interview_speech in access exclusive mode;

-- An interrupted rendition remains auditable and can never prove playback.
alter table public.website_interview_speech
  add column rendition_root_action_id text,
  add column rendition_number integer not null default 0 check (rendition_number between 0 and 2);
alter table public.website_interview_speech add constraint website_speech_rendition_root
  foreign key(call_id,rendition_root_action_id) references public.website_interview_speech(call_id,action_id);
create table public.website_interview_speech_interruptions (
  call_id uuid not null,
  action_id text not null,
  request_id uuid not null references public.browser_session_requests(id),
  tenant_id uuid not null references public.tenants(id),
  interview_id uuid not null references public.website_interviews(interview_id),
  provider_item_id text not null check(length(btrim(provider_item_id)) between 1 and 400),
  receipt_id uuid not null unique references public.receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(call_id,action_id), unique(call_id,provider_item_id),
  foreign key(call_id,action_id) references public.website_interview_speech(call_id,action_id)
);
alter table public.website_interview_speech_interruptions enable row level security;
alter table public.website_interview_speech_interruptions force row level security;
revoke all on public.website_interview_speech_interruptions from public,anon,authenticated,service_role;
grant select on public.website_interview_speech_interruptions to service_role;
create index website_speech_interruptions_tenant on public.website_interview_speech_interruptions(tenant_id);
create trigger website_speech_interruptions_append_only before update or delete on public.website_interview_speech_interruptions
  for each row execute function public.block_mutation();

create function public.interrupt_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_item text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_prior public.website_interview_speech_interruptions;
  v_receipt uuid:=gen_random_uuid(); v_readback jsonb; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  if p_item is null or length(btrim(p_item)) not between 1 and 400 then raise exception 'interview_interruption_item_invalid'; end if;
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.action_id is null or v_s.digest<>v_i.digest or v_i.state='complete' then raise exception 'interview_speech_not_current'; end if;
  select * into v_prior from public.website_interview_speech_interruptions where call_id=p_call and action_id=p_action;
  if v_prior.receipt_id is not null then
    if v_prior.request_id<>p_request or v_prior.provider_item_id<>p_item then raise exception 'interview_interruption_conflict'; end if;
    select readback into v_readback from public.receipts where id=v_prior.receipt_id;
    return v_readback||jsonb_build_object('replayed',true);
  end if;
  if v_s.status not in ('preparing','ready') then raise exception 'interview_speech_not_interruptible'; end if;
  v_readback:=jsonb_build_object('callId',p_call,'actionId',p_action,'providerItemId',p_item,'status','superseded','receiptId',v_receipt,'replayed',false);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-speech-interrupted:'||p_call::text||':'||p_action,
      v_i.digest,v_readback,jsonb_build_object('requestId',p_request,'ownerItemId',p_item,'assistantItemId','lgs-'||left(p_action,28),'readyReceiptId',v_s.ready_receipt_id));
  insert into public.website_interview_speech_interruptions(call_id,action_id,request_id,tenant_id,interview_id,provider_item_id,receipt_id)
    values(p_call,p_action,p_request,v_i.tenant_id,v_i.interview_id,p_item,v_receipt);
  update public.website_interview_speech set status='superseded' where call_id=p_call and action_id=p_action;
  return v_readback;
end $$;

-- Successful empty ASR can end an interrupted input without manufacturing
-- owner words. This receipt authorizes only resuming that unchanged rendition.
create function public.record_website_interview_empty_input(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_item text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_interrupt public.website_interview_speech_interruptions;
  v_receipt uuid:=gen_random_uuid(); v_key text; v_readback jsonb; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  select * into v_interrupt from public.website_interview_speech_interruptions
    where call_id=p_call and action_id=p_action and request_id=p_request and provider_item_id=p_item;
  if v_s.action_id is null or v_s.status<>'superseded' or v_s.digest<>v_i.digest or v_i.state='complete'
    or v_interrupt.receipt_id is null then raise exception 'interview_empty_input_not_current'; end if;
  if exists(select 1 from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item) then raise exception 'interview_empty_input_conflicts_with_owner_turn'; end if;
  v_key:='website-empty-input:'||p_call::text||':'||p_action||':'||p_item;
  select readback into v_readback from public.receipts where tenant_id=v_i.tenant_id and call_id=p_call and kind='website_interview' and external_id=v_key;
  if v_readback is not null then return v_readback||jsonb_build_object('replayed',true); end if;
  v_readback:=jsonb_build_object('receiptId',v_receipt,'callId',p_call,'actionId',p_action,'providerItemId',p_item,'interruptionReceiptId',v_interrupt.receipt_id,'replayed',false);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted',v_key,v_i.digest,v_readback,
      jsonb_build_object('requestId',p_request,'reason','empty_final_transcript','ownerWordsRecorded',false));
  return v_readback;
end $$;
revoke all on function public.record_website_interview_empty_input(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.record_website_interview_empty_input(uuid,uuid,uuid,text,text) to service_role;

create function public.resume_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_item text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_interrupt public.website_interview_speech_interruptions;
  v_existing public.website_interview_speech; v_action jsonb; v_payload jsonb; v_id text; v_root text;
  v_number integer; v_receipt uuid:=gen_random_uuid(); v_extra jsonb; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  select * into v_interrupt from public.website_interview_speech_interruptions
    where call_id=p_call and action_id=p_action and request_id=p_request and provider_item_id=p_item;
  if v_s.action_id is null or v_s.status<>'superseded' or v_s.digest<>v_i.digest or v_i.state='complete'
    or v_interrupt.receipt_id is null then raise exception 'interview_interruption_not_current'; end if;
  if not exists(select 1 from public.website_interview_owner_turns t where t.call_id=p_call and t.provider_item_id=p_item and t.created_at>=v_interrupt.created_at)
    and not exists(select 1 from public.receipts r where r.tenant_id=v_i.tenant_id and r.call_id=p_call and r.kind='website_interview' and r.outcome='accepted'
      and r.external_id='website-empty-input:'||p_call::text||':'||p_action||':'||p_item and r.payload_hash=v_i.digest
      and r.readback->>'actionId'=p_action and r.readback->>'providerItemId'=p_item and r.readback->>'interruptionReceiptId'=v_interrupt.receipt_id::text)
    then raise exception 'interview_interruption_owner_turn_pending'; end if;
  if v_s.action->>'kind'='SPEAK_FINAL_SIGNOFF' and exists(select 1 from public.website_interview_amendment_requests where interview_id=v_i.interview_id) then raise exception 'interview_amendment_pending'; end if;
  v_number:=v_s.rendition_number+1;
  if v_number>2 then raise exception 'interview_speech_resume_exhausted'; end if;
  v_root:=coalesce(v_s.rendition_root_action_id,v_s.action_id);
  v_id:=encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(p_action,'resume',p_item,v_number)),'sha256'),'hex');
  v_action:=jsonb_set(v_s.action,'{actionId}',to_jsonb(v_id));
  v_extra:=jsonb_build_object('resumedFromActionId',p_action,'providerItemId',p_item,'rendition',v_number,'interruptionReceiptId',v_interrupt.receipt_id);
  select * into v_existing from public.website_interview_speech where call_id=p_call and action_id=v_id;
  if v_existing.action_id is not null then
    if v_existing.action<>v_action then raise exception 'interview_speech_resume_conflict'; end if;
    return public.website_interview_speech_readback(p_call,v_id,false)||v_extra;
  end if;
  if exists(select 1 from public.website_interview_speech where call_id=p_call and digest=v_i.digest and status in ('preparing','ready')) then raise exception 'interview_speech_resume_competing'; end if;
  if exists(select 1 from public.website_interview_approvals where interview_id=v_i.interview_id)
    and v_s.action->>'kind' not in ('SPEAK_FINAL_SIGNOFF','SPEAK_TERMINAL_ERROR','SPEAK_AMENDMENT_SIGNOFF') then raise exception 'interview_speech_after_approval'; end if;
  if v_s.payload is not null then
    v_payload:=jsonb_set(v_s.payload,'{actionId}',to_jsonb(v_id));
    insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
      values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-speech-ready:'||p_call::text||':'||v_id,
        v_payload->>'audio_sha256',jsonb_build_object('action',v_action,'textSha256',v_payload->>'text_sha256','audioSha256',v_payload->>'audio_sha256'),
        jsonb_build_object('state','ready','reusedAudioReceiptId',v_s.ready_receipt_id,'interruptionReceiptId',v_interrupt.receipt_id,'newTtsCharge',false));
  end if;
  insert into public.website_interview_speech(call_id,action_id,tenant_id,interview_id,digest,action,speech_slot,summary_id,part_index,clarification_turn_id,status,payload,ready_receipt_id,rendition_root_action_id,rendition_number)
    values(p_call,v_id,v_i.tenant_id,v_i.interview_id,v_i.digest,v_action,v_s.speech_slot||':resume:'||v_number::text,
      v_s.summary_id,v_s.part_index,v_s.clarification_turn_id,case when v_payload is null then 'preparing' else 'ready' end,
      v_payload,case when v_payload is null then null else v_receipt end,v_root,v_number);
  return public.website_interview_speech_readback(p_call,v_id,v_payload is null)||v_extra;
end $$;

revoke all on function public.interrupt_website_interview_speech(uuid,uuid,uuid,text,text),public.resume_website_interview_speech(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.interrupt_website_interview_speech(uuid,uuid,uuid,text,text),public.resume_website_interview_speech(uuid,uuid,uuid,text,text) to service_role;

-- Approved snapshots stay immutable. A correction request names existing targets;
-- its next explicit Start opens a new lineage and only those targets are reopened.
create table public.website_interview_amendment_requests (
  interview_id uuid primary key references public.website_interviews(interview_id),
  tenant_id uuid not null references public.tenants(id),
  call_id uuid not null,
  request_id uuid not null references public.browser_session_requests(id),
  approval_receipt_id uuid not null unique references public.website_interview_approvals(receipt_id),
  provider_item_id text not null,
  proposal jsonb not null,
  receipt_id uuid not null unique references public.receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(call_id,provider_item_id) references public.website_interview_owner_turns(call_id,provider_item_id)
);
alter table public.website_interview_amendment_requests enable row level security;
alter table public.website_interview_amendment_requests force row level security;
revoke all on public.website_interview_amendment_requests from public,anon,authenticated,service_role;
grant select on public.website_interview_amendment_requests to service_role;
create index website_amendment_requests_tenant on public.website_interview_amendment_requests(tenant_id);
create trigger website_amendment_requests_append_only before update or delete on public.website_interview_amendment_requests
  for each row execute function public.block_mutation();
alter table public.website_interviews add column parent_interview_id uuid references public.website_interviews(interview_id),
  add column amendment_request_receipt_id uuid unique references public.receipts(id);

create function public.request_website_interview_amendment(p_owner uuid,p_call uuid,p_request uuid,p_approval uuid,p_item text,p_proposal jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_a public.website_interview_approvals; v_prior public.website_interview_amendment_requests;
  v_text text; v_entry jsonb; v_receipt uuid:=gen_random_uuid(); v_readback jsonb; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  select * into v_a from public.website_interview_approvals where interview_id=v_i.interview_id and receipt_id=p_approval;
  if v_a.receipt_id is null then raise exception 'interview_amendment_approval_missing'; end if;
  select owner_text into v_text from public.website_interview_owner_turns
    where call_id=p_call and provider_item_id=p_item and created_at>v_a.created_at;
  if v_text is null then raise exception 'interview_amendment_owner_turn_missing'; end if;
  if p_proposal is null or jsonb_typeof(p_proposal)<>'object' or octet_length(p_proposal::text)>65536
    or p_proposal->>'kind' is distinct from 'correction' or (p_proposal-array['kind','affectedItems','affectedCandidates'])<>'{}'::jsonb
    or jsonb_typeof(coalesce(p_proposal->'affectedItems','[]'))<>'array' or jsonb_typeof(coalesce(p_proposal->'affectedCandidates','[]'))<>'array'
    then raise exception 'interview_amendment_proposal_invalid'; end if;
  if jsonb_array_length(coalesce(p_proposal->'affectedItems','[]'))+jsonb_array_length(coalesce(p_proposal->'affectedCandidates','[]')) not between 1 and 1024 then raise exception 'interview_amendment_targets_invalid'; end if;
  for v_entry in select value from jsonb_array_elements(coalesce(p_proposal->'affectedItems','[]')) loop
    if jsonb_typeof(v_entry)<>'object' or (v_entry-array['itemId','disposition'])<>'{}'::jsonb or v_entry->>'disposition' is distinct from 'reopen'
      or not exists(select 1 from jsonb_array_elements(v_i.agenda->'items') x where x->>'id'=v_entry->>'itemId') then raise exception 'interview_amendment_target_not_current'; end if;
  end loop;
  for v_entry in select value from jsonb_array_elements(coalesce(p_proposal->'affectedCandidates','[]')) loop
    if jsonb_typeof(v_entry)<>'object' or (v_entry-array['candidateId','disposition'])<>'{}'::jsonb or v_entry->>'disposition' is distinct from 'reopen'
      or not exists(select 1 from jsonb_array_elements(v_i.agenda->'candidateContext') x where x->>'id'=v_entry->>'candidateId') then raise exception 'interview_amendment_target_not_current'; end if;
  end loop;
  if (select count(distinct x->>'itemId') from jsonb_array_elements(coalesce(p_proposal->'affectedItems','[]')) x)<>jsonb_array_length(coalesce(p_proposal->'affectedItems','[]'))
    or (select count(distinct x->>'candidateId') from jsonb_array_elements(coalesce(p_proposal->'affectedCandidates','[]')) x)<>jsonb_array_length(coalesce(p_proposal->'affectedCandidates','[]')) then raise exception 'interview_amendment_duplicate_target'; end if;
  select * into v_prior from public.website_interview_amendment_requests where interview_id=v_i.interview_id;
  if v_prior.receipt_id is not null then
    if v_prior.call_id<>p_call or v_prior.request_id<>p_request or v_prior.provider_item_id<>p_item or v_prior.approval_receipt_id<>p_approval or v_prior.proposal<>p_proposal then raise exception 'interview_amendment_conflict'; end if;
    select readback into v_readback from public.receipts where id=v_prior.receipt_id;
    return v_readback||jsonb_build_object('replayed',true);
  end if;
  v_readback:=jsonb_build_object('receiptId',v_receipt,'interviewId',v_i.interview_id,'callId',p_call,'approvalReceiptId',p_approval,'providerItemId',p_item,'proposal',p_proposal,'state','pending_amendment','replayed',false);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-amendment:'||v_i.interview_id::text,v_i.digest,v_readback,
      jsonb_build_object('ownerText',v_text,'ownerTurnId',p_call::text||':'||p_item,'approvedSnapshotChanged',false,'operatingAuthorityChanged',false));
  insert into public.website_interview_amendment_requests(interview_id,tenant_id,call_id,request_id,approval_receipt_id,provider_item_id,proposal,receipt_id)
    values(v_i.interview_id,v_i.tenant_id,p_call,p_request,p_approval,p_item,p_proposal,v_receipt);
  update public.website_interview_speech set status='superseded' where call_id=p_call and status in ('preparing','ready');
  return v_readback;
end $$;

alter function public.resolve_prepared_website_source(uuid,uuid,uuid) rename to resolve_prepared_website_source_before_amendment;
create function public.resolve_prepared_website_source(p_owner uuid,p_call uuid,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_tenant uuid; v_i public.website_interviews;
  v_p public.website_interview_preparations; v_d public.company_discovery_onboarding_drafts; begin
  v_result:=public.resolve_prepared_website_source_before_amendment(p_owner,p_call,p_request);
  if v_result->>'prepared'='true' then return v_result; end if;
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);
  select i.* into v_i from public.website_interviews i join public.website_interview_amendment_requests m on m.interview_id=i.interview_id
    where i.tenant_id=v_tenant and i.owner_id=p_owner and i.current_call_id<>p_call
      and not exists(select 1 from public.website_interviews newer where newer.tenant_id=v_tenant and newer.created_at>i.created_at)
    order by i.created_at desc limit 1 for update of i;
  if v_i.interview_id is null then return v_result; end if;
  if not public.website_interview_prior_settled(v_tenant,p_owner,v_i.current_call_id,v_i.generation)
    or exists(select 1 from public.calls where tenant_id=v_tenant and status='active' and id<>p_call) then raise exception 'interview_resume_source_not_settled'; end if;
  select * into v_p from public.website_interview_preparations where id=v_i.preparation_id;
  if v_p.generation is distinct from (select test_memory_generation from public.tenants where id=v_tenant)
    or not public.website_interview_source_valid(v_tenant,p_owner,v_p.draft_id,v_p.draft_hash,v_p.result_id,v_p.result_hash) then raise exception using errcode='40001',message='interview_selected_draft_changed'; end if;
  select * into v_d from public.company_discovery_onboarding_drafts where id=v_p.draft_id;
  return jsonb_build_object('prepared',true,'preparationId',v_p.id,'draftId',v_p.draft_id,'draftHash',v_p.draft_hash,'sourceResultId',v_p.result_id,'sourceResultHash',v_p.result_hash,
    'draft_readback',jsonb_build_object('draft_id',v_d.id,'draft_version',v_d.version,'draft_hash',v_d.draft_hash,'draft',v_d.draft),
    'resume',jsonb_build_object('interviewId',v_i.interview_id,'priorCallId',v_i.current_call_id));
end $$;

alter function public.attach_website_interview(uuid,uuid,uuid,uuid,uuid) rename to attach_website_interview_before_amendment;
create function public.attach_website_interview(p_owner uuid,p_call uuid,p_request uuid,p_interview uuid,p_prior_call uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_tenant uuid; v_i public.website_interviews; v_child public.website_interviews; v_m public.website_interview_amendment_requests;
  v_p public.website_interview_preparations; v_agenda jsonb; v_items jsonb:='[]'::jsonb; v_overrides jsonb:='[]'::jsonb; v_entry jsonb; v_override jsonb;
  v_turn jsonb; v_text text; v_digest text; v_action jsonb; v_preparation uuid:=gen_random_uuid(); v_receipt uuid:=gen_random_uuid(); begin
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);
  select * into v_m from public.website_interview_amendment_requests where interview_id=p_interview and tenant_id=v_tenant;
  if v_m.receipt_id is null then return public.attach_website_interview_before_amendment(p_owner,p_call,p_request,p_interview,p_prior_call); end if;
  select * into v_i from public.website_interviews where interview_id=p_interview and tenant_id=v_tenant and owner_id=p_owner for update;
  select * into v_child from public.website_interviews where amendment_request_receipt_id=v_m.receipt_id;
  if v_child.interview_id is not null then
    if v_child.current_call_id<>p_call or not exists(select 1 from public.website_interview_calls where call_id=p_call and request_id=p_request) then raise exception 'interview_amendment_consumed'; end if;
    return public.website_interview_readback(v_child.interview_id,true);
  end if;
  if v_i.current_call_id is distinct from p_prior_call or v_i.generation is distinct from (select test_memory_generation from public.tenants where id=v_tenant)
    or not exists(select 1 from public.website_interview_approvals where interview_id=p_interview and receipt_id=v_m.approval_receipt_id)
    or not public.website_interview_prior_settled(v_tenant,p_owner,p_prior_call,v_i.generation) then raise exception 'interview_amendment_source_changed'; end if;
  if exists(select 1 from public.calls where tenant_id=v_tenant and status='active' and id<>p_call)
    or exists(select 1 from public.website_interview_preparations where tenant_id=v_tenant and consumed_call_id is null)
    or exists(select 1 from public.website_interviews where tenant_id=v_tenant and created_at>v_i.created_at) then raise exception 'interview_resume_competing_lineage'; end if;
  select * into v_p from public.website_interview_preparations where id=v_i.preparation_id;
  if not public.website_interview_source_valid(v_tenant,p_owner,v_p.draft_id,v_p.draft_hash,v_p.result_id,v_p.result_hash) then raise exception 'interview_selected_draft_changed'; end if;
  select owner_text into v_text from public.website_interview_owner_turns where call_id=v_m.call_id and provider_item_id=v_m.provider_item_id;
  if v_text is null then raise exception 'interview_amendment_owner_turn_missing'; end if;
  v_turn:=jsonb_build_object('turnId',v_m.call_id::text||':'||v_m.provider_item_id,'text',v_text);
  for v_entry in select value from jsonb_array_elements(v_i.agenda->'items') loop
    if exists(select 1 from jsonb_array_elements(coalesce(v_m.proposal->'affectedItems','[]')) target where target->>'itemId'=v_entry->>'id') then
      v_entry:=v_entry||jsonb_build_object('status','open','answerRevision',(v_entry->>'answerRevision')::bigint+1,'evidence',v_entry->'evidence'||jsonb_build_array(v_turn));
    end if;
    v_items:=v_items||jsonb_build_array(v_entry);
  end loop;
  for v_entry in select value from jsonb_array_elements(v_i.agenda->'candidateContext') loop
    select value into v_override from jsonb_array_elements(v_i.agenda->'candidateOverrides') x where x->>'id'=v_entry->>'id';
    if exists(select 1 from jsonb_array_elements(coalesce(v_m.proposal->'affectedCandidates','[]')) target where target->>'candidateId'=v_entry->>'id') then
      if v_override is null then v_override:=v_entry||jsonb_build_object('source','contradiction','relatedItemIds','[]'::jsonb,'blocking',true,'answerRevision',0,'clarificationCount',0,'lastQuestionPt',v_entry->>'questionPt','evidence','[]'::jsonb); end if;
      v_override:=v_override||jsonb_build_object('status','open','answerRevision',(v_override->>'answerRevision')::bigint+1,'evidence',v_override->'evidence'||jsonb_build_array(v_turn));
    end if;
    if v_override is not null then v_overrides:=v_overrides||jsonb_build_array(v_override); end if;
  end loop;
  v_agenda:=v_i.agenda||jsonb_build_object('binding',(v_i.agenda->'binding')||jsonb_build_object('interviewId',p_call,'callId',p_call),
    'revision',(v_i.agenda->>'revision')::bigint+1,'ownerTurns',v_i.agenda->'ownerTurns'||jsonb_build_array(v_turn),'items',v_items,'candidateOverrides',v_overrides);
  perform public.website_interview_validate_agenda(v_agenda);
  v_digest:=encode(extensions.digest(public.onboarding_canonical_json_v1(v_agenda),'sha256'),'hex');
  v_action:=public.website_interview_action(v_agenda,'initial');
  insert into public.website_interview_preparations(id,tenant_id,owner_id,generation,prior_call_id,draft_id,draft_hash,result_id,result_hash,consumed_call_id,consumed_at)
    values(v_preparation,v_tenant,p_owner,v_i.generation,p_prior_call,v_p.draft_id,v_p.draft_hash,v_p.result_id,v_p.result_hash,p_call,clock_timestamp());
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_tenant,p_call,'website_interview','accepted','website-interview:'||p_call::text||':amendment',v_digest,
      jsonb_build_object('agenda',v_agenda,'nextAction',v_action),jsonb_build_object('parentInterviewId',p_interview,'approvalReceiptId',v_m.approval_receipt_id,'amendmentRequestReceiptId',v_m.receipt_id));
  insert into public.website_interviews(interview_id,preparation_id,tenant_id,owner_id,generation,current_call_id,agenda,next_action,digest,state,receipt_id,parent_interview_id,amendment_request_receipt_id)
    values(p_call,v_preparation,v_tenant,p_owner,v_i.generation,p_call,v_agenda,v_action,v_digest,'unfinished',v_receipt,p_interview,v_m.receipt_id);
  insert into public.website_interview_calls(call_id,request_id,interview_id,tenant_id) values(p_call,p_request,p_call,v_tenant);
  return public.website_interview_readback(p_call);
end $$;

create function public.website_interview_amendment_approval_provenance() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_parent public.website_interview_approvals; v_i public.website_interviews; begin
  select * into v_i from public.website_interviews where interview_id=new.interview_id;
  if v_i.parent_interview_id is not null then
    select * into v_parent from public.website_interview_approvals where interview_id=v_i.parent_interview_id;
    if v_parent.receipt_id is null or not exists(select 1 from public.website_interview_amendment_requests m where m.receipt_id=v_i.amendment_request_receipt_id and m.approval_receipt_id=v_parent.receipt_id) then raise exception 'interview_amendment_approval_lineage_invalid'; end if;
    new.finalized_draft:=new.finalized_draft||jsonb_build_object('amendsApprovalReceiptId',v_parent.receipt_id,
      'factBatchReceiptIds',coalesce(v_parent.finalized_draft->'factBatchReceiptIds','[]')||coalesce(new.finalized_draft->'factBatchReceiptIds','[]'));
  end if;
  return new;
end $$;
create trigger website_amendment_approval_provenance before insert on public.website_interview_approvals
  for each row execute function public.website_interview_amendment_approval_provenance();

-- The same unconsumed first preparation survives attempts that provably never
-- reached voice or owner progress. Every failed call remains in the audit trail.
alter table public.website_interview_preparations alter column prior_call_id drop not null;
alter function public.website_interview_prior_settled(uuid,uuid,uuid,bigint) rename to website_interview_prior_settled_noninitial;
create function public.website_interview_prior_settled(p_tenant uuid,p_owner uuid,p_call uuid,p_generation bigint) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_p public.website_interview_preparations; begin
  if p_call is not null then return public.website_interview_prior_settled_noninitial(p_tenant,p_owner,p_call,p_generation); end if;
  if not exists(select 1 from public.tenants where id=p_tenant and owner_user_id=p_owner and test_memory_generation=p_generation and status='onboarding' and operational_mode='simulation_only')
    or exists(select 1 from public.website_interviews where tenant_id=p_tenant) then return false; end if;
  if not exists(select 1 from public.calls where tenant_id=p_tenant) then return true; end if;
  select * into v_p from public.website_interview_preparations where tenant_id=p_tenant and owner_id=p_owner and generation=p_generation and prior_call_id is null and consumed_call_id is null;
  if v_p.id is null or not public.website_interview_source_valid(p_tenant,p_owner,v_p.draft_id,v_p.draft_hash,v_p.result_id,v_p.result_hash)
    or (select count(*) from public.calls where tenant_id=p_tenant and status='active')>1 then return false; end if;
  return not exists(select 1 from public.calls c where c.tenant_id=p_tenant and (
    c.channel is distinct from 'browser' or c.session_type is distinct from 'onboarding'
    or c.test_memory_generation is distinct from p_generation or c.started_at<v_p.created_at
    or coalesce(c.transcript,'[]'::jsonb)<>'[]'::jsonb
    or not exists(select 1 from public.browser_session_requests br where br.call_id=c.id and br.tenant_id=p_tenant
      and br.user_id=p_owner and br.session_type='onboarding' and br.onboarding_protocol_version=3
      and br.opening_mode_requested='application_tts_v1' and br.test_memory_generation=p_generation)
    or exists(select 1 from public.browser_session_requests br where br.call_id=c.id and (
      br.tenant_id is distinct from p_tenant or br.user_id is distinct from p_owner or br.test_memory_generation is distinct from p_generation
      or br.answer_sdp is not null or br.opening_payload is not null))
    or exists(select 1 from public.website_interview_calls wc where wc.call_id=c.id)
    or exists(select 1 from public.website_interview_owner_turns t where t.call_id=c.id)
    or exists(select 1 from public.receipts r where r.call_id=c.id and r.kind in ('website_interview','onboarding_coverage','onboarding_voice_approval'))
    or not coalesce(
      (c.status='active' and c.ended_at is null and exists(select 1 from public.browser_session_requests br where br.call_id=c.id and br.status in ('processing','ready')))
      or (c.status in ('ended','error','killed_budget','killed_deadline') and c.ended_at is not null
        and c.openai_call_id is null and c.provider_termination_state='not_required'
        and ((c.provider_usage_state='not_applicable' and coalesce(c.cost_estimate_usd,0)=0) or (c.provider_usage_state='resolved' and c.cost_estimate_usd=0))
        and not exists(select 1 from public.budget_reservations b where b.call_id=c.id and (b.tenant_id is distinct from p_tenant or b.status is distinct from 'settled')))
    ,false)
  ));
end $$;
create function public.prepare_initial_website_interview(p_preparation uuid,p_owner uuid,p_expected_tenant uuid,p_generation bigint,p_draft uuid,p_draft_hash text,p_result uuid,p_result_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
  perform public.website_interview_service_guard();
  perform pg_advisory_xact_lock(hashtextextended('ligou.company_discovery.onboarding_draft:'||p_expected_tenant::text,0));
  if exists(select 1 from public.calls where tenant_id=p_expected_tenant) and not (
    exists(select 1 from public.website_interview_preparations where id=p_preparation and tenant_id=p_expected_tenant and owner_id=p_owner and generation=p_generation and prior_call_id is null and consumed_call_id is null)
    and not exists(select 1 from public.calls where tenant_id=p_expected_tenant and status='active')
    and public.website_interview_prior_settled(p_expected_tenant,p_owner,null,p_generation)
  ) then raise exception 'interview_initial_history_exists'; end if;
  if exists(select 1 from public.website_interviews where tenant_id=p_expected_tenant) then raise exception 'interview_initial_history_exists'; end if;
  return public.prepare_fresh_website_interview(p_preparation,p_owner,p_expected_tenant,p_generation,null,p_draft,p_draft_hash,p_result,p_result_hash);
end $$;

-- UI eligibility is a preflight of the same source, owner, lineage and terminal
-- proof checked by resolve/attach; the mutating RPCs still recheck under lock.
create function public.website_interview_resume_eligible(p_interview uuid,p_owner uuid,p_amendment boolean default false) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_p public.website_interview_preparations; begin
  select i.* into v_i from public.website_interviews i join public.tenants t on t.id=i.tenant_id
    where i.interview_id=p_interview and i.owner_id=p_owner and t.owner_user_id=p_owner
      and i.generation=t.test_memory_generation and t.status='onboarding' and t.operational_mode='simulation_only';
  if v_i.interview_id is null then return false; end if;
  select * into v_p from public.website_interview_preparations where id=v_i.preparation_id;
  if v_p.owner_id is distinct from p_owner or v_p.tenant_id is distinct from v_i.tenant_id or v_p.generation is distinct from v_i.generation
    or not public.website_interview_source_valid(v_i.tenant_id,p_owner,v_p.draft_id,v_p.draft_hash,v_p.result_id,v_p.result_hash)
    or exists(select 1 from public.calls where tenant_id=v_i.tenant_id and status='active')
    or exists(select 1 from public.website_interview_preparations where tenant_id=v_i.tenant_id and consumed_call_id is null)
    or exists(select 1 from public.website_interviews where tenant_id=v_i.tenant_id and created_at>v_i.created_at) then return false; end if;
  if p_amendment then
    if not exists(select 1 from public.website_interview_amendment_requests m join public.website_interview_approvals a on a.receipt_id=m.approval_receipt_id and a.interview_id=v_i.interview_id
      where m.interview_id=v_i.interview_id and m.tenant_id=v_i.tenant_id and m.call_id=v_i.current_call_id
        and not exists(select 1 from public.website_interviews child where child.amendment_request_receipt_id=m.receipt_id)) then return false; end if;
  elsif v_i.state<>'unfinished' or exists(select 1 from public.website_interview_approvals where interview_id=v_i.interview_id)
    or exists(select 1 from public.website_interview_amendment_requests where interview_id=v_i.interview_id) then return false; end if;
  return public.website_interview_prior_settled(v_i.tenant_id,p_owner,v_i.current_call_id,v_i.generation);
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
    ('request_website_interview_amendment','resolve_prepared_website_source','resolve_prepared_website_source_before_amendment','attach_website_interview','attach_website_interview_before_amendment','website_interview_amendment_approval_provenance','website_interview_prior_settled','website_interview_prior_settled_noninitial','prepare_initial_website_interview','website_interview_resume_eligible') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    if f.proname in ('request_website_interview_amendment','resolve_prepared_website_source','attach_website_interview','prepare_initial_website_interview') then execute format('grant execute on function %s to service_role',f.signature); end if;
  end loop;
end $$;

-- The correction signoff is truthful only after its durable request exists.
create or replace function public.claim_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action jsonb,p_summary uuid default null,p_part integer default null,p_clarification_turn text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_summary public.website_interview_summaries;
  v_kind text:=p_action->>'kind'; v_text text:=p_action->>'text'; v_id text:=p_action->>'actionId'; v_slot text;
  v_expected text; v_opening text; v_opening_id text; v_approved boolean; v_played_at timestamptz; v_current_item jsonb; v_owner_text text; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  if p_action is null or jsonb_typeof(p_action)<>'object' or (select count(*) from jsonb_object_keys(p_action))<>7
    or coalesce(v_id ~ '^[a-f0-9]{64}$',false)=false or length(btrim(coalesce(v_text,''))) not between 1 and 4096
    or p_action->>'interviewId' is distinct from v_i.interview_id::text or p_action->>'callId' is distinct from p_call::text
    or p_action->'revision' is distinct from v_i.agenda->'revision' or p_action->>'sourceDigest' is distinct from v_i.digest then raise exception 'interview_speech_binding_invalid'; end if;
  if v_i.state='complete' then raise exception 'interview_complete'; end if;
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=v_id for update;
  if v_s.action_id is not null then
    if v_s.action is distinct from p_action or v_s.summary_id is distinct from p_summary or v_s.part_index is distinct from p_part or v_s.clarification_turn_id is distinct from p_clarification_turn then raise exception 'interview_speech_conflict'; end if;
    return public.website_interview_speech_readback(p_call,v_id,false);
  end if;
  v_approved:=exists(select 1 from public.website_interview_approvals where interview_id=v_i.interview_id);
  if v_kind<>'SPEAK_TERMINAL_ERROR' and exists(select 1 from public.website_interview_speech where call_id=p_call and action->>'kind'='SPEAK_TERMINAL_ERROR') then raise exception 'interview_terminal_speech_latched'; end if;
  if v_approved and v_kind not in ('SPEAK_FINAL_SIGNOFF','SPEAK_TERMINAL_ERROR','SPEAK_AMENDMENT_SIGNOFF') then raise exception 'interview_speech_after_approval'; end if;
  if p_summary is not null then
    select * into v_summary from public.website_interview_summaries where id=p_summary and interview_id=v_i.interview_id and call_id=p_call and digest=v_i.digest;
    if v_summary.id is null then raise exception 'interview_summary_changed'; end if;
  end if;
  select 'Oi! Aqui é o Ligou, agente de inteligência artificial da '||t.name||'. Eu já analisei seu website. '||(v_i.next_action->>'spokenPt') into v_opening from public.tenants t where t.id=v_i.tenant_id;
  v_opening_id:=encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(v_i.next_action->>'actionId','opening',v_opening)),'sha256'),'hex');
  if v_kind='ASK_NEXT_GAP' and v_text=v_opening and v_id=v_opening_id and not exists(select 1 from public.website_interview_speech where call_id=p_call) then
    v_slot:='opening'; v_expected:=v_opening;
  elsif v_kind='GENERATE_FINAL_SUMMARY' and v_summary.id is not null then
    if p_part is null or p_part<0 or p_part>=jsonb_array_length(v_summary.parts) then raise exception 'interview_summary_part_invalid'; end if;
    if p_part>0 and not exists(select 1 from public.website_interview_speech where summary_id=p_summary and part_index=p_part-1 and status='played') then raise exception 'interview_summary_previous_part_unplayed'; end if;
    v_slot:='summary:'||p_summary::text||':'||p_part::text; v_expected:=v_summary.parts->>p_part;
  elsif v_kind='REQUEST_FINAL_APPROVAL' and v_summary.id is not null then
    if exists(select 1 from generate_series(0,jsonb_array_length(v_summary.parts)-1) n where not exists(select 1 from public.website_interview_speech s where s.summary_id=p_summary and s.part_index=n and s.action->>'kind'='GENERATE_FINAL_SUMMARY' and s.status='played')) then raise exception 'interview_summary_not_fully_played'; end if;
    v_expected:='Está tudo correto no resumo e você confirma essas informações? Se precisar, diga o que devo corrigir.';
    v_slot:='approval:'||p_summary::text;
    if p_clarification_turn is not null then
      select max(played_at) into v_played_at from public.website_interview_speech where summary_id=p_summary and action->>'kind'='REQUEST_FINAL_APPROVAL' and status='played';
      if v_played_at is null or (select count(*) from public.website_interview_speech where summary_id=p_summary and action->>'kind'='REQUEST_FINAL_APPROVAL')>=2
        or not exists(select 1 from public.website_interview_owner_turns t where t.call_id=p_call and p_call::text||':'||t.provider_item_id=p_clarification_turn and t.created_at>v_played_at) then raise exception 'interview_approval_clarification_invalid'; end if;
      select owner_text into v_owner_text from public.website_interview_owner_turns t where t.call_id=p_call and p_call::text||':'||t.provider_item_id=p_clarification_turn and t.created_at>v_played_at;
      if v_owner_text is null then raise exception 'interview_approval_clarification_invalid'; end if;
      v_expected:=public.website_approval_clarification(v_owner_text)||' '||v_expected;
      v_slot:=v_slot||':'||p_clarification_turn;
    end if;
  elsif v_kind='SPEAK_AMENDMENT_SIGNOFF' then
    if not v_approved or not exists(select 1 from public.website_interview_amendment_requests where interview_id=v_i.interview_id and call_id=p_call and request_id=p_request) then raise exception 'interview_amendment_signoff_requires_request'; end if;
    v_slot:='amendment-signoff'; v_expected:='Registrei seu pedido de correção. A versão aprovada continua guardada. Para revisar a alteração, inicie uma nova conversa pelo painel. Obrigado e até logo.';
  elsif v_kind='SPEAK_FINAL_SIGNOFF' then
    if exists(select 1 from public.website_interview_amendment_requests where interview_id=v_i.interview_id) then raise exception 'interview_amendment_pending'; end if;
    if not v_approved then raise exception 'interview_signoff_requires_approval'; end if;
    v_slot:='signoff'; v_expected:='Perfeito. Seu onboarding foi concluído e suas informações foram salvas. Até logo.';
  elsif v_kind='SPEAK_TERMINAL_ERROR' then
    v_slot:='terminal-error'; v_expected:=v_text;
  elsif v_kind=v_i.next_action->>'type' and v_kind in ('ASK_NEXT_GAP','CLARIFY_CURRENT_GAP','CONFIRM_AND_ASK_NEXT','DEFER_OFF_SCOPE_AND_CONTINUE','HANDLE_OWNER_CORRECTION') then
    v_slot:='queue:'||(v_i.next_action->>'actionId'); v_expected:=v_i.next_action->>'spokenPt';
    if v_kind='CLARIFY_CURRENT_GAP' then
      select value into v_current_item from jsonb_array_elements(v_i.agenda->'items'||(v_i.agenda->'candidateOverrides')) where value->>'id'=v_i.next_action->>'itemId' and value->>'status' in ('open','awaiting_clarification');
      if v_current_item is null then raise exception 'interview_speech_action_not_current'; end if;
      v_expected:=public.website_question_guidance(v_current_item)||' '||v_expected;
    end if;
  else raise exception 'interview_speech_action_not_current'; end if;
  if v_text is distinct from v_expected then raise exception 'interview_speech_text_mismatch'; end if;
  if exists(select 1 from public.website_interview_speech where call_id=p_call and digest=v_i.digest and speech_slot=v_slot) then raise exception 'interview_speech_alias_conflict'; end if;
  insert into public.website_interview_speech(call_id,action_id,tenant_id,interview_id,digest,action,speech_slot,summary_id,part_index,clarification_turn_id,status)
    values(p_call,v_id,v_i.tenant_id,v_i.interview_id,v_i.digest,p_action,v_slot,p_summary,p_part,p_clarification_turn,'preparing');
  return public.website_interview_speech_readback(p_call,v_id,true);
end $$;

alter function public.record_website_interview_completion(uuid,uuid,uuid,text,uuid) rename to record_website_interview_completion_before_amendment;
create function public.record_website_interview_completion(p_owner uuid,p_call uuid,p_request uuid,p_outcome text,p_approval uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request,false);
  if p_outcome='complete' and exists(select 1 from public.website_interview_amendment_requests where interview_id=v_i.interview_id) then raise exception 'interview_amendment_pending'; end if;
  return public.record_website_interview_completion_before_amendment(p_owner,p_call,p_request,p_outcome,p_approval);
end $$;
revoke all on function public.record_website_interview_completion_before_amendment(uuid,uuid,uuid,text,uuid),public.record_website_interview_completion(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.record_website_interview_completion(uuid,uuid,uuid,text,uuid) to service_role;
-- Public readback separates preserved approval from the requested edit.
alter function public.get_website_interview_status(uuid) rename to get_website_interview_status_before_amendment;
create function public.get_website_interview_status(p_call uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_i public.website_interviews; v_m public.website_interview_amendment_requests; v_child public.website_interviews; v_prior_approval uuid; v_settled boolean:=false; v_amendment_eligible boolean:=false; begin
  v_result:=public.get_website_interview_status_before_amendment(p_call);
  select * into v_i from public.website_interviews where interview_id=(v_result->>'interviewId')::uuid;
  select * into v_m from public.website_interview_amendment_requests where interview_id=v_i.interview_id;
  if v_m.receipt_id is not null then select * into v_child from public.website_interviews where amendment_request_receipt_id=v_m.receipt_id; end if;
  if v_i.parent_interview_id is not null then select receipt_id into v_prior_approval from public.website_interview_approvals where interview_id=v_i.parent_interview_id; end if;
  if v_i.current_call_id=p_call then
    v_settled:=public.website_interview_resume_eligible(v_i.interview_id,v_i.owner_id,false);
    v_amendment_eligible:=public.website_interview_resume_eligible(v_i.interview_id,v_i.owner_id,true);
  end if;
  return v_result||jsonb_build_object('amendmentPending',v_m.receipt_id is not null and not exists(select 1 from public.website_interview_approvals where interview_id=v_child.interview_id),
    'amendmentRequestReceiptId',v_m.receipt_id,'amendmentInterviewId',v_child.interview_id,'parentInterviewId',v_i.parent_interview_id,'priorApprovalReceiptId',v_prior_approval,
    'resumeEligible',v_i.state='unfinished' and v_settled,'amendmentCanResume',v_m.receipt_id is not null and v_child.interview_id is null and v_amendment_eligible);
end $$;

alter function public.company_discovery_setup_status() rename to company_discovery_setup_status_before_amendment;
create function public.company_discovery_setup_status() returns jsonb
language plpgsql security definer volatile set search_path='' as $$
declare v_result jsonb; v_i public.website_interviews; v_m public.website_interview_amendment_requests; v_approval uuid; v_prior_approval uuid; v_can_resume boolean:=false; begin
  v_result:=public.company_discovery_setup_status_before_amendment();
  select i.* into v_i from public.website_interviews i join public.tenants t on t.id=i.tenant_id
    where t.owner_user_id=auth.uid() and i.generation=t.test_memory_generation order by i.created_at desc,i.interview_id desc limit 1;
  if v_i.interview_id is null then return v_result; end if;
  select receipt_id into v_approval from public.website_interview_approvals where interview_id=v_i.interview_id;
  if v_i.parent_interview_id is not null then select receipt_id into v_prior_approval from public.website_interview_approvals where interview_id=v_i.parent_interview_id; end if;
  select * into v_m from public.website_interview_amendment_requests where interview_id=v_i.interview_id;
  if v_m.receipt_id is not null and not exists(select 1 from public.website_interviews where amendment_request_receipt_id=v_m.receipt_id) then
    v_can_resume:=public.website_interview_resume_eligible(v_i.interview_id,auth.uid(),true);
    v_result:=v_result||jsonb_build_object('state','onboarding_amendment_pending','amendment_pending',true,'amendment_can_resume',v_can_resume,'amendment_request_receipt_id',v_m.receipt_id);
  else v_result:=v_result||jsonb_build_object('amendment_pending',false); end if;
  return v_result||jsonb_build_object('voice_approval_receipt_id',v_approval,'prior_voice_approval_receipt_id',v_prior_approval,'voice_interview_id',v_i.interview_id);
end $$;
revoke all on function public.get_website_interview_status_before_amendment(uuid),public.get_website_interview_status(uuid),public.company_discovery_setup_status_before_amendment(),public.company_discovery_setup_status() from public,anon,authenticated,service_role;
grant execute on function public.get_website_interview_status(uuid),public.company_discovery_setup_status() to authenticated;
alter function public.list_website_interview_terminal_candidates(integer) rename to list_website_interview_terminal_candidates_before_amendment;
create function public.list_website_interview_terminal_candidates(p_limit integer default 4) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_candidates jsonb; begin
  v_candidates:=public.list_website_interview_terminal_candidates_before_amendment(p_limit);
  return coalesce((select jsonb_agg(case when exists(select 1 from public.website_interview_amendment_requests m where m.interview_id=(c->>'interviewId')::uuid)
    then c||jsonb_build_object('canComplete',false) else c end) from jsonb_array_elements(v_candidates) c),'[]'::jsonb);
end $$;
revoke all on function public.list_website_interview_terminal_candidates_before_amendment(integer),public.list_website_interview_terminal_candidates(integer) from public,anon,authenticated,service_role;
grant execute on function public.list_website_interview_terminal_candidates(integer) to service_role;
commit;
