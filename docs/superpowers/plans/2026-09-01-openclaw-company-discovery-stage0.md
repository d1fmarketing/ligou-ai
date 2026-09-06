# OpenClaw Company Discovery Stage 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement, qualify, and deploy a bounded `company_discovery.v1`
experiment in which OpenClaw and a direct-model baseline compete behind
Ligou-owned authority and web-fetch boundaries.

**Architecture:** A separate trusted discovery supervisor polls fenced
Supabase jobs, runs either a direct model or one ephemeral OpenClaw cell, and
uses one SSRF-resistant Ligou Fetch Gateway. Candidate claims remain staged
until an authenticated Portuguese grouped review materializes accepted facts
through Ligou's existing versioned policy path.

**Tech Stack:** TypeScript/Bun, PostgreSQL/Supabase RLS and RPCs, React/Vite,
Node DNS/TLS primitives, stdio MCP, OpenClaw Gateway `2026.8.1`, Docker,
AWS EC2/SSM, existing deterministic Ligou release tooling.

**Spec:** `docs/superpowers/specs/2026-09-01-openclaw-company-discovery-stage0-design.md`

## Global Constraints

- Only `company_discovery.v1`; no generalized workflow engine.
- OpenClaw is ephemeral and non-authoritative; no Ligou credential or direct
  general internet access enters a cell.
- No Fleet, persistent cells, native Ligou plugin, updates, live-call work,
  post-call automation, uploads/login, external search, Twilio/SMS/Stripe, or
  V0.3 work.
- Database identities, statuses, versions, hashes, policy groups, approvals,
  evidence, release, and recovery are assigned by Ligou.
- Stage 0 is default-off and limited to internal plus three-to-five
  allowlisted tenants. Stage 1 and paid-customer enablement are forbidden.
- Every production behavior follows RED-GREEN-REFACTOR and every task receives
  independent spec/quality review before the next begins.

---

### Task 1: Durable job, attempt, evidence, and review authority

**Files:**
- Create: `voice-controller/test/company-discovery-migration.test.ts`
- Create: `supabase/migrations/*_openclaw_company_discovery_stage0.sql`
- Modify: `voice-controller/scripts/run-unit-tests.mjs`
- Modify: `voice-controller/src/onboarding-materialization.ts`
- Modify: `voice-controller/src/rules.ts`

**Interfaces:**
- Produces the tables and exact owner/service RPCs defined by the design.
- Produces source-neutral provenance accepted by rule loading without a fake
  `source_call_id`.
- Review is atomic and zero pending claim can enter `effective_rules`.

- [ ] Write migration-contract tests that fail because the discovery migration
  and RPCs do not exist. Assert RLS/FORCE RLS, grants, empty search paths,
  tenant derivation, job/attempt fencing, immutable results/evidence,
  allowlist/kill switch, class confirmation, and zero auto-activation.
- [ ] Run `bun test test/company-discovery-migration.test.ts` and confirm the
  failure names the missing migration.
- [ ] Run `bunx supabase migration new openclaw_company_discovery_stage0`, then
  implement the schema/RPCs with the exact names in the design.
- [ ] Add source-neutral discovery materialization while keeping existing
  onboarding-call materialization behavior unchanged.
- [ ] Run the focused migration/materialization/rules tests, then
  `npm test` in `voice-controller`.
- [ ] Run `bun run db:gate:local` from the repository root and verify owner
  BOLA, service-role-only worker mutation, stale fence rejection, atomic
  grouped review, and effective-policy exclusion against real Postgres.
- [ ] Commit only Task 1 files with `feat: add company discovery authority`.

### Task 2: Fixed contracts, broker, store, and direct-model baseline

**Files:**
- Create: `discovery-supervisor/package.json`
- Create: `discovery-supervisor/bun.lock`
- Create: `discovery-supervisor/src/contracts.ts`
- Create: `discovery-supervisor/src/job-store.ts`
- Create: `discovery-supervisor/src/worker-broker.ts`
- Create: `discovery-supervisor/src/adapters/direct-model.ts`
- Create: `discovery-supervisor/test/contracts.test.ts`
- Create: `discovery-supervisor/test/worker-broker.test.ts`
- Create: `discovery-supervisor/test/direct-model.test.ts`

**Interfaces:**
- Produces `WorkerAdapter`, `WorkerJob`, `WorkerHandle`, `WorkerStatus`, and
  `WorkerResult` exactly as constrained by the design.
- `JobStore` calls only the Task 1 service RPCs and never accepts model-owned
  tenant/job/fence identity.

- [ ] Write failing contract tests for exact result keys and rejection of
  tenant IDs, canonical IDs, approval/effective/action fields, owner-private
  facts, malformed evidence, oversize values, and unbounded arrays.
- [ ] Write failing broker tests for the four methods, exact job-type support,
  adapter capability selection, cancellation, and result normalization.
- [ ] Write failing direct-model tests using fixed fetched-page fixtures and
  literal expected claims/questions; mock only the external model HTTP call.
- [ ] Implement the minimal contracts, store, broker, and direct adapter.
- [ ] Run all supervisor tests and mutation-check stale/forbidden fields.
- [ ] Commit with `feat: add bounded discovery worker broker`.

### Task 3: SSRF-resistant Ligou Discovery Fetch Gateway

**Files:**
- Create: `discovery-supervisor/src/fetch/url-policy.ts`
- Create: `discovery-supervisor/src/fetch/address-policy.ts`
- Create: `discovery-supervisor/src/fetch/https-client.ts`
- Create: `discovery-supervisor/src/fetch/html-page.ts`
- Create: `discovery-supervisor/src/fetch/discovery-fetch-gateway.ts`
- Create: `discovery-supervisor/test/fetch-gateway.test.ts`
- Create: `discovery-supervisor/test/fixtures/hostile-sites.ts`

**Interfaces:**
- Produces `DiscoveryFetchGateway.fetchPage(attemptContext, url)` and
  `crawl(attemptContext, originUrl)` returning bounded evidence snapshots.
- Both adapters consume these snapshots; neither performs its own fetch.

- [ ] Add exact pinned parser/public-suffix/IP dependencies to the supervisor
  lockfile; do not use floating versions.
- [ ] Write failing tests for HTTPS/port/userinfo rules, CNAME and IPv4/IPv6
  private/reserved ranges, DNS rebinding, peer mismatch, redirect escape,
  registrable-domain enforcement, MIME/attachment/size/depth/page/byte/rate
  caps, duplicate URLs, crawl loops, and hostile prompt text.
- [ ] Implement preflight DNS validation plus a TLS request pinned to the
  validated address, revalidating each redirect and verifying the peer.
- [ ] Implement static HTML extraction with no cookies, scripts, forms,
  downloads, authentication, or external navigation.
- [ ] Run focused tests and the supervisor suite; demonstrate at least one test
  fails if peer-address verification or redirect revalidation is removed.
- [ ] Commit with `feat: add contained discovery fetch gateway`.

### Task 4: Ephemeral OpenClaw supervisor and cleanup fencing

**Files:**
- Create: `discovery-supervisor/src/openclaw/runtime-identity.ts`
- Create: `discovery-supervisor/src/openclaw/mcp-bridge.ts`
- Create: `discovery-supervisor/src/openclaw/gateway-client.ts`
- Create: `discovery-supervisor/src/openclaw/cell-runtime.ts`
- Create: `discovery-supervisor/src/adapters/openclaw.ts`
- Create: `discovery-supervisor/src/supervisor.ts`
- Create: `discovery-supervisor/openclaw/openclaw.json`
- Create: `discovery-supervisor/openclaw/Dockerfile.bridge`
- Create: `discovery-supervisor/test/openclaw-runtime.test.ts`
- Create: `discovery-supervisor/test/cleanup.test.ts`

**Interfaces:**
- Uses image digest and exact Gateway packages from the design.
- MCP exposes only `fetch_discovery_page` and `submit_discovery_result`.
- Cleanup returns a proof object covering every resource named by the spec.

- [ ] Write failing tests for unique profile/state/workspace/output/port/network/
  container identity, tool-policy deny-by-default, absence of Ligou secrets,
  no direct fetch/browser/exec/filesystem tools, stale result rejection, and
  slot-local quarantine after ambiguous cleanup.
- [ ] Install exact Gateway client/protocol `2026.8.1` packages and commit the
  lockfile.
- [ ] Implement the attempt-local MCP bridge, Gateway client, cell lifecycle,
  OpenClaw adapter, and supervisor polling loop.
- [ ] Verify config and generated container command without Docker, then start
  Docker Desktop and run the pinned image in an isolated Stage 0 profile.
- [ ] Prove one successful attempt and forced failures at Gateway start, model
  call, result submission, cancellation, and every cleanup boundary. Confirm
  no listener/process/container/network/state/output survives.
- [ ] Commit with `feat: add ephemeral OpenClaw discovery worker`.

### Task 5: Portuguese grouped review, fallback, and kill switch

**Files:**
- Read first: `dashboard/AGENTS.md`
- Create: `dashboard/src/views/DiscoveryReviewView.jsx`
- Create: `dashboard/src/discovery-model.js`
- Create: `dashboard/tests/discovery-review.test.mjs`
- Modify: `dashboard/src/data/gateway.supabase.js`
- Modify: `dashboard/src/App.jsx`
- Modify: `dashboard/src/styles.css`
- Modify: `dashboard/package.json`

**Interfaces:**
- Uses Task 1 owner RPCs and owner-RLS status/result reads.
- Never waits for discovery before offering existing Portuguese onboarding.

- [ ] Write failing behavioral tests for grouped descriptive/operational/
  safety/private rendering, evidence/contradictions, per-claim edit/reject,
  nonce/step-up confirmation, stale-version errors, late suggestions, kill
  switch, allowlist refusal, failure fallback, and immediate interview CTA.
- [ ] Implement the minimal gateway mapping, state reducer, review view, and
  styles using the existing dashboard visual language.
- [ ] Run dashboard tests/build and inspect responsive 320, 430, 768, and 969
  pixel surfaces without changing the existing voice flow.
- [ ] Commit with `feat: add Portuguese discovery review`.

### Task 6: Benchmark and adversarial qualification harness

**Files:**
- Create: `discovery-supervisor/benchmark/corpus/*.json`
- Create: `discovery-supervisor/benchmark/run-benchmark.ts`
- Create: `discovery-supervisor/benchmark/score.ts`
- Create: `discovery-supervisor/test/benchmark.test.ts`
- Create: `docs/release/OPENCLAW-COMPANY-DISCOVERY-STAGE0-BENCHMARK.json`
- Create: `docs/release/OPENCLAW-COMPANY-DISCOVERY-STAGE0-BENCHMARK.md`

**Interfaces:**
- Runs both adapters over identical immutable Fetch Gateway snapshots.
- Emits per-attempt quality, contradiction, missing-question, crawl, latency,
  CPU/RSS/storage, cleanup, saturation, usage, and cost evidence.

- [ ] Write failing scoring tests with hand-derived expected outcomes for
  synthetic and hostile fixtures, including private-price non-inference.
- [ ] Implement the deterministic scorer and runner with raw result hashes.
- [ ] Freeze synthetic/hostile fixtures, then add three-to-five reviewed public
  real-company URL cases to the allowlist without customer credentials.
- [ ] Run both adapters sequentially and under bounded parallel saturation;
  retain every result/cleanup receipt and calculate costs from observed usage.
- [ ] Generate the machine-readable and human benchmark reports.
- [ ] Commit with `test: qualify discovery adapters`.

### Task 7: Deterministic release, full review, and Stage 0 rollout

**Files:**
- Modify: `infra/package-release.mjs`
- Modify: `infra/release-manifest.mjs`
- Modify: `infra/deploy-host.sh`
- Modify: `infra/release-health.sh`
- Modify: `infra/test/deploy-release.test.mjs`
- Modify: `infra/toolchain.json`
- Create: `infra/ligou-discovery-supervisor.service`
- Create: `docs/release/OPENCLAW-COMPANY-DISCOVERY-STAGE0.md`
- Create: `docs/release/OPENCLAW-COMPANY-DISCOVERY-STAGE0.json`

**Interfaces:**
- Adds the supervisor package/service and OpenClaw pins to immutable release
  evidence; health never requires a live ephemeral cell.
- Preserves automatic rollback and unchanged Edge/Hermes/voice behavior.

- [ ] Write failing release tests for supervisor inclusion, OpenClaw image and
  Gateway package pins, service install/restart/readiness, rollback, secret
  exclusion, and deterministic rebuild identity.
- [ ] Implement the minimal release/package/health changes and run focused
  release tests twice to prove deterministic artifacts.
- [ ] Run voice, onboarding, RLS/BOLA, security, Hermes, backup/restore,
  dashboard, migration/isolated Postgres, Edge compile/identity, release,
  secret scan, and `git diff --check` gates.
- [ ] Run task reviews plus one whole-branch independent review; fix all
  Critical/Important findings and require final `0 Critical / 0 Important`.
- [ ] Push the Stage 0 branch, capture a remote PostgreSQL pre-change backup,
  verify linked migration history, and apply only the new migration.
- [ ] Build/sign/upload the immutable artifact and activate changed EC2/SSM
  surfaces with automatic rollback. Do not redeploy unchanged Edge, Hermes,
  voice-provider, or dashboard bytes.
- [ ] Verify supervisor/database/allowlist/kill-switch health, one direct-model
  attempt, one OpenClaw attempt, cleanup, quarantine isolation, and rollback
  receipt. Keep Stage 0 default-off except the three-to-five allowlisted
  tenants.
- [ ] Write the final record and issue exactly
  `OPENCLAW_COMPANY_DISCOVERY_STAGE0_GO` or
  `OPENCLAW_COMPANY_DISCOVERY_STAGE0_NO_GO`, with one next action and no Stage
  1 work.
- [ ] Commit with `docs: record OpenClaw discovery Stage 0 verdict`.
