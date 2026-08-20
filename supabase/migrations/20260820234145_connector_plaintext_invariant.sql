-- Final forward-only invariant. Apply only after the per-tenant converter reports zero eligible rows.
do $$
begin
  if exists (
    select 1 from public.connector_accounts where refresh_token is not null
  ) then
    raise exception using errcode = 'P0001', message = 'legacy_connector_plaintext_remaining';
  end if;
end;
$$;

alter table public.connector_accounts
  drop constraint if exists connector_accounts_plaintext_quarantined_check,
  drop column if exists refresh_token;

revoke all on table public.connector_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.connector_accounts to service_role;

revoke all on function public.get_connector_status() from public, anon;
grant execute on function public.get_connector_status() to authenticated;
