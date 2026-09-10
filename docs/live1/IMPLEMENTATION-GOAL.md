# GOAL: INTEGRATE GPT-LIVE-1 INTO LIGOU, THEN PILOT THE AGENTS API SEPARATELY

Continue in the authoritative Ligou worktree with the current native-onboarding changes. Implement and test an internal candidate, not another architecture report. Deliver a human-testable voice path before expanding the migration.

This is an engineering goal, not the prompt to paste into the voice model. OpenAI's September 10, 2026 release and the official sources below are the technical starting point. Recheck the actual API/SDK contracts before editing their integration points.

## 1. Scope and starting point

First deliver GPT-Live-1 for the Brazilian owner's browser onboarding, connected to Ligou's existing business operations. Then add a separate, manually triggered Agents API pilot that reviews a completed internal QA attempt. That worker must not become a dependency of starting, conducting, or ending a call.

Do not migrate Renan's private agent workforce, adopt Presence, rebuild memory, rerun website discovery, replace EC2/Supabase/Vercel, or change commercial telephone routing in this milestone. Browser acceptance does not prove SIP acceptance.

Find the current local branch, uncommitted changes, deployed versions, active voice configuration, and latest approved internal-QA budget policy. Reuse existing receipts. The connected GitHub copy inspected during planning did not expose the recent native-onboarding branch; do not assume remote main is the current implementation. Preserve legitimate work and create an isolated candidate from the verified current source, not an old SHA.

Keep the existing native Realtime implementation available as a compatible rollback, without restoring MP3, cached speech, or deterministic reading. Use the existing deployment/session selection mechanism where possible. One voice engine owns a session; do not switch protocols mid-call or create a general provider framework.

## 2. Implement the actual Live protocol, not a model-name replacement

Read the Live getting-started, migration, delegation, session, and prompting guides [S1-S5]. Follow their linked WebRTC/sideband quickstart and current SDK reference. Use verified model, authentication, transport, event, and permission fields. Do not copy Realtime event names into Live handlers because they look similar.

The intended separation is:

- GPT-Live-1 owns native listening, speech, pacing, and conversational interaction.
- The delegated backend interprets the business task and selects existing tools.
- Ligou's server validates and executes operations; its database remains authoritative.

Use client delegation initially to preserve control of backend context and the existing approved subscription-backed text route. Reuse its supported integration, verifying authentication and deployment compatibility. OpenAI's release includes a Codex integration example, but that excerpt is not a complete adapter or blanket guarantee about every subscription/account setup [S8]. Do not build around an undocumented endpoint or silently replace subscription work with paid Responses calls.

Implement only the necessary bridge between Live delegation and the existing authorized tools. Keep backend instances/context isolated by tenant and interview; never share one conversational Codex thread across customers. Do not give the delegated model general shell, filesystem, cloud-admin, or database-superuser access to conduct onboarding.

This migration explicitly changes one earlier assumption: the Live voice frontend delegates work rather than emitting the same ordinary structured tool calls as Realtime. A text backend is part of this documented architecture. What remains prohibited is turning every spoken exchange into a blocked ASR-to-script-to-TTS pipeline. Replace the universal test that every business commit must precede ASR on this new path: client delegation may need transcript context before it can determine the operation. Prove that speech remains full duplex and the write is timely and correct. Never invent missing content to pass an obsolete timing assertion.

## 3. Build delegation context and persistence correctly

In client mode, handle `session.delegation.created` using its actual delegation metadata. It does not contain the utterance, waveform, or parsed business-tool arguments. Maintain context from Live's input/output transcript events plus the authenticated interview state [S3].

Live transcript deltas have timeline intervals, not Realtime input-item IDs or an authoritative turn-completed event [S4]. Adapt the existing provenance contract explicitly. Retain source fragments and speaker/timing information according to the existing retention policy, and use application-owned operation references where needed. Never label invented IDs as provider IDs. Do not keep waiting for a legacy ASR completion event that Live will never send.

A transcript fragment is not a complete instruction. Preserve context for short replies, pauses, overlapping acknowledgments, unfinished sentences, and corrections. If a delegation arrives before sufficient context, retain it and resolve the necessary context rather than dropping it, guessing, or treating the latest fragment as the whole request. Do not make every transcript delta trigger a write.

An operation must contain the actual proposed values or faithful interpretation, not merely “question answered.” Keep interpretation distinct from transcript evidence. Preserve conditions, negations, uncertainty, and private/public distinctions. Reuse existing schemas and RPCs; change storage only where the Live provenance contract genuinely requires it.

Validate tenant, owner authority, session, allowed targets, current revision, and operation identity on the server. Keep existing idempotency semantics: retries or a new delegation for the same operation must not duplicate its effects; a genuine correction must remain possible. A new Live delegation ID is not, by itself, a new business action. Reconcile ambiguous commits before retrying.

Return compact verified facts and relevant pending work, not a mandatory speech script. Use the documented quiet-context and spoken-result channels appropriately. Never stream private reasoning, credentials, or irrelevant internal tool output to the speaker. For customer calls, private negotiation floors remain backend-only; authenticated owner onboarding has a different disclosure policy.

Interrupting speech does not automatically cancel backend work [S1]. Handle intent-changing corrections and explicit cancellation separately. Before an irreversible effect, recheck applicable authorization and current state. Do not claim that interrupting speech undid a committed action. Suppress stale results from superseded tasks/sessions without losing their audit record.

## 4. Preserve a natural, finite onboarding

Split prompts rather than moving the entire old prompt into Live. Give the voice model a short role/style/delegation prompt; put detailed business procedures and tool instructions in the backend. Preserve native speech from greeting through goodbye. No exact-sentence matching, per-phrase playback approval, mandatory fillers, or second model used only to rewrite a tool result for speech.

For Portuguese QA, audition the documented Brazilian Portuguese voices `bossa` and `tempo`, retaining the preferred supported choice. Request natural Brazilian Portuguese with a light São Paulo accent, without caricature. Do not promise accent quality from a voice label; Renan evaluates real audio. Voice comparisons use separate sessions when the contract requires it [S4]. Preserve fluent English as a separately tested customer-facing requirement.

Start from the persisted website/draft and current unresolved decisions. Do not ask for timezone or other information already reliably resolved. Ask which conflicting business rule is correct, not whether the owner agrees that a contradiction exists.

Fix the observed conversation problems through task state and concise prompting:

- Once the owner explicitly leaves numeric discount limits undefined, record that choice and its restrictions; do not repeatedly offer to define them. Unknown optional values must not trap the interview.
- Identify the service when asking its price. Use the tenant's actual catalogue, not plumbing examples or other fixtures injected by a QA participant. Do not silently apply an answer to a different service.
- An understood answer whose write fails remains unresolved and recoverable. Do not announce that it was rejected and then abandon it while advancing.
- Do not expose schema repair or repeatedly narrate “I will register that.” Announce success only after the operation succeeds. Quiet waiting is allowed; progress chatter is not a substitute for a result.

Preserve a short spoken review of persisted decisions and material restrictions, followed by explicit approval of the current revision. Adapt consent evidence to Live's real events without weakening it into a model-authored boolean. Earlier acknowledgments, deferred items, silence, and goodbye do not constitute final approval. Corrections invalidate the affected approval context.

A crucial distinction: “end the call now” is a request to stop, not a request to approve the setup. Honor it promptly, save existing progress, and leave the onboarding incomplete when appropriate. Never force the user through a review or approval to be allowed to hang up. Normal successful completion and user-requested early termination are separate paths.

## 5. Adapt startup, shutdown, recovery, and accounting

Follow Live's actual startup procedure, including readiness and the documented way to initiate a greeting while microphone input remains active. Keep credentials on the trusted server and restrict browser-side control permissions. Do not disable input merely because the assistant is speaking.

For ordinary completion, deliver the closing message and validate that it is heard in a real audio test. Do not treat an appended-context acknowledgment as playback completion or invent an output-audio-done event. Use the supported transport behavior and the smallest necessary terminal handling, not a speech-certification system.

Follow the documented close flow: register the terminal-event listener before requesting closure, keep receivers alive long enough to observe finalization, and then release resources. `session.closed` and its reason establish provider finalization, not successful business approval. Reconcile pending client-managed work separately [S4]. Explicit Stop must remain promptly usable even when graceful cleanup encounters a problem.

Map disconnection, expiration, cancellation, and approved completion separately in the existing application state. Reconnect from saved business state/history and reconcile pending effects; do not assume a new connection resumes the old provider session.

Adapt costs to Live duration accounting rather than reusing Realtime audio-token estimates. The documented usage snapshots are cumulative, so do not sum them as increments. Track backend and carrier costs separately [S4]. The advertised $0.05/minute is the voice frontend price, not an all-in Ligou price [S8].

Preserve Renan's latest explicitly approved internal-human-QA budget exception. Do not accidentally restore the old daily test blocker through a new cost adapter. Also do not remove unrelated account/provider or production safeguards. Before a live run, show the actual applicable QA allowance and any genuine external limit without inventing a new cap. Do not create new credentials or expose secrets.

## 6. Add an independent Agents API pilot, not another live dependency

After the first Live voice checkpoint, implement one optional QA-review worker using the actual Agents API public-beta contract [S6-S7]. This is not the Agents SDK under a new name.

Its input is an explicitly selected, tenant-scoped internal QA attempt: permitted transcript/context, operation results, state revisions, termination reason, and measured timings. Its output is a report of evidence-supported failures, unresolved items, repeated questions, policy discrepancies, and focused regression suggestions. A transcript-only report must not claim to have evaluated accent or audible playback.

Use a supported Astra model for this pilot only when its API access and incremental billing are explicitly authorized under the applicable test budget. Agents API usage is billed API work, not included Codex-subscription work merely because it uses the Codex harness [S9]. Do not silently migrate the rest of Ligou's text processing. If there is no authorized paid-text budget, implement the isolated invocation path and deterministic tests, mark the real-provider pilot unrun, and keep voice work moving through the approved backend.

Use existing job tracking and an appropriate isolated environment. Keep the worker's access read-only to supplied evidence and allow it to write only its report. Do not give it customer credentials, live mutation tools, production deployment access, or permission to modify its own access policy. Start without subagents or new infrastructure; add neither merely because the launch supports them.

Persist the provider session/job association and actual terminal outcome. Do not duplicate jobs on retry or announce that analysis completed when it is only queued. Demonstrate one supported run when authorized. A worker failure must not block or terminate a voice session.

## 7. Test the smallest useful path, then get human feedback

Run focused protocol and business regressions, then a short browser/provider audio smoke with real Live media and one real authorized write. Verify that the owner can add a correction while backend work is pending, receive a truthful result, and stop the call. Use isolated QA state, not customer traffic or duplicated side effects.

Cover the known failures: valid territory answer; saved/unsaved Sunday rule; undefined discount limits without looping; catalogue/service identity; relevant price approval; interruption versus cancellation; stale/duplicate operations; missing or late transcript context; early hangup without approval; and normal approval followed by closure. Use actual project fixtures rather than hardcoding the examples into production.

Reuse the browser/audio harness, adapting only transport-specific assumptions. Mark simulations honestly. Use the internal browser first; an isolated Edge QA session is allowed when necessary, never Renan's personal tabs.

Measure startup to intelligible/useful speech, real end-of-owner-speech to useful response, delegation/tool latency, interruptions, and actual cost. Backchannels and beeps are not completed answers. Do not claim the launch benchmarks predict Ligou's results.

Once the essential path is safe and the smoke passes, make the Live candidate available for an early human diagnostic. No fixed requirement for three full interviews, dozens of starts, or a statistical percentile before Renan can try it. Do not hold that checkpoint hostage to the Agents API pilot.

Keep the full interview, review, correction, consent, and closure as a later acceptance check. SIP needs its own real-call proof before changing any commercial phone route; an announcement of telephony support is not evidence that our carrier integration works.

## 8. Release and stop at a useful checkpoint

Use the existing immutable deployment process and only changed surfaces. Run the repository's relevant security/release gates and a focused review of changed protocol, persistence, and consent boundaries. Apply a migration only for a demonstrated contract gap. Preserve compatible rollback and data; no manual EC2 patching or unrelated refactor.

Return `LIGOU_LIVE1_READY_FOR_HUMAN_DIAGNOSTIC` with the deployed candidate identity, exact entry point, prepared QA state, selected voice/backend/delegation mode, real tests, timings, observed cost, remaining limits, and evidence that test calls were cleaned up. State separately whether the Agents API pilot is implemented, tested with a real provider, or waiting on paid-text authorization.

Stop that execution for Renan's participation. Continue the same goal when feedback arrives. Do not loop indefinitely or start migrating the private agent workforce while waiting. Never label code changes, a model-name change, or a passing simulated test as a completed migration.

Full acceptance requires the complete real voice/business path and verified durable state. A genuine provider-access or credential blocker must be reported precisely with the useful completed work, not bypassed or used to justify unrelated engineering.

The outcome is better conversation with the existing business guarantees, plus one independent agent-worker pilot. It is not a new operating system, a speech gate, or a rewrite of Ligou.

## Official sources to verify at execution time

[S1] Getting started: https://developers.openai.com/api/docs/guides/live
[S2] Migration: https://developers.openai.com/api/docs/guides/live-migration
[S3] Delegation and tools: https://developers.openai.com/api/docs/guides/live-delegation
[S4] Session lifecycle, voices, transcripts, usage: https://developers.openai.com/api/docs/guides/live-conversations
[S5] Live prompting: https://developers.openai.com/api/docs/guides/live-prompting
[S6] Agents API: https://developers.openai.com/api/docs/guides/agents-api/overview
[S7] Agents API quickstart: https://developers.openai.com/api/docs/guides/agents-api/quickstart
[S8] GPT-Live-1 API release: https://openai.com/index/introducing-gpt-live-1-in-the-api/
[S9] Agents API release and billing distinction: https://openai.com/index/introducing-the-agents-api/
