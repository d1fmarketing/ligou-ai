-- Sales-only expiry reconciliation. This is not a hangup ACK or a billing receipt.
-- Official Realtime session lifetime: 60 minutes (including gpt-realtime-2.1).
-- https://developers.openai.com/api/docs/guides/realtime-conversations
alter table public.sales_sessions drop constraint sales_sessions_provider_termination_state_check;
alter table public.sales_sessions add constraint sales_sessions_provider_termination_state_check
 check(provider_termination_state in ('not_started','requested','confirmed','unknown','expired'));
alter table public.sales_sessions add column provider_expiry_evidence jsonb;

create function public.sales_reconcile_provider_expiry(
 p_session_id uuid,
 p_provider_call_id text,
 p_checked_at timestamptz,
 p_http_status integer,
 p_error_code text,
 p_error_type text,
 p_evidence_reference text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 s public.sales_sessions;
 anchor_at timestamptz;
 receipt jsonb;
 checked_now timestamptz:=clock_timestamp();
begin
 -- Match admission/claim lock order. Fencing invalidates any worker racing this explicit reconciliation.
 perform 1 from public.sales_configuration where singleton for update;
 select * into s from public.sales_sessions where session_id=p_session_id for update;
 if not found or p_provider_call_id is null or s.provider_call_id is distinct from p_provider_call_id then
  raise exception 'provider_expiry_identity_mismatch';
 end if;
 if p_checked_at is null or p_http_status is distinct from 404 or p_error_code is distinct from 'call_id_not_found'
  or p_error_type is distinct from 'invalid_request_error' or p_evidence_reference is null
  or length(p_evidence_reference) not between 1 and 200 or p_evidence_reference !~ '^[a-zA-Z0-9:_./-]+$' then
  raise exception 'provider_expiry_receipt_invalid';
 end if;
 receipt:=jsonb_build_object('checked_at',p_checked_at,'http_status',p_http_status,'error_code',p_error_code,
  'error_type',p_error_type,'evidence_reference',p_evidence_reference);
 if s.provider_termination_state='expired' then
  if s.provider_expiry_evidence->'receipt' is distinct from receipt then raise exception 'provider_expiry_receipt_conflict';end if;
  return public.sales_public_shape(s);
 end if;
 if s.status<>'quarantined' or not s.stop_requested or s.provider_termination_state<>'unknown' then
  raise exception 'provider_expiry_not_quarantined';
 end if;
 if p_checked_at>checked_now or p_checked_at<checked_now-interval '15 minutes' then
  raise exception 'provider_expiry_receipt_invalid';
 end if;
 if s.model is null or s.model not in ('gpt-realtime-2.1','gpt-realtime-2.1-mini') then
  raise exception 'provider_expiry_model_unsupported';
 end if;
 -- A persisted assistant transcript proves that this specific provider session already existed.
 -- Using its receipt time gives a conservative upper bound, unlike local admission time.
 select min(created_at) into anchor_at from public.sales_transcript_items
  where session_id=s.session_id and role='assistant';
 if anchor_at is null or s.create_intent_at is null or anchor_at<s.created_at or anchor_at<s.create_intent_at then
  raise exception 'provider_expiry_anchor_missing';
 end if;
 if p_checked_at<anchor_at+interval '60 minutes' or checked_now<anchor_at+interval '60 minutes' then
  raise exception 'provider_expiry_not_elapsed';
 end if;
 update public.sales_sessions set status='ended',provider_termination_state='expired',stop_requested=true,
  offer_sdp='',answer_sdp=null,claim_token=null,lease_expires_at=null,worker_id=null,error='provider_session_expired',
  provider_expiry_evidence=jsonb_build_object('source','realtime_max_duration_60m_and_sideband_404','policy_version',1,
    'model',s.model,'first_provider_evidence_at',anchor_at,'maximum_duration_seconds',3600,
    'expiry_upper_bound',anchor_at+interval '60 minutes','receipt',receipt,'recorded_at',checked_now),
  updated_at=checked_now
 where session_id=s.session_id returning * into s;
 -- reserved_cost_usd, observed_cost_usd, usage_state and commercial records are deliberately untouched.
 -- Existing sales_admit excludes ended from concurrency but retains every unsettled hold across UTC days.
 return public.sales_public_shape(s);
end;$$;
revoke all on function public.sales_reconcile_provider_expiry(uuid,text,timestamptz,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.sales_reconcile_provider_expiry(uuid,text,timestamptz,integer,text,text,text) to service_role;
-- authenticated has only column-level sales_sessions reads: the new evidence column remains service-only.
