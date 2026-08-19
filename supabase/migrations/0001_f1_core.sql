-- F1 core: tenants, rules (versioned, append-only), approval_cases, calls, usage ledger + budget gate.
-- Authority principle: mutations of status flow through RPCs (F2 hardens); tables deny direct UPDATE/DELETE where append-only.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tenants
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  vertical text,
  owner_user_id uuid references auth.users (id),
  status text not null default 'provisioning' check (status in ('provisioning','active','paused')),
  languages text[] not null default '{en,es}',
  plan_minutes int not null default 400,
  timezone text not null default 'America/Los_Angeles',
  daily_budget_usd numeric not null default 15,
  session_max_minutes int not null default 15,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- rules (append-only, versioned)
create table public.rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  rule_group_id uuid not null default gen_random_uuid(),
  version int not null default 1 check (version > 0),
  origem text not null check (origem in ('onboarding','escalacao','edicao_manual','aprendizado')),
  escopo text not null default 'geral' check (escopo in ('geral','servico','localizacao','cliente')),
  status text not null default 'sugerido' check (status in ('sugerido','aprovado','rejeitado','revogado')),
  category text not null,
  text text not null,
  structured jsonb,
  evidence_quote text,
  related_call_id uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (rule_group_id, version)
);
create index rules_tenant_status_idx on public.rules (tenant_id, status, category);

create or replace function public.block_mutation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'append_only: % on %.% is forbidden; insert a new version via RPC', tg_op, tg_table_schema, tg_table_name;
end $$;

create trigger rules_append_only before update or delete on public.rules
  for each row execute function public.block_mutation();

-- ---------------------------------------------------------------- approval cases
create table public.approval_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  call_id uuid,
  client_name text,
  contact text,
  request text not null,
  proposed_action text,
  price_quoted numeric,
  urgency text not null default 'normal' check (urgency in ('normal','urgente')),
  rule_consulted uuid references public.rules (id),
  status text not null default 'pendente' check (status in ('pendente','aprovada','recusada','expirada')),
  resolution jsonb,
  evidence_quote text,
  idempotency_key text not null unique,
  decision_hash text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create index approval_cases_tenant_idx on public.approval_cases (tenant_id, status, created_at desc);

-- ---------------------------------------------------------------- calls + usage
create table public.calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  channel text not null default 'browser' check (channel in ('browser','phone','onboarding','eval')),
  session_type text not null default 'customer' check (session_type in ('customer','owner_browser','onboarding')),
  model text,
  status text not null default 'active' check (status in ('active','ended','killed_budget','killed_deadline','error')),
  language text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds int,
  transcript jsonb not null default '[]',
  summary_pt text,
  summary_status text not null default 'pending' check (summary_status in ('pending','pending_ingest','ready','failed')),
  usage_tokens jsonb,
  cost_estimate_usd numeric,
  openai_call_id text
);
create index calls_tenant_idx on public.calls (tenant_id, started_at desc);

create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  call_id uuid references public.calls (id),
  kind text not null check (kind in ('reservation','usage','adjustment')),
  minutes numeric,
  cost_usd numeric not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index usage_ledger_tenant_day_idx on public.usage_ledger (tenant_id, created_at);

-- Atomic budget reservation: sums today's ledger under lock, inserts a reservation or raises.
create or replace function public.reserve_call_budget(p_tenant uuid, p_call uuid, p_est_cost numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_budget numeric; v_spent numeric; v_id uuid;
begin
  select t.daily_budget_usd into v_budget from public.tenants t where t.id = p_tenant for update;
  if v_budget is null then raise exception 'tenant_not_found'; end if;
  select coalesce(sum(l.cost_usd),0) into v_spent
    from public.usage_ledger l
    where l.tenant_id = p_tenant and l.created_at >= date_trunc('day', now());
  if v_spent + p_est_cost > v_budget then
    raise exception 'budget_exceeded: spent % + est % > cap %', v_spent, p_est_cost, v_budget;
  end if;
  insert into public.usage_ledger (tenant_id, call_id, kind, cost_usd, detail)
    values (p_tenant, p_call, 'reservation', p_est_cost, jsonb_build_object('at','session_start'))
    returning id into v_id;
  return v_id;
end $$;
revoke all on function public.reserve_call_budget(uuid, uuid, numeric) from public, anon;

-- ---------------------------------------------------------------- RLS
alter table public.tenants enable row level security;
alter table public.tenants force row level security;
alter table public.rules enable row level security;
alter table public.rules force row level security;
alter table public.approval_cases enable row level security;
alter table public.approval_cases force row level security;
alter table public.calls enable row level security;
alter table public.calls force row level security;
alter table public.usage_ledger enable row level security;
alter table public.usage_ledger force row level security;

-- Owner reads/acts on own tenant rows (dashboard). Writes of authority flow via RPC (F2).
create policy tenants_owner_select on public.tenants for select using (owner_user_id = auth.uid());
create policy rules_owner_select on public.rules for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));
create policy cases_owner_select on public.approval_cases for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));
create policy calls_owner_select on public.calls for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));
create policy usage_owner_select on public.usage_ledger for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));

-- ---------------------------------------------------------------- realtime
alter publication supabase_realtime add table public.approval_cases;
alter publication supabase_realtime add table public.rules;
alter publication supabase_realtime add table public.calls;
