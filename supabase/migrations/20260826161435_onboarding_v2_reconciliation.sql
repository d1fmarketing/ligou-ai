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

create or replace function public.onboarding_locality_value_v1(
  p_value jsonb
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_display text;
  v_country text;
  v_region text;
  v_key text;
  v_id text;
  v_result jsonb := '[]'::jsonb;
  v_ids text[] := array[]::text[];
  v_states constant text[] := array[
    'alabama','alaska','arizona','arkansas','california','colorado',
    'connecticut','delaware','florida','georgia','hawaii','idaho',
    'illinois','indiana','iowa','kansas','kentucky','louisiana','maine',
    'maryland','massachusetts','michigan','minnesota','mississippi',
    'missouri','montana','nebraska','nevada','new hampshire','new jersey',
    'new mexico','new york','north carolina','north dakota','ohio',
    'oklahoma','oregon','pennsylvania','rhode island','south carolina',
    'south dakota','tennessee','texas','utah','vermont','virginia',
    'washington','west virginia','wisconsin','wyoming'
  ];
  v_regions constant text[] := array[
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN',
    'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV',
    'NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
    'TX','UT','VT','VA','WA','WV','WI','WY','DC'
  ];
begin
  if jsonb_typeof(p_value) <> 'object'
     or (select count(*) from jsonb_object_keys(p_value)) <> 1
     or not (p_value ? 'localities')
     or jsonb_typeof(p_value->'localities') <> 'array'
     or jsonb_array_length(p_value->'localities') = 0 then
    return null;
  end if;
  for v_item in select value from jsonb_array_elements(p_value->'localities')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or (select count(*) from jsonb_object_keys(v_item)) <> 3
       or not (v_item ? 'display_name' and v_item ? 'country_code'
         and v_item ? 'region_code')
       or jsonb_typeof(v_item->'display_name') <> 'string'
       or jsonb_typeof(v_item->'country_code') <> 'string'
       or jsonb_typeof(v_item->'region_code') <> 'string' then
      return null;
    end if;
    v_display := v_item->>'display_name';
    v_country := v_item->>'country_code';
    v_region := v_item->>'region_code';
    if v_display <> regexp_replace(
         v_display, '^[[:space:]]+|[[:space:]]+$', '', 'g'
       )
       or v_country <> 'US'
       or not (v_region = any(v_regions))
       or upper(v_display) = any(v_regions)
       or length(v_display) < 1 or length(v_display) > 100
       or v_display ~ '[0-9]'
       or v_display !~ '^[[:alpha:]][[:alpha:].'' -]*$' then
      return null;
    end if;
    v_key := lower(regexp_replace(v_display, '[[:space:]]+', ' ', 'g'));
    if not (
         (v_display = 'New York' and v_region = 'NY')
         or (v_display = 'Washington' and v_region = 'DC')
       ) and (
         v_key = any(v_states)
         or regexp_replace(v_key, '[^[:alpha:]]', '', 'g') in (
           'unitedstates','unitedstatesofamerica','usa','us','america',
           'canada'
         )
         or v_key in ('state','estado')
         or v_key ~ '(^|[^[:alpha:]])(county|condado|region|regiao|região|province|provincia|província|metropolitan|metro|area|área|zip|cep|postal)([^[:alpha:]]|$)'
         or (
           v_key ~ '^(north(?:ern)?|south(?:ern)?|east(?:ern)?|west(?:ern)?|central) '
           and regexp_replace(v_key, '^[^ ]+ ', '') = any(v_states)
         )
         or (
           v_key ~ '^(state of|estado de) '
           and regexp_replace(v_key, '^(state of|estado de) ', '') = any(v_states)
         )
         or (
           v_key ~ ' (state|estado)$'
           and regexp_replace(v_key, ' (state|estado)$', '') = any(v_states)
         )
       ) then
      return null;
    end if;
    v_id := 'loc_' || substring(encode(extensions.digest(
      convert_to(v_country || ':' || v_region || ':' || v_key, 'UTF8'),
      'sha256'
    ), 'hex') from 1 for 24);
    if v_id = any(v_ids) then return null; end if;
    v_ids := array_append(v_ids, v_id);
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'display_name', v_display,
      'country_code', v_country,
      'region_code', v_region,
      'locality_id', v_id
    ));
  end loop;
  return jsonb_build_object('localities', v_result);
end
$$;

revoke all on function public.onboarding_locality_value_v1(jsonb)
from public, anon, authenticated, service_role;

create or replace function public.onboarding_answer_value_valid_v2(
  p_field text,
  p_value jsonb
) returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_opens text;
  v_closes text;
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
    return public.onboarding_locality_value_v1(p_value) is not null;
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

create or replace function public.onboarding_canonical_json_v1(
  p_value jsonb
) returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result text;
begin
  if jsonb_typeof(p_value) = 'object' then
    select '{' || coalesce(string_agg(
      to_jsonb(key)::text || ':' ||
        public.onboarding_canonical_json_v1(value),
      ',' order by key
    ), '') || '}' into v_result
    from jsonb_each(p_value);
    return v_result;
  elsif jsonb_typeof(p_value) = 'array' then
    select '[' || coalesce(string_agg(
      public.onboarding_canonical_json_v1(value),
      ',' order by ordinal
    ), '') || ']' into v_result
    from jsonb_array_elements(p_value) with ordinality item(value, ordinal);
    return v_result;
  end if;
  return p_value::text;
end
$$;

revoke all on function public.onboarding_canonical_json_v1(jsonb)
from public, anon, authenticated, service_role;

create or replace function public.onboarding_scalar_text_v1(
  p_value jsonb
) returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result text;
begin
  if jsonb_typeof(p_value) = 'string' then
    return nullif(regexp_replace(
      p_value #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'
    ), '');
  elsif jsonb_typeof(p_value) = 'number' then
    return p_value #>> '{}';
  elsif jsonb_typeof(p_value) = 'boolean' then
    return case when (p_value #>> '{}')::boolean then 'sim' else 'não' end;
  elsif jsonb_typeof(p_value) = 'array' then
    select string_agg(public.onboarding_scalar_text_v1(value), ', '
      order by ordinal) into v_result
    from jsonb_array_elements(p_value) with ordinality item(value, ordinal)
    where public.onboarding_scalar_text_v1(value) is not null;
    return v_result;
  elsif jsonb_typeof(p_value) = 'object' then
    select string_agg(public.onboarding_scalar_text_v1(value), ', '
      order by case
        when lower(key) in ('day','days','weekdays') then 0
        when lower(key) in ('open','opens','opening','start','starts') then 1
        when lower(key) in ('close','closes','closing','end','ends') then 2
        else 3
      end, key) into v_result
    from jsonb_each(p_value)
    where public.onboarding_scalar_text_v1(value) is not null;
    return v_result;
  end if;
  return null;
end
$$;

revoke all on function public.onboarding_scalar_text_v1(jsonb)
from public, anon, authenticated, service_role;

create or replace function public.onboarding_cell_text_v1(
  p_field text,
  p_cell jsonb
) returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value jsonb := p_cell->'value';
  v_mode text;
  v_floor text;
begin
  if p_cell->>'state' = 'not_applicable' then return 'Não se aplica'; end if;
  if p_cell->>'state' = 'owner_review_required' then
    return nullif(p_cell->>'safeRestriction', '');
  end if;
  if p_cell->>'state' <> 'answered' then return null; end if;
  if p_field = 'service.price_mode' then
    return case v_value #>> '{}'
      when 'fixed' then 'fixo'
      when 'starting_at' then 'a partir de'
      when 'estimate' then 'estimativa'
      when 'owner_review' then 'revisão do dono'
      else v_value #>> '{}'
    end;
  elsif p_field = 'service.negotiation' then
    v_mode := v_value->>'mode';
    v_floor := v_value->>'floor';
    if v_mode = 'non_negotiable' then
      return case when v_floor is null then 'não negociável'
        else 'não negociável (' || v_floor || ')' end;
    elsif v_mode = 'negotiable' and v_floor is not null then
      return 'mínimo ' || v_floor;
    end if;
    return null;
  elsif p_field = 'service.duration' then
    v_mode := public.onboarding_scalar_text_v1(v_value);
    return case when v_mode is null then null else v_mode || ' minutos' end;
  elsif p_field = 'area.coverage' then
    if jsonb_typeof(v_value->'localities') <> 'array' then return null; end if;
    select string_agg(
      jsonb_extract_path_text(locality::jsonb, 'display_name') || ', ' ||
        jsonb_extract_path_text(locality::jsonb, 'region_code') || ', ' ||
        jsonb_extract_path_text(locality::jsonb, 'country_code'),
      '; ' order by ordinal
    ) into v_mode
    from jsonb_array_elements(v_value->'localities')
      with ordinality item(locality, ordinal);
    return v_mode;
  end if;
  return public.onboarding_scalar_text_v1(v_value);
end
$$;

revoke all on function public.onboarding_cell_text_v1(text,jsonb)
from public, anon, authenticated, service_role;

create or replace function public.onboarding_materialization_v3(
  p_snapshot jsonb,
  p_key text,
  p_revision integer,
  p_call uuid
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_subject text;
  v_fields text[];
  v_field text;
  v_ref text;
  v_cell jsonb;
  v_text_value text;
  v_label text;
  v_text text := '';
  v_fields_object jsonb := '{}'::jsonb;
  v_source_refs text[] := array[]::text[];
  v_owner_fields text[] := array[]::text[];
  v_source_json jsonb;
  v_owner_json jsonb;
  v_incomplete boolean := false;
  v_owner_review boolean := false;
  v_review_ready boolean;
  v_state text;
  v_category text;
  v_scope text;
  v_schema text;
  v_structured jsonb;
  v_semantic_structured jsonb;
  v_semantic jsonb;
  v_hash text;
  v_mode text;
  v_target numeric;
  v_floor numeric;
  v_duration numeric;
  v_negotiation_mode text;
  v_quoteable boolean := false;
  v_negotiable boolean := false;
  v_names jsonb;
  v_name_text text;
  v_area_value jsonb;
  v_area_raw jsonb;
begin
  if p_key like 'service:%' then
    v_subject := substring(p_key from 9);
    if v_subject !~ '^[a-z0-9][a-z0-9_]{0,199}$' then return null; end if;
    v_category := 'preco';
    v_scope := 'servico';
    v_schema := 'ligou.rule.service.v2';
    v_fields := array[
      'service.duration','service.emergency_eligibility','service.escalation',
      'service.inclusions_exclusions','service.materials_parts',
      'service.name_synonyms','service.negotiation','service.price_mode',
      'service.price_target','service.warranty'
    ];
    v_cell := p_snapshot->'cells'->(
      'service:' || v_subject || ':service.price_mode'
    );
    if v_cell->>'state' = 'owner_review_required'
       or (
         v_cell->>'state' = 'answered'
         and v_cell->'value' #>> '{}' in ('estimate','owner_review')
       ) then
      v_fields := array_remove(v_fields, 'service.price_target');
      v_fields := array_remove(v_fields, 'service.negotiation');
    end if;
  else
    v_subject := null;
    case p_key
      when 'domain:business' then
        v_category := 'negocio'; v_scope := 'geral';
        v_schema := 'ligou.rule.business.v2';
        v_fields := array['business.customer_types','business.excluded_work',
          'business.languages_tone'];
      when 'domain:area' then
        v_category := 'area'; v_scope := 'localizacao';
        v_schema := 'ligou.rule.area.v2';
        v_fields := array['area.coverage','area.out_of_area_policy',
          'area.travel_fee'];
      when 'domain:schedule' then
        v_category := 'agenda'; v_scope := 'geral';
        v_schema := 'ligou.rule.schedule.v2';
        v_fields := array['schedule.business_hours','schedule.same_day_lead_time',
          'schedule.capacity_buffer','schedule.reschedule_cancel',
          'schedule.holidays'];
      when 'domain:emergency' then
        v_category := 'emergencia'; v_scope := 'geral';
        v_schema := 'ligou.rule.emergency.v2';
        v_fields := array['emergency.types','emergency.safety_escalation',
          'emergency.after_hours','emergency.fee_authority'];
      when 'domain:policy' then
        v_category := 'politica'; v_scope := 'geral';
        v_schema := 'ligou.rule.policy.v2';
        v_fields := array['policy.payment_estimate','policy.warranty_materials',
          'policy.access_cancellation','policy.complaints_returns'];
      when 'domain:authority' then
        v_category := 'autoridade'; v_scope := 'geral';
        v_schema := 'ligou.rule.authority.v2';
        v_fields := array['authority.quote_price','authority.negotiate_floor',
          'authority.read_calendar','authority.book',
          'authority.reschedule_cancel','authority.charge_fee',
          'authority.emergency','authority.out_of_area'];
      else return null;
    end case;
  end if;

  foreach v_field in array v_fields loop
    v_ref := case when v_subject is null then v_field
      else 'service:' || v_subject || ':' || v_field end;
    v_source_refs := array_append(v_source_refs, v_ref);
    v_cell := p_snapshot->'cells'->v_ref;
    if v_cell is null or coalesce(v_cell->>'state', '') in ('missing','ambiguous')
    then
      v_incomplete := true;
    elsif v_cell->>'state' = 'owner_review_required' then
      v_owner_review := true;
      v_owner_fields := array_append(v_owner_fields, v_field);
    end if;
    v_text_value := public.onboarding_cell_text_v1(v_field, v_cell);
    if v_text_value is not null then
      v_label := case v_field
        when 'business.customer_types' then 'Tipos de clientes'
        when 'business.excluded_work' then 'Serviços excluídos'
        when 'business.languages_tone' then 'Idioma e tom'
        when 'area.coverage' then 'Área atendida'
        when 'area.out_of_area_policy' then 'Pedidos fora da área'
        when 'area.travel_fee' then 'Taxa de deslocamento'
        when 'schedule.business_hours' then 'Horário comercial'
        when 'schedule.same_day_lead_time' then 'Antecedência no mesmo dia'
        when 'schedule.capacity_buffer' then 'Capacidade e intervalo'
        when 'schedule.reschedule_cancel' then 'Remarcação e cancelamento'
        when 'schedule.holidays' then 'Feriados'
        when 'emergency.types' then 'Tipos de emergência'
        when 'emergency.safety_escalation' then 'Orientação de segurança'
        when 'emergency.after_hours' then 'Emergência fora do horário'
        when 'emergency.fee_authority' then 'Taxa de emergência'
        when 'policy.payment_estimate' then 'Pagamento e orçamento'
        when 'policy.warranty_materials' then 'Garantia e materiais'
        when 'policy.access_cancellation' then 'Acesso e cancelamento'
        when 'policy.complaints_returns' then 'Reclamações e retornos'
        when 'authority.quote_price' then 'Autonomia para informar preço'
        when 'authority.negotiate_floor' then 'Autonomia para negociar'
        when 'authority.read_calendar' then 'Autonomia para consultar agenda'
        when 'authority.book' then 'Autonomia para agendar'
        when 'authority.reschedule_cancel' then 'Autonomia para remarcar ou cancelar'
        when 'authority.charge_fee' then 'Autonomia para confirmar taxa'
        when 'authority.emergency' then 'Autonomia em emergência'
        when 'authority.out_of_area' then 'Autonomia fora da área'
        when 'service.name_synonyms' then 'Nomes do serviço'
        when 'service.price_mode' then 'Modo de preço'
        when 'service.price_target' then 'Preço público'
        when 'service.negotiation' then 'Negociação'
        when 'service.duration' then 'Duração'
        when 'service.inclusions_exclusions' then 'Inclusões e exclusões'
        when 'service.materials_parts' then 'Materiais e peças'
        when 'service.warranty' then 'Garantia'
        when 'service.emergency_eligibility' then 'Elegibilidade de emergência'
        when 'service.escalation' then 'Escalonamento'
      end;
      v_text := v_text || case when v_text = '' then '' else ' ' end ||
        v_label || ': ' || v_text_value || '.';
      if v_subject is null then
        v_fields_object := v_fields_object || jsonb_build_object(
          substring(v_field from position('.' in v_field) + 1), v_text_value
        );
      end if;
    end if;
  end loop;

  v_review_ready := not v_incomplete;
  v_state := case when v_incomplete then 'incomplete'
    when v_owner_review then 'owner_review_required' else 'active' end;
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
    into v_source_json from unnest(v_source_refs) value;
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
    into v_owner_json from (
      select distinct value from unnest(v_owner_fields) value
    ) sorted;

  if v_subject is not null then
    v_cell := p_snapshot->'cells'->(
      'service:' || v_subject || ':service.name_synonyms'
    );
    if v_cell->>'state' = 'answered'
       and jsonb_typeof(v_cell->'value') = 'array' then
      select jsonb_agg(to_jsonb(regexp_replace(
        item.value::jsonb #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'
      )) order by ordinal), string_agg(regexp_replace(
        item.value::jsonb #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'
      ), ' / ' order by ordinal)
      into v_names, v_name_text
      from jsonb_array_elements(v_cell->'value')
        with ordinality item(value, ordinal);
    end if;
    if v_names is null or jsonb_array_length(v_names) = 0 then
      v_name_text := replace(v_subject, '_', ' ');
      v_names := jsonb_build_array(v_name_text);
    end if;
    v_text := 'Serviço ' || v_name_text || '.' ||
      case when v_text = '' then '' else ' ' || v_text end;
    v_cell := p_snapshot->'cells'->(
      'service:' || v_subject || ':service.price_mode'
    );
    v_mode := case when v_cell->>'state' = 'answered'
      and v_cell->'value' #>> '{}' in ('fixed','starting_at','estimate','owner_review')
      then v_cell->'value' #>> '{}' else 'owner_review' end;
    v_cell := p_snapshot->'cells'->(
      'service:' || v_subject || ':service.price_target'
    );
    if v_cell->>'state' = 'answered' and jsonb_typeof(v_cell->'value') = 'number'
      then v_target := (v_cell->'value' #>> '{}')::numeric; end if;
    v_cell := p_snapshot->'cells'->(
      'service:' || v_subject || ':service.negotiation'
    );
    if v_cell->>'state' = 'answered' and jsonb_typeof(v_cell->'value') = 'object'
    then
      v_negotiation_mode := v_cell->'value'->>'mode';
      if jsonb_typeof(v_cell->'value'->'floor') = 'number'
        then v_floor := (v_cell->'value'->>'floor')::numeric; end if;
    end if;
    v_cell := p_snapshot->'cells'->(
      'service:' || v_subject || ':service.duration'
    );
    if v_cell->>'state' = 'answered' and jsonb_typeof(v_cell->'value') = 'number'
      then v_duration := (v_cell->'value' #>> '{}')::numeric; end if;
    v_quoteable := v_review_ready and v_state = 'active'
      and v_mode in ('fixed','starting_at')
      and v_target is not null and v_target >= 0
      and v_floor is not null and v_floor >= 0 and v_floor <= v_target
      and (
        v_negotiation_mode = 'negotiable'
        or (
          v_negotiation_mode = 'non_negotiable' and v_floor = v_target
        )
      )
      and v_duration is not null and v_duration > 0;
    v_negotiable := v_quoteable and v_negotiation_mode = 'negotiable';
    if v_mode = 'owner_review' and v_review_ready then
      v_state := 'owner_review_required';
      select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        into v_owner_json from (
          select distinct value from unnest(
            array_append(v_owner_fields, 'service.price_mode')
          ) value
        ) sorted;
    end if;
    v_structured := jsonb_build_object(
      'schema', v_schema,
      'service_type', v_subject,
      'service_names', v_names,
      'price_mode', v_mode,
      'quoteable', v_quoteable,
      'negotiable', v_negotiable,
      'operational_state', v_state,
      'owner_review_fields', v_owner_json,
      'materialization_key', p_key,
      'materialization_eligible', v_review_ready,
      'review_ready', v_review_ready,
      'coverage_revision', p_revision,
      'source_call_id', p_call,
      'source_refs', v_source_json
    );
    if v_negotiation_mode in ('negotiable','non_negotiable') then
      v_structured := v_structured || jsonb_build_object(
        'negotiation_mode', v_negotiation_mode
      );
    end if;
    if v_duration is not null and v_duration > 0 then
      v_structured := v_structured || jsonb_build_object('duration_min', v_duration);
    end if;
    if v_quoteable then
      v_structured := v_structured || jsonb_build_object(
        'price_target', v_target, 'price_min', v_floor
      );
    end if;
    for v_field in select unnest(array[
      'service.inclusions_exclusions','service.warranty','service.escalation'
    ]) loop
      v_cell := p_snapshot->'cells'->(
        'service:' || v_subject || ':' || v_field
      );
      if v_cell->>'state' = 'answered' then
        v_structured := v_structured || jsonb_build_object(
          substring(v_field from position('.' in v_field) + 1), v_cell->'value'
        );
      end if;
    end loop;
    v_cell := p_snapshot->'cells'->(
      'service:' || v_subject || ':service.materials_parts'
    );
    if v_cell->>'state' = 'not_applicable' then
      v_structured := v_structured || jsonb_build_object('materials_parts', null);
    elsif v_cell->>'state' = 'answered' then
      v_structured := v_structured || jsonb_build_object(
        'materials_parts', v_cell->'value'
      );
    end if;
    v_cell := p_snapshot->'cells'->(
      'service:' || v_subject || ':service.emergency_eligibility'
    );
    if v_cell->>'state' = 'answered'
       and jsonb_typeof(v_cell->'value') = 'boolean' then
      v_structured := v_structured || jsonb_build_object(
        'emergency_eligible', v_cell->'value'
      );
    end if;
  else
    v_structured := jsonb_build_object(
      'schema', v_schema,
      'materialization_key', p_key,
      'operational_state', v_state,
      'materialization_eligible', v_review_ready,
      'review_ready', v_review_ready,
      'owner_review_fields', v_owner_json,
      'coverage_revision', p_revision,
      'source_call_id', p_call,
      'source_refs', v_source_json,
      'fields', v_fields_object
    );
    if p_key = 'domain:area' then
      v_cell := p_snapshot->'cells'->'area.coverage';
      if v_cell->>'state' = 'answered' then
        v_area_value := v_cell->'value';
        select jsonb_build_object('localities', jsonb_agg(
          locality::jsonb - 'locality_id' order by ordinal
        )) into v_area_raw
        from jsonb_array_elements(v_area_value->'localities')
          with ordinality item(locality, ordinal);
        if public.onboarding_locality_value_v1(v_area_raw)
             is distinct from v_area_value then
          v_state := 'incomplete'; v_review_ready := false;
          v_structured := v_structured || jsonb_build_object(
            'operational_state', v_state,
            'materialization_eligible', false,
            'review_ready', false
          );
        else
          v_structured := v_structured || jsonb_build_object(
            'coverage_labels', (
              select jsonb_agg(
                jsonb_extract_path_text(locality::jsonb, 'display_name') ||
                  ', ' || jsonb_extract_path_text(locality::jsonb, 'region_code') ||
                  ', ' || jsonb_extract_path_text(locality::jsonb, 'country_code')
                  order by ordinal
              ) from jsonb_array_elements(v_area_value->'localities')
                with ordinality item(locality, ordinal)
            ),
            'localities', v_area_value->'localities'
          );
        end if;
      end if;
    elsif p_key = 'domain:schedule' then
      v_cell := p_snapshot->'cells'->'schedule.business_hours';
      if v_cell->>'state' = 'answered'
         and public.onboarding_answer_value_valid_v2(
           'schedule.business_hours', v_cell->'value'
         ) then
        v_structured := v_structured || jsonb_build_object(
          'business_hours', v_cell->'value'
        );
      elsif v_cell->>'state' = 'answered' then
        v_state := 'incomplete'; v_review_ready := false;
        v_structured := v_structured || jsonb_build_object(
          'operational_state', v_state,
          'materialization_eligible', false,
          'review_ready', false
        );
      end if;
    end if;
  end if;

  v_semantic_structured := v_structured - 'coverage_revision' -
    'materialization_hash';
  v_semantic := jsonb_build_object(
    'key', p_key,
    'category', v_category,
    'scope', v_scope,
    'state', v_state,
    'reviewReady', v_review_ready,
    'text', v_text,
    'structured', v_semantic_structured,
    'sourceRefs', v_source_json
  );
  v_hash := encode(extensions.digest(convert_to(
    public.onboarding_canonical_json_v1(v_semantic), 'UTF8'
  ), 'sha256'), 'hex');
  v_structured := v_structured || jsonb_build_object(
    'materialization_hash', v_hash
  );
  return jsonb_build_object(
    'key', p_key,
    'category', v_category,
    'scope', v_scope,
    'state', v_state,
    'review_ready', v_review_ready,
    'text', v_text,
    'structured', v_structured,
    'source_refs', v_source_json,
    'materialization_hash', v_hash
  );
end
$$;

revoke all on function public.onboarding_materialization_v3(
  jsonb,text,integer,uuid
) from public, anon, authenticated, service_role;

create or replace function public.onboarding_booking_rule_safe(
  p_category text,
  p_scope text,
  p_structured jsonb,
  p_service text,
  p_price numeric
) returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_category is distinct from 'preco'
      or jsonb_typeof(p_structured) is distinct from 'object'
      or p_structured->>'service_type' is distinct from p_service
      or jsonb_typeof(p_structured->'price_min') is distinct from 'number'
      then false
    when p_structured ? 'schema' or p_structured ? 'materialization_key'
      then case
        when p_structured->>'schema' = 'ligou.rule.service.v2'
         and p_structured->>'materialization_key' = 'service:' || p_service
         and p_scope = 'servico'
         and jsonb_typeof(p_structured->'materialization_eligible') = 'boolean'
         and jsonb_typeof(p_structured->'review_ready') = 'boolean'
         and jsonb_typeof(p_structured->'quoteable') = 'boolean'
         and jsonb_typeof(p_structured->'negotiable') = 'boolean'
         and jsonb_typeof(p_structured->'price_target') = 'number'
        then (p_structured->>'materialization_eligible')::boolean
          and (p_structured->>'review_ready')::boolean
          and p_structured->>'operational_state' = 'active'
          and (p_structured->>'quoteable')::boolean
          and p_structured->>'price_mode' in ('fixed', 'starting_at')
          and (
            (
              p_structured->>'negotiation_mode' = 'non_negotiable'
              and not (p_structured->>'negotiable')::boolean
              and (p_structured->>'price_min')::numeric =
                (p_structured->>'price_target')::numeric
            )
            or (
              p_structured->>'negotiation_mode' = 'negotiable'
              and (p_structured->>'negotiable')::boolean
              and (p_structured->>'price_min')::numeric <=
                (p_structured->>'price_target')::numeric
            )
          )
          and p_price >= (p_structured->>'price_min')::numeric
        else false
      end
    else p_price >= (p_structured->>'price_min')::numeric
  end;
$$;

revoke all on function public.onboarding_booking_rule_safe(
  text,text,jsonb,text,numeric
) from public, anon, authenticated, service_role;

-- Retain the predecessor signature only for marker-free legacy callers. Every
-- V2 booking fence below is forward-replaced with the scope-aware overload.
create or replace function public.onboarding_booking_rule_safe(
  p_category text,
  p_structured jsonb,
  p_service text,
  p_price numeric
) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_category = 'preco'
    and jsonb_typeof(p_structured) = 'object'
    and not (p_structured ? 'schema' or p_structured ? 'materialization_key')
    and p_structured->>'service_type' = p_service
    and jsonb_typeof(p_structured->'price_min') = 'number'
    and p_price >= (p_structured->>'price_min')::numeric;
$$;

revoke all on function public.onboarding_booking_rule_safe(
  text,jsonb,text,numeric
) from public, anon, authenticated, service_role;

create or replace function public.authorize_booking_intent(
  p_tenant uuid,
  p_call uuid,
  p_booking uuid,
  p_power uuid,
  p_rule uuid,
  p_confirmed_price numeric,
  p_expected_auth_epoch integer,
  p_expected_policy_epoch integer,
  p_payload jsonb,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
  v_booking public.bookings;
  v_power public.powers;
  v_rule record;
  v_intent public.action_intents;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  select t.* into v_tenant
  from public.tenants t where t.id = p_tenant for update;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_tenant.auth_epoch <> p_expected_auth_epoch
     or v_tenant.policy_epoch <> p_expected_policy_epoch then
    raise exception 'authority_epoch_stale';
  end if;
  select b.* into v_booking
  from public.bookings b
  where b.id = p_booking
    and b.tenant_id = p_tenant
    and b.call_id = p_call
  for update;
  if v_booking.id is null or v_booking.status <> 'proposed' then
    raise exception 'booking_not_authorizable';
  end if;
  select p.* into v_power
  from public.powers p
  where p.id = p_power
    and p.tenant_id = p_tenant
    and p.subject = 'voice_agent'
    and p.capability = 'create_booking'
    and (p.resource = '*' or p.resource = v_booking.service_type)
    and p.revoked_at is null
    and (p.expires_at is null or p.expires_at > now())
  for share;
  if v_power.id is null
     or (v_power.monetary_limit is not null
       and p_confirmed_price > v_power.monetary_limit) then
    raise exception 'referenced_power_not_current';
  end if;
  select er.* into v_rule
  from public.effective_rules er
  where er.id = p_rule
    and er.tenant_id = p_tenant
    and public.onboarding_booking_rule_safe(
      er.category, er.escopo, er.structured,
      v_booking.service_type, p_confirmed_price
    );
  if v_rule.id is null then
    raise exception 'referenced_rule_not_effective';
  end if;
  select ai.* into v_intent
  from public.action_intents ai
  where ai.idempotency_key = p_idempotency_key;
  if v_intent.id is null then
    insert into public.action_intents (
      tenant_id, call_id, booking_id, kind, payload, policy_snapshot,
      idempotency_key, status
    ) values (
      p_tenant, p_call, p_booking, 'calendar_book', p_payload,
      jsonb_build_object(
        'power_id', p_power,
        'rule_id', p_rule,
        'auth_epoch', p_expected_auth_epoch,
        'policy_epoch', p_expected_policy_epoch,
        'price_confirmed', p_confirmed_price,
        'authority_context', v_booking.authority_context
      ),
      p_idempotency_key,
      'queued'
    ) returning * into v_intent;
  elsif v_intent.tenant_id <> p_tenant or v_intent.booking_id <> p_booking then
    raise exception 'idempotency_scope_mismatch';
  end if;
  update public.bookings b
  set intent_id = v_intent.id, price_agreed = p_confirmed_price
  where b.id = p_booking and b.status = 'proposed';
  return jsonb_build_object('id', v_intent.id, 'status', v_intent.status);
end
$$;

revoke all on function public.authorize_booking_intent(
  uuid,uuid,uuid,uuid,uuid,numeric,integer,integer,jsonb,text
) from public, anon, authenticated;
grant execute on function public.authorize_booking_intent(
  uuid,uuid,uuid,uuid,uuid,numeric,integer,integer,jsonb,text
) to service_role;

create or replace function public.validate_booking_intent_authority(
  p_intent uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_intent public.action_intents;
  v_booking public.bookings;
  v_valid boolean;
begin
  select ai.tenant_id into v_tenant_id
  from public.action_intents ai where ai.id = p_intent;
  if v_tenant_id is null then return false; end if;
  perform 1 from public.tenants t where t.id = v_tenant_id for update;
  select ai.* into v_intent
  from public.action_intents ai where ai.id = p_intent for update;
  select b.* into v_booking
  from public.bookings b where b.id = v_intent.booking_id;
  select
    v_intent.status = 'running'
    and exists (
      select 1 from public.tenants t
      where t.id = v_intent.tenant_id
        and t.auth_epoch = (v_intent.policy_snapshot->>'auth_epoch')::integer
        and t.policy_epoch = (v_intent.policy_snapshot->>'policy_epoch')::integer
    )
    and exists (
      select 1 from public.powers p
      where p.id = (v_intent.policy_snapshot->>'power_id')::uuid
        and p.tenant_id = v_intent.tenant_id
        and p.subject = 'voice_agent'
        and p.capability = 'create_booking'
        and (p.resource = '*' or p.resource = v_booking.service_type)
        and p.revoked_at is null
        and (p.expires_at is null or p.expires_at > now())
        and (
          p.monetary_limit is null
          or (v_intent.policy_snapshot->>'price_confirmed')::numeric <=
            p.monetary_limit
        )
    )
    and exists (
      select 1 from public.effective_rules er
      where er.id = (v_intent.policy_snapshot->>'rule_id')::uuid
        and er.tenant_id = v_intent.tenant_id
        and public.onboarding_booking_rule_safe(
          er.category,
          er.escopo,
          er.structured,
          v_booking.service_type,
          (v_intent.policy_snapshot->>'price_confirmed')::numeric
        )
    )
  into v_valid;
  if not coalesce(v_valid, false) then
    update public.action_intents ai set
      status = 'failed',
      last_error = 'authority_stale_before_provider',
      finished_at = now(),
      lease_until = null
    where ai.id = p_intent and ai.status = 'running';
    update public.bookings b set status = 'pending_approval'
    where b.id = v_intent.booking_id and b.status in ('proposed','unknown');
    return false;
  end if;
  return true;
end
$$;

revoke all on function public.validate_booking_intent_authority(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.consume_slot_offer(
  p_tenant uuid,
  p_call uuid,
  p_token_hash text,
  p_expected_auth_epoch integer,
  p_expected_policy_epoch integer,
  p_client_name text,
  p_contact text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
  v_offer public.slot_offers;
  v_quote public.booking_quotes;
  v_booking public.bookings;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  select t.* into v_tenant
  from public.tenants t where t.id = p_tenant for update;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_tenant.auth_epoch <> p_expected_auth_epoch then
    raise exception 'authorization_epoch_stale';
  end if;
  if v_tenant.policy_epoch <> p_expected_policy_epoch then
    raise exception 'policy_epoch_stale';
  end if;
  select so.* into v_offer
  from public.slot_offers so where so.token_hash = p_token_hash for update;
  if v_offer.id is null then raise exception 'slot_offer_not_found'; end if;
  if v_offer.tenant_id <> p_tenant or v_offer.call_id <> p_call then
    raise exception 'slot_offer_scope_mismatch';
  end if;
  if v_offer.expires_at <= now() then raise exception 'slot_offer_expired'; end if;
  if v_offer.consumed_at is not null then raise exception 'slot_offer_consumed'; end if;
  if v_tenant.policy_epoch <> v_offer.policy_epoch then
    raise exception 'slot_offer_policy_stale';
  end if;
  select q.* into v_quote
  from public.booking_quotes q where q.id = v_offer.quote_id for share;
  if v_quote.id is null
     or v_quote.tenant_id <> v_offer.tenant_id
     or v_quote.call_id <> v_offer.call_id
     or v_quote.service_type <> v_offer.service_type
     or v_quote.public_quote <> v_offer.public_quote
     or v_quote.rule_id <> v_offer.rule_id
     or v_quote.policy_epoch <> v_offer.policy_epoch
     or v_quote.expires_at <= now() then
    raise exception 'slot_offer_quote_invalid';
  end if;
  if not exists (
    select 1 from public.powers p
    where p.id = v_offer.power_id
      and p.tenant_id = p_tenant
      and p.subject = 'voice_agent'
      and p.capability = 'create_booking'
      and (p.resource = '*' or p.resource = v_offer.service_type)
      and p.revoked_at is null
      and (p.expires_at is null or p.expires_at > now())
      and (
        p.monetary_limit is null
        or v_offer.public_quote <= p.monetary_limit
      )
  ) then
    raise exception 'slot_offer_power_stale';
  end if;
  if not exists (
    select 1 from public.effective_rules er
    where er.id = v_offer.rule_id
      and er.tenant_id = p_tenant
      and public.onboarding_booking_rule_safe(
        er.category,
        er.escopo,
        er.structured,
        v_offer.service_type,
        v_offer.public_quote
      )
  ) then
    raise exception 'slot_offer_rule_stale';
  end if;
  insert into public.bookings (
    tenant_id, call_id, client_name, contact, service_type, price_agreed,
    slot_start, slot_end, status, idempotency_key, authority_context
  ) values (
    p_tenant,
    p_call,
    nullif(left(p_client_name, 120), ''),
    nullif(left(p_contact, 120), ''),
    v_offer.service_type,
    v_offer.public_quote,
    v_offer.slot_start,
    v_offer.slot_end,
    'proposed',
    v_offer.token_hash,
    jsonb_build_object(
      'geography', v_offer.geography,
      'channel', 'voice',
      'purpose', 'booking',
      'appointment_at', v_offer.slot_start,
      'slot_offer_id', v_offer.id,
      'quote_id', v_offer.quote_id
    )
  ) returning * into v_booking;
  update public.slot_offers so
  set consumed_at = now(), booking_id = v_booking.id
  where so.id = v_offer.id;
  return jsonb_build_object(
    'booking_id', v_booking.id,
    'service_type', v_booking.service_type,
    'public_price', v_booking.price_agreed,
    'slot_start', v_booking.slot_start,
    'slot_end', v_booking.slot_end,
    'geography', v_offer.geography
  );
end
$$;

revoke all on function public.consume_slot_offer(
  uuid,uuid,text,integer,integer,text,text
) from public, anon, authenticated;
grant execute on function public.consume_slot_offer(
  uuid,uuid,text,integer,integer,text,text
) to service_role;

create or replace function public.enforce_slot_offer_private_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.effective_rules er
    where er.id = new.rule_id
      and er.tenant_id = new.tenant_id
      and public.onboarding_booking_rule_safe(
        er.category,
        er.escopo,
        er.structured,
        new.service_type,
        new.public_quote
      )
  ) then
    raise exception 'slot_offer_private_policy_missing_or_denied';
  end if;
  return new;
end
$$;

revoke all on function public.enforce_slot_offer_private_policy()
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
  v_request_id uuid;
  v_existing_event uuid;
  v_expected_value jsonb;
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
    raise exception using errcode = '22023', message = 'onboarding_scope_required';
  end if;
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
  select r.id into v_existing_event
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind in ('onboarding_coverage', 'onboarding_event_alias')
    and r.external_id = p_event_key
  limit 1;
  if v_existing_event is not null then
    return public.record_onboarding_answer_v2_base(
      p_tenant, p_call, p_owner, p_provider_tool_call_id, p_event_key,
      p_answer_hash, p_expected_revision, p_fact, p_rule_group_id, p_coverage
    );
  end if;
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
         and jsonb_typeof(p_coverage->'snapshot'->'services') = 'array'
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
      elsif p_fact->>'field' = 'area.coverage' then
        v_expected_value := public.onboarding_locality_value_v1(v_value);
        if v_expected_value is null
           or v_cell->>'state' <> 'answered'
           or v_cell->'value' is distinct from v_expected_value then
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
    if v_materialization_key is not null
       and v_materialization is distinct from
         public.onboarding_materialization_v3(
           p_coverage->'snapshot', v_materialization_key,
           (p_coverage->>'revision')::integer, p_call
         ) then
      raise exception using errcode = '22023',
        message = 'onboarding_materialization_projection_invalid';
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
