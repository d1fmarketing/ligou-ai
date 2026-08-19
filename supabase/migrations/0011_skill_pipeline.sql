-- Plan v4 §11: Hermes may write skills, but it cannot sign its own certificate. Every candidate walks a
-- pipeline: capability manifest -> independent scanner -> Ligou-owned tests -> sandbox -> tenant canary ->
-- immutable digest -> promotion -> automatic rollback. A skill that uses ONLY existing powers and passes the
-- pipeline promotes itself (no human click). A skill that asks for a NEW power goes to the owner (VERMELHO).

create table public.skill_candidates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  source text not null,                       -- the skill body as proposed by the cell
  digest text not null,                       -- sha256 of source; immutable identity of this version
  manifest jsonb not null default '{}',       -- {capabilities:[], channels:[], reads:[], writes:[]}
  origin text not null default 'hermes' check (origin in ('hermes','owner','ligou_core')),
  status text not null default 'proposed' check (status in
    ('proposed','scanning','rejected_scan','needs_power','testing','failed_tests','canary','promoted','rolled_back','revoked')),
  scan_findings jsonb not null default '[]',  -- why the scanner refused, when it did
  required_powers text[] not null default '{}',
  missing_powers text[] not null default '{}',
  canary_runs int not null default 0,
  canary_failures int not null default 0,
  promoted_at timestamptz,
  rolled_back_at timestamptz,
  rollback_reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, name, digest)
);
create index skill_candidates_tenant_idx on public.skill_candidates (tenant_id, status, created_at desc);

-- Append-only trail of every pipeline transition: who/what moved the skill and why.
create table public.skill_pipeline_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  candidate_id uuid not null references public.skill_candidates (id),
  stage text not null,
  outcome text not null check (outcome in ('pass','fail','defer')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create trigger skill_events_append_only before update or delete on public.skill_pipeline_events
  for each row execute function public.block_mutation();

alter table public.skill_candidates enable row level security;
alter table public.skill_candidates force row level security;
alter table public.skill_pipeline_events enable row level security;
alter table public.skill_pipeline_events force row level security;

create policy skill_candidates_owner_select on public.skill_candidates for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));
create policy skill_events_owner_select on public.skill_pipeline_events for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));

alter publication supabase_realtime add table public.skill_candidates;
