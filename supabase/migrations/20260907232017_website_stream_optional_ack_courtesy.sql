begin;
set local lock_timeout='5s';

-- Only an application-selected saved-answer courtesy may be omitted. Never
-- normalize that claim out of the provider transcript or rewrite stored proof.
-- The standalone normalizer remains unchanged from its deployed definition.
create or replace function public.website_stream_transcript_matches(p_expected text,p_actual text) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(length(p_expected) between 1 and 4096 and length(p_actual) between 1 and 8192
    and btrim(p_actual)<>'' and (
      public.website_stream_transcript_normalize(p_expected)=public.website_stream_transcript_normalize(p_actual)
      or public.website_stream_transcript_normalize(regexp_replace(p_expected collate pg_catalog."und-x-icu",
        '^\s*obrigado[\s,.!:;]+registrei\s+sua\s+resposta\s*[,!.:;]+\s*(?=[\s\S]*[[:alnum:]])','','i'))=public.website_stream_transcript_normalize(p_actual)
    ),false);
$$;

-- CREATE OR REPLACE retains existing ACLs; keep this helper private explicitly.
revoke all on function public.website_stream_transcript_matches(text,text) from public,anon,authenticated,service_role;
commit;
