# Sales voice capture and termination repair

## Scope and historical evidence

Base: `a25f6ae` in the isolated sales checkout. Changes affect only the sales runtime, sales tests and an additive sales-only migration. The authenticated owner `browser-session`, customer controller, voice Ash, model `gpt-realtime-2.1`, fallback acceptance policy, five-minute maximum, one simultaneous session, three sessions per visitor/day and financial ceilings are preserved.

Read-only SSM evidence on2026-09-05:

- Instance `i-0de12212f9a17dcfc`, region `us-east-1`; `ligou-sales` running with PID904294. Original services untouched.
- Session `21939bc2-4af1-493b-ba33-3a965ed8f2a4`: quarantined / termination unknown; observedUSD0.091033, reservedUSD1.50, usage observed.
- Persisted transcript contains a greeting, four requests to repeat, and only one caller utterance. It contains no roleplay or saved commercial facts. This does not establish that later-reproduced evidence-ordering defects caused that particular historical failure.
- SSM query receipt `13eafe93-36cd-4017-9145-fc3fdb6b6917` read those safe columns and transcript. No credentials or SDP were emitted.
- SSM receipt `55373318-9442-44f4-919a-11a7ce59d590`: authenticated read-only handshake of the known sideband route, at2026-09-05T02:28:34.259566Z, returned404 / `call_id_not_found` / `invalid_request_error`. It sent no session update or response request.
- First persisted assistant transcript:2026-09-04T20:51:10.130418Z. With the verified60-minute provider maximum, the conservative expiry upper bound is2026-09-04T21:51:10.130418Z. Reconciliation requires a fresh check; the old receipt must not be submitted after its15-minute freshness window.

## Capture changes

Semantic VAD remains `low` with interruption enabled. `create_response` becomes false: the sales server creates a response only after nonempty caller transcription is durably stored, while initial greeting and tool continuations remain explicitly supported. Empty transcription emits a diagnostic and does not trigger another spoken request to repeat. This adds transcription/persistence latency to turn start; a human conversation must judge the actual tradeoff.

Provider tool calls that precede already-committed transcription wait for the same evidence. Caller transcript placeholders preserve order before a later assistant readback. Tool continuation waits for active/requested responses to finish, including the initial greeting ACK race. A pending transcript expires after10seconds; timeout blocks further audio creation, reports the issue and requests termination. Timers are cleared on completion/close.

A casual mention of “demonstração”, or declining a simulation, no longer labels real facts as roleplay. Explicit simulation start and end markers remain in the prompt. Contact confirmation, consent sequencing, revocation and evidence validation remain enforced.

UI diagnostics use a server-created system message with an `input_text` content entry:

`LIGOU_SALES_DIAGNOSTIC:{"code":"no_speech_detected"}`

or `transcription_timeout`. The browser can read the provider's `conversation.item.added` / `conversation.item.created` event, require system role plus this exact prefix and allowlisted code, and show an audio guidance message. These markers are not visitor evidence and the agent must not read them aloud.

## Termination changes

The sales-specific hangup adapter records only bounded HTTP status, safe provider error code/type, request reference and receipt time. It never logs response body, transcript, credentials or arbitrary transport-error text. Only HTTP success confirms hangup;404 and transport/timeout remain unknown. A thrown termination adapter now persists unknown instead of leaving requested or repeating the local attempt.

Migration `20260905023147_sales_provider_expiry_reconciliation.sql` adds the separate `expired` state and the service-only reconciliation RPC documented in `WEBSITE-V2-SALES-RPCS.md`. It frees the concurrency slot while retaining every unsettled financial hold. No live reconciliation or deployment was performed by this change.

## Validation

- Sales regressions were reproduced as failing tests before implementation: delayed evidence, readback order, false roleplay, empty audio responses, bounded transcription wait, late persistence after timeout, greeting ACK overlap, expired worker recovery and thrown hangup transport.
- Real disposable PostgreSQL16, loopback55439, with the existing sales migration plus the additive expiry migration: existing persistence suite13groups passed; new expiry suite10groups passed. Checks include concurrent admission, idempotency, consent and role boundaries, exact expiry guards, RLS/privileges, financial holds across midnight and stale worker fencing. The disposable cluster was stopped and removed after verification.
- The complete repository DB gate is recorded separately; the sales-only PostgreSQL fixture is not proof of all historical migrations or the Supabase/Colima production-like stack.
- Voice quality, real microphone behavior, a complete human commercial conversation and live deployment/reconciliation still need verification on their responsible surfaces. Unit tests and read-only provider evidence do not prove audible acceptance.

- Final complete voice unit runner passed after parent review. New English/Spanish ordered consent, withdrawal and simulation-isolation regressions also passed; qualified yes replies remain rejected. Caller language preference can be followed without bypassing evidence or authorization.
