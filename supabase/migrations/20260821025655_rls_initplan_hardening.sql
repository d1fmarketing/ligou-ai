-- Forward-only replacement of owner read policies. Restrict the policies to the
-- authenticated role and evaluate auth.uid() once per statement.
drop policy if exists tenants_owner_select on public.tenants;
create policy tenants_owner_select on public.tenants for select to authenticated
using (owner_user_id = (select auth.uid()));

drop policy if exists rules_owner_select on public.rules;
create policy rules_owner_select on public.rules for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists cases_owner_select on public.approval_cases;
create policy cases_owner_select on public.approval_cases for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists calls_owner_select on public.calls;
create policy calls_owner_select on public.calls for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists usage_owner_select on public.usage_ledger;
create policy usage_owner_select on public.usage_ledger for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists powers_owner_select on public.powers;
create policy powers_owner_select on public.powers for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists intents_owner_select on public.action_intents;
create policy intents_owner_select on public.action_intents for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists receipts_owner_select on public.receipts;
create policy receipts_owner_select on public.receipts for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists bookings_owner_select on public.bookings;
create policy bookings_owner_select on public.bookings for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists notifications_owner_all on public.notifications;
create policy notifications_owner_all on public.notifications for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists opt_outs_owner_select on public.contact_opt_outs;
create policy opt_outs_owner_select on public.contact_opt_outs for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists communications_owner_select on public.communications;
create policy communications_owner_select on public.communications for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists skill_candidates_owner_select on public.skill_candidates;
create policy skill_candidates_owner_select on public.skill_candidates for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists skill_events_owner_select on public.skill_pipeline_events;
create policy skill_events_owner_select on public.skill_pipeline_events for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));

drop policy if exists budget_reservations_owner_select on public.budget_reservations;
create policy budget_reservations_owner_select on public.budget_reservations for select to authenticated
using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = (select auth.uid())));
