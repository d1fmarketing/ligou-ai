# Protocol compatibility and rollback sets

Facts as of 2026-09-11 (controller `5e51dc6` lineage, Edge `browser-session` v21, 98 migrations). This runbook states which layers must move together; it is procedure, not evidence of any executed rollback.

## Matrix

| Onboarding protocol / opening mode | Frontend build | Edge v21 (`supabase/functions/browser-session/core.ts:634-637`) | Controller (`voice-controller/src/browser-requests.ts:720-727`) | Schema |
|---|---|---|---|---|
| 2 `application_tts_v1` | `f9a2841` = Vercel 2026-09-06 (`client-2gx05b0hr…`) | 409 `client_upgrade_required` | 409 | accepted (`20260904022004`) |
| 4 `realtime_stream_v1` | builds between `20260907165213` and `71647ae` | 409 | 409 (payload shape tolerated at `:383`, request rejected at `:722`) | accepted |
| 5 `realtime_native_v1` | `71647ae` (never deployed to Vercel) | accepted with `speech_contract_version=3` (`core.ts:640-642`) | accepted | accepted (additive) |
| 6 `live_managed_v1` | `8f51898` and later (bundle `index-CH2HickC.js` sha256 `3115d80c…`) | accepted | accepted; controllers from `8344172` require migration `20260911072902`; controllers from the 2026-09-11 close-anchor release require `20260911230000` | ≥ 96 / 97 / 98 |

## Rules

- The frontend may roll back alone only to a protocol-6 build. Valid target today: `https://client-aasmtehgu-d1fdmarketing-gmailcoms-projects.vercel.app` (5e51dc6 bytes, previous production). Invalid: `client-2gx05b0hr…` (protocol 2 → 409 on every "Começar entrevista").
- The controller may roll back alone only when the schema change since the target was additive and every RPC signature the target calls is unchanged. The 2026-09-11 migration is additive: `record_website_live_termination` keeps its signature; `reconcile_live_session_expiry` and `settle_unresolved_live_call_budget` are new and simply unused by an older controller. Rolling the controller back re-enables the unconverged Live reconciliation loop for any `unknown` termination.
- A protocol change (5 ↔ 6) requires frontend, Edge and controller together; the schema already accepts both.
- The schema never rolls back. Compensation is a new migration. For the 2026-09-11 change set the compensation is only `revoke execute on function public.reconcile_live_session_expiry(uuid,text,timestamptz,integer,text,text,text) from service_role` (and the same for `settle_unresolved_live_call_budget`). The policy-aware receipt constraint and the patched `website_interview_prior_settled_before_stream_resume` MUST stay: restoring the 60-minute-only versions would permanently reject Live receipts already recorded with `checked_at < anchor_at + 60 minutes`.

## Commands

- Vercel: `vercel rollback <protocol-6 immutable URL> --yes`, then verify the alias serves the expected bundle hash (`curl … | shasum -a 256`).
- Controller: automatic inside `infra/deploy-host.sh` on failed activation (`rolled_back` / `rollback_failed` in `/opt/ligou/deploy-results.jsonl`). Manual: via SSM re-point `/opt/ligou/current` to the previous release directory, `systemctl restart ligou-controller`, run `infra/release-health.sh`. Re-activating an identical commit through `infra/deploy.sh` is refused (`release_already_exists`): fix forward needs a new commit.
- Edge: redeploy the previous source from a detached checkout (`supabase functions deploy browser-session --project-ref ixpbqquvxirvuevjhmrq --use-api --import-map supabase/deno.json`), then compare the composite identity with `node scripts/check-edge-functions.mjs`.
- Migrations: forward-only; never `supabase migration repair`; never delete receipts or reservation rows to make a state look clean.
