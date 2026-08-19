-- Browser session bootstrap without any inbound port on the EC2: the public Edge Function inserts a
-- request row; the controller (outbound-only, Realtime+poll) performs the actual session start and
-- writes the answer back; the Edge Function returns it to the browser.
create table public.browser_session_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null,
  session_type text not null default 'owner_browser' check (session_type in ('customer','owner_browser','onboarding')),
  model_override text,
  offer_sdp text not null,
  status text not null default 'pending' check (status in ('pending','processing','ready','error','expired')),
  answer_sdp text,
  call_id uuid,
  error text,
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
create index browser_session_requests_status_idx on public.browser_session_requests (status, created_at);

alter table public.browser_session_requests enable row level security;
alter table public.browser_session_requests force row level security;
-- no owner policies: only privileged server code (Edge Function service key / controller secret key) touches this table

alter publication supabase_realtime add table public.browser_session_requests;
