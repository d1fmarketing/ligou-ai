-- Forward-only retirement of the legacy connector plaintext credential surface.
-- The preceding hardening migration quarantined these rows; this migration destroys the bytes and column.

update public.connector_accounts
set status = 'reconnect_required',
    last_error = 'legacy_plaintext_reconnect_required',
    updated_at = clock_timestamp()
where refresh_token is not null;

update public.connector_accounts
set refresh_token = null
where refresh_token is not null;

alter table public.connector_accounts
  drop column if exists refresh_token;

revoke all on table public.connector_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.connector_accounts to service_role;

revoke all on function public.get_connector_status() from public, anon;
grant execute on function public.get_connector_status() to authenticated;
