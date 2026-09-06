-- A resumed browser may retain a capability after its action TTL expires.
-- Recover only a matching, definitively closed receipt; never extend admission,
-- connected acknowledgement, SDP access, or authority over unresolved sessions.
create or replace function public.sales_public_session(p_session_id uuid,p_token_hash text,p_network_hash text,p_end boolean default false) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.sales_sessions;t public.sales_cancellations;day_start timestamptz:=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC';
begin
 if p_session_id is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or p_network_hash is null or p_network_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_request';end if;
 -- Existing sessions and cancellation replays never take the global admission lock.
 select * into s from public.sales_sessions where session_id=p_session_id for update;
 if not found then
  select * into t from public.sales_cancellations where session_id=p_session_id;
  if not found and p_end then
   -- Fast rejection avoids contending on the singleton once either bound is exhausted.
   if (select count(*) from public.sales_cancellations where network_hash=p_network_hash and created_at>=day_start)>=10
      or (select count(*) from public.sales_cancellations where created_at>=day_start)>=100 then raise exception 'cancellation_limit';end if;
   -- Same lock order as admission; no session row was locked above because it did not exist.
   perform 1 from public.sales_configuration where singleton for update;
   select * into s from public.sales_sessions where session_id=p_session_id for update;
   if not found then
    select * into t from public.sales_cancellations where session_id=p_session_id;
    if not found then
     -- Recheck under lock: concurrent unknown requests cannot overrun either bound.
     if (select count(*) from public.sales_cancellations where network_hash=p_network_hash and created_at>=day_start)>=10
        or (select count(*) from public.sales_cancellations where created_at>=day_start)>=100 then raise exception 'cancellation_limit';end if;
     insert into public.sales_cancellations(session_id,token_hash,network_hash) values(p_session_id,p_token_hash,p_network_hash) returning * into t;
    end if;
   end if;
  end if;
  if s.session_id is null then
   if t.session_id is null or t.token_hash<>p_token_hash then raise exception 'session_not_found';end if;
   -- An existing cancellation proves no admission occurred. Replay is a receipt
   -- at any age and cannot insert another tombstone or authorize a delayed start.
   return jsonb_build_object('session_id',p_session_id,'status','ended','max_minutes',5,'expires_at',t.created_at,'provider_termination_state','not_started');
  end if;
 end if;
 if s.token_hash<>p_token_hash then raise exception 'session_not_found';end if;
 if s.expires_at+interval '1 hour'<clock_timestamp() then
  if (s.status='ended' and s.provider_termination_state in ('confirmed','expired'))
   or (s.status in ('ended','error') and s.provider_termination_state='not_started'
    and s.create_intent_at is null and s.provider_call_id is null) then
   -- Explicit receipt allowlist: no SDP, provider identity/evidence, lead or usage.
   -- Return before the end path, including for p_end=true: no state or cost changes.
   return jsonb_strip_nulls(jsonb_build_object('session_id',s.session_id,'status',s.status,
    'max_minutes',s.max_minutes,'expires_at',s.expires_at,
    'provider_termination_state',s.provider_termination_state,'error',s.error));
  end if;
  raise exception 'session_not_found';
 end if;
 if p_end or s.expires_at<=clock_timestamp() then
  if s.status not in ('ended','error') then
   if s.create_intent_at is null and s.provider_call_id is null then
    update public.sales_sessions set stop_requested=true,status='ended',offer_sdp='',usage_state='settled',updated_at=clock_timestamp() where session_id=s.session_id returning * into s;
   else
    update public.sales_sessions set stop_requested=true,status=case when status='quarantined' then status else 'ending' end,updated_at=clock_timestamp() where session_id=s.session_id returning * into s;
   end if;
  end if;
 end if;
 return public.sales_public_shape(s);
end;$$;
revoke all on function public.sales_public_session(uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.sales_public_session(uuid,text,text,boolean) to service_role;
