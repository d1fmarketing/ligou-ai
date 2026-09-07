-- Expiry evidence permits resumption; it is never a hangup ACK or a billing adjustment.
-- https://developers.openai.com/api/docs/guides/realtime-conversations (60-minute maximum).
create table public.browser_interview_expiry_receipts (
 call_id uuid primary key references public.calls(id),
 tenant_id uuid not null references public.tenants(id),
 owner_id uuid not null,
 generation bigint not null,
 provider_call_id text not null,
 termination_attempt_id uuid not null,
 anchor_at timestamptz not null,
 checked_at timestamptz not null,
 evidence_reference text not null,
 recorded_at timestamptz not null default clock_timestamp(),
 policy text not null default 'realtime_60m_and_sideband_404_v1',
 check(checked_at>=anchor_at+interval '60 minutes')
);
alter table public.browser_interview_expiry_receipts enable row level security;
alter table public.browser_interview_expiry_receipts force row level security;
revoke all on public.browser_interview_expiry_receipts from public,anon,authenticated,service_role;
grant select on public.browser_interview_expiry_receipts to service_role;

create function public.reconcile_browser_interview_expiry(
 p_call uuid,p_provider_call_id text,p_checked_at timestamptz,p_http_status integer,
 p_error_code text,p_error_type text,p_evidence_reference text
) returns boolean language plpgsql security definer set search_path='' as $$
declare c public.calls; t public.tenants; b public.budget_reservations; prior public.browser_interview_expiry_receipts; tid uuid; checked_now timestamptz:=clock_timestamp();
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode='42501';end if;
 select tenant_id into tid from public.calls where id=p_call;
 if tid is null then raise exception 'browser_expiry_identity_mismatch';end if;
 perform pg_advisory_xact_lock(hashtextextended('ligou.company_discovery.onboarding_draft:'||tid::text,0));
 select * into t from public.tenants where id=tid for update;
 select * into c from public.calls where id=p_call for update;
 select * into b from public.budget_reservations where call_id=p_call and tenant_id=tid for update;
 if c.tenant_id is distinct from tid or p_provider_call_id is null or c.openai_call_id is distinct from p_provider_call_id
  or t.owner_user_id is null or c.test_memory_generation is distinct from t.test_memory_generation
  or c.channel is distinct from 'browser' or c.session_type is distinct from 'onboarding' then raise exception 'browser_expiry_identity_mismatch';end if;
 if p_checked_at is null or p_http_status is distinct from 404 or p_error_code is distinct from 'call_id_not_found'
  or p_error_type is distinct from 'invalid_request_error' or p_evidence_reference is null
  or length(p_evidence_reference) not between 1 and 200 or p_evidence_reference !~ '^[a-zA-Z0-9:_./-]+$' then raise exception 'browser_expiry_receipt_invalid';end if;
 select * into prior from public.browser_interview_expiry_receipts where call_id=p_call;
 if found then
  if row(prior.provider_call_id,prior.checked_at,prior.evidence_reference,prior.owner_id,prior.generation,prior.termination_attempt_id)
   is distinct from row(p_provider_call_id,p_checked_at,p_evidence_reference,t.owner_user_id,c.test_memory_generation,c.provider_termination_attempt_id) then raise exception 'browser_expiry_receipt_conflict';end if;
  return true;
 end if;
 if p_checked_at>checked_now or p_checked_at<checked_now-interval '15 minutes' then raise exception 'browser_expiry_receipt_invalid';end if;
 if c.model is null or c.model not in ('gpt-realtime-2.1','gpt-realtime-2.1-mini') then raise exception 'browser_expiry_model_unsupported';end if;
 if c.status not in ('ended','error','killed_budget','killed_deadline') or c.ended_at is null or b.status is distinct from 'settled'
  or c.provider_termination_state is distinct from 'external_evidence_required' then raise exception 'browser_expiry_not_settled';end if;
 -- handled_at predates provider creation. The termination attempt timestamp is later,
 -- and only qualifies alongside the persisted successful provider answer and identity.
 if c.provider_termination_attempt_id is null or c.provider_termination_attempted_at is null
  or c.provider_termination_mode is distinct from 'hangup' or c.provider_termination_attempted_at<c.started_at
  or not exists(select 1 from public.browser_session_requests r where r.call_id=c.id and r.tenant_id=c.tenant_id
    and r.user_id=t.owner_user_id and r.test_memory_generation=c.test_memory_generation and r.status='ready'
    and nullif(btrim(r.answer_sdp),'') is not null) then raise exception 'browser_expiry_anchor_missing';end if;
 if p_checked_at<c.provider_termination_attempted_at+interval '60 minutes' then raise exception 'browser_expiry_not_elapsed';end if;
 insert into public.browser_interview_expiry_receipts(call_id,tenant_id,owner_id,generation,provider_call_id,termination_attempt_id,anchor_at,checked_at,evidence_reference)
 values(c.id,c.tenant_id,t.owner_user_id,c.test_memory_generation,c.openai_call_id,c.provider_termination_attempt_id,c.provider_termination_attempted_at,p_checked_at,p_evidence_reference);
 return true;
end $$;
revoke all on function public.reconcile_browser_interview_expiry(uuid,text,timestamptz,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.reconcile_browser_interview_expiry(uuid,text,timestamptz,integer,text,text,text) to service_role;

create or replace function public.website_interview_prior_settled(p_tenant uuid,p_owner uuid,p_call uuid,p_generation bigint) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_call public.calls; v_budget public.budget_reservations; begin
 select c.* into v_call from public.calls c where c.id=p_call and c.tenant_id=p_tenant for update;
 select b.* into v_budget from public.budget_reservations b where b.call_id=p_call and b.tenant_id=p_tenant for update;
 return coalesce(v_call.channel='browser' and v_call.session_type='onboarding' and v_call.test_memory_generation=p_generation
  and v_call.status in ('ended','error','killed_budget','killed_deadline') and v_call.ended_at is not null
  and (v_call.provider_termination_state='confirmed' or exists(select 1 from public.browser_interview_expiry_receipts e
    where e.call_id=v_call.id and e.tenant_id=p_tenant and e.owner_id=p_owner and e.generation=p_generation
      and e.provider_call_id=v_call.openai_call_id and e.termination_attempt_id=v_call.provider_termination_attempt_id
      and e.anchor_at=v_call.provider_termination_attempted_at and e.checked_at<=clock_timestamp()
      and e.checked_at>=e.anchor_at+interval '60 minutes'))
  and v_budget.status='settled' and exists(select 1 from public.browser_session_requests br where br.call_id=p_call
    and br.tenant_id=p_tenant and br.user_id=p_owner and br.test_memory_generation=p_generation),false);
end $$;
