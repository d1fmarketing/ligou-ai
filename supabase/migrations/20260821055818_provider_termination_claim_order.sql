create or replace function public.claim_provider_termination_reconciliation(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call public.calls;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if nullif(p_worker, '') is null then
    raise exception 'worker_required' using errcode = '22023';
  end if;

  select c.* into v_call
  from public.calls c
  where c.status <> 'active'
    and c.provider_termination_state in ('active','pending','unknown')
    and c.provider_termination_mode in ('reject','hangup')
    and c.provider_termination_reconcile_after <= clock_timestamp()
    and (
      c.provider_termination_reconcile_lease_until is null
      or c.provider_termination_reconcile_lease_until <= clock_timestamp()
    )
  order by c.started_at, c.id
  for update of c skip locked
  limit 1;

  if v_call.id is null then return null; end if;

  update public.calls c
  set provider_termination_reconcile_attempts = c.provider_termination_reconcile_attempts + 1,
      provider_termination_reconcile_lease_until = clock_timestamp() + interval '30 seconds',
      provider_termination_reconcile_worker = left(p_worker, 100)
  where c.id = v_call.id;

  return jsonb_build_object(
    'call_id', v_call.id,
    'openai_call_id', v_call.openai_call_id,
    'provider_termination_mode', v_call.provider_termination_mode,
    'provider_termination_reason', v_call.provider_termination_reason
  );
end;
$$;

revoke all on function public.claim_provider_termination_reconciliation(text) from public, anon, authenticated;
grant execute on function public.claim_provider_termination_reconciliation(text) to service_role;
