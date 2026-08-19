-- The plan's data model had tenants.calendar_id; the shipped 0001 migration missed it. The provisioning
-- flow (the Ligou creates its own calendar at deal-time — RJ's product rule) needs somewhere canonical to
-- record which external calendar belongs to the tenant. Never exposed to the model.
alter table public.tenants add column if not exists calendar_id text;
