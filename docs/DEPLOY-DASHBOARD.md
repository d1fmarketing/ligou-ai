# Production release — Ligou landing, sales demo and dashboard

Vercel project: `client` (`prj_lWeapZCZqtv32BlfHAuylDzqO20g`). Team: `team_Kt6PAU2cglJsc1PmybP6F5Oh`.
Production alias: https://client-nine-taupe-24.vercel.app

## Source and scope

The September 6 release consolidates the approved original landing and responsive correction (`d92b315`) with the deployed phone/backend and current dashboard/onboarding (`880be86`). Keep this integrated source on `main` after verification. Preserved preview branches remain historical references; they are not interchangeable deploy roots.

The composed artifact serves `/`, `/dashboard/`, `/comercial/`, `/termos/`, `/privacidade/`, and the server-only `/api/sales-session` adapter. It does not redeploy EC2, Supabase migrations or Edge functions. Those releases have independent receipts. The project has no Git integration as verified on September 6: pushing Git alone does not publish.

## Build and configuration

1. Use a clean committed source. Run `npm ci` in `dashboard/` and ensure the pinned Bun/Node toolchain is on a short PATH.
2. Provide all four public build inputs: `LIGOU_PUBLIC_SUPABASE_URL`, `LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `LIGOU_PUBLIC_SUPABASE_FUNCTIONS_URL`, `LIGOU_PUBLIC_SESSION_URL`. The voice endpoint must resolve to the intended authenticated Edge `browser-session`, never localhost. Public keys must not be service-role credentials.
3. Run `npm run test:dashboard --prefix dashboard`, `bun run site:build --production`, and `npm run test:sites --prefix dashboard`. The publication build rejects missing public inputs and requires the same project's HTTPS `functions/v1/browser-session` endpoint before invoking a bundler. `bun run site:build` validates the four public inputs by default (`--production` remains an explicit alias). Use `bun run site:build --preview` only for intentional offline/local previews; a preview bundle embeds the loopback voice endpoint and must never be deployed. The build includes landing checks and assembles `dist/client` without private env files or symlinks.
4. Set Vercel server-only `LIGOU_SALES_EDGE_URL` and encrypted `LIGOU_SALES_PROXY_SECRET` for the target environment. They are read at invocation time and never embedded into public JavaScript. The Supabase `SALES_ALLOWED_ORIGINS` list must include each exact production alias and any deployment URL being tested. Preserve existing allowed origins when extending it; verify the local source against the live digest first.
5. Verify Supabase authentication redirect URLs admit `/dashboard/` and `/comercial/` on the final alias. Do not send login messages as part of deployment without explicit authorization.

## Staged production deployment

`site:build` recreates `dist/client`, so restore its ignored `.vercel/project.json` only after building, with the exact project/team IDs above. Do not let the CLI create a new project implicitly.

Deploy the artifact using `vercel deploy --prod --skip-domain --yes` from `dist/client`. This builds with production runtime configuration but leaves the previous production alias intact. Record the returned deployment ID/URL. If deployment protection applies, use the authenticated CLI or authorized access rather than weakening protection.

Verify HTML, compiled JS/CSS, media responses, dashboard nested routes, commercial and legal routes, public configuration, API method/origin behavior and the same-origin sales proxy. Use a non-creating status request to exercise the proxy without spending on a voice call. Inspect the final browser rendering at the responsive regression viewport.

Promote the verified deployment with `vercel promote <deployment-url> --yes`. Repeat route/hash and proxy checks on the stable production alias. Save a sanitized receipt with source commit, deployment ID, previous deployment, bundle hashes and validation results.

## Rollback and repository hygiene

Preserve the prior deployment ID/URL before promotion. `vercel rollback <previous-deployment-url> --yes` restores its production alias without rebuilding. Rollback targets must be protocol-compatible with the deployed Edge function and controller; see `docs/runbooks/PROTOCOL-COMPATIBILITY-AND-ROLLBACK.md`. Preserve call/lead records and existing backend configuration; never delete database records or release budget holds to make a deploy appear clean.

Push the integrated main commit and verify local/remote HEAD agree. Preserve original uncommitted work in a named branch or verified snapshot before changing its checkout. Keep useful worktrees and agents; repository cleanliness means no unintended working-tree changes or unexplained source divergence, not deleting history, backups or review artifacts.
