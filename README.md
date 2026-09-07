# Ligou.AI

Ligou is an AI operational employee for service businesses: a public voice demonstration, an authenticated owner dashboard, business rules and approvals, and controlled voice/booking infrastructure.

## Current release

The approved original website and current dashboard are deployed at **https://client-nine-taupe-24.vercel.app**. The September 6, 2026 release consolidates the website, responsive fixes, sales runtime source, and first-phone preparation on `main`.

- [Latest onboarding resume recovery](docs/release/ONBOARDING-RESUME-RECOVERY-2026-09-06.md)
- [Production release receipt and verification](docs/release/VERCEL-2026-09-06.md)
- [Build, deploy and rollback](docs/DEPLOY-DASHBOARD.md)
- [Repository map](docs/REPOSITORY-MAP.md)
- [Responsive QA](docs/HERO-RESPONSIVE-QA-20260906.md)
- [First phone number setup](docs/RUNBOOK-TELEFONE-F6.md)
- [Security and authority boundaries](docs/SECURITY-RULEBOOK.md)

Website deployment and passing automated tests do not establish real phone-number activation or human voice acceptance. Phone intake remains a separate rollout; see its runbook and dated installation receipt.

## Local verification

```sh
bun run check
npm run test:dashboard --prefix dashboard
npm run build --prefix dashboard
npm run test:sites --prefix dashboard
bun voice-controller/scripts/run-unit-tests.mjs
```

Production composition uses `bun run site:build` with the four explicit public build inputs described in the deployment runbook. Provider credentials stay server-side. Database changes additionally require the isolated gate described in [VERIFICATION.md](docs/VERIFICATION.md).

Older V0.1/RC1 documents are dated historical evidence, not the current deployment inventory. Keep preserved versions and backups; use `main` for the integrated release source.
