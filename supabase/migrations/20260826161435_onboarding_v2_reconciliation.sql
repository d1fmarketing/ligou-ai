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

-- Application-owned locality membership.  Voice/model text can propose a
-- tuple, but only a unique registry row can mint the stable operational ID.
create table public.onboarding_locality_registry (
  locality_id text primary key
    check (locality_id ~ '^loc_[0-9a-f]{24}$'),
  display_name text not null check (
    display_name = btrim(display_name) and length(display_name) between 1 and 100
  ),
  country_code text not null check (country_code = 'US'),
  region_code text not null check (region_code in (
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN',
    'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV',
    'NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
    'TX','UT','VT','VA','WA','WV','WI','WY','DC'
  )),
  created_at timestamptz not null default now()
);

create unique index onboarding_locality_registry_identity_unique
  on public.onboarding_locality_registry (
    country_code, region_code, lower(display_name)
  );

insert into public.onboarding_locality_registry (
  locality_id, display_name, country_code, region_code
) values
  ('loc_06b5af1ac7ab0ac5ffaa565a', 'Concord', 'US', 'CA'),
  ('loc_d89792846ce09bcbb7667a0a', 'Concord', 'US', 'NH'),
  ('loc_103311f819190c5e34075124', 'Walnut Creek', 'US', 'CA'),
  ('loc_49cae77e3299fdc874706952', 'Pleasant Hill', 'US', 'CA'),
  ('loc_fcc2e7491cf2266b3cc824d5', 'Martinez', 'US', 'CA'),
  ('loc_4bc5a435c3c9a7013a252ae4', 'Anaheim', 'US', 'CA'),
  ('loc_f523ab817485998b9f27a274', 'Santa Ana', 'US', 'CA'),
  ('loc_9971eda617977d43d7df9fd5', 'Irvine', 'US', 'CA'),
  ('loc_1775cd185638a4eb34fa8b78', 'Orange', 'US', 'CA'),
  ('loc_62bcd7af7bfab0878130f238', 'Tustin', 'US', 'CA'),
  ('loc_7a99602020a0ced6f4ceea63', 'Costa Mesa', 'US', 'CA'),
  ('loc_c0f300f553807cd44f5f7ede', 'New York', 'US', 'NY'),
  ('loc_e939e6896203b54b290f9224', 'Washington', 'US', 'DC'),
  ('loc_598cce799aeb20c5d2116b74', 'State College', 'US', 'PA');

create table public.onboarding_locality_aliases (
  alias_normalized text primary key check (
    alias_normalized = lower(regexp_replace(
      btrim(alias_normalized), '[[:space:]]+', ' ', 'g'
    )) and length(alias_normalized) between 1 and 100
  ),
  locality_id text not null references public.onboarding_locality_registry(
    locality_id
  ) on delete restrict,
  created_at timestamptz not null default now()
);

insert into public.onboarding_locality_aliases (
  alias_normalized, locality_id
) values
  ('new york city', 'loc_c0f300f553807cd44f5f7ede'),
  ('nyc', 'loc_c0f300f553807cd44f5f7ede'),
  ('washington dc', 'loc_e939e6896203b54b290f9224'),
  ('washington, dc', 'loc_e939e6896203b54b290f9224');

alter table public.onboarding_locality_registry enable row level security;
alter table public.onboarding_locality_registry force row level security;
revoke all on table public.onboarding_locality_registry
  from public, anon, authenticated, service_role;
grant select on table public.onboarding_locality_registry to service_role;

alter table public.onboarding_locality_aliases enable row level security;
alter table public.onboarding_locality_aliases force row level security;
revoke all on table public.onboarding_locality_aliases
  from public, anon, authenticated, service_role;
grant select on table public.onboarding_locality_aliases to service_role;

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

create or replace function public.onboarding_resolve_locality_v1(
  p_value jsonb
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_display_key text;
  v_country text;
  v_region text;
  v_match_count integer;
  v_match public.onboarding_locality_registry;
  v_result jsonb := '[]'::jsonb;
  v_ids text[] := array[]::text[];
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
    v_display_key := lower(regexp_replace(
      btrim(v_item->>'display_name'), '[[:space:]]+', ' ', 'g'
    ));
    v_country := upper(btrim(v_item->>'country_code'));
    v_region := upper(btrim(v_item->>'region_code'));
    if v_display_key = '' or v_country !~ '^[A-Z]{2}$'
       or v_region !~ '^[A-Z]{2}$' then
      return null;
    end if;
    select count(*) into v_match_count
    from public.onboarding_locality_registry registry
    where registry.country_code = v_country
      and registry.region_code = v_region
      and (
        lower(regexp_replace(
          btrim(registry.display_name), '[[:space:]]+', ' ', 'g'
        )) = v_display_key
        or exists (
          select 1 from public.onboarding_locality_aliases alias
          where alias.locality_id = registry.locality_id
            and alias.alias_normalized = v_display_key
        )
      );
    if v_match_count <> 1 then return null; end if;
    select registry.* into v_match
    from public.onboarding_locality_registry registry
    where registry.country_code = v_country
      and registry.region_code = v_region
      and (
        lower(regexp_replace(
          btrim(registry.display_name), '[[:space:]]+', ' ', 'g'
        )) = v_display_key
        or exists (
          select 1 from public.onboarding_locality_aliases alias
          where alias.locality_id = registry.locality_id
            and alias.alias_normalized = v_display_key
        )
      )
    limit 1;
    if v_match.locality_id = any(v_ids) then return null; end if;
    v_ids := array_append(v_ids, v_match.locality_id);
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'display_name', v_match.display_name,
      'country_code', v_match.country_code,
      'region_code', v_match.region_code,
      'locality_id', v_match.locality_id
    ));
  end loop;
  return jsonb_build_object('localities', v_result);
end
$$;

revoke all on function public.onboarding_resolve_locality_v1(jsonb)
from public, anon, authenticated, service_role;

create or replace function public.onboarding_owner_evidence_normalize_v1(
  p_value text
) returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
    translate(
      lower(coalesce(p_value, '')),
      'áàâãäåéèêëíìîïóòôõöúùûüçñ',
      'aaaaaaeeeeiiiiooooouuuucn'
    ),
    '[^a-z0-9]+', ' ', 'g'
  ));
$$;

revoke all on function public.onboarding_owner_evidence_normalize_v1(text)
from public, anon, authenticated, service_role;

create or replace function public.onboarding_resolve_locality_owner_v2(
  p_value jsonb,
  p_owner_words text,
  p_prior_cell jsonb,
  p_directed_question text
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_label text;
  v_owner_label text;
  v_owner text := public.onboarding_owner_evidence_normalize_v1(
    p_owner_words
  );
  v_proposed jsonb := '[]'::jsonb;
  v_resolved jsonb := '[]'::jsonb;
  v_sorted_resolved jsonb := '[]'::jsonb;
  v_unknown jsonb := '[]'::jsonb;
  v_sorted_unknown jsonb := '[]'::jsonb;
  v_matches jsonb;
  v_selected jsonb;
  v_ambiguity jsonb;
  v_match_count integer;
  v_selected_count integer;
  v_duplicate_count integer;
  v_prior_resolution jsonb;
  v_same_pending boolean;
  v_labels text[];
  v_question text;
begin
  if jsonb_typeof(p_value) <> 'object'
     or (select count(*) from jsonb_object_keys(p_value)) <> 1
     or not (p_value ? 'localities')
     or jsonb_typeof(p_value->'localities') <> 'array'
     or jsonb_array_length(p_value->'localities') = 0 then
    return jsonb_build_object('state', 'unknown', 'unknown', '[]'::jsonb);
  end if;

  for v_item in select value from jsonb_array_elements(p_value->'localities')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or (select count(*) from jsonb_object_keys(v_item)) <> 3
       or not (v_item ? 'display_name' and v_item ? 'country_code'
         and v_item ? 'region_code')
       or jsonb_typeof(v_item->'display_name') <> 'string'
       or jsonb_typeof(v_item->'country_code') <> 'string'
       or jsonb_typeof(v_item->'region_code') <> 'string'
       or btrim(v_item->>'display_name') = '' then
      return jsonb_build_object('state', 'unknown', 'unknown', '[]'::jsonb);
    end if;
    v_proposed := v_proposed || jsonb_build_array(jsonb_build_object(
      'display_name', v_item->>'display_name'
    ));
  end loop;

  if jsonb_typeof(p_prior_cell) = 'object'
     and p_prior_cell->>'state' = 'ambiguous'
     and p_prior_cell->>'reason' =
       'locality_region_owner_evidence_required'
     and jsonb_typeof(p_prior_cell->'value'->'localities') = 'array'
     and jsonb_typeof(p_prior_cell->'candidates') = 'array'
     and jsonb_array_length(p_prior_cell->'candidates') > 1
     and coalesce(p_prior_cell->>'questionPt', '') <> '' then
    v_prior_resolution := jsonb_build_object(
      'state', 'ambiguous',
      'reason', 'locality_region_owner_evidence_required',
      'value', jsonb_build_object(
        'localities', p_prior_cell->'value'->'localities'
      ),
      'candidates', p_prior_cell->'candidates',
      'questionPt', p_prior_cell->>'questionPt'
    );
    select exists (
      select 1
      from jsonb_array_elements(p_prior_cell->'candidates') prior_candidate
      cross join jsonb_array_elements(v_proposed) proposed
      where lower(regexp_replace(
        btrim(prior_candidate->>'display_name'), '[[:space:]]+', ' ', 'g'
      )) = lower(regexp_replace(
        btrim(proposed->>'display_name'), '[[:space:]]+', ' ', 'g'
      ))
    ) into v_same_pending;
    if not coalesce(v_same_pending, false) then
      select coalesce(jsonb_agg(to_jsonb(display_name) order by display_name),
        '[]'::jsonb) into v_sorted_unknown
      from (
        select distinct btrim(value->>'display_name') display_name
        from jsonb_array_elements(v_proposed) proposed(value)
      ) names;
      return jsonb_build_object(
        'state', 'unknown', 'unknown', v_sorted_unknown
      );
    end if;
    if p_directed_question is distinct from p_prior_cell->>'questionPt' then
      return v_prior_resolution;
    end if;
    select count(*), coalesce(jsonb_agg(candidate order by
      candidate->>'display_name', candidate->>'region_code',
      candidate->>'country_code', candidate->>'locality_id'), '[]'::jsonb)
      into v_selected_count, v_selected
    from jsonb_array_elements(p_prior_cell->'candidates') candidate
    where case candidate->>'region_code'
      when 'CA' then
        position(' ca ' in ' ' || v_owner || ' ') > 0
        or position(' california ' in ' ' || v_owner || ' ') > 0
      when 'NH' then
        position(' nh ' in ' ' || v_owner || ' ') > 0
        or position(' new hampshire ' in ' ' || v_owner || ' ') > 0
      else false
    end;
    if v_selected_count <> 1 then return v_prior_resolution; end if;
    select coalesce(jsonb_agg(value order by
      value->>'display_name', value->>'region_code', value->>'country_code',
      value->>'locality_id'), '[]'::jsonb) into v_sorted_resolved
    from jsonb_array_elements(
      p_prior_cell->'value'->'localities' || v_selected
    ) item(value);
    return jsonb_build_object(
      'state', 'resolved',
      'value', jsonb_build_object('localities', v_sorted_resolved)
    );
  end if;

  for v_item in select value from jsonb_array_elements(v_proposed)
  loop
    v_label := lower(regexp_replace(
      btrim(v_item->>'display_name'), '[[:space:]]+', ' ', 'g'
    ));
    v_owner_label := public.onboarding_owner_evidence_normalize_v1(
      v_item->>'display_name'
    );
    if v_owner_label = ''
       or position(' ' || v_owner_label || ' ' in ' ' || v_owner || ' ') = 0
    then
      v_unknown := v_unknown || to_jsonb(btrim(v_item->>'display_name'));
      continue;
    end if;
    select count(*), coalesce(jsonb_agg(jsonb_build_object(
      'locality_id', registry.locality_id,
      'display_name', registry.display_name,
      'country_code', registry.country_code,
      'region_code', registry.region_code
    ) order by registry.display_name, registry.region_code,
      registry.country_code, registry.locality_id), '[]'::jsonb)
      into v_match_count, v_matches
    from public.onboarding_locality_registry registry
    where lower(regexp_replace(
        btrim(registry.display_name), '[[:space:]]+', ' ', 'g'
      )) = v_label
      or exists (
        select 1 from public.onboarding_locality_aliases alias
        where alias.locality_id = registry.locality_id
          and alias.alias_normalized = v_label
      );
    if v_match_count = 0 then
      v_unknown := v_unknown || to_jsonb(btrim(v_item->>'display_name'));
    elsif v_match_count = 1 then
      v_resolved := v_resolved || v_matches;
    else
      select count(*), coalesce(jsonb_agg(candidate order by
        candidate->>'display_name', candidate->>'region_code',
        candidate->>'country_code', candidate->>'locality_id'), '[]'::jsonb)
        into v_selected_count, v_selected
      from jsonb_array_elements(v_matches) candidate
      where case candidate->>'region_code'
        when 'CA' then
          position(' ca ' in ' ' || v_owner || ' ') > 0
          or position(' california ' in ' ' || v_owner || ' ') > 0
        when 'NH' then
          position(' nh ' in ' ' || v_owner || ' ') > 0
          or position(' new hampshire ' in ' ' || v_owner || ' ') > 0
        else false
      end;
      if v_selected_count = 1 then v_resolved := v_resolved || v_selected;
      elsif v_ambiguity is null then v_ambiguity := v_matches;
      end if;
    end if;
  end loop;

  if jsonb_array_length(v_unknown) > 0 then
    select coalesce(jsonb_agg(to_jsonb(value) order by value), '[]'::jsonb)
      into v_sorted_unknown
    from (
      select distinct item #>> '{}' value
      from jsonb_array_elements(v_unknown) item
    ) names;
    return jsonb_build_object(
      'state', 'unknown', 'unknown', v_sorted_unknown
    );
  end if;
  select count(*) - count(distinct value->>'locality_id')
    into v_duplicate_count from jsonb_array_elements(v_resolved) item(value);
  if v_duplicate_count > 0 then
    return jsonb_build_object('state', 'unknown', 'unknown', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(value order by
    value->>'display_name', value->>'region_code', value->>'country_code',
    value->>'locality_id'), '[]'::jsonb) into v_sorted_resolved
  from jsonb_array_elements(v_resolved) item(value);
  if v_ambiguity is not null then
    select array_agg(
      (value->>'display_name') || ', ' || (value->>'region_code') || ', ' ||
        (value->>'country_code')
      order by value->>'display_name', value->>'region_code',
        value->>'country_code', value->>'locality_id'
    ) into v_labels from jsonb_array_elements(v_ambiguity) item(value);
    v_question := 'Você quer dizer ' || case
      when cardinality(v_labels) = 2
        then v_labels[1] || ' ou ' || v_labels[2]
      else array_to_string(v_labels[1:cardinality(v_labels) - 1], ', ') ||
        ' ou ' || v_labels[cardinality(v_labels)]
    end || '?';
    return jsonb_build_object(
      'state', 'ambiguous',
      'reason', 'locality_region_owner_evidence_required',
      'value', jsonb_build_object('localities', v_sorted_resolved),
      'candidates', v_ambiguity,
      'questionPt', v_question
    );
  end if;
  return jsonb_build_object(
    'state', 'resolved',
    'value', jsonb_build_object('localities', v_sorted_resolved)
  );
end
$$;

revoke all on function public.onboarding_resolve_locality_owner_v2(
  jsonb,text,jsonb,text
) from public, anon, authenticated, service_role;

create or replace function public.onboarding_locality_value_v1(
  p_value jsonb
) returns jsonb
language sql
stable
set search_path = ''
as $$
  select public.onboarding_resolve_locality_v1(p_value);
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

create or replace function public.onboarding_cell_semantic_hash_v1(
  p_coverage_key text,
  p_cell jsonb
) returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_cell jsonb;
  v_payload jsonb;
begin
  if coalesce(p_coverage_key, '') = '' or jsonb_typeof(p_cell) <> 'object'
  then return null; end if;
  v_cell := p_cell - 'attempts';
  if p_coverage_key like 'service:%:service.negotiation'
     and v_cell->>'state' = 'answered'
     and v_cell->'value'->>'mode' = 'non_negotiable' then
    v_cell := v_cell || jsonb_build_object(
      'value', jsonb_build_object('mode', 'non_negotiable')
    );
  end if;
  v_payload := jsonb_build_object(
    'coverage_key', p_coverage_key,
    'cell', v_cell
  );
  return encode(extensions.digest(convert_to(
    public.onboarding_canonical_json_v1(v_payload), 'UTF8'
  ), 'sha256'), 'hex');
end
$$;

revoke all on function public.onboarding_cell_semantic_hash_v1(text,jsonb)
from public, anon, authenticated, service_role;

create or replace function public.onboarding_absent_cell_hash_v1(
  p_coverage_key text
) returns text
language sql
stable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(
    public.onboarding_canonical_json_v1(jsonb_build_object(
      'coverage_key', p_coverage_key
    )), 'UTF8'
  ), 'sha256'), 'hex');
$$;

revoke all on function public.onboarding_absent_cell_hash_v1(text)
from public, anon, authenticated, service_role;

create or replace function public.onboarding_snapshot_hashes_v1(
  p_snapshot jsonb
) returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(
    key, public.onboarding_cell_semantic_hash_v1(key, value)
    order by key
  ), '{}'::jsonb)
  from jsonb_each(p_snapshot->'cells');
$$;

revoke all on function public.onboarding_snapshot_hashes_v1(jsonb)
from public, anon, authenticated, service_role;

create or replace function public.onboarding_validate_answer_transition_v2(
  p_prior_readback jsonb,
  p_candidate jsonb,
  p_fact jsonb,
  p_answer_hash text
) returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_prior_schema integer := coalesce(
    (p_prior_readback->>'schema_version')::integer, 0
  );
  v_prior_revision integer := coalesce(
    (p_prior_readback->>'revision')::integer, 0
  );
  v_prior jsonb;
  v_candidate jsonb := p_candidate->'snapshot';
  v_field text := p_fact->>'field';
  v_subject text := nullif(p_fact->>'subject', '');
  v_current_key text;
  v_negotiation_key text;
  v_prior_cell jsonb;
  v_candidate_cell jsonb;
  v_prior_negotiation jsonb;
  v_candidate_negotiation jsonb;
  v_expected_negotiation jsonb;
  v_prior_services jsonb;
  v_new_service boolean := false;
  v_overflow boolean := false;
  v_expected_catalog jsonb;
  v_key text;
  v_value jsonb;
  v_target numeric;
  v_floor numeric;
begin
  if jsonb_typeof(p_candidate) <> 'object'
     or p_candidate->'schema_version' is distinct from '2'::jsonb
     or p_candidate->>'transition_kind' <> 'answer'
     or jsonb_typeof(v_candidate) <> 'object'
     or jsonb_typeof(v_candidate->'cells') <> 'object'
     or jsonb_typeof(v_candidate->'services') <> 'array'
     or jsonb_typeof(v_candidate->'followUps') <> 'number'
     or jsonb_typeof(v_candidate->'followUpGroups') <> 'object'
     or jsonb_typeof(v_candidate->'summaryInvalidated') <> 'boolean'
     or coalesce(p_answer_hash ~ '^[0-9a-f]{64}$', false) = false
     or exists (
       select 1 from jsonb_object_keys(v_candidate) key
       where key not in (
         'tenantId','callId','revision','services','currentSubject','cells',
         'followUps','followUpGroups','summaryInvalidated','catalogOverflow'
       )
     ) then return false;
  end if;
  if (p_candidate->>'revision')::integer <> v_prior_revision + 1
     or (v_candidate->>'revision')::integer <> v_prior_revision + 1 then
    return false;
  end if;

  v_prior := case when v_prior_schema = 2 then p_prior_readback->'snapshot'
    else jsonb_build_object(
      'tenantId', v_candidate->>'tenantId',
      'callId', v_candidate->>'callId',
      'revision', v_prior_revision,
      'services', '[]'::jsonb,
      'cells', '{}'::jsonb,
      'followUps', 0,
      'followUpGroups', '{}'::jsonb,
      'summaryInvalidated', false
    ) end;
  if jsonb_typeof(v_prior) <> 'object'
     or jsonb_typeof(v_prior->'cells') <> 'object'
     or jsonb_typeof(v_prior->'services') <> 'array'
     or v_candidate->>'tenantId' is distinct from v_prior->>'tenantId'
     or v_candidate->>'callId' is distinct from v_prior->>'callId'
     or v_candidate->'followUps' is distinct from v_prior->'followUps'
     or v_candidate->'followUpGroups' is distinct from v_prior->'followUpGroups'
     or (
       coalesce((v_prior->>'summaryInvalidated')::boolean, false)
       and not coalesce((v_candidate->>'summaryInvalidated')::boolean, false)
     ) then return false;
  end if;

  v_current_key := case
    when v_field like 'service.%' and v_field <> 'service.catalog_closure'
      then 'service:' || coalesce(v_subject, '') || ':' || v_field
    else v_field
  end;
  if coalesce(v_current_key, '') = '' then return false; end if;
  v_prior_services := v_prior->'services';
  if v_field like 'service.%' and v_field <> 'service.catalog_closure' then
    if coalesce(v_subject, '') !~ '^[a-z0-9][a-z0-9_]{0,199}$' then
      return false;
    end if;
    v_new_service := not (v_prior_services ? v_subject);
    if v_candidate->>'currentSubject' is distinct from v_subject then
      return false;
    end if;
    if v_new_service then
      v_overflow := jsonb_array_length(v_prior_services) >= 20;
      if v_overflow then
        if v_candidate->'services' is distinct from v_prior_services
           or v_candidate->'cells' is distinct from v_prior->'cells'
           or v_candidate->'catalogOverflow' is distinct from
             jsonb_build_object(
               'services', case
                 when coalesce(
                   v_prior->'catalogOverflow'->'services', '[]'::jsonb
                 ) ? v_subject then coalesce(
                   v_prior->'catalogOverflow'->'services', '[]'::jsonb
                 )
                 else coalesce(
                   v_prior->'catalogOverflow'->'services', '[]'::jsonb
                 ) || jsonb_build_array(v_subject)
               end,
               'safeRestriction',
                 'Não aceitar, precificar ou agendar serviços além dos vinte primeiros autonomamente; encaminhar o catálogo ao dono.',
               'ownerWords', p_fact->>'owner_words'
             )
           or v_candidate->'cells' ? v_current_key
           or public.onboarding_absent_cell_hash_v1(v_current_key)
                is distinct from p_answer_hash then
          return false;
        end if;
        return true;
      else
        if v_candidate->'services' is distinct from
             (v_prior_services || jsonb_build_array(v_subject)) then
          return false;
        end if;
        v_expected_catalog := jsonb_build_object(
          'state', 'missing',
          'attempts', coalesce(
            (v_prior->'cells'->'service.catalog_closure'->>'attempts')::integer,
            0
          )
        );
        if v_candidate->'cells'->'service.catalog_closure'
             is distinct from v_expected_catalog then return false; end if;
      end if;
    elsif v_candidate->'services' is distinct from v_prior_services then
      return false;
    end if;
  else
    if v_candidate->'services' is distinct from v_prior_services
       or v_candidate->'currentSubject'
            is distinct from v_prior->'currentSubject' then
      return false;
    end if;
  end if;
  if v_candidate->'catalogOverflow' is distinct from
       v_prior->'catalogOverflow' then return false; end if;

  if exists (
    select 1 from jsonb_each(v_prior->'cells') prior_cell
    where not (v_candidate->'cells' ? prior_cell.key)
  ) then return false; end if;
  if exists (
    select 1 from jsonb_each(v_candidate->'cells') candidate_cell
    where not (v_prior->'cells' ? candidate_cell.key)
      and candidate_cell.key <> v_current_key
      and not (v_new_service and candidate_cell.key = 'service.catalog_closure')
  ) then return false; end if;

  v_negotiation_key := case when v_field = 'service.price_target'
    then 'service:' || v_subject || ':service.negotiation' else null end;
  for v_key, v_value in select key, value from jsonb_each(v_prior->'cells')
  loop
    if v_key = v_current_key or v_key = v_negotiation_key
       or (v_new_service and v_key = 'service.catalog_closure') then
      continue;
    end if;
    v_candidate_cell := v_candidate->'cells'->v_key;
    if v_candidate_cell is distinct from v_value then return false; end if;
  end loop;

  v_prior_cell := v_prior->'cells'->v_current_key;
  v_candidate_cell := v_candidate->'cells'->v_current_key;
  if jsonb_typeof(v_candidate_cell) <> 'object'
     or coalesce((v_candidate_cell->>'attempts')::integer, -1) <>
       coalesce((v_prior_cell->>'attempts')::integer, 0) + 1
     or public.onboarding_cell_semantic_hash_v1(
       v_current_key, v_candidate_cell
     ) is distinct from p_answer_hash then
    return false;
  end if;

  if v_negotiation_key is not null then
    v_prior_negotiation := v_prior->'cells'->v_negotiation_key;
    v_candidate_negotiation := v_candidate->'cells'->v_negotiation_key;
    if v_prior_negotiation is null then
      if v_candidate_negotiation is not null then return false; end if;
    else
      v_expected_negotiation := v_prior_negotiation;
      if v_prior_negotiation->>'state' = 'answered'
         and v_prior_negotiation->'value'->>'mode' = 'non_negotiable' then
        if v_candidate_cell->>'state' = 'answered'
           and jsonb_typeof(v_candidate_cell->'value') = 'number' then
          v_expected_negotiation := jsonb_set(
            v_prior_negotiation, '{value,floor}',
            v_candidate_cell->'value', true
          );
        else
          v_expected_negotiation := jsonb_build_object(
            'state', 'ambiguous',
            'attempts', (v_prior_negotiation->>'attempts')::integer,
            'reason', 'non_negotiable_requires_public_target'
          );
        end if;
      elsif v_prior_negotiation->>'state' = 'answered'
            and v_prior_negotiation->'value'->>'mode' = 'negotiable'
            and jsonb_typeof(v_prior_negotiation->'value'->'floor') = 'number'
      then
        v_floor := (v_prior_negotiation->'value'->>'floor')::numeric;
        if v_candidate_cell->>'state' <> 'answered'
           or jsonb_typeof(v_candidate_cell->'value') <> 'number' then
          v_expected_negotiation := jsonb_build_object(
            'state', 'ambiguous',
            'attempts', (v_prior_negotiation->>'attempts')::integer,
            'reason', 'negotiation_floor_requires_public_price'
          );
        else
          v_target := (v_candidate_cell->>'value')::numeric;
        end if;
        if v_target is not null and v_floor > v_target then
          v_expected_negotiation := jsonb_build_object(
            'state', 'ambiguous',
            'attempts', (v_prior_negotiation->>'attempts')::integer,
            'reason', 'negotiation_floor_requires_public_price'
          );
        end if;
      end if;
      if v_candidate_negotiation is distinct from v_expected_negotiation then
        return false;
      end if;
    end if;
  end if;
  return true;
exception when others then
  return false;
end
$$;

revoke all on function public.onboarding_validate_answer_transition_v2(
  jsonb,jsonb,jsonb,text
) from public, anon, authenticated, service_role;

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
      or p_scope is distinct from 'servico'
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
  -- Scope-less predecessor callers cannot prove service scope. All current
  -- booking fences use the five-argument overload above.
  select false;
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
  v_prior_cell jsonb;
  v_locality_resolution jsonb;
  v_locality_expected_cell jsonb;
  v_locality_followup_question text;
  v_materialization jsonb;
  v_value_valid boolean;
  v_request_id uuid;
  v_existing_event public.receipts;
  v_existing_target public.receipts;
  v_expected_value jsonb;
  v_latest public.receipts;
  v_latest_rule public.rules;
  v_latest_revision integer;
  v_expected_event_key text;
  v_payload jsonb;
  v_payload_hash text;
  v_revision integer;
  v_rule_id uuid;
  v_rule_group_id uuid;
  v_rule_version integer;
  v_receipt_id uuid;
  v_readback jsonb;
  v_alias_readback jsonb;
  v_snapshot_digest text;
  v_materialization_count integer;
  v_materialization_distinct integer;
  v_selected_base jsonb;
  v_selected_final jsonb;
  v_current_hashes jsonb;
  v_materialization_action text := 'coverage_only';
  v_catalog_overflow boolean := false;
  v_catalog_overflow_repeat boolean := false;
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
  if p_coverage->'schema_version' is not distinct from '2'::jsonb then
    v_payload := jsonb_build_object(
      'schema_version', 2,
      'tenant_id', p_tenant,
      'call_id', p_call,
      'owner_id', p_owner,
      'provider_tool_call_id', p_provider_tool_call_id,
      'event_key', p_event_key,
      'answer_hash', p_answer_hash,
      'expected_revision', p_expected_revision,
      'fact', p_fact,
      'rule_group_id', p_rule_group_id,
      'coverage', p_coverage
    );
    v_payload_hash := encode(extensions.digest(
      convert_to(v_payload::text, 'UTF8'), 'sha256'
    ), 'hex');
  end if;
  select r.* into v_existing_event
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind in ('onboarding_coverage', 'onboarding_event_alias')
    and r.external_id = p_event_key
  limit 1;
  if v_existing_event.id is not null
     and v_existing_event.detail->'transition_schema'
       is not distinct from '2'::jsonb then
    if v_existing_event.payload_hash is distinct from v_payload_hash then
      raise exception using errcode = '23505',
        message = 'onboarding_event_payload_mismatch';
    end if;
    if v_existing_event.kind = 'onboarding_event_alias' then
      select r.* into v_existing_target
      from public.receipts r
      where r.id = (v_existing_event.readback->>'target_receipt_id')::uuid
        and r.tenant_id = p_tenant
        and r.call_id = p_call
        and r.kind = 'onboarding_coverage'
      limit 1;
      if v_existing_target.id is null then
        raise exception using errcode = 'P0002',
          message = 'onboarding_alias_target_missing';
      end if;
      return jsonb_build_object(
        'status', 'reused',
        'rule_id', null,
        'rule_group_id', null,
        'coverage_receipt_id', v_existing_target.id,
        'revision', (v_existing_target.readback->>'revision')::integer,
        'snapshot_digest', v_existing_target.readback->>'snapshot_digest',
        'complete', (v_existing_target.readback->>'complete')::boolean,
        'missing', v_existing_target.readback->'progress'->'missingRequired',
        'ambiguous', v_existing_target.readback->'progress'->'ambiguous',
        'next_action', v_existing_target.readback->'next_action',
        'coverage', v_existing_target.readback
      );
    end if;
    return jsonb_build_object(
      'status', 'reused',
      'rule_id', nullif(v_existing_event.readback->>'rule_id', ''),
      'rule_group_id', nullif(v_existing_event.readback->>'rule_group_id', ''),
      'coverage_receipt_id', v_existing_event.id,
      'revision', (v_existing_event.readback->>'revision')::integer,
      'snapshot_digest', v_existing_event.readback->>'snapshot_digest',
      'complete', (v_existing_event.readback->>'complete')::boolean,
      'missing', v_existing_event.readback->'progress'->'missingRequired',
      'ambiguous', v_existing_event.readback->'progress'->'ambiguous',
      'next_action', v_existing_event.readback->'next_action',
      'coverage', v_existing_event.readback
    );
  elsif v_existing_event.id is not null then
    return public.record_onboarding_answer_v2_base(
      p_tenant, p_call, p_owner, p_provider_tool_call_id, p_event_key,
      p_answer_hash, p_expected_revision, p_fact, p_rule_group_id, p_coverage
    );
  end if;
  if p_coverage->'schema_version' is not distinct from '2'::jsonb then
    v_expected_event_key := encode(extensions.digest(convert_to(
      'ligou.v0_2.onboarding_answer:v1:' || p_tenant::text || ':' ||
        p_call::text || ':' || p_provider_tool_call_id,
      'UTF8'
    ), 'sha256'), 'hex');
    if p_event_key is distinct from v_expected_event_key
       or coalesce(p_answer_hash ~ '^[0-9a-f]{64}$', false) = false
       or p_expected_revision is null or p_expected_revision < 0 then
      raise exception using errcode = '22023',
        message = 'onboarding_hash_or_event_invalid';
    end if;
    v_payload := jsonb_build_object(
      'schema_version', 2,
      'tenant_id', p_tenant,
      'call_id', p_call,
      'owner_id', p_owner,
      'provider_tool_call_id', p_provider_tool_call_id,
      'event_key', p_event_key,
      'answer_hash', p_answer_hash,
      'expected_revision', p_expected_revision,
      'fact', p_fact,
      'rule_group_id', p_rule_group_id,
      'coverage', p_coverage
    );
    v_payload_hash := encode(extensions.digest(
      convert_to(v_payload::text, 'UTF8'), 'sha256'
    ), 'hex');
    select r.* into v_latest
    from public.receipts r
    where r.tenant_id = p_tenant
      and r.call_id = p_call
      and r.kind = 'onboarding_coverage'
    order by (r.readback->>'revision')::integer desc,
      r.created_at desc, r.id desc
    limit 1;
    v_latest_revision := coalesce(
      (v_latest.readback->>'revision')::integer, 0
    );
    if v_latest_revision <> p_expected_revision then
      raise exception using errcode = '40001',
        message = 'onboarding_revision_changed';
    end if;
    if v_latest.readback->'schema_version' = '2'::jsonb
       and v_latest.detail->'transition_schema' is not distinct from '2'::jsonb
       and v_latest.readback->'current_answer_hashes' is distinct from
         public.onboarding_snapshot_hashes_v1(v_latest.readback->'snapshot')
    then
      raise exception using errcode = '22023',
        message = 'onboarding_snapshot_transition_invalid';
    end if;
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
    v_catalog_overflow := p_fact->>'field' like 'service.%'
      and p_fact->>'field' <> 'service.catalog_closure'
      and v_latest.readback->'schema_version' = '2'::jsonb
      and not (
        v_latest.readback->'snapshot'->'services' ? (p_fact->>'subject')
      )
      and jsonb_array_length(
        v_latest.readback->'snapshot'->'services'
      ) >= 20;
    v_catalog_overflow_repeat := v_catalog_overflow and coalesce(
      v_latest.readback->'snapshot'->'catalogOverflow'->'services',
      '[]'::jsonb
    ) ? (p_fact->>'subject');
    if v_catalog_overflow then v_materialization_key := null; end if;
    v_cell := p_coverage->'snapshot'->'cells'->v_coverage_key;
    v_value := p_fact->'structured'->'value';
    v_value_valid := false;

    if v_catalog_overflow then
      v_value_valid := false;
    elsif p_fact->>'disposition' = 'answered' then
      if p_fact->>'field' = 'area.coverage' then
        v_prior_cell := case
          when v_latest.readback->'schema_version' = '2'::jsonb
            then v_latest.readback->'snapshot'->'cells'->'area.coverage'
          else null
        end;
        v_locality_followup_question := case
          when v_latest.readback->'schema_version' = '2'::jsonb
           and v_latest.readback->>'transition_kind' = 'directed_followup'
           and v_latest.detail->>'transition_kind' = 'directed_followup'
           and v_latest.detail->'transition_schema' is not distinct from
             '2'::jsonb
           and v_latest.detail->>'field' = 'area.coverage'
           and coalesce(v_latest.detail->>'subject', '') = ''
           and coalesce(v_latest.detail->>'source_revision' ~
             '^[1-9][0-9]*$', false)
           and (v_latest.detail->>'source_revision')::integer + 1 =
             (v_latest.readback->>'revision')::integer
           and coalesce(v_latest.detail->>'source_digest' ~
             '^[0-9a-f]{64}$', false)
           and coalesce(v_latest.detail->>'question_pt', '') =
             coalesce(v_prior_cell->>'questionPt', '')
           and coalesce(
             (v_latest.readback->'snapshot'->'followUpGroups'
               ->>'area.coverage')::integer,
             0
           ) > 0
            then v_latest.detail->>'question_pt'
          else null
        end;
        v_locality_resolution :=
          public.onboarding_resolve_locality_owner_v2(
            v_value,
            p_fact->>'owner_words',
            v_prior_cell,
            v_locality_followup_question
          );
        v_value_valid := v_locality_resolution->>'state' = 'resolved';
        v_locality_expected_cell := case v_locality_resolution->>'state'
          when 'resolved' then jsonb_build_object(
            'state', 'answered',
            'attempts', coalesce((v_prior_cell->>'attempts')::integer, 0) + 1,
            'value', v_locality_resolution->'value'
          )
          when 'ambiguous' then v_locality_resolution || jsonb_build_object(
            'attempts', coalesce((v_prior_cell->>'attempts')::integer, 0) + 1
          )
          when 'unknown' then jsonb_build_object(
            'state', 'owner_review_required',
            'attempts', coalesce((v_prior_cell->>'attempts')::integer, 0) + 1,
            'safeRestriction',
              'Não executar nem confirmar área atendida autonomamente; encaminhar a decisão ao dono.'
          )
          else null
        end;
        if v_locality_expected_cell is null
           or v_cell is distinct from v_locality_expected_cell then
          raise exception using errcode = '22023',
            message = 'onboarding_structured_projection_invalid';
        end if;
      else
        v_value_valid := public.onboarding_answer_value_valid_v2(
          p_fact->>'field', v_value
        );
        if not v_value_valid then
        if p_fact->>'field' = 'area.coverage'
           and public.onboarding_locality_value_v1(v_value) is null
           and v_cell->>'state' = 'owner_review_required'
           and v_cell->>'safeRestriction' =
             'Não executar nem confirmar área atendida autonomamente; encaminhar a decisão ao dono.'
        then
          null;
        elsif coalesce(v_cell->>'state', '') not in ('ambiguous', 'missing') then
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
          v_expected_value := jsonb_extract_path(
            p_coverage->'snapshot'->'cells',
            'service:' || (p_fact->>'subject') || ':service.price_target'
          );
          if v_expected_value->>'state' = 'answered'
             and jsonb_typeof(v_expected_value->'value') = 'number' then
            if v_cell->>'state' <> 'answered'
               or v_cell->'value' is distinct from jsonb_build_object(
                 'mode', 'non_negotiable',
                 'floor', v_expected_value->'value'
               ) then
              raise exception using errcode = '22023',
                message = 'onboarding_structured_projection_invalid';
            end if;
          elsif v_cell is distinct from jsonb_build_object(
            'state', 'ambiguous',
            'attempts', coalesce((v_cell->>'attempts')::integer, 1),
            'reason', 'non_negotiable_requires_public_target'
          ) then
            raise exception using errcode = '22023',
              message = 'onboarding_structured_projection_invalid';
          end if;
        else
          v_expected_value := jsonb_extract_path(
            p_coverage->'snapshot'->'cells',
            'service:' || (p_fact->>'subject') || ':service.price_target'
          );
          if v_expected_value->>'state' = 'answered'
             and jsonb_typeof(v_expected_value->'value') = 'number'
             and (v_value->>'floor')::numeric <=
               (v_expected_value->>'value')::numeric then
            if v_cell->>'state' <> 'answered'
               or v_cell->'value' is distinct from jsonb_build_object(
                 'mode', 'negotiable', 'floor', v_value->'floor'
               ) then
              raise exception using errcode = '22023',
                message = 'onboarding_structured_projection_invalid';
            end if;
          elsif v_cell->>'state' <> 'ambiguous'
                or v_cell->>'reason' <>
                  'negotiation_floor_requires_public_price' then
            raise exception using errcode = '22023',
              message = 'onboarding_structured_projection_invalid';
          end if;
        end if;
      elsif v_cell->>'state' <> 'answered'
            or v_cell->'value' is distinct from v_value then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
        end if;
      end if;
    elsif p_fact->>'disposition' = 'owner_review_required' then
      if coalesce(v_cell->>'state', '') not in (
        'owner_review_required', 'ambiguous', 'missing'
      ) then
        raise exception using errcode = '22023',
          message = 'onboarding_structured_projection_invalid';
      end if;
    elsif p_fact->>'field' = 'service.negotiation' then
      v_expected_value := jsonb_extract_path(
        p_coverage->'snapshot'->'cells',
        'service:' || (p_fact->>'subject') || ':service.price_target'
      );
      if v_expected_value->>'state' = 'answered'
         and jsonb_typeof(v_expected_value->'value') = 'number' then
        if v_cell->>'state' <> 'answered'
           or v_cell->'value' is distinct from jsonb_build_object(
             'mode', 'non_negotiable', 'floor', v_expected_value->'value'
           ) then
          raise exception using errcode = '22023',
            message = 'onboarding_structured_projection_invalid';
        end if;
      elsif v_cell->>'state' <> 'ambiguous'
            or v_cell->>'reason' <> 'non_negotiable_requires_public_target'
      then
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
    if not public.onboarding_validate_answer_transition_v2(
      v_latest.readback, p_coverage, p_fact, p_answer_hash
    ) then
      raise exception using errcode = '22023',
        message = 'onboarding_snapshot_transition_invalid';
    end if;

    if p_rule_group_id is not null
       or p_coverage->>'transition_kind' <> 'answer'
       or p_coverage->>'tenant_id' is distinct from p_tenant::text
       or p_coverage->>'call_id' is distinct from p_call::text
       or jsonb_typeof(p_coverage->'complete') <> 'boolean'
       or jsonb_typeof(p_coverage->'progress') <> 'object'
       or jsonb_typeof(p_coverage->'selected_rule_ids') <> 'array'
       or jsonb_typeof(p_coverage->'next_action') <> 'object'
       or jsonb_typeof(p_coverage->'current_answer_hashes') <> 'object'
       or p_coverage->'authority' is distinct from jsonb_build_object(
         'rules_approved', false,
         'powers_granted', false,
         'operational_mode_changed', false
       ) then
      raise exception using errcode = '22023',
        message = 'onboarding_coverage_shape_invalid';
    end if;
    v_revision := (p_coverage->>'revision')::integer;
    if v_revision <> p_expected_revision + 1
       or jsonb_typeof(p_coverage->'progress'->'missingRequired') <> 'array'
       or jsonb_typeof(p_coverage->'progress'->'ambiguous') <> 'array'
       or (
         (p_coverage->>'complete')::boolean
         and (
           jsonb_typeof(p_coverage->'summary_projection') <> 'object'
           or coalesce(p_coverage->>'summary_hash' ~ '^[0-9a-f]{64}$', false) = false
           or p_coverage->>'summary_hash' <>
             p_coverage->'summary_projection'->>'summaryHash'
         )
       )
       or (
         not (p_coverage->>'complete')::boolean
         and (
           p_coverage->'summary_projection' is distinct from 'null'::jsonb
           or p_coverage->'summary_hash' is distinct from 'null'::jsonb
         )
       ) then
      raise exception using errcode = '22023',
        message = 'onboarding_coverage_projection_invalid';
    end if;

    select count(*), count(distinct item->>'key')
      into v_materialization_count, v_materialization_distinct
    from jsonb_array_elements(p_coverage->'materializations') item;
    if v_materialization_count <> v_materialization_distinct
       or exists (
         select 1 from jsonb_array_elements(
           p_coverage->'materializations'
         ) item
         where item is distinct from public.onboarding_materialization_v3(
           p_coverage->'snapshot', item->>'key', v_revision, p_call
         )
       ) then
      raise exception using errcode = '22023',
        message = 'onboarding_materializations_invalid';
    end if;

    v_rule_group_id := case when v_materialization_key is null then null
      else (md5(
        'ligou.rule.materialization.v2:' || p_tenant::text || ':' ||
        v_materialization_key
      ))::uuid end;
    if exists (
      select 1 from jsonb_array_elements_text(
        p_coverage->'selected_rule_ids'
      ) selected(value)
      where selected.value !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then
      raise exception using errcode = '22023',
        message = 'onboarding_selected_rules_invalid';
    end if;
    select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
      into v_selected_base
    from jsonb_array_elements_text(
      case when v_latest.readback->'schema_version' = '2'::jsonb
        then coalesce(v_latest.readback->'selected_rule_ids', '[]'::jsonb)
        else '[]'::jsonb end
    ) selected(value)
    left join public.rules selected_rule
      on selected_rule.id = selected.value::uuid
     and selected_rule.tenant_id = p_tenant
    where v_rule_group_id is null
       or selected_rule.rule_group_id is distinct from v_rule_group_id;
    if p_coverage->'selected_rule_ids' is distinct from v_selected_base then
      raise exception using errcode = '22023',
        message = 'onboarding_selected_rules_invalid';
    end if;

    v_current_hashes := public.onboarding_snapshot_hashes_v1(
      p_coverage->'snapshot'
    );
    if not v_catalog_overflow
       and v_current_hashes->>v_coverage_key is distinct from p_answer_hash then
      raise exception using errcode = '22023',
        message = 'onboarding_current_answer_hashes_invalid';
    end if;

    if v_catalog_overflow_repeat then
      v_alias_readback := v_latest.readback || jsonb_build_object(
        'schema_version', 2,
        'target_kind', 'onboarding_coverage',
        'target_receipt_id', v_latest.id,
        'target_revision', (v_latest.readback->>'revision')::integer,
        'target_digest', v_latest.readback->>'snapshot_digest',
        'alias_target_receipt_id', v_latest.id,
        'rule_id', null,
        'rule_group_id', null
      );
      insert into public.receipts (
        tenant_id, call_id, kind, outcome, external_id, readback,
        payload_hash, detail
      ) values (
        p_tenant, p_call, 'onboarding_event_alias', 'accepted', p_event_key,
        v_alias_readback, v_payload_hash,
        jsonb_build_object(
          'transition_schema', 2,
          'answer_hash', p_answer_hash,
          'provider_tool_call_id', p_provider_tool_call_id,
          'fact', p_fact,
          'coverage_key', v_coverage_key,
          'target_receipt_id', v_latest.id,
          'browser_request_id', v_request_id
        )
      );
      return jsonb_build_object(
        'status', 'reused',
        'rule_id', null,
        'rule_group_id', null,
        'coverage_receipt_id', v_latest.id,
        'revision', (v_latest.readback->>'revision')::integer,
        'snapshot_digest', v_latest.readback->>'snapshot_digest',
        'complete', (v_latest.readback->>'complete')::boolean,
        'missing', v_latest.readback->'progress'->'missingRequired',
        'ambiguous', v_latest.readback->'progress'->'ambiguous',
        'next_action', v_latest.readback->'next_action',
        'coverage', v_latest.readback
      );
    end if;

    -- Alias only when the durable cell itself is semantically identical.
    -- The predecessor hash map is evidence, never authority for this decision.
    if not v_catalog_overflow
       and v_latest.id is not null
       and v_latest.readback->'schema_version' = '2'::jsonb
       and public.onboarding_cell_semantic_hash_v1(
         v_coverage_key,
         v_latest.readback->'snapshot'->'cells'->v_coverage_key
       ) = p_answer_hash
       and v_current_hashes is not distinct from
         public.onboarding_snapshot_hashes_v1(v_latest.readback->'snapshot')
       and (
         p_fact->>'field' <> 'service.price_target'
         or jsonb_extract_path(
           p_coverage->'snapshot'->'cells',
           'service:' || (p_fact->>'subject') || ':service.negotiation'
         ) is not distinct from jsonb_extract_path(
           v_latest.readback->'snapshot'->'cells',
           'service:' || (p_fact->>'subject') || ':service.negotiation'
         )
       )
       and (
         p_fact->>'field' <> 'service.negotiation'
         or (
           jsonb_extract_path(
             p_coverage->'snapshot'->'cells', v_coverage_key
           ) - 'attempts'
         ) is not distinct from (
           jsonb_extract_path(
             v_latest.readback->'snapshot'->'cells', v_coverage_key
           ) - 'attempts'
         )
       ) then
      v_alias_readback := v_latest.readback || jsonb_build_object(
        'schema_version', 2,
        'target_kind', 'onboarding_coverage',
        'target_receipt_id', v_latest.id,
        'target_revision', (v_latest.readback->>'revision')::integer,
        'target_digest', v_latest.readback->>'snapshot_digest',
        'alias_target_receipt_id', v_latest.id,
        'rule_id', null,
        'rule_group_id', null
      );
      insert into public.receipts (
        tenant_id, call_id, kind, outcome, external_id, readback,
        payload_hash, detail
      ) values (
        p_tenant, p_call, 'onboarding_event_alias', 'accepted', p_event_key,
        v_alias_readback, v_payload_hash,
        jsonb_build_object(
          'transition_schema', 2,
          'answer_hash', p_answer_hash,
          'provider_tool_call_id', p_provider_tool_call_id,
          'fact', p_fact,
          'coverage_key', v_coverage_key,
          'target_receipt_id', v_latest.id,
          'browser_request_id', v_request_id
        )
      );
      return jsonb_build_object(
        'status', 'reused',
        'rule_id', null,
        'rule_group_id', null,
        'coverage_receipt_id', v_latest.id,
        'revision', (v_latest.readback->>'revision')::integer,
        'snapshot_digest', v_latest.readback->>'snapshot_digest',
        'complete', (v_latest.readback->>'complete')::boolean,
        'missing', v_latest.readback->'progress'->'missingRequired',
        'ambiguous', v_latest.readback->'progress'->'ambiguous',
        'next_action', v_latest.readback->'next_action',
        'coverage', v_latest.readback
      );
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      'ligou.v0_2.rules_versioning:' || p_tenant::text, 0
    ));
    if v_rule_group_id is not null then
      select r.* into v_latest_rule
      from public.rules r
      where r.tenant_id = p_tenant
        and r.rule_group_id = v_rule_group_id
      order by r.version desc, r.created_at desc, r.id desc
      limit 1;
      v_rule_version := coalesce(v_latest_rule.version, 0) + 1;
      if (v_materialization->>'review_ready')::boolean then
        insert into public.rules (
          tenant_id, rule_group_id, version, origem, escopo, status,
          category, text, structured, evidence_quote, related_call_id
        ) values (
          p_tenant, v_rule_group_id, v_rule_version, 'onboarding',
          v_materialization->>'scope', 'sugerido',
          v_materialization->>'category', v_materialization->>'text',
          v_materialization->'structured', p_fact->>'owner_words', p_call
        ) returning id into v_rule_id;
        v_materialization_action := 'suggested';
      elsif v_latest_rule.id is not null then
        insert into public.rules (
          tenant_id, rule_group_id, version, origem, escopo, status,
          category, text, structured, evidence_quote, related_call_id
        ) values (
          p_tenant, v_rule_group_id, v_rule_version, 'onboarding',
          v_materialization->>'scope', 'rejeitado',
          v_materialization->>'category',
          coalesce(nullif(v_materialization->>'text', ''),
            'Materialização incompleta; revisão necessária.'),
          v_materialization->'structured', p_fact->>'owner_words', p_call
        ) returning id into v_rule_id;
        v_materialization_action := 'rejected_tombstone';
      end if;
    end if;
    select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
      into v_selected_final
    from (
      select value from jsonb_array_elements_text(v_selected_base) item(value)
      union all
      select v_rule_id::text where v_materialization_action = 'suggested'
    ) selected;
    v_readback := (p_coverage - 'snapshot_digest') || jsonb_build_object(
      'schema_version', 2,
      'transition_kind', 'answer',
      'tenant_id', p_tenant,
      'call_id', p_call,
      'revision', v_revision,
      'rule_id', v_rule_id,
      'rule_group_id', v_rule_group_id,
      'materialization_action', v_materialization_action,
      'selected_rule_ids', v_selected_final,
      'current_answer_hashes', v_current_hashes,
      'authority', jsonb_build_object(
        'rules_approved', false,
        'powers_granted', false,
        'operational_mode_changed', false
      )
    );
    v_snapshot_digest := encode(extensions.digest(
      convert_to(v_readback::text, 'UTF8'), 'sha256'
    ), 'hex');
    v_readback := v_readback || jsonb_build_object(
      'snapshot_digest', v_snapshot_digest
    );
    insert into public.receipts (
      tenant_id, call_id, kind, outcome, external_id, readback,
      payload_hash, detail
    ) values (
      p_tenant, p_call, 'onboarding_coverage', 'accepted', p_event_key,
      v_readback, v_payload_hash,
      jsonb_build_object(
        'transition_kind', 'answer',
        'transition_schema', 2,
        'source_revision', p_expected_revision,
        'source_digest', v_latest.readback->>'snapshot_digest',
        'answer_hash', p_answer_hash,
        'provider_tool_call_id', p_provider_tool_call_id,
        'fact', p_fact,
        'coverage_key', v_coverage_key,
        'materialization_key', v_materialization_key,
        'materialization_action', v_materialization_action,
        'rule_id', v_rule_id,
        'rule_group_id', v_rule_group_id,
        'browser_request_id', v_request_id
      )
    ) returning id into v_receipt_id;
    return jsonb_build_object(
      'status', 'recorded',
      'rule_id', v_rule_id,
      'rule_group_id', v_rule_group_id,
      'coverage_receipt_id', v_receipt_id,
      'revision', v_revision,
      'snapshot_digest', v_snapshot_digest,
      'complete', (v_readback->>'complete')::boolean,
      'missing', v_readback->'progress'->'missingRequired',
      'ambiguous', v_readback->'progress'->'ambiguous',
      'next_action', v_readback->'next_action',
      'coverage', v_readback
    );
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
  if v_global_count >= 256 then
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
