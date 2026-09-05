# First inbound phone number — operator runbook

This prepares one US local voice number for one owned pilot business. The path is PSTN → Twilio Elastic SIP Trunk → OpenAI Realtime → signed `accept-call` webhook → durable controller. Browser voice success does not prove this carrier path.

## Prepared software

- Private `phone_inbound_configuration` starts disabled and unassigned. There is no default-business fallback.
- Only the service role can call `configure_first_phone_number(p_tenant_id, p_phone_number, p_enabled, p_max_minutes)`; use five minutes for the first test. Enabling requires an active, owned tenant.
- One concurrent phone call. Unknown, disabled, unavailable or busy routes reject before business instructions/model acceptance.
- Signed incoming webhook, bounded payload and timeouts, hashed caller identifiers, durable budget/termination lifecycle, and greeting only after sideband activation.
- Read-only `bun run phone:plan` and `bun run phone:inspect` prepare and verify provider settings; they cannot buy, port, release or activate a number.

## External setup inputs

Use a dedicated Ligou account/subaccount; do not borrow another business's credentials. Provide these through private environment configuration, never Git or logs:

- `LIGOU_TWILIO_ACCOUNT_SID`
- `LIGOU_TWILIO_API_KEY_SID` + `LIGOU_TWILIO_API_KEY_SECRET`, or `LIGOU_TWILIO_AUTH_TOKEN`
- `LIGOU_OPENAI_PROJECT_ID` for the same project whose API credentials the controller uses
- `LIGOU_PHONE_TENANT_ID` for the selected approved business
- `LIGOU_SUPABASE_URL`
- `LIGOU_PHONE_AREA_CODE` when looking for candidates, or `LIGOU_PHONE_NUMBER` for an owned number
- Optional expected `LIGOU_TWILIO_TRUNK_SID`

Server-side `OPENAI_WEBHOOK_SECRET` must be the provider-generated secret for this incoming-call webhook. `CONTACT_HASH_KEY` is a separate stable 32-byte key shared by Edge/controller: preserve the existing key; do not generate a replacement during routine setup. `SERVICE_KEY` remains server-side.

## Connection sequence

1. Run `phone:plan`; resolve missing inputs. With dedicated credentials, `phone:inspect` can list candidate US local voice numbers. Candidate availability is not a reservation.
2. Review the exact number and recurring/usage costs before the separately authorized purchase. Existing numbers can be inspected without purchase or porting.
3. Register the OpenAI `realtime.call.incoming` webhook at the plan's `/functions/v1/accept-call` URL. Configure the returned signing secret in Edge. Its JWT gateway check must be disabled; the handler verifies the OpenAI signature itself.
4. Configure the dedicated Twilio trunk with the exact plan SIP URI: `sip:proj_ID@sip.api.openai.com;transport=tls`. Enable secure trunking; recording off, transfers disabled, no unreviewed failover destination. Attach only the selected number. `phone:inspect` requires a single matching enabled origination route and matching account/number/trunk identities.
5. Configure the binding with the plan's service-only RPC payload, initially `p_enabled=false`. Read it back privately. No public dashboard should expose this table.
6. Confirm active controller release, both required webhook secrets, model access, tenant policy/budget and no unresolved previous phone event. Enable the same binding only for the agreed test window.
7. Make an authorized real call. Verify correct business greeting and language, interruption, response latency, recorded summary/contact accuracy, exceptions/permissions, budget reservation and final provider termination. Test an early hangup and maximum-duration behavior. Do not exercise real external actions during a demonstration.
8. Reconcile provider call state, database call/event state and budget settlement. A successful setup inspector or local test is not carrier acceptance. Customer traffic starts only after this real-path check.

## Limits, failover and rollback

The five-minute deadline includes provider acceptance/setup time. Backend termination requires durable authorization to prevent duplicate provider actions. A total database outage can prevent that authorization; a carrier-side hard duration/failover guarantee is not yet proven. Validate this failure mode and a provider-side bound before customer traffic, rather than adding an unfenced emergency hangup.

Disable intake using the service-only configuration RPC with the same tenant/number and `p_enabled=false`; this preserves calls/leads and lets active-call termination reconcile. Do not delete events or release budget holds manually. Binding reassignment is blocked while a call is unresolved.

Keep the authenticated release artifact and previous controller release for rollback. The schema migration is additive and should remain in place during code rollback. Restore only the affected Edge function from its preserved source/artifact; other Edge functions, sales service and website need no redeploy.

## Verification evidence

See `FIRST-PHONE-NUMBER-IMPLEMENTATION.md` and the task's `output/first-phone/` receipts. Tests cover real isolated PostgreSQL/Supabase routing with simulated external provider transport; they do not call a real number.
