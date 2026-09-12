-- Live expiry reconciliation: a session that no longer exists at the provider
-- (404 session_id_not_found) after its persisted expires_at settles the resume
-- gate without inventing session.closed. Realtime receipts keep the 60-minute
-- rule; Live receipts are governed by the session's own expires_at.
begin;
select set_config('request.jwt.claim.role','service_role',true);
insert into auth.users values('9e000000-0000-4000-8000-000000000001'),('9e000000-0000-4000-8000-000000000009');
insert into tenants(id,owner_user_id,status,operational_mode,test_memory_generation) values('9e000000-0000-4000-8000-000000000002','9e000000-0000-4000-8000-000000000001','onboarding','simulation_only',2);
insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation,started_at,ended_at,duration_seconds,model,openai_call_id,
  provider_termination_state,provider_termination_mode,provider_termination_reason,provider_usage_state,cost_estimate_usd,provider_usage_details)
 values('9e000000-0000-4000-8000-000000000004','9e000000-0000-4000-8000-000000000002','browser','onboarding','ended',2,now()-interval '40 minutes',now()-interval '30 minutes',92,'gpt-live-1','live-expired-fixture',
  'unknown','hangup','owner_requested_stop','unknown',0.14330983,jsonb_build_object('expiresAt',extract(epoch from now()-interval '5 minutes'),'voiceSeconds',92));
insert into browser_session_requests(id,tenant_id,call_id,user_id,session_type,test_memory_generation,onboarding_protocol_version,opening_mode_requested,status,offer_sdp,answer_sdp,opening_mode_applied,opening_payload)
 values('9e000000-0000-4000-8000-000000000005','9e000000-0000-4000-8000-000000000002','9e000000-0000-4000-8000-000000000004','9e000000-0000-4000-8000-000000000001','onboarding',2,6,'live_managed_v1','ready','v=0','v=0','live_managed_v1',
  '{"version":6,"live":{"callId":"9e000000-0000-4000-8000-000000000004","interviewId":"9e000000-0000-4000-8000-000000000004","revision":1,"sourceDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sessionId":"live-expired-fixture"}}');
insert into budget_reservations(tenant_id,call_id,status,budget_day,reserved_cost_usd,reserved_minutes,reconcile_attempts) values('9e000000-0000-4000-8000-000000000002','9e000000-0000-4000-8000-000000000004','active',current_date,7.5,55,25);

do $$declare t uuid:='9e000000-0000-4000-8000-000000000002';o uuid:='9e000000-0000-4000-8000-000000000001';c uuid:='9e000000-0000-4000-8000-000000000004';
 before_call jsonb;before_budget jsonb;before_receipts bigint;caught text;attempt uuid;ok boolean;n int;
 expected text[]:=array['live_expiry_identity_mismatch','live_expiry_model_unsupported','live_expiry_receipt_invalid','live_expiry_receipt_invalid','live_expiry_receipt_invalid',
   'live_expiry_receipt_invalid','live_expiry_receipt_invalid','live_expiry_not_terminal','live_expiry_not_applicable','live_expiry_identity_mismatch',
   'live_expiry_anchor_missing','live_expiry_not_elapsed','live_expiry_evidence_missing','live_expiry_identity_mismatch','live_expiry_receipt_invalid'];begin
 if public.website_interview_prior_settled(t,o,c,2) then raise exception 'unsettled_call_admitted_before_evidence';end if;
 select to_jsonb(x) into before_call from calls x where id=c;select to_jsonb(b) into before_budget from budget_reservations b where call_id=c;
 select count(*) into before_receipts from browser_interview_expiry_receipts where call_id=c;
 -- Rejections: each mutation lives in a sub-transaction that the raised error rolls back.
 for n in 1..15 loop
  caught:=null;
  begin
   if n=2 then update calls set model='gpt-realtime-2.1' where id=c;end if;
   if n=8 then update calls set status='active' where id=c;end if;
   if n=9 then update calls set provider_termination_state='confirmed' where id=c;end if;
   if n=10 then update calls set channel='sip' where id=c;end if; -- scope drift (request rows are trigger-guarded against ad-hoc updates)
   if n=11 then update tenants set owner_user_id='9e000000-0000-4000-8000-000000000009' where id=t;end if; -- request no longer bound to the owner
   if n=12 then update calls set provider_usage_details=jsonb_build_object('expiresAt',extract(epoch from now()+interval '10 minutes'),'voiceSeconds',92) where id=c;end if;
   if n=13 then update calls set provider_usage_details=jsonb_build_object('voiceSeconds',92) where id=c;end if;
   if n=14 then update calls set test_memory_generation=3 where id=c;end if;
   perform public.reconcile_live_session_expiry(c,
     case when n=1 then 'live-other' else 'live-expired-fixture' end,
     case when n=6 then now()+interval '1 minute' when n=7 then now()-interval '16 minutes' else now() end,
     case when n=3 then 500 else 404 end,
     case when n=4 then 'call_id_not_found' else 'session_id_not_found' end,
     case when n=5 then 'server_error' else 'invalid_request_error' end,
     case when n=15 then 'live attach probe' else 'live_attach_probe:live-expired-fixture' end);
   -- Sentinel with its own prefix: it must never be mistaken for the expected rejection.
   raise exception 'test_case_%_accepted_unexpectedly',n;
  exception when others then caught:=sqlerrm;end;
  if caught is distinct from expected[n] then raise exception 'live_expiry_case_%_wrong_error:% (expected %)',n,caught,expected[n];end if;
 end loop;
 if (select to_jsonb(x) from calls x where id=c) is distinct from before_call then raise exception 'rejections_mutated_call';end if;
 if (select to_jsonb(b) from budget_reservations b where call_id=c) is distinct from before_budget then raise exception 'rejections_mutated_budget';end if;
 if (select count(*) from browser_interview_expiry_receipts where call_id=c)<>before_receipts then raise exception 'rejections_recorded_receipt';end if;
 -- Acceptance: evidence after expires_at, anchor backfilled from ended_at, no 60-minute wait for Live.
 ok:=public.reconcile_live_session_expiry(c,'live-expired-fixture',now(),404,'session_id_not_found','invalid_request_error','live_attach_probe:live-expired-fixture');
 if not ok then raise exception 'live_expiry_not_accepted';end if;
 select provider_termination_attempt_id into attempt from calls where id=c;
 if attempt is null or (select provider_termination_attempted_at<>ended_at or provider_termination_request_id<>attempt::text or provider_termination_state<>'unknown' or provider_termination_mode<>'hangup' from calls where id=c) then raise exception 'anchor_backfill_wrong';end if;
 if (select to_jsonb(x)-array['provider_termination_attempt_id','provider_termination_request_id','provider_termination_attempted_at'] from calls x where id=c)
   is distinct from before_call-array['provider_termination_attempt_id','provider_termination_request_id','provider_termination_attempted_at'] then raise exception 'acceptance_rewrote_call';end if;
 if (select policy<>'live_expires_at_and_attach_404_v1' or anchor_at<>(select provider_termination_attempted_at from calls where id=c) or termination_attempt_id<>attempt
   or owner_id<>o or generation<>2 or checked_at>=anchor_at+interval '60 minutes' from browser_interview_expiry_receipts where call_id=c) then raise exception 'live_receipt_wrong';end if;
 if public.website_interview_prior_settled(t,o,c,2) then raise exception 'settled_with_active_reservation';end if;
 -- Locked settlement wrapper: cost must match the persisted floor; receipt must exist; overrun still refused.
 begin perform public.settle_unresolved_live_call_budget(t,c,0.10,1.5333,'ended','{"reconciled":true}'::jsonb);caught:=null;exception when others then caught:=sqlerrm;end;
 if caught is distinct from 'live_settlement_cost_changed' then raise exception 'stale_cost_settled:%',caught;end if;
 if (select status<>'active' from budget_reservations where call_id=c) then raise exception 'stale_cost_mutated_reservation';end if;
 begin update calls set cost_estimate_usd=9 where id=c;perform public.settle_unresolved_live_call_budget(t,c,9,1.5333,'killed_budget','{}'::jsonb);caught:=null;exception when others then caught:=sqlerrm;end;
 if caught is distinct from 'settlement_exceeds_reservation' then raise exception 'overrun_settled_without_confirmed_termination:%',caught;end if;
 perform public.settle_unresolved_live_call_budget(t,c,0.14330983,1.5333,'ended','{"reconciled":true,"cost_source":"calls.cost_estimate_usd@reread"}'::jsonb);
 if (select status<>'settled' or final_cost_usd<>0.14330983 or outcome<>'ended' from budget_reservations where call_id=c) then raise exception 'live_settlement_missing';end if;
 if (select count(*)<>1 from usage_ledger where call_id=c and kind='adjustment' and cost_usd=-7.5 and detail->>'basis'='reservation_rate_estimate') then raise exception 'ledger_adjustment_wrong';end if;
 if (select count(*)<>1 from usage_ledger where call_id=c and kind='usage' and cost_usd=0.14330983 and detail->>'settlement_basis'='reservation_rate_estimate'
   and detail->>'provider_termination_state'='unknown' and detail->>'cost_source'='calls.cost_estimate_usd@reread') then raise exception 'ledger_usage_wrong';end if;
 if not public.website_interview_prior_settled(t,o,c,2) then raise exception 'live_receipt_not_admitted';end if;
 if public.website_interview_prior_settled(t,o,c,3) or public.website_interview_prior_settled(t,'9e000000-0000-4000-8000-000000000009',c,2) then raise exception 'drifted_identity_admitted';end if;
 -- Replay is idempotent and never rewrites the receipt.
 select to_jsonb(e) into before_call from browser_interview_expiry_receipts e where call_id=c;
 if not public.reconcile_live_session_expiry(c,'live-expired-fixture',now()+interval '1 minute',404,'session_id_not_found','invalid_request_error','live_attach_probe:manual') then raise exception 'replay_rejected';end if;
 if (select to_jsonb(e) from browser_interview_expiry_receipts e where call_id=c) is distinct from before_call then raise exception 'replay_rewrote_receipt';end if;
 -- A pre-existing anchor is reused, and a reaped provider-active call qualifies.
 insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation,started_at,ended_at,duration_seconds,model,openai_call_id,provider_termination_state,provider_termination_mode,provider_usage_state,cost_estimate_usd,provider_usage_details,
   provider_termination_attempt_id,provider_termination_request_id,provider_termination_attempted_at)
  values('9e000000-0000-4000-8000-000000000006',t,'browser','onboarding','ended',2,now()-interval '40 minutes',now()-interval '30 minutes',50,'gpt-live-1','live-reaped-fixture','active','hangup','unknown',0.05,
   jsonb_build_object('expiresAt',extract(epoch from now()-interval '5 minutes'),'voiceSeconds',50),'9e000000-0000-4000-8000-000000000007','9e000000-0000-4000-8000-000000000007',now()-interval '31 minutes');
 insert into browser_session_requests(id,tenant_id,call_id,user_id,session_type,test_memory_generation,onboarding_protocol_version,opening_mode_requested,status,offer_sdp,answer_sdp,opening_mode_applied,opening_payload)
  values('9e000000-0000-4000-8000-000000000008',t,'9e000000-0000-4000-8000-000000000006',o,'onboarding',2,6,'live_managed_v1','ready','v=0','v=0','live_managed_v1',
   '{"version":6,"live":{"callId":"9e000000-0000-4000-8000-000000000006","interviewId":"9e000000-0000-4000-8000-000000000006","revision":1,"sourceDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sessionId":"live-reaped-fixture"}}'); -- terminal request states cannot be inserted directly (transition trigger)
 insert into budget_reservations(tenant_id,call_id,status,budget_day,reserved_cost_usd,reserved_minutes,reconcile_attempts) values(t,'9e000000-0000-4000-8000-000000000006','active',current_date,7.5,55,25);
 if not public.reconcile_live_session_expiry('9e000000-0000-4000-8000-000000000006','live-reaped-fixture',now(),404,'session_id_not_found','invalid_request_error','live_attach_probe:live-reaped-fixture') then raise exception 'reaped_active_rejected';end if;
 if (select termination_attempt_id<>'9e000000-0000-4000-8000-000000000007' or anchor_at<>now()-interval '31 minutes' from browser_interview_expiry_receipts where call_id='9e000000-0000-4000-8000-000000000006') then raise exception 'existing_anchor_not_reused';end if;
 if (select provider_termination_state<>'active' from calls where id='9e000000-0000-4000-8000-000000000006') then raise exception 'reaped_state_rewritten';end if;
end $$;
select has_table_privilege('service_role','public.browser_interview_expiry_receipts','insert') is false;
do $$begin
 perform set_config('request.jwt.claim.role','authenticated',true);
 begin perform public.reconcile_live_session_expiry('9e000000-0000-4000-8000-000000000004','live-expired-fixture',now(),404,'session_id_not_found','invalid_request_error','x');
  raise exception 'authenticated_reconciled_expiry';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claim.role','service_role',true);
end $$;
rollback;
select 'live_expiry_reconciliation_passed';
