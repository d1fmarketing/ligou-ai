-- Forward-only ACL normalization for the new Data API default where SQL-created objects
-- are not auto-exposed. Direct browser access is read-only and RLS-bound; service_role
-- receives only the table verbs used by the deterministic runtime. Side effects stay RPC-only.

grant usage on schema public to anon, authenticated, service_role;

revoke all privileges on all tables in schema public from public, anon, authenticated, service_role;

grant select on table
  public.action_intents,
  public.approval_cases,
  public.bookings,
  public.budget_reservations,
  public.calls,
  public.communications,
  public.contact_opt_outs,
  public.effective_rules,
  public.notifications,
  public.powers,
  public.receipts,
  public.rules,
  public.skill_candidates,
  public.skill_pipeline_events,
  public.tenants,
  public.usage_ledger
to authenticated;

grant select on table
  public.approval_cases,
  public.booking_quotes,
  public.bookings,
  public.browser_session_requests,
  public.calls,
  public.communications,
  public.connector_accounts,
  public.contact_opt_outs,
  public.effective_rules,
  public.fake_calendar_events,
  public.notifications,
  public.oauth_states,
  public.phone_events,
  public.powers,
  public.rules,
  public.skill_candidates,
  public.tenants,
  public.usage_ledger
to service_role;

grant insert on table
  public.approval_cases,
  public.booking_quotes,
  public.browser_session_requests,
  public.calls,
  public.connector_accounts,
  public.fake_calendar_events,
  public.notifications,
  public.oauth_states,
  public.phone_events,
  public.rules,
  public.skill_candidates,
  public.skill_pipeline_events,
  public.slot_offers,
  public.tenants
to service_role;

grant update on table
  public.approval_cases,
  public.bookings,
  public.browser_session_requests,
  public.budget_reservations,
  public.calls,
  public.connector_accounts,
  public.oauth_states,
  public.phone_events,
  public.skill_candidates
to service_role;

revoke execute on all functions in schema public from public, anon, authenticated, service_role;

grant execute on function
  public.adjust_case(uuid,text),
  public.decide_case(uuid,text,text,text,jsonb,text,text),
  public.decide_rule(uuid,text),
  public.edit_rule(uuid,text),
  public.get_connector_status(uuid),
  public.grant_power(uuid,text,text,text,jsonb,numeric,timestamptz),
  public.revoke_power(uuid),
  public.revoke_rule(uuid,text)
to authenticated;

grant execute on function
  public.authorize_booking_intent(uuid,uuid,uuid,uuid,uuid,numeric,integer,integer,jsonb,text),
  public.begin_provider_write(uuid,uuid),
  public.booking_provider_input(uuid),
  public.claim_budget_reconciliation(text),
  public.claim_intent(text),
  public.consume_oauth_state(text,text,uuid,uuid,text),
  public.consume_slot_offer(uuid,uuid,text,integer,integer,text,text),
  public.get_booking_confirmation(uuid,uuid,uuid),
  public.get_booking_provider_input(uuid),
  public.get_contact_hash_requirements(uuid),
  public.prepare_booking_provider_write(uuid,uuid),
  public.provision_tenant_owner(uuid,uuid),
  public.purge_ephemeral_call_data(timestamptz,timestamptz),
  public.record_booking_delivery(uuid,text,text,text,jsonb,text,jsonb,jsonb),
  public.reserve_call_budget(uuid,uuid,numeric),
  public.settle_call_budget(uuid,uuid,numeric,numeric,text,jsonb),
  public.transition_claimed_intent(uuid,uuid,text,text,integer)
to service_role;
