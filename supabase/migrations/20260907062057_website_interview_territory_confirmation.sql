-- Presentation derived only from the latest resolved owner's territory evidence.
-- No policy materialization, locality normalization, or historical-row rewrite.
create function public.website_territory_confirmation(p_agenda jsonb) returns text
language plpgsql stable set search_path='' as $$
declare
  v_fallback text := 'Obrigado, registrei sua resposta. ';
  v_latest jsonb := (p_agenda->'ownerTurns')->-1;
  v_text text; v_parts text[]; v_part text; v_normal text; v_kept text[] := ARRAY[]::text[];
  v_outside boolean := false; v_excerpt text;
begin
  if v_latest is null or not exists (
    select 1 from jsonb_array_elements(p_agenda->'items') item
    where item->'coverageRefs' @> '["area.coverage"]'::jsonb
      and item->>'status' in ('answered','corrected') and (item->>'answerRevision')::bigint>0
      and (item->'evidence'->-1)->>'turnId'=v_latest->>'turnId'
      and (item->'evidence'->-1)->>'text'=v_latest->>'text'
  ) then return v_fallback; end if;
  v_text:=v_latest->>'text';
  if v_text is null or length(v_text)>700 or v_text ~ '["“”<>[:cntrl:]]' then return v_fallback; end if;
  v_text:=regexp_replace(regexp_replace(btrim(v_text),'^(?:(?:uhum|aham|ah|entendi)[.!?, ]+)*','','i'),'^olha[, ]+','','i');
  v_parts:=regexp_split_to_array(v_text,'(?<=[.!?]) +');
  v_normal:=lower(regexp_replace(normalize(v_parts[1],NFD),U&'[\0300-\036F]','','g'));
  if v_normal !~ '^(?:(?:atendemos|atende) (?:so|somente|apenas|exclusivamente) |(?:a )?nossa area (?:fica|esta|e) restrita a )' then return v_fallback; end if;
  foreach v_part in array v_parts loop
    v_normal:=lower(regexp_replace(normalize(v_part,NFD),U&'[\0300-\036F]','','g'));
    if v_normal ~ '^(?:se .* fora\y|para sair dessas cidades\y|fora (?:da area|dessas cidades|da cobertura)\y)'
      and v_normal ~ '\y(?:aprovacao|autorizacao)\y' and v_normal ~ '\y(?:dono|proprietario|minha|comigo)\y' then v_outside:=true; end if;
  end loop;
  if not v_outside then return v_fallback; end if;
  foreach v_part in array v_parts loop
    v_normal:=lower(regexp_replace(normalize(v_part,NFD),U&'[\0300-\036F]','','g'));
    -- Only this wholly redundant historical aside is omitted. Additional
    -- conditions and prohibitions are retained, never shortened to fit.
    if v_normal !~ '^ja (?:teve|tivemos|recebemos) pedidos? de (?:gente|pessoas|clientes) de outras cidades, mas nao e (?:pra|para) atender[.!]?$' then
      v_kept:=array_append(v_kept,regexp_replace(v_part,', *combinado[?!.]*$','','i'));
    end if;
  end loop;
  v_excerpt:=btrim(regexp_replace(array_to_string(v_kept,' '),'[.!?]+$',''));
  if v_excerpt is null or v_excerpt='' or length(v_excerpt)>480 then return v_fallback; end if;
  return 'Registrado. Você informou: “'||v_excerpt||'”. ';
end;
$$;
revoke all on function public.website_territory_confirmation(jsonb) from public,anon,authenticated,service_role;

-- Preserve the existing action identity, unresolved-question selection and ACL.
create or replace function public.website_interview_action(p_agenda jsonb,p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_next jsonb; v_type text; v_prefix text; v_id text; v_b jsonb:=p_agenda->'binding'; begin
  select value into v_next from jsonb_array_elements(p_agenda->'items'||(p_agenda->'candidateOverrides')) with ordinality x(value,n) where value->>'status' in ('open','awaiting_clarification') order by n limit 1;
  v_type:=case p_kind when 'off_scope' then 'DEFER_OFF_SCOPE_AND_CONTINUE' when 'correction' then 'HANDLE_OWNER_CORRECTION'
    when 'clarification' then case when v_next->>'status'='awaiting_clarification' then 'CLARIFY_CURRENT_GAP' else 'CONFIRM_AND_ASK_NEXT' end
    when 'initial' then case when v_next->>'status'='awaiting_clarification' then 'CLARIFY_CURRENT_GAP' else 'ASK_NEXT_GAP' end
    else 'CONFIRM_AND_ASK_NEXT' end;
  if v_next is null and v_type not in ('HANDLE_OWNER_CORRECTION','DEFER_OFF_SCOPE_AND_CONTINUE') then v_type:='GENERATE_FINAL_SUMMARY'; end if;
  v_prefix:=case v_type when 'ASK_NEXT_GAP' then '' when 'CLARIFY_CURRENT_GAP' then 'Para esclarecer: '
    when 'CONFIRM_AND_ASK_NEXT' then public.website_territory_confirmation(p_agenda)
    when 'DEFER_OFF_SCOPE_AND_CONTINUE' then 'Podemos tratar disso depois; agora vamos concluir sua configuração. '
    when 'GENERATE_FINAL_SUMMARY' then 'Vou preparar o resumo para sua revisão.' when 'HANDLE_OWNER_CORRECTION' then 'Registrei sua correção. ' end;
  v_id:=encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(1,v_b->>'interviewId',v_b->>'callId',v_b->>'draftId',v_b->>'draftHash',v_b->>'sourceResultId',v_b->>'sourceResultHash',(p_agenda->>'revision')::bigint,v_next->>'id',v_type)),'sha256'),'hex');
  return jsonb_strip_nulls(jsonb_build_object('type',v_type,'actionId',v_id,'itemId',v_next->>'id','questionPt',v_next->>'questionPt','spokenPt',v_prefix||coalesce(v_next->>'questionPt',case when v_type='GENERATE_FINAL_SUMMARY' then '' else 'Vou preparar o resumo para sua revisão.' end)));
end $$;
