# Ligou MVP — Verification Evidence (2026-08-19)

Every claim below was produced by a runnable check, not assertion. Commands are reproducible from `voice-controller/`.

## Unit + integration suite — GREEN
`bun test` → **24 pass / 0 fail** across 3 files (tools, booking integration, learning). Covers: tri-state
receipts, server-issued idempotency, price-floor enforcement, powers deny-by-default, evidence redaction,
strict proposal validation.

## F1 — Voice policy (eval) — GREEN, both models 8/8
`bun run eval` (`docs/EVAL-F1.md`), Rocha Plumbing fixtures, text mode:
- **gpt-realtime-2.1-mini**: 8/8 · turn p50 851ms / p95 1993ms · $0.0097/run
- **gpt-realtime-2.1**: 8/8 · turn p50 1088ms / p95 2215ms · $0.0867/run
- Scenarios: price-from-rules (EN+ES), floor-held negotiation, flooding→case, gas/CO→case,
  prompt-injection→evidence-not-action, out-of-area refusal, unknown-service no-hallucination.

## F1 — Live session pipe — GREEN (real OpenAI Realtime call created)
Real browser WebRTC offer → controller `/session` (owner JWT) → verified full chain:
auth → tenant claim → **atomic budget reservation** ($1 reserved, usage recorded on close) →
ephemeral `ek_` mint → **SDP exchange with OpenAI accepted** → answer with `m=audio` →
call row got `openai_call_id: rtc_u7_...` (a real Realtime call) → sideband attached + finalized.
Only unexercised step = audio bytes (needs a microphone speaking) — a UX confirmation, not a correctness gate.
Test user + call purged after; seed tenant reset to unclaimed.

## F2 — Authority + booking — GREEN
`booking.integration.test.ts` (real Supabase): price floor rejected server-side → async case;
in-range close → `action_intent` → outbox → calendar insert → **receipt with read-back** (`accepted` only
with a confirmed external event) → booking `confirmed`; retry/timeout never double-books (idempotency_key).
Google Calendar uses the fake adapter until `GOOGLE_*` creds exist; the real googleapis adapter is coded.

## F4 — Learning loop — GREEN (mock brain, honors LLM=subscription rule)
`bun run scripts/prove-learning-e2e.ts`: finished call → `tickLearning` → redacted evidence → mock Hermes
proposals → suggested rules. Asserts: rule created `status=sugerido/origem=aprendizado`, customer fact
captured, caller's "50% off forever" **never** becomes a price rule, digit runs stay redacted.

## F5 — Onboarding interview — GREEN (stable across runs)
`bun run scripts/prove-onboarding-e2e.ts`: a brand-new HVAC tenant with zero rules is configured by a
Portuguese voice interview; `record_interview_answer` produces suggested rules spanning
**preco / area / agenda / emergencia**. No file hand-edited. Self-cleans append-only test data via
Management API (`session_replication_role=replica`).

## F3 — Infrastructure — LIVE
AWS account `330140023537`, us-east-1. EC2 `ligou-host-01` provisioned (bun, docker); `ligou-controller`
systemd service active with latest code; Hermes cell `ligou-cell-rocha-plumbing` Up (health 200);
deploy via `infra/deploy.sh` (commit limpo → pacote filtrado + manifesto HMAC → S3 → SSM, zero inbound
ports); o host verifica hash/commit, ativa diretório imutável, roda health funcional controller/Supabase/Hermes
e faz rollback automático. Secrets permanecem em SSM `/ligou/*`; daily EBS snapshots.

## Credential/decision-gated (require RJ; not code gaps)
1. **F1 audio** — speak into the mic (pipe already proven).
2. **Real Google Calendar** — Google Workspace OAuth (`GOOGLE_*`); fake adapter proves the logic today.
3. **Hermes brain** — subscription/OAuth (rule: LLM ≠ API); loop already proven with a mock.
4. **F5 real client** — RJ picks the vertical; mechanism proven with a synthetic tenant.
5. **F6 Twilio** — new account; RJ deferred to last. Phone/SIP scaffolding built.
