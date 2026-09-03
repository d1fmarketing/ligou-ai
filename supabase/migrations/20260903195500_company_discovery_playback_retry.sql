begin;

-- Application-owned TTS can be persisted successfully while the browser ends
-- before playback reaches the provider transcript. With no caller item and no
-- other progress, an exact empty transcript is as owner-empty as the single
-- matching agent opening already accepted by the recovery predicate.
do $patch_company_discovery_playback_retry$
declare
  v_definition text;
  v_old text := '       or jsonb_array_length(v_prior.transcript) <> 1
       or jsonb_typeof(v_prior.transcript->0) is distinct from ''object''
       or not ((v_prior.transcript->0) ?& array[''role'',''text'',''at''])
       or (v_prior.transcript->0) - array[''role'',''text'',''at'']::text[]
         is distinct from ''{}''::jsonb
       or v_prior.transcript->0->>''role'' is distinct from ''agent''
       or v_prior.transcript->0->>''text'' is distinct from
         v_request.opening_payload->>''text'' then';
  v_new text := '       or not (
         v_prior.transcript is not distinct from ''[]''::jsonb
         or (
           jsonb_array_length(v_prior.transcript) = 1
           and jsonb_typeof(v_prior.transcript->0) is not distinct from ''object''
           and (v_prior.transcript->0) ?& array[''role'',''text'',''at'']
           and (v_prior.transcript->0) - array[''role'',''text'',''at'']::text[]
             is not distinct from ''{}''::jsonb
           and v_prior.transcript->0->>''role'' is not distinct from ''agent''
           and v_prior.transcript->0->>''text'' is not distinct from
             v_request.opening_payload->>''text''
         )
       ) then';
begin
  select pg_get_functiondef(
    'public.company_discovery_onboarding_prefill_source_allowed(uuid,uuid,uuid,uuid)'::regprocedure
  ) into v_definition;
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
       / length(v_old) <> 1 then
    raise exception 'company_discovery_playback_retry_patch_mismatch';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$patch_company_discovery_playback_retry$;

commit;
