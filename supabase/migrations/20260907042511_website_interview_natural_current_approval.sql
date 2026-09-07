-- Present first-person approval of the currently presented recap/configuration.
-- A completed review or "correções que confirmei" is retrospective context,
-- not a new correction request. The entire utterance must still match.
-- No changes to owner binding, played-summary evidence, revision, or grants.
create or replace function public.website_interview_positive_approval(p_text text) returns boolean
language plpgsql immutable set search_path='' as $$
declare
  v_normal text;
  v_legacy text := 'sim|(?:eu )?(?:aprovo|confirmo)|aprovado|aprovada|esta correto|esta correta|esta tudo correto|esta tudo correta|tudo certo|tudo correto|correto|correta|pode salvar|pode confirmar';
  v_summary text := '(?:este|esse|o) resumo(?: atual| apresentado)?';
  v_configuration text := '(?:esta|essa|a) configuracao(?: atual| apresentada)?';
  v_completed_corrections text := '(?: com as correcoes que (?:eu )?(?:ja )?confirmei)?';
  v_direct text;
  v_correctness text;
  v_reviewed text;
  v_clause text;
begin
  v_normal:=regexp_replace(normalize(lower(p_text),NFD),U&'[\0300-\036F]','','g');
  if v_normal is null or v_normal ~ '[^a-z[:space:].,!;:–—-]' then return false; end if;
  v_normal:=btrim(regexp_replace(v_normal,'[[:space:].,!;:–—-]+',' ','g'));
  v_direct := '(?:eu )?(?:aprovo|confirmo)(?: explicitamente)? (?:'||v_summary||'|a versao atual do resumo|'||v_configuration||')'||v_completed_corrections;
  v_correctness := '(?:eu )?confirmo(?: explicitamente)? que (?:'||v_summary||' esta correto|'||v_configuration||' esta correta)';
  v_reviewed := '(?:(?:eu )?(?:revisei|conferi|li) '||v_summary||' (?:e )?)?';
  v_clause := '(?:'||v_legacy||'|'||v_reviewed||'(?:'||v_direct||'|'||v_correctness||'))';
  return v_normal ~ ('^'||v_clause||'(?: (?:e )?'||v_clause||')*$');
end;
$$;
