-- Summaries retry instead of dying on the first transient error (a 404 on the model name marked
-- RJ's first real call "failed" forever, with no log). Terminal only after 3 attempts.
alter table public.calls add column if not exists summary_attempts int not null default 0;
