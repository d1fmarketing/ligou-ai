-- V0.2 M2: "Restaurar demonstração" on a real signed-in tenant was an honest no-op, so
-- repeated onboarding E2E runs piled suggestion batches into Memória with no way to
-- start a test from zero. The owner can now reset their own SIMULATION-ONLY tenant's
-- working memory through the same append-only versioning the product already uses:
-- nothing is deleted — every group gets a terminal 'rejeitado' version (approved rules
-- pass through 'revogado' first so effective_rules drops them by the designed path),
-- pending approval cases expire, and one receipt records the reset.
-- Forward-only; no existing object is altered.

create or replace function public.reset_owner_test_memory()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_role text;
  v_tenant public.tenants;
  v_revoked int := 0;
  v_rejected int := 0;
  v_cases int := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    '');
  if v_role <> 'authenticated' then
    raise exception using errcode = '42501', message = 'authenticated_role_required';
  end if;

  select t.* into v_tenant
  from public.tenants t
  where t.owner_user_id = v_uid and t.bootstrap_origin = 'v0_2_google'
  order by t.created_at asc
  limit 1;
  if v_tenant.id is null then
    raise exception using errcode = 'P0002', message = 'tenant_not_found';
  end if;
  if v_tenant.operational_mode <> 'simulation_only' then
    raise exception using errcode = '42501', message = 'reset_requires_simulation_only';
  end if;

  -- Per-tenant rules-versioning lock, shared with decide_rule/revoke_rule (replaced
  -- below): without it a concurrent decision can collide with the reset on the
  -- (rule_group_id, version) unique constraint and abort either transaction.
  perform pg_advisory_xact_lock(hashtextextended('ligou.v0_2.rules_versioning:' || v_tenant.id::text, 0));

  -- Pass 1: approved groups lose effectiveness by the designed path (a 'revogado'
  -- version), exactly like revoke_rule does one at a time.
  with latest as (
    select distinct on (r.rule_group_id) r.*
    from public.rules r
    where r.tenant_id = v_tenant.id
    order by r.rule_group_id, r.version desc, r.created_at desc, r.id desc
  )
  insert into public.rules
    (tenant_id, rule_group_id, version, origem, escopo, status, category, text,
     structured, evidence_quote, related_call_id, approved_by, approved_at)
  select l.tenant_id, l.rule_group_id, l.version + 1, l.origem, l.escopo, 'revogado',
         l.category, l.text, l.structured, l.evidence_quote, l.related_call_id, v_uid, now()
  from latest l
  where l.status = 'aprovado';
  get diagnostics v_revoked = row_count;

  -- Pass 2: every group that is not already terminally rejected gets a 'rejeitado'
  -- version, which removes it from the working memory list.
  with latest as (
    select distinct on (r.rule_group_id) r.*
    from public.rules r
    where r.tenant_id = v_tenant.id
    order by r.rule_group_id, r.version desc, r.created_at desc, r.id desc
  )
  insert into public.rules
    (tenant_id, rule_group_id, version, origem, escopo, status, category, text,
     structured, evidence_quote, related_call_id, approved_by, approved_at)
  select l.tenant_id, l.rule_group_id, l.version + 1, l.origem, l.escopo, 'rejeitado',
         l.category, l.text, l.structured, l.evidence_quote, l.related_call_id, v_uid, now()
  from latest l
  where l.status <> 'rejeitado';
  get diagnostics v_rejected = row_count;

  update public.approval_cases set
    status = 'expirada',
    resolved_at = now(),
    resolved_by = v_uid,
    resolution = jsonb_build_object('mode', 'test_reset')
  where tenant_id = v_tenant.id and status = 'pendente';
  get diagnostics v_cases = row_count;

  insert into public.receipts (tenant_id, kind, outcome, external_id, readback, payload_hash, detail)
  values (v_tenant.id, 'rule_change', 'accepted', 'test_reset:' || now()::text,
          jsonb_build_object('revoked', v_revoked, 'rejected', v_rejected, 'cases_expired', v_cases),
          md5(v_tenant.id::text || 'test_reset' || now()::text),
          jsonb_build_object('mode', 'test_reset', 'operational_mode', v_tenant.operational_mode));

  return jsonb_build_object(
    'tenant_id', v_tenant.id,
    'revoked', v_revoked,
    'rejected', v_rejected,
    'cases_expired', v_cases);
end
$$;

revoke all on function public.reset_owner_test_memory() from public, anon;
grant execute on function public.reset_owner_test_memory() to authenticated;

-- decide_rule and revoke_rule re-issued byte-identical to 0003 plus the shared
-- per-tenant rules-versioning advisory lock, taken after ownership is proven and
-- before the version math, so a decision can never race the reset (or another
-- decision) into a (rule_group_id, version) collision. Grants are unchanged.

create or replace function public.decide_rule(p_rule uuid, p_decision text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_rule public.rules; v_new uuid;
begin
  select r.* into v_rule from public.rules r
    join public.tenants t on t.id = r.tenant_id and t.owner_user_id = auth.uid()
    where r.id = p_rule;
  if v_rule.id is null then raise exception 'rule_not_found_or_not_owner'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ligou.v0_2.rules_versioning:' || v_rule.tenant_id::text, 0));
  if v_rule.status <> 'sugerido' then raise exception 'rule_not_pending: %', v_rule.status; end if;
  if p_decision not in ('aprovado','rejeitado') then raise exception 'invalid_decision'; end if;
  insert into public.rules (tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured, evidence_quote, related_call_id, approved_by, approved_at)
    values (v_rule.tenant_id, v_rule.rule_group_id, v_rule.version + 1, v_rule.origem, v_rule.escopo,
            p_decision, v_rule.category, v_rule.text, v_rule.structured, v_rule.evidence_quote, v_rule.related_call_id,
            auth.uid(), now())
    returning id into v_new;
  return v_new;
end $$;

create or replace function public.revoke_rule(p_rule uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_rule public.rules; v_new uuid;
begin
  select r.* into v_rule from public.rules r
    join public.tenants t on t.id = r.tenant_id and t.owner_user_id = auth.uid()
    where r.id = p_rule;
  if v_rule.id is null then raise exception 'rule_not_found_or_not_owner'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ligou.v0_2.rules_versioning:' || v_rule.tenant_id::text, 0));
  if v_rule.status <> 'aprovado' then raise exception 'only_approved_can_be_revoked'; end if;
  insert into public.rules (tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured, approved_by, approved_at)
    values (v_rule.tenant_id, v_rule.rule_group_id, v_rule.version + 1, v_rule.origem, v_rule.escopo,
            'revogado', v_rule.category, v_rule.text, v_rule.structured, auth.uid(), now())
    returning id into v_new;
  insert into public.receipts (tenant_id, kind, outcome, external_id, readback, payload_hash, detail)
    values (v_rule.tenant_id, 'rule_change', 'accepted', v_new::text,
            jsonb_build_object('revoked_rule', p_rule), md5(p_rule::text || 'revogado'),
            jsonb_build_object('reason', p_reason));
  return v_new;
end $$;
