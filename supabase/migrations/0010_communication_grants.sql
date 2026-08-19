-- Plan v4 §12: proactive communication needs a COMPLETE grant — consent/origin, channel, recipient,
-- purpose, content limits, quiet hours, frequency, opt-out, duration. Without this the agent could text a
-- customer at 3am or spam them; with it, each message goes out on its own and is logged, no owner click.
-- Enforcement lives in code (powers.ts) against these tables + powers.conditions.

-- Who must never be contacted again, per tenant. Checked before any outbound message.
create table public.contact_opt_outs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  contact_hash text not null,               -- sha256 of the normalized contact; raw contact never stored here
  channel text not null default '*' check (channel in ('*','sms','whatsapp','email','voice')),
  reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, contact_hash, channel)
);
create index contact_opt_outs_lookup on public.contact_opt_outs (tenant_id, contact_hash);

-- Every proactive message the agent sends. Doubles as the frequency-cap ledger and the audit trail.
create table public.communications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  call_id uuid references public.calls (id),
  contact_hash text not null,
  channel text not null check (channel in ('sms','whatsapp','email','voice')),
  purpose text not null,                    -- follow_up | confirmation | reminder
  body_preview text,                        -- truncated, for the owner's audit view
  power_id uuid references public.powers (id),
  status text not null default 'queued' check (status in ('queued','sent','failed','blocked')),
  blocked_reason text,                      -- quiet_hours | opt_out | frequency_cap | no_grant
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index communications_freq_idx on public.communications (tenant_id, contact_hash, created_at desc);

alter table public.contact_opt_outs enable row level security;
alter table public.contact_opt_outs force row level security;
alter table public.communications enable row level security;
alter table public.communications force row level security;

create policy opt_outs_owner_select on public.contact_opt_outs for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));
create policy communications_owner_select on public.communications for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));

alter publication supabase_realtime add table public.communications;

-- Seed the communication grant for the synthetic tenant: SMS follow-ups, business hours only,
-- at most 2 messages per contact per 7 days, expiring in 90 days.
insert into public.powers (tenant_id, subject, capability, resource, conditions, expires_at, granted_by)
select id, 'hermes', 'follow_up_message', 'sms',
  jsonb_build_object(
    'channel', jsonb_build_array('sms'),
    'purpose', jsonb_build_array('follow_up','confirmation'),
    'allowed_hours', jsonb_build_object('start','08:00','end','18:00','days', jsonb_build_array('mon','tue','wed','thu','fri','sat')),
    'quiet_hours_respect', true,
    'frequency', jsonb_build_object('max', 2, 'per_days', 7),
    'requires_prior_consent', true,
    'max_body_chars', 320
  ),
  now() + interval '90 days', null
from public.tenants where slug = 'rocha-plumbing';
