-- Forward-only reconciliation for pre-authority booking evidence observed on the
-- linked Ligou project. Every historical receipt remains append-only. For an
-- intent with repeated unknown receipts, the earliest row remains canonical and
-- every later row is quarantined with its original relationship before only the
-- duplicate intent link is cleared.

create table if not exists public.legacy_unknown_receipt_quarantine (
  receipt_id uuid primary key references public.receipts(id),
  original_intent_id uuid not null references public.action_intents(id),
  reason text not null default 'duplicate_unknown_booking_receipt'
    check (reason = 'duplicate_unknown_booking_receipt'),
  quarantined_at timestamptz not null default clock_timestamp()
);

alter table public.legacy_unknown_receipt_quarantine enable row level security;
alter table public.legacy_unknown_receipt_quarantine force row level security;

revoke all on table public.legacy_unknown_receipt_quarantine from public, anon, authenticated;
grant select, insert on table public.legacy_unknown_receipt_quarantine to service_role;

drop trigger if exists legacy_unknown_receipt_quarantine_append_only
  on public.legacy_unknown_receipt_quarantine;
create trigger legacy_unknown_receipt_quarantine_append_only
  before update or delete on public.legacy_unknown_receipt_quarantine
  for each row execute function public.block_mutation();

lock table public.receipts in access exclusive mode;

with ranked as (
  select
    r.id as receipt_id,
    r.intent_id as original_intent_id,
    row_number() over (
      partition by r.intent_id
      order by r.created_at, r.id
    ) as receipt_rank
  from public.receipts r
  where r.kind = 'booking' and r.outcome = 'unknown'
    and r.intent_id is not null
)
insert into public.legacy_unknown_receipt_quarantine (
  receipt_id,
  original_intent_id,
  reason
)
select
  ranked.receipt_id,
  ranked.original_intent_id,
  'duplicate_unknown_booking_receipt'
from ranked
where ranked.receipt_rank > 1
on conflict (receipt_id) do nothing;

alter table public.receipts disable trigger receipts_append_only;

update public.receipts r
set intent_id = null
from public.legacy_unknown_receipt_quarantine q
where r.id = q.receipt_id
  and r.intent_id = q.original_intent_id
  and r.kind = 'booking'
  and r.outcome = 'unknown';

alter table public.receipts enable trigger receipts_append_only;

do $$
begin
  if exists (
    select 1
    from public.receipts r
    where r.kind = 'booking' and r.intent_id is not null
    group by r.intent_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'booking_receipt_reconciliation_incomplete';
  end if;
end;
$$;
