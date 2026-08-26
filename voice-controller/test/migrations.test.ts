import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

function migrationSql(suffix: string): string {
  const names = readdirSync(migrationsDir).filter((name) => name.endsWith(`_${suffix}.sql`));
  expect(names).toHaveLength(1);
  return readFileSync(path.join(migrationsDir, names[0]!), "utf8").replace(/\s+/g, " ").trim();
}

describe("OAuth connector hardening migration contract", () => {
  test("state consumption is atomic, short-lived, fully bound, and service-role-only", () => {
    const sql = migrationSql("connector_oauth_hardening");
    expect(sql).toContain("function public.consume_oauth_state(text,text,uuid,uuid,text)");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("for update");
    expect(sql).toContain("expires_at <= clock_timestamp()");
    expect(sql).toContain("nonce_hash is distinct from p_nonce_hash");
    expect(sql).toContain("tenant_id is distinct from p_tenant");
    expect(sql).toContain("user_id is distinct from p_user");
    expect(sql).toContain("redirect_uri is distinct from p_redirect");
    expect(sql).toContain("revoke all on function public.consume_oauth_state(text,text,uuid,uuid,text) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.consume_oauth_state(text,text,uuid,uuid,text) to service_role");
  });

  test("owner status RPC exposes metadata only and cannot be invoked anonymously", () => {
    const sql = migrationSql("connector_oauth_hardening");
    expect(sql).toContain("function public.get_connector_status()");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("t.owner_user_id");
    expect(sql).not.toContain("returns table (refresh_token");
    expect(sql).toContain("drop view if exists public.connector_status");
    expect(sql).toContain("revoke all on function public.get_connector_status() from public, anon");
    expect(sql).toContain("grant execute on function public.get_connector_status() to authenticated");
  });

  test("encrypted token columns quarantine legacy plaintext without rewriting it", () => {
    const sql = migrationSql("connector_oauth_hardening");
    expect(sql).toContain("refresh_token_ciphertext");
    expect(sql).toContain("refresh_token_iv");
    expect(sql).toContain("token_key_version");
    expect(sql).toContain("token_account_ref");
    expect(sql).toContain("status = 'reconnect_required'");
    expect(sql).not.toContain("set refresh_token =");
  });
});

describe("forward-only connector plaintext retirement migration contract", () => {
  test("quarantines remaining legacy rows and keeps plaintext available only for the guarded converter", () => {
    const sql = migrationSql("connector_plaintext_retirement");
    const quarantineAt = sql.indexOf("status = 'reconnect_required'");
    expect(quarantineAt).toBeGreaterThan(-1);
    expect(sql).toContain("legacy_plaintext_reconnect_required");
    expect(sql).toContain("connector_accounts_plaintext_quarantined_check");
    expect(sql).not.toContain("set refresh_token = null");
    expect(sql).not.toContain("drop column if exists refresh_token");
    expect(sql).toContain("revoke all on table public.connector_accounts from public, anon, authenticated");
    expect(sql).toContain("grant select, insert, update, delete on table public.connector_accounts to service_role");
  });
});

describe("connector plaintext invariant migration contract", () => {
  test("fails closed if conversion is incomplete before removing the legacy column", () => {
    const sql = migrationSql("connector_plaintext_invariant");
    const guardAt = sql.indexOf("legacy_connector_plaintext_remaining");
    const dropAt = sql.indexOf("drop column if exists refresh_token");
    expect(guardAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(guardAt);
    expect(sql).toContain("if exists ( select 1 from public.connector_accounts where refresh_token is not null )");
    expect(sql).toContain("revoke all on table public.connector_accounts from public, anon, authenticated");
    expect(sql).toContain("grant select, insert, update, delete on table public.connector_accounts to service_role");
  });

  test("removes the plaintext-dependent active constraint before the column and recreates an encrypted-only invariant", () => {
    const sql = migrationSql("connector_plaintext_invariant");
    const constraintDropAt = sql.indexOf("drop constraint if exists connector_accounts_active_encrypted_check");
    const columnDropAt = sql.indexOf("drop column if exists refresh_token");
    const constraintAddAt = sql.indexOf("add constraint connector_accounts_active_encrypted_check");
    expect(constraintDropAt).toBeGreaterThan(-1);
    expect(columnDropAt).toBeGreaterThan(constraintDropAt);
    expect(constraintAddAt).toBeGreaterThan(columnDropAt);
    expect(sql.slice(constraintAddAt)).not.toContain("refresh_token is null");
    expect(sql.slice(constraintAddAt)).toContain("refresh_token_ciphertext is not null");
  });
});

describe("communication contact hash cutover migration contract", () => {
  test("marks legacy SHA rows and defaults new rows to versioned HMAC metadata", () => {
    const sql = migrationSql("communication_hash_cutover");
    expect(sql).toContain("add column if not exists hash_algorithm text");
    expect(sql).toContain("add column if not exists hash_key_version integer");
    expect(sql).toContain("set hash_algorithm = 'sha256', hash_key_version = null");
    expect(sql).toContain("alter column hash_algorithm set default 'hmac-sha256'");
    expect(sql).toContain("alter column hash_key_version set default 1");
    expect(sql).not.toContain("update public.contact_opt_outs set contact_hash");
    expect(sql).not.toContain("update public.communications set contact_hash");
  });
});

describe("tenant-scoped connector status migration contract", () => {
  test("requires one tenant and verifies the current user owns that exact tenant", () => {
    const sql = migrationSql("connector_status_tenant_scope");
    expect(sql).toContain("function public.get_connector_status(p_tenant uuid)");
    expect(sql).toContain("t.id = p_tenant and t.owner_user_id = v_user");
    expect(sql).toContain("where ca.tenant_id = p_tenant");
    expect(sql).toContain("revoke all on function public.get_connector_status(uuid) from public, anon");
    expect(sql).toContain("grant execute on function public.get_connector_status(uuid) to authenticated");
    expect(sql).toContain("drop function if exists public.get_connector_status()");
  });
});

describe("learning retention skip migration contract", () => {
  test("backfills pending free-form learning to a fixed retention-eligible skipped state", () => {
    const sql = migrationSql("learning_retention_skip");
    expect(sql).toContain("add column if not exists learning_skip_reason text");
    expect(sql).toContain("set learning_status = 'skipped'");
    expect(sql).toContain("learning_skip_reason = 'freeform_model_learning_disabled'");
    expect(sql).toContain("where learning_status = 'pending'");
    expect(sql).not.toContain("delete from public.calls");
  });
});

describe("contact hash requirements aggregate RPC contract", () => {
  test("returns one bounded aggregate for one tenant and is service-role-only", () => {
    const sql = migrationSql("contact_hash_requirements_rpc");
    expect(sql).toContain("function public.get_contact_hash_requirements(p_tenant uuid)");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("from public.contact_opt_outs");
    expect(sql).toContain("from public.communications");
    expect(sql).toContain("group by hash_algorithm, hash_key_version");
    expect(sql).toContain("too_many_contact_hash_versions");
    expect(sql).toContain("revoke all on function public.get_contact_hash_requirements(uuid) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.get_contact_hash_requirements(uuid) to service_role");
  });
});

describe("privacy retention migration contract", () => {
  test("service-role retention removes raw transcripts and transient transport rows only", () => {
    const sql = migrationSql("privacy_retention");
    expect(sql).toContain("function public.purge_ephemeral_call_data(timestamptz,timestamptz)");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("set transcript = '[]'::jsonb");
    expect(sql).toContain("delete from public.browser_session_requests");
    expect(sql).toContain("delete from public.phone_events");
    expect(sql).not.toContain("delete from public.receipts");
    expect(sql).not.toContain("delete from public.rules");
    expect(sql).not.toContain("delete from public.audit_log");
    expect(sql).toContain("revoke all on function public.purge_ephemeral_call_data(timestamptz,timestamptz) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.purge_ephemeral_call_data(timestamptz,timestamptz) to service_role");
  });
});

describe("expired transient retention migration contract", () => {
  test("forward retention deletes expired OAuth states, slot offers, and unreferenced quotes", () => {
    const sql = migrationSql("expired_transient_retention");
    expect(sql).toContain("function public.purge_ephemeral_call_data(");
    expect(sql).toContain("delete from public.oauth_states");
    expect(sql).toContain("delete from public.slot_offers");
    expect(sql).toContain("delete from public.booking_quotes");
    expect(sql.indexOf("delete from public.slot_offers")).toBeLessThan(sql.indexOf("delete from public.booking_quotes"));
    expect(sql).toContain("expires_at < p_transient_before");
    expect(sql).toContain("not exists (select 1 from public.slot_offers");
    expect(sql).not.toContain("delete from public.receipts");
  });
});

describe("tenant owner provisioning migration contract", () => {
  test("only the service role can invoke the atomic owner binding RPC", () => {
    const sql = migrationSql("tenant_owner_provisioning");

    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("auth.role() <> 'service_role'");
    expect(sql).toContain("for update");
    expect(sql).toContain("revoke all on function public.provision_tenant_owner(uuid,uuid) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.provision_tenant_owner(uuid,uuid) to service_role");
  });
});

describe("effective authority migration contract", () => {
  test("projects only the deterministic latest approved version per tenant rule group", () => {
    const sql = migrationSql("effective_authority_epochs");

    expect(sql).toContain("with (security_invoker = true)");
    expect(sql).toContain("partition by r.tenant_id, r.rule_group_id order by r.version desc, r.created_at desc, r.id desc");
    expect(sql).toContain("where ranked.version_rank = 1 and ranked.status = 'aprovado'");
  });

  test("rule and power changes bump separate epochs and normalize seeded hours", () => {
    const sql = migrationSql("effective_authority_epochs");

    expect(sql).toContain("set policy_epoch = t.policy_epoch + 1");
    expect(sql).toContain("set auth_epoch = t.auth_epoch + 1");
    expect(sql).toContain("after insert on public.rules");
    expect(sql).toContain("after insert or update or delete on public.powers");
    expect(sql).toContain("jsonb_build_object('days', jsonb_build_array('mon','tue','wed','thu','fri','sat'), 'start', '08:00', 'end', '18:00')");
  });
});

describe("effective policy epoch event migration contract", () => {
  test("suggested and rejected versions are non-effective while approved/revoked changes bump once", () => {
    const sql = migrationSql("effective_policy_epoch_events");
    expect(sql).toContain("where r.status in ('aprovado','revogado')");
    expect(sql).toContain("where ranked.version_rank = 1 and ranked.status = 'aprovado'");
    expect(sql).toContain("if new.status in ('aprovado','revogado') then");
    expect(sql).toContain("drop trigger if exists rules_policy_epoch on public.rules");
    expect(sql).toContain("after insert on public.rules");
    expect(sql).not.toContain("if new.status = 'sugerido'");
  });
});

describe("budget reservation settlement migration contract", () => {
  test("serializes cap reservations on the tenant row and uses the tenant-local day", () => {
    const sql = migrationSql("budget_reservation_settlement");

    expect(sql).toContain("from public.tenants t where t.id = p_tenant for update");
    expect(sql).toContain("(v_now at time zone v_timezone)::date");
    expect(sql).toContain("case when br.status = 'active' then br.reserved_cost_usd else br.final_cost_usd end");
    expect(sql).toContain("unique (call_id)");
  });

  test("settles one reservation into one release and one usage charge idempotently", () => {
    const sql = migrationSql("budget_reservation_settlement");

    expect(sql).toContain("if v_reservation.status = 'settled' then return v_reservation.id");
    expect(sql).toContain("values (p_tenant, p_call, 'adjustment', -v_reservation.reserved_cost_usd");
    expect(sql).toContain("values (p_tenant, p_call, 'usage', p_minutes, p_actual_cost");
    expect(sql).toContain("create unique index usage_ledger_budget_event_unique");
    expect(sql).toContain("p_outcome not in ('ended','startup_error','killed_deadline','killed_budget','error')");
  });

  test("backfills legacy holds so migration does not reset or double-count the current day", () => {
    const sql = migrationSql("budget_reservation_settlement");

    expect(sql).toContain("with legacy_budget as");
    expect(sql).toContain("from public.usage_ledger l join public.calls c");
    expect(sql).toContain("sum(l.cost_usd) filter (where l.kind = 'reservation')");
    expect(sql).toContain("jsonb_build_object('at','legacy_reservation_release')");
    expect(sql.indexOf("with legacy_budget as")).toBeLessThan(sql.indexOf("create unique index usage_ledger_budget_event_unique"));
  });

  test("budget RPCs are service-role-only", () => {
    const sql = migrationSql("budget_reservation_settlement");

    for (const signature of [
      "public.reserve_call_budget(uuid,uuid,numeric)",
      "public.settle_call_budget(uuid,uuid,numeric,numeric,text,jsonb)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("session settlement ceiling migration contract", () => {
  test("actual settlement cannot exceed the amount reserved for that session", () => {
    const sql = migrationSql("session_settlement_ceiling");
    expect(sql).toContain("p_actual_cost > v_reservation.reserved_cost_usd");
    expect(sql).toContain("settlement_exceeds_reservation");
    expect(sql).toContain("function public.settle_call_budget(");
    expect(sql).toContain("grant execute on function public.settle_call_budget(uuid,uuid,numeric,numeric,text,jsonb) to service_role");
  });
});

describe("provider termination reconciliation migration contract", () => {
  test("claims terminal provider work independently of budget reservations", () => {
    const sql = migrationSql("provider_termination_reconciliation");
    expect(sql).toContain("function public.claim_provider_termination_reconciliation(p_worker text)");
    expect(sql).toContain("from public.calls c");
    expect(sql).not.toContain("join public.budget_reservations");
    expect(sql).toContain("provider_termination_state in ('active','pending','unknown')");
    expect(sql).toContain("for update of c skip locked");
    expect(sql).toContain("revoke all on function public.claim_provider_termination_reconciliation(text) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.claim_provider_termination_reconciliation(text) to service_role");
  });
});

describe("provider termination claim ordering repair migration contract", () => {
  test("replaces the claim with the real calls timestamp column", () => {
    const sql = migrationSql("provider_termination_claim_order");
    expect(sql).toContain("function public.claim_provider_termination_reconciliation(p_worker text)");
    expect(sql).toContain("order by c.started_at, c.id");
    expect(sql).not.toContain("c.created_at");
  });
});

describe("durable phone lifecycle migration contract", () => {
  test("models ownership, every provider boundary, and fail-closed call identity", () => {
    const sql = migrationSql("durable_phone_lifecycle");
    for (const column of [
      "lifecycle_state text", "lifecycle_owner text", "lifecycle_claim_token uuid",
      "provider_accept_state text", "provider_termination_state text", "provider_termination_mode text",
      "sideband_state text", "lifecycle_last_error text", "phone_event_id uuid",
    ]) expect(sql).toContain(column);
    expect(sql).toContain("'call_persisted','budget_reserved','accepting','accepted','sideband_attaching','active'");
    expect(sql).toContain("'rejected','terminated','reconciliation_required'");
    expect(sql).toContain("duplicate_openai_call_id_before_phone_lifecycle");
    expect(sql).toContain("phone_call_tenant_mismatch_before_phone_lifecycle");
    expect(sql).toContain("p.tenant_id is not null and c.tenant_id is distinct from p.tenant_id");
    expect(sql.indexOf("duplicate_openai_call_id_before_phone_lifecycle")).toBeLessThan(sql.indexOf("create unique index calls_openai_call_id_unique"));
    expect(sql).toContain("phone_event_id uuid references public.phone_events (id) on delete set null");
    expect(sql).not.toContain("delete from public.calls");
    const retentionAt = sql.indexOf("function public.purge_ephemeral_call_data");
    expect(sql.slice(0, retentionAt)).not.toContain("delete from public.phone_events");
  });

  test("claims atomically, compares the owner token, and reconciles events without calls rows", () => {
    const sql = migrationSql("durable_phone_lifecycle");
    expect(sql).toContain("function public.claim_phone_event(p_event_id uuid, p_worker text)");
    expect(sql).toContain("'openai_call_id', v_event.openai_call_id");
    expect(sql).toContain("for update of p skip locked");
    expect(sql).toContain("v_claim uuid := gen_random_uuid()");
    expect(sql).toContain("v_event.lifecycle_claim_token is distinct from p_claim_token");
    expect(sql).toContain("function public.claim_phone_lifecycle_reconciliation(p_worker text)");
    const reconcileAt = sql.indexOf("function public.claim_phone_lifecycle_reconciliation");
    const reconcileEnd = sql.indexOf("revoke all on function public.claim_phone_lifecycle_reconciliation", reconcileAt);
    const reconcileSql = sql.slice(reconcileAt, reconcileEnd);
    expect(reconcileSql).toContain("from public.phone_events p");
    expect(reconcileSql).toContain("for update of p skip locked");
    expect(reconcileSql).not.toContain("from public.phone_events p join public.calls");
    expect(reconcileSql).toContain("openai_call_id");
    expect(reconcileSql).toContain("provider_termination_mode");
    expect(sql).toContain("p_mode is null or p_mode not in ('reject','hangup')");
  });

  test("all lifecycle RPCs are service-role-only with an empty search path", () => {
    const sql = migrationSql("durable_phone_lifecycle");
    const signatures = [
      "public.claim_phone_event(uuid,text)",
      "public.persist_phone_call(uuid,uuid,uuid,text)",
      "public.reserve_phone_call_budget(uuid,uuid,numeric)",
      "public.begin_phone_provider_accept(uuid,uuid)",
      "public.confirm_phone_provider_accept(uuid,uuid)",
      "public.begin_phone_sideband(uuid,uuid)",
      "public.confirm_phone_sideband(uuid,uuid)",
      "public.begin_phone_termination(uuid,uuid,text,text,text)",
      "public.complete_phone_termination(uuid,uuid,boolean,text)",
      "public.claim_phone_lifecycle_reconciliation(text)",
      "public.claim_provider_termination_reconciliation(text)",
      "public.claim_budget_reconciliation(text)",
      "public.purge_ephemeral_call_data(timestamptz,timestamptz)",
    ];
    expect(sql.match(/security definer set search_path = ''/g)?.length).toBe(signatures.length);
    expect(sql.match(/service_role_required/g)?.length).toBe(signatures.length);
    for (const signature of signatures) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });

  test("retention purges only lifecycle-safe terminal phone events", () => {
    const sql = migrationSql("durable_phone_lifecycle");
    expect(sql).toContain("function public.purge_ephemeral_call_data(");
    expect(sql).toContain("p.status in ('accepted', 'rejected', 'error')");
    expect(sql).toContain("p.lifecycle_state in ('active', 'rejected', 'terminated')");
    expect(sql).toContain("c.status <> 'active'");
    expect(sql).toContain("c.provider_termination_state in ('confirmed','not_required')");
    expect(sql).not.toContain("p.lifecycle_state in ('reconciliation_required'");
  });

  test("existing budget and provider reconcilers cannot race the phone lifecycle owner", () => {
    const sql = migrationSql("durable_phone_lifecycle");
    expect(sql).toContain("function public.claim_provider_termination_reconciliation(p_worker text)");
    expect(sql).toContain("c.phone_event_id is null");
    expect(sql).toContain("function public.claim_budget_reconciliation(p_worker text)");
    expect(sql).toContain("c.phone_event_id is null or c.provider_termination_state in ('confirmed','not_required')");
  });
});

describe("phone sideband recovery migration contract", () => {
  test("adds renewable sideband ownership and at-most-once provider attempt identity", () => {
    const sql = migrationSql("phone_sideband_recovery");
    for (const column of [
      "sideband_lease_until timestamptz",
      "sideband_heartbeat_at timestamptz",
      "provider_termination_attempt_id uuid",
      "provider_termination_request_id text",
      "provider_termination_attempted_at timestamptz",
    ]) expect(sql).toContain(column);
    expect(sql).toContain("'external_evidence_required'");
    expect(sql).toContain("provider_termination_attempt_id is null");
    expect(sql).toContain("sideband_lease_until <= clock_timestamp()");
    expect(sql).toContain("provider_termination_state in ('pending','unknown')");
    expect(sql).toContain("provider_termination_state = 'external_evidence_required'");
    expect(sql).toContain("where p.lifecycle_state = 'active' and p.sideband_lease_until is null");
  });

  test("phone sideband opens, heartbeats, finalizes, and defers through fenced RPCs", () => {
    const sql = migrationSql("phone_sideband_recovery");
    for (const name of [
      "begin_phone_sideband",
      "confirm_phone_sideband",
      "heartbeat_phone_sideband",
      "finalize_phone_sideband",
      "defer_phone_sideband_finalization",
    ]) expect(sql).toContain(`function public.${name}`);
    expect(sql).toContain("lifecycle_state = 'active'");
    expect(sql).toContain("sideband_heartbeat_at = clock_timestamp()");
    expect(sql).toContain("sideband_lease_until = clock_timestamp() + interval '15 seconds'");
    expect(sql).toContain("lifecycle_state in ('active','sideband_attaching')");
    expect(sql).toContain("lifecycle_state = 'reconciliation_required'");
  });

  test("generic and phone termination attempts are fenced before provider writes", () => {
    const sql = migrationSql("phone_sideband_recovery");
    for (const name of [
      "begin_provider_termination_attempt",
      "complete_provider_termination_attempt",
      "begin_phone_termination",
      "complete_phone_termination",
      "claim_phone_lifecycle_reconciliation",
      "claim_provider_termination_reconciliation",
    ]) expect(sql).toContain(`function public.${name}`);
    expect(sql).toContain("v_attempt uuid := gen_random_uuid()");
    expect(sql).toContain("provider_termination_request_id = v_attempt::text");
    expect(sql).toContain("provider_termination_state = 'pending'");
    expect(sql).toContain("provider_termination_state = case when p_confirmed then 'confirmed' else 'external_evidence_required' end");
  });

  test("legacy orphan repair links unique compatible calls and quarantines unsafe matches", () => {
    const sql = migrationSql("phone_sideband_recovery");
    expect(sql).toContain("create table public.phone_lifecycle_legacy_conflicts");
    expect(sql).toContain("function public.repair_legacy_phone_links()");
    expect(sql).toContain("where p.call_id is null and p.handled_at is not null");
    expect(sql).toContain("c.channel = 'phone' and c.openai_call_id = v_event.openai_call_id");
    expect(sql).toContain("v_match_count = 1");
    expect(sql).toContain("v_call.tenant_id is not distinct from v_event.tenant_id");
    expect(sql).toContain("set call_id = v_call.id, tenant_id = coalesce(p.tenant_id, v_call.tenant_id)");
    expect(sql).toContain("set phone_event_id = v_event.id");
    expect(sql).toContain("set resolved_at = clock_timestamp()");
    expect(sql).toContain("legacy_phone_provider_match_ambiguous");
    expect(sql).not.toContain("delete from public.calls");
    expect(sql.slice(0, sql.indexOf("function public.purge_ephemeral_call_data"))).not.toContain("delete from public.phone_events");
  });

  test("retention preserves an unlinked event whenever any call shares its provider id", () => {
    const sql = migrationSql("phone_sideband_recovery");
    expect(sql).toContain("function public.purge_ephemeral_call_data(");
    expect(sql).toContain("not exists ( select 1 from public.calls orphan where orphan.openai_call_id = p.openai_call_id )");
    expect(sql).not.toContain("p.lifecycle_state in ('external_evidence_required'");
  });

  test("every corrective RPC and conflict table remain service-role-only", () => {
    const sql = migrationSql("phone_sideband_recovery");
    const signatures = [
      "public.begin_provider_termination_attempt(uuid,text,text,text)",
      "public.complete_provider_termination_attempt(uuid,uuid,boolean,text)",
      "public.begin_phone_termination(uuid,uuid,text,text,text)",
      "public.complete_phone_termination(uuid,uuid,boolean,text)",
      "public.begin_phone_sideband(uuid,uuid)",
      "public.confirm_phone_sideband(uuid,uuid)",
      "public.heartbeat_phone_sideband(uuid,uuid)",
      "public.finalize_phone_sideband(uuid,uuid,jsonb)",
      "public.defer_phone_sideband_finalization(uuid,uuid,text)",
      "public.claim_phone_lifecycle_reconciliation(text)",
      "public.claim_provider_termination_reconciliation(text)",
      "public.repair_legacy_phone_links()",
    ];
    for (const signature of signatures) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("auth.role() <> 'service_role'");
    expect(sql).toContain("revoke all on table public.phone_lifecycle_legacy_conflicts from public, anon, authenticated, service_role");
    expect(sql).toContain("grant select, insert, update on table public.phone_lifecycle_legacy_conflicts to service_role");
  });
});

describe("service-role release health migration contract", () => {
  test("returns only exact sanitized tenant state and rejects every browser role", () => {
    const sql = migrationSql("release_health_state");
    expect(sql).toContain("function public.release_health_state(p_tenant uuid, p_slug text)");
    expect(sql).toContain("auth.role() <> 'service_role'");
    expect(sql).toContain("t.id = p_tenant and t.slug = p_slug and t.status = 'active'");
    expect(sql).toContain("jsonb_build_object('ok', true, 'tenant_id', t.id, 'tenant_slug', t.slug, 'status', t.status)");
    expect(sql).toContain("revoke all on function public.release_health_state(uuid,text) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.release_health_state(uuid,text) to service_role");
  });
});

describe("side-effect authority revalidation migration contract", () => {
  test("atomically checks expected epochs plus referenced power/rule before enqueue", () => {
    const sql = migrationSql("authority_side_effect_revalidation");
    expect(sql).toContain("function public.authorize_booking_intent");
    expect(sql).toContain("v_tenant.auth_epoch <> p_expected_auth_epoch or v_tenant.policy_epoch <> p_expected_policy_epoch");
    expect(sql).toContain("from public.powers p");
    expect(sql).toContain("from public.effective_rules er");
    expect(sql).toContain("for update");
  });

  test("claim and immediate execution validation fail stale referenced authority", () => {
    const sql = migrationSql("authority_side_effect_revalidation");
    expect(sql).toContain("authority_stale_before_claim");
    expect(sql).toContain("function public.validate_booking_intent_authority");
    expect(sql).toContain("authority_stale_before_provider");
    expect(sql).toContain("p.revoked_at is null");
  });

  test("replacement RPCs remain service-role-only", () => {
    const sql = migrationSql("authority_side_effect_revalidation");
    for (const signature of [
      "public.authorize_booking_intent(uuid,uuid,uuid,uuid,uuid,numeric,integer,integer,jsonb,text)",
      "public.validate_booking_intent_authority(uuid)",
      "public.claim_intent(text)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("durable provider settlement corrective migration contract", () => {
  test("persists provider termination and leases active terminal reservations for retry", () => {
    const sql = migrationSql("durable_provider_settlement");
    expect(sql).toContain("provider_termination_state");
    expect(sql).toContain("reconcile_lease_until");
    expect(sql).toContain("function public.claim_budget_reconciliation");
    expect(sql).toContain("for update of br skip locked");
  });

  test("error and killed call states win over legacy usage when correcting outcomes", () => {
    const sql = migrationSql("durable_provider_settlement");
    expect(sql).toContain("when c.status = 'error' then 'error'");
    expect(sql).toContain("when c.status = 'killed_deadline' then 'killed_deadline'");
    expect(sql).toContain("when c.status = 'killed_budget' then 'killed_budget'");
  });

  test("replacement reserve function reads the clock only after locking the tenant", () => {
    const sql = migrationSql("durable_provider_settlement");
    const lockAt = sql.indexOf("from public.tenants t where t.id = p_tenant for update");
    const clockAt = sql.indexOf("v_now := clock_timestamp()");
    expect(lockAt).toBeGreaterThan(-1);
    expect(clockAt).toBeGreaterThan(lockAt);
  });

  test("corrective service RPCs remain service-role-only", () => {
    const sql = migrationSql("durable_provider_settlement");
    for (const signature of ["public.claim_budget_reconciliation(text)", "public.reserve_call_budget(uuid,uuid,numeric)"]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("ambiguous provider usage resolution migration contract", () => {
  test("tracks usage separately from confirmed provider termination", () => {
    const sql = migrationSql("ambiguous_provider_usage_resolution");
    expect(sql).toContain("provider_usage_state");
    expect(sql).toContain("'provider_usage_state', v_call.provider_usage_state");
    expect(sql).toContain("'provider_terminated_at', v_call.provider_terminated_at");
  });

  test("replacement reconciliation claim remains service-role-only", () => {
    const sql = migrationSql("ambiguous_provider_usage_resolution");
    expect(sql).toContain("revoke all on function public.claim_budget_reconciliation(text) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.claim_budget_reconciliation(text) to service_role");
  });
});

describe("usage settlement authority corrective migration contract", () => {
  test("backfills ambiguous no-ID calls to unknown and makes unknown the default", () => {
    const sql = migrationSql("usage_settlement_authority");
    expect(sql).toContain("alter column provider_usage_state set default 'unknown'");
    expect(sql).toContain("provider_usage_evidence jsonb");
    expect(sql).toContain("c.openai_call_id is null and c.provider_termination_reason = 'openai_key_missing'");
    expect(sql).toContain("then 'not_applicable' else 'unknown'");
    expect(sql).not.toContain("when c.openai_call_id is null then 'not_applicable'");
  });

  test("settlement locks durable state and rejects every state except resolved or not applicable", () => {
    const sql = migrationSql("usage_settlement_authority");
    const reservationLockAt = sql.indexOf("from public.budget_reservations br");
    const callLockAt = sql.indexOf("from public.calls c");
    const reservationForUpdateAt = sql.indexOf("for update", reservationLockAt);
    const callForUpdateAt = sql.indexOf("for update", callLockAt);
    const usageGateAt = sql.indexOf("coalesce(v_call.provider_usage_state, 'unknown') not in ('resolved','not_applicable')");
    const settledReturnAt = sql.indexOf("if v_reservation.status = 'settled' then return v_reservation.id");
    expect(reservationLockAt).toBeGreaterThan(-1);
    expect(callLockAt).toBeGreaterThan(reservationLockAt);
    expect(reservationForUpdateAt).toBeGreaterThan(reservationLockAt);
    expect(reservationForUpdateAt).toBeLessThan(callLockAt);
    expect(callForUpdateAt).toBeGreaterThan(callLockAt);
    expect(usageGateAt).toBeGreaterThan(callForUpdateAt);
    expect(settledReturnAt).toBeGreaterThan(usageGateAt);
    expect(sql).toContain("provider_usage_unresolved");
  });

  test("the replacement settlement RPC remains service-role-only", () => {
    const sql = migrationSql("usage_settlement_authority");
    const signature = "public.settle_call_budget(uuid,uuid,numeric,numeric,text,jsonb)";
    expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
    expect(sql).toContain(`grant execute on function ${signature} to service_role`);
  });
});

describe("opaque booking offers migration contract", () => {
  test("stores only hashes and atomically consumes an exact scoped current offer", () => {
    const sql = migrationSql("booking_offers");
    expect(sql).toContain("create table public.booking_quotes");
    expect(sql).toContain("create table public.slot_offers");
    expect(sql).toContain("token_hash text not null unique");
    expect(sql).not.toContain("slot_token text");
    expect(sql).toContain("function public.consume_slot_offer");
    expect(sql).toContain("for update");
    expect(sql).toContain("v_offer.tenant_id <> p_tenant or v_offer.call_id <> p_call");
    expect(sql).toContain("v_offer.expires_at <= now()");
    expect(sql).toContain("v_offer.consumed_at is not null");
    expect(sql).toContain("v_tenant.policy_epoch <> v_offer.policy_epoch");
  });

  test("offer consumption is service-role-only", () => {
    const sql = migrationSql("booking_offers");
    const signature = "public.consume_slot_offer(uuid,uuid,text,integer,integer,text,text)";
    expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
    expect(sql).toContain(`grant execute on function ${signature} to service_role`);
  });
});

describe("booking commit lease and reconciliation migration contract", () => {
  test("uses a tenant time-range exclusion and current-authority preparation before provider write", () => {
    const sql = migrationSql("booking_commit_leases");
    expect(sql).toContain("create table public.booking_slot_leases");
    expect(sql).toContain("exclude using gist");
    expect(sql).toContain("tenant_id with =");
    expect(sql).toContain("slot_range with &&");
    expect(sql).toContain("function public.prepare_booking_provider_write");
    expect(sql).toContain("public.validate_booking_intent_authority(p_intent)");
    expect(sql).toContain("exclusion_violation");
  });

  test("unknown claims are marked reconciliation-only and never promoted back to write", () => {
    const sql = migrationSql("booking_commit_leases");
    expect(sql).toContain("execution_mode");
    expect(sql).toContain("when candidate.prior_status = 'unknown' then 'reconcile'");
    expect(sql).toContain("status in ('authorized','queued','unknown')");
  });

  test("repeated exact commitment is constrained to one receipt per intent", () => {
    const sql = migrationSql("booking_commit_leases");
    expect(sql).toContain("create unique index receipts_one_booking_per_intent");
    expect(sql).toContain("on public.receipts (intent_id) where kind = 'booking'");
  });

  test("lease RPCs are service-role-only", () => {
    const sql = migrationSql("booking_commit_leases");
    for (const signature of [
      "public.prepare_booking_provider_write(uuid)",
      "public.release_booking_slot_lease(uuid)",
      "public.commit_booking_slot_lease(uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("private pricing policy guard migration contract", () => {
  test("a slot offer cannot be issued without a private server policy", () => {
    const sql = migrationSql("private_pricing_policy_guard");
    expect(sql).toContain("function public.enforce_slot_offer_private_policy");
    expect(sql).toContain("er.structured ? 'price_min'");
    expect(sql).toContain("new.public_quote >= (er.structured->>'price_min')::numeric");
    expect(sql).toContain("before insert on public.slot_offers");
  });
});

describe("booking delivery authority corrective migration contract", () => {
  test("replaces the flawed receipt index with append-safe attempts and explicit legacy conflict capture", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("drop index if exists public.receipts_one_booking_per_intent");
    expect(sql).toContain("attempt_key text");
    expect(sql).toContain("create unique index receipts_booking_attempt_unique");
    expect(sql).toContain("create table public.booking_receipt_conflicts");
    expect(sql).toContain("array_agg(r.id order by r.created_at, r.id)");
    expect(sql).toContain("create table public.booking_accepted_receipts");
  });

  test("claims carry a unique fence and every reclaimed running intent becomes reconciliation-only", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("claim_token uuid");
    expect(sql).toContain("claim_version bigint");
    expect(sql).toContain("provider_write_started_at timestamptz");
    expect(sql).toContain("candidate.prior_status in ('unknown','running')");
    expect(sql).toContain("claim_token = gen_random_uuid()");
    expect(sql).toContain("ai.status in ('authorized','queued')");
    expect(sql).toContain("ai.provider_write_started_at is null");
  });

  test("only a current fenced begin transition can authorize one provider write", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("function public.begin_provider_write");
    expect(sql).toContain("v_intent.claim_token <> p_claim_token");
    expect(sql).toContain("v_intent.lease_until <= now()");
    expect(sql).toContain("v_intent.provider_write_started_at is not null");
    expect(sql).toContain("provider_write_started_at = now()");
    expect(sql).toContain("execution_mode = 'reconcile'");
    expect(sql).toContain("v_lease.state is distinct from 'held'");
    expect(sql).toContain("v_lease.slot_end is distinct from coalesce(v_booking.slot_end, v_booking.slot_start)");
  });

  test("all pre-write defer/fail/release transitions require the current claim token", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("function public.transition_claimed_intent");
    expect(sql).toContain("v_intent.claim_token is null or p_claim_token is null");
    expect(sql).toContain("v_intent.claim_token is distinct from p_claim_token");
    expect(sql).toContain("v_intent.provider_write_started_at is not null");
    expect(sql).toContain("delete from public.booking_slot_leases l");
    expect(sql).toContain("revoke execute on function public.release_booking_slot_lease(uuid) from service_role");
    expect(sql).toContain("revoke execute on function public.prepare_booking_provider_write(uuid) from service_role");
    expect(sql).toContain("revoke execute on function public.validate_booking_intent_authority(uuid) from service_role");
    const transitionAt = sql.indexOf("function public.transition_claimed_intent");
    const transitionEnd = sql.indexOf("revoke all on function public.transition_claimed_intent", transitionAt);
    const transitionSql = sql.slice(transitionAt, transitionEnd);
    expect(transitionSql.indexOf("update public.action_intents ai set")).toBeLessThan(transitionSql.indexOf("delete from public.booking_slot_leases l"));
  });

  test("provider input and lease are exactly reconstructed from locked booking state", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("function public.booking_provider_input");
    expect(sql).toContain("v_intent.payload <> v_provider_input");
    expect(sql).toContain("v_lease.slot_start is distinct from v_booking.slot_start");
    expect(sql).toContain("v_lease.slot_end is distinct from coalesce(v_booking.slot_end, v_booking.slot_start)");
    expect(sql).toContain("function public.enforce_booking_intent_payload");
  });

  test("accepted receipt, lease, intent, and booking settle atomically with exact proof", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("function public.record_booking_delivery");
    expect(sql).toContain("accepted_receipt_conflict");
    expect(sql).toContain("p_readback->'extendedProperties'->'private'->>'ligouPayloadHash') is distinct from p_payload_hash");
    expect(sql).toContain("insert into public.booking_accepted_receipts");
    expect(sql).toContain("set state = 'committed'");
    expect(sql).toContain("set status = 'succeeded'");
    expect(sql).toContain("status = 'confirmed'");
    expect(sql).toContain("v_existing_map.intent_id is not null and p_outcome <> 'accepted'");
  });

  test("corrective authority RPCs remain service-role-only", () => {
    const sql = migrationSql("booking_delivery_authority");
    for (const signature of [
      "public.prepare_booking_provider_write(uuid,uuid)",
      "public.begin_provider_write(uuid,uuid)",
      "public.get_booking_provider_input(uuid)",
      "public.record_booking_delivery(uuid,text,text,text,jsonb,text,jsonb,jsonb)",
      "public.get_booking_confirmation(uuid,uuid,uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("legacy unknown booking receipt reconciliation contract", () => {
  test("preserves every duplicate receipt while unlinking only noncanonical unknown evidence", () => {
    const sql = migrationSql("legacy_unknown_receipt_reconciliation");
    const beginAt = sql.indexOf("begin;");
    const lockAt = sql.indexOf("lock table public.receipts in access exclusive mode");
    const commitAt = sql.lastIndexOf("commit;");
    expect(beginAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(commitAt).toBeGreaterThan(lockAt);
    expect(sql).toContain("create table if not exists public.legacy_unknown_receipt_quarantine");
    expect(sql).toContain("receipt_id uuid primary key references public.receipts(id)");
    expect(sql).toContain("original_intent_id uuid not null");
    expect(sql).toContain("row_number() over ( partition by r.intent_id order by r.created_at, r.id )");
    expect(sql).toContain("where r.kind = 'booking' and r.outcome = 'unknown'");
    expect(sql).toContain("where ranked.receipt_rank > 1");
    expect(sql).toContain("on conflict (receipt_id) do nothing");
    expect(sql).toContain("disable trigger receipts_append_only");
    expect(sql).toContain("set intent_id = null");
    expect(sql).toContain("r.intent_id = q.original_intent_id");
    expect(sql).toContain("enable trigger receipts_append_only");
    expect(sql).toContain("create trigger legacy_unknown_receipt_quarantine_append_only");
    expect(sql).toContain("lock table public.receipts in access exclusive mode");
    expect(sql).not.toContain("delete from public.receipts");
    expect(sql).not.toContain("delete from public.legacy_unknown_receipt_quarantine");
    expect(sql).toContain("revoke all on table public.legacy_unknown_receipt_quarantine from public, anon, authenticated");
    expect(sql).toContain("grant select, insert on table public.legacy_unknown_receipt_quarantine to service_role");
  });
});

describe("booking provider-write settlement fence migration contract", () => {
  test("accepted delivery requires the current provider-write claim and exact locked input", () => {
    const sql = migrationSql("booking_delivery_fence");
    expect(sql).toContain("p_claim_token uuid");
    expect(sql).toContain("v_intent.provider_write_started_at is null");
    expect(sql).toContain("v_intent.provider_write_claim_token is distinct from p_claim_token");
    expect(sql).toContain("v_intent.claim_token is distinct from p_claim_token");
    expect(sql).toContain("v_intent.provider_write_input is distinct from public.booking_provider_input(p_intent)");
    expect(sql).toContain("revoke all on function public.record_booking_delivery(uuid,text,text,text,jsonb,text,jsonb,jsonb) from public, anon, authenticated, service_role");
    expect(sql).toContain("grant execute on function public.record_booking_delivery(uuid,uuid,text,text,text,jsonb,text,jsonb,jsonb) to service_role");
  });
});

describe("unapplied Task 4 receipt migration boundary contract", () => {
  test("quarantines all legacy accepted history before defining confirmation authority", () => {
    const sql = migrationSql("booking_delivery_authority");
    const quarantineAt = sql.indexOf("legacy_accepted_receipt_unverifiable");
    const confirmationAt = sql.indexOf("function public.get_booking_confirmation");
    const recordAt = sql.indexOf("function public.record_booking_delivery");
    expect(quarantineAt).toBeGreaterThan(-1);
    expect(confirmationAt).toBeGreaterThan(quarantineAt);
    expect(sql.slice(0, recordAt)).not.toContain("insert into public.booking_accepted_receipts");
    expect(sql).not.toContain("booking_id uuid not null unique");
    expect(sql).toContain("not exists (select 1 from public.booking_receipt_conflicts c");
    expect(sql).toContain("receipt_history_quarantined");
    expect(sql).not.toContain("delete from public.receipts");
  });
});

describe("onboarding coverage receipt migration contract", () => {
  test("adds append-only coverage and voice acknowledgement receipts without a parallel state table", () => {
    const sql = migrationSql("onboarding_coverage_receipts");

    expect(sql).toContain("onboarding_coverage");
    expect(sql).toContain("onboarding_voice_approval");
    expect(sql).toContain("receipts_onboarding_event_key_unique");
    expect(sql).toContain("receipts_onboarding_coverage_revision_unique");
    expect(sql).toContain("receipts_onboarding_answer_hash_unique");
    expect(sql).toContain("receipts_onboarding_approval_snapshot_unique");
    expect(sql).toContain("receipts_onboarding_shape_check");
    expect(sql).not.toContain("create table public.onboarding");
  });

  test("records controller coverage atomically through a service-role-only definer RPC", () => {
    const sql = migrationSql("onboarding_coverage_receipts");

    expect(sql).toContain("function public.record_onboarding_answer");
    expect(sql).toContain("p_expected_revision integer");
    expect(sql).toContain("p_coverage jsonb");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("current_setting('request.jwt.claim.role', true)");
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(sql).toContain("'ligou.v0_2.onboarding:' || p_tenant::text || ':' || p_call::text");
    expect(sql).toContain("for update of c, t, br");
    expect(sql.indexOf("pg_advisory_xact_lock(hashtextextended(")).toBeLessThan(sql.indexOf("select br.id into v_request_id"));
    expect(sql).toContain("v_readback := (p_coverage - 'snapshot_digest') || jsonb_build_object(");
    expect(sql).toContain("revoke all on function public.record_onboarding_answer");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.record_onboarding_answer");
    expect(sql).toContain("to service_role");
  });

  test("records voice acknowledgement without changing authority or operational state", () => {
    const sql = migrationSql("onboarding_coverage_receipts");
    const start = sql.indexOf("create or replace function public.record_onboarding_voice_approval");
    const end = sql.indexOf("revoke all on function public.record_onboarding_voice_approval", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const approval = sql.slice(start, end);

    expect(approval).toContain("security definer set search_path = ''");
    expect(approval).toContain("onboarding_voice_approval");
    expect(approval).toContain("for update of c, t, br");
    expect(approval.indexOf("pg_advisory_xact_lock(hashtextextended(")).toBeLessThan(approval.indexOf("select br.id into v_request_id"));
    expect(approval).not.toContain("decide_rule");
    expect(approval).not.toContain("grant_power");
    expect(approval).not.toContain("update public.tenants");
    expect(approval).not.toContain("insert into public.bookings");
    expect(approval).not.toContain("update public.bookings");
    expect(approval).not.toContain("insert into public.action_intents");
    expect(approval).not.toContain("update public.action_intents");
    expect(sql).toContain("revoke all on function public.record_onboarding_voice_approval");
    expect(sql).toContain("grant execute on function public.record_onboarding_voice_approval");
  });

  test("prevents approving a corrected-away suggested rule", () => {
    const sql = migrationSql("onboarding_coverage_receipts");
    expect(sql).toContain("create or replace function public.decide_rule");
    expect(sql).toContain("stale_rule_version");
    expect(sql).toContain("r.rule_group_id = v_rule.rule_group_id");
    expect(sql).toContain("r.version > v_rule.version");
  });
});

describe("service-role onboarding receipt read grant contract", () => {
  test("adds only the SELECT privilege required by the server-side receipt store", () => {
    const sql = migrationSql("service_role_receipts_select");

    expect(sql).toBe("grant select on table public.receipts to service_role;");
    expect(sql).not.toContain("insert");
    expect(sql).not.toContain("update");
    expect(sql).not.toContain("delete");
    expect(sql).not.toContain("anon");
    expect(sql).not.toContain("authenticated");
  });
});
