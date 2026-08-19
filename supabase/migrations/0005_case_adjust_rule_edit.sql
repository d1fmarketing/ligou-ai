-- Owner adjustments: adjust a pending case's proposed action; edit an approved rule as a NEW version.

create or replace function public.adjust_case(p_case uuid, p_proposal text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_case public.approval_cases; v_rows int;
begin
  select c.* into v_case from public.approval_cases c
    join public.tenants t on t.id = c.tenant_id and t.owner_user_id = auth.uid()
    where c.id = p_case for update;
  if v_case.id is null then raise exception 'case_not_found_or_not_owner'; end if;
  if v_case.status <> 'pendente' then raise exception 'case_already_decided'; end if;
  update public.approval_cases set
    proposed_action = p_proposal,
    resolution = coalesce(resolution, '{}'::jsonb) || jsonb_build_object(
      'adjustments', coalesce(resolution->'adjustments', '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object('before', v_case.proposed_action, 'after', p_proposal, 'at', now())))
  where id = p_case and status = 'pendente';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'case_race_lost'; end if;
  return jsonb_build_object('case_id', p_case, 'proposed_action', p_proposal);
end $$;
revoke all on function public.adjust_case(uuid,text) from public, anon;

create or replace function public.edit_rule(p_rule uuid, p_text text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_rule public.rules; v_new uuid;
begin
  select r.* into v_rule from public.rules r
    join public.tenants t on t.id = r.tenant_id and t.owner_user_id = auth.uid()
    where r.id = p_rule;
  if v_rule.id is null then raise exception 'rule_not_found_or_not_owner'; end if;
  if v_rule.status <> 'aprovado' then raise exception 'only_approved_can_be_edited'; end if;
  if coalesce(trim(p_text),'') = '' then raise exception 'text_required'; end if;
  insert into public.rules (tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured, approved_by, approved_at)
    values (v_rule.tenant_id, v_rule.rule_group_id, v_rule.version + 1, 'edicao_manual', v_rule.escopo,
            'aprovado', v_rule.category, p_text, v_rule.structured, auth.uid(), now())
    returning id into v_new;
  insert into public.receipts (tenant_id, kind, outcome, external_id, readback, payload_hash, detail)
    values (v_rule.tenant_id, 'rule_change', 'accepted', v_new::text,
            jsonb_build_object('edited_from', p_rule), md5(p_text), jsonb_build_object('op','edit'));
  return v_new;
end $$;
revoke all on function public.edit_rule(uuid,text) from public, anon;
