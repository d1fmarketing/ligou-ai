-- Shared focused SQL assertions. The caller owns the disposable transaction.
do $budget_overrun$
declare
  tenant uuid:=gen_random_uuid(); other_tenant uuid:=gen_random_uuid();
  call_id uuid:=gen_random_uuid(); next_call uuid:=gen_random_uuid(); legacy_call uuid:=gen_random_uuid();
  reservation uuid; legacy_reservation uuid; got uuid; scenario record; rejected boolean;
begin
  insert into public.tenants(id,slug,name,daily_budget_usd,timezone)
    values(tenant,'budget-overrun-'||tenant::text,'Budget overrun fixture',15,'America/Los_Angeles'),
          (other_tenant,'budget-other-'||other_tenant::text,'Other budget fixture',15,'America/Los_Angeles');
  insert into public.calls(id,tenant_id,session_type,status,model,ended_at,duration_seconds,cost_estimate_usd,provider_termination_state,provider_usage_state)
    values(call_id,tenant,'onboarding','killed_budget','gpt-realtime-2.1',clock_timestamp(),480,8.2209408,'confirmed','unknown'),
          (next_call,tenant,'onboarding','active','gpt-realtime-2.1',null,null,null,'not_required','unknown'),
          (legacy_call,other_tenant,'onboarding','ended','gpt-realtime-2.1',clock_timestamp(),30,0.2,'confirmed','unknown');
  perform set_config('request.jwt.claim.role','service_role',true);
  reservation:=public.reserve_call_budget(tenant,call_id,7.5,55);
  legacy_reservation:=public.reserve_call_budget(other_tenant,legacy_call,1.5,15);
  update public.budget_reservations set reconcile_attempts=197 where id in (reservation,legacy_reservation);

  assert has_function_privilege('service_role','public.settle_unresolved_call_budget(uuid,uuid,numeric,numeric,text,jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','public.settle_unresolved_call_budget(uuid,uuid,numeric,numeric,text,jsonb)','EXECUTE');
  assert not has_function_privilege('anon','public.settle_unresolved_call_budget(uuid,uuid,numeric,numeric,text,jsonb)','EXECUTE');

  for scenario in select * from (values
    ('wrong actor','authenticated',false,8.2209408::numeric,197,'killed_budget','confirmed','unknown',true,'service_role_required'),
    ('wrong tenant','service_role',true,8.2209408::numeric,197,'killed_budget','confirmed','unknown',true,'reservation_not_found'),
    ('clip known floor','service_role',false,7.5::numeric,197,'killed_budget','confirmed','unknown',true,'settlement_exceeds_reservation'),
    ('invent higher amount','service_role',false,8.3::numeric,197,'killed_budget','confirmed','unknown',true,'settlement_exceeds_reservation'),
    ('premature estimate','service_role',false,8.2209408::numeric,19,'killed_budget','confirmed','unknown',true,'unresolved_settlement_premature'),
    ('not budget stopped','service_role',false,8.2209408::numeric,197,'ended','confirmed','unknown',true,'settlement_exceeds_reservation'),
    ('provider active','service_role',false,8.2209408::numeric,197,'killed_budget','active','unknown',true,'provider_termination_unconfirmed'),
    ('usage is resolvable','service_role',false,8.2209408::numeric,197,'killed_budget','confirmed','resolved',true,'provider_usage_resolvable'),
    ('no terminal timestamp','service_role',false,8.2209408::numeric,197,'killed_budget','confirmed','unknown',false,'settlement_exceeds_reservation')
  ) x(label,actor,wrong_tenant,amount,attempts,status,provider_state,usage_state,ended,expected_error) loop
    update public.calls set status=scenario.status,provider_termination_state=scenario.provider_state,provider_usage_state=scenario.usage_state,
      ended_at=case when scenario.ended then clock_timestamp() else null end where id=call_id;
    update public.budget_reservations set reconcile_attempts=scenario.attempts where id=reservation;
    perform set_config('request.jwt.claim.role',scenario.actor,true);rejected:=false;
    begin
      perform public.settle_unresolved_call_budget(case when scenario.wrong_tenant then other_tenant else tenant end,call_id,scenario.amount,8,'killed_budget','{}');
    exception when others then
      if sqlerrm<>scenario.expected_error then raise exception 'Unexpected failure for %: %',scenario.label,sqlerrm;end if;
      rejected:=true;
    end;
    assert rejected,'Unsafe settlement accepted: '||scenario.label;
    assert (select status='active' and reserved_cost_usd=7.5 from public.budget_reservations where id=reservation),'Failed settlement changed reservation';
    assert (select count(*)=1 from public.usage_ledger where budget_reservation_id=reservation),'Failed settlement wrote ledger';
  end loop;

  perform set_config('request.jwt.claim.role','service_role',true);
  update public.calls set status='killed_budget',provider_termination_state='confirmed',provider_usage_state='unknown',ended_at=clock_timestamp() where id=call_id;
  update public.budget_reservations set reconcile_attempts=197 where id=reservation;
  rejected:=false;
  begin perform public.settle_unresolved_call_budget(tenant,call_id,8.2209408,8,'ended','{}');
  exception when others then
    if sqlerrm<>'settlement_exceeds_reservation' then raise;end if;rejected:=true;
  end;
  assert rejected,'Observed overrun lost its budget-stop outcome';
  got:=public.settle_unresolved_call_budget(tenant,call_id,8.2209408,8,'killed_budget','{"fixture":"observed-overrun"}');
  assert got=reservation;
  assert (select status='settled' and final_cost_usd=8.2209408 and reserved_cost_usd=7.5 from public.budget_reservations where id=reservation),'Durable floor or original reservation changed';
  assert (select provider_usage_state='unknown' and usage_tokens is null and cost_estimate_usd=8.2209408 from public.calls where id=call_id),'Estimated settlement fabricated final usage';
  assert (select sum(cost_usd)=8.2209408 and count(*)=3 from public.usage_ledger where budget_reservation_id=reservation),'Ledger did not preserve exact floor';
  assert (select detail->>'settlement_basis'='observed_usage_floor' and detail->>'provider_usage_state'='unknown' from public.usage_ledger where budget_reservation_id=reservation and kind='usage'),'Estimate provenance lost';
  assert public.settle_unresolved_call_budget(tenant,call_id,8.2209408,8,'killed_budget','{}')=reservation;
  assert (select count(*)=3 from public.usage_ledger where budget_reservation_id=reservation),'Repeated settlement duplicated ledger';
  assert (select daily_budget_usd=15 from public.tenants where id=tenant),'Daily limit changed';
  rejected:=false;
  begin perform public.reserve_call_budget(tenant,next_call,7.5,55);
  exception when others then
    if sqlerrm not like 'budget_exceeded:%' then raise;end if;rejected:=true;
  end;
  assert rejected,'Overrun created spending headroom for a future call';
  assert not exists(select 1 from public.budget_reservations where public.budget_reservations.call_id=next_call),'Denied future call obtained a reservation';

  assert public.settle_unresolved_call_budget(other_tenant,legacy_call,0.2,0.5,'ended','{}')=legacy_reservation;
  assert (select final_cost_usd=0.2 and reserved_cost_usd=1.5 from public.budget_reservations where id=legacy_reservation),'Legacy estimate changed';
  assert (select detail->>'settlement_basis'='reservation_rate_estimate' from public.usage_ledger where budget_reservation_id=legacy_reservation and kind='usage'),'Legacy basis changed';
end $budget_overrun$;
