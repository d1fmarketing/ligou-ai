begin;
set local lock_timeout='5s';

-- Fixed provider voice rates only. Current synthesis uses tts-1; historical
-- tts-1-hd receipts keep their original model, bytes, cost and identity.
-- Preserve existing scope, claim ownership, audio hashes and function ACLs.
create or replace function public.complete_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_audio bytea; v_receipt uuid:=gen_random_uuid(); begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.action_id is null or v_s.digest<>v_i.digest or v_i.state='complete' then raise exception 'interview_speech_not_current'; end if;
  if p_payload is null or octet_length(p_payload::text)>2200000 or jsonb_typeof(p_payload)<>'object' then raise exception 'interview_speech_payload_invalid'; end if;
  if (p_payload-array['schema','text_sha256','audio_base64','audio_sha256','mime','voice','tts_model','cost_usd']) is distinct from v_s.action
    or p_payload->>'schema' is distinct from 'onboarding.speech.v1' or p_payload->>'mime' is distinct from 'audio/mpeg'
    or p_payload->>'voice' is distinct from 'ash' or coalesce(p_payload->>'tts_model','') not in ('tts-1','tts-1-hd')
    or p_payload->>'text_sha256' is distinct from encode(extensions.digest(v_s.action->>'text','sha256'),'hex')
    or jsonb_typeof(p_payload->'cost_usd') is distinct from 'number' or length(coalesce(p_payload->>'audio_base64','')) not between 4 and 2000000 then raise exception 'interview_speech_payload_invalid'; end if;
  if (p_payload->>'cost_usd')::numeric<>round(length(v_s.action->>'text')*(case p_payload->>'tts_model' when 'tts-1' then 15 else 30 end)::numeric/1000000,8) then raise exception 'interview_speech_cost_invalid'; end if;
  v_audio:=decode(p_payload->>'audio_base64','base64');
  if octet_length(v_audio) not between 4 and 1500000 or replace(encode(v_audio,'base64'),E'\n','') is distinct from p_payload->>'audio_base64'
    or encode(extensions.digest(v_audio,'sha256'),'hex') is distinct from p_payload->>'audio_sha256'
    or not (substring(v_audio from 1 for 3)=decode('494433','hex') or (get_byte(v_audio,0)=255 and (get_byte(v_audio,1)&224)=224 and (get_byte(v_audio,1)&6)<>0 and (get_byte(v_audio,2)&240)<>240 and (get_byte(v_audio,2)&12)<>12)) then raise exception 'interview_speech_audio_invalid'; end if;
  if v_s.status in ('ready','played') then
    if v_s.payload is distinct from p_payload then raise exception 'interview_speech_payload_conflict'; end if;
    return public.website_interview_speech_readback(p_call,p_action);
  end if;
  if v_s.status<>'preparing' then raise exception 'interview_speech_claim_not_preparing'; end if;
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-speech-ready:'||p_call::text||':'||p_action,p_payload->>'audio_sha256',jsonb_build_object('action',v_s.action,'textSha256',p_payload->>'text_sha256','audioSha256',p_payload->>'audio_sha256'),jsonb_build_object('state','ready'));
  update public.website_interview_speech set status='ready',payload=p_payload,ready_receipt_id=v_receipt where call_id=p_call and action_id=p_action;
  return public.website_interview_speech_readback(p_call,p_action);
end $$;

create or replace function public.website_browser_opening_v3_valid(p_payload jsonb, p_call uuid)
returns boolean language plpgsql stable security invoker set search_path = ''
as $$
declare s jsonb; a bytea; t text;
begin
  if p_call is null or jsonb_typeof(p_payload) is distinct from 'object'
    or p_call::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or not (p_payload ?& array['version','item_id','speech'])
    or p_payload - array['version','item_id','speech'] <> '{}'::jsonb
    or jsonb_typeof(p_payload->'item_id') is distinct from 'string'
    or p_payload->'version' <> '3'::jsonb then return false; end if;
  s := p_payload->'speech';
  if jsonb_typeof(s) is distinct from 'object'
    or not (s ?& array['schema','actionId','interviewId','callId','revision','kind','text','sourceDigest','text_sha256','audio_base64','audio_sha256','mime','voice','tts_model','cost_usd'])
    or s - array['schema','actionId','interviewId','callId','revision','kind','text','sourceDigest','text_sha256','audio_base64','audio_sha256','mime','voice','tts_model','cost_usd'] <> '{}'::jsonb
    or s->>'schema' <> 'onboarding.speech.v1'
    or s->>'kind' <> 'ASK_NEXT_GAP'
    or s->>'callId' <> p_call::text
    or s->>'interviewId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or s->>'actionId' !~ '^[0-9a-f]{64}$'
    or s->>'sourceDigest' !~ '^[0-9a-f]{64}$'
    or s->>'text_sha256' !~ '^[0-9a-f]{64}$'
    or s->>'audio_sha256' !~ '^[0-9a-f]{64}$'
    or p_payload->>'item_id' <> 'lgs-' || left(s->>'actionId',28)
    or jsonb_typeof(s->'revision') <> 'number'
    or (s->>'revision') !~ '^[0-9]+$'
    or (s->>'revision')::numeric > 9007199254740991
    or jsonb_typeof(s->'text') <> 'string'
    or length(s->>'text') not between 1 and 4096
    or btrim(s->>'text') = ''
    or translate(s->>'text', E'\n\r\t', '') ~ '[[:cntrl:]]'
    or s->>'mime' <> 'audio/mpeg' or s->>'voice' <> 'ash' or coalesce(s->>'tts_model','') not in ('tts-1','tts-1-hd')
    or jsonb_typeof(s->'cost_usd') <> 'number'
    or (s->>'cost_usd')::numeric <> round(length(s->>'text')::numeric * (case s->>'tts_model' when 'tts-1' then 15 else 30 end) / 1000000,8)
    or jsonb_typeof(s->'audio_base64') <> 'string'
    or length(s->>'audio_base64') not between 4 and 2000000
    or length(s->>'audio_base64') % 4 <> 0 then return false; end if;
  -- Explicit type checks prevent JSON null or scalar coercion passing SQL NULL.
  if exists(select 1 from jsonb_each(s) e where e.key not in ('revision','cost_usd') and jsonb_typeof(e.value) <> 'string') then return false; end if;
  t := lower(translate(s->>'text','áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ','aaaaeeiooouucAAAAEEIOOOUUC'));
  if t ~ '(posso (te )?ajudar|tem mais alguma coisa|o que mais voce gostaria|e so me chamar)' then return false; end if;
  a := decode(s->>'audio_base64','base64');
  if length(a) not between 4 and 1500000
    or replace(encode(a,'base64'), E'\n','') <> s->>'audio_base64' then return false; end if;
  if not ((get_byte(a,0)=73 and get_byte(a,1)=68 and get_byte(a,2)=51)
    or (get_byte(a,0)=255 and (get_byte(a,1)&224)=224 and (get_byte(a,1)&6)<>0 and (get_byte(a,2)&240)<>240 and (get_byte(a,2)&12)<>12)) then return false; end if;
  return encode(extensions.digest(convert_to(s->>'text','UTF8'),'sha256'),'hex') = s->>'text_sha256'
    and encode(extensions.digest(a,'sha256'),'hex') = s->>'audio_sha256';
exception when others then return false;
end;
$$;

-- Extend only the V2 model predicate within the exact prior opening contract.
-- Keep every mode/status/protocol/resume/shape predicate and add exact paired
-- model pricing for V2; retain historical V1 checks verbatim. V3 uses the helper above.
do $tts_opening_rates$
declare
  previous_expression text;
  revised_expression text;
  old_model text := $model$(opening_payload ->> 'tts_model'::text) = 'tts-1-hd'::text$model$;
  new_model text := $model$(opening_payload ->> 'tts_model'::text) IN ('tts-1'::text,'tts-1-hd'::text)$model$;
begin
  select pg_get_expr(c.conbin,c.conrelid) into strict previous_expression
    from pg_constraint c where c.conrelid='public.browser_session_requests'::regclass
      and c.conname='browser_session_requests_opening_state_check';
  if position(old_model in previous_expression)=0 then raise exception 'onboarding_tts_prior_model_contract_missing'; end if;
  revised_expression:=replace(previous_expression,old_model,new_model);
  alter table public.browser_session_requests drop constraint browser_session_requests_opening_state_check;
  execute 'alter table public.browser_session_requests add constraint browser_session_requests_opening_state_check check (('||revised_expression||') and '
    || $cost$(opening_payload is null or coalesce(opening_payload->>'version' <> '2',false) or coalesce(
       jsonb_typeof(opening_payload->'cost_usd')='number'
       and opening_payload->>'tts_model' in ('tts-1','tts-1-hd')
       and (opening_payload->>'cost_usd')::numeric=round(length(opening_payload->>'text')::numeric
         * (case opening_payload->>'tts_model' when 'tts-1' then 15 when 'tts-1-hd' then 30 end)/1000000,8),false))) not valid$cost$;
end;
$tts_opening_rates$;
alter table public.browser_session_requests validate constraint browser_session_requests_opening_state_check;
commit;
