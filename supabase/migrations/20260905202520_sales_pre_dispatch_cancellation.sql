-- A failure with no known provider or unresolved create intent is a never-started receipt.
-- Runtime must first prove explicit rejection or no POST dispatch before clearing an intent.
create or replace function public.sales_worker_apply(p_session_id uuid,p_claim_token uuid,p_operation text,p_payload jsonb default '{}') returns jsonb
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
  s.offer_sdp:='';s.status:='error';s.error:='session_failed';s.usage_state:='settled';s.provider_termination_state:='not_started';s.stop_requested:=true;
 else raise exception 'unknown_operation';
 end case;
 update public.sales_sessions set status=s.status,offer_sdp=s.offer_sdp,answer_sdp=s.answer_sdp,provider_call_id=s.provider_call_id,model=s.model,stop_requested=s.stop_requested,lease_expires_at=s.lease_expires_at,create_intent_at=s.create_intent_at,create_attempts=s.create_attempts,observed_cost_usd=s.observed_cost_usd,usage_state=s.usage_state,provider_termination_state=s.provider_termination_state,error=s.error,updated_at=clock_timestamp() where session_id=s.session_id returning * into s;
 return public.sales_worker_shape(s)||case when out_id is null then '{}'::jsonb else jsonb_build_object('transcript_item_id',out_id) end;
end;$$;
revoke all on function public.sales_worker_apply(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.sales_worker_apply(uuid,uuid,text,jsonb) to service_role;
