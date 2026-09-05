# Automatic QA — original Ligou website and isolated sales pilot

September 5, 2026. Local human-review preview: http://127.0.0.1:4189/ . Commercial viewer: http://127.0.0.1:4189/comercial/ . Main-site publication was not performed.

## Fixes made

- Bounded and cancellable browser SDP negotiation. Stalled local offer creation releases capture before provider admission; later failures also request server termination.
- Pending microphone replacement stops immediately on hangup. Muting during replacement also mutes the replacement and remains applied after adoption.
- Session recovery credentials must be stored successfully before provider admission. Blocked storage produces a recovery message.
- A connection failure remains visible after automatic termination; a retry clears it.
- Complete spoken contact matching rejects truncated domains, country-code/number suffixes, local-part prefixes and spaced aliases. Email accents remain significant. Ambiguous evidence requires clarification.
- Commercial initialization, session lookup, OAuth, logout and transcript-loading failures have usable recovery states. Logout applies to the current session. Stale auth responses cannot replace a newer identity.
- Follow-up permission is displayed only for the exact confirmed contact and matching consent channel. A failed transcript request is not presented as an empty conversation.
- Long company names and email addresses wrap inside the commercial layout across narrow and wide viewports.
- The local preview rejects malformed URLs without crashing, restricts public files, validates canonical symlink targets, rejects untrusted Host headers and static writes, and shares the release build's public-key validator.
- The sales model now receives the exact persisted transcript, encoded as quoted JSON data, before using its tools. Persistence failure exposes no evidence. Validators, roleplay isolation and confirmation/consent ordering remain unchanged.
- Sales instructions request brief replies, silent tool execution and simple clarification instead of internal validation/consent explanations.

## Automated verification

- Landing/voice/commercial behavior: 73 Bun tests. Preview/proxy/build/commercial data: 17 Node tests. Asset/runtime verifier: 85 pinned files, 46 runtime references. Secrets scan passed.
- Existing dashboard: 114 tests passed.
- Sales and existing voice/controller unit runner: all 56 files passed with synthetic external boundaries.
- Core database gate passed against deployed core commit 757f194: 73 migrations, 29 SQL assertions, 20 concurrency tests, 28 upgrade tests, 38 authenticated RLS tests, plus the existing onboarding/discovery/summary integration suites. Its dedicated local stack was stopped and destroyed; tracked source stayed unchanged.
- Separate disposable PostgreSQL sales checks: 35 groups across persistence, expiry and closed-receipt recovery. This covers the sales additions separately from the deployed core gate.
- Landing DOM/layout checks passed at 22 widths from 320 to 3440 px, including intermediate breakpoints. This is geometry/behavior verification, not a claim that every pixel has human approval.
- Commercial long-data fixture passed at 11 widths from 320 to 3440 px.
- Denied-microphone UI passed at eight viewport sizes from 320×568 to 1920×1080: one capture attempt despite duplicate clicks, zero provider requests, actionable retry, panel inside the viewport and no horizontal overflow.
- The real commercial viewer loaded through the existing authorized browser session and displayed the synthetic lead, its transcript and the refusal of follow-up. No logout or new OAuth flow was triggered.
- Independent review findings were fixed and rechecked. Final transcript-handoff review: 37/37 sideband tests, no remaining scoped blockers.

## Real provider evidence and its limits

Three synthetic WebRTC calls used prerecorded Portuguese speech through a synthetic microphone. No physical microphone, outbound phone calls, calendar bookings, messages or customer activation were used.

The first two probes established connection, received the AI opening, and ended with confirmed provider receipts. Their synthetic audio source stopped transmitting silence between utterances; that test-harness issue was corrected with a continuous silent source.

The third call, af8a6414-4526-451b-9138-7ef148b76a83, demonstrated two-way audio transport, automatic transcription, interruption, progressive lead facts, an explicit refusal of follow-up and the five-minute cutoff. Sixteen transcript items and seven lead fields survived termination. The declined follow-up has recorded evidence. All three calls are ended/confirmed.

The email transcription differed from the spoken address; the validator correctly refused to mark it confirmed. Several reformulated business facts were also rejected. This exposed the missing literal transcript handoff, which was subsequently fixed and independently unit-reviewed. The final wording/handoff patch has **not** received another live conversation acceptance test; the QA visitor's three-session daily limit was respected. A successful human contact readback and confirmation remains required.

Recorded usage for the three calls totals US$0.418097. This is observed usage, not a settled billing receipt. Their US$4.50 reservation remains held according to the existing settlement policy; no reservation was manually released. At the final conversation readback, zero active sessions and US$10.50 of the configured US$15 daily admission budget remained available.

## Artifacts and rollback

- Frontend source: isolated branch codex/v1-pilot-complete. Final assembled output: dist/automatic-audit-review. Source commit and artifact hashes are recorded in output/automatic-audit/artifact-manifest.json.
- Final isolated sales source: acd7843d3e08ce03576506a3e09a175d30ea4869. Standalone server SHA-256: 7b9594924dbfd35198c82a0b643943ab9da8aaa1cbc5391c7d2f2438918b81c9. Two independent builds were byte-equal.
- Sales-only deployment command: b50e0893-5bcb-4464-9e54-63b6ab16fd2a. Service active with zero restarts; owner controller PID remained 871573. Previous release remains available through the release directory for rollback.
- The original main checkout and external original-site backup were not edited. Original reference remains on port 4177 when its preserved preview is running.
- Logs, synthetic records and browser fixtures are under output/automatic-audit in the respective frontend and sales worktrees. These QA fixtures are excluded from the assembled site.

## RJ's later review

1. Open the local landing, click “Falar com o Ligou,” allow the microphone, and assess the voice, pacing and naturalness.
2. Use a realistic business, correct any misheard name/contact, confirm the readback, express an objection and choose whether follow-up is allowed. End once before completing the whole conversation to verify the saved progress in the commercial viewer.
3. Sign in to /comercial/ with the authorized account and check the exact contact, permission channel and next step. Automated UI/data/RLS checks passed; a fresh Google sign-in and physical microphone assessment require the human account/device.
4. Review the original design on your usual devices. The hero/brand/slogan remain; “Ver de novo” and “Pausar animações” remain removed, and waveforms loop automatically with reduced-motion/offscreen handling.
5. Supply/approve legal operator identity, jurisdiction, privacy contact and retention choices in the existing drafts before public launch. Nothing was invented or published in their place.

No replacement of the main website, billing, outreach or pilot activation was performed.
