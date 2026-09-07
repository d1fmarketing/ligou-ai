# Website onboarding: full Realtime streaming

RJ explicitly directed that new onboarding conversations use full streaming from opening through signoff. No MP3 generation, prerecorded opening, voice cache or TTS fallback is permitted on the new path. The original execution goal and its performance, real-audio, authority, completion and human-acceptance gates remain in force.

This changes the voice transport, not the authoritative finite agenda. Existing source results, drafts, answers, failed attempts, approvals and legacy media receipts remain preserved and readable. No new provider, paid text fallback, billing framework, customer contact or budget increase is authorized.

Browser verification must first exhaust **Codex's in-app browser**, operated through `cua_repl` (including its documented tab CDP capability for development). RJ subsequently authorized Edge only as a last resort after those options are exhausted. Any such fallback must use a separate test session and preserve his personal tabs and windows. Former native launch/cleanup entrypoints remain disabled; native-only checks must say skipped/not run. Terminal-only unit/database work may continue. Earlier native-browser test results are historical evidence, not permission to reuse unsafe launch or cleanup helpers.

## Shared wire contract

- New browser onboarding protocol: `4`.
- Opening/transport mode: `realtime_stream_v1`.
- Client declares `speech_contract_version: 3`.
- New onboarding admission rejects older protocols/modes before enqueue/provider work. Historical branches remain available for readback and cleanup, not new TTS sessions.
- Keep the existing 55-minute protocol window and USD 7.50 per-call reservation/hard cap. Realtime usage owns the new call's audio cost; no TTS cost is invented.

The opening response contains `opening_payload: {version: 4, stream: authorization}` and the existing SDP, call, model, business-name and max-minutes fields. There are no audio bytes, MP3 hashes or TTS price fields in a stream descriptor.

```ts
type StreamAuthorization = {
  schema: 'onboarding.stream.v1';
  action: OnboardingSpeechAction; // existing seven authoritative fields
  dispatchId: string;           // fresh UUID, stable for this rendition
  receiptId: string;            // durable action authorization receipt
};
```

The backend claims the existing selected action before generating any audio. Browser intent/readiness then triggers this exact rendition. Every streamed response carries metadata identifying the call, action, source digest and dispatch. One audio response may be current at a time. Interpretation keeps its separate, text-only, out-of-band tool response and the repaired single-proposal validation.

Session defaults remain text-only with empty tools and automatic response/interruption disabled. Each authorized speech request explicitly uses `output_modalities:['audio']`, `tool_choice:'none'`, empty tools, and `conversation:'none'`. Reuse the existing application response coordinator's intent/idempotency pattern, not the generic unconstrained provider conversation.

Control messages follow the existing owned data-channel system-message pattern:

- Backend notice: `ligou.website_stream:` followed by the authorization JSON.
- Browser ready: `ligou.website_stream_ready:` followed by `{actionId,dispatchId}`.
- Browser playout: `ligou.website_stream_played:` followed by `{actionId,dispatchId,responseId,itemId,bufferStoppedEventId,mediaEvidence}`.
- Backend rejected-rendition retirement: `ligou.website_stream_retire:` followed by `{actionId,dispatchId,responseId,generationReceiptId,reason:'transcript_mismatch'}`. The player retires only the matched current rendition. A matching buffer clear arriving first silences immediately and waits at most three seconds for this control; duplicates do not extend the deadline. Unknown clears still fail, and late old clears cannot mute a new rendition. The existing server clear barrier still fences new audio dispatch.
- Existing exact `ligou.website_stop:<callId>` control remains the Stop mechanism.

Use deterministic bounded message IDs derived from the dispatch and control purpose. Neither system control nor provider text is owner speech. The backend must verify current durable scope/rendition before starting audio and must not treat a repeated ready control as a new generation.

## Evidence and progression

Reuse `website_interview_speech` for the action/slot/digest ledger with an additive transport discriminator and stream correlation fields. Preserve its states and one-outstanding-speech index. A separate workflow platform is unnecessary.

Provide these stream-specific RPC operations through the existing evidence store:

1. `claim_website_interview_stream`: same owner/call/browser-request/action/summary-part inputs and authority gates as the existing claim; return the authorization above.
2. `read_website_interview_stream`: authenticated owner read of the current authorization. An opening descriptor already obtained through the authenticated bootstrap may be used directly only if the backend rechecks current durable authorization when ready is received.
3. `record_website_interview_stream_response`: service-only, current action/dispatch plus provider response/item identity, successful final generation status, actual final audio transcript and its validated relation to the selected action. Preserve a distinct provider-completion receipt.
4. `record_website_interview_stream_playout`: service-only, exact current action/dispatch/response/item plus the browser's matched WebRTC buffer-stop/media evidence. Preserve a distinct playout receipt. Provider-side buffer-stop evidence, if independently observed, must be identified separately; do not assume event IDs or arrival order are identical across connections.
5. `resume_website_interview_stream`: retain the existing interruption/final-owner-input/unchanged-digest/two-rendition bounds, but authorize a new dispatch and response. Never reuse an old response ID or playback receipt.

Provider completion and client playout can arrive in either order. Only their valid join for the current, non-cleared, non-superseded rendition may mark the existing speech row `played` and advance the coordinator. Add explicit stream events/proofs to the coordinator; do not put a synthetic value in an MP3 hash field.

Generated transcript validation occurs after streaming has begun. It cannot promise the old full-file-before-play property. Application state and approval remain independently guarded. Validation must permit harmless presentation variation while preserving the requested question and all factual/conditional recap content. Missing or changed critical recap content cannot earn a played/approval receipt. Keep transcript-validation policy explicit, bounded, shared/tested at the appropriate authority boundary, and never equate provider output failure with owner uncertainty.

On barge-in, retire the rendition immediately, silence local output, cancel the specific response, then clear its remaining output buffer. Clearing has no response-ID parameter, so a newer speech response cannot start before old-buffer clearing/drain is resolved. Continue the existing final-ASR persistence, captured-question context, correction, acknowledgment and amendment logic. Clearing/truncation is not complete playback. Resuming an interrupted opening should continue the current question without needlessly repeating the introduction.

## Browser and lifecycle

Use the existing `RTCPeerConnection`, remote audio element, microphone acquisition, data channel and audited Stop custody. Separate microphone custody from provider-output muting. Keep output closed until one currently authorized speech intent/response is established; do not lose its onset by waiting for full audio generation. Reject/mute unsolicited, stale or concurrent speech. Never expose provider credentials.

A continuous remote stream does not emit HTML `ended` for each utterance. Per-response playback uses matching `output_audio_buffer.started/stopped`, successful generation/transcript completion and actual browser media evidence. `cleared`, failed/cancelled generation, autoplay failure, muted output or supersession cannot count as played. The audio harness must capture and align real streamed output; no text injection or simulated MP3 may stand in for it.

Keep configuration approval separate from call teardown. Final signoff must finish before the one audited effective hangup; retain the transport while that request is acknowledged. Reconcile actual Realtime usage and reservations. A confirmed provider rejection before any audio may truthfully have zero cost/`not_applicable`; update the narrow empty-start resume predicates for protocol 4 without fabricating TTS usage.

## Implementation ownership

- Root: controller/bootstrap, queue and Edge admission/cancellation contracts, release integration and real-provider execution.
- Database worker: stream migration, scoped RPCs, protocol/binding triggers, setup/resume/status and SQL tests.
- Runtime worker: speech/evidence types, runtime/coordinator/sideband streaming transport and focused regressions.
- Browser worker: stream player, session/panel/setup protocol handling, real-audio harness and browser tests.

All workers preserve others' edits. New boundaries above must agree before integration. No worker deploys or makes provider calls.

## Verification and release

Prove zero `/audio/speech` calls on new onboarding, first audio before full generation, one authorized response, barge-in and clear races, duplicate/late events, reliable owner progression, current recap/correction/explicit approval and signoff/teardown. Preserve actual runtime/store/SQL tests and full faithful 114-item source. Run the relevant full suites and migration gate on the frozen source, independent review, reproducible immutable package/deployment and final-surface readback. Then perform real stream pilots, the 10 warm/5 cold sample and all three complete audio interviews under existing budgets. The readiness and human acceptance markers retain their original strict meanings.
