-- The browser requests an opening strategy; only the trusted controller may
-- publish the strategy and immutable payload that were actually applied.
-- Existing provider-owned ready rows are backfilled before the atomic state
-- constraint is installed. No ACL or RLS policy changes are required.

alter table public.browser_session_requests
  add column if not exists opening_mode_requested text not null default 'provider_model_v1',
  add column if not exists opening_mode_applied text,
  add column if not exists opening_payload jsonb;

alter table public.browser_session_requests
  drop constraint if exists browser_session_requests_status_check;
alter table public.browser_session_requests
  add constraint browser_session_requests_status_check check (
    status in ('pending','processing','ready','cancel_requested','error','expired')
  );

create unique index browser_session_requests_call_id_unique
  on public.browser_session_requests (call_id)
  where call_id is not null;

create or replace function public.enforce_browser_session_call_binding_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.browser_session_requests%rowtype;
begin
  select br.* into v_request
  from public.browser_session_requests br
  where br.call_id = new.id for update;
  if found and (
    v_request.status <> 'processing'
    or v_request.tenant_id is distinct from new.tenant_id
    or v_request.session_type is distinct from new.session_type
    or v_request.session_type <> 'onboarding'
    or v_request.opening_mode_requested <> 'application_tts_v1'
    or v_request.answer_sdp is not null
    or v_request.opening_mode_applied is not null
    or v_request.opening_payload is not null
  ) then
    raise exception using errcode = '23514', message = 'browser_session_call_binding_invalid';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_browser_session_call_binding_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists calls_browser_session_binding on public.calls;
create trigger calls_browser_session_binding
before insert on public.calls
for each row execute function public.enforce_browser_session_call_binding_v1();

create or replace function public.normalize_legacy_provider_opening_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'ready'
    and new.opening_mode_requested = 'provider_model_v1'
    and new.opening_mode_applied is null
    and new.opening_payload is null then
    new.opening_mode_applied := 'provider_model_v1';
  end if;
  return new;
end;
$$;

revoke all on function public.normalize_legacy_provider_opening_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists browser_session_requests_legacy_provider_opening
  on public.browser_session_requests;
create trigger browser_session_requests_legacy_provider_opening
before insert or update on public.browser_session_requests
for each row execute function public.normalize_legacy_provider_opening_v1();

update public.browser_session_requests
set opening_mode_applied = 'provider_model_v1'
where status = 'ready'
  and opening_mode_applied is null
  and opening_payload is null;

create or replace function public.enforce_browser_session_cancel_transition_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status = 'ready' then
    if new is not distinct from old then
      return new;
    elsif new.status = 'cancel_requested' then
      if old.session_type <> 'onboarding'
        or old.opening_mode_requested <> 'application_tts_v1'
        or old.opening_mode_applied <> 'application_tts_v1'
        or old.opening_payload is null
        or old.call_id is null
        or old.answer_sdp is null
        or new.id is distinct from old.id
        or new.tenant_id is distinct from old.tenant_id
        or new.user_id is distinct from old.user_id
        or new.session_type is distinct from old.session_type
        or new.opening_mode_requested is distinct from old.opening_mode_requested
        or new.call_id is distinct from old.call_id
        or new.answer_sdp is distinct from old.answer_sdp
        or new.opening_mode_applied is distinct from old.opening_mode_applied
        or new.opening_payload is distinct from old.opening_payload then
        raise exception using errcode = '23514', message = 'browser_session_cancel_transition_invalid';
      end if;
    else
      raise exception using errcode = '23514', message = 'browser_session_cancel_transition_invalid';
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'processing' and new.status = 'cancel_requested' then
    if old.session_type <> 'onboarding'
      or old.opening_mode_requested <> 'application_tts_v1'
      or old.call_id is null
      or old.answer_sdp is not null
      or old.opening_mode_applied is not null
      or old.opening_payload is not null
      or new.id is distinct from old.id
      or new.tenant_id is distinct from old.tenant_id
      or new.user_id is distinct from old.user_id
      or new.session_type is distinct from old.session_type
      or new.opening_mode_requested is distinct from old.opening_mode_requested
      or new.call_id is distinct from old.call_id
      or new.answer_sdp is not null
      or new.opening_mode_applied is not null
      or new.opening_payload is not null then
      raise exception using errcode = '23514', message = 'browser_session_cancel_transition_invalid';
    end if;
  elsif new.status = 'cancel_requested' then
    raise exception using errcode = '23514', message = 'browser_session_cancel_transition_invalid';
  elsif tg_op = 'UPDATE' and old.status = 'cancel_requested' then
    if new.status <> 'expired'
      or new.id is distinct from old.id
      or new.tenant_id is distinct from old.tenant_id
      or new.user_id is distinct from old.user_id
      or new.session_type is distinct from old.session_type
      or new.opening_mode_requested is distinct from old.opening_mode_requested
      or new.call_id is distinct from old.call_id
      or new.answer_sdp is not null
      or new.opening_mode_applied is not null
      or new.opening_payload is not null then
      raise exception using errcode = '23514', message = 'browser_session_cancel_transition_invalid';
    end if;
  elsif new.status = 'expired' and new.call_id is not null then
    raise exception using errcode = '23514', message = 'browser_session_cancel_transition_invalid';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_browser_session_cancel_transition_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists browser_session_requests_cancel_transition
  on public.browser_session_requests;
create trigger browser_session_requests_cancel_transition
before insert or update on public.browser_session_requests
for each row execute function public.enforce_browser_session_cancel_transition_v1();

alter table public.browser_session_requests
  drop constraint if exists browser_session_requests_opening_mode_requested_check,
  drop constraint if exists browser_session_requests_application_opening_scope_check,
  drop constraint if exists browser_session_requests_opening_state_check;

alter table public.browser_session_requests
  add constraint browser_session_requests_opening_mode_requested_check check (
    opening_mode_requested in ('provider_model_v1', 'application_tts_v1')
  ),
  add constraint browser_session_requests_application_opening_scope_check check (
    opening_mode_requested <> 'application_tts_v1' or session_type = 'onboarding'
  ),
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
        or
        (
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
            and opening_payload->'version' = '1'::jsonb
            and length(opening_payload->>'item_id') = 32
            and opening_payload->>'item_id' ~ '^lgo-[0-9a-f]{28}$'
            and length(opening_payload->>'text') between 1 and 1000
            and btrim(opening_payload->>'text') <> ''
            and opening_payload->>'text_sha256' ~ '^[0-9a-f]{64}$'
            and length(opening_payload->>'audio_base64') between 4 and 2000000
            and length(opening_payload->>'audio_base64') % 4 = 0
            and opening_payload->>'audio_base64' ~ '^[A-Za-z0-9+/]+={0,2}$'
            and opening_payload->>'audio_sha256' ~ '^[0-9a-f]{64}$'
            and opening_payload->>'mime' = 'audio/mpeg'
            and opening_payload->>'voice' = 'ash'
            and opening_payload->>'tts_model' = 'tts-1'
            and case
              when jsonb_typeof(opening_payload->'cost_usd') = 'number'
                then (opening_payload->>'cost_usd')::numeric between 0 and 1
              else false
            end
          ), false)
        )
      )
    )
    ), false)
  );
