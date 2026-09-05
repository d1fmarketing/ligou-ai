-- First-number binding is explicit, private and disabled until an operator configures it.
create table public.phone_inbound_configuration (
 singleton boolean primary key default true check(singleton),
 tenant_id uuid references public.tenants(id),
 phone_number text check(phone_number is null or phone_number ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
 enabled boolean not null default false,
 max_minutes integer not null default 5 check(max_minutes between 1 and 5),
 updated_at timestamptz not null default clock_timestamp(),
 check((tenant_id is null)=(phone_number is null)),
 check(not enabled or (tenant_id is not null and phone_number is not null))
);
insert into public.phone_inbound_configuration(singleton) values(true);
alter table public.phone_inbound_configuration enable row level security;
alter table public.phone_inbound_configuration force row level security;
revoke all on public.phone_inbound_configuration from public,anon,authenticated,service_role;
grant select,update on public.phone_inbound_configuration to service_role;

create function public.configure_first_phone_number(p_tenant_id uuid,p_phone_number text,p_enabled boolean,p_max_minutes integer default 5)
returns jsonb language plpgsql set search_path='' as $$
declare c public.phone_inbound_configuration;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode='42501';end if;
 if p_enabled is null or p_max_minutes is null or p_max_minutes not between 1 and 5 or (p_tenant_id is null)<>(p_phone_number is null) or (p_enabled and p_tenant_id is null) or (p_phone_number is not null and p_phone_number !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$') then raise exception 'invalid_phone_binding';end if;
 if p_tenant_id is not null and not exists(select 1 from public.tenants t where t.id=p_tenant_id and t.owner_user_id is not null and (not p_enabled or t.status='active')) then raise exception 'phone_tenant_unavailable';end if;
 select * into c from public.phone_inbound_configuration where singleton for update;
 if not found then raise exception 'phone_configuration_missing';end if;
 if (c.tenant_id is distinct from p_tenant_id or c.phone_number is distinct from p_phone_number or c.max_minutes<>p_max_minutes)
 and exists(select 1 from public.phone_events p where p.tenant_id is not null and (p.lifecycle_state not in ('rejected','terminated') or p.provider_termination_state in ('active','pending','unknown','external_evidence_required'))) then raise exception 'phone_calls_active';end if;
 update public.phone_inbound_configuration set tenant_id=p_tenant_id,phone_number=p_phone_number,enabled=p_enabled,max_minutes=p_max_minutes,updated_at=clock_timestamp() where singleton returning * into c;
 return to_jsonb(c);
end;$$;
revoke all on function public.configure_first_phone_number(uuid,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.configure_first_phone_number(uuid,text,boolean,integer) to service_role;

create or replace function public.claim_phone_event(p_event_id uuid, p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.phone_events;
  v_claim uuid := gen_random_uuid();
  v_config public.phone_inbound_configuration;
  v_route_error text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_event_id is null or nullif(btrim(p_worker), '') is null then
    raise exception 'phone_claim_arguments_invalid' using errcode = '22023';
  end if;

  select * into v_config from public.phone_inbound_configuration where singleton for update;

  select p.* into v_event
  from public.phone_events p
  where p.id = p_event_id and p.status = 'pending' and p.lifecycle_state = 'pending'
  for update of p skip locked;
  if v_event.id is null then return null; end if;

  if not coalesce(v_config.enabled,false) then v_route_error:='phone_not_configured';
  elsif v_event.called_number is distinct from v_config.phone_number then v_route_error:='phone_number_unassigned';
  elsif not exists(select 1 from public.tenants t where t.id=v_config.tenant_id and t.owner_user_id is not null and t.status='active') then v_route_error:='phone_tenant_unavailable';
  elsif exists(select 1 from public.phone_events p where p.id<>v_event.id and p.tenant_id is not null and (p.lifecycle_state not in ('rejected','terminated') or p.provider_termination_state in ('active','pending','unknown','external_evidence_required'))) then v_route_error:='phone_busy';
  end if;

  update public.phone_events p
  set tenant_id=case when v_route_error is null then v_config.tenant_id else null end,
      lifecycle_state = 'claimed',
      lifecycle_owner = left(p_worker, 100),
      lifecycle_claim_token = v_claim,
      lifecycle_claimed_at = clock_timestamp(),
      lifecycle_updated_at = clock_timestamp(),
      lifecycle_reconcile_after = clock_timestamp() + interval '30 seconds',
      lifecycle_reconcile_lease_until = null,
      lifecycle_reconcile_worker = null,
      provider_termination_state = 'active',
      provider_termination_mode = 'reject',
      handled_at = coalesce(p.handled_at, clock_timestamp())
  where p.id = v_event.id;

  return jsonb_build_object(
    'id', v_event.id,
    'claim_token', v_claim,
    'openai_call_id', v_event.openai_call_id,
    'called_number',v_event.called_number,
    'tenant_id',case when v_route_error is null then v_config.tenant_id else null end,
    'max_minutes',v_config.max_minutes,
    'route_error',v_route_error
  );
end;
$$;

create or replace function public.persist_phone_call(
  p_event_id uuid,
  p_claim_token uuid,
  p_tenant_id uuid,
  p_model text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.phone_events;
  v_call uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_event_id is null or p_claim_token is null or p_tenant_id is null or nullif(btrim(p_model), '') is null then
    raise exception 'phone_call_arguments_invalid' using errcode = '22023';
  end if;

  select p.* into v_event from public.phone_events p where p.id = p_event_id for update;
  if v_event.id is null then raise exception 'phone_event_not_found' using errcode = 'P0002'; end if;
  if v_event.lifecycle_claim_token is distinct from p_claim_token or nullif(btrim(v_event.lifecycle_owner), '') is null then
    raise exception 'phone_claim_lost' using errcode = '42501';
  end if;
  if v_event.tenant_id is distinct from p_tenant_id or not exists(select 1 from public.phone_inbound_configuration c join public.tenants t on t.id=c.tenant_id where c.singleton and c.enabled and c.tenant_id=p_tenant_id and c.phone_number=v_event.called_number and t.status='active' and t.owner_user_id is not null) then
    raise exception 'phone_route_unavailable' using errcode='42501';
  end if;
  if v_event.lifecycle_state = 'call_persisted' and v_event.call_id is not null then return v_event.call_id; end if;
  if v_event.lifecycle_state <> 'claimed' then raise exception 'phone_lifecycle_transition_invalid' using errcode = '55000'; end if;

  insert into public.calls (
    tenant_id, channel, session_type, model, status, openai_call_id, phone_event_id,
    provider_termination_state, provider_termination_mode, provider_termination_reason, provider_usage_state
  ) values (
    p_tenant_id, 'phone', 'customer', p_model, 'active', v_event.openai_call_id, v_event.id,
    'active', 'reject', 'phone_waiting_before_accept', 'unknown'
  ) returning id into v_call;

  update public.phone_events p
  set tenant_id = p_tenant_id,
      call_id = v_call,
      lifecycle_state = 'call_persisted',
      lifecycle_updated_at = clock_timestamp(),
      lifecycle_reconcile_after = clock_timestamp() + interval '30 seconds'
  where p.id = v_event.id;
  return v_call;
end;
$$;

create or replace function public.begin_phone_provider_accept(p_event_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_event public.phone_events;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_event_id is null or p_claim_token is null then raise exception 'phone_accept_arguments_invalid' using errcode = '22023'; end if;
  select p.* into v_event from public.phone_events p where p.id = p_event_id for update;
  if v_event.id is null then raise exception 'phone_event_not_found' using errcode = 'P0002'; end if;
  if v_event.lifecycle_claim_token is distinct from p_claim_token or nullif(btrim(v_event.lifecycle_owner), '') is null then
    raise exception 'phone_claim_lost' using errcode = '42501';
  end if;
  if not exists(select 1 from public.phone_inbound_configuration c join public.tenants t on t.id=c.tenant_id where c.singleton and c.enabled and c.tenant_id=v_event.tenant_id and c.phone_number=v_event.called_number and t.status='active' and t.owner_user_id is not null) then
    raise exception 'phone_route_unavailable' using errcode='42501';
  end if;
  if v_event.lifecycle_state = 'accepting' then return true; end if;
  if v_event.lifecycle_state <> 'budget_reserved' then raise exception 'phone_lifecycle_transition_invalid' using errcode = '55000'; end if;
  update public.phone_events p set
    lifecycle_state = 'accepting', provider_accept_state = 'attempting',
    provider_termination_state = 'active', provider_termination_mode = 'hangup',
    lifecycle_updated_at = clock_timestamp(), lifecycle_reconcile_after = clock_timestamp() + interval '30 seconds'
  where p.id = v_event.id;
  update public.calls c set provider_termination_mode = 'hangup', provider_termination_reason = 'phone_accept_outcome_pending'
  where c.id = v_event.call_id;
  if not found then raise exception 'phone_call_not_found' using errcode = 'P0002'; end if;
  return true;
end;
$$;
revoke all on function public.claim_phone_event(uuid,text),public.persist_phone_call(uuid,uuid,uuid,text),public.begin_phone_provider_accept(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_phone_event(uuid,text),public.persist_phone_call(uuid,uuid,uuid,text),public.begin_phone_provider_accept(uuid,uuid) to service_role;
