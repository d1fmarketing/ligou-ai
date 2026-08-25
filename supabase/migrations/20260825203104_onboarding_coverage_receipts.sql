-- Durable onboarding coverage and voice acknowledgement reuse the existing
-- append-only receipt ledger. The controller remains the sole coverage engine;
-- these RPCs validate the bounded projection and persist it atomically with the
-- suggested rule under call-scoped serialization.

alter table public.receipts drop constraint if exists receipts_kind_check;
alter table public.receipts add constraint receipts_kind_check check (
  kind in (
    'booking', 'booking_cancel', 'rule_change', 'power_change', 'notification',
    'onboarding_coverage', 'onboarding_voice_approval'
  )
);

alter table public.receipts add constraint receipts_onboarding_shape_check check (
  kind not in ('onboarding_coverage', 'onboarding_voice_approval')
  or (
    outcome = 'accepted'
    and call_id is not null
    and coalesce(external_id ~ '^[0-9a-f]{64}$', false)
    and coalesce(payload_hash ~ '^[0-9a-f]{64}$', false)
    and jsonb_typeof(readback) = 'object'
    and readback->'schema_version' is not distinct from '1'::jsonb
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
        and coalesce(detail->>'answer_hash' ~ '^[0-9a-f]{64}$', false)
      )
    )
    and (
      kind <> 'onboarding_voice_approval'
      or (
        coalesce(readback->>'snapshot_receipt_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
        and coalesce(readback->>'snapshot_revision' ~ '^[1-9][0-9]*$', false)
        and coalesce(readback->>'snapshot_digest' ~ '^[0-9a-f]{64}$', false)
        and coalesce(detail->>'owner_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      )
    )
  )
) not valid;
alter table public.receipts validate constraint receipts_onboarding_shape_check;

create unique index receipts_onboarding_event_key_unique
  on public.receipts (tenant_id, kind, external_id)
  where kind in ('onboarding_coverage','onboarding_voice_approval');

create unique index receipts_onboarding_coverage_revision_unique
  on public.receipts (tenant_id, call_id, ((readback ->> 'revision')::integer))
  where kind = 'onboarding_coverage';

create unique index receipts_onboarding_answer_hash_unique
  on public.receipts (tenant_id, call_id, (detail ->> 'answer_hash'))
  where kind = 'onboarding_coverage';

create unique index receipts_onboarding_approval_snapshot_unique
  on public.receipts (tenant_id, call_id, (readback ->> 'snapshot_receipt_id'))
  where kind = 'onboarding_voice_approval';

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
  v_request_id uuid;
  v_expected_event_key text;
  v_payload jsonb;
  v_payload_hash text;
  v_existing public.receipts;
  v_prior_rule public.rules;
  v_latest_revision integer;
  v_revision integer;
  v_rule_id uuid;
  v_rule_group_id uuid;
  v_rule_version integer;
  v_receipt_id uuid;
  v_readback jsonb;
  v_snapshot_digest text;
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

  v_expected_event_key := encode(extensions.digest(convert_to(
    'ligou.v0_2.onboarding_answer:v1:' || p_tenant::text || ':' || p_call::text || ':' || p_provider_tool_call_id,
    'UTF8'
  ), 'sha256'), 'hex');
  if p_event_key <> v_expected_event_key then
    raise exception using errcode = '22023', message = 'onboarding_event_key_mismatch';
  end if;

  if jsonb_typeof(p_fact) is distinct from 'object'
     or coalesce(p_fact->>'topic', '') not in ('servicos','area','precos','agenda','emergencia','outro')
     or coalesce(p_fact->>'field', '') !~ '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$'
     or coalesce(p_fact->>'disposition', '') not in ('answered','not_applicable','owner_review_required')
     or length(btrim(coalesce(p_fact->>'rule_text', ''))) < 1
     or length(p_fact->>'rule_text') > 4000
     or length(btrim(coalesce(p_fact->>'owner_words', ''))) < 1
     or length(p_fact->>'owner_words') > 1000
     or (p_fact ? 'subject' and p_fact->'subject' <> 'null'::jsonb and jsonb_typeof(p_fact->'subject') <> 'string')
     or length(coalesce(p_fact->>'subject', '')) > 200
     or (p_fact ? 'structured' and p_fact->'structured' <> 'null'::jsonb and jsonb_typeof(p_fact->'structured') <> 'object') then
    raise exception using errcode = '22023', message = 'onboarding_fact_shape_invalid';
  end if;

  if jsonb_typeof(p_coverage) is distinct from 'object'
     or p_coverage->'schema_version' is distinct from '1'::jsonb
     or coalesce(p_coverage->>'tenant_id' = p_tenant::text, false) = false
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
  if coalesce(p_coverage->>'revision', '') !~ '^[1-9][0-9]*$'
     or coalesce(p_coverage->'snapshot'->>'revision', '') !~ '^[1-9][0-9]*$' then
    raise exception using errcode = '22023', message = 'onboarding_coverage_revision_invalid';
  end if;
  v_revision := (p_coverage->>'revision')::integer;
  if v_revision <> p_expected_revision + 1
     or (p_coverage->'snapshot'->>'revision')::integer <> v_revision
     or coalesce(p_coverage->'snapshot'->>'tenantId' = p_tenant::text, false) = false
     or coalesce(p_coverage->'snapshot'->>'callId' = p_call::text, false) = false
     or jsonb_typeof(p_coverage->'snapshot'->'services') is distinct from 'array'
     or jsonb_typeof(p_coverage->'snapshot'->'cells') is distinct from 'object'
     or jsonb_typeof(p_coverage->'snapshot'->'followUps') is distinct from 'number'
     or jsonb_typeof(p_coverage->'snapshot'->'followUpGroups') is distinct from 'object'
     or jsonb_typeof(p_coverage->'progress'->'missingRequired') is distinct from 'array'
     or jsonb_typeof(p_coverage->'progress'->'ambiguous') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'onboarding_coverage_projection_invalid';
  end if;

  v_payload := jsonb_build_object(
    'schema_version', 1,
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
  v_payload_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

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
    and r.kind = 'onboarding_coverage'
    and r.external_id = p_event_key
  limit 1;
  if v_existing.id is not null then
    if v_existing.payload_hash is distinct from v_payload_hash then
      raise exception using errcode = '23505', message = 'onboarding_event_payload_mismatch';
    end if;
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

  select coalesce(max((r.readback->>'revision')::integer), 0)
    into v_latest_revision
  from public.receipts r
  where r.tenant_id = p_tenant and r.call_id = p_call and r.kind = 'onboarding_coverage';
  if v_latest_revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'onboarding_revision_changed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.rules_versioning:' || p_tenant::text,
    0
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
    coalesce(nullif(p_fact->'structured', 'null'::jsonb), '{}'::jsonb) || jsonb_build_object(
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
    'selected_rule_ids', (p_coverage->'selected_rule_ids') || to_jsonb(v_rule_id::text),
    'authority', jsonb_build_object(
      'rules_approved', false,
      'powers_granted', false,
      'operational_mode_changed', false
    )
  );
  v_snapshot_digest := encode(extensions.digest(convert_to(v_readback::text, 'UTF8'), 'sha256'), 'hex');
  v_readback := v_readback || jsonb_build_object('snapshot_digest', v_snapshot_digest);

  insert into public.receipts (
    tenant_id, call_id, kind, outcome, external_id, readback, payload_hash, detail
  ) values (
    p_tenant,
    p_call,
    'onboarding_coverage',
    'accepted',
    p_event_key,
    v_readback,
    v_payload_hash,
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
end
$$;

revoke all on function public.record_onboarding_answer(uuid,uuid,uuid,text,text,text,integer,jsonb,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_onboarding_answer(uuid,uuid,uuid,text,text,text,integer,jsonb,uuid,jsonb)
  to service_role;

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
  v_request_id uuid;
  v_expected_event_key text;
  v_payload jsonb;
  v_payload_hash text;
  v_coverage public.receipts;
  v_existing public.receipts;
  v_receipt_id uuid;
  v_readback jsonb;
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
     or p_expected_digest is null or p_expected_digest !~ '^[0-9a-f]{64}$'
     or p_expected_revision is null or p_expected_revision < 1 then
    raise exception using errcode = '22023', message = 'onboarding_approval_snapshot_invalid';
  end if;
  if length(btrim(coalesce(p_owner_words, ''))) < 1 or length(p_owner_words) > 1000 then
    raise exception using errcode = '22023', message = 'onboarding_approval_words_invalid';
  end if;

  v_expected_event_key := encode(extensions.digest(convert_to(
    'ligou.v0_2.onboarding_voice_approval:v1:' || p_tenant::text || ':' || p_call::text || ':' || p_provider_tool_call_id,
    'UTF8'
  ), 'sha256'), 'hex');
  if p_event_key <> v_expected_event_key then
    raise exception using errcode = '22023', message = 'onboarding_event_key_mismatch';
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
  v_payload_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

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

  select r.* into v_coverage
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind = 'onboarding_coverage'
  order by (r.readback->>'revision')::integer desc, r.created_at desc, r.id desc
  limit 1;
  if v_coverage.id is null then
    raise exception using errcode = 'P0002', message = 'onboarding_coverage_missing';
  end if;
  if coalesce((v_coverage.readback->>'complete')::boolean, false) = false then
    raise exception using errcode = '22023', message = 'onboarding_coverage_incomplete';
  end if;
  if (v_coverage.readback->>'revision')::integer <> p_expected_revision
     or v_coverage.readback->>'snapshot_digest' <> p_expected_digest then
    raise exception using errcode = '40001', message = 'onboarding_snapshot_changed';
  end if;

  select r.* into v_existing
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.kind = 'onboarding_voice_approval'
    and r.external_id = p_event_key
  limit 1;
  if v_existing.id is not null then
    if v_existing.payload_hash is distinct from v_payload_hash then
      raise exception using errcode = '23505', message = 'onboarding_event_payload_mismatch';
    end if;
    return jsonb_build_object(
      'status', 'reused',
      'approval_receipt_id', v_existing.id,
      'coverage_receipt_id', v_existing.readback->>'snapshot_receipt_id',
      'revision', (v_existing.readback->>'snapshot_revision')::integer,
      'snapshot_digest', v_existing.readback->>'snapshot_digest'
    );
  end if;

  select r.* into v_existing
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_call
    and r.kind = 'onboarding_voice_approval'
    and r.readback->>'snapshot_receipt_id' = v_coverage.id::text
  limit 1;
  if v_existing.id is not null then
    return jsonb_build_object(
      'status', 'reused',
      'approval_receipt_id', v_existing.id,
      'coverage_receipt_id', v_existing.readback->>'snapshot_receipt_id',
      'revision', (v_existing.readback->>'snapshot_revision')::integer,
      'snapshot_digest', v_existing.readback->>'snapshot_digest'
    );
  end if;

  v_readback := jsonb_build_object(
    'schema_version', 1,
    'call_id', p_call,
    'snapshot_receipt_id', v_coverage.id,
    'snapshot_revision', (v_coverage.readback->>'revision')::integer,
    'snapshot_digest', v_coverage.readback->>'snapshot_digest',
    'authority', jsonb_build_object(
      'rules_approved', false,
      'powers_granted', false,
      'operational_mode_changed', false
    )
  );
  insert into public.receipts (
    tenant_id, call_id, kind, outcome, external_id, readback, payload_hash, detail
  ) values (
    p_tenant,
    p_call,
    'onboarding_voice_approval',
    'accepted',
    p_event_key,
    v_readback,
    v_payload_hash,
    jsonb_build_object(
      'owner_words', p_owner_words,
      'owner_id', p_owner,
      'provider_tool_call_id', p_provider_tool_call_id,
      'browser_request_id', v_request_id,
      'snapshot_digest', v_coverage.readback->>'snapshot_digest'
    )
  ) returning id into v_receipt_id;

  return jsonb_build_object(
    'status', 'recorded',
    'approval_receipt_id', v_receipt_id,
    'coverage_receipt_id', v_coverage.id,
    'revision', (v_coverage.readback->>'revision')::integer,
    'snapshot_digest', v_coverage.readback->>'snapshot_digest'
  );
end
$$;

revoke all on function public.record_onboarding_voice_approval(uuid,uuid,uuid,text,text,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.record_onboarding_voice_approval(uuid,uuid,uuid,text,text,integer,text,text)
  to service_role;

-- A correction appends a newer suggested version in the same rule group. The
-- owner dashboard may approve only the latest version that existed after the
-- shared tenant versioning lock was acquired.
create or replace function public.decide_rule(p_rule uuid, p_decision text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_rule public.rules; v_new uuid;
begin
  select r.* into v_rule from public.rules r
    join public.tenants t on t.id = r.tenant_id and t.owner_user_id = auth.uid()
    where r.id = p_rule;
  if v_rule.id is null then raise exception 'rule_not_found_or_not_owner'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ligou.v0_2.rules_versioning:' || v_rule.tenant_id::text, 0));
  if exists (
    select 1 from public.rules r
    where r.tenant_id = v_rule.tenant_id
      and r.rule_group_id = v_rule.rule_group_id
      and r.version > v_rule.version
  ) then
    raise exception using errcode = '40001', message = 'stale_rule_version';
  end if;
  if v_rule.status <> 'sugerido' then raise exception 'rule_not_pending: %', v_rule.status; end if;
  if p_decision not in ('aprovado','rejeitado') then raise exception 'invalid_decision'; end if;
  insert into public.rules (tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured, evidence_quote, related_call_id, approved_by, approved_at)
    values (v_rule.tenant_id, v_rule.rule_group_id, v_rule.version + 1, v_rule.origem, v_rule.escopo,
            p_decision, v_rule.category, v_rule.text, v_rule.structured, v_rule.evidence_quote, v_rule.related_call_id,
            auth.uid(), now())
    returning id into v_new;
  return v_new;
end $$;

revoke all on function public.decide_rule(uuid,text) from public, anon, service_role;
grant execute on function public.decide_rule(uuid,text) to authenticated;
