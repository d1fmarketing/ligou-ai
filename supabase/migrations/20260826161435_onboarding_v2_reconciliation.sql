-- Review round 1: V2 facts require an explicit typed value, directed
-- follow-ups retain their complete source identity, and a second provider
-- approval event for the same snapshot receives its own durable alias.
-- Public RPC signatures remain unchanged. The previously audited bodies are
-- renamed, fully revoked, and called only by these narrow definer wrappers.

do $$
begin
  if to_regclass('public.receipts_onboarding_approval_snapshot_unique') is null
     or to_regclass('public.receipts_onboarding_event_key_unique') is null then
    raise exception using errcode = '55000',
      message = 'onboarding_reconciliation_indexes_missing';
  end if;
end
$$;

alter table public.receipts
  drop constraint if exists receipts_onboarding_shape_check;
alter table public.receipts add constraint receipts_onboarding_shape_check check (
  kind not in (
    'onboarding_coverage',
    'onboarding_voice_approval',
    'onboarding_event_alias'
  )
  or (
    outcome = 'accepted'
    and call_id is not null
    and coalesce(external_id ~ '^[0-9a-f]{64}$', false)
    and coalesce(payload_hash ~ '^[0-9a-f]{64}$', false)
    and jsonb_typeof(readback) = 'object'
    and coalesce(readback->>'call_id' = call_id::text, false)
    and readback->'authority' is not distinct from jsonb_build_object(
      'rules_approved', false,
      'powers_granted', false,
      'operational_mode_changed', false
    )
    and (
      kind <> 'onboarding_coverage'
      or (
        coalesce(readback->>'revision' ~ '^[1-9][0-9]*$', false)
        and jsonb_typeof(readback->'complete') = 'boolean'
        and coalesce(readback->>'snapshot_digest' ~ '^[0-9a-f]{64}$', false)
        and (
          (
            readback->'schema_version' is not distinct from '1'::jsonb
            and coalesce(detail->>'answer_hash' ~ '^[0-9a-f]{64}$', false)
          )
          or (
            readback->'schema_version' is not distinct from '2'::jsonb
            and coalesce(readback->>'transition_kind', '') in (
              'answer', 'directed_followup'
            )
            and jsonb_typeof(readback->'snapshot') = 'object'
            and jsonb_typeof(readback->'progress') = 'object'
            and jsonb_typeof(readback->'selected_rule_ids') = 'array'
            and jsonb_typeof(readback->'current_answer_hashes') = 'object'
            and jsonb_typeof(readback->'materializations') = 'array'
            and (
              (
                (readback->>'complete')::boolean = false
                and readback->'summary_projection' = 'null'::jsonb
                and readback->'summary_hash' = 'null'::jsonb
              )
              or (
                (readback->>'complete')::boolean = true
                and jsonb_typeof(readback->'summary_projection') = 'object'
                and coalesce(readback->>'summary_hash' ~ '^[0-9a-f]{64}$', false)
                and readback->>'summary_hash' =
                  readback->'summary_projection'->>'summaryHash'
              )
            )
            and (
              (
                readback->>'transition_kind' = 'answer'
                and coalesce(detail->>'answer_hash' ~ '^[0-9a-f]{64}$', false)
                and coalesce(detail->>'coverage_key', '') <> ''
              )
              or (
                readback->>'transition_kind' = 'directed_followup'
                and detail->>'transition_kind' = 'directed_followup'
                and coalesce(detail->>'source_revision' ~ '^[1-9][0-9]*$', false)
                and coalesce(detail->>'field', '') <> ''
                -- Rows emitted by migration 57 predate the strict transition
                -- envelope.  Keep those immutable receipts valid while every
                -- newly emitted follow-up is explicitly schema 2 and strict.
                and (
                  not (detail ? 'transition_schema')
                  or (
                    detail->'transition_schema' is not distinct from '2'::jsonb
                    and coalesce(detail->>'source_digest' ~ '^[0-9a-f]{64}$', false)
                    and coalesce(detail->>'question_pt', '') <> ''
                  )
                )
              )
            )
          )
        )
      )
    )
    and (
      kind <> 'onboarding_voice_approval'
      or (
        readback->'schema_version' is not distinct from '1'::jsonb
        and coalesce(
          readback->>'snapshot_receipt_id' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
        and coalesce(readback->>'snapshot_revision' ~ '^[1-9][0-9]*$', false)
        and coalesce(readback->>'snapshot_digest' ~ '^[0-9a-f]{64}$', false)
        and coalesce(
          detail->>'owner_id' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
      )
    )
    and (
      kind <> 'onboarding_event_alias'
      or (
        readback->'schema_version' is not distinct from '2'::jsonb
        and readback->>'target_kind' in (
          'onboarding_coverage', 'onboarding_voice_approval'
        )
        and coalesce(
          readback->>'target_receipt_id' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
        and coalesce(readback->>'target_revision' ~ '^[1-9][0-9]*$', false)
        and coalesce(readback->>'target_digest' ~ '^[0-9a-f]{64}$', false)
        and coalesce(
          detail->>'target_receipt_id' = readback->>'target_receipt_id', false
        )
        and (
          readback->>'target_kind' = 'onboarding_coverage'
          or (
            readback->>'target_kind' = 'onboarding_voice_approval'
            and readback->>'approval_receipt_id' =
              readback->>'target_receipt_id'
            and coalesce(
              readback->>'snapshot_receipt_id' ~
                '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
              false
            )
            and readback->>'snapshot_revision' =
              readback->>'target_revision'
            and readback->>'snapshot_digest' = readback->>'target_digest'
            and coalesce(
              detail->>'owner_id' ~
                '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
              false
            )
            and coalesce(detail->>'provider_tool_call_id', '') <> ''
            and coalesce(detail->>'owner_words', '') <> ''
          )
        )
      )
    )
  )
) not valid;
alter table public.receipts
  validate constraint receipts_onboarding_shape_check;

create or replace function public.onboarding_answer_value_valid_v2(
  p_field text,
  p_value jsonb
) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
  v_canonical text;
  v_opens text;
  v_closes text;
  v_state_names constant text[] := array[
    'alabama','alaska','arizona','arkansas','california','colorado',
    'connecticut','delaware','florida','georgia','hawaii','idaho',
    'illinois','indiana','iowa','kansas','kentucky','louisiana','maine',
    'maryland','massachusetts','michigan','minnesota','mississippi',
    'missouri','montana','nebraska','nevada','new hampshire','new jersey',
    'new mexico','new york','north carolina','north dakota','ohio',
    'oklahoma','oregon','pennsylvania','rhode island','south carolina',
    'south dakota','tennessee','texas','utah','vermont','virginia',
    'washington','west virginia','wisconsin','wyoming',
    'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il',
    'in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt',
    'ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri',
    'sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy'
  ];
begin
  if p_value is null or p_value = 'null'::jsonb then
    return false;
  end if;

  if p_field = 'service.catalog_closure' then
    return p_value is not distinct from 'true'::jsonb;
  elsif p_field = 'service.price_target' then
    if jsonb_typeof(p_value) <> 'number' then return false; end if;
    return (p_value #>> '{}')::numeric >= 0;
  elsif p_field = 'service.duration' then
    if jsonb_typeof(p_value) <> 'number' then return false; end if;
    return (p_value #>> '{}')::numeric > 0;
  elsif p_field = 'service.price_mode' then
    return jsonb_typeof(p_value) = 'string'
      and p_value #>> '{}' in ('fixed','starting_at','estimate','owner_review');
  elsif p_field = 'service.negotiation' then
    if jsonb_typeof(p_value) = 'string' then
      return p_value #>> '{}' = 'non_negotiable';
    end if;
    if jsonb_typeof(p_value) <> 'object' then return false; end if;
    return (select count(*) from jsonb_object_keys(p_value)) = 1
      and p_value ? 'floor'
      and jsonb_typeof(p_value->'floor') = 'number'
      and (p_value->>'floor')::numeric >= 0;
  elsif p_field = 'service.emergency_eligibility' then
    return jsonb_typeof(p_value) = 'boolean';
  elsif p_field = 'schedule.business_hours' then
    if jsonb_typeof(p_value) <> 'object' then return false; end if;
    if (select count(*) from jsonb_object_keys(p_value)) <> 2
       or not (p_value ? 'days' and p_value ? 'hours')
       or jsonb_typeof(p_value->'days') <> 'array'
       or jsonb_typeof(p_value->'hours') <> 'object' then
      return false;
    end if;
    if jsonb_array_length(p_value->'days') = 0
       or (select count(*) from jsonb_object_keys(p_value->'hours')) <> 2
       or not (p_value->'hours' ? 'opens' and p_value->'hours' ? 'closes') then
      return false;
    end if;
    if exists (
         select 1 from jsonb_array_elements(p_value->'days') day
         where jsonb_typeof(day) <> 'string'
           or day #>> '{}' not in ('sun','mon','tue','wed','thu','fri','sat')
       )
       or (
         select count(*) <> count(distinct day #>> '{}')
         from jsonb_array_elements(p_value->'days') day
       ) then
      return false;
    end if;
    v_opens := p_value->'hours'->>'opens';
    v_closes := p_value->'hours'->>'closes';
    return coalesce(v_opens ~ '^(?:[01][0-9]|2[0-3]):00$', false)
      and coalesce(v_closes ~ '^(?:[01][0-9]|2[0-3]):00$', false)
      and v_opens < v_closes;
  elsif p_field = 'business.customer_types' then
    if jsonb_typeof(p_value) <> 'array' then return false; end if;
    return jsonb_array_length(p_value) > 0
      and not exists (
        select 1 from jsonb_array_elements(p_value) item
        where jsonb_typeof(item) <> 'string'
          or lower(regexp_replace(
            item #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'
          )) not in (
            'residencial','comercial','ambos'
          )
      );
  elsif p_field = 'area.coverage' then
    if jsonb_typeof(p_value) <> 'object' then return false; end if;
    if (select count(*) from jsonb_object_keys(p_value)) <> 1
       or not (p_value ? 'cities')
       or jsonb_typeof(p_value->'cities') <> 'array' then
      return false;
    end if;
    if jsonb_array_length(p_value->'cities') = 0 then
      return false;
    end if;
    for v_text in
      select city #>> '{}' from jsonb_array_elements(p_value->'cities') city
    loop
      if v_text is null or v_text <> regexp_replace(
           v_text, '^[[:space:]]+|[[:space:]]+$', '', 'g'
         )
         or length(v_text) > 100 or v_text ~ '[0-9]'
         or v_text !~ '^[[:alpha:]][[:alpha:].'' -]*$' then
        return false;
      end if;
      v_canonical := lower(regexp_replace(v_text, '[[:space:]]+', ' ', 'g'));
      if v_canonical = any(v_state_names)
         or regexp_replace(v_canonical, '[^[:alpha:]]', '', 'g') in (
           'unitedstates','unitedstatesofamerica','usa','us','america'
         )
         or v_canonical in ('state','estado')
         or v_canonical ~ '(^|[^[:alpha:]])(county|condado|region|regiao|região|province|provincia|província|metropolitan|metro|area|área|zip|cep|postal)([^[:alpha:]]|$)'
         or (
           v_canonical ~ '^(north(?:ern)?|south(?:ern)?|east(?:ern)?|west(?:ern)?|central) '
           and regexp_replace(v_canonical, '^[^ ]+ ', '') = any(v_state_names)
         )
         or (
           v_canonical ~ '^(state of|estado de) '
           and regexp_replace(v_canonical, '^(state of|estado de) ', '') =
             any(v_state_names)
         )
         or (
           v_canonical ~ ' (state|estado)$'
           and regexp_replace(v_canonical, ' (state|estado)$', '') =
             any(v_state_names)
         ) then
        return false;
      end if;
    end loop;
    return (
      select count(*) = count(distinct lower(city #>> '{}'))
      from jsonb_array_elements(p_value->'cities') city
    );
  elsif p_field in ('emergency.types','service.name_synonyms') then
    if jsonb_typeof(p_value) <> 'array' then return false; end if;
    return jsonb_array_length(p_value) > 0
      and not exists (
        select 1 from jsonb_array_elements(p_value) item
        where jsonb_typeof(item) <> 'string'
          or length(regexp_replace(
            item #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'
          )) = 0
      );
  elsif p_field = any(array[
    'business.excluded_work','business.languages_tone',
    'area.out_of_area_policy','area.travel_fee',
    'schedule.same_day_lead_time','schedule.capacity_buffer',
    'schedule.reschedule_cancel','schedule.holidays',
    'emergency.safety_escalation','emergency.after_hours',
    'emergency.fee_authority','policy.payment_estimate',
    'policy.warranty_materials','policy.access_cancellation',
    'policy.complaints_returns','authority.quote_price',
    'authority.negotiate_floor','authority.read_calendar','authority.book',
    'authority.reschedule_cancel','authority.charge_fee',
    'authority.emergency','authority.out_of_area',
    'service.inclusions_exclusions','service.materials_parts',
    'service.warranty','service.escalation'
  ]) then
    return jsonb_typeof(p_value) = 'string'
      and length(regexp_replace(
        p_value #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'
      )) > 0;
  end if;
  return false;
end
$$;

revoke all on function public.onboarding_answer_value_valid_v2(text,jsonb)
from public, anon, authenticated, service_role;

alter function public.record_onboarding_answer(
  uuid,uuid,uuid,text,text,text,integer,jsonb,uuid,jsonb
) rename to record_onboarding_answer_v2_base;

create or replace function public.record_onboarding_answer(
  p_tenant uuid,
  p_call uuid,
  p_owner uuid,
  p_provider_tool_call_id text,
  p_event_key text,
  p_answer_hash text,
  p_expected_revision integer,
  p_fact jsonb,
  p_rule_group_id uuid,
  p_coverage jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_role text;
  v_coverage_key text;
  v_materialization_key text;
  v_cell jsonb;
  v_value jsonb;
  v_materialization jsonb;
  v_value_valid boolean;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt()->>'role', '')
  );
  if v_request_role is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  perform set_config('request.jwt.claim.role', v_request_role, true);
  if p_coverage->'schema_version' is not distinct from '2'::jsonb then
    if not (
         jsonb_typeof(p_fact->'structured') = 'object'
         and p_fact->'structured' ? 'value'
         and (
           select count(*) from jsonb_object_keys(p_fact->'structured')
         ) = 1
         and p_fact->>'disposition' in (
           'answered', 'owner_review_required', 'not_applicable'
         )
         and (
           p_fact->>'disposition' = 'answered'
           or p_fact->'structured'->'value' is not distinct from 'null'::jsonb
         )
         and jsonb_typeof(p_coverage->'snapshot') = 'object'
         and jsonb_typeof(p_coverage->'snapshot'->'cells') = 'object'
         and jsonb_typeof(p_coverage->'materializations') = 'array'
         and length(regexp_replace(
           coalesce(p_fact->>'owner_words', ''),
           '^[[:space:]]+|[[:space:]]+$', '', 'g'
         )) > 0
       ) then
      raise exception using errcode = '22023',
        message = 'onboarding_structured_contract_invalid';
    end if;
    v_coverage_key := case
      when p_fact->>'field' like 'service.%'
        and p_fact->>'field' <> 'service.catalog_closure'
        then 'service:' || coalesce(p_fact->>'subject', '') || ':' ||
          (p_fact->>'field')
      else p_fact->>'field'
    end;
    v_materialization_key := case
      when p_fact->>'field' like 'service.%'
        and p_fact->>'field' <> 'service.catalog_closure'
        then 'service:' || coalesce(p_fact->>'subject', '')
      when p_fact->>'field' like 'business.%' then 'domain:business'
      when p_fact->>'field' like 'area.%' then 'domain:area'
      when p_fact->>'field' like 'schedule.%' then 'domain:schedule'
      when p_fact->>'field' like 'emergency.%' then 'domain:emergency'
      when p_fact->>'field' like 'policy.%' then 'domain:policy'
      when p_fact->>'field' like 'authority.%' then 'domain:authority'
      else null
    end;
    v_cell := p_coverage->'snapshot'->'cells'->v_coverage_key;
    v_value := p_fact->'structured'->'value';
    v_value_valid := false;

    if p_fact->>'disposition' = 'answered' then
      v_value_valid := public.onboarding_answer_value_valid_v2(
        p_fact->>'field', v_value
      );
      if not v_value_valid then
        if coalesce(v_cell->>'state', '') not in ('ambiguous', 'missing') then
          raise exception using errcode = '22023',
            message = 'onboarding_structured_projection_invalid';
        end if;
      elsif p_fact->>'field' = 'service.negotiation' then
        if jsonb_typeof(v_value) = 'string' then
          if v_cell->>'state' <> 'answered'
             or v_cell->'value'->>'mode' <> 'non_negotiable'
             or jsonb_typeof(v_cell->'value'->'floor') <> 'number' then
            raise exception using errcode = '22023',
              message = 'onboarding_structured_projection_invalid';
          end if;
        elsif v_cell->>'state' <> 'answered'
              or v_cell->'value'->>'mode' <> 'negotiable'
              or v_cell->'value'->'floor' is distinct from (
                case
                  when jsonb_typeof(v_value) = 'object' then v_value->'floor'
                  else v_value
                end
              ) then
          raise exception using errcode = '22023',
            message = 'onboarding_structured_projection_invalid';
        end if;
      elsif v_cell->>'state' <> 'answered'
            or v_cell->'value' is distinct from v_value then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      end if;
    elsif p_fact->>'disposition' = 'owner_review_required' then
      if coalesce(v_cell->>'state', '') not in (
        'owner_review_required', 'ambiguous', 'missing'
      ) then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      end if;
    elsif p_fact->>'field' = 'service.negotiation' then
      if v_cell->>'state' <> 'answered'
         or v_cell->'value'->>'mode' <> 'non_negotiable'
         or jsonb_typeof(v_cell->'value'->'floor') <> 'number' then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      end if;
    elsif coalesce(v_cell->>'state', '') not in (
      'not_applicable', 'ambiguous', 'missing'
    ) then
      raise exception using errcode = '22023',
        message = 'onboarding_structured_projection_invalid';
    end if;

    if v_materialization_key is not null then
      select item into v_materialization
      from jsonb_array_elements(p_coverage->'materializations') item
      where item->>'key' = v_materialization_key;
      if v_materialization is null
         or not (
           v_materialization->'source_refs' @> jsonb_build_array(v_coverage_key)
         ) then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      end if;
    end if;

    if v_materialization is not null
       and (
         p_fact->>'disposition' = 'owner_review_required'
         or v_cell->>'state' = 'owner_review_required'
       )
       and coalesce(v_materialization->>'state', '') not in (
         'owner_review_required', 'incomplete'
       ) then
      raise exception using errcode = '22023',
        message = 'onboarding_structured_projection_invalid';
    end if;

    if v_materialization_key like 'service:%'
       and p_fact->>'field' = 'service.price_mode'
       and (
         p_fact->>'disposition' <> 'answered'
         or v_value_valid
       ) then
      if v_cell->>'state' = 'owner_review_required' then
        if v_materialization->'structured'->>'price_mode' <> 'owner_review'
           or v_materialization->'structured'->'quoteable'
                is not distinct from 'true'::jsonb
           or v_materialization->'structured' ? 'price_target'
           or v_materialization->'structured' ? 'price_min' then
          raise exception using errcode = '22023',
            message = 'onboarding_structured_projection_invalid';
        end if;
      elsif v_value #>> '{}' in ('estimate', 'owner_review') then
        if v_materialization->'structured'->>'price_mode' <> v_value #>> '{}'
           or v_materialization->'structured'->'quoteable'
                is not distinct from 'true'::jsonb
           or v_materialization->'structured' ? 'price_target'
           or v_materialization->'structured' ? 'price_min'
           or (
             v_value #>> '{}' = 'owner_review'
             and coalesce(v_materialization->>'state', '') not in (
               'owner_review_required', 'incomplete'
             )
           ) then
          raise exception using errcode = '22023',
            message = 'onboarding_structured_projection_invalid';
        end if;
      elsif v_materialization->'structured'->>'price_mode' <> v_value #>> '{}'
      then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      end if;
    end if;
    if v_materialization_key like 'service:%'
       and p_fact->>'field' <> 'service.price_mode'
       and v_cell->>'state' = 'owner_review_required'
       and (
         v_materialization->'structured'->'quoteable'
           is not distinct from 'true'::jsonb
         or v_materialization->'structured' ? 'price_target'
         or v_materialization->'structured' ? 'price_min'
         or (
           p_fact->>'field' = 'service.duration'
           and v_materialization->'structured' ? 'duration_min'
         )
       ) then
      raise exception using errcode = '22023',
        message = 'onboarding_structured_projection_invalid';
    end if;

    if v_materialization_key like 'service:%'
       and p_fact->>'disposition' = 'answered'
       and v_value_valid
       and v_materialization->'structured'->'materialization_eligible'
            is not distinct from 'true'::jsonb then
      if p_fact->>'field' = 'service.price_target'
         and v_materialization->'structured'->'quoteable'
              is not distinct from 'true'::jsonb
         and v_materialization->'structured'->'price_target'
              is distinct from v_value then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      elsif p_fact->>'field' = 'service.negotiation'
            and v_materialization->'structured'->'quoteable'
              is not distinct from 'true'::jsonb
            and v_materialization->'structured'->'price_min'
              is distinct from v_cell->'value'->'floor' then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      elsif p_fact->>'field' = 'service.duration'
            and v_materialization->'structured'->'duration_min'
              is distinct from v_value then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      elsif p_fact->>'field' = 'service.name_synonyms'
            and v_materialization->'structured'->'service_names'
              is distinct from (
                select jsonb_agg(
                  to_jsonb(regexp_replace(
                    name #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'
                  )) order by ordinal
                )
                from jsonb_array_elements(v_value)
                  with ordinality names(name, ordinal)
              ) then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      elsif p_fact->>'field' = 'service.emergency_eligibility'
            and v_materialization->'structured'->'emergency_eligible'
              is distinct from v_value then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      end if;
    end if;

    if p_fact->>'disposition' = 'answered'
       and v_value_valid
       and v_materialization->'structured'->'materialization_eligible'
         is not distinct from 'true'::jsonb
       and p_fact->>'field' = 'area.coverage'
       and v_materialization->'structured'->'cities'
         is distinct from v_value->'cities' then
      raise exception using errcode = '22023',
        message = 'onboarding_structured_projection_invalid';
    end if;
    if p_fact->>'disposition' = 'answered'
       and v_value_valid
       and v_materialization->'structured'->'materialization_eligible'
         is not distinct from 'true'::jsonb
       and p_fact->>'field' = 'schedule.business_hours'
       and v_materialization->'structured'->'business_hours'
         is distinct from v_value then
      raise exception using errcode = '22023',
        message = 'onboarding_structured_projection_invalid';
    end if;
    if coalesce(v_cell->>'state', '') in ('ambiguous', 'missing')
       and exists (
         select 1
         from jsonb_array_elements(p_coverage->'materializations') item
         where item->>'key' = v_materialization_key
           and (
             coalesce((item->>'review_ready')::boolean, false)
             or coalesce(
               (item->'structured'->>'materialization_eligible')::boolean,
               false
             )
           )
       ) then
      raise exception using errcode = '22023',
        message = 'onboarding_structured_projection_invalid';
    end if;
  end if;
  return public.record_onboarding_answer_v2_base(
    p_tenant, p_call, p_owner, p_provider_tool_call_id, p_event_key,
    p_answer_hash, p_expected_revision, p_fact, p_rule_group_id, p_coverage
  );
end
$$;

revoke all on function public.record_onboarding_answer_v2_base(
  uuid,uuid,uuid,text,text,text,integer,jsonb,uuid,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.record_onboarding_answer(
  uuid,uuid,uuid,text,text,text,integer,jsonb,uuid,jsonb
) from public, anon, authenticated;
grant execute on function public.record_onboarding_answer(
  uuid,uuid,uuid,text,text,text,integer,jsonb,uuid,jsonb
) to service_role;

create or replace function public.record_onboarding_followup(
  p_tenant uuid,
  p_call uuid,
  p_owner uuid,
  p_event_key text,
  p_expected_revision integer,
  p_field text,
  p_subject text,
  p_coverage jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_expected_event_key text;
  v_payload jsonb;
  v_payload_hash text;
  v_existing public.receipts;
  v_latest public.receipts;
  v_receipt_id uuid;
  v_key text;
  v_global_count integer;
  v_group_count integer;
  v_expected_snapshot jsonb;
  v_expected_coverage jsonb;
  v_readback jsonb;
  v_snapshot_digest text;
  v_request_role text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt()->>'role', '')
  );
  if v_request_role is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  perform set_config('request.jwt.claim.role', v_request_role, true);
  if p_tenant is null or p_call is null or p_owner is null
     or p_expected_revision is null or p_expected_revision < 1
     or coalesce(p_field, '') = ''
     or p_event_key is null or p_event_key !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_coverage) is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'onboarding_followup_shape_invalid';
  end if;
  if p_field like 'service.%' and p_field <> 'service.catalog_closure' then
    if coalesce(p_subject, '') !~ '^[a-z0-9][a-z0-9_]{0,199}$' then
      raise exception using errcode = '22023',
        message = 'onboarding_subject_required';
    end if;
    v_key := 'service:' || p_subject || ':' || p_field;
  else
    if nullif(p_subject, '') is not null then
      raise exception using errcode = '22023',
        message = 'onboarding_subject_forbidden';
    end if;
    v_key := p_field;
  end if;
  v_expected_event_key := encode(extensions.digest(convert_to(
    'ligou.v0_2.onboarding_followup:v1:' || p_tenant::text || ':' ||
      p_call::text || ':' || p_expected_revision::text || ':' || p_field ||
      ':' || coalesce(p_subject, ''),
    'UTF8'
  ), 'sha256'), 'hex');
  if p_event_key <> v_expected_event_key then
    raise exception using errcode = '22023',
      message = 'onboarding_event_key_mismatch';
  end if;
  v_payload := jsonb_build_object(
    'schema_version', 2,
    'tenant_id', p_tenant,
    'call_id', p_call,
    'owner_id', p_owner,
    'event_key', p_event_key,
    'expected_revision', p_expected_revision,
    'field', p_field,
    'subject', p_subject,
    'coverage', p_coverage
  );
  v_payload_hash := encode(extensions.digest(
    convert_to(v_payload::text, 'UTF8'), 'sha256'
  ), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.onboarding:' || p_tenant::text || ':' || p_call::text,
    0
  ));
  select br.id into v_request_id
  from public.calls c
  join public.tenants t
    on t.id = c.tenant_id
   and t.id = p_tenant
   and t.owner_user_id = p_owner
   and t.status = 'onboarding'
   and t.operational_mode = 'simulation_only'
  join public.browser_session_requests br
    on br.tenant_id = t.id
   and br.call_id = c.id
   and br.user_id = p_owner
   and br.session_type = 'onboarding'
   and br.status = 'ready'
  where c.id = p_call
    and c.tenant_id = p_tenant
    and c.channel = 'browser'
    and c.session_type = 'onboarding'
    and c.status = 'active'
  order by br.handled_at desc nulls last, br.created_at desc, br.id desc
  limit 1
  for update of c, t, br;
  if v_request_id is null then
    raise exception using errcode = '42501',
      message = 'onboarding_call_not_owner_bound';
  end if;

  select r.* into v_existing
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind = 'onboarding_coverage'
    and r.external_id = p_event_key
  limit 1;
  if v_existing.id is not null then
    if v_existing.payload_hash is distinct from v_payload_hash then
      raise exception using errcode = '23505',
        message = 'onboarding_event_payload_mismatch';
    end if;
    return jsonb_build_object(
      'status', 'reused',
      'coverage_receipt_id', v_existing.id,
      'revision', (v_existing.readback->>'revision')::integer,
      'snapshot_digest', v_existing.readback->>'snapshot_digest',
      'complete', (v_existing.readback->>'complete')::boolean,
      'missing', v_existing.readback->'progress'->'missingRequired',
      'ambiguous', v_existing.readback->'progress'->'ambiguous',
      'next_action', v_existing.readback->'next_action',
      'coverage', v_existing.readback
    );
  end if;

  select r.* into v_latest
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind = 'onboarding_coverage'
  order by (r.readback->>'revision')::integer desc,
    r.created_at desc, r.id desc
  limit 1;
  if v_latest.id is null then
    raise exception using errcode = 'P0002',
      message = 'onboarding_coverage_missing';
  end if;
  if v_latest.readback->'schema_version' is distinct from '2'::jsonb
     or (v_latest.readback->>'revision')::integer <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'onboarding_revision_changed';
  end if;
  if coalesce((v_latest.readback->>'complete')::boolean, false) then
    raise exception using errcode = '22023',
      message = 'onboarding_coverage_complete';
  end if;
  if v_latest.readback->'next_action'->>'type' <> 'ask'
     or v_latest.readback->'next_action'->>'field' <> p_field
     or coalesce(v_latest.readback->'next_action'->>'subject', '') <>
       coalesce(p_subject, '') then
    raise exception using errcode = '40001',
      message = 'onboarding_followup_changed';
  end if;
  v_global_count := (v_latest.readback->'snapshot'->>'followUps')::integer;
  v_group_count := coalesce(
    (v_latest.readback->'snapshot'->'followUpGroups'->>v_key)::integer,
    0
  );
  if v_group_count >= 2 then
    raise exception using errcode = '22023',
      message = 'onboarding_followup_group_exhausted';
  end if;
  if v_global_count >= 12 then
    raise exception using errcode = '22023',
      message = 'onboarding_followup_global_exhausted';
  end if;

  v_expected_snapshot := v_latest.readback->'snapshot' || jsonb_build_object(
    'revision', p_expected_revision + 1,
    'followUps', v_global_count + 1,
    'followUpGroups',
      (v_latest.readback->'snapshot'->'followUpGroups') ||
        jsonb_build_object(v_key, v_group_count + 1)
  );
  v_expected_coverage := (
    v_latest.readback
      - 'snapshot_digest'
      - 'rule_id'
      - 'rule_group_id'
      - 'materialization_action'
  ) || jsonb_build_object(
    'schema_version', 2,
    'transition_kind', 'directed_followup',
    'revision', p_expected_revision + 1,
    'snapshot', v_expected_snapshot
  );
  if p_coverage is distinct from v_expected_coverage then
    raise exception using errcode = '22023',
      message = 'onboarding_followup_projection_invalid';
  end if;

  v_readback := p_coverage || jsonb_build_object(
    'rule_id', v_latest.readback->'rule_id',
    'rule_group_id', v_latest.readback->'rule_group_id',
    'materialization_action', v_latest.readback->'materialization_action'
  );
  v_snapshot_digest := encode(extensions.digest(
    convert_to(v_readback::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_readback := v_readback || jsonb_build_object(
    'snapshot_digest', v_snapshot_digest
  );
  insert into public.receipts (
    tenant_id, call_id, kind, outcome, external_id, readback, payload_hash,
    detail
  ) values (
    p_tenant, p_call, 'onboarding_coverage', 'accepted', p_event_key,
    v_readback, v_payload_hash,
    jsonb_build_object(
      'transition_kind', 'directed_followup',
      'transition_schema', 2,
      'source_revision', p_expected_revision,
      'source_digest', v_latest.readback->>'snapshot_digest',
      'field', p_field,
      'subject', p_subject,
      'question_pt', v_latest.readback->'next_action'->>'question_pt',
      'coverage_key', v_key,
      'browser_request_id', v_request_id
    )
  ) returning id into v_receipt_id;
  return jsonb_build_object(
    'status', 'recorded',
    'coverage_receipt_id', v_receipt_id,
    'revision', p_expected_revision + 1,
    'snapshot_digest', v_snapshot_digest,
    'complete', (v_readback->>'complete')::boolean,
    'missing', v_readback->'progress'->'missingRequired',
    'ambiguous', v_readback->'progress'->'ambiguous',
    'next_action', v_readback->'next_action',
    'coverage', v_readback
  );
end
$$;

revoke all on function public.record_onboarding_followup(
  uuid,uuid,uuid,text,integer,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.record_onboarding_followup(
  uuid,uuid,uuid,text,integer,text,text,jsonb
) to service_role;

alter function public.record_onboarding_voice_approval(
  uuid,uuid,uuid,text,text,integer,text,text
) rename to record_onboarding_voice_approval_v2_base;

create or replace function public.record_onboarding_voice_approval(
  p_tenant uuid,
  p_call uuid,
  p_owner uuid,
  p_provider_tool_call_id text,
  p_event_key text,
  p_expected_revision integer,
  p_expected_digest text,
  p_owner_words text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_payload_hash text;
  v_result jsonb;
  v_exact public.receipts;
  v_target public.receipts;
  v_alias_readback jsonb;
  v_request_role text;
  v_request_id uuid;
  v_expected_event_key text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt()->>'role', '')
  );
  if v_request_role is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  perform set_config('request.jwt.claim.role', v_request_role, true);
  if p_tenant is null or p_call is null or p_owner is null then
    raise exception using errcode = '22023',
      message = 'onboarding_scope_required';
  end if;
  if p_provider_tool_call_id is null
     or length(btrim(p_provider_tool_call_id)) < 1
     or length(p_provider_tool_call_id) > 255 then
    raise exception using errcode = '22023',
      message = 'onboarding_provider_tool_call_id_invalid';
  end if;
  if p_event_key is null or p_event_key !~ '^[0-9a-f]{64}$'
     or p_expected_digest is null or p_expected_digest !~ '^[0-9a-f]{64}$'
     or p_expected_revision is null or p_expected_revision < 1 then
    raise exception using errcode = '22023',
      message = 'onboarding_approval_snapshot_invalid';
  end if;
  if length(btrim(coalesce(p_owner_words, ''))) < 1
     or length(p_owner_words) > 1000 then
    raise exception using errcode = '22023',
      message = 'onboarding_approval_words_invalid';
  end if;
  v_expected_event_key := encode(extensions.digest(convert_to(
    'ligou.v0_2.onboarding_voice_approval:v1:' || p_tenant::text || ':' ||
      p_call::text || ':' || p_provider_tool_call_id,
    'UTF8'
  ), 'sha256'), 'hex');
  if p_event_key <> v_expected_event_key then
    raise exception using errcode = '22023',
      message = 'onboarding_event_key_mismatch';
  end if;
  v_payload := jsonb_build_object(
    'schema_version', 1,
    'tenant_id', p_tenant,
    'call_id', p_call,
    'owner_id', p_owner,
    'provider_tool_call_id', p_provider_tool_call_id,
    'event_key', p_event_key,
    'expected_revision', p_expected_revision,
    'expected_digest', p_expected_digest,
    'owner_words', p_owner_words
  );
  v_payload_hash := encode(extensions.digest(
    convert_to(v_payload::text, 'UTF8'), 'sha256'
  ), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.onboarding:' || p_tenant::text || ':' || p_call::text,
    0
  ));
  select br.id into v_request_id
  from public.calls c
  join public.tenants t
    on t.id = c.tenant_id
   and t.id = p_tenant
   and t.owner_user_id = p_owner
   and t.status = 'onboarding'
   and t.operational_mode = 'simulation_only'
  join public.browser_session_requests br
    on br.tenant_id = t.id
   and br.call_id = c.id
   and br.user_id = p_owner
   and br.session_type = 'onboarding'
   and br.status = 'ready'
  where c.id = p_call
    and c.tenant_id = p_tenant
    and c.channel = 'browser'
    and c.session_type = 'onboarding'
    and c.status = 'active'
  order by br.handled_at desc nulls last, br.created_at desc, br.id desc
  limit 1
  for update of c, t, br;
  if v_request_id is null then
    raise exception using errcode = '42501',
      message = 'onboarding_call_not_owner_bound';
  end if;

  -- Historical exact event replay wins after owner/call proof and before the
  -- latest snapshot preflight in the legacy-compatible base body.
  select r.* into v_exact
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind in ('onboarding_voice_approval', 'onboarding_event_alias')
    and r.external_id = p_event_key
  limit 1;
  if v_exact.id is not null then
    if v_exact.payload_hash is distinct from v_payload_hash then
      raise exception using errcode = '23505',
        message = 'onboarding_event_payload_mismatch';
    end if;
    if v_exact.kind = 'onboarding_event_alias' then
      if v_exact.readback->>'target_kind' <> 'onboarding_voice_approval' then
        raise exception using errcode = '23505',
          message = 'onboarding_event_payload_mismatch';
      end if;
      select r.* into v_target
      from public.receipts r
      where r.id = (v_exact.readback->>'target_receipt_id')::uuid
        and r.tenant_id = p_tenant
        and r.call_id = p_call
        and r.kind = 'onboarding_voice_approval'
        and r.readback->>'snapshot_receipt_id' =
          v_exact.readback->>'snapshot_receipt_id'
      limit 1;
      if v_target.id is null then
        raise exception using errcode = 'P0002',
          message = 'onboarding_approval_target_missing';
      end if;
      return jsonb_build_object(
        'status', 'reused',
        'approval_receipt_id', v_target.id,
        'coverage_receipt_id', v_exact.readback->>'snapshot_receipt_id',
        'revision', (v_exact.readback->>'snapshot_revision')::integer,
        'snapshot_digest', v_exact.readback->>'snapshot_digest'
      );
    end if;
    return jsonb_build_object(
      'status', 'reused',
      'approval_receipt_id', v_exact.id,
      'coverage_receipt_id', v_exact.readback->>'snapshot_receipt_id',
      'revision', (v_exact.readback->>'snapshot_revision')::integer,
      'snapshot_digest', v_exact.readback->>'snapshot_digest'
    );
  end if;

  v_result := public.record_onboarding_voice_approval_v2_base(
    p_tenant, p_call, p_owner, p_provider_tool_call_id, p_event_key,
    p_expected_revision, p_expected_digest, p_owner_words
  );

  select r.* into v_exact
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind in ('onboarding_voice_approval', 'onboarding_event_alias')
    and r.external_id = p_event_key
  limit 1;
  if v_exact.id is not null then
    if v_exact.payload_hash is distinct from v_payload_hash then
      raise exception using errcode = '23505',
        message = 'onboarding_event_payload_mismatch';
    end if;
    if v_exact.kind = 'onboarding_event_alias' then
      if v_exact.readback->>'target_kind' <> 'onboarding_voice_approval'
         or v_exact.readback->>'target_receipt_id' <>
           v_result->>'approval_receipt_id' then
        raise exception using errcode = '23505',
          message = 'onboarding_event_payload_mismatch';
      end if;
      return jsonb_build_object(
        'status', 'reused',
        'approval_receipt_id', v_exact.readback->>'target_receipt_id',
        'coverage_receipt_id', v_exact.readback->>'snapshot_receipt_id',
        'revision', (v_exact.readback->>'snapshot_revision')::integer,
        'snapshot_digest', v_exact.readback->>'snapshot_digest'
      );
    end if;
    return v_result;
  end if;

  select r.* into v_target
  from public.receipts r
  where r.id = (v_result->>'approval_receipt_id')::uuid
    and r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind = 'onboarding_voice_approval'
    and r.readback->>'snapshot_receipt_id' =
      v_result->>'coverage_receipt_id'
  limit 1;
  if v_target.id is null then
    raise exception using errcode = 'P0002',
      message = 'onboarding_approval_target_missing';
  end if;
  v_alias_readback := jsonb_build_object(
    'schema_version', 2,
    'call_id', p_call,
    'target_kind', 'onboarding_voice_approval',
    'target_receipt_id', v_target.id,
    'approval_receipt_id', v_target.id,
    'snapshot_receipt_id', v_result->>'coverage_receipt_id',
    'snapshot_revision', (v_result->>'revision')::integer,
    'snapshot_digest', v_result->>'snapshot_digest',
    'target_revision', (v_result->>'revision')::integer,
    'target_digest', v_result->>'snapshot_digest',
    'authority', jsonb_build_object(
      'rules_approved', false,
      'powers_granted', false,
      'operational_mode_changed', false
    )
  );
  insert into public.receipts (
    tenant_id, call_id, kind, outcome, external_id, readback, payload_hash,
    detail
  ) values (
    p_tenant, p_call, 'onboarding_event_alias', 'accepted', p_event_key,
    v_alias_readback, v_payload_hash,
    jsonb_build_object(
      'owner_words', p_owner_words,
      'owner_id', p_owner,
      'provider_tool_call_id', p_provider_tool_call_id,
      'target_receipt_id', v_target.id,
      'snapshot_digest', v_result->>'snapshot_digest'
    )
  );
  return jsonb_build_object(
    'status', 'reused',
    'approval_receipt_id', v_target.id,
    'coverage_receipt_id', v_result->>'coverage_receipt_id',
    'revision', (v_result->>'revision')::integer,
    'snapshot_digest', v_result->>'snapshot_digest'
  );
end
$$;

revoke all on function public.record_onboarding_voice_approval_v2_base(
  uuid,uuid,uuid,text,text,integer,text,text
) from public, anon, authenticated, service_role;
revoke all on function public.record_onboarding_voice_approval(
  uuid,uuid,uuid,text,text,integer,text,text
) from public, anon, authenticated;
grant execute on function public.record_onboarding_voice_approval(
  uuid,uuid,uuid,text,text,integer,text,text
) to service_role;
