# Security containment

## Scope and invariant

No credential belongs in a URL, client bundle, Git content, or `.env.example`. The dashboard uses the
standard Supabase magic-link flow. The repository scanner is intentionally narrow: it checks tracked files
only and masks every finding as category, path, line, and short SHA-256 fingerprint.

## Operator-only rotation checklist

If a credential may have been exposed, an authorized operator must:

1. Inventory the affected provider and credential class without pasting values into tickets, chat, or Git.
2. Revoke or rotate the exposed credential at its issuing provider; create a least-privilege replacement.
3. Update the authorized secret store and runtime configuration out of band. Do not put a replacement in a
   repository file, build variable, URL, or local example file.
4. For dashboard access, invalidate the affected password/session at the identity provider and require a
   normal magic-link sign-in. Do not reintroduce a test bypass.
5. Redeploy only through the approved change process, then verify the responsible provider/runtime surface.
6. Record the incident, affected scope, rotation time, and verification result without recording secret values.
7. Run `bun run secrets:scan` before closing the containment work; retain only its masked output.

This document intentionally has no credential values, project identifiers, account IDs, IP addresses, or
deployment URLs.
