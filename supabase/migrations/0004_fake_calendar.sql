-- Fake calendar provider table: stands in for Google until Workspace credentials exist.
-- Service-role access only (RLS forced with no policies => deny for anon/authenticated).
create table public.fake_calendar_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  summary text not null,
  description text,
  start_iso text not null,
  end_iso text not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
alter table public.fake_calendar_events enable row level security;
alter table public.fake_calendar_events force row level security;
