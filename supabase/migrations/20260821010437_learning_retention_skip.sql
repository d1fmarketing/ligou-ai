alter table public.calls
  add column if not exists learning_skip_reason text;

update public.calls
set learning_status = 'skipped',
    learning_skip_reason = 'freeform_model_learning_disabled'
where learning_status = 'pending';
