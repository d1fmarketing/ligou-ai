-- Per-tenant calendar connections (Caso A do docs/CLIENTE-CALENDARIO.md).
-- The customer clicks "Connect Google Calendar", approves, and we keep THEIR refresh token here.
-- Tenants without a row keep using the Ligou-managed calendar (Caso B) — already live.
create table public.connector_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  provider text not null default 'google_calendar' check (provider in ('google_calendar')),
  -- credential material: readable ONLY by the service role (no owner policy below)
  refresh_token text not null,
  calendar_id text not null default 'primary',
  account_email text,
  scopes text,
  status text not null default 'active' check (status in ('active','revoked','error')),
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider)
);

alter table public.connector_accounts enable row level security;
alter table public.connector_accounts force row level security;
-- deliberately NO owner policy: the dashboard learns the connection state from the view below,
-- never from the token itself.

-- Safe projection for the dashboard: says whether it is connected, never exposes the token.
create view public.connector_status
with (security_invoker = true) as
  select tenant_id, provider, account_email, calendar_id, status, connected_at
  from public.connector_accounts;

grant select on public.connector_status to authenticated;

-- OAuth state: short-lived, single-use, ties the callback back to the tenant that started it.
create table public.oauth_states (
  state text primary key,
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
alter table public.oauth_states enable row level security;
alter table public.oauth_states force row level security;
