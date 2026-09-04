-- Isolated first-party sales admission. No customer tenant/runtime tables are modified.
create table public.sales_configuration (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 owner_user_id uuid references auth.users(id),
 max_minutes integer not null default 5 check(max_minutes between 1 and 5),
 session_cost_ceiling_usd numeric(12,6) not null default 1.5 check(session_cost_ceiling_usd>0 and session_cost_ceiling_usd<=1.5),
 daily_budget_usd numeric(12,6) not null default 15 check(daily_budget_usd>0 and daily_budget_usd<=15),
 visitor_daily_limit integer not null default 3 check(visitor_daily_limit between 1 and 3),
 network_daily_limit integer not null default 10 check(network_daily_limit between 1 and 10),
 heartbeat_at timestamptz, worker_id text
);
insert into public.sales_configuration(singleton) values(true);
create table public.sales_sessions (
 session_id uuid primary key, request_id uuid not null unique check(session_id=request_id),
 token_hash text not null check(token_hash ~ '^[a-f0-9]{64}$'),
 visitor_hash text not null check(visitor_hash ~ '^[a-f0-9]{64}$'),
 network_hash text not null check(network_hash ~ '^[a-f0-9]{64}$'),
 status text not null default 'pending' check(status in ('pending','starting','ready','ending','ended','error','quarantined')),
 offer_sdp text not null check(length(offer_sdp) between 0 and 65536), answer_sdp text,
 provider_call_id text, model text, client_connected_at timestamptz,
 max_minutes integer not null, expires_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 stop_requested boolean not null default false, claim_token uuid, lease_expires_at timestamptz, worker_id text,
 create_intent_at timestamptz, create_attempts integer not null default 0,
 reserved_cost_usd numeric(12,6) not null check(reserved_cost_usd>0 and reserved_cost_usd<=1.5),
 observed_cost_usd numeric(12,6) not null default 0 check(observed_cost_usd>=0),
 usage_state text not null default 'reserved' check(usage_state in ('reserved','observed','settled')),
 provider_termination_state text not null default 'not_started' check(provider_termination_state in ('not_started','requested','confirmed','unknown')),
 error text
);
create index sales_sessions_visitor_day on public.sales_sessions(visitor_hash,created_at);
create index sales_sessions_network_day on public.sales_sessions(network_hash,created_at);
create index sales_sessions_unsettled on public.sales_sessions(created_at) where usage_state <> 'settled';
create index sales_sessions_active on public.sales_sessions(created_at) where status not in ('ended','error');
create table public.sales_cancellations(
 session_id uuid primary key,token_hash text not null check(token_hash ~ '^[a-f0-9]{64}$'),
 network_hash text not null check(network_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp()
);
create index sales_cancellations_network_day on public.sales_cancellations(network_hash,created_at);
create index sales_cancellations_day on public.sales_cancellations(created_at);
create table public.sales_transcript_items (
 id uuid primary key default gen_random_uuid(),session_id uuid not null references public.sales_sessions(session_id),
 provider_item_id text not null check(length(provider_item_id) between 1 and 200),
 role text not null check(role in ('user','assistant')),text text not null check(length(text) between 1 and 16000),
 provider_usage jsonb,
 context text not null default 'real' check(context in ('real','roleplay')),
 created_at timestamptz not null default clock_timestamp(),unique(session_id,provider_item_id)
);
create table public.sales_usage_events (
 session_id uuid not null references public.sales_sessions(session_id),provider_event_id text not null check(length(provider_event_id) between 1 and 200),
 provider_usage jsonb not null check(jsonb_typeof(provider_usage)='object'),observed_cost_usd numeric(12,6) not null check(observed_cost_usd>=0),
 created_at timestamptz not null default clock_timestamp(),primary key(session_id,provider_event_id)
);
create table public.sales_leads (
 session_id uuid primary key references public.sales_sessions(session_id),fields jsonb not null default '{}',
 contact_confirmed boolean not null default false,contact_confirmation jsonb,
 followup_consent boolean not null default false,followup_consent_evidence jsonb,
 followup_decision_at timestamptz,followup_decision_item_id text,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
alter table public.sales_usage_events enable row level security;
alter table public.sales_usage_events force row level security;
alter table public.sales_configuration enable row level security;
alter table public.sales_configuration force row level security;
alter table public.sales_sessions enable row level security;
alter table public.sales_sessions force row level security;
alter table public.sales_cancellations enable row level security;
alter table public.sales_cancellations force row level security;
alter table public.sales_transcript_items enable row level security;
alter table public.sales_transcript_items force row level security;
alter table public.sales_leads enable row level security;
alter table public.sales_leads force row level security;
revoke all on public.sales_configuration,public.sales_sessions,public.sales_cancellations,public.sales_transcript_items,public.sales_leads,public.sales_usage_events from public,anon,authenticated,service_role;
grant select,update on public.sales_configuration to service_role;
grant select,insert,update on public.sales_sessions,public.sales_leads to service_role;
grant select,insert on public.sales_cancellations,public.sales_transcript_items,public.sales_usage_events to service_role;
-- The private config is never exposed just to support an RLS predicate.
create function public.sales_is_owner() returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.sales_configuration where singleton and owner_user_id=(select auth.uid()));
$$;
revoke all on function public.sales_is_owner() from public,anon;
grant execute on function public.sales_is_owner() to authenticated,service_role;
grant select on public.sales_leads,public.sales_transcript_items to authenticated;
grant select(session_id,status,max_minutes,expires_at,created_at,updated_at,provider_termination_state,error) on public.sales_sessions to authenticated;
create policy sales_owner_leads on public.sales_leads for select to authenticated using ((select public.sales_is_owner()));
create policy sales_owner_transcript on public.sales_transcript_items for select to authenticated using ((select public.sales_is_owner()));
create policy sales_owner_sessions on public.sales_sessions for select to authenticated using ((select public.sales_is_owner()));

-- Helpers are also service-only; public shape intentionally excludes provider and token identities.
create function public.sales_public_shape(s public.sales_sessions) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_strip_nulls(jsonb_build_object('session_id',s.session_id,'status',s.status,'max_minutes',s.max_minutes,'expires_at',s.expires_at,
 'sdp',case when s.status='ready' then s.answer_sdp end,'error',s.error,'provider_termination_state',s.provider_termination_state));
$$;
create function public.sales_worker_shape(s public.sales_sessions) returns jsonb language sql immutable set search_path='' as $$
 select to_jsonb(s)-array['token_hash','visitor_hash','network_hash','worker_id'];
$$;
create function public.sales_admit(p_request_id uuid,p_token_hash text,p_visitor_hash text,p_network_hash text,p_offer_sdp text) returns jsonb
language plpgsql set search_path='' as $$
declare c public.sales_configuration; s public.sales_sessions; t public.sales_cancellations; day_start timestamptz:=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'; spent numeric;
begin
 if p_request_id is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or p_visitor_hash is null or p_visitor_hash !~ '^[a-f0-9]{64}$' or p_network_hash is null or p_network_hash !~ '^[a-f0-9]{64}$' or p_offer_sdp is null or length(p_offer_sdp) not between 1 and 65536 then raise exception 'invalid_request'; end if;
 select * into c from public.sales_configuration where singleton for update;
 select * into s from public.sales_sessions where request_id=p_request_id;
 if found then
  if s.token_hash<>p_token_hash or s.expires_at+interval '1 hour'<clock_timestamp() then raise exception 'session_not_found';end if;
  return public.sales_public_shape(s);
 end if;
 select * into t from public.sales_cancellations where session_id=p_request_id;
 if found then
  if t.token_hash<>p_token_hash or t.created_at+interval '1 hour'<clock_timestamp() then raise exception 'session_not_found';end if;
  return jsonb_build_object('session_id',p_request_id,'status','ended','max_minutes',c.max_minutes,'expires_at',t.created_at,'provider_termination_state','not_started');
 end if;
 if not c.enabled or c.owner_user_id is null then raise exception 'sales_disabled';end if;
 if c.heartbeat_at is null or c.heartbeat_at<clock_timestamp()-interval '30 seconds' then raise exception 'runtime_unavailable';end if;
 -- Only rows that provably never attempted provider creation can be safely reclaimed here.
 update public.sales_sessions set status='ended',offer_sdp='',stop_requested=true,usage_state='settled',updated_at=clock_timestamp()
 where status in ('pending','starting') and create_intent_at is null and provider_call_id is null and expires_at<=clock_timestamp();
 if exists(select 1 from public.sales_sessions where status not in ('ended','error')) then raise exception 'global_busy';end if;
 if (select count(*) from public.sales_sessions where visitor_hash=p_visitor_hash and created_at>=day_start)>=c.visitor_daily_limit then raise exception 'visitor_limit';end if;
 if (select count(*) from public.sales_sessions where network_hash=p_network_hash and created_at>=day_start)>=c.network_daily_limit then raise exception 'network_limit';end if;
 select coalesce(sum(case when usage_state='settled' and status in ('ended','error') then observed_cost_usd else greatest(reserved_cost_usd,observed_cost_usd) end),0) into spent from public.sales_sessions where created_at>=day_start or usage_state<>'settled' or status not in ('ended','error');
 if spent+c.session_cost_ceiling_usd>c.daily_budget_usd then raise exception 'daily_budget';end if;
 insert into public.sales_sessions(session_id,request_id,token_hash,visitor_hash,network_hash,offer_sdp,max_minutes,expires_at,reserved_cost_usd)
 values(p_request_id,p_request_id,p_token_hash,p_visitor_hash,p_network_hash,p_offer_sdp,c.max_minutes,clock_timestamp()+make_interval(mins=>c.max_minutes),c.session_cost_ceiling_usd) returning * into s;
 insert into public.sales_leads(session_id) values(s.session_id);
 return public.sales_public_shape(s);
end;$$;
create function public.sales_public_session(p_session_id uuid,p_token_hash text,p_network_hash text,p_end boolean default false) returns jsonb
language plpgsql set search_path='' as $$
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
   if t.session_id is null or t.token_hash<>p_token_hash or t.created_at+interval '1 hour'<clock_timestamp() then raise exception 'session_not_found';end if;
   return jsonb_build_object('session_id',p_session_id,'status','ended','max_minutes',5,'expires_at',t.created_at,'provider_termination_state','not_started');
  end if;
 end if;
 if s.token_hash<>p_token_hash or s.expires_at+interval '1 hour'<clock_timestamp() then raise exception 'session_not_found';end if;
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
create function public.sales_client_connected(p_session_id uuid,p_token_hash text) returns jsonb
language plpgsql set search_path='' as $$
declare s public.sales_sessions;
begin
 select * into s from public.sales_sessions where session_id=p_session_id for update;
 if not found or p_token_hash is null or s.token_hash<>p_token_hash or s.expires_at+interval '1 hour'<clock_timestamp() then raise exception 'session_not_found';end if;
 if s.expires_at<=clock_timestamp() or s.status in ('ending','ended','error','quarantined') then
  return public.sales_public_session(p_session_id,p_token_hash,s.network_hash,false);
 end if;
 if s.status<>'ready' then raise exception 'session_not_ready';end if;
 if s.client_connected_at is null then update public.sales_sessions set client_connected_at=clock_timestamp(),updated_at=clock_timestamp() where session_id=s.session_id returning * into s;end if;
 return public.sales_public_shape(s);
end;$$;
create function public.sales_heartbeat(p_worker_id text) returns jsonb language plpgsql set search_path='' as $$
declare c public.sales_configuration;
begin
 if p_worker_id is null or length(p_worker_id) not between 1 and 120 then raise exception 'invalid_worker';end if;
 update public.sales_configuration set heartbeat_at=clock_timestamp(),worker_id=p_worker_id where singleton returning * into c;
 return jsonb_build_object('enabled',c.enabled,'server_time',clock_timestamp());
end;$$;
create function public.sales_claim(p_worker_id text) returns jsonb language plpgsql set search_path='' as $$
declare s public.sales_sessions; c public.sales_configuration;
begin
 if p_worker_id is null or length(p_worker_id) not between 1 and 120 then raise exception 'invalid_worker';end if;
 select * into c from public.sales_configuration where singleton for update;
 -- A process may have died after create was accepted. Never repeat that request.
 update public.sales_sessions set status='quarantined',offer_sdp='',stop_requested=true,provider_termination_state='unknown',error='provider_create_unknown',updated_at=clock_timestamp()
 where status not in ('ended','error','quarantined') and provider_call_id is null and create_intent_at is not null and lease_expires_at<clock_timestamp();
 select * into s from public.sales_sessions where (lease_expires_at is null or lease_expires_at<clock_timestamp()) and
  (status in ('pending','starting','ready','ending') or (status='quarantined' and provider_call_id is not null))
 order by created_at for update skip locked limit 1;
 if not found then return null;end if;
 if (not c.enabled or s.expires_at<=clock_timestamp() or s.stop_requested) and s.create_intent_at is null and s.provider_call_id is null then
  update public.sales_sessions set status='ended',offer_sdp='',stop_requested=true,usage_state='settled',updated_at=clock_timestamp() where session_id=s.session_id;return null;
 end if;
 update public.sales_sessions set claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '30 seconds',worker_id=p_worker_id,
 status=case when s.status='pending' then 'starting' when s.provider_call_id is not null and s.status<>'ended' then 'ending' else s.status end,
 stop_requested=s.stop_requested or not c.enabled or s.expires_at<=clock_timestamp() or s.provider_call_id is not null,updated_at=clock_timestamp()
 where session_id=s.session_id returning * into s;
 return public.sales_worker_shape(s);
end;$$;
create function public.sales_worker_apply(p_session_id uuid,p_claim_token uuid,p_operation text,p_payload jsonb default '{}') returns jsonb
language plpgsql set search_path='' as $$
declare s public.sales_sessions;t public.sales_transcript_items; l public.sales_leads; k text; v jsonb; evidence text; a public.sales_transcript_items; u public.sales_transcript_items; amount numeric; out_id uuid; channel text; evidence_at timestamptz;
begin
 select * into s from public.sales_sessions where session_id=p_session_id for update;
 if not found or p_claim_token is null or s.claim_token is distinct from p_claim_token or s.lease_expires_at<=clock_timestamp() then raise exception 'stale_claim';end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'invalid_payload';end if;
 case p_operation
 when 'renew' then
  s.lease_expires_at:=clock_timestamp()+interval '30 seconds';
  if s.expires_at<=clock_timestamp() or not (select enabled from public.sales_configuration where singleton) then s.stop_requested:=true;end if;
 when 'create_intent' then
  if s.status<>'starting' or s.stop_requested or s.expires_at<=clock_timestamp() or s.create_intent_at is not null or s.provider_call_id is not null or s.create_attempts>=2 then raise exception 'create_not_allowed';end if;
  if not (select enabled from public.sales_configuration where singleton) then raise exception 'sales_disabled';end if;
  if coalesce(length(p_payload->>'model'),0) not between 1 and 120 then raise exception 'invalid_model';end if;
  s.create_intent_at:=clock_timestamp();s.create_attempts:=s.create_attempts+1;s.model:=p_payload->>'model';
 when 'provider_rejected' then
  if s.create_intent_at is null or s.provider_call_id is not null then raise exception 'rejection_not_allowed';end if;
  s.create_intent_at:=null;
 when 'provider_ready' then
  if s.provider_call_id is not null and s.provider_call_id=p_payload->>'provider_call_id' and s.answer_sdp=p_payload->>'answer_sdp' and s.model=p_payload->>'model' then return public.sales_worker_shape(s);end if;
  if s.create_intent_at is null or s.provider_call_id is not null or coalesce(length(p_payload->>'provider_call_id'),0) not between 1 and 300 or coalesce(length(p_payload->>'answer_sdp'),0) not between 1 and 65536 or p_payload->>'model' is distinct from s.model then raise exception 'provider_not_allowed';end if;
  s.offer_sdp:='';s.provider_call_id:=p_payload->>'provider_call_id';s.answer_sdp:=p_payload->>'answer_sdp';
  if s.stop_requested or s.expires_at<=clock_timestamp() then s.status:='ending';s.stop_requested:=true;
  else s.status:='starting';end if;
 when 'activate' then
  if s.status='ready' then return public.sales_worker_shape(s);end if;
  if s.provider_call_id is null or s.answer_sdp is null or s.status<>'starting' then raise exception 'activate_not_allowed';end if;
  if s.stop_requested or s.expires_at<=clock_timestamp() or not (select enabled from public.sales_configuration where singleton) then s.status:='ending';s.stop_requested:=true;else s.status:='ready';end if;
 when 'quarantine' then
  if p_payload ? 'provider_call_id' then
   if coalesce(length(p_payload->>'provider_call_id'),0) not between 1 and 300 or (s.provider_call_id is not null and s.provider_call_id<>p_payload->>'provider_call_id') then raise exception 'provider_conflict';end if;
   s.provider_call_id:=p_payload->>'provider_call_id';
  end if;
  s.offer_sdp:='';s.status:='quarantined';s.stop_requested:=true;s.provider_termination_state:='unknown';s.error:='provider_outcome_unknown';
 when 'transcript' then
  select * into t from public.sales_transcript_items where session_id=s.session_id and provider_item_id=p_payload->>'provider_item_id';
  if found then
   if t.role is distinct from p_payload->>'role' or t.text is distinct from p_payload->>'text' or t.context is distinct from coalesce(p_payload->>'context','real') then raise exception 'transcript_conflict';end if;
  else
   insert into public.sales_transcript_items(session_id,provider_item_id,role,text,context,provider_usage) values(s.session_id,p_payload->>'provider_item_id',p_payload->>'role',p_payload->>'text',coalesce(p_payload->>'context','real'),p_payload->'usage') returning * into t;
  end if;out_id:=t.id;
 when 'lead_patch' then
  select * into l from public.sales_leads where session_id=s.session_id for update;
  if p_payload ? 'fields' and jsonb_typeof(p_payload->'fields')<>'object' then raise exception 'invalid_fields';end if;
  for k,v in select * from jsonb_each(coalesce(p_payload->'fields','{}')) loop
   if k<>all(array['name','company','website','industry','region','language','call_volume','current_tools','main_need','contact_preference','phone','email','summary','next_step','pilot_interest']) or jsonb_typeof(v)<>'object' or jsonb_typeof(v->'value') is distinct from 'string' or length(v->>'value') not between 1 and 2000 or jsonb_typeof(v->'evidence_item_ids') is distinct from 'array' or jsonb_array_length(v->'evidence_item_ids') not between 1 and 20 then raise exception 'invalid_fields';end if;
   for evidence in select jsonb_array_elements_text(v->'evidence_item_ids') loop
    if not exists(select 1 from public.sales_transcript_items where session_id=s.session_id and provider_item_id=evidence and role='user' and context='real') then raise exception 'invalid_evidence';end if;
   end loop;
   if k in ('phone','email') and l.fields->k->>'value' is distinct from v->>'value' then l.contact_confirmed:=false;l.contact_confirmation:=null;l.followup_consent:=false;l.followup_consent_evidence:=null;end if;
   l.fields:=jsonb_set(l.fields,array[k],v);
  end loop;
  if p_payload ? 'contact_confirmation' then
   v:=p_payload->'contact_confirmation';channel:=v->>'channel';
   if channel is null or channel not in ('phone','email') or l.fields->channel->>'value' is null or l.fields->channel->>'value' is distinct from v->>'value' then raise exception 'invalid_contact';end if;
   select * into a from public.sales_transcript_items where session_id=s.session_id and provider_item_id=v->>'readback_item_id' and role='assistant' and context='real';
   select * into u from public.sales_transcript_items where session_id=s.session_id and provider_item_id=v->>'confirmation_item_id' and role='user' and context='real';
   select max(created_at) into evidence_at from public.sales_transcript_items where session_id=s.session_id and provider_item_id in (select jsonb_array_elements_text(l.fields->channel->'evidence_item_ids'));
   if a.id is null or u.id is null or evidence_at is null or a.created_at<=evidence_at or u.created_at<=a.created_at then raise exception 'invalid_confirmation_evidence';end if;
   l.contact_confirmed:=true;l.contact_confirmation:=v;
  end if;
  if p_payload ? 'followup_consent' then
   v:=p_payload->'followup_consent';channel:=v->>'channel';
   if jsonb_typeof(v->'granted') is distinct from 'boolean' then raise exception 'invalid_consent';end if;
   select * into u from public.sales_transcript_items where session_id=s.session_id and provider_item_id=v->>'response_item_id' and role='user' and context='real';
   if u.id is null then raise exception 'invalid_consent_evidence';end if;
   if l.followup_decision_item_id=u.provider_item_id and l.followup_consent_evidence=v and l.followup_consent=(v->>'granted')::boolean then
    null; -- Exact current decision replay does not rewrite its evidence order.
   else
    if l.followup_decision_at is not null and u.created_at<=l.followup_decision_at then raise exception 'stale_consent_decision';end if;
    if (v->>'granted')::boolean then
     select * into a from public.sales_transcript_items where session_id=s.session_id and provider_item_id=v->>'request_item_id' and role='assistant' and context='real';
     if a.id is null then raise exception 'invalid_consent_evidence';end if;
     if l.followup_decision_at is not null and a.created_at<=l.followup_decision_at then raise exception 'stale_consent_decision';end if;
     if not l.contact_confirmed or channel is null or l.contact_confirmation->>'channel' is distinct from channel then raise exception 'contact_not_confirmed';end if;
     select * into t from public.sales_transcript_items where session_id=s.session_id and provider_item_id=l.contact_confirmation->>'confirmation_item_id' and role='user' and context='real';
     select max(created_at) into evidence_at from public.sales_transcript_items where session_id=s.session_id and provider_item_id in (select jsonb_array_elements_text(l.fields->channel->'evidence_item_ids'));
     if t.id is null or evidence_at is null or t.created_at<=evidence_at or a.created_at<=t.created_at or u.created_at<=a.created_at or a.provider_item_id=l.contact_confirmation->>'readback_item_id' or u.provider_item_id=t.provider_item_id then raise exception 'invalid_consent_evidence';end if;
    elsif channel is not null and channel not in ('all','phone','email') then raise exception 'invalid_consent';
    end if;
    -- A real user's withdrawal needs no new assistant question or confirmed contact.
    l.followup_consent:=(v->>'granted')::boolean;l.followup_consent_evidence:=v;
    l.followup_decision_at:=u.created_at;l.followup_decision_item_id:=u.provider_item_id;
   end if;
  end if;
  update public.sales_leads set fields=l.fields,contact_confirmed=l.contact_confirmed,contact_confirmation=l.contact_confirmation,followup_consent=l.followup_consent,followup_consent_evidence=l.followup_consent_evidence,followup_decision_at=l.followup_decision_at,followup_decision_item_id=l.followup_decision_item_id,updated_at=clock_timestamp() where session_id=s.session_id;
 when 'usage' then
  if jsonb_typeof(p_payload->'observed_cost_usd') is distinct from 'number' then raise exception 'invalid_usage';end if;
  amount:=(p_payload->>'observed_cost_usd')::numeric;
  if amount< s.observed_cost_usd then raise exception 'usage_regression';end if;
  if amount<0 or amount>100000 then raise exception 'invalid_usage';end if;
  if p_payload ? 'provider_event_id' then
   if jsonb_typeof(p_payload->'provider_usage') is distinct from 'object' then raise exception 'invalid_usage_receipt';end if;
   if exists(select 1 from public.sales_usage_events where session_id=s.session_id and provider_event_id=p_payload->>'provider_event_id' and (provider_usage is distinct from p_payload->'provider_usage' or observed_cost_usd<>amount)) then raise exception 'usage_receipt_conflict';end if;
   insert into public.sales_usage_events(session_id,provider_event_id,provider_usage,observed_cost_usd) values(s.session_id,p_payload->>'provider_event_id',p_payload->'provider_usage',amount) on conflict do nothing;
  end if;
  if amount>s.observed_cost_usd and not coalesce((p_payload->>'final')::boolean,false) then s.usage_state:='observed';end if;
  s.observed_cost_usd:=amount;
  if coalesce((p_payload->>'final')::boolean,false) then s.usage_state:='settled';elsif s.usage_state<>'settled' then s.usage_state:='observed';end if;
  if amount>=s.reserved_cost_usd and s.status not in ('ended','error') then s.stop_requested:=true;s.status:='ending';end if;
 when 'termination' then
  if s.provider_termination_state='confirmed' then return public.sales_worker_shape(s);end if;
  if p_payload->>'state'='confirmed' then s.offer_sdp:='';s.provider_termination_state:='confirmed';s.status:='ended';s.answer_sdp:=null;
  elsif p_payload->>'state'='requested' then s.provider_termination_state:='requested';s.status:='ending';
  elsif p_payload->>'state'='unknown' then s.provider_termination_state:='unknown';s.status:='quarantined';s.error:='provider_termination_unknown';
  else raise exception 'invalid_termination';end if;s.stop_requested:=true;
 when 'fail' then
  if s.provider_call_id is not null or s.create_intent_at is not null then raise exception 'ambiguous_failure_requires_quarantine';end if;
  s.offer_sdp:='';s.status:='error';s.error:='session_failed';s.usage_state:='settled';s.stop_requested:=true;
 else raise exception 'unknown_operation';
 end case;
 update public.sales_sessions set status=s.status,offer_sdp=s.offer_sdp,answer_sdp=s.answer_sdp,provider_call_id=s.provider_call_id,model=s.model,stop_requested=s.stop_requested,lease_expires_at=s.lease_expires_at,create_intent_at=s.create_intent_at,create_attempts=s.create_attempts,observed_cost_usd=s.observed_cost_usd,usage_state=s.usage_state,provider_termination_state=s.provider_termination_state,error=s.error,updated_at=clock_timestamp() where session_id=s.session_id returning * into s;
 return public.sales_worker_shape(s)||case when out_id is null then '{}'::jsonb else jsonb_build_object('transcript_item_id',out_id) end;
end;$$;
revoke all on function public.sales_public_shape(public.sales_sessions),public.sales_worker_shape(public.sales_sessions),public.sales_admit(uuid,text,text,text,text),public.sales_public_session(uuid,text,text,boolean),public.sales_client_connected(uuid,text),public.sales_heartbeat(text),public.sales_claim(text),public.sales_worker_apply(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.sales_public_shape(public.sales_sessions),public.sales_worker_shape(public.sales_sessions),public.sales_admit(uuid,text,text,text,text),public.sales_public_session(uuid,text,text,boolean),public.sales_client_connected(uuid,text),public.sales_heartbeat(text),public.sales_claim(text),public.sales_worker_apply(uuid,uuid,text,jsonb) to service_role;
