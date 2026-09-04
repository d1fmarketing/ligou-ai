begin;

-- A pure CHECK helper: no data access, privilege escalation, or provider calls.
create function public.website_browser_opening_v3_valid(p_payload jsonb, p_call uuid)
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
    or s->>'mime' <> 'audio/mpeg' or s->>'voice' <> 'ash' or s->>'tts_model' <> 'tts-1-hd'
    or jsonb_typeof(s->'cost_usd') <> 'number'
    or (s->>'cost_usd')::numeric <> round(length(s->>'text')::numeric * 30 / 1000000,8)
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
revoke all on function public.website_browser_opening_v3_valid(jsonb,uuid) from public, anon;
grant execute on function public.website_browser_opening_v3_valid(jsonb,uuid) to authenticated, service_role;

-- Keep the exact previous v1/v2 expression, including all resume constraints.
do $extend_browser_opening$
declare previous_expression text;
begin
  select pg_get_expr(c.conbin,c.conrelid) into strict previous_expression
    from pg_constraint c where c.conrelid='public.browser_session_requests'::regclass
      and c.conname='browser_session_requests_opening_state_check';
  if position('website_browser_opening_v3_valid' in previous_expression)>0 then
    raise exception 'website_browser_protocol3_already_extended';
  end if;
  alter table public.browser_session_requests drop constraint browser_session_requests_opening_state_check;
  execute 'alter table public.browser_session_requests add constraint browser_session_requests_opening_state_check check (' ||
    '(onboarding_protocol_version is distinct from 3 and (' || previous_expression || ')) or ' ||
    '(onboarding_protocol_version = 3 and session_type = ''onboarding'' and opening_mode_requested = ''application_tts_v1'' and coalesce((' ||
      '(status in (''pending'',''processing'',''error'',''expired'') and opening_mode_applied is null and opening_payload is null and (status <> ''pending'' or call_id is null) and (status <> ''processing'' or answer_sdp is null)) or ' ||
      '(status = ''cancel_requested'' and call_id is not null and answer_sdp is null and opening_mode_applied is null and opening_payload is null) or ' ||
      '(status in (''ready'',''cancel_requested'') and call_id is not null and coalesce(answer_sdp,'''') <> '''' and opening_mode_applied = ''application_tts_v1'' and public.website_browser_opening_v3_valid(opening_payload,call_id))' ||
    '),false))) not valid';
end;
$extend_browser_opening$;
alter table public.browser_session_requests validate constraint browser_session_requests_opening_state_check;

alter table public.browser_session_requests drop constraint browser_session_requests_onboarding_protocol_check;
alter table public.browser_session_requests add constraint browser_session_requests_onboarding_protocol_check check (
  (onboarding_protocol_version is null or onboarding_protocol_version in (2,3))
  and (onboarding_protocol_version is null or (session_type='onboarding' and opening_mode_requested='application_tts_v1'))
  and (onboarding_protocol_version is distinct from 2 or status not in ('ready','cancel_requested') or coalesce(opening_payload->'version'='2'::jsonb,false))
  and (onboarding_protocol_version is distinct from 3 or status <> 'ready' or coalesce(opening_payload->'version'='3'::jsonb,false))
) not valid;
alter table public.browser_session_requests validate constraint browser_session_requests_onboarding_protocol_check;
-- Existing protocol identity trigger remains unchanged: protocol is immutable.
commit;
