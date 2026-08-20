-- Server-issued public quotes and appointment offers. Raw opaque tokens never
-- enter the database: only SHA-256 hashes cross the persistence boundary.
create table public.booking_quotes (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  tenant_id uuid not null references public.tenants (id),
  call_id uuid not null references public.calls (id),
  service_type text not null,
  public_quote numeric not null check (public_quote >= 0),
  rule_id uuid not null references public.rules (id),
  policy_epoch integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index booking_quotes_scope_idx on public.booking_quotes (tenant_id, call_id, expires_at);
alter table public.booking_quotes enable row level security;
alter table public.booking_quotes force row level security;

create table public.slot_offers (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  tenant_id uuid not null references public.tenants (id),
  call_id uuid not null references public.calls (id),
  quote_id uuid not null references public.booking_quotes (id),
  service_type text not null,
  slot_start timestamptz not null,
  slot_end timestamptz not null check (slot_end > slot_start),
  local_display text not null,
  public_quote numeric not null check (public_quote >= 0),
  geography text not null,
  power_id uuid not null references public.powers (id),
  rule_id uuid not null references public.rules (id),
  policy_epoch integer not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  booking_id uuid references public.bookings (id),
  created_at timestamptz not null default now()
);
create index slot_offers_scope_idx on public.slot_offers (tenant_id, call_id, expires_at);
alter table public.slot_offers enable row level security;
alter table public.slot_offers force row level security;

create or replace function public.consume_slot_offer(
  p_tenant uuid,
  p_call uuid,
  p_token_hash text,
  p_expected_auth_epoch integer,
  p_expected_policy_epoch integer,
  p_client_name text,
  p_contact text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
  v_offer public.slot_offers;
  v_quote public.booking_quotes;
  v_booking public.bookings;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select t.* into v_tenant from public.tenants t where t.id = p_tenant for update;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_tenant.auth_epoch <> p_expected_auth_epoch then raise exception 'authorization_epoch_stale'; end if;
  if v_tenant.policy_epoch <> p_expected_policy_epoch then raise exception 'policy_epoch_stale'; end if;

  select so.* into v_offer from public.slot_offers so where so.token_hash = p_token_hash for update;
  if v_offer.id is null then raise exception 'slot_offer_not_found'; end if;
  if v_offer.tenant_id <> p_tenant or v_offer.call_id <> p_call then raise exception 'slot_offer_scope_mismatch'; end if;
  if v_offer.expires_at <= now() then raise exception 'slot_offer_expired'; end if;
  if v_offer.consumed_at is not null then raise exception 'slot_offer_consumed'; end if;
  if v_tenant.policy_epoch <> v_offer.policy_epoch then raise exception 'slot_offer_policy_stale'; end if;

  select q.* into v_quote from public.booking_quotes q where q.id = v_offer.quote_id for share;
  if v_quote.id is null
     or v_quote.tenant_id <> v_offer.tenant_id or v_quote.call_id <> v_offer.call_id
     or v_quote.service_type <> v_offer.service_type or v_quote.public_quote <> v_offer.public_quote
     or v_quote.rule_id <> v_offer.rule_id or v_quote.policy_epoch <> v_offer.policy_epoch
     or v_quote.expires_at <= now() then
    raise exception 'slot_offer_quote_invalid';
  end if;

  if not exists (
    select 1 from public.powers p
    where p.id = v_offer.power_id and p.tenant_id = p_tenant
      and p.subject = 'voice_agent' and p.capability = 'create_booking'
      and (p.resource = '*' or p.resource = v_offer.service_type)
      and p.revoked_at is null and (p.expires_at is null or p.expires_at > now())
      and (p.monetary_limit is null or v_offer.public_quote <= p.monetary_limit)
  ) then raise exception 'slot_offer_power_stale'; end if;

  if not exists (
    select 1 from public.effective_rules er
    where er.id = v_offer.rule_id and er.tenant_id = p_tenant
      and er.structured->>'service_type' = v_offer.service_type
      and v_offer.public_quote >= coalesce((er.structured->>'price_min')::numeric, 0)
  ) then raise exception 'slot_offer_rule_stale'; end if;

  insert into public.bookings (
    tenant_id, call_id, client_name, contact, service_type, price_agreed,
    slot_start, slot_end, status, idempotency_key, authority_context
  ) values (
    p_tenant, p_call, nullif(left(p_client_name, 120), ''), nullif(left(p_contact, 120), ''),
    v_offer.service_type, v_offer.public_quote, v_offer.slot_start, v_offer.slot_end,
    'proposed', v_offer.token_hash,
    jsonb_build_object(
      'geography', v_offer.geography, 'channel', 'voice', 'purpose', 'booking',
      'appointment_at', v_offer.slot_start, 'slot_offer_id', v_offer.id,
      'quote_id', v_offer.quote_id
    )
  ) returning * into v_booking;

  update public.slot_offers so set consumed_at = now(), booking_id = v_booking.id where so.id = v_offer.id;

  return jsonb_build_object(
    'booking_id', v_booking.id, 'service_type', v_booking.service_type,
    'public_price', v_booking.price_agreed, 'slot_start', v_booking.slot_start,
    'slot_end', v_booking.slot_end, 'geography', v_offer.geography
  );
end;
$$;

revoke all on function public.consume_slot_offer(uuid,uuid,text,integer,integer,text,text) from public, anon, authenticated;
grant execute on function public.consume_slot_offer(uuid,uuid,text,integer,integer,text,text) to service_role;
