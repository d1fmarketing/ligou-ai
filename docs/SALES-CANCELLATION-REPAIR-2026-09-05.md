# Sales cancellation recovery — September 5, 2026

Scope: the isolated public-sales backend. Frontend, physical microphones, authenticated owner routes, customer operations and the owner controller were not changed.

## Reproduced failures and fixes

1. Stop previously waited for persistence and provider hangup before closing the sideband. A caller turn arriving during that wait could create new provider audio. Stop now closes the sideband immediately.
2. Sideband setup failure could reset an already-running stop and issue two hangups. Stop now owns one promise per captured provider identity and all callers await it.
3. Cancellation during create-intent persistence could still dispatch provider creation after the acknowledgement returned. The hook now checks cancellation again before it can return to the provider POST.
4. A provider identity arriving after an earlier no-ID stop must still be drained. That cleanup is chained after the prior stop, preventing its delayed writes from landing after the new hangup receipt.
5. An unknown creation outcome formerly started quarantine outside stop. If abort arrived during that write, it could later overwrite confirmed termination. Unknown outcomes now use the same serialized stop path.

A pre-dispatch callback can prove it never returned to the provider POST. After waiting for any earlier stop, it can clear that unissued intent with the existing fenced provider_rejected operation and then fail. Recovered or ambiguous dispatched attempts never use this cleanup path. Failure while clearing intent remains protected by SQL's independent no-provider/no-intent guard.

Migration 20260905202520_sales_pre_dispatch_cancellation.sql changes only the existing fail branch's terminal marker to not_started, after those guards. This allows current and expired browser capabilities to recognize a never-started session correctly. No monetary hold for a known or unresolved provider is released. Function ownership, invoker security, empty search path and service-only permissions are preserved.

## Verification

- Four original cancellation regressions failed before the worker fix; an additional delayed-quarantine regression failed before serialization was completed.
- Worker suite: 21 tests passed. Full existing voice/controller runner: all 56 files passed.
- Disposable PostgreSQL: the new pre-dispatch regression and all 35 existing sales persistence/expiry/closed-receipt groups passed. The new scenario checks recovery, effective hold/slot release for zero-spend cancellation, expired capability replay, and rejection of unsafe clearing for ambiguous or known provider calls.
- Backup/restore and release infrastructure: 54 tests passed using synthetic external boundaries.
- Independent runtime review found no remaining blocker in this patch. SQL review verified the fail-state transition against real disposable PostgreSQL.
- Live migration dry run selected only this one sales migration. Function body hashes and privilege checks are recorded before and after deployment; service-only permissions remain unchanged.

These tests exercise actual worker/socket code with injected external transports and actual PostgreSQL functions. They do not replace human assessment of speech, contact pronunciation or the final sales conversation.

## Operations and evidence

Before the update, the sales service was active with zero restarts, approximately 18 MB memory use, a fresh database heartbeat and no active calls. Its installed artifact matched its recorded hash. The existing owner controller remained active.

Deployment receipts, before/after function metadata, regression logs and service health are in output/backend-followup. Release packaging uses two independently compared builds and retains the previous sales release for rollback. The one-line database correction is compatible with the previous worker release.

No additional provider conversations, outbound calls, messages, bookings, website publication, billing changes or increases to usage limits are part of this follow-up. The human voice/contact acceptance test and business/legal decisions remain for RJ.
