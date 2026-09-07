-- Read back the current committed area evidence independently of ASR fillers,
-- verb inflection, or an exception clause. Keep the helper private and read-only.
create or replace function public.website_territory_confirmation(p_agenda jsonb) returns text
language plpgsql stable set search_path='' as $$
declare
  v_fallback text := 'Obrigado, registrei sua resposta. ';
  v_latest jsonb := (p_agenda->'ownerTurns')->-1;
  v_text text; v_parts text[]; v_part text; v_normal text; v_kept text[] := ARRAY[]::text[];
  v_exclusive boolean := false; v_excerpt text;
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
  v_text:=regexp_replace(btrim(v_text),'^(?:(?:uhum|aham|hum|ah|entendi|olha)[.!?, ]+|1, *olha[, ]+)*','','i');
  v_parts:=regexp_split_to_array(v_text,'(?<=[.!?]) +');
  v_normal:=lower(regexp_replace(normalize(v_parts[1],NFD),U&'[\0300-\036F]','','g'));
  -- This check only proves the historical aside redundant. Unrecognized
  -- wording still receives the full attributed readback, with all conditions.
  v_exclusive:=v_normal ~ '^(?:(?:atendemos|atende) (?:so|somente|apenas|exclusivamente) |(?:a )?nossa area (?:fica|esta|e) restrita a )';
  foreach v_part in array v_parts loop
    v_normal:=lower(regexp_replace(normalize(v_part,NFD),U&'[\0300-\036F]','','g'));
    if not v_exclusive or v_normal !~ '^ja (?:teve|tivemos|recebemos) pedidos? de (?:gente|pessoas|clientes) de outras cidades, mas nao e (?:pra|para) atender[.!]?$' then
      v_kept:=array_append(v_kept,regexp_replace(v_part,', *combinado[?!.]*$','','i'));
    end if;
  end loop;
  v_excerpt:=btrim(regexp_replace(array_to_string(v_kept,' '),'[.!?]+$',''));
  if v_excerpt is null or v_excerpt='' or length(v_excerpt)>480 then return v_fallback; end if;
  return 'Registrado. Você informou: “'||v_excerpt||'”. ';
end;
$$;
revoke all on function public.website_territory_confirmation(jsonb) from public,anon,authenticated,service_role;
