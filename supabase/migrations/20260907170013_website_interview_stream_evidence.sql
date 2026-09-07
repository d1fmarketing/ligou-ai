begin;
set local lock_timeout='5s';
lock table public.website_interviews in access exclusive mode;
lock table public.website_interview_speech in access exclusive mode;

alter table public.website_interview_speech
  add column transport text not null default 'application_tts_v1' check(transport in ('application_tts_v1','realtime_stream_v1')),
  add column stream_dispatch_id uuid,
  add column stream_authorization_receipt_id uuid references public.receipts(id),
  add column stream_dispatch_started_at timestamptz,
  add column stream_response_id text,
  add column stream_item_id text,
  add column stream_transcript text,
  add column stream_generation_status text check(stream_generation_status in ('completed','rejected')),
  add column stream_generation_receipt_id uuid references public.receipts(id),
  add column stream_playout_response_id text,
  add column stream_playout_item_id text,
  add column stream_buffer_event_id text,
  add column stream_media_evidence jsonb,
  add column stream_playout_receipt_id uuid references public.receipts(id);
alter table public.website_interview_speech add constraint website_speech_transport_contract check(coalesce(
  (transport='application_tts_v1' and stream_dispatch_id is null and stream_authorization_receipt_id is null
    and stream_dispatch_started_at is null and stream_response_id is null and stream_item_id is null and stream_transcript is null
    and stream_generation_status is null and stream_generation_receipt_id is null and stream_playout_response_id is null
    and stream_playout_item_id is null and stream_buffer_event_id is null and stream_media_evidence is null and stream_playout_receipt_id is null)
  or (transport='realtime_stream_v1' and payload is null and stream_dispatch_id is not null and stream_authorization_receipt_id is not null
    and ((stream_generation_receipt_id is null and stream_response_id is null and stream_item_id is null and stream_transcript is null and stream_generation_status is null)
      or (stream_generation_receipt_id is not null and stream_dispatch_started_at is not null
        and length(btrim(stream_response_id)) between 1 and 400 and length(btrim(stream_item_id)) between 1 and 400
        and length(btrim(stream_transcript)) between 1 and 8192 and stream_generation_status in ('completed','rejected')))
    and ((stream_playout_receipt_id is null and stream_playout_response_id is null and stream_playout_item_id is null and stream_buffer_event_id is null and stream_media_evidence is null)
      or (stream_playout_receipt_id is not null and stream_dispatch_started_at is not null
        and length(btrim(stream_playout_response_id)) between 1 and 400 and length(btrim(stream_playout_item_id)) between 1 and 400
        and length(btrim(stream_buffer_event_id)) between 1 and 400 and jsonb_typeof(stream_media_evidence)='object')))
  ,false));
alter table public.website_interview_speech add constraint website_stream_progress_proof check(transport<>'realtime_stream_v1' or coalesce(
  (status<>'ready' or (stream_generation_status='completed' and stream_generation_receipt_id is not null and ready_receipt_id=stream_generation_receipt_id))
  and (status<>'played' or (stream_generation_status='completed' and stream_generation_receipt_id is not null and stream_playout_receipt_id is not null
    and played_receipt_id is not null and played_at is not null and ready_receipt_id=stream_generation_receipt_id
    and stream_response_id=stream_playout_response_id and stream_item_id=stream_playout_item_id
    and stream_generation_receipt_id<>stream_playout_receipt_id and played_receipt_id<>stream_generation_receipt_id and played_receipt_id<>stream_playout_receipt_id)),false));
create unique index website_stream_dispatch_unique on public.website_interview_speech(call_id,stream_dispatch_id) where transport='realtime_stream_v1';
create unique index website_stream_response_unique on public.website_interview_speech(call_id,stream_response_id) where stream_response_id is not null;
create unique index website_stream_item_unique on public.website_interview_speech(call_id,stream_item_id) where stream_item_id is not null;
create unique index website_stream_buffer_event_unique on public.website_interview_speech(call_id,stream_buffer_event_id) where stream_buffer_event_id is not null;

-- Match the runtime's explicit ordered lexical policy. ICU classification keeps
-- non-Latin names as words instead of silently dropping them under a C locale.
create function public.website_stream_transcript_normalize(p_text text) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare v_text text; v_tokens text; begin
  if p_text is null then return null; end if;
  v_text:=lower(regexp_replace(normalize(p_text,NFD),U&'[\0300-\036f]','','g') collate pg_catalog."und-x-icu");
  v_text:=regexp_replace(v_text,'^\s*(?:(?:claro|certo|perfeito|bem|bom|entao|olha|ok)\s*[,!:.]\s*){1,2}','');
  v_text:=regexp_replace(v_text,'^\s*(?:oi|ola)[,!:.\s]+','');
  v_text:=regexp_replace(regexp_replace(v_text,'\mpras\M','para as','g'),'\mpra\M','para','g');
  v_text:=regexp_replace(regexp_replace(v_text,'\mpros\M','para os','g'),'\mpro\M','para o','g');
  v_text:=regexp_replace(v_text,'\mta\M','esta','g');
  v_text:=regexp_replace(v_text,'^\s*(?:aqui e|sou) (?:o )?ligou\M','ligou');
  v_text:=regexp_replace(regexp_replace(v_text,'\mem quais cidades\M','quais cidades','g'),'\mquais sao as cidades\M','quais cidades','g');
  v_text:=regexp_replace(v_text,'\m(?:o|a|os|as) (?=(?:resumo|configuracao|empresa|cidades|horario|horarios)\M)','','g');
  v_text:=regexp_replace(v_text,'([0-9])\s*[–—]\s*(?=[0-9])','\1-','g');
  v_text:=regexp_replace(v_text,'([+-])\s+(?=[0-9])','\1','g');
  v_text:=regexp_replace(v_text,'([0-9])\s+([%°])','\1\2','g');
  select string_agg(m[1],' ' order by n) into v_tokens from regexp_matches(v_text collate pg_catalog."und-x-icu",
    '[+-]?[0-9]+(?:[.,:][0-9]+)*(?:[%°])?|[[:alpha:]][[:alnum:]]*|[%$€£<>≤≥=]','g') with ordinality matches(m,n);
  return coalesce(v_tokens,'');
end $$;
create function public.website_stream_transcript_matches(p_expected text,p_actual text) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(length(p_expected) between 1 and 4096 and length(p_actual) between 1 and 8192
    and btrim(p_actual)<>'' and public.website_stream_transcript_normalize(p_expected)=public.website_stream_transcript_normalize(p_actual),false);
$$;

create function public.website_stream_media_valid(p_evidence jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_key text; begin
  if jsonb_typeof(p_evidence) is distinct from 'object'
    or not (p_evidence ?& array['schema','nonzeroSamples','observedMs','firstSampleAtMs','lastSampleAtMs','unmuted','playbackStarted'])
    or p_evidence-array['schema','nonzeroSamples','observedMs','firstSampleAtMs','lastSampleAtMs','unmuted','playbackStarted']<>'{}'::jsonb
    or p_evidence->>'schema' is distinct from 'onboarding.stream.media.v1'
    or p_evidence->'unmuted' is distinct from 'true'::jsonb or p_evidence->'playbackStarted' is distinct from 'true'::jsonb then return false; end if;
  foreach v_key in array array['nonzeroSamples','observedMs','firstSampleAtMs','lastSampleAtMs'] loop
    if jsonb_typeof(p_evidence->v_key) is distinct from 'number' then return false; end if;
  end loop;
  return coalesce(p_evidence->>'nonzeroSamples' ~ '^[0-9]+$' and (p_evidence->>'nonzeroSamples')::numeric between 1 and 9007199254740991
    and (p_evidence->>'observedMs')::numeric between 0 and 180000 and (p_evidence->>'firstSampleAtMs')::numeric>=0
    and (p_evidence->>'firstSampleAtMs')::numeric<=1.7976931348623157e308
    and (p_evidence->>'lastSampleAtMs')::numeric between (p_evidence->>'firstSampleAtMs')::numeric and 1.7976931348623157e308,false);
exception when others then return false;
end $$;

create function public.website_interview_stream_actor(p_owner uuid,p_call uuid,p_request uuid,p_provider boolean default true) returns public.website_interviews
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_preparation public.website_interview_preparations; v_budget public.budget_reservations; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  if not exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=4 and opening_mode_requested='realtime_stream_v1') then
    raise exception using errcode='42501',message='interview_stream_protocol_not_current'; end if;
  select * into v_preparation from public.website_interview_preparations where id=v_i.preparation_id;
  if v_i.state='complete' or v_preparation.owner_id is distinct from p_owner or v_preparation.tenant_id is distinct from v_i.tenant_id
    or v_preparation.generation is distinct from v_i.generation
    or not public.website_interview_source_valid(v_i.tenant_id,p_owner,v_preparation.draft_id,v_preparation.draft_hash,v_preparation.result_id,v_preparation.result_hash) then
    raise exception using errcode='42501',message='interview_stream_source_not_current'; end if;
  if p_provider then
    select * into v_budget from public.budget_reservations where call_id=p_call and tenant_id=v_i.tenant_id for update;
    if v_budget.status is distinct from 'active' or not exists(select 1 from public.calls c join public.browser_session_requests br on br.id=p_request and br.call_id=c.id
      where c.id=p_call and c.status='active' and c.ended_at is null and length(btrim(coalesce(c.openai_call_id,'')))>0
        and c.provider_termination_state='active' and br.status='ready' and br.opening_mode_applied='realtime_stream_v1') then
      raise exception using errcode='42501',message='interview_stream_provider_not_active'; end if;
  end if;
  return v_i;
end $$;

create function public.website_interview_stream_descriptor(p_call uuid,p_action text) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('schema','onboarding.stream.v1','action',action,'dispatchId',stream_dispatch_id,'receiptId',stream_authorization_receipt_id)
    from public.website_interview_speech where call_id=p_call and action_id=p_action and transport='realtime_stream_v1';
$$;
create function public.website_interview_stream_proof(p_call uuid,p_action text) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object('actionId',action_id,'dispatchId',stream_dispatch_id,
    'responseId',coalesce(stream_response_id,stream_playout_response_id),'itemId',coalesce(stream_item_id,stream_playout_item_id),
    'status',case when stream_generation_status='rejected' then 'rejected' else status end,
    'generationReceiptId',stream_generation_receipt_id,'playoutReceiptId',stream_playout_receipt_id,'receiptId',played_receipt_id,
    'reason',case when stream_generation_status='rejected' then 'transcript_mismatch' else null end))
  from public.website_interview_speech where call_id=p_call and action_id=p_action and transport='realtime_stream_v1';
$$;

-- Keep the proven action/summary/approval selector. The old public MP3 entry
-- point remains callable only for its historical transport; new claims wrap
-- the same private selector and atomically add a stream authorization receipt.
alter function public.claim_website_interview_speech(uuid,uuid,uuid,jsonb,uuid,integer,text) rename to claim_website_interview_speech_transport_core;
create function public.claim_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action jsonb,p_summary uuid default null,p_part integer default null,p_clarification_turn text default null) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
  perform public.website_interview_current(p_owner,p_call,p_request);
  if exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=4)
    or exists(select 1 from public.website_interview_speech where call_id=p_call and action_id=p_action->>'actionId' and transport<>'application_tts_v1') then
    raise exception 'interview_mp3_transport_mismatch'; end if;
  return public.claim_website_interview_speech_transport_core(p_owner,p_call,p_request,p_action,p_summary,p_part,p_clarification_turn);
end $$;
create function public.claim_website_interview_stream(p_owner uuid,p_call uuid,p_request uuid,p_action jsonb,p_summary uuid default null,p_part integer default null,p_clarification_turn text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_descriptor jsonb; v_dispatch uuid:=gen_random_uuid(); v_receipt uuid:=gen_random_uuid(); begin
  v_i:=public.website_interview_stream_actor(p_owner,p_call,p_request,false);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action->>'actionId' for update;
  if v_s.action_id is not null and v_s.transport<>'realtime_stream_v1' then raise exception 'interview_stream_transport_mismatch'; end if;
  perform public.claim_website_interview_speech_transport_core(p_owner,p_call,p_request,p_action,p_summary,p_part,p_clarification_turn);
  if v_s.action_id is not null then return public.website_interview_stream_descriptor(p_call,v_s.action_id); end if;
  v_descriptor:=jsonb_build_object('schema','onboarding.stream.v1','action',p_action,'dispatchId',v_dispatch,'receiptId',v_receipt);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-stream-authorized:'||p_call::text||':'||(p_action->>'actionId'),
      v_i.digest,v_descriptor,jsonb_build_object('requestId',p_request,'generation',v_i.generation,'transport','realtime_stream_v1','providerGenerationStarted',false));
  update public.website_interview_speech set transport='realtime_stream_v1',stream_dispatch_id=v_dispatch,stream_authorization_receipt_id=v_receipt
    where call_id=p_call and action_id=p_action->>'actionId';
  return v_descriptor;
end $$;

create function public.authorize_website_interview_stream(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_dispatch uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; begin
  v_i:=public.website_interview_stream_actor(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.transport is distinct from 'realtime_stream_v1' or v_s.stream_dispatch_id is distinct from p_dispatch or p_dispatch is null
    or v_s.digest<>v_i.digest or v_s.action->'revision' is distinct from v_i.agenda->'revision' or v_s.status<>'preparing'
    or v_s.stream_generation_receipt_id is not null or v_s.stream_playout_receipt_id is not null then raise exception 'interview_stream_not_current'; end if;
  if v_s.stream_dispatch_started_at is not null then raise exception 'interview_stream_dispatch_already_started'; end if;
  update public.website_interview_speech set stream_dispatch_started_at=clock_timestamp() where call_id=p_call and action_id=p_action;
  return public.website_interview_stream_descriptor(p_call,p_action);
end $$;

create function public.read_website_interview_stream(p_call uuid,p_action text,p_dispatch uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_s public.website_interview_speech; begin
  select s.* into v_s from public.website_interview_speech s join public.website_interviews i on i.interview_id=s.interview_id
    join public.tenants t on t.id=i.tenant_id join public.calls c on c.id=s.call_id
    join public.website_interview_calls wc on wc.call_id=c.id join public.browser_session_requests br on br.id=wc.request_id
    join public.website_interview_preparations p on p.id=i.preparation_id
    where s.call_id=p_call and s.action_id=p_action and s.transport='realtime_stream_v1' and s.stream_dispatch_id=p_dispatch
      and i.current_call_id=p_call and i.digest=s.digest and i.state<>'complete' and t.owner_user_id=auth.uid() and i.owner_id=auth.uid()
      and br.user_id=auth.uid() and c.status='active' and c.ended_at is null and t.status='onboarding' and t.operational_mode='simulation_only'
      and c.test_memory_generation=t.test_memory_generation and br.test_memory_generation=t.test_memory_generation and i.generation=t.test_memory_generation
      and br.onboarding_protocol_version=4 and br.opening_mode_requested='realtime_stream_v1' and br.status='ready'
      and public.website_interview_source_valid(i.tenant_id,auth.uid(),p.draft_id,p.draft_hash,p.result_id,p.result_hash);
  if v_s.action_id is null then raise exception using errcode='42501',message='interview_stream_not_owner_bound'; end if;
  if v_s.status not in ('preparing','ready') then return null; end if;
  return public.website_interview_stream_descriptor(p_call,p_action);
end $$;

-- Provider completion and client playout are independent facts. Neither may
-- promote an interrupted/old rendition or authorize a different response.
create function public.website_interview_stream_finish(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_dispatch uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_receipt uuid:=gen_random_uuid(); v_proof jsonb; begin
  v_i:=public.website_interview_stream_actor(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.transport is distinct from 'realtime_stream_v1' or v_s.stream_dispatch_id is distinct from p_dispatch or p_dispatch is null
    or v_s.digest<>v_i.digest or v_s.action->'revision' is distinct from v_i.agenda->'revision' or v_s.stream_dispatch_started_at is null
    or v_s.status='superseded' then raise exception 'interview_stream_not_current'; end if;
  if v_s.status='played' or v_s.stream_generation_status='rejected' then return public.website_interview_stream_proof(p_call,p_action); end if;
  if v_s.status not in ('preparing','ready') then raise exception 'interview_stream_not_current'; end if;
  if v_s.stream_generation_status='completed' and v_s.stream_generation_receipt_id is not null and v_s.stream_playout_receipt_id is not null
    and v_s.stream_response_id=v_s.stream_playout_response_id and v_s.stream_item_id=v_s.stream_playout_item_id then
    v_proof:=jsonb_build_object('actionId',p_action,'dispatchId',p_dispatch,'responseId',v_s.stream_response_id,'itemId',v_s.stream_item_id,
      'status','played','generationReceiptId',v_s.stream_generation_receipt_id,'playoutReceiptId',v_s.stream_playout_receipt_id,'receiptId',v_receipt);
    insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
      values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-stream-played:'||p_call::text||':'||p_dispatch::text,
        v_i.digest,v_proof,jsonb_build_object('transport','realtime_stream_v1','authorizationReceiptId',v_s.stream_authorization_receipt_id,
          'generationReceiptId',v_s.stream_generation_receipt_id,'playoutReceiptId',v_s.stream_playout_receipt_id));
    update public.website_interview_speech set status='played',played_receipt_id=v_receipt,played_at=clock_timestamp()
      where call_id=p_call and action_id=p_action;
    return v_proof;
  end if;
  return public.website_interview_stream_proof(p_call,p_action);
end $$;

create function public.record_website_interview_stream_response(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_dispatch uuid,p_response text,p_item text,p_transcript text,p_status text default 'completed') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_receipt uuid:=gen_random_uuid(); v_matches boolean; v_readback jsonb; begin
  v_i:=public.website_interview_stream_actor(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.transport is distinct from 'realtime_stream_v1' or v_s.stream_dispatch_id is distinct from p_dispatch or p_dispatch is null
    or v_s.digest<>v_i.digest or v_s.action->'revision' is distinct from v_i.agenda->'revision' or v_s.stream_dispatch_started_at is null
    or v_s.status='superseded' then raise exception 'interview_stream_not_current'; end if;
  if p_status is distinct from 'completed' or p_response is null or length(btrim(p_response)) not between 1 and 400
    or p_item is null or length(btrim(p_item)) not between 1 and 400 or p_transcript is null or length(btrim(p_transcript)) not between 1 and 8192 then
    raise exception 'interview_stream_generation_invalid'; end if;
  if v_s.stream_generation_receipt_id is not null then
    if v_s.stream_response_id<>p_response or v_s.stream_item_id<>p_item or v_s.stream_transcript<>p_transcript then raise exception 'interview_stream_generation_conflict'; end if;
    return public.website_interview_stream_finish(p_owner,p_call,p_request,p_action,p_dispatch);
  end if;
  if v_s.status<>'preparing' then raise exception 'interview_stream_not_current'; end if;
  v_matches:=public.website_stream_transcript_matches(v_s.action->>'text',p_transcript);
  v_readback:=jsonb_build_object('actionId',p_action,'dispatchId',p_dispatch,'responseId',p_response,'itemId',p_item,
    'transcript',p_transcript,'providerStatus','completed','validationPolicy','ordered_lexical_v1',
    'status',case when v_matches then 'completed' else 'rejected' end,'generationReceiptId',v_receipt);
  if not v_matches then v_readback:=v_readback||jsonb_build_object('reason','transcript_mismatch'); end if;
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview',case when v_matches then 'accepted' else 'failed' end,
      'website-stream-generation:'||p_call::text||':'||p_dispatch::text,
      encode(extensions.digest(p_transcript,'sha256'),'hex'),v_readback,
      jsonb_build_object('transport','realtime_stream_v1','authorizationReceiptId',v_s.stream_authorization_receipt_id,'requestId',p_request));
  update public.website_interview_speech set stream_response_id=p_response,stream_item_id=p_item,stream_transcript=p_transcript,
    stream_generation_status=case when v_matches then 'completed' else 'rejected' end,stream_generation_receipt_id=v_receipt,
    status=case when v_matches then 'ready' else 'failed' end,
    ready_receipt_id=case when v_matches then v_receipt else null end,failure_receipt_id=case when v_matches then null else v_receipt end
    where call_id=p_call and action_id=p_action;
  return public.website_interview_stream_finish(p_owner,p_call,p_request,p_action,p_dispatch);
end $$;

create function public.record_website_interview_stream_playout(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_dispatch uuid,p_response text,p_item text,p_buffer_event text,p_media_evidence jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_receipt uuid:=gen_random_uuid(); v_readback jsonb; begin
  v_i:=public.website_interview_stream_actor(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.transport is distinct from 'realtime_stream_v1' or v_s.stream_dispatch_id is distinct from p_dispatch or p_dispatch is null
    or v_s.digest<>v_i.digest or v_s.action->'revision' is distinct from v_i.agenda->'revision' or v_s.stream_dispatch_started_at is null
    or v_s.status not in ('preparing','ready','played') then raise exception 'interview_stream_not_current'; end if;
  if p_response is null or length(btrim(p_response)) not between 1 and 400 or p_item is null or length(btrim(p_item)) not between 1 and 400
    or p_buffer_event is null or length(btrim(p_buffer_event)) not between 1 and 400 or not public.website_stream_media_valid(p_media_evidence) then
    raise exception 'interview_stream_playout_invalid'; end if;
  if v_s.stream_response_id is not null and (v_s.stream_response_id<>p_response or v_s.stream_item_id<>p_item) then raise exception 'interview_stream_playout_response_mismatch'; end if;
  if v_s.stream_playout_receipt_id is not null then
    if v_s.stream_playout_response_id<>p_response or v_s.stream_playout_item_id<>p_item or v_s.stream_buffer_event_id<>p_buffer_event
      or v_s.stream_media_evidence<>p_media_evidence then raise exception 'interview_stream_playout_conflict'; end if;
    return public.website_interview_stream_finish(p_owner,p_call,p_request,p_action,p_dispatch);
  end if;
  v_readback:=jsonb_build_object('actionId',p_action,'dispatchId',p_dispatch,'responseId',p_response,'itemId',p_item,
    'bufferStoppedEventId',p_buffer_event,'mediaEvidence',p_media_evidence,'playoutReceiptId',v_receipt);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-stream-playout:'||p_call::text||':'||p_dispatch::text,
      v_i.digest,v_readback,jsonb_build_object('transport','realtime_stream_v1','authorizationReceiptId',v_s.stream_authorization_receipt_id,'requestId',p_request,
        'evidenceSource','owned_browser','providerCompletionProven',false));
  update public.website_interview_speech set stream_playout_response_id=p_response,stream_playout_item_id=p_item,
    stream_buffer_event_id=p_buffer_event,stream_media_evidence=p_media_evidence,stream_playout_receipt_id=v_receipt
    where call_id=p_call and action_id=p_action;
  return public.website_interview_stream_finish(p_owner,p_call,p_request,p_action,p_dispatch);
end $$;

create function public.resume_website_interview_stream(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_item text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_interrupt public.website_interview_speech_interruptions;
  v_existing public.website_interview_speech; v_action jsonb; v_id text; v_root text; v_number integer; v_kind text;
  v_dispatch uuid:=gen_random_uuid(); v_receipt uuid:=gen_random_uuid(); v_descriptor jsonb; begin
  v_i:=public.website_interview_stream_actor(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.transport is distinct from 'realtime_stream_v1' or v_s.digest<>v_i.digest or v_s.action->'revision' is distinct from v_i.agenda->'revision' then
    raise exception 'interview_stream_resume_not_current'; end if;
  if p_item is null then
    if v_s.status<>'failed' or v_s.stream_generation_status is distinct from 'rejected'
      or not exists(select 1 from public.receipts r where r.id=v_s.stream_generation_receipt_id and r.call_id=p_call and r.tenant_id=v_i.tenant_id
        and r.kind='website_interview' and r.outcome='failed' and r.readback->>'reason'='transcript_mismatch'
        and r.readback->>'dispatchId'=v_s.stream_dispatch_id::text and r.readback->>'actionId'=p_action) then
      raise exception 'interview_stream_retry_requires_rejection'; end if;
  else
    select * into v_interrupt from public.website_interview_speech_interruptions where call_id=p_call and action_id=p_action and request_id=p_request and provider_item_id=p_item;
    if v_s.status<>'superseded' or v_interrupt.receipt_id is null then raise exception 'interview_interruption_not_current'; end if;
    if not exists(select 1 from public.website_interview_owner_turns t where t.call_id=p_call and t.provider_item_id=p_item and t.created_at>=v_interrupt.created_at)
      and not exists(select 1 from public.receipts r where r.tenant_id=v_i.tenant_id and r.call_id=p_call and r.kind='website_interview' and r.outcome='accepted'
        and r.external_id='website-empty-input:'||p_call::text||':'||p_action||':'||p_item and r.payload_hash=v_i.digest
        and r.readback->>'actionId'=p_action and r.readback->>'providerItemId'=p_item and r.readback->>'interruptionReceiptId'=v_interrupt.receipt_id::text) then
      raise exception 'interview_interruption_owner_turn_pending'; end if;
  end if;
  v_number:=v_s.rendition_number+1;
  if v_number>2 then raise exception 'interview_speech_resume_exhausted'; end if;
  v_root:=coalesce(v_s.rendition_root_action_id,v_s.action_id);
  v_id:=encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(p_action,'stream-resume',p_item,v_number)),'sha256'),'hex');
  v_action:=jsonb_set(v_s.action,'{actionId}',to_jsonb(v_id));v_kind:=v_action->>'kind';
  if v_s.speech_slot='opening' or v_s.speech_slot like 'opening:resume:%' then
    if v_i.next_action->>'itemId' is null then raise exception 'interview_stream_opening_question_missing'; end if;
    v_action:=jsonb_set(v_action,'{text}',v_i.next_action->'spokenPt');
  end if;
  if v_kind='SPEAK_FINAL_SIGNOFF' and exists(select 1 from public.website_interview_amendment_requests where interview_id=v_i.interview_id) then raise exception 'interview_amendment_pending'; end if;
  if exists(select 1 from public.website_interview_approvals where interview_id=v_i.interview_id)
    and v_kind not in ('SPEAK_FINAL_SIGNOFF','SPEAK_TERMINAL_ERROR','SPEAK_AMENDMENT_SIGNOFF') then raise exception 'interview_speech_after_approval'; end if;
  select * into v_existing from public.website_interview_speech where call_id=p_call and action_id=v_id;
  if v_existing.action_id is not null then
    if v_existing.transport<>'realtime_stream_v1' or v_existing.action<>v_action then raise exception 'interview_speech_resume_conflict'; end if;
    return public.website_interview_stream_descriptor(p_call,v_id);
  end if;
  if exists(select 1 from public.website_interview_speech where call_id=p_call and digest=v_i.digest and status in ('preparing','ready')) then raise exception 'interview_speech_resume_competing'; end if;
  v_descriptor:=jsonb_build_object('schema','onboarding.stream.v1','action',v_action,'dispatchId',v_dispatch,'receiptId',v_receipt);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-stream-authorized:'||p_call::text||':'||v_id,v_i.digest,v_descriptor,
      jsonb_build_object('requestId',p_request,'generation',v_i.generation,'transport','realtime_stream_v1','resumedFromActionId',p_action,
        'interruptionReceiptId',v_interrupt.receipt_id,'rejectedGenerationReceiptId',case when p_item is null then v_s.stream_generation_receipt_id else null end,'rendition',v_number));
  insert into public.website_interview_speech(call_id,action_id,tenant_id,interview_id,digest,action,speech_slot,summary_id,part_index,clarification_turn_id,
    status,rendition_root_action_id,rendition_number,transport,stream_dispatch_id,stream_authorization_receipt_id)
    values(p_call,v_id,v_i.tenant_id,v_i.interview_id,v_i.digest,v_action,v_s.speech_slot||':resume:'||v_number::text,
      v_s.summary_id,v_s.part_index,v_s.clarification_turn_id,'preparing',v_root,v_number,'realtime_stream_v1',v_dispatch,v_receipt);
  return v_descriptor;
end $$;

alter function public.complete_website_interview_speech(uuid,uuid,uuid,text,jsonb) rename to complete_website_interview_speech_mp3_core;
create function public.complete_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
  perform public.website_interview_current(p_owner,p_call,p_request);
  if not exists(select 1 from public.website_interview_speech where call_id=p_call and action_id=p_action and transport='application_tts_v1') then
    raise exception 'interview_mp3_transport_mismatch'; end if;
  return public.complete_website_interview_speech_mp3_core(p_owner,p_call,p_request,p_action,p_payload);
end $$;
alter function public.record_website_interview_speech_played(uuid,uuid,uuid,text,text,text,text,text) rename to record_website_interview_speech_played_mp3_core;
create function public.record_website_interview_speech_played(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_assistant_item text,p_assistant_text text,p_text_hash text,p_audio_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
  perform public.website_interview_current(p_owner,p_call,p_request);
  if not exists(select 1 from public.website_interview_speech where call_id=p_call and action_id=p_action and transport='application_tts_v1') then
    raise exception 'interview_mp3_transport_mismatch'; end if;
  return public.record_website_interview_speech_played_mp3_core(p_owner,p_call,p_request,p_action,p_assistant_item,p_assistant_text,p_text_hash,p_audio_hash);
end $$;
alter function public.resume_website_interview_speech(uuid,uuid,uuid,text,text) rename to resume_website_interview_speech_mp3_core;
create function public.resume_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_item text) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
  perform public.website_interview_current(p_owner,p_call,p_request);
  if not exists(select 1 from public.website_interview_speech where call_id=p_call and action_id=p_action and transport='application_tts_v1') then
    raise exception 'interview_mp3_transport_mismatch'; end if;
  return public.resume_website_interview_speech_mp3_core(p_owner,p_call,p_request,p_action,p_item);
end $$;

do $stream_existing_guards$
declare v_sql text; v_before text; v_after text; begin
  select pg_get_functiondef('public.interrupt_website_interview_speech(uuid,uuid,uuid,text,text)'::regprocedure) into v_sql;
  v_before:='''assistantItemId'',''lgs-''||left(p_action,28),''readyReceiptId'',v_s.ready_receipt_id)';
  v_after:='''assistantItemId'',case when v_s.transport=''realtime_stream_v1'' then coalesce(v_s.stream_item_id,v_s.stream_playout_item_id) else ''lgs-''||left(p_action,28) end,''readyReceiptId'',v_s.ready_receipt_id)'||
    '||case when v_s.transport=''realtime_stream_v1'' then jsonb_build_object(''dispatchId'',v_s.stream_dispatch_id,''transport'',''realtime_stream_v1'') else ''{}''::jsonb end';
  if position(v_before in v_sql)=0 then raise exception 'stream_interruption_prior_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
  select pg_get_functiondef('public.website_interview_prior_settled_noninitial(uuid,uuid,uuid,bigint)'::regprocedure) into v_sql;
  v_before:='and not exists(select 1 from public.website_interview_approvals a where a.interview_id=i.interview_id)';
  v_after:=v_before||E'\n      and not exists(select 1 from public.website_interview_speech stream where stream.interview_id=i.interview_id and stream.transport=''realtime_stream_v1'' and (stream.stream_dispatch_started_at is not null or stream.stream_generation_receipt_id is not null or stream.stream_playout_receipt_id is not null))';
  if position(v_before in v_sql)=0 then raise exception 'stream_no_provider_progress_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
end $stream_existing_guards$;

-- A resumed interview may already contain valid answers (or be ready for its
-- recap). A definitive zero-cost rejection of its NEW call must not strand
-- that unchanged snapshot. Its own append-only initialize/attach/amendment
-- receipt is the anchor; no current-call owner or audio progress is accepted.
alter function public.website_interview_prior_settled_noninitial(uuid,uuid,uuid,bigint) rename to website_interview_prior_settled_before_stream_resume;
create function public.website_interview_prior_settled_noninitial(p_tenant uuid,p_owner uuid,p_call uuid,p_generation bigint) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_call public.calls;v_budget public.budget_reservations;begin
  if public.website_interview_prior_settled_before_stream_resume(p_tenant,p_owner,p_call,p_generation)
    and not exists(select 1 from public.browser_session_requests br join public.calls c on c.id=br.call_id
      where c.id=p_call and c.provider_termination_state='not_required' and br.onboarding_protocol_version=4 and br.opening_mode_requested='realtime_stream_v1') then return true;end if;
  select * into v_call from public.calls where id=p_call and tenant_id=p_tenant for update;
  select * into v_budget from public.budget_reservations where call_id=p_call and tenant_id=p_tenant for update;
  if not coalesce(v_call.channel='browser' and v_call.session_type='onboarding' and v_call.test_memory_generation=p_generation
    and v_call.status='error' and v_call.ended_at is not null and v_call.duration_seconds=0
    and v_call.provider_termination_state='not_required' and v_call.provider_termination_reason='realtime_unavailable'
    and v_call.openai_call_id is null and v_call.provider_termination_mode is null and v_call.provider_termination_attempt_id is null
    and v_call.provider_termination_attempted_at is null and v_call.provider_terminated_at is null and v_call.transcript='[]'::jsonb
    and v_call.provider_usage_state in ('not_applicable','resolved') and v_call.cost_estimate_usd=0
    and v_budget.status='settled' and v_budget.outcome='startup_error' and v_budget.final_cost_usd=0
    and v_budget.final_minutes=0 and v_budget.settled_at is not null,false) then return false;end if;
  return exists(select 1 from public.website_interviews i
    join public.tenants t on t.id=i.tenant_id and t.owner_user_id=i.owner_id and t.test_memory_generation=i.generation
    join public.website_interview_preparations p on p.id=i.preparation_id and p.tenant_id=i.tenant_id and p.owner_id=i.owner_id and p.generation=i.generation
      and p.consumed_call_id=i.interview_id and p.consumed_at is not null
    join public.website_interview_calls wc on wc.call_id=p_call and wc.interview_id=i.interview_id and wc.tenant_id=i.tenant_id
    join public.browser_session_requests br on br.id=wc.request_id and br.call_id=p_call and br.tenant_id=i.tenant_id
    join public.receipts anchor on anchor.id=i.receipt_id and anchor.tenant_id=i.tenant_id and anchor.call_id=p_call
      and anchor.kind='website_interview' and anchor.outcome='accepted'
      and anchor.external_id in ('website-interview:'||p_call::text||':initialize','website-interview:'||p_call::text||':attach','website-interview:'||p_call::text||':amendment')
      and anchor.readback->'agenda'=i.agenda and anchor.readback->'nextAction'=i.next_action and anchor.payload_hash=i.digest
    where i.current_call_id=p_call and i.tenant_id=p_tenant and i.owner_id=p_owner and i.generation=p_generation
      and t.status='onboarding' and t.operational_mode='simulation_only' and i.state in ('unfinished','reviewing')
      and br.user_id=p_owner and br.test_memory_generation=p_generation and br.session_type='onboarding'
      and br.onboarding_protocol_version=4 and br.opening_mode_requested='realtime_stream_v1'
      and br.status='error' and br.error='realtime_unavailable' and br.answer_sdp is null and br.opening_payload is null and br.opening_mode_applied is null
      and public.website_interview_source_valid(p_tenant,p_owner,p.draft_id,p.draft_hash,p.result_id,p.result_hash)
      and i.agenda->'binding'=jsonb_build_object('interviewId',i.interview_id,'callId',p_call,'draftId',p.draft_id,'draftHash',p.draft_hash,'sourceResultId',p.result_id,'sourceResultHash',p.result_hash)
      and i.digest=encode(extensions.digest(public.onboarding_canonical_json_v1(i.agenda),'sha256'),'hex')
      and i.db_version=coalesce((anchor.detail->>'dbVersion')::bigint,0)
      and not exists(select 1 from public.website_interview_owner_turns where call_id=p_call)
      and not exists(select 1 from public.website_interview_fact_batches where call_id=p_call)
      and not exists(select 1 from public.website_interview_approvals where interview_id=i.interview_id)
      and not exists(select 1 from public.website_interview_amendment_requests where interview_id=i.interview_id)
      and not exists(select 1 from public.website_interview_speech s where s.call_id=p_call and
        (s.transport<>'realtime_stream_v1' or s.stream_dispatch_started_at is not null or s.stream_generation_receipt_id is not null
          or s.stream_playout_receipt_id is not null or s.status='played' or s.played_at is not null or s.played_receipt_id is not null))
      and not exists(select 1 from public.website_interviews newer where newer.tenant_id=p_tenant and newer.created_at>i.created_at)
      and not exists(select 1 from public.website_interview_preparations pending where pending.tenant_id=p_tenant and pending.consumed_call_id is null)
      and (select count(*) from public.calls active where active.tenant_id=p_tenant and active.status='active')<=1
      and not exists(select 1 from public.calls later where later.tenant_id=p_tenant and later.id<>p_call
        and (later.started_at>=v_call.started_at or later.status='active') and not coalesce(
          later.status='active' and later.started_at>=v_call.started_at and later.ended_at is null and later.channel='browser'
          and later.session_type='onboarding' and later.test_memory_generation=p_generation and later.openai_call_id is null
          and later.provider_termination_state='not_required' and later.provider_termination_attempt_id is null and later.provider_termination_attempted_at is null
          and later.transcript='[]'::jsonb and not exists(select 1 from public.website_interview_calls bound where bound.call_id=later.id)
          and exists(select 1 from public.browser_session_requests next_request where next_request.call_id=later.id and next_request.tenant_id=p_tenant
            and next_request.user_id=p_owner and next_request.session_type='onboarding' and next_request.test_memory_generation=p_generation
            and next_request.onboarding_protocol_version=4 and next_request.opening_mode_requested='realtime_stream_v1' and next_request.status='processing'
            and next_request.answer_sdp is null and next_request.opening_mode_applied is null and next_request.opening_payload is null),false))
      and not exists(select 1 from public.browser_session_requests pending where pending.tenant_id=p_tenant and pending.call_id is null
        and pending.status in ('pending','processing','ready','cancel_requested')));
end $$;

-- Tables remain FORCE RLS/read-only to clients. Only named service RPCs can
-- write stream evidence; normalization/current/readback/core helpers are private.
do $stream_acl$
declare f record; begin
  for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'website_stream_transcript_normalize','website_stream_transcript_matches','website_stream_media_valid',
      'website_interview_stream_actor','website_interview_stream_descriptor','website_interview_stream_proof','website_interview_stream_finish',
      'website_interview_prior_settled_before_stream_resume','website_interview_prior_settled_noninitial',
      'claim_website_interview_speech_transport_core','complete_website_interview_speech_mp3_core','record_website_interview_speech_played_mp3_core','resume_website_interview_speech_mp3_core',
      'claim_website_interview_speech','complete_website_interview_speech','record_website_interview_speech_played','resume_website_interview_speech',
      'claim_website_interview_stream','authorize_website_interview_stream','read_website_interview_stream',
      'record_website_interview_stream_response','record_website_interview_stream_playout','resume_website_interview_stream') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    if f.proname='read_website_interview_stream' then execute format('grant execute on function %s to authenticated',f.signature);
    elsif f.proname in ('claim_website_interview_speech','complete_website_interview_speech','record_website_interview_speech_played','resume_website_interview_speech',
      'claim_website_interview_stream','authorize_website_interview_stream','record_website_interview_stream_response','record_website_interview_stream_playout','resume_website_interview_stream') then
      execute format('grant execute on function %s to service_role',f.signature);
    end if;
  end loop;
end $stream_acl$;
commit;
