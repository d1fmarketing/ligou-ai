# Open Questions

An open question is not permission to make a convenient implementation assumption. Each item has a decision boundary and owner role.

## Blocking before any real tenant

| ID | Question | Why it matters | Required evidence / owner |
|---|---|---|---|
| OQ-001 | What identity provider and organization-membership implementation will secure the dashboard? | Approval authority depends on authenticated owner identity and revocation. | Cognito vs a contained OIDC/Better Auth option; session/CSRF/role spike. Security + platform. |
| OQ-002 | What legal basis and exact retention apply to raw transcripts, summaries, decisions, receipts, audit, and backups? | The proposed 30-day raw transcript limit alone is not a complete policy. | Counsel/privacy decision, data map, deletion/export drill. Product + legal + security. |
| OQ-003 | Does tenant one’s Google Workspace permit standard user OAuth offline access with the intended calendar owner? | The approved pilot excludes DWD and service-account ownership. | Real sandbox authorization, owner/subject verification, refresh/revoke test. Connector owner. |
| OQ-004 | Which voice provider passes Ligou’s task and safety gates? | Model quality determines customer experience but cannot own authority. | Identical bilingual/telephony/tool evaluation and measured usage. Voice evaluation owner. |
| OQ-005 | Which carrier passes inbound SIP, security, transfer-readiness, capacity, and portability gates? | Number and call-path choices can create operational lock-in. | Twilio/Telnyx spike and commercial confirmation. Telephony owner. |
| OQ-006 | Which durable workflow candidate is smallest while preserving required failure semantics? | In-memory execution can duplicate or lose customer actions. | DBOS vs Step Functions experiment. Workflow owner. |
| OQ-007 | What are the exact allowed service, time, geography, value, and emergency policies for pilot tenant one? | Deterministic policy cannot be invented by engineering or the model. | Owner-approved policy corpus and expected outcomes. Product/tenant owner. |
| OQ-008 | What customer wording is approved for pending, denied, failed, unknown, and confirmed states? | False completion is a high-risk product failure. | Product/legal copy plus voice-eval oracle. Product owner. |
| OQ-009 | What constitutes customer consent for transcript processing and contact follow-up in the operating jurisdictions? | Call privacy and communication obligations vary. | Legal review and scripted disclosure/consent states. Legal/product. |
| OQ-010 | What gross-margin floor and support allowance govern the pilot offer? | Provider choice and included minutes need a commercial constraint. | Approved economics plus measured support/call data. Finance/product. |

## Blocking before a second tenant

| ID | Question | Required evidence |
|---|---|---|
| OQ-020 | Does the logical-isolation topology pass adversarial tests with multiple real-shaped tenants? | Cross-tenant API/database/object/log tests under production-equivalent roles. |
| OQ-021 | Can one tenant’s traffic, malformed calls, or spend exhaust shared capacity? | Per-tenant quotas/fairness/load test and alarm drill. |
| OQ-022 | Can tenant export/deletion and OAuth/number offboarding complete without affecting another tenant? | End-to-end offboarding rehearsal including derived indexes and backup policy. |
| OQ-023 | Are tenant-specific prompts/policies/config changes versioned, reviewed, and reproducible? | Config/prompt release and rollback drill with audit. |
| OQ-024 | What support roles can access transcript/call evidence, and how is access approved/audited? | Least-privilege support workflow and access review. |

Domain-wide delegation is **not** automatically a “tenant two” question. If DWD becomes necessary for tenant one, its isolation, scopes, credential-compromise, audit, and blast-radius spike becomes blocking before tenant one.

## Important but non-blocking for the private pilot

| ID | Question | Current posture |
|---|---|---|
| OQ-030 | When does a tenant require physical database/account/service isolation? | Define risk/compliance tier before broader sales; shared logical pilot remains proposed. |
| OQ-031 | Should future escalation support live transfer, callback, or deny per rule? | Contract preserves modes; only `ASYNC_CASE` is enabled initially. |
| OQ-032 | Should Ligou support outbound consumer calls? | Deferred; requires separate consent, abuse, carrier, campaign, and product architecture. |
| OQ-033 | Is a parallel advisory STT path worth cost/complexity? | Decide only if it measurably reduces critical-field errors. |
| OQ-034 | When should Temporal/Hatchet replace a smaller workflow engine? | Only when concrete workflow/operator requirements exceed the selected engine. |
| OQ-035 | When GPT-Live-1 becomes selectable, does it outperform the incumbent under the same tests? | Horizon evaluation; no assumed compatibility or automatic migration. |
| OQ-036 | Which customer systems follow Google Calendar? | No connector roadmap until the calendar slice proves the Action Gateway. |
| OQ-037 | Should tenants receive dedicated encryption keys or regions? | Candidate higher-isolation tier; assess demand and compliance. |

## Decisions explicitly not reopened by implementation convenience

- The model never chooses raw calendar IDs.
- Point approval does not silently create reusable policy.
- Notification channels do not approve actions.
- Provider SDK state does not become AgentCore state.
- Audio is not recorded by default.
- DWD and outbound customer calling are not pilot shortcuts.
- Provider preference does not bypass evaluation gates.
