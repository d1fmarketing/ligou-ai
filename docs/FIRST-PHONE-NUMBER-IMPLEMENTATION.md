# First phone number preparation

Goal: prepare one explicitly assigned US local voice number for one pilot business, using the existing Twilio SIP → OpenAI → signed Edge webhook → durable phone worker path. Number purchase, carrier routing activation and real-call acceptance are separate milestones.

## Scope and interfaces

- Preserve the website, public sales worker, owner authentication, Ash voice, operational permissions and existing customer budget enforcement.
- Add a private singleton `phone_inbound_configuration`, initially disabled and unassigned. Service-only configuration binds an E.164 number to a tenant UUID; no default-tenant fallback. The first pilot is limited to one concurrent phone call and at most five minutes per call.
- Extend the existing fenced phone claim with the persisted called number and authoritative binding result. Claim, call persistence and provider acceptance verify the binding. Unknown/disabled/busy routes are rejected before customer rules or budgeted model use.
- Extract and test the actual `accept-call` HTTP handler: POST only, bounded body, strict Standard Webhooks signature/timestamp, safe JSON/event parsing, canonical called number and bounded persistence. Missing secrets fail closed. Raw caller identifiers remain excluded from durable metadata.
- Add a read-only first-number operator CLI. It prepares exact configuration steps and inspects explicitly supplied Ligou Twilio credentials, account state, candidate/owned numbers and trunk settings. It cannot purchase, release, port, or activate numbers.
- Produce an independently buildable release artifact and an updated runbook distinguishing local proof, installed code, configured provider resources and actual carrier-call acceptance.

## Execution checklist

- [x] Reproduce webhook and explicit-routing gaps with tests.
- [x] Implement private binding and guarded lifecycle transitions; run real isolated PostgreSQL regression checks.
- [x] Implement and test the signed HTTP boundary and phone controller's explicit route handling.
- [x] Implement and test the read-only setup checker, including failure paths and no provider mutations.
- [x] Run relevant existing voice, Edge, database and release verification; independently review the changes.
- [x] Install only safe inactive preparation where the live account/runtime preconditions are verified. Preserve rollback and all existing records. Leave number purchase and traffic activation untouched.
- [ ] Deliver exact readiness, verified receipts and remaining external inputs.

## Verified before release

- 78 migrations passed the current isolated full database gate, including private binding/RLS and three webhook-to-controller integration scenarios. The dedicated QA VM configuration was restored afterward.
- All 57 voice test files passed; focused suites cover 10 webhook, 27 phone lifecycle and 32 sideband cases. Eight read-only setup checker cases and 21 release infrastructure cases passed.
- Deno's frozen strict Edge check passed. Independent code review confirmed the routing, absolute deadline, bounded RPC and provider inspector fixes.
- No real Twilio number, carrier call or incoming OpenAI webhook registration is represented by these tests.

The inactive deployment and final readiness receipt are recorded separately so release evidence cannot be confused with source-level test evidence.

## Inactive installation receipt — 2026-09-05

- Controller source commit: `8de9bc2c63bb17de04ac993257dded4dbfec9cf6`.
- Authenticated release artifact SHA-256: `04976beee3b8997da991f7b0f74921adfbc830be28d76e43a31d29832d0e5255`.
- Installed on the existing Ligou host; health readback reports controller, Supabase and Hermes ready. Sales remains active; previously inactive discovery supervisor remains inactive. Previous controller release is preserved.
- Migration `20260905215424_first_phone_number_binding.sql` applied. Live readback: disabled, no tenant, no phone number, max five minutes, forced RLS, no anon/authenticated table access or configuration execution.
- `accept-call` Edge version 8 active with its explicit import map and signature authentication (gateway JWT verification disabled). Provider bundle SHA-256: `d5fd6525e089242fc509b70f8e601608ad107e092ab1ee94d3419812dcfbf5f5`.
- Live probes: GET → 405; unsigned POST while signing secret absent → 503 `phone_webhook_unavailable`. No event or call generated.
- Stable contact-hashing key prepared in the private parameter store, Edge secrets and controller environment. Existing environment preserved; mode 0600. No secret values in receipts.
- Setup still needs dedicated Twilio access, the matching OpenAI project ID and incoming webhook signing secret, selected business, and an authorized number purchase/connection. No number acquired, bound or activated by this task.
- Real carrier call acceptance and database-outage duration/failover behavior remain unverified. See the runbook before enabling customer traffic.

Detailed sanitized receipts: `output/first-phone/`. The full schema gate retains one existing lint warning and 152 informational advisor notices; no advisor warnings/errors were introduced. Source tests and live deployment health are distinct from carrier acceptance.
