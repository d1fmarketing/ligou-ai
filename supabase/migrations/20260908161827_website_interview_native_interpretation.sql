begin;
set local lock_timeout='5s';
lock table public.website_interviews in access exclusive mode;
lock table public.website_interview_owner_turns in access exclusive mode;
lock table public.website_interview_fact_batches in access exclusive mode;

-- Existing text remains literal ASR. Only native operations can establish the
-- separate interpretation; later ASR fills its own field without editing facts.
alter table public.website_interview_owner_turns alter column owner_text drop not null;
alter table public.website_interview_owner_turns add column interpretation_text text
  check(interpretation_text is null or (length(btrim(interpretation_text))>0 and length(interpretation_text)<=32768));
alter table public.website_interview_owner_turns add constraint website_owner_turn_content_required
  check(owner_text is not null or interpretation_text is not null);
alter table public.website_interview_fact_batches alter column owner_text drop not null;
alter table public.website_interview_fact_batches add column interpretation_text text
  check(interpretation_text is null or (length(btrim(interpretation_text))>0 and length(interpretation_text)<=32768));
alter table public.website_interview_fact_batches add constraint website_fact_batch_content_required
  check((owner_text is not null and interpretation_text is null) or (owner_text is null and interpretation_text is not null));

create function public.website_interview_owner_evidence_once() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if tg_op='DELETE' then raise exception 'append_only';end if;
  if (to_jsonb(new)-array['owner_text','interpretation_text']) is distinct from (to_jsonb(old)-array['owner_text','interpretation_text'])
    or (old.owner_text is not null and new.owner_text is distinct from old.owner_text)
    or (old.interpretation_text is not null and new.interpretation_text is distinct from old.interpretation_text)
    or (new.owner_text is not distinct from old.owner_text and new.interpretation_text is not distinct from old.interpretation_text)
    or not exists(select 1 from public.website_interview_calls wc join public.browser_session_requests br on br.id=wc.request_id
      where wc.call_id=old.call_id and br.call_id=wc.call_id and br.onboarding_protocol_version=5 and br.opening_mode_requested='realtime_native_v1') then raise exception 'append_only';end if;
  return new;
end $$;
drop trigger website_interview_owner_turns_append_only on public.website_interview_owner_turns;
create trigger website_interview_owner_turns_append_only before update or delete on public.website_interview_owner_turns
  for each row execute function public.website_interview_owner_evidence_once();

create or replace function public.record_website_interview_owner_turn(p_owner uuid,p_call uuid,p_request uuid,p_item text,p_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_tenant uuid;v_turn public.website_interview_owner_turns;v_replayed boolean;begin
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);
  if not exists(select 1 from public.website_interview_calls c join public.website_interviews i on i.interview_id=c.interview_id
    where c.call_id=p_call and c.request_id=p_request and i.current_call_id=p_call and i.state<>'complete') then raise exception 'interview_not_current';end if;
  if p_item is null or length(btrim(p_item)) not between 1 and 400 or p_text is null or length(btrim(p_text))<1 or length(p_text)>32768 then raise exception 'interview_owner_transcript_invalid';end if;
  select * into v_turn from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item for update;
  v_replayed:=v_turn.owner_text is not null;
  if v_turn.owner_text is not null and v_turn.owner_text<>p_text then raise exception using errcode='23505',message='interview_owner_transcript_conflict';end if;
  if v_turn.call_id is null then
    insert into public.website_interview_owner_turns(call_id,provider_item_id,tenant_id,owner_text) values(p_call,p_item,v_tenant,p_text);
  elsif v_turn.owner_text is null then
    update public.website_interview_owner_turns set owner_text=p_text where call_id=p_call and provider_item_id=p_item;
  end if;
  return jsonb_build_object('callId',p_call,'turnId',p_call::text||':'||p_item,'providerItemId',p_item,'text',p_text,'replayed',v_replayed);
end $$;

-- The pure agenda validator understands both exact evidence forms. Persistence
-- still assigns native provenance from the privileged native operation path.
do $provenance_contract$
declare v_sql text;v_before text;v_after text;begin
  select pg_get_functiondef('public.website_interview_validate_agenda(jsonb)'::regprocedure) into v_sql;
  v_before:=$old$if (select count(*) from jsonb_object_keys(v_e))<>2 then raise exception 'interview_turn_invalid'; end if;$old$;
  v_after:=$new$if not(v_e ?& array['turnId','text']) or jsonb_typeof(v_e->'turnId')<>'string' or jsonb_typeof(v_e->'text')<>'string'
      or not ((v_e-array['turnId','text'])='{}'::jsonb or ((v_e-array['turnId','text','provenance'])='{}'::jsonb and v_e->'provenance'='"model_interpretation"'::jsonb)) then raise exception 'interview_turn_invalid';end if;$new$;
  if position(v_before in v_sql)=0 then raise exception 'native_evidence_schema_prior_missing';end if;
  v_sql:=replace(v_sql,v_before,v_after);
  v_before:=$old$if not (p_agenda->'ownerTurns' @> jsonb_build_array(v_e)) then raise exception 'interview_evidence_not_owner_turn'; end if;$old$;
  v_after:=$new$if not exists(select 1 from jsonb_array_elements(p_agenda->'ownerTurns') t where t=v_e) then raise exception 'interview_evidence_not_owner_turn';end if;$new$;
  if position(v_before in v_sql)=0 then raise exception 'native_evidence_link_prior_missing';end if;
  execute replace(v_sql,v_before,v_after);
  select pg_get_functiondef('public.website_territory_confirmation(jsonb)'::regprocedure) into v_sql;
  v_before:='if v_latest is null or not exists (';
  if position(v_before in v_sql)=0 then raise exception 'native_territory_reader_prior_missing';end if;
  execute replace(v_sql,v_before,'if v_latest is null or v_latest->>''provenance''=''model_interpretation'' or not exists (');

  -- Share the existing reducer transaction and invariants. Its additional private
  -- argument records native operation identity; legacy callers always pass NULL.
  select pg_get_functiondef('public.commit_website_interview_turn(uuid,uuid,uuid,bigint,bigint,text,text,jsonb,text)'::regprocedure) into v_sql;
  v_sql:=replace(v_sql,'public.commit_website_interview_turn(','public.commit_website_interview_turn_provenance_core(');
  v_before:='p_proposal_kind text)';
  if position(v_before in v_sql)=0 then raise exception 'native_commit_signature_prior_missing';end if;
  v_sql:=replace(v_sql,v_before,'p_proposal_kind text, p_native_operation jsonb)');
  v_before:=$old$select owner_text into v_text from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item;$old$;
  v_after:=$new$if p_native_operation is null then
    select owner_text into v_text from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item;
  else
    if not exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=5 and opening_mode_requested='realtime_native_v1') then raise exception 'interview_native_protocol_not_current';end if;
    select interpretation_text into v_text from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item;
    if v_text is distinct from p_native_operation->>'interpretation' or p_native_operation->'proposal'->>'kind' is distinct from p_proposal_kind then raise exception 'interview_native_interpretation_conflict';end if;
  end if;$new$;
  if position(v_before in v_sql)=0 then raise exception 'native_commit_text_prior_missing';end if;
  v_sql:=replace(v_sql,v_before,v_after);
  v_before:=$old$if v_prior.payload_hash<>v_digest or$old$;
  if position(v_before in v_sql)=0 then raise exception 'native_commit_replay_prior_missing';end if;
  v_sql:=replace(v_sql,v_before,$new$if v_prior.detail->'nativeOperation' is distinct from p_native_operation or v_prior.payload_hash<>v_digest or$new$);
  v_before:=$old$v_turn:=jsonb_build_object('turnId',p_call::text||':'||p_item,'text',v_text);$old$;
  if position(v_before in v_sql)=0 then raise exception 'native_commit_evidence_prior_missing';end if;
  v_sql:=replace(v_sql,v_before,v_before||$new$
  if p_native_operation is not null then v_turn:=v_turn||jsonb_build_object('provenance','model_interpretation');end if;$new$);
  v_before:=$old$'dbVersion',v_i.db_version+1));$old$;
  if position(v_before in v_sql)=0 then raise exception 'native_commit_receipt_prior_missing';end if;
  v_sql:=replace(v_sql,v_before,$new$'dbVersion',v_i.db_version+1)||case when p_native_operation is null then '{}'::jsonb else jsonb_build_object('nativeOperation',p_native_operation) end);$new$);
  execute v_sql;
end $provenance_contract$;

create or replace function public.commit_website_interview_turn(p_owner uuid,p_call uuid,p_request uuid,p_revision bigint,p_store_version bigint,p_digest text,p_item text,p_agenda jsonb,p_proposal_kind text) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
  return public.commit_website_interview_turn_provenance_core(p_owner,p_call,p_request,p_revision,p_store_version,p_digest,p_item,p_agenda,p_proposal_kind,null);
end $$;

create function public.website_interview_native_interpretation(p_owner uuid,p_call uuid,p_request uuid,p_item text,p_interpretation text) returns public.website_interviews
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews;v_turn public.website_interview_owner_turns;begin
  v_i:=public.website_interview_native_actor(p_owner,p_call,p_request);
  if p_item is null or length(btrim(p_item)) not between 1 and 400 or p_interpretation is null or length(btrim(p_interpretation))<1 or length(p_interpretation)>32768 then raise exception 'interview_native_content_invalid';end if;
  select * into v_turn from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item for update;
  if v_turn.interpretation_text is not null and v_turn.interpretation_text<>p_interpretation then raise exception 'interview_native_interpretation_conflict';end if;
  if v_turn.call_id is null then
    insert into public.website_interview_owner_turns(call_id,provider_item_id,tenant_id,owner_text,interpretation_text) values(p_call,p_item,v_i.tenant_id,null,p_interpretation);
  elsif v_turn.interpretation_text is null then
    update public.website_interview_owner_turns set interpretation_text=p_interpretation where call_id=p_call and provider_item_id=p_item;
  end if;
  return v_i;
end $$;

create function public.replay_website_interview_native_turn(p_owner uuid,p_call uuid,p_request uuid,p_item text,p_interpretation text,p_proposal jsonb,p_facts jsonb default '[]') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews;v_r public.receipts;begin
  v_i:=public.website_interview_native_actor(p_owner,p_call,p_request);
  if p_item is null or length(btrim(p_item)) not between 1 and 400 or p_interpretation is null or length(btrim(p_interpretation))<1 or length(p_interpretation)>32768 then raise exception 'interview_native_content_invalid';end if;
  select * into v_r from public.receipts where tenant_id=v_i.tenant_id and kind='website_interview' and external_id='website-interview:'||p_call::text||':turn:'||p_item;
  if v_r.id is null then return null;end if;
  if v_r.call_id is distinct from p_call or v_r.outcome<>'accepted' or v_r.detail->'nativeOperation' is distinct from jsonb_build_object('interpretation',p_interpretation,'proposal',p_proposal,'facts',p_facts) then raise exception 'interview_native_replay_conflict';end if;
  return public.website_interview_readback(v_i.interview_id,true)||jsonb_build_object('operationReceiptId',v_r.id,'operationRevision',v_r.readback->'agenda'->'revision');
end $$;

create function public.commit_website_interview_native_turn(p_owner uuid,p_call uuid,p_request uuid,p_revision bigint,p_store_version bigint,p_digest text,p_item text,p_interpretation text,p_proposal jsonb,p_agenda jsonb,p_facts jsonb default '[]') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews;v_result jsonb;v_r public.receipts;v_refs jsonb;v_current jsonb;v_target jsonb;v_targets jsonb;v_changed jsonb;v_evidence jsonb;begin
  v_i:=public.website_interview_native_interpretation(p_owner,p_call,p_request,p_item,p_interpretation);
  if p_proposal is null or jsonb_typeof(p_proposal)<>'object' or octet_length(p_proposal::text)>65536
    or coalesce(p_proposal->>'kind','') not in ('answer','clarification','off_scope','defer','not_applicable','correction') then raise exception 'interview_native_proposal_invalid';end if;
  if p_facts is null or jsonb_typeof(p_facts)<>'array' or octet_length(p_facts::text)>131072 or jsonb_array_length(p_facts)>100
    or exists(select 1 from jsonb_array_elements(p_facts) f where jsonb_typeof(f)<>'object' or f ? 'owner_words' or f ? 'provenance'
      or f-array['topic','field','subject','disposition','rule_text','structured']<>'{}'
      or length(btrim(coalesce(f->>'field','')))=0 or coalesce(f->>'disposition','') not in ('answered','not_applicable','owner_review_required') or jsonb_typeof(f->'structured') is distinct from 'object') then raise exception 'interview_native_facts_invalid';end if;
  v_result:=public.replay_website_interview_native_turn(p_owner,p_call,p_request,p_item,p_interpretation,p_proposal,p_facts);
  if v_result is not null then return v_result;end if;
  -- Scope the declared proposal to the exact changed evidence, in addition to
  -- the shared reducer's immutable seed, current/related graph and counter checks.
  select value into v_current from jsonb_array_elements(v_i.agenda->'items'||(v_i.agenda->'candidateOverrides')) with ordinality a(value,n)
    where value->>'status' in ('open','awaiting_clarification') order by n limit 1;
  v_evidence:=jsonb_build_object('turnId',p_call::text||':'||p_item,'text',p_interpretation,'provenance','model_interpretation');
  select coalesce(jsonb_agg(x->>'id' order by x->>'id'),'[]') into v_changed from jsonb_array_elements(p_agenda->'items'||(p_agenda->'candidateOverrides')) x where x->'evidence' @> jsonb_build_array(v_evidence);
  if p_proposal->>'kind' in ('answer','clarification','defer','not_applicable') then
    if jsonb_typeof(p_proposal->'itemId') is distinct from 'string' or p_proposal->>'itemId' is distinct from v_current->>'id' or v_current is null
      or p_proposal-array['kind','itemId','relatedItemIds','questionPt']<>'{}' then raise exception 'interview_native_target_not_current';end if;
    if p_proposal->>'kind'<>'answer' and p_proposal ? 'relatedItemIds' then raise exception 'interview_native_proposal_invalid';end if;
    if p_proposal->>'kind'<>'clarification' and p_proposal ? 'questionPt' then raise exception 'interview_native_proposal_invalid';end if;
    if jsonb_typeof(coalesce(p_proposal->'relatedItemIds','[]'))<>'array' then raise exception 'interview_native_proposal_invalid';end if;
    v_targets:=jsonb_build_array(p_proposal->'itemId')||coalesce(p_proposal->'relatedItemIds','[]');
  elsif p_proposal->>'kind'='off_scope' then
    if p_proposal<>'{"kind":"off_scope"}' then raise exception 'interview_native_proposal_invalid';end if;
    v_targets:=case when v_changed='[]' then '[]'::jsonb else jsonb_build_array(v_current->'id') end;
  else
    if p_proposal-array['kind','affectedItems','affectedCandidates']<>'{}' or jsonb_typeof(coalesce(p_proposal->'affectedItems','[]'))<>'array'
      or jsonb_typeof(coalesce(p_proposal->'affectedCandidates','[]'))<>'array' then raise exception 'interview_native_proposal_invalid';end if;
    if exists(select 1 from jsonb_array_elements(coalesce(p_proposal->'affectedItems','[]')) x where jsonb_typeof(x->'itemId') is distinct from 'string' or x ? 'candidateId')
      or exists(select 1 from jsonb_array_elements(coalesce(p_proposal->'affectedCandidates','[]')) x where jsonb_typeof(x->'candidateId') is distinct from 'string' or x ? 'itemId') then raise exception 'interview_native_proposal_invalid';end if;
    v_targets:='[]';
    for v_target in select value from jsonb_array_elements(coalesce(p_proposal->'affectedItems','[]')||coalesce(p_proposal->'affectedCandidates','[]')) loop
      if jsonb_typeof(v_target)<>'object' or v_target-array['itemId','candidateId','disposition']<>'{}' or (v_target ? 'itemId')=(v_target ? 'candidateId')
        or coalesce(v_target->>'disposition','') not in ('corrected','reopen') then raise exception 'interview_native_proposal_invalid';end if;
      if not exists(select 1 from jsonb_array_elements(p_agenda->'items'||(p_agenda->'candidateOverrides')) x
        where x->>'id'=coalesce(v_target->>'itemId',v_target->>'candidateId') and x->>'status'=case v_target->>'disposition' when 'reopen' then 'open' else 'corrected' end) then raise exception 'interview_native_target_not_current';end if;
      v_targets:=v_targets||jsonb_build_array(coalesce(v_target->'itemId',v_target->'candidateId'));
    end loop;
  end if;
  if exists(select 1 from jsonb_array_elements(v_targets) x where jsonb_typeof(x)<>'string')
    or (select count(distinct x) from jsonb_array_elements(v_targets) x)<>jsonb_array_length(v_targets)
    or v_changed is distinct from (select coalesce(jsonb_agg(x order by x#>>'{}'),'[]') from jsonb_array_elements(v_targets) x) then raise exception 'interview_native_proposal_targets_changed';end if;
  v_result:=public.commit_website_interview_turn_provenance_core(p_owner,p_call,p_request,p_revision,p_store_version,p_digest,p_item,p_agenda,p_proposal->>'kind',jsonb_build_object('interpretation',p_interpretation,'proposal',p_proposal,'facts',p_facts));
  select * into v_r from public.receipts where tenant_id=v_i.tenant_id and kind='website_interview' and external_id='website-interview:'||p_call::text||':turn:'||p_item;
  select coalesce(jsonb_agg(distinct ref),'[]') into v_refs from jsonb_array_elements(p_agenda->'items'||(p_agenda->'candidateOverrides')) x,
    jsonb_array_elements(x->'coverageRefs') ref where x->'evidence' @> jsonb_build_array(v_evidence);
  if jsonb_array_length(p_facts)>0 and (p_proposal->>'kind' not in ('answer','correction','not_applicable') or exists(select 1 from jsonb_array_elements(p_facts) f
    where not exists(select 1 from jsonb_array_elements_text(v_refs) ref where ref=f->>'field' or right(ref,length(f->>'field')+1)=':'||(f->>'field')))) then raise exception 'interview_fact_evidence_scope_invalid';end if;
  insert into public.website_interview_fact_batches(call_id,provider_item_id,tenant_id,interview_id,agenda_receipt_id,owner_text,interpretation_text,coverage_refs,facts)
    values(p_call,p_item,v_i.tenant_id,v_i.interview_id,v_r.id,null,p_interpretation,v_refs,p_facts);
  return v_result||jsonb_build_object('operationReceiptId',v_r.id,'operationRevision',v_r.readback->'agenda'->'revision');
end $$;

-- Closing corrections also carry interpretation without manufacturing ASR.
-- Reuse all existing approval/target/amendment-lineage checks and receipts.
do $native_amendment_contract$
declare v_sql text;v_before text;v_after text;begin
  select pg_get_functiondef('public.request_website_interview_amendment(uuid,uuid,uuid,uuid,text,jsonb)'::regprocedure) into v_sql;
  v_sql:=replace(v_sql,'public.request_website_interview_amendment(','public.request_website_interview_amendment_provenance_core(');
  v_before:='p_proposal jsonb)';
  if position(v_before in v_sql)=0 then raise exception 'native_amendment_signature_missing';end if;
  v_sql:=replace(v_sql,v_before,'p_proposal jsonb, p_native boolean)');
  v_before:='select owner_text into v_text from public.website_interview_owner_turns';
  if position(v_before in v_sql)=0 then raise exception 'native_amendment_text_missing';end if;
  v_sql:=replace(v_sql,v_before,'select case when p_native then interpretation_text else owner_text end into v_text from public.website_interview_owner_turns');
  v_before:=$old$select readback into v_readback from public.receipts where id=v_prior.receipt_id;$old$;
  if position(v_before in v_sql)=0 then raise exception 'native_amendment_replay_missing';end if;
  v_sql:=replace(v_sql,v_before,v_before||$new$
    if coalesce(v_readback->>'provenance'='model_interpretation',false) is distinct from p_native then raise exception 'interview_amendment_conflict';end if;$new$);
  v_before:=$old$'state','pending_amendment','replayed',false);$old$;
  if position(v_before in v_sql)=0 then raise exception 'native_amendment_readback_missing';end if;
  v_sql:=replace(v_sql,v_before,$new$'state','pending_amendment','replayed',false)||case when p_native then jsonb_build_object('provenance','model_interpretation','interpretation',v_text) else '{}'::jsonb end;$new$);
  v_before:=$old$jsonb_build_object('ownerText',v_text,'ownerTurnId',p_call::text||':'||p_item,'approvedSnapshotChanged',false,'operatingAuthorityChanged',false)$old$;
  if position(v_before in v_sql)=0 then raise exception 'native_amendment_detail_missing';end if;
  v_sql:=replace(v_sql,v_before,$new$jsonb_build_object('ownerTurnId',p_call::text||':'||p_item,'approvedSnapshotChanged',false,'operatingAuthorityChanged',false)||case when p_native then jsonb_build_object('interpretationText',v_text,'provenance','model_interpretation') else jsonb_build_object('ownerText',v_text) end$new$);
  execute v_sql;
  select pg_get_functiondef('public.attach_website_interview(uuid,uuid,uuid,uuid,uuid)'::regprocedure) into v_sql;
  v_before:=$old$select owner_text into v_text from public.website_interview_owner_turns where call_id=v_m.call_id and provider_item_id=v_m.provider_item_id;$old$;
  v_after:=$new$select case when exists(select 1 from public.receipts where id=v_m.receipt_id and readback->>'provenance'='model_interpretation') then interpretation_text else owner_text end
    into v_text from public.website_interview_owner_turns where call_id=v_m.call_id and provider_item_id=v_m.provider_item_id;$new$;
  if position(v_before in v_sql)=0 then raise exception 'native_amendment_attach_text_missing';end if;
  v_sql:=replace(v_sql,v_before,v_after);
  v_before:=$old$v_turn:=jsonb_build_object('turnId',v_m.call_id::text||':'||v_m.provider_item_id,'text',v_text);$old$;
  if position(v_before in v_sql)=0 then raise exception 'native_amendment_attach_evidence_missing';end if;
  v_sql:=replace(v_sql,v_before,v_before||$new$
  if exists(select 1 from public.receipts where id=v_m.receipt_id and readback->>'provenance'='model_interpretation') then v_turn:=v_turn||jsonb_build_object('provenance','model_interpretation');end if;$new$);
  execute v_sql;
  select pg_get_functiondef('public.approve_website_interview_summary(uuid,uuid,uuid,uuid,text,text,bigint,bigint,text)'::regprocedure) into v_sql;
  v_before:=$old$if not public.website_interview_positive_approval(v_turn.owner_text) then$old$;
  if position(v_before in v_sql)=0 then raise exception 'native_approval_actual_asr_guard_missing';end if;
  execute replace(v_sql,v_before,$new$if v_turn.owner_text is null or not public.website_interview_positive_approval(v_turn.owner_text) then$new$);
end $native_amendment_contract$;

create or replace function public.request_website_interview_amendment(p_owner uuid,p_call uuid,p_request uuid,p_approval uuid,p_item text,p_proposal jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
  return public.request_website_interview_amendment_provenance_core(p_owner,p_call,p_request,p_approval,p_item,p_proposal,false);
end $$;
create function public.request_website_interview_native_amendment(p_owner uuid,p_call uuid,p_request uuid,p_approval uuid,p_item text,p_proposal jsonb,p_interpretation text) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
  perform public.website_interview_native_interpretation(p_owner,p_call,p_request,p_item,p_interpretation);
  return public.request_website_interview_amendment_provenance_core(p_owner,p_call,p_request,p_approval,p_item,p_proposal,true);
end $$;

do $native_interpretation_acl$ declare f record;begin
  for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('website_interview_owner_evidence_once','commit_website_interview_turn_provenance_core','website_interview_native_interpretation','replay_website_interview_native_turn','commit_website_interview_native_turn','request_website_interview_amendment_provenance_core','request_website_interview_native_amendment') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    if f.proname in ('replay_website_interview_native_turn','commit_website_interview_native_turn','request_website_interview_native_amendment') then execute format('grant execute on function %s to service_role',f.signature);end if;
  end loop;
end $native_interpretation_acl$;
commit;
