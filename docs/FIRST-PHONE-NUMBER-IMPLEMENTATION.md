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
- [ ] Install only safe inactive preparation where the live account/runtime preconditions are verified. Preserve rollback and all existing records. Leave number purchase and traffic activation untouched.
- [ ] Deliver exact readiness, verified receipts and remaining external inputs.

## Verified before release

- 78 migrations passed the current isolated full database gate, including private binding/RLS and three webhook-to-controller integration scenarios. The dedicated QA VM configuration was restored afterward.
- All 57 voice test files passed; focused suites cover 10 webhook, 27 phone lifecycle and 32 sideband cases. Eight read-only setup checker cases and 21 release infrastructure cases passed.
- Deno's frozen strict Edge check passed. Independent code review confirmed the routing, absolute deadline, bounded RPC and provider inspector fixes.
- No real Twilio number, carrier call or incoming OpenAI webhook registration is represented by these tests.

The inactive deployment and final readiness receipt are recorded separately so release evidence cannot be confused with source-level test evidence.
