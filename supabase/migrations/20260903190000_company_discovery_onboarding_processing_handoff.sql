begin;

-- The browser controller binds a new onboarding call while the request is in
-- its exact pre-opening `processing` state. It cannot become `ready` until
-- startSession has returned the answer SDP and application-owned TTS payload.
-- Patch only that impossible lifecycle predicate in both existing CAS
-- functions, with one-occurrence guards so migration drift fails closed.
do $patch_company_discovery_processing_handoff$
declare
  v_definition text;
  v_old text := 'and br.status = ''ready''';
  v_new text := 'and br.status = ''processing''
   and br.opening_mode_requested = ''application_tts_v1''
   and br.onboarding_protocol_version = 2
   and br.answer_sdp is null
   and br.opening_mode_applied is null
   and br.opening_payload is null';
begin
  select pg_get_functiondef(
    'public.initialize_company_discovery_onboarding_prefill(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ) into v_definition;
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
       / length(v_old) <> 1 then
    raise exception 'company_discovery_prefill_handoff_patch_mismatch';
  end if;
  execute replace(v_definition, v_old, v_new);

  select pg_get_functiondef(
    'public.reconcile_company_discovery_onboarding_prefill(uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text)'::regprocedure
  ) into v_definition;
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
       / length(v_old) <> 1 then
    raise exception 'company_discovery_reconcile_handoff_patch_mismatch';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$patch_company_discovery_processing_handoff$;

-- A website-first next action intentionally starts with its discovery
-- disclosure instead of pretending that a previous voice interview existed.
-- Keep both opening forms exact while preserving every existing payload bound.
alter table public.browser_session_requests
  drop constraint if exists browser_session_requests_opening_state_check;
alter table public.browser_session_requests
  add constraint browser_session_requests_opening_state_check check (
    coalesce((
      (
        status in ('pending', 'processing', 'error', 'expired')
        and opening_mode_applied is null
        and opening_payload is null
        and (status <> 'pending' or call_id is null)
        and (
          status <> 'processing'
          or call_id is null
          or (
            session_type = 'onboarding'
            and opening_mode_requested = 'application_tts_v1'
            and answer_sdp is null
          )
        )
      )
      or
      (
        status = 'cancel_requested'
        and session_type = 'onboarding'
        and opening_mode_requested = 'application_tts_v1'
        and call_id is not null
        and answer_sdp is null
        and opening_mode_applied is null
        and opening_payload is null
      )
      or
      (
        status in ('ready', 'cancel_requested')
        and opening_mode_applied = opening_mode_requested
        and (
          status <> 'cancel_requested'
          or (
            session_type = 'onboarding'
            and opening_mode_requested = 'application_tts_v1'
            and opening_mode_applied = 'application_tts_v1'
            and call_id is not null
            and coalesce(answer_sdp, '') <> ''
          )
        )
        and (
          (
            opening_mode_applied = 'provider_model_v1'
            and opening_payload is null
          )
          or (
            session_type = 'onboarding'
            and opening_mode_applied = 'application_tts_v1'
            and coalesce((
              jsonb_typeof(opening_payload) = 'object'
              and opening_payload ? 'version'
              and opening_payload ? 'item_id'
              and opening_payload ? 'text'
              and opening_payload ? 'text_sha256'
              and opening_payload ? 'audio_base64'
              and opening_payload ? 'audio_sha256'
              and opening_payload ? 'mime'
              and opening_payload ? 'voice'
              and opening_payload ? 'tts_model'
              and opening_payload ? 'cost_usd'
              and length(opening_payload->>'item_id') = 32
              and opening_payload->>'item_id' ~ '^lgo-[0-9a-f]{28}$'
              and length(opening_payload->>'text') between 1 and 1000
              and btrim(opening_payload->>'text') <> ''
              and opening_payload->>'text_sha256' ~ '^[0-9a-f]{64}$'
              and length(opening_payload->>'audio_base64')
                between 4 and 2000000
              and length(opening_payload->>'audio_base64') % 4 = 0
              and opening_payload->>'audio_base64' ~
                '^[A-Za-z0-9+/]+={0,2}$'
              and opening_payload->>'audio_sha256' ~ '^[0-9a-f]{64}$'
              and opening_payload->>'mime' = 'audio/mpeg'
              and opening_payload->>'voice' = 'ash'
              and case
                when jsonb_typeof(opening_payload->'cost_usd') = 'number'
                  then (opening_payload->>'cost_usd')::numeric between 0 and 1
                else false
              end
              and (
                (
                  opening_payload->'version' = '1'::jsonb
                  and opening_payload->>'tts_model' = 'tts-1'
                  and opening_payload - array[
                    'version',
                    'item_id',
                    'text',
                    'text_sha256',
                    'audio_base64',
                    'audio_sha256',
                    'mime',
                    'voice',
                    'tts_model',
                    'cost_usd'
                  ]::text[] = '{}'::jsonb
                )
                or
                (
                  opening_payload->'version' = '2'::jsonb
                  and opening_payload->>'tts_model' = 'tts-1-hd'
                  and opening_payload - array[
                    'version',
                    'item_id',
                    'text',
                    'text_sha256',
                    'audio_base64',
                    'audio_sha256',
                    'mime',
                    'voice',
                    'tts_model',
                    'cost_usd',
                    'resume_context'
                  ]::text[] = '{}'::jsonb
                  and (
                    opening_payload @>
                      '{"resume_context":null}'::jsonb
                    or (
                      jsonb_typeof(opening_payload->'resume_context') =
                        'object'
                      and (opening_payload->'resume_context') - array[
                        'coverage_receipt_id',
                        'revision',
                        'snapshot_digest',
                        'next_action'
                      ]::text[] = '{}'::jsonb
                      and coalesce(
                        opening_payload->'resume_context'
                          ->>'coverage_receipt_id' ~
                            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                        false
                      )
                      and opening_payload->'resume_context'->'revision' =
                        '1'::jsonb
                      and coalesce(
                        opening_payload->'resume_context'
                          ->>'snapshot_digest' ~ '^[0-9a-f]{64}$',
                        false
                      )
                      and jsonb_typeof(
                        opening_payload->'resume_context'->'next_action'
                      ) = 'object'
                      and (opening_payload->'resume_context'->'next_action')
                        - array[
                          'type', 'field', 'subject', 'question_pt'
                        ]::text[] = '{}'::jsonb
                      and opening_payload->'resume_context'->'next_action'->>'type' = 'ask'
                      and coalesce(btrim(
                        opening_payload->'resume_context'->'next_action'
                          ->>'field'
                      ), '') <> ''
                      and coalesce(btrim(
                        opening_payload->'resume_context'->'next_action'
                          ->>'question_pt'
                      ), '') <> ''
                      and (
                        opening_payload->'resume_context'->'next_action'
                          ->'subject' is null
                        or coalesce(btrim(
                          opening_payload->'resume_context'->'next_action'
                            ->>'subject'
                        ), '') <> ''
                      )
                      and (
                        (
                          opening_payload->'resume_context'->'next_action'
                            ->>'question_pt' like
                              'Eu já analisei seu website%'
                          and position(
                            'Eu já analisei seu website' in
                              opening_payload->>'text'
                          ) > 0
                        )
                        or (
                          opening_payload->'resume_context'->'next_action'
                            ->>'question_pt' not like
                              'Eu já analisei seu website%'
                          and position(
                            'Vamos continuar de onde paramos.' in
                              opening_payload->>'text'
                          ) > 0
                        )
                      )
                      and position(
                        opening_payload->'resume_context'->'next_action'
                          ->>'question_pt' in opening_payload->>'text'
                      ) > 0
                    )
                  )
                )
              )
            ), false)
          )
        )
      )
    ), false)
  ) not valid;
alter table public.browser_session_requests
  validate constraint browser_session_requests_opening_state_check;

revoke all on function public.initialize_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.initialize_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,jsonb
) to service_role;

revoke all on function public.reconcile_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text
) to service_role;

commit;
