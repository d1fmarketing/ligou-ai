-- F4: learning pipeline state on calls
alter table public.calls add column learning_status text not null default 'pending'
  check (learning_status in ('pending','done','skipped','failed'));
