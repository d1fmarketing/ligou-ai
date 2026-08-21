# Calendar connector — local contract

Calendar runtime is tenant-connector-only. Configure `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET`, then use the authenticated owner connection flow.

The callback encrypts the provider refresh token with tenant/provider/account/key-version AAD before storing
it. Runtime selects and decrypts that tenant row only. Do not install refresh tokens, service-account keys,
calendar IDs, or managed-calendar fallback values in process environment.

Local tests cover connector absence/error/revocation, authenticated decryption, provider readback,
idempotency, and free/busy failure behavior. They do not prove a deployed Edge Function, migrated database,
or live Google Calendar connection.
