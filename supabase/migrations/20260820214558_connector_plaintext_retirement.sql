-- Forward-only guard for the one-time tenant converter. This migration is local and unapplied.
-- Plaintext stays quarantined and unusable until the converter verifies AES-GCM and clears it atomically.

update public.connector_accounts
set status = 'reconnect_required',
    last_error = 'legacy_plaintext_reconnect_required',
    updated_at = clock_timestamp()
where refresh_token is not null;

alter table public.connector_accounts
  drop constraint if exists connector_accounts_plaintext_quarantined_check;
alter table public.connector_accounts
  add constraint connector_accounts_plaintext_quarantined_check
  check (refresh_token is null or status = 'reconnect_required');

revoke all on table public.connector_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.connector_accounts to service_role;

revoke all on function public.get_connector_status() from public, anon;
grant execute on function public.get_connector_status() to authenticated;
