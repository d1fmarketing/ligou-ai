-- F6: inbound phone events. The accept-call Edge Function writes here; the controller (outbound-only, no open
-- ports anywhere) reacts via Realtime and accepts/attaches the OpenAI SIP call.
create table public.phone_events (
  id uuid primary key default gen_random_uuid(),
  openai_call_id text not null unique,
  called_number text,
  caller_number_hash text,          -- caller id is untrusted; stored hashed for correlation only
  sip_headers jsonb,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','error')),
  tenant_id uuid references public.tenants (id),
  call_id uuid references public.calls (id),
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
alter table public.phone_events enable row level security;
alter table public.phone_events force row level security;
alter publication supabase_realtime add table public.phone_events;
