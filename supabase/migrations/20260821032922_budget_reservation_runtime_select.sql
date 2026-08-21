-- PostgREST UPDATE filters and result handling require SELECT on the target relation.
-- Keep the existing UPDATE grant and add only the missing runtime read privilege.
grant select on table public.budget_reservations to service_role;
