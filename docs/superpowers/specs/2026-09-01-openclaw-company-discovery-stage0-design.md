# OpenClaw Company Discovery Stage 0 Design

## Decision

Ligou owns tenant identity, truth, policy, authority, memory, actions,
approvals, evidence, release, and recovery. OpenClaw is an ephemeral,
non-authoritative worker that competes with a direct-model baseline for one
job type: `company_discovery.v1`.

Stage 0 is internal plus three to five allowlisted tenants. It never enables
paid-customer rollout or Stage 1. Stage 1 remains blocked until a fresh
Portuguese voice E2E proves the complete audible-summary, approval, signoff,
hangup, provider-confirmation, and dashboard-ended chain.

## Runtime boundary

```text
Authenticated owner
      |
      v
Ligou job RPCs -> worker_jobs / worker_attempts / fencing
      |
      v
Discovery Supervisor (trusted)
  | tenant/job identity, budgets, leases, Gateway credential
  | persistence, result validation, teardown, cleanup receipts
  |
  +--> DirectModelDiscoveryAdapter -------------------+
  |                                                   |
  +--> OpenClawDiscoveryAdapter                       |
         | one digest-pinned cell per attempt         |
         | no Ligou credential                        |
         | no host browser/filesystem/general egress  |
         | only two local MCP tools                   |
         +--------------------------------------------+
                                                      v
                                       Ligou Discovery Fetch Gateway
                                       DNS/SSRF/redirect/domain/size caps
                                                      |
                                                      v
                                              Public HTTPS site
```

The supervisor owns the OpenClaw Gateway connection and attempt-local
credential. The cell receives no Supabase, Twilio, calendar, CRM, AWS, or
Ligou result-upload credential. A local stdio MCP bridge exposes exactly:

- `fetch_discovery_page(url)`
- `submit_discovery_result(result)`

The bridge is bound to one attempt by process/socket identity. The supervisor
adds tenant, job, attempt, and fence identity after schema validation.

The cell has no direct general internet. Model-provider traffic is the only
required external path and must pass an attempt-scoped, supervisor-controlled
allowlist/proxy boundary. This path is runtime plumbing, not a model tool.

## Fixed WorkerBroker contract

```ts
type WorkerJobType = "company_discovery.v1";
type DiscoveryAdapterId = "openclaw" | "direct_model";

interface WorkerAdapter {
  supports(jobType: WorkerJobType): boolean;
  submit(job: WorkerJob): Promise<WorkerHandle>;
  cancel(handle: WorkerHandle): Promise<void>;
  status(handle: WorkerHandle): Promise<WorkerStatus>;
  result(handle: WorkerHandle): Promise<WorkerResult>;
}
```

No workflow language, dependency graph, worker messaging, persistent worker
memory, dynamic schema, marketplace, or autonomous action execution is in
scope.

`job_id` identifies one logical discovery request. Every execution gets a
unique `attempt_id` and increasing `attempt_number`. `fence_generation`
increases before cancellation, retry, or selection changes. Result commit
requires the exact current job, attempt, fence, and claim-token proof.

- Reusing the same owner idempotency key and request hash returns the same
  `job_id`.
- Reusing it with a different request fails closed.
- Retry creates a new attempt; attempts never merge implicitly.
- Only one validated result becomes selected.
- Superseded, cancelled, stale, destroyed, or late attempts remain auditable
  but cannot create claims.

## Database authority

New tenant-owned records:

- `worker_jobs`: logical job, immutable normalized origin, idempotency,
  version, fence, current/selected attempt, deadline, budget, fallback state.
- `worker_attempts`: attempt number, adapter, fence, lease/claim proof,
  runtime identity, provider metadata, terminal and cleanup state.
- `worker_results`: immutable schema-validated candidate result and hash.
- `worker_runtime_slots`: supervisor-owned host slot and quarantine state.
- `discovery_source_snapshots`: URL, retrieval time, HTTP status, MIME,
  byte length, content hash, bounded excerpt, crawl order/depth, provenance.
- `discovery_claims`: Ligou-assigned candidate ID, class, type, normalized
  value, evidence references, contradictions, uncertainty, version.
- `discovery_decisions`: append-only authenticated approve/edit/reject event.
- `business_profile_versions`: versioned descriptive profile facts.
- `company_discovery_controls` and `company_discovery_allowlist`: default-off
  kill switch and Stage 0 tenant gate.

All exposed tables use RLS and force RLS. Owner reads derive membership from
`auth.uid()`. Every mutation RPC derives tenant identity server-side. Service
worker RPCs are `SECURITY DEFINER`, use `search_path = ''`, revoke `PUBLIC`,
`anon`, and `authenticated`, and are granted only to `service_role`.

Owner RPCs:

- `submit_company_discovery(url, idempotency_key)`
- `cancel_company_discovery(job_id, expected_version)`
- `retry_company_discovery(job_id, expected_version)`
- `create_company_discovery_review_nonce(job_id, result_id, claim_ids)`
- `review_company_discovery_claims(job_id, result_id, expected_version,
  decisions, confirmation_nonce)`

Supervisor RPCs:

- `claim_company_discovery_attempt(worker_id, lease_seconds)`
- `commit_company_discovery_result(attempt_id, fence_generation,
  claim_token, result, result_hash)`
- `select_company_discovery_result(job_id, attempt_id, expected_version)`
- `record_company_discovery_cleanup(attempt_id, fence_generation,
  claim_token, proof)`
- `quarantine_company_discovery_slot(slot_id, reason, proof_hash)`

The grouped review RPC is atomic. It appends decisions, creates descriptive
profile versions, and sends operational/safety facts through the existing
versioned rule materialization path in one transaction. No pending discovery
row is visible through `effective_rules`.

## Fetch Gateway

Only owner-supplied HTTPS URLs are accepted. Stage 0 performs static HTML
fetching only; JavaScript rendering, cookies, login, uploads, downloads,
external search, PDFs, and authenticated state are excluded.

Fixed safety ceilings:

- HTTPS default port only; URL credentials and fragments rejected.
- Maximum 5 redirects, with full validation on every hop.
- Maximum CNAME depth 8; IPv4 and IPv6 resolution checked before each request.
- The request connects to the validated address and verifies the connected
  peer, while TLS SNI and hostname verification use the normalized host.
- Loopback, private, carrier-grade NAT, link-local, multicast, documentation,
  benchmark, reserved, unspecified, and cloud-metadata targets are rejected.
- All pages remain within the submitted registrable domain.
- `text/html` only; attachment responses and content sniffing mismatches fail.
- Maximum 25 pages, depth 2, 1 MiB per page, and 10 MiB per job.
- One request per second per origin; duplicate canonical URLs are skipped.
- Hard attempt deadline 10 minutes. Onboarding never waits for it: the owner
  can continue the Portuguese interview immediately and missing/disputed
  facts remain interview questions.

Every page is hostile evidence. Instructions in HTML cannot change system
prompts, tools, budget, tenant, job, fence, claim schema, or approval state.

## Result and claim contract

Workers may return only candidate facts, evidence locators, contradictions,
missing questions, and uncertainty. The schema contains no tenant ID,
canonical ID, policy group, approval, status, effective flag, policy hash, or
action-completion field.

Claim classes:

- `descriptive`: public identity/contact/marketing description; normal owner
  confirmation creates a profile version.
- `operational`: services, public prices, durations, territory, hours,
  guarantees, and booking restrictions; explicit group confirmation required
  before a new rule version can be approved.
- `safety_critical`: emergency, gas/CO, electrical, flooding, or other safety
  guidance; exact evidence and per-claim acknowledgement required.
- `owner_private`: minimum prices, discount authority, private exceptions,
  internal escalation, authority grants; never emitted as a fact. It can only
  appear as a Portuguese unanswered question.

Missing guarantees are questions, never inferred guarantees. Website prices
are public prices only. No worker output can activate policy automatically.

## Product behavior

The Portuguese review groups claims by class and business category. Each row
shows the proposed value, evidence URL/excerpt, contradiction/uncertainty,
and approve/edit/reject controls. Operational groups require an explicit
confirmation nonce. Safety claims require exact evidence acknowledgement.

The kill switch is disabled by default. Stage 0 submission requires both the
global switch and an active tenant allowlist entry. Disabled, failed,
unavailable, or expired discovery falls back immediately to the existing
Portuguese onboarding. Discovery results arriving later appear only as
suggestions and never overwrite answers already supplied by the owner.

## Isolation, cleanup, and release

OpenClaw is pinned to `2026.8.1`:

- image `ghcr.io/openclaw/openclaw@sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4`
- `@openclaw/gateway-client` `2026.8.1`
- `@openclaw/gateway-protocol` `2026.8.1`
- wire protocol `4`, with client/Gateway compatibility tested together

Every attempt receives unique profile, config/state/workspace/output paths,
Gateway credential, loopback port, network namespace, container name, and
fence generation. No Fleet, native Ligou plugin, automatic installation, or
automatic update is permitted.

Cleanup proves Gateway exit, container removal, state/workspace/output
removal, network removal, credential revocation, listener closure, and late
result rejection. Missing proof sets `cleanup_unresolved` and quarantines only
the affected runtime slot; healthy slots continue.

The release artifact adds the supervisor as a separately managed service.
Voice/controller, Hermes, Realtime, Twilio, Edge, and dashboard surfaces are
redeployed only when their bytes change. Stage 0 health requires supervisor
readiness but never an always-running OpenClaw cell.

## Qualification and verdict

Both adapters run the same synthetic, hostile, and three-to-five allowlisted
real-site corpus through the same Fetch Gateway. The report records claim
precision/recall against human-reviewed fixtures, contradiction and missing
question discovery, crawl completion, latency, CPU/RSS/storage, cleanup,
parallel saturation, model usage, and cost.

Final output is exactly one of:

- `OPENCLAW_COMPANY_DISCOVERY_STAGE0_GO`
- `OPENCLAW_COMPANY_DISCOVERY_STAGE0_NO_GO`

It includes source/deploy IDs, tests, independent review, isolation/cleanup
proof, comparison, costs, limitations, and one next action. Neither verdict
begins Stage 1.
