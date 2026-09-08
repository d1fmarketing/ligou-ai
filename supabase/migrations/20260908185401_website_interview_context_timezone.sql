begin;
set local lock_timeout='5s';
lock table public.website_interviews in access exclusive mode;

-- A context resolution is not an owner statement. It resolves only a dedicated
-- timezone item; normal hours, weekends, holidays and authority stay unchanged.
create function public.website_timezone_question(p_question text) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(lower(regexp_replace(normalize(btrim(p_question),NFD),U&'[\0300-\036f]','','g'))
   ~ '^(qual (e )?(o )?(fuso( horario)?|timezone)( oficial)?( (usado|utilizado) para os horarios publicados)?|(what|which) (is (the )?)?time ?zone( is used for (the )?published hours)?)\??$',false);
$$;
create function public.website_timezone_context_valid(p_context jsonb) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare k text;begin
 if jsonb_typeof(p_context) is distinct from 'object' or not(p_context ?& array['itemId','timeZone','origin','sourceClaimIds','evidenceRefs'])
  or p_context-array['itemId','timeZone','origin','sourceClaimIds','evidenceRefs']<>'{}'
  or jsonb_typeof(p_context->'itemId') is distinct from 'string' or length(btrim(p_context->>'itemId')) not between 1 and 512
  or coalesce(p_context->>'origin','') not in ('website_configuration','location_inference')
  or jsonb_typeof(p_context->'timeZone') is distinct from 'string' or length(p_context->>'timeZone') not between 1 and 128
  or (p_context->>'timeZone'<>'UTC' and p_context->>'timeZone' !~ '^[A-Za-z_+-]+/[A-Za-z0-9_+/-]+$')
  or not exists(select 1 from pg_catalog.pg_timezone_names n where lower(n.name)=lower(p_context->>'timeZone')) then return false;end if;
 foreach k in array array['sourceClaimIds','evidenceRefs'] loop
  if jsonb_typeof(p_context->k) is distinct from 'array' or jsonb_array_length(p_context->k) not between 1 and 100
   or exists(select 1 from jsonb_array_elements(p_context->k) x where jsonb_typeof(x)<>'string' or x#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
   or p_context->k is distinct from (select jsonb_agg(x order by x#>>'{}') from (select distinct value x from jsonb_array_elements(p_context->k)) d) then return false;end if;
 end loop;
 return true;
exception when others then return false;
end $$;

create function public.website_timezone_context_for_draft(p_draft jsonb,p_item text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare f jsonb;v jsonb;used jsonb:='[]'::jsonb;zone text;declared bigint;territories integer:=0;origin text;result jsonb;begin
 if jsonb_typeof(p_draft->'candidate_facts') is distinct from 'array' then return null;end if;
 select count(*) into declared from jsonb_array_elements(p_draft->'candidate_facts') x
  where x->>'claim_type'='business_hours' and jsonb_typeof(x->'value'->'timezone')='string' and btrim(x->'value'->>'timezone')<>'';
 if declared>0 then
  for f in select value from jsonb_array_elements(p_draft->'candidate_facts') x
   where value->>'claim_type'='business_hours' and jsonb_typeof(value->'value'->'timezone')='string' and btrim(value->'value'->>'timezone')<>'' loop
   if f->>'contradiction_status' is distinct from 'none' or coalesce(f->'missing_fields' ? 'timezone',false) or coalesce(f->'ambiguous_fields' ? 'timezone',false)
     or (zone is not null and zone<>f->'value'->>'timezone') then return null;end if;
   zone:=f->'value'->>'timezone';used:=used||jsonb_build_array(f);
  end loop;
  origin:='website_configuration';
 else
  for f in select value from jsonb_array_elements(p_draft->'candidate_facts') where value->>'claim_type' in ('service_territory','public_address') loop
   if f->>'contradiction_status' is distinct from 'none' or f->'missing_fields' is distinct from '[]'::jsonb
    or f->'ambiguous_fields' is distinct from '[]'::jsonb or f->'uncertainty' is distinct from '[]'::jsonb then return null;end if;
   v:=f->'value';
   if f->>'claim_type'='service_territory' then
    territories:=territories+1;
    if jsonb_typeof(v) is distinct from 'object' or v->'radius' is distinct from 'null'::jsonb or v->'service_type' is distinct from 'null'::jsonb
     or jsonb_typeof(v->'included_areas') is distinct from 'array' or jsonb_array_length(v->'included_areas')=0
     or exists(select 1 from jsonb_array_elements(v->'included_areas') a where jsonb_typeof(a)<>'object' or a->>'country_code' is distinct from 'US'
      or a->>'region_state' is distinct from 'CA' or coalesce(a->>'kind','') not in ('city','county','state') or jsonb_typeof(a->'name') is distinct from 'string' or btrim(a->>'name')='') then return null;end if;
   elsif jsonb_typeof(v) is distinct from 'string' or v#>>'{}' !~* ',\s*CA\s+[0-9]{5}(-[0-9]{4})?(,?\s*(USA|United States))?\s*$' then return null;end if;
   used:=used||jsonb_build_array(f);
  end loop;
  if territories=0 then return null;end if;
  zone:='America/Los_Angeles';origin:='location_inference';
 end if;
 result:=jsonb_build_object('itemId',p_item,'timeZone',zone,'origin',origin,
  'sourceClaimIds',(select jsonb_agg(x order by x) from (select distinct claim->>'claim_id' x from jsonb_array_elements(used) as claims(claim)) d),
  'evidenceRefs',(select jsonb_agg(x order by x) from (select distinct e#>>'{}' x from jsonb_array_elements(used) as claims(claim),jsonb_array_elements(claim->'evidence_refs') e) d));
 if not public.website_timezone_context_valid(result) then return null;end if;
 return result;
exception when others then return null;
end $$;

do $timezone_agenda_contract$
declare v_sql text;v_before text;v_after text;begin
 select pg_get_functiondef('public.website_interview_validate_agenda(jsonb)'::regprocedure) into v_sql;
 v_before:='(select count(*) from jsonb_object_keys(p_agenda))<>7';
 if position(v_before in v_sql)=0 then raise exception 'timezone_prior_agenda_shape_missing';end if;
 v_sql:=replace(v_sql,v_before,'(select count(*) from jsonb_object_keys(p_agenda))<>(case when p_agenda ? ''contextTimezone'' then 8 else 7 end)');
 v_before:='''open'',''awaiting_clarification'',''answered'',''corrected'',''not_applicable'',''deferred_owner_review''';
 if position(v_before in v_sql)=0 then raise exception 'timezone_prior_agenda_status_missing';end if;
 v_sql:=replace(v_sql,v_before,v_before||',''context_resolved''');
 v_before:='v_queue:=p_agenda->''items''||(p_agenda->''candidateOverrides'');';
 v_after:=v_before||$new$
  if p_agenda ? 'contextTimezone' then
    if not public.website_timezone_context_valid(p_agenda->'contextTimezone')
      or not exists(select 1 from jsonb_array_elements(p_agenda->'items') x where x->>'id'=p_agenda->'contextTimezone'->>'itemId' and x->>'status'='context_resolved')
      or exists(select 1 from jsonb_array_elements_text(p_agenda->'contextTimezone'->'sourceClaimIds') id where not exists(select 1 from jsonb_array_elements(p_agenda->'candidateContext') c where c->>'id'='candidate:'||id)) then raise exception 'interview_context_timezone_invalid';end if;
  end if;
  if exists(select 1 from jsonb_array_elements(v_queue) x where x->>'status'='context_resolved' and
    (x->>'id' is distinct from p_agenda->'contextTimezone'->>'itemId' or not public.website_timezone_question(x->>'questionPt')
      or x->>'answerRevision'<>'0' or x->>'clarificationCount'<>'0' or x->'evidence'<>'[]')) then raise exception 'interview_context_timezone_item_invalid';end if;
$new$;
 if position(v_before in v_sql)=0 then raise exception 'timezone_prior_queue_missing';end if;
 execute replace(v_sql,v_before,v_after);

 select pg_get_functiondef('public.initialize_website_interview(uuid,uuid,uuid,uuid,jsonb)'::regprocedure) into v_sql;
 v_before:='x->>''status''<>''open'' or x->>''answerRevision''<>''0''';
 if position(v_before in v_sql)=0 then raise exception 'timezone_prior_initialize_status_missing';end if;
 v_sql:=replace(v_sql,v_before,'x->>''status'' not in (''open'',''context_resolved'') or x->>''answerRevision''<>''0''');
 v_before:='v_digest:=encode(extensions.digest(public.onboarding_canonical_json_v1(p_agenda),''sha256''),''hex'');';
 v_after:=$new$if p_agenda ? 'contextTimezone' then
    if not exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=5 and opening_mode_requested='realtime_native_v1')
      or p_agenda->'contextTimezone' is distinct from (select public.website_timezone_context_for_draft(draft,p_agenda->'contextTimezone'->>'itemId') from public.company_discovery_onboarding_drafts where id=v_p.draft_id)
      or not exists(select 1 from public.company_discovery_onboarding_drafts d,jsonb_array_elements(p_agenda->'items') x where d.id=v_p.draft_id
        and x->>'id'=p_agenda->'contextTimezone'->>'itemId' and x->>'source'='missing_website_information' and d.draft->'missing_information' ? (x->>'questionPt')) then
      raise exception 'interview_context_timezone_source_mismatch';end if;
  end if;
  $new$||v_before;
 if position(v_before in v_sql)=0 then raise exception 'timezone_prior_initialize_digest_missing';end if;
 execute replace(v_sql,v_before,v_after);

 select pg_get_functiondef('public.commit_website_interview_turn_provenance_core(uuid,uuid,uuid,bigint,bigint,text,text,jsonb,text,jsonb)'::regprocedure) into v_sql;
 v_before:=$old$if p_agenda->'binding' is distinct from v_i.agenda->'binding'$old$;
 v_after:=$new$if p_agenda->'contextTimezone' is distinct from v_i.agenda->'contextTimezone' then
    if not(v_i.agenda ? 'contextTimezone') or p_agenda ? 'contextTimezone' or p_proposal_kind<>'correction'
      or not exists(select 1 from jsonb_array_elements(p_agenda->'items') x where x->>'id'=v_i.agenda->'contextTimezone'->>'itemId'
        and x->>'status' in ('corrected','open') and x->>'answerRevision'='1' and x->'evidence'->-1=v_turn) then raise exception 'interview_context_timezone_changed';end if;
  end if;
  if p_agenda->'binding' is distinct from v_i.agenda->'binding'$new$;
 if position(v_before in v_sql)=0 then raise exception 'timezone_prior_commit_binding_missing';end if;
 execute replace(v_sql,v_before,v_after);

 select pg_get_functiondef('public.attach_website_interview(uuid,uuid,uuid,uuid,uuid)'::regprocedure) into v_sql;
 v_before:='perform public.website_interview_validate_agenda(v_agenda);';
 v_after:=$new$if v_i.agenda ? 'contextTimezone' and exists(select 1 from jsonb_array_elements(coalesce(v_m.proposal->'affectedItems','[]')) x where x->>'itemId'=v_i.agenda->'contextTimezone'->>'itemId') then
    v_agenda:=v_agenda-'contextTimezone';
  end if;
  $new$||v_before;
 if position(v_before in v_sql)=0 then raise exception 'timezone_prior_amendment_attach_missing';end if;
 execute replace(v_sql,v_before,v_after);
end $timezone_agenda_contract$;
revoke all on function public.website_timezone_question(text),public.website_timezone_context_valid(jsonb),public.website_timezone_context_for_draft(jsonb,text) from public,anon,authenticated,service_role;
commit;
