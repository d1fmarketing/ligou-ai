# OpenClaw Company Discovery Stage 0 Security Evidence

Canonical scan ID: `152cd839-8033-4658-a099-921425255753`

Canonical target: `120c98eea6b79434bdc670600d9de25bcc7fc7bf..11f628c2bb79b2b52d96b745dcef71c99d71efa3`

Canonical report SHA-256: `030bfc7bef40736cc363aebb44c0a9c8dde151d67354b73ef1ef8b7b1539c872`

The native workbench marked publication failed before the manifest existed. The preserved draft was completed in the same scan directory with the plugin's official `finalize_scan_contract.py`, then `validate_scan_contract.py` returned `status: valid`. The report below is the deterministic projection of that sealed contract.

# Security Review: Ligou.AI

## Scope

Security diff review of Ligou OpenClaw Company Discovery Stage 0 from 120c98eea6b79434bdc670600d9de25bcc7fc7bf to 11f628c2bb79b2b52d96b745dcef71c99d71efa3.

- Scan mode: branch_diff
- Target kind: git_diff
- Target ID: target_sha256_4159e1cf74f938bd55f305098d78f9ee7b48b1ad36b39973f74ac90788bd194e
- Revision range: 120c98eea6b79434bdc670600d9de25bcc7fc7bf...11f628c2bb79b2b52d96b745dcef71c99d71efa3
- Snapshot digest: codex-security-snapshot/v1:sha256:fa010ef5e7bfa171990c630630e0d4d960b76f97e9c0b32e57a6009a7aaa392b
- Inventory strategy: diff
- Included paths: .
- Excluded paths: none
- Runtime or test status: AMD64 12/12 benchmark attempts and ARM64 synthetic qualification passed with complete cleanup.
- Artifacts reviewed: discovery-supervisor/src/\*\*, discovery-supervisor/openclaw/\*\*, discovery-supervisor/benchmark/\*\*, infra release and service changes, Stage 0 and summary subscription migrations, voice summary subscription runtime, all changed security, integration, migration, cleanup, and benchmark tests
- Scan context: OpenClaw is treated as an untrusted ephemeral worker. Ligou owns tenant identity, evidence, policy, result validation, actions, approvals, and cleanup.

Limitations and exclusions:
- No kernel or container-runtime exploit testing.
- External provider internals are pinned and black-box validated rather than source audited.
- Production rollout is a separate post-scan gate.
- Excluded discovery-supervisor/benchmark/corpus/\*.json: Public benchmark evidence only; reviewed for parser and authority-shaped content, with no production execution.
- Excluded \*\*/test/\*\* and \*\*/\*.test.\*: Validation artifacts were used as counterevidence rather than treated as production entrypoints.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 0 |
| Severity mix | none |
| Confidence mix | none |
| Coverage | complete |
| Validation mode | Source review, deterministic tests, isolated PostgreSQL gates, real OAuth benchmark, live Fetch Gateway, multi-architecture Docker qualification, and ECR scanning. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Hostile public evidence and model output must remain unable to choose tenant, access provider credentials, reach private networks, mutate policy, escape the cell, commit stale results, or survive cleanup.

### Assets

- Tenant identity and cross-tenant data
- Hermes subscription bearer
- Supabase service-role data
- Company policy and owner approvals
- Docker host authority
- Evidence and cleanup receipts

### Trust Boundaries

- Public web to Fetch Gateway
- Supervisor to OpenClaw cell
- Cell to trusted bridge
- Bridge UDS to subscription proxy
- Supervisor to Hermes
- Service RPC to Postgres
- Signed release to systemd

### Attacker Capabilities

- Hostile website text, links, redirects, and DNS
- Prompt injection and malformed tool output
- Retries, cancellation, duplicate delivery, and stale completion
- Bounded resource contention

### Security Objectives

- No cross-tenant authority
- No provider credential exposure
- No private-network SSRF
- No model-authored activation
- Bounded consumption
- Complete teardown and late-result rejection
- Signed reproducible rollback

### Assumptions

- Host root, Docker, kernel, AWS IAM, and pinned images are trusted infrastructure.
- Pinned Node, Bun, and image identities match release evidence.
- Discovery remains default-off until an explicit allowlist decision.

## Findings

### No findings

No reportable findings survived the canonical discovery, validation, and reportability gates.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Tenant and attempt authority | Cross-tenant BOLA, stale commits, and cleanup substitution | Rejected | Exact DB claim readbacks, store-local opaque capabilities, monotonic fences, result snapshot equality, and resource release counts reject cross-tenant and stale mutations. |
| Public web Fetch Gateway | SSRF, DNS rebinding, redirect escape, and response bombs | Rejected | Canonical HTTPS, CNAME limits, public-address filtering, per-hop re-resolution, registrable-domain containment, pinned peer equality, and MIME, encoding, byte, and deadline bounds close the candidate path. |
| Hermes OAuth subscription boundary | Provider bearer exposure | Rejected | Sensitive helper stdout, pinned Hermes runtime identity, distinct attempt markers, UDS authentication, and a fixed upstream endpoint keep the bearer outside the cell. |
| Ephemeral OpenClaw cell isolation | Container escape and ambient authority | Rejected | Digest pins, non-root read-only containers, dropped capabilities, no-new-privileges, bounded resources, internal cell networking, fixed mounts, and deny-by-default tools close application-layer escape paths. |
| Model and MCP output validation | Malformed or authority-shaped output | Rejected | The non-strict provider schema remains non-authoritative; parseWorkerResult, exact source snapshots, single accepted submission, and atomic output writing are mandatory at the Ligou sink. |
| Gateway retry and relay resource bounds | Resource exhaustion | Rejected | Exact loopback URLs, pre-hello-only retry classification, connection caps, pairwise socket destruction, cancellation, and per-attempt deadlines bound the candidate path. |
| Cleanup and recovery | Orphaned authority and late results | No issue found | Adapter-specific cleanup proofs, inspect-after absence, UDS revocation, exact resource reservations, slot quarantine, and late-result rejection were covered. |
| Release, rollback, and voice summary subscription | Unsigned drift, API-key misuse, and stale generation notifications | No issue found | Signed artifact identity, pinned toolchains, inactive-service preservation, rollback, summary lease tokens, tenant generation checks, and subscription-only text routing were reviewed. |
