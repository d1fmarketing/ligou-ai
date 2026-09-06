# Repository map — September 6, 2026

The integrated release source is `main`. The current production website is https://client-nine-taupe-24.vercel.app; [its receipt](release/VERCEL-2026-09-06.md) records the exact deployed commit and scope.

| Path | Responsibility | Verification boundary |
|---|---|---|
| `index.html`, `src/runtime/`, `assets/`, `_ds/` | Approved original landing, animation and responsive behavior | Built and verified on Vercel; source assets preserved. |
| `src/sales-demo/`, `src/server/` | Public voice panel and same-origin server proxy | Automated lifecycle tests and live proxy-to-Edge status check; human microphone acceptance is separate. |
| `src/commercial/`, `comercial/` | Authenticated commercial lead viewer | Bundled under `/comercial/`; public configuration and login page verified. |
| `dashboard/` | Owner app, website onboarding, rules, memory and approvals | Combined source passes 171 dashboard tests and six hosting tests; nested production route verified. |
| `voice-controller/` | Realtime sessions, budgets, provider lifecycle and sales worker | Current source consolidated; voice suites pass. This website deployment does not redeploy the host. |
| `supabase/` | Schema, RLS, RPCs and Edge functions | Current deployed phone/sales source preserved. No schema or Edge code changed in this website release; origin/redirect configuration was extended. |
| `hermes-cell/`, `infra/` | Tenant execution and signed backend releases | Independent backend release lifecycle; see dated receipts. |
| `scripts/` | Build, verification and read-only phone setup | Production artifact excludes private configuration and development files. |
| `tests/browser/` | Repeatable responsive browser QA | Local-only test pages; not included in production artifact. |
| `docs/` | Runbooks, current receipts and dated historical records | Start with the current production receipt; older RC evidence is not current runtime status. |
| `output/`, `dist/`, `.env*`, `node_modules/` | Local artifacts, private configuration and dependencies | Ignored by Git. Public composition is a deliberate subset. |

The API and database own operational authority. Hermes and the browser do not bypass approval or budget checks. See [SECURITY-RULEBOOK.md](SECURITY-RULEBOOK.md).

All 15 existing worktrees were clean at the release audit. Preserved preview branches and the rejected V2 remain available for history; none were deleted. The original 18 local edits are preserved in `codex/preserved-local-v1-20260906` and an external backup before the main checkout was advanced.
