-- Fix A: durable directed interview progress, current-relative answer aliases,
-- and server-owned composite operational materializations. Existing schema-v1
-- callers remain rollback-callable through the unchanged answer signature.

alter table public.receipts drop constraint if exists receipts_kind_check;
alter table public.receipts add constraint receipts_kind_check check (
  kind in (
    'booking', 'booking_cancel', 'rule_change', 'power_change', 'notification',
    'onboarding_coverage', 'onboarding_voice_approval',
    'onboarding_event_alias'
  )
);

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
        and readback->>'target_kind' = 'onboarding_coverage'
        and coalesce(
          readback->>'target_receipt_id' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
        and coalesce(readback->>'target_revision' ~ '^[1-9][0-9]*$', false)
        and coalesce(readback->>'target_digest' ~ '^[0-9a-f]{64}$', false)
        and coalesce(detail->>'target_receipt_id' = readback->>'target_receipt_id', false)
      )
    )
  )
) not valid;
alter table public.receipts
  validate constraint receipts_onboarding_shape_check;

drop index if exists public.receipts_onboarding_event_key_unique;
create unique index receipts_onboarding_event_key_unique
  on public.receipts (tenant_id, external_id)
  where kind in (
    'onboarding_coverage',
    'onboarding_voice_approval',
    'onboarding_event_alias'
  );

drop index if exists public.receipts_onboarding_answer_hash_unique;
create index receipts_onboarding_answer_hash_lookup
  on public.receipts (tenant_id, call_id, (detail->>'answer_hash'))
  where kind = 'onboarding_coverage' and detail ? 'answer_hash';

-- Strict legacy pricing compatibility accepts only a numeric floor. V2 adds
-- explicit eligibility, review readiness, active state, and quoteability.
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
  select case
    when p_category is distinct from 'preco'
      or jsonb_typeof(p_structured) is distinct from 'object'
      or p_structured->>'service_type' is distinct from p_service
      or jsonb_typeof(p_structured->'price_min') is distinct from 'number'
      then false
    when p_structured->>'schema' = 'ligou.rule.service.v2'
      then case
        when jsonb_typeof(p_structured->'materialization_eligible') = 'boolean'
         and jsonb_typeof(p_structured->'review_ready') = 'boolean'
         and jsonb_typeof(p_structured->'quoteable') = 'boolean'
        then (p_structured->>'materialization_eligible')::boolean
          and (p_structured->>'review_ready')::boolean
          and p_structured->>'operational_state' = 'active'
          and (p_structured->>'quoteable')::boolean
          and p_structured->>'price_mode' in ('fixed', 'starting_at')
          and p_price >= (p_structured->>'price_min')::numeric
        else false
      end
    else p_price >= (p_structured->>'price_min')::numeric
  end;
$$;
revoke all on function public.onboarding_booking_rule_safe(text,jsonb,text,numeric)
  from public, anon, authenticated, service_role;

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
  v_schema_version integer;
  v_request_id uuid;
  v_expected_event_key text;
  v_payload jsonb;
  v_payload_hash text;
  v_existing public.receipts;
  v_latest public.receipts;
  v_prior_rule public.rules;
  v_latest_rule public.rules;
  v_latest_revision integer;
  v_revision integer;
  v_rule_id uuid;
  v_rule_group_id uuid;
  v_rule_version integer;
  v_receipt_id uuid;
  v_readback jsonb;
  v_alias_readback jsonb;
  v_snapshot_digest text;
  v_coverage_key text;
  v_materialization_key text;
  v_materialization jsonb;
  v_materialization_count integer;
  v_materialization_distinct integer;
  v_selected_base jsonb;
  v_selected_final jsonb;
  v_current_hashes jsonb;
  v_materialization_action text := 'coverage_only';
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_tenant is null or p_call is null or p_owner is null then
    raise exception using errcode = '22023', message = 'onboarding_scope_required';
  end if;
  if p_provider_tool_call_id is null
     or length(btrim(p_provider_tool_call_id)) < 1
     or length(p_provider_tool_call_id) > 255 then
    raise exception using errcode = '22023', message = 'onboarding_provider_tool_call_id_invalid';
  end if;
  if p_event_key is null or p_event_key !~ '^[0-9a-f]{64}$'
     or p_answer_hash is null or p_answer_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'onboarding_hash_invalid';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'onboarding_expected_revision_invalid';
  end if;
  if jsonb_typeof(p_coverage) is distinct from 'object'
     or coalesce(p_coverage->>'schema_version', '') !~ '^[12]$' then
    raise exception using errcode = '22023', message = 'onboarding_coverage_shape_invalid';
  end if;
  v_schema_version := (p_coverage->>'schema_version')::integer;

  v_expected_event_key := encode(extensions.digest(convert_to(
    'ligou.v0_2.onboarding_answer:v1:' || p_tenant::text || ':' ||
      p_call::text || ':' || p_provider_tool_call_id,
    'UTF8'
  ), 'sha256'), 'hex');
  if p_event_key <> v_expected_event_key then
    raise exception using errcode = '22023', message = 'onboarding_event_key_mismatch';
  end if;

  if jsonb_typeof(p_fact) is distinct from 'object'
     or coalesce(p_fact->>'topic', '') not in (
       'servicos','area','precos','agenda','emergencia','outro'
     )
     or coalesce(p_fact->>'field', '') !~
       '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$'
     or coalesce(p_fact->>'disposition', '') not in (
       'answered','not_applicable','owner_review_required'
     )
     or length(btrim(coalesce(p_fact->>'rule_text', ''))) < 1
     or length(p_fact->>'rule_text') > 4000
     or length(btrim(coalesce(p_fact->>'owner_words', ''))) < 1
     or length(p_fact->>'owner_words') > 1000
     or (p_fact ? 'subject' and p_fact->'subject' <> 'null'::jsonb
       and jsonb_typeof(p_fact->'subject') <> 'string')
     or length(coalesce(p_fact->>'subject', '')) > 200
     or (p_fact ? 'structured' and p_fact->'structured' <> 'null'::jsonb
       and jsonb_typeof(p_fact->'structured') <> 'object') then
    raise exception using errcode = '22023', message = 'onboarding_fact_shape_invalid';
  end if;

  if v_schema_version = 2 then
    if p_fact->>'field' not in (
      'business.customer_types','business.excluded_work','business.languages_tone',
      'area.coverage','area.out_of_area_policy','area.travel_fee',
      'schedule.business_hours','schedule.same_day_lead_time',
      'schedule.capacity_buffer','schedule.reschedule_cancel','schedule.holidays',
      'emergency.types','emergency.safety_escalation','emergency.after_hours',
      'emergency.fee_authority','policy.payment_estimate',
      'policy.warranty_materials','policy.access_cancellation',
      'policy.complaints_returns','authority.quote_price',
      'authority.negotiate_floor','authority.read_calendar','authority.book',
      'authority.reschedule_cancel','authority.charge_fee','authority.emergency',
      'authority.out_of_area','service.catalog_closure','service.name_synonyms',
      'service.price_mode','service.price_target','service.negotiation',
      'service.duration','service.inclusions_exclusions','service.materials_parts',
      'service.warranty','service.emergency_eligibility','service.escalation'
    ) then
      raise exception using errcode = '22023', message = 'onboarding_field_invalid';
    end if;
    if p_fact->'structured' ? 'fields'
       or (
         jsonb_typeof(p_fact->'structured'->'value') = 'object'
         and p_fact->'structured'->'value' ? 'fields'
       ) then
      raise exception using errcode = '22023', message = 'onboarding_bundled_fact_forbidden';
    end if;
    if p_fact->>'field' like 'service.%'
       and p_fact->>'field' <> 'service.catalog_closure' then
      if coalesce(p_fact->>'subject', '') !~ '^[a-z0-9][a-z0-9_]{0,199}$' then
        raise exception using errcode = '22023', message = 'onboarding_subject_required';
      end if;
      if not coalesce(p_coverage->'snapshot'->'services' ? (p_fact->>'subject'), false) then
        raise exception using errcode = '22023', message = 'onboarding_subject_not_discovered';
      end if;
    elsif nullif(p_fact->>'subject', '') is not null then
      raise exception using errcode = '22023', message = 'onboarding_subject_forbidden';
    end if;
  end if;

  v_payload := jsonb_build_object(
    'schema_version', v_schema_version,
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
    raise exception using errcode = '42501', message = 'onboarding_call_not_owner_bound';
  end if;

  -- exact event replay always wins before semantic comparison.
  select r.* into v_existing
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind in ('onboarding_coverage', 'onboarding_event_alias')
    and r.external_id = p_event_key
  limit 1;
  if v_existing.id is not null then
    if v_existing.payload_hash is distinct from v_payload_hash then
      raise exception using errcode = '23505', message = 'onboarding_event_payload_mismatch';
    end if;
    return jsonb_build_object(
      'status', 'reused',
      'rule_id', nullif(v_existing.readback->>'rule_id', ''),
      'rule_group_id', nullif(v_existing.readback->>'rule_group_id', ''),
      'coverage_receipt_id', coalesce(
        v_existing.readback->>'target_receipt_id',
        v_existing.id::text
      ),
      'revision', coalesce(
        (v_existing.readback->>'target_revision')::integer,
        (v_existing.readback->>'revision')::integer
      ),
      'snapshot_digest', coalesce(
        v_existing.readback->>'target_digest',
        v_existing.readback->>'snapshot_digest'
      ),
      'complete', coalesce((v_existing.readback->>'complete')::boolean, false),
      'missing', coalesce(
        v_existing.readback->'progress'->'missingRequired', '[]'::jsonb
      ),
      'ambiguous', coalesce(
        v_existing.readback->'progress'->'ambiguous', '[]'::jsonb
      ),
      'next_action', v_existing.readback->'next_action',
      'coverage', v_existing.readback
    );
  end if;

  select r.* into v_latest
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind = 'onboarding_coverage'
  order by (r.readback->>'revision')::integer desc, r.created_at desc, r.id desc
  limit 1;
  v_latest_revision := coalesce((v_latest.readback->>'revision')::integer, 0);
  if v_latest_revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'onboarding_revision_changed';
  end if;

  if v_schema_version = 1 then
    if coalesce(p_coverage->>'tenant_id' = p_tenant::text, false) = false
       or coalesce(p_coverage->>'call_id' = p_call::text, false) = false
       or jsonb_typeof(p_coverage->'complete') is distinct from 'boolean'
       or jsonb_typeof(p_coverage->'snapshot') is distinct from 'object'
       or jsonb_typeof(p_coverage->'progress') is distinct from 'object'
       or jsonb_typeof(p_coverage->'selected_rule_ids') is distinct from 'array'
       or jsonb_typeof(p_coverage->'next_action') is distinct from 'object'
       or p_coverage->'authority' is distinct from jsonb_build_object(
         'rules_approved', false,
         'powers_granted', false,
         'operational_mode_changed', false
       ) then
      raise exception using errcode = '22023', message = 'onboarding_coverage_shape_invalid';
    end if;
    v_revision := (p_coverage->>'revision')::integer;
    if v_revision <> p_expected_revision + 1
       or (p_coverage->'snapshot'->>'revision')::integer <> v_revision
       or p_coverage->'snapshot'->>'tenantId' <> p_tenant::text
       or p_coverage->'snapshot'->>'callId' <> p_call::text
       or jsonb_typeof(p_coverage->'snapshot'->'services') is distinct from 'array'
       or jsonb_typeof(p_coverage->'snapshot'->'cells') is distinct from 'object'
       or jsonb_typeof(p_coverage->'snapshot'->'followUps') is distinct from 'number'
       or jsonb_typeof(p_coverage->'snapshot'->'followUpGroups') is distinct from 'object'
       or jsonb_typeof(p_coverage->'progress'->'missingRequired') is distinct from 'array'
       or jsonb_typeof(p_coverage->'progress'->'ambiguous') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'onboarding_coverage_revision_invalid';
    end if;

    select r.* into v_existing
    from public.receipts r
    where r.tenant_id = p_tenant
      and r.call_id = p_call
      and r.kind = 'onboarding_coverage'
      and r.detail->>'answer_hash' = p_answer_hash
    limit 1;
    if v_existing.id is not null then
      return jsonb_build_object(
        'status', 'reused',
        'rule_id', v_existing.readback->>'rule_id',
        'rule_group_id', v_existing.readback->>'rule_group_id',
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

    perform pg_advisory_xact_lock(hashtextextended(
      'ligou.v0_2.rules_versioning:' || p_tenant::text, 0
    ));
    if p_rule_group_id is null then
      v_rule_group_id := gen_random_uuid();
      v_rule_version := 1;
    else
      select r.* into v_prior_rule
      from public.rules r
      where r.tenant_id = p_tenant
        and r.rule_group_id = p_rule_group_id
        and r.related_call_id = p_call
        and r.origem = 'onboarding'
      order by r.version desc, r.created_at desc, r.id desc
      limit 1;
      if v_prior_rule.id is null then
        raise exception using errcode = '22023', message = 'onboarding_rule_group_invalid';
      end if;
      v_rule_group_id := v_prior_rule.rule_group_id;
      v_rule_version := v_prior_rule.version + 1;
    end if;
    insert into public.rules (
      tenant_id, rule_group_id, version, origem, escopo, status, category, text,
      structured, evidence_quote, related_call_id
    ) values (
      p_tenant,
      v_rule_group_id,
      v_rule_version,
      'onboarding',
      case
        when p_fact->>'field' like 'service.%' then 'servico'
        when p_fact->>'field' like 'area.%' then 'localizacao'
        else 'geral'
      end,
      'sugerido',
      p_fact->>'topic',
      p_fact->>'rule_text',
      coalesce(nullif(p_fact->'structured', 'null'::jsonb), '{}'::jsonb) ||
        jsonb_build_object(
          'coverage_field', p_fact->>'field',
          'coverage_subject', nullif(p_fact->>'subject', ''),
          'coverage_disposition', p_fact->>'disposition',
          'coverage_revision', v_revision
        ),
      p_fact->>'owner_words',
      p_call
    ) returning id into v_rule_id;
    v_readback := (p_coverage - 'snapshot_digest') || jsonb_build_object(
      'schema_version', 1,
      'tenant_id', p_tenant,
      'call_id', p_call,
      'revision', v_revision,
      'rule_id', v_rule_id,
      'rule_group_id', v_rule_group_id,
      'selected_rule_ids',
        (p_coverage->'selected_rule_ids') || to_jsonb(v_rule_id::text),
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
      tenant_id, call_id, kind, outcome, external_id, readback, payload_hash, detail
    ) values (
      p_tenant, p_call, 'onboarding_coverage', 'accepted', p_event_key,
      v_readback, v_payload_hash,
      jsonb_build_object(
        'answer_hash', p_answer_hash,
        'provider_tool_call_id', p_provider_tool_call_id,
        'fact', p_fact,
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

  -- Schema V2. The a -> b -> a path compares only the current key hash; a
  -- historical A never suppresses a legitimate third version.
  if p_rule_group_id is not null then
    raise exception using errcode = '22023', message = 'onboarding_v2_group_authority_forbidden';
  end if;
  if p_coverage->'schema_version' <> '2'::jsonb
     or p_coverage->>'transition_kind' <> 'answer'
     or coalesce(p_coverage->>'tenant_id' = p_tenant::text, false) = false
     or coalesce(p_coverage->>'call_id' = p_call::text, false) = false
     or jsonb_typeof(p_coverage->'complete') is distinct from 'boolean'
     or jsonb_typeof(p_coverage->'snapshot') is distinct from 'object'
     or jsonb_typeof(p_coverage->'progress') is distinct from 'object'
     or jsonb_typeof(p_coverage->'selected_rule_ids') is distinct from 'array'
     or jsonb_typeof(p_coverage->'next_action') is distinct from 'object'
     or jsonb_typeof(p_coverage->'current_answer_hashes') is distinct from 'object'
     or jsonb_typeof(p_coverage->'materializations') is distinct from 'array'
     or p_coverage->'authority' is distinct from jsonb_build_object(
       'rules_approved', false,
       'powers_granted', false,
       'operational_mode_changed', false
     ) then
    raise exception using errcode = '22023', message = 'onboarding_coverage_shape_invalid';
  end if;
  v_revision := (p_coverage->>'revision')::integer;
  if v_revision <> p_expected_revision + 1
     or (p_coverage->'snapshot'->>'revision')::integer <> v_revision
     or p_coverage->'snapshot'->>'tenantId' <> p_tenant::text
     or p_coverage->'snapshot'->>'callId' <> p_call::text
     or jsonb_typeof(p_coverage->'snapshot'->'services') is distinct from 'array'
     or jsonb_typeof(p_coverage->'snapshot'->'cells') is distinct from 'object'
     or jsonb_typeof(p_coverage->'snapshot'->'followUps') is distinct from 'number'
     or jsonb_typeof(p_coverage->'snapshot'->'followUpGroups') is distinct from 'object'
     or jsonb_typeof(p_coverage->'progress'->'missingRequired') is distinct from 'array'
     or jsonb_typeof(p_coverage->'progress'->'ambiguous') is distinct from 'array'
     or (
       (p_coverage->>'complete')::boolean
       and (
         jsonb_typeof(p_coverage->'summary_projection') is distinct from 'object'
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
    raise exception using errcode = '22023', message = 'onboarding_coverage_projection_invalid';
  end if;

  v_coverage_key := case
    when p_fact->>'field' like 'service.%'
      and p_fact->>'field' <> 'service.catalog_closure'
      then 'service:' || (p_fact->>'subject') || ':' || (p_fact->>'field')
    else p_fact->>'field'
  end;
  v_materialization_key := case
    when p_fact->>'field' like 'service.%'
      and p_fact->>'field' <> 'service.catalog_closure'
      then 'service:' || (p_fact->>'subject')
    when p_fact->>'field' like 'business.%' then 'domain:business'
    when p_fact->>'field' like 'area.%' then 'domain:area'
    when p_fact->>'field' like 'schedule.%' then 'domain:schedule'
    when p_fact->>'field' like 'emergency.%' then 'domain:emergency'
    when p_fact->>'field' like 'policy.%' then 'domain:policy'
    when p_fact->>'field' like 'authority.%' then 'domain:authority'
    else null
  end;
  v_rule_group_id := case
    when v_materialization_key is null then null
    else (md5(
      'ligou.rule.materialization.v2:' || p_tenant::text || ':' ||
      v_materialization_key
    ))::uuid
  end;

  v_current_hashes := (
    case
      when v_latest.readback->'schema_version' = '2'::jsonb
        then coalesce(v_latest.readback->'current_answer_hashes', '{}'::jsonb)
      else '{}'::jsonb
    end
  ) || jsonb_build_object(v_coverage_key, p_answer_hash);
  if p_coverage->'current_answer_hashes' is distinct from v_current_hashes then
    raise exception using errcode = '22023', message = 'onboarding_current_answer_hashes_invalid';
  end if;

  select count(*), count(distinct item->>'key')
    into v_materialization_count, v_materialization_distinct
  from jsonb_array_elements(p_coverage->'materializations') item;
  if v_materialization_count <> v_materialization_distinct
     or exists (
       select 1
       from jsonb_array_elements(p_coverage->'materializations') item
       where coalesce(item->>'key', '') !~
           '^(service:[a-z0-9][a-z0-9_]*|domain:(area|schedule|emergency|business|policy|authority))$'
         or item->>'category' not in (
           'preco','area','agenda','emergencia','negocio','politica','autoridade'
         )
         or item->>'scope' not in ('servico','localizacao','geral')
         or item->>'state' not in (
           'active','owner_review_required','incomplete','disabled'
         )
         or jsonb_typeof(item->'review_ready') is distinct from 'boolean'
         or length(btrim(coalesce(item->>'text', ''))) > 12000
         or jsonb_typeof(item->'structured') is distinct from 'object'
         or jsonb_typeof(item->'source_refs') is distinct from 'array'
         or coalesce(item->>'materialization_hash' ~ '^[0-9a-f]{64}$', false) = false
         or item->>'materialization_hash' <>
           item->'structured'->>'materialization_hash'
         or item->>'key' <> item->'structured'->>'materialization_key'
         or item->>'state' is distinct from
           item->'structured'->>'operational_state'
         or case
           when jsonb_typeof(item->'review_ready') = 'boolean'
            and jsonb_typeof(item->'structured'->'review_ready') = 'boolean'
            and jsonb_typeof(
              item->'structured'->'materialization_eligible'
            ) = 'boolean'
           then (item->>'review_ready')::boolean is distinct from
              (item->'structured'->>'review_ready')::boolean
             or (item->>'review_ready')::boolean is distinct from
              (item->'structured'->>'materialization_eligible')::boolean
           else true
         end
         or case
           when coalesce(
             item->'structured'->>'coverage_revision' ~ '^[1-9][0-9]*$',
             false
           )
           then (item->'structured'->>'coverage_revision')::integer <>
             v_revision
           else true
         end
         or item->'structured'->>'source_call_id' <> p_call::text
         or item->'structured'->'source_refs' is distinct from item->'source_refs'
         or (
           item->>'key' like 'service:%'
           and (
             item->>'category' <> 'preco'
             or item->>'scope' <> 'servico'
             or item->'structured'->>'schema' <> 'ligou.rule.service.v2'
             or item->'structured'->>'service_type' <>
               substring(item->>'key' from 9)
           )
         )
         or (
           item->>'key' like 'domain:%'
           and (
             item->'structured'->>'schema' <>
               case item->>'key'
                 when 'domain:area' then 'ligou.rule.area.v2'
                 when 'domain:schedule' then 'ligou.rule.schedule.v2'
                 when 'domain:emergency' then 'ligou.rule.emergency.v2'
                 when 'domain:business' then 'ligou.rule.business.v2'
                 when 'domain:policy' then 'ligou.rule.policy.v2'
                 when 'domain:authority' then 'ligou.rule.authority.v2'
               end
             or item->>'category' <>
               case item->>'key'
                 when 'domain:area' then 'area'
                 when 'domain:schedule' then 'agenda'
                 when 'domain:emergency' then 'emergencia'
                 when 'domain:business' then 'negocio'
                 when 'domain:policy' then 'politica'
                 when 'domain:authority' then 'autoridade'
               end
             or item->>'scope' <>
               case item->>'key'
                 when 'domain:area' then 'localizacao'
                 else 'geral'
               end
           )
         )
     ) then
    raise exception using errcode = '22023', message = 'onboarding_materializations_invalid';
  end if;

  if v_materialization_key is not null then
    select item into v_materialization
    from jsonb_array_elements(p_coverage->'materializations') item
    where item->>'key' = v_materialization_key;
    if v_materialization is null then
      raise exception using errcode = '22023', message = 'onboarding_affected_materialization_missing';
    end if;
  end if;

  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
    into v_selected_base
  from jsonb_array_elements_text(
    case
      when v_latest.readback->'schema_version' = '2'::jsonb
        then coalesce(v_latest.readback->'selected_rule_ids', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) selected(value)
  left join public.rules selected_rule
    on selected_rule.id = selected.value::uuid
   and selected_rule.tenant_id = p_tenant
  where v_rule_group_id is null
     or selected_rule.rule_group_id is distinct from v_rule_group_id;
  if p_coverage->'selected_rule_ids' is distinct from v_selected_base then
    raise exception using errcode = '22023', message = 'onboarding_selected_rules_invalid';
  end if;

  -- current-relative semantic alias: append exact event evidence but no coverage
  -- revision or rule. Exact replay of this alias after B returns its old output
  -- and therefore cannot regress the current state.
  if v_latest.id is not null
     and v_latest.readback->'schema_version' = '2'::jsonb
     and v_latest.readback->'current_answer_hashes'->>v_coverage_key = p_answer_hash then
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
      tenant_id, call_id, kind, outcome, external_id, readback, payload_hash, detail
    ) values (
      p_tenant, p_call, 'onboarding_event_alias', 'accepted', p_event_key,
      v_alias_readback, v_payload_hash,
      jsonb_build_object(
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
    'ligou.v0_2.rules_versioning:' || p_tenant::text,
    0
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
        tenant_id, rule_group_id, version, origem, escopo, status, category,
        text, structured, evidence_quote, related_call_id
      ) values (
        p_tenant,
        v_rule_group_id,
        v_rule_version,
        'onboarding',
        v_materialization->>'scope',
        'sugerido',
        v_materialization->>'category',
        v_materialization->>'text',
        v_materialization->'structured',
        p_fact->>'owner_words',
        p_call
      ) returning id into v_rule_id;
      v_materialization_action := 'suggested';
    elsif v_latest_rule.id is not null then
      insert into public.rules (
        tenant_id, rule_group_id, version, origem, escopo, status, category,
        text, structured, evidence_quote, related_call_id
      ) values (
        p_tenant,
        v_rule_group_id,
        v_rule_version,
        'onboarding',
        v_materialization->>'scope',
        'rejeitado',
        v_materialization->>'category',
        coalesce(nullif(v_materialization->>'text', ''),
          'Materialização incompleta; revisão necessária.'),
        v_materialization->'structured',
        p_fact->>'owner_words',
        p_call
      ) returning id into v_rule_id;
      v_materialization_action := 'rejected_tombstone';
    end if;
  end if;

  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
    into v_selected_final
  from (
    select value
    from jsonb_array_elements_text(v_selected_base) selected(value)
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
    tenant_id, call_id, kind, outcome, external_id, readback, payload_hash, detail
  ) values (
    p_tenant, p_call, 'onboarding_coverage', 'accepted', p_event_key,
    v_readback, v_payload_hash,
    jsonb_build_object(
      'transition_kind', 'answer',
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
end
$$;

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
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_tenant is null or p_call is null or p_owner is null
     or p_expected_revision is null or p_expected_revision < 1
     or coalesce(p_field, '') = ''
     or p_event_key is null or p_event_key !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_coverage) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'onboarding_followup_shape_invalid';
  end if;
  if p_field like 'service.%' and p_field <> 'service.catalog_closure' then
    if coalesce(p_subject, '') !~ '^[a-z0-9][a-z0-9_]{0,199}$' then
      raise exception using errcode = '22023', message = 'onboarding_subject_required';
    end if;
    v_key := 'service:' || p_subject || ':' || p_field;
  else
    if nullif(p_subject, '') is not null then
      raise exception using errcode = '22023', message = 'onboarding_subject_forbidden';
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
    raise exception using errcode = '22023', message = 'onboarding_event_key_mismatch';
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
    raise exception using errcode = '42501', message = 'onboarding_call_not_owner_bound';
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
      raise exception using errcode = '23505', message = 'onboarding_event_payload_mismatch';
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
  order by (r.readback->>'revision')::integer desc, r.created_at desc, r.id desc
  limit 1;
  if v_latest.id is null then
    raise exception using errcode = 'P0002', message = 'onboarding_coverage_missing';
  end if;
  if v_latest.readback->'schema_version' is distinct from '2'::jsonb
     or (v_latest.readback->>'revision')::integer <> p_expected_revision then
    raise exception using errcode = '40001', message = 'onboarding_revision_changed';
  end if;
  if coalesce((v_latest.readback->>'complete')::boolean, false) then
    raise exception using errcode = '22023', message = 'onboarding_coverage_complete';
  end if;
  if v_latest.readback->'next_action'->>'type' <> 'ask'
     or v_latest.readback->'next_action'->>'field' <> p_field
     or coalesce(v_latest.readback->'next_action'->>'subject', '') <>
       coalesce(p_subject, '') then
    raise exception using errcode = '40001', message = 'onboarding_followup_changed';
  end if;
  v_global_count := (v_latest.readback->'snapshot'->>'followUps')::integer;
  v_group_count := coalesce(
    (v_latest.readback->'snapshot'->'followUpGroups'->>v_key)::integer,
    0
  );
  if v_group_count >= 2 then
    raise exception using errcode = '22023', message = 'onboarding_followup_group_exhausted';
  end if;
  if v_global_count >= 12 then
    raise exception using errcode = '22023', message = 'onboarding_followup_global_exhausted';
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
    raise exception using errcode = '22023', message = 'onboarding_followup_projection_invalid';
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
    tenant_id, call_id, kind, outcome, external_id, readback, payload_hash, detail
  ) values (
    p_tenant, p_call, 'onboarding_coverage', 'accepted', p_event_key,
    v_readback, v_payload_hash,
    jsonb_build_object(
      'transition_kind', 'directed_followup',
      'source_revision', p_expected_revision,
      'field', p_field,
      'subject', p_subject,
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

create or replace function public.decide_rule(
  p_rule uuid,
  p_decision text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.rules;
  v_new uuid;
begin
  select r.* into v_rule
  from public.rules r
  join public.tenants t
    on t.id = r.tenant_id
   and t.owner_user_id = auth.uid()
  where r.id = p_rule;
  if v_rule.id is null then
    raise exception 'rule_not_found_or_not_owner';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.rules_versioning:' || v_rule.tenant_id::text,
    0
  ));
  if exists (
    select 1 from public.rules r
    where r.tenant_id = v_rule.tenant_id
      and r.rule_group_id = v_rule.rule_group_id
      and r.version > v_rule.version
  ) then
    raise exception using errcode = '40001', message = 'stale_rule_version';
  end if;
  if v_rule.status <> 'sugerido' then
    raise exception 'rule_not_pending: %', v_rule.status;
  end if;
  if p_decision not in ('aprovado','rejeitado') then
    raise exception 'invalid_decision';
  end if;
  if p_decision = 'aprovado'
     and v_rule.origem = 'onboarding'
     and (
       jsonb_typeof(v_rule.structured->'materialization_eligible')
         is distinct from 'boolean'
       or jsonb_typeof(v_rule.structured->'review_ready')
         is distinct from 'boolean'
       or (v_rule.structured->>'materialization_eligible')::boolean is not true
       or (v_rule.structured->>'review_ready')::boolean is not true
     ) then
    raise exception using errcode = '22023',
      message = 'rule_not_materialization_eligible';
  end if;
  insert into public.rules (
    tenant_id, rule_group_id, version, origem, escopo, status, category, text,
    structured, evidence_quote, related_call_id, approved_by, approved_at
  ) values (
    v_rule.tenant_id, v_rule.rule_group_id, v_rule.version + 1,
    v_rule.origem, v_rule.escopo, p_decision, v_rule.category, v_rule.text,
    v_rule.structured, v_rule.evidence_quote, v_rule.related_call_id,
    auth.uid(), now()
  ) returning id into v_new;
  return v_new;
end
$$;

revoke all on function public.decide_rule(uuid,text)
  from public, anon, service_role;
grant execute on function public.decide_rule(uuid,text) to authenticated;

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
      er.category, er.structured, v_booking.service_type, p_confirmed_price
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
