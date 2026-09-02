# Proposed Architecture Work Agents

Status: **proposed review roles only**. No agent defined here is running, authorized to mutate production, or allowed to approve its own work.

## Why separate roles

The architecture crosses voice quality, tenant isolation, authorization, external side effects, economics, and privacy. Parallel evidence collection can help, but final decisions must reconcile through the Decision Register and a human review. Agents produce evidence and drafts; RJ retains decision authority.

## Role matrix

| Role | Bounded responsibility | Required output | Prohibited shortcuts |
|---|---|---|---|
| Evidence Curator | Verify primary sources, repo revisions/licenses, claim dates, and contradictions | Evidence Register diff with confidence and source excerpts/links | No vendor ranking from marketing summaries; no status promotion |
| Domain Architect | Maintain invariants, contexts, source-of-truth map, data/contracts | Architecture/ADR proposal with consequences and alternatives | No provider types in domain model; no implementation |
| Tenant Isolation Reviewer | Design/run RLS, object, cache, log, and workload isolation tests | Reproducible adversarial report | No app-filter-only proof; no production credentials/data |
| Action/Workflow Reviewer | Test approval state, idempotency, retry, reconciliation, receipts, durable engines | Failure matrix and DBOS/Step Functions comparison | No happy-path-only demo; no unguarded provider retry |
| Voice Evaluation Lead | Maintain provider-neutral fixtures and measure call behavior | Versioned metrics with audio conditions/provider pins | No crown from unrelated benchmark; no real customer calls during spike |
| Telephony Reviewer | Compare inbound carrier security, quality, portability, capacity, usage | Twilio/Telnyx evidence scorecard | No selection from list price alone; no outbound scope expansion |
| Memory Safety Reviewer | Test provenance, policy separation, conflicts, retrieval, deletion, injection | Memory evaluation and residual risks | No autonomous policy creation; no global vector search |
| Security/Privacy Reviewer | Validate threat model, identity, OAuth, webhook, retention, IAM, supply chain | Findings with severity, reproduction, mitigation, owner | Cannot self-accept Critical/High risk; no DWD shortcut |
| Cost/Capacity Reviewer | Reconcile actual usage, AWS/carrier/model costs and busy-hour capacity | Sensitivity model with explicit assumptions | No RPM-to-concurrency inference; no omitted support/infra |
| Architecture Integrator | Reconcile outputs, contradictions, dependencies, and ADR statuses | Review-ready package and unresolved questions | Cannot silently turn experimental evidence into Accepted decision |

## Shared evidence envelope

Every role reports:

```text
scope and authority
pinned repository/provider/model/date/region
sources and confidence
commands or fixtures used
observed result versus inference
hard-gate outcome
security/privacy/cost impact
unknowns and contradictions
proposed ADR status change
files changed and cleanup performed
```

## Coordination rules

- One owner writes a given file at a time; reviewers submit findings rather than overlapping edits.
- Findings use stable IDs linked to Evidence Register, spike, threat, and ADR entries.
- A role cannot promote the technology it evaluated without independent review.
- Secrets, tokens, customer data, and raw audio never enter prompts, Git, or shared evidence artifacts.
- Read-only repository/cloud inspection is distinguished from mutation/provisioning.
- A blocked role reports the missing authority/evidence; it does not expand scope.
- Final architecture review is human-owned.

## Suggested execution waves

1. Evidence Curator + Domain Architect define claims/contracts.
2. Isolation, Action/Workflow, Voice, Telephony, and Memory roles run independent spikes.
3. Security/Privacy and Cost/Capacity challenge integrated results.
4. Architecture Integrator updates ADRs and produces GO/NO-GO dossier.
5. RJ reviews; no agent autonomously begins production.

This division is useful only when each task is concrete and bounded. It is not a reason to create a large agent organization before the first vertical slice proves the product.
