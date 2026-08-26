begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(29);

select extensions.ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  ),
  'every public table has row-level security enabled'
);

select extensions.ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relforcerowsecurity
  ),
  'every public table forces row-level security'
);

select extensions.ok(
  coalesce((
    select c.reloptions @> array['security_invoker=true']
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'effective_rules' and c.relkind = 'v'
  ), false),
  'effective_rules executes with invoker security'
);

select extensions.ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
  ),
  'every public SECURITY DEFINER function has an empty search_path'
);

select extensions.ok(
  array(
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
    order by 1
  ) = array(
    select signature from (values
      ('adjust_case(uuid,text)'),
      ('begin_connector_handoff(uuid,text,text)'),
      ('decide_case(uuid,text,text,text,jsonb,text,text)'),
      ('decide_rule(uuid,text)'),
      ('edit_rule(uuid,text)'),
      ('ensure_owner_tenant()'),
      ('get_calendar_test_state(uuid)'),
      ('get_connector_status(uuid)'),
      ('grant_power(uuid,text,text,text,jsonb,numeric,timestamp with time zone)'),
      ('reset_owner_test_memory()'),
      ('revoke_power(uuid)'),
      ('revoke_rule(uuid,text)')
    ) expected(signature)
    order by signature
  ),
  'authenticated can execute only owner-authorized RPCs'
);

select extensions.ok(
  array(
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('service_role', p.oid, 'execute')
    order by 1
  ) = array(
    select signature from (values
      ('authorize_booking_intent(uuid,uuid,uuid,uuid,uuid,numeric,integer,integer,jsonb,text)'),
      ('begin_calendar_test_attempt(uuid,text,text,text,text,text)'),
      ('begin_provider_write(uuid,uuid)'),
      ('booking_provider_input(uuid)'),
      ('begin_phone_provider_accept(uuid,uuid)'),
      ('begin_phone_sideband(uuid,uuid)'),
      ('begin_phone_termination(uuid,uuid,text,text,text)'),
      ('begin_provider_termination_attempt(uuid,text,text,text)'),
      ('claim_budget_reconciliation(text)'),
      ('claim_phone_event(uuid,text)'),
      ('claim_phone_lifecycle_reconciliation(text)'),
      ('claim_provider_termination_reconciliation(text)'),
      ('complete_phone_termination(uuid,uuid,boolean,text)'),
      ('complete_provider_termination_attempt(uuid,uuid,boolean,text)'),
      ('confirm_phone_provider_accept(uuid,uuid)'),
      ('confirm_phone_sideband(uuid,uuid)'),
      ('claim_intent(text)'),
      ('consume_connector_handoff(uuid,text,uuid,uuid)'),
      ('consume_oauth_state(text,text,uuid,uuid,text)'),
      ('consume_slot_offer(uuid,uuid,text,integer,integer,text,text)'),
      ('get_booking_confirmation(uuid,uuid,uuid)'),
      ('get_booking_provider_input(uuid)'),
      ('get_contact_hash_requirements(uuid)'),
      ('heartbeat_phone_sideband(uuid,uuid)'),
      ('prepare_booking_provider_write(uuid,uuid)'),
      ('persist_phone_call(uuid,uuid,uuid,text)'),
      ('finalize_phone_sideband(uuid,uuid,jsonb)'),
      ('defer_phone_sideband_finalization(uuid,uuid,text)'),
      ('provision_tenant_owner(uuid,uuid)'),
      ('purge_ephemeral_call_data(timestamp with time zone,timestamp with time zone)'),
      ('reap_abandoned_calls(integer)'),
      ('record_booking_delivery(uuid,uuid,text,text,text,jsonb,text,jsonb,jsonb)'),
      ('record_calendar_test_result(uuid,text,text,jsonb,text)'),
      ('record_onboarding_answer(uuid,uuid,uuid,text,text,text,integer,jsonb,uuid,jsonb)'),
      ('record_onboarding_followup(uuid,uuid,uuid,text,integer,text,text,jsonb)'),
      ('record_onboarding_voice_approval(uuid,uuid,uuid,text,text,integer,text,text)'),
      ('release_health_state(uuid,text)'),
      ('reserve_call_budget(uuid,uuid,numeric)'),
      ('reserve_phone_call_budget(uuid,uuid,numeric)'),
      ('repair_legacy_phone_links()'),
      ('settle_call_budget(uuid,uuid,numeric,numeric,text,jsonb)'),
      ('settle_unresolved_call_budget(uuid,uuid,numeric,numeric,text,jsonb)'),
      ('transition_claimed_intent(uuid,uuid,text,text,integer)')
    ) expected(signature)
    order by signature
  ),
  'service_role can execute only current internal RPCs'
);

select extensions.ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
  ),
  'anon cannot execute public functions'
);

select extensions.ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype = 'trigger'::regtype
      and (
        has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('service_role', p.oid, 'execute')
      )
  ),
  'trigger functions are not directly executable through Data API roles'
);

select extensions.ok(
  array(
    select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v')
      and has_table_privilege('authenticated', c.oid, 'select')
    order by 1
  ) = array(
    select relation from (values
      ('action_intents'),
      ('approval_cases'),
      ('bookings'),
      ('budget_reservations'),
      ('calls'),
      ('communications'),
      ('contact_opt_outs'),
      ('effective_rules'),
      ('notifications'),
      ('owner_profiles'),
      ('powers'),
      ('receipts'),
      ('rules'),
      ('skill_candidates'),
      ('skill_pipeline_events'),
      ('tenant_provisioning_receipts'),
      ('tenants'),
      ('usage_ledger')
    ) expected(relation)
    order by relation
  ),
  'authenticated Data API SELECT grants are explicit and complete'
);

select extensions.ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v')
      and (
        has_table_privilege('authenticated', c.oid, 'insert')
        or has_table_privilege('authenticated', c.oid, 'update')
        or has_table_privilege('authenticated', c.oid, 'delete')
        or has_table_privilege('authenticated', c.oid, 'truncate')
      )
  ),
  'authenticated has no direct public-table mutation grants'
);

select extensions.ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v')
      and has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')
  ),
  'anon has no public relation privileges'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.connector_accounts', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.connector_accounts', 'select,insert,update,delete')
  and not has_table_privilege('anon', 'public.oauth_states', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.oauth_states', 'select,insert,update,delete'),
  'connector tables are inaccessible to anon and authenticated'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.connector_handoff_intents', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.connector_handoff_intents', 'select,insert,update,delete')
  and not has_table_privilege('anon', 'public.calendar_test_receipts', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.calendar_test_receipts', 'select,insert,update,delete'),
  'handoff intents and calendar test receipts are inaccessible to anon and authenticated'
);

select extensions.ok(
  exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.relname = 'tenants_one_v0_2_tenant_per_owner'
      and i.indisunique
      and i.indpred is not null
  ),
  'one V0.2 bootstrap tenant per owner is enforced by a partial unique index'
);

select extensions.ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenants'::regclass
      and conname = 'tenants_status_check'
      and convalidated
      and pg_get_constraintdef(oid) like '%onboarding%'
  )
  and exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenants'::regclass
      and conname = 'tenants_operational_mode_check'
      and convalidated
  ),
  'tenant lifecycle and operational mode constraints are valid'
);

select extensions.ok(
  has_table_privilege('service_role', 'public.connector_accounts', 'select,insert,update')
  and not has_table_privilege('service_role', 'public.connector_accounts', 'delete')
  and has_table_privilege('service_role', 'public.oauth_states', 'select,insert,update')
  and not has_table_privilege('service_role', 'public.oauth_states', 'delete'),
  'service_role connector-table grants are explicit'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.effective_rules', 'select')
  and has_table_privilege('service_role', 'public.effective_rules', 'select')
  and not has_table_privilege('anon', 'public.effective_rules', 'select'),
  'effective_rules is readable only by authenticated and service roles'
);

select extensions.ok(
  exists (select 1 from pg_extension where extname = 'pgcrypto')
  and exists (select 1 from pg_extension where extname = 'btree_gist'),
  'pgcrypto and btree_gist are installed'
);

select extensions.ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.booking_slot_leases'::regclass
      and conname = 'booking_slot_leases_tenant_id_slot_range_excl'
      and contype = 'x'
      and convalidated
  )
  and exists (
    select 1 from pg_constraint
    where conrelid = 'public.connector_accounts'::regclass
      and conname = 'connector_accounts_active_encrypted_check'
      and contype = 'c'
      and convalidated
  )
  and exists (
    select 1 from pg_constraint
    where conrelid = 'public.receipts'::regclass
      and conname = 'receipts_onboarding_shape_check'
      and contype = 'c'
      and convalidated
  )
  and not exists (
    select required.name
    from (values
      ('receipts_onboarding_event_key_unique'),
      ('receipts_onboarding_coverage_revision_unique'),
      ('receipts_onboarding_approval_snapshot_unique')
    ) required(name)
    where not exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname = required.name and i.indisunique and i.indpred is not null
    )
  )
  and exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.relname = 'receipts_onboarding_answer_hash_lookup'
      and not i.indisunique
      and i.indpred is not null
  )
  and not exists (
    select 1 from pg_class c
    where c.relname = 'receipts_onboarding_answer_hash_unique'
  ),
  'booking, connector, and onboarding receipt constraints are valid'
);

select extensions.ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.contact_opt_outs'::regclass
      and conname = 'contact_opt_outs_hash_metadata_check'
      and convalidated
  )
  and exists (
    select 1 from pg_constraint
    where conrelid = 'public.communications'::regclass
      and conname = 'communications_hash_metadata_check'
      and convalidated
  ),
  'contact hash metadata constraints are valid'
);

select extensions.ok(
  array(
    select t.tgname::text
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    order by 1
  ) @> array[
    'action_intents_booking_payload_guard',
    'powers_auth_epoch',
    'rules_append_only',
    'rules_policy_epoch',
    'slot_offers_private_policy_guard',
    'tenant_provisioning_receipts_append_only'
  ],
  'booking, append-only, and authority epoch triggers exist'
);

select extensions.ok(
  not has_function_privilege('service_role', 'public.prepare_booking_provider_write(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.release_booking_slot_lease(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.commit_booking_slot_lease(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.validate_booking_intent_authority(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.validate_booking_intent_authority(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.validate_booking_intent_authority(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.enforce_slot_offer_private_policy()', 'execute')
  and not has_function_privilege('anon', 'public.enforce_slot_offer_private_policy()', 'execute')
  and not has_function_privilege('authenticated', 'public.enforce_slot_offer_private_policy()', 'execute'),
  'removed booking RPCs are not executable by service_role'
);

select extensions.ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'connector_accounts'
      and column_name = 'refresh_token'
  ),
  'the connector plaintext column is absent after the final migration'
);

select extensions.ok(
  (select count(*) = count(distinct version) from supabase_migrations.schema_migrations),
  'migration history contains no duplicate version'
);

select extensions.ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and has_table_privilege('authenticated', c.oid, 'select')
      and (not c.relrowsecurity or not c.relforcerowsecurity)
  ),
  'every authenticated-exposed table has RLS and FORCE RLS'
);

select extensions.ok(
  not exists (
    select 1
    from (values
      ('tenants', 'select'), ('tenants', 'insert'),
      ('rules', 'select'), ('rules', 'insert'),
      ('approval_cases', 'select'), ('approval_cases', 'insert'), ('approval_cases', 'update'),
      ('calls', 'select'), ('calls', 'insert'), ('calls', 'update'),
      ('usage_ledger', 'select'),
      ('powers', 'select'),
      ('bookings', 'select'), ('bookings', 'update'),
      ('notifications', 'select'), ('notifications', 'insert'),
      ('fake_calendar_events', 'select'), ('fake_calendar_events', 'insert'),
      ('browser_session_requests', 'select'), ('browser_session_requests', 'insert'), ('browser_session_requests', 'update'),
      ('phone_events', 'select'), ('phone_events', 'insert'), ('phone_events', 'update'),
      ('communications', 'select'),
      ('contact_opt_outs', 'select'),
      ('skill_candidates', 'select'), ('skill_candidates', 'insert'), ('skill_candidates', 'update'),
      ('skill_pipeline_events', 'insert'),
      ('budget_reservations', 'select'), ('budget_reservations', 'update'),
      ('booking_quotes', 'select'), ('booking_quotes', 'insert'),
      ('slot_offers', 'insert'),
      ('effective_rules', 'select'),
      ('connector_accounts', 'select'), ('connector_accounts', 'insert'), ('connector_accounts', 'update'),
      ('connector_handoff_intents', 'select'), ('connector_handoff_intents', 'insert'), ('connector_handoff_intents', 'update'),
      ('calendar_test_receipts', 'select'), ('calendar_test_receipts', 'insert'), ('calendar_test_receipts', 'update'),
      ('owner_profiles', 'select'),
      ('oauth_states', 'select'), ('oauth_states', 'insert'), ('oauth_states', 'update'),
      ('phone_lifecycle_legacy_conflicts', 'select'), ('phone_lifecycle_legacy_conflicts', 'insert'), ('phone_lifecycle_legacy_conflicts', 'update'),
      ('receipts', 'select'),
      ('onboarding_locality_registry', 'select')
    ) required(relation, privilege)
    where not has_table_privilege('service_role', format('public.%I', relation), privilege)
  ),
  'service_role has every explicit direct runtime relation grant'
);

select extensions.ok(
  has_table_privilege('service_role', 'public.receipts', 'select')
  and not has_table_privilege('service_role', 'public.receipts', 'insert')
  and not has_table_privilege('service_role', 'public.receipts', 'update')
  and not has_table_privilege('service_role', 'public.receipts', 'delete')
  and not has_table_privilege('service_role', 'public.receipts', 'truncate')
  and not has_table_privilege('anon', 'public.receipts', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.receipts', 'insert,update,delete'),
  'receipt ledger grants are least-privilege and keep owner reads RLS-bound'
);

select extensions.ok(
  has_table_privilege(
    'service_role', 'public.onboarding_locality_registry', 'select'
  )
  and not has_table_privilege(
    'service_role', 'public.onboarding_locality_registry',
    'insert,update,delete,truncate,references,trigger'
  )
  and not has_table_privilege(
    'anon', 'public.onboarding_locality_registry',
    'select,insert,update,delete'
  )
  and not has_table_privilege(
    'authenticated', 'public.onboarding_locality_registry',
    'select,insert,update,delete'
  )
  and (select count(*) from public.onboarding_locality_registry) = 13,
  'locality registry is seeded and service-role read-only'
);

select extensions.ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v')
      and has_table_privilege('service_role', c.oid, 'delete,truncate,references,trigger')
  ),
  'service_role has no unneeded destructive or DDL-adjacent relation grants'
);

select * from extensions.finish();
rollback;
