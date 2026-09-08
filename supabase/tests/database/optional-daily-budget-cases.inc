-- Caller owns a disposable transaction; no provider calls are made.
do $optional_daily_budget$
declare
  capped uuid:=gen_random_uuid(); uncapped uuid:=gen_random_uuid();
  capped_call uuid:=gen_random_uuid(); first_call uuid:=gen_random_uuid(); next_call uuid:=gen_random_uuid();
  receipt uuid; denied boolean;
begin
  insert into public.tenants(id,slug,name,daily_budget_usd)
    values(capped,'daily-capped-'||capped,'Capped budget fixture',15),
          (uncapped,'daily-uncapped-'||uncapped,'Uncapped budget fixture',null);
  insert into public.calls(id,tenant_id,session_type,status,ended_at)
    values(capped_call,capped,'onboarding','ended',clock_timestamp()),
          (first_call,uncapped,'onboarding','ended',clock_timestamp()),
          (next_call,uncapped,'onboarding','ended',clock_timestamp());

  denied:=false;
  begin perform public.reserve_call_budget(capped,capped_call,16,55);
  exception when others then
    if sqlerrm not like 'budget_exceeded:%' then raise;end if;denied:=true;
  end;
  assert denied,'A configured daily cap stopped being enforced';
  receipt:=public.reserve_call_budget(uncapped,first_call,7.5,55);
  assert public.reserve_call_budget(uncapped,first_call,7.5,55)=receipt,'Reservation replay changed identity';
  perform public.reserve_call_budget(uncapped,next_call,1000000,55);
  assert (select count(*)=2 and sum(reserved_cost_usd)=1000007.5 from public.budget_reservations where tenant_id=uncapped),'Uncapped reservations were limited or duplicated';
  assert (select count(*)=2 and sum(cost_usd)=1000007.5 from public.usage_ledger where tenant_id=uncapped),'Uncapped usage accounting was lost';

  denied:=false;
  begin perform public.reserve_call_budget(gen_random_uuid(),first_call,7.5,55);
  exception when sqlstate 'P0002' then denied:=true;end;
  assert denied,'A missing tenant was confused with an uncapped tenant';
  denied:=false;
  begin perform public.reserve_call_budget(uncapped,capped_call,7.5,55);
  exception when sqlstate '23503' then denied:=true;end;
  assert denied,'Cross-tenant reservation was accepted';
  denied:=false;
  begin perform public.reserve_call_budget(uncapped,first_call,8,55);
  exception when sqlstate '23505' then denied:=true;end;
  assert denied,'A changed reservation payload was accepted';
end;
$optional_daily_budget$;
