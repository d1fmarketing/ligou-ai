import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");
const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function localSqlUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("local SQL fixture requires a UUID");
  return `'${value}'::uuid`;
}

async function runDisposableLocalSql(sql: string): Promise<string> {
  if (process.env.LIGOU_LOCAL_DB_TEST !== "1" ||
      process.env.LIGOU_LOCAL_PROJECT_ID !== "ligou-v0-1-rc1" ||
      process.env.PGHOST !== "127.0.0.1" ||
      process.env.PGPORT !== "54322" ||
      process.env.PGDATABASE !== "postgres" ||
      process.env.PGUSER !== "postgres" ||
      !process.env.PGPASSWORD || !process.env.LIGOU_PSQL_BIN) {
    throw new Error("recovery tests require the exact disposable local database");
  }
  const { stdout } = await execFileAsync(process.env.LIGOU_PSQL_BIN, [
    "-X", "--set=ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--quiet",
    "--command", sql,
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C",
      PGAPPNAME: "ligou_discovery_recovery_test",
      PGCONNECT_TIMEOUT: "5",
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGDATABASE: process.env.PGDATABASE,
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
    },
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function migrationSql(): string {
  const names = readdirSync(migrationsDir).filter((name) =>
    name.endsWith("_openclaw_company_discovery_stage0.sql")
  );
  expect(names, "missing openclaw company discovery Stage 0 migration").toHaveLength(1);
  return readFileSync(path.join(migrationsDir, names[0]!), "utf8")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stage0bMigrationSql(): string {
  const names = readdirSync(migrationsDir).filter((name) =>
    name.endsWith("_company_discovery_directmodel_stage0b.sql")
  );
  expect(names, "missing DirectModel company discovery Stage 0B migration").toHaveLength(1);
  return readFileSync(path.join(migrationsDir, names[0]!), "utf8")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function functionBody(sql: string, signature: string, nextMarker: string): string {
  const functionName = signature.slice(0, signature.indexOf("("));
  const start = sql.indexOf(`function public.${functionName}(`);
  const end = sql.indexOf(nextMarker, start);
  expect(start, `${signature} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${signature} must have a bounded definition`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("OpenClaw company discovery Stage 0 database authority", () => {
  test("creates the complete durable job, attempt, evidence, review, and control ledger", () => {
    const sql = migrationSql();
    for (const table of [
      "worker_jobs",
      "worker_attempts",
      "worker_results",
      "worker_runtime_slots",
      "discovery_source_snapshots",
      "discovery_claims",
      "discovery_decisions",
      "business_profile_versions",
      "company_discovery_controls",
      "company_discovery_allowlist",
      "company_discovery_review_nonces",
      "company_discovery_subscription_bindings",
      "company_discovery_subscription_governors",
      "company_discovery_subscription_reservations",
    ]) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`alter table public.${table} force row level security`);
    }
    expect(sql).toContain("'company_discovery.v1'");
    expect(sql).toContain("'openclaw','direct_model'");
    expect(sql).toContain(
      "adapter_id text not null default 'openclaw' check (adapter_id in ('openclaw','direct_model'))",
    );
  });

  test("keeps every owner read tenant-scoped and derives owner mutation identity from auth.uid", () => {
    const sql = migrationSql();
    expect(sql).toContain("owner_user_id = (select auth.uid())");
    for (const signature of [
      "submit_company_discovery(text,text)",
      "company_discovery_owner_status()",
      "cancel_company_discovery(uuid,bigint)",
      "retry_company_discovery(uuid,bigint)",
      "create_company_discovery_review_nonce(uuid,uuid,uuid[])",
      "review_company_discovery_claims(uuid,uuid,bigint,jsonb,text)",
    ]) {
      const body = functionBody(sql, signature, `revoke all on function public.${signature}`);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain("auth.uid()");
      expect(sql).toContain(
        `revoke all on function public.${signature} from public, anon, authenticated, service_role`,
      );
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
    }
    expect(sql).not.toContain("submit_company_discovery(p_tenant");
    expect(sql).not.toContain("review_company_discovery_claims(p_tenant");
  });

  test("returns only the authenticated owner's truthful discovery availability", () => {
    const sql = migrationSql();
    const status = functionBody(
      sql,
      "company_discovery_owner_status()",
      "revoke all on function public.company_discovery_owner_status()",
    );
    expect(status).toContain("auth.uid()");
    expect(status).toContain("company_discovery_owner_tenant_ambiguous");
    expect(status).toContain("'enabled'");
    expect(status).toContain("'allowlisted'");
    expect(status).toContain("'expires_at'");
    expect(status).toContain("'available'");
    expect(status).not.toContain("'allowlist_expires_at'");
    expect(status).not.toContain("'effective_available'");
    expect(status).toContain("v_enabled and v_allowlisted and not v_expired");
    for (const forbidden of [
      "note", "updated_by", "updated_at", "tenant_id", "owner_user_id",
      "invalidation_reason", "quarantine_reason",
    ]) expect(status).not.toContain(`'${forbidden}'`);
    expect(sql).toContain(
      "revoke all on function public.company_discovery_owner_status() from public, anon, authenticated, service_role",
    );
    expect(sql).toContain(
      "grant execute on function public.company_discovery_owner_status() to authenticated",
    );
  });

  test("makes every supervisor mutation service-role-only with an empty search path", () => {
    const sql = migrationSql();
    for (const signature of [
      "claim_company_discovery_attempt(text,text,integer)",
      "bind_company_discovery_runtime(uuid,bigint,text,jsonb)",
      "terminalize_company_discovery_attempt(uuid,bigint,text,text,text)",
      "claim_expired_company_discovery_cleanup(text,integer)",
      "read_company_discovery_model_access(uuid,bigint,text,bigint)",
      "read_company_discovery_subscription_recovery(uuid,bigint,text)",
      "reserve_company_discovery_subscription_request(uuid,bigint,text,bigint,uuid,integer,integer,integer)",
      "settle_company_discovery_subscription_request(uuid,bigint,text,uuid,text,integer,integer,bigint,bigint,boolean,text,integer)",
      "reap_company_discovery_subscription_reservations(integer)",
      "commit_company_discovery_result(uuid,bigint,text,jsonb,text)",
      "select_company_discovery_result(uuid,uuid,bigint)",
      "record_company_discovery_cleanup(uuid,bigint,text,jsonb)",
      "quarantine_company_discovery_slot(uuid,text,text)",
    ]) {
      const body = functionBody(sql, signature, `revoke all on function public.${signature}`);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(sql).toContain(
        `revoke all on function public.${signature} from public, anon, authenticated, service_role`,
      );
      expect(sql).toContain(`grant execute on function public.${signature} to service_role`);
      expect(sql).not.toContain(`grant execute on function public.${signature} to authenticated`);
    }
    expect(sql).toContain(
      "drop function if exists public.claim_company_discovery_attempt(text,integer)",
    );
    expect(sql).not.toContain(
      "grant execute on function public.claim_company_discovery_attempt(text,integer)",
    );
    const modelAccess = functionBody(
      sql,
      "read_company_discovery_model_access(uuid,bigint,text,bigint)",
      "revoke all on function public.read_company_discovery_model_access(uuid,bigint,text,bigint)",
    );
    expect(modelAccess).toContain("company_discovery_subscription_binding_missing");
    expect(modelAccess).toContain("company_discovery_subscription_binding_stale");
    expect(modelAccess).toContain("expected_account_hash");
    expect(modelAccess).toContain("credential_owner_id");
    expect(modelAccess).toContain("credential_generation");
    for (const field of [
      "tenant_id", "job_id", "attempt_id", "fence_generation",
      "runtime_slot_id", "adapter_id", "deadline_at", "expected_account_hash",
      "credential_owner_id", "credential_generation", "provider", "auth_kind", "model",
      "subscription_socket_path", "runtime_identity_hash",
    ]) expect(modelAccess).toContain(field);
    const subscriptionRecovery = functionBody(
      sql,
      "read_company_discovery_subscription_recovery(uuid,bigint,text)",
      "revoke all on function public.read_company_discovery_subscription_recovery(uuid,bigint,text)",
    );
    expect(subscriptionRecovery).toContain("company_discovery_subscription_recovery_not_current");
    for (const field of [
      "job_id", "attempt_id", "fence_generation", "subscription_socket_path",
      "runtime_kind", "late_result_rejected",
    ]) expect(subscriptionRecovery).toContain(`'${field}'`);
    const reserve = functionBody(
      sql,
      "reserve_company_discovery_subscription_request(uuid,bigint,text,bigint,uuid,integer,integer,integer)",
      "revoke all on function public.reserve_company_discovery_subscription_request(uuid,bigint,text,bigint,uuid,integer,integer,integer)",
    );
    expect(reserve).toContain("for update");
    expect(reserve).toContain("v_governor.settled_requests + v_governor.reserved_requests + 1");
    expect(reserve).toContain("v_governor.settled_input_bytes + v_governor.reserved_input_bytes +");
    expect(reserve).toContain("v_governor.settled_output_bytes + v_governor.reserved_output_bytes +");
    expect(reserve).toContain("v_governor.active_requests + 1 > v_governor.max_concurrency");
    expect(reserve).toContain("v_tenant_requests + 1 > 28");
    expect(reserve).toContain("v_tenant_input_bytes + p_input_bytes > 400000");
    expect(reserve).toContain("v_tenant_output_bytes + p_output_bytes > 8388608");
    expect(reserve).toContain("company_discovery_subscription_owner_limit_exceeded");
    expect(reserve).toContain("company_discovery_subscription_tenant_limit_exceeded");
    for (const field of [
      "owner_current_requests", "owner_current_input_bytes",
      "owner_current_output_bytes", "owner_max_requests",
      "owner_max_input_bytes", "owner_max_output_bytes",
    ]) expect(reserve).toContain(`'${field}'`);
    expect(reserve).toContain("company_discovery_subscription_quota_unknown");
    expect(reserve).toContain("company_discovery_subscription_cooldown");
    expect(reserve).toContain("p_credential_generation is null");
    const settle = functionBody(
      sql,
      "settle_company_discovery_subscription_request(uuid,bigint,text,uuid,text,integer,integer,bigint,bigint,boolean,text,integer)",
      "revoke all on function public.settle_company_discovery_subscription_request(uuid,bigint,text,uuid,text,integer,integer,bigint,bigint,boolean,text,integer)",
    );
    expect(settle).toContain("p_quota_state not in ('available', 'cooldown', 'unknown')");
    expect(settle).toContain("p_usage_complete is null or p_quota_state is null");
    expect(settle).toContain("length(p_reservation_token) <> 64");
    expect(settle).toContain("p_retry_after_seconds not between 1 and 3600");
    expect(settle).toContain("company_discovery_subscription_settlement_invalid");
    expect(settle).toContain("company_discovery_subscription_settlement_conflict");
    expect(settle).toContain("company_discovery_subscription_governor_inconsistent");
    expect(settle).not.toContain("greatest(reserved_requests - 1, 0)");
    expect(settle).toContain("if v_reservation.state = 'settled' then");
    const reap = functionBody(
      sql,
      "reap_company_discovery_subscription_reservations(integer)",
      "revoke all on function public.reap_company_discovery_subscription_reservations(integer)",
    );
    expect(reap).toContain("for update skip locked");
    expect(reap).toContain("p_limit is null or p_limit not between 1 and 1000");
    expect(reap).toContain("quota_state = 'unknown'");
    expect(reap).toContain("prospective_input_bytes");
    expect(reap).toContain("company_discovery_subscription_governor_inconsistent");
    expect(sql).toContain("max_requests integer not null default 140 check (max_requests = 140)");
    expect(sql).toContain("max_input_bytes bigint not null default 2000000 check (max_input_bytes = 2000000)");
    expect(sql).toContain("max_output_bytes bigint not null default 40000000 check (max_output_bytes = 40000000)");
  });

  test("claims an exact adapter-bound slot and returns complete post-claim authority", () => {
    const sql = migrationSql();
    const claim = functionBody(
      sql,
      "claim_company_discovery_attempt(text,text,integer)",
      "revoke all on function public.claim_company_discovery_attempt(text,text,integer)",
    );
    expect(claim).toContain("p_adapter_id text");
    expect(claim).toContain("p_adapter_id not in ('openclaw', 'direct_model')");
    expect(claim).toContain("v_slot_name := btrim(p_worker_id) || ':' || p_adapter_id");
    expect(claim).toContain("where s.slot_name = v_slot_name");
    expect(claim).toContain("s.adapter_id = p_adapter_id");
    expect(claim).toContain("adapter_id text");
    expect(claim).toContain("runtime_slot_id uuid");
    expect(claim).toContain("job_version bigint");
    for (const field of [
      "job_id", "attempt_id", "attempt_number", "adapter_id",
      "fence_generation", "claim_token", "runtime_slot_id", "job_version",
      "normalized_origin", "deadline_at", "budget",
      "tenant_id", "credential_owner_id", "credential_generation",
      "subscription_account_hash",
    ]) expect(claim).toContain(field);
    expect(claim).toContain("v_job.version + 1");
  });

  test("binds one exact bounded nonsecret runtime identity before launch", () => {
    const sql = migrationSql();
    const bind = functionBody(
      sql,
      "bind_company_discovery_runtime(uuid,bigint,text,jsonb)",
      "revoke all on function public.bind_company_discovery_runtime(uuid,bigint,text,jsonb)",
    );
    expect(sql).toContain("runtime_identity_hash text");
    expect(bind).toContain("company_discovery_runtime_already_bound");
    expect(bind).toContain("company_discovery_runtime_identity_invalid");
    expect(bind).toContain("p_runtime_identity->>'runtime_kind' <> 'openclaw_cell'");
    expect(bind).toContain("p_runtime_identity->>'runtime_kind' <> 'direct_model_subscription'");
    expect(bind).toContain("v_attempt.adapter_id = 'openclaw'");
    expect(bind).toContain("v_attempt.adapter_id = 'direct_model'");
    expect(bind).toContain("octet_length(p_runtime_identity::text) > 4096");
    expect(bind).toContain("v_job.current_attempt_id is distinct from v_attempt.id");
    expect(bind).toContain("v_attempt.lease_until <= clock_timestamp()");
    expect(bind).toContain("extensions.digest(convert_to(p_runtime_identity::text, 'utf8'), 'sha256'");
    for (const field of [
      "cell_container_name", "bridge_container_name", "internal_network_name",
      "egress_network_name", "config_volume_name", "state_volume_name",
      "workspace_volume_name", "output_volume_name", "gateway_secret_volume_name",
      "bridge_secret_volume_name", "profile_name", "loopback_port",
      "cell_image", "bridge_image", "reference", "index_digest", "platform",
      "selected_manifest_digest", "image_id", "config_digest",
      "subscription_socket_path",
      "runtime_kind",
    ]) expect(bind).toContain(`'${field}'`);
    expect(bind).toContain(
      "ghcr.io/openclaw/openclaw@sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4",
    );
    expect(bind).toContain("in ('linux/arm64', 'linux/amd64')");
    expect(bind).toContain("split_part(v_image->>'reference', '@', 2)");
    expect(bind).toContain("v_image->>'index_digest'");
    expect(bind).toContain("'index_digest', 'selected_manifest_digest', 'image_id', 'config_digest'");
    expect(bind).toContain("^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$");
    expect(bind).not.toContain(
      "v_image->>'index_digest' is distinct from\n           v_image->>'selected_manifest_digest'",
    );
    expect(bind).not.toContain("^ligou-discovery-bridge@sha256:");
    expect(bind).toContain(
      "^/run/ligou-discovery/[0-9a-f]{48}/subscription[.]sock$",
    );
    expect(bind).toContain(
      "'socket', 'socket_identifier', p_runtime_identity->>'subscription_socket_path'",
    );
    expect(bind).not.toContain("'127.0.0.1:' || (p_runtime_identity->>'loopback_port')");
    expect(bind).toContain(
      "not (p_runtime_identity ?& array[ 'runtime_kind', 'subscription_socket_path' ])",
    );
    expect(bind).toContain(
      "(p_runtime_identity - array[ 'runtime_kind', 'subscription_socket_path' ]::text[]) <> '{}'::jsonb",
    );
    expect(bind).not.toContain("jsonb_object_length");
    for (const forbidden of [
      "tenant_id", "job_id", "claim_token", "gateway_token", "bridge_token",
      "credential", "api_key", "config_path", "state_path", "workspace_path",
      "output_path",
    ]) expect(bind).toContain(`'${forbidden}'`);
    expect(bind).toContain("'runtime_identity', p_runtime_identity");
    expect(bind).toContain("'runtime_identity_hash', v_runtime_hash");
  });

  test("terminalizes with rotated cleanup authority and permanently fences late work", () => {
    const sql = migrationSql();
    const terminalize = functionBody(
      sql,
      "terminalize_company_discovery_attempt(uuid,bigint,text,text,text)",
      "revoke all on function public.terminalize_company_discovery_attempt(uuid,bigint,text,text,text)",
    );
    expect(terminalize).toContain("p_outcome not in ('failed', 'cancelled')");
    expect(terminalize).toContain("company_discovery_terminal_reason_invalid");
    expect(terminalize).toContain("v_attempt.status <> 'running'");
    expect(terminalize).toContain("v_job.current_attempt_id is distinct from v_attempt.id");
    expect(terminalize).toContain("v_attempt.lease_until <= clock_timestamp()");
    expect(terminalize).toContain("fence_generation = v_new_fence");
    expect(terminalize).toContain("claim_token_hash = extensions.digest(v_cleanup_token, 'sha256')");
    expect(terminalize).toContain("selected_attempt_id = null");
    expect(terminalize).toContain("invalidated_at = clock_timestamp()");
    expect(terminalize).not.toContain("set status = 'available'");
    for (const field of [
      "job_id", "attempt_id", "runtime_slot_id", "job_version",
      "fence_generation", "claim_token", "status", "cleanup_state",
    ]) expect(terminalize).toContain(`'${field}'`);
  });

  test("reclaims expired bound and terminal cleanup with rotated authority and exact quarantine", () => {
    const sql = migrationSql();
    const expired = functionBody(
      sql,
      "claim_expired_company_discovery_cleanup(text,integer)",
      "revoke all on function public.claim_expired_company_discovery_cleanup(text,integer)",
    );
    expect(expired).toContain("for update of a skip locked");
    expect(expired).toContain("a.lease_until <= clock_timestamp()");
    expect(expired).toContain("s.supervisor_worker_id = btrim(p_worker_id)");
    expect(expired).toContain("v_runtime_bound := v_attempt.runtime_identity <> '{}'::jsonb");
    expect(expired).toContain(
      "v_attempt.status in ('validated', 'selected', 'failed', 'cancelled', 'superseded')",
    );
    expect(expired).toContain("status = case when status = 'running' then 'failed' else status end");
    expect(expired).toContain("fence_generation = v_new_fence");
    expect(expired).toContain("claim_token_hash = extensions.digest(v_cleanup_token, 'sha256')");
    expect(expired).toContain("quarantine_reason = 'expired_lease_cleanup'");
    expect(expired).toContain("current_attempt_id = v_attempt.id");
    expect(expired).toContain("recovery_outcome text");
    expect(expired).toContain("'runtime_not_bound'::text");
    expect(expired).toContain("'cleanup_claimed'::text");
    for (const field of [
      "job_id", "attempt_id", "adapter_id", "runtime_slot_id",
      "runtime_identity", "fence_generation", "claim_token", "job_version",
      "recovery_outcome",
    ]) expect(expired).toContain(field);
    expect(expired).toContain("if v_attempt.id is null then return; end if");
    expect(expired).toContain("null::text");
    const quarantine = functionBody(
      sql,
      "quarantine_company_discovery_slot(uuid,text,text)",
      "revoke all on function public.quarantine_company_discovery_slot(uuid,text,text)",
    );
    expect(quarantine).toContain("p_proof_hash is null");
    const cleanup = functionBody(
      sql,
      "record_company_discovery_cleanup(uuid,bigint,text,jsonb)",
      "revoke all on function public.record_company_discovery_cleanup(uuid,bigint,text,jsonb)",
    );
    expect(sql).toContain("released_at timestamp with time zone");
    expect(sql).toContain(
      "where resource_kind not in ('loopback_port', 'socket_identifier')",
    );
    expect(sql).toContain(
      "where resource_kind in ('loopback_port', 'socket_identifier') and released_at is null",
    );
    expect(sql).toContain("company_discovery_runtime_resource_release_invalid");
    expect(cleanup).toContain("p_proof->'listener_closed' = 'true'::jsonb");
    expect(cleanup).toContain("p_proof->'identity_process_absent' = 'true'::jsonb");
    for (const field of [
      "credential_material_removed", "subscription_lease_revoked",
      "subscription_requests_drained", "subscription_listener_closed",
      "subscription_socket_absent",
    ]) expect(cleanup).toContain(`p_proof->'${field}' = 'true'::jsonb`);
    expect(cleanup).not.toContain("credential_revoked");
    expect(cleanup).toContain("set released_at = clock_timestamp()");
    expect(cleanup).toContain("resource_kind = 'socket_identifier'");
    expect(cleanup).toContain("resource_kind = 'loopback_port'");
    expect(cleanup).toContain("v_expected_releases := case when v_attempt.adapter_id = 'openclaw' then 2 else 1 end");
    expect(cleanup).toContain("company_discovery_cleanup_proof_kind_invalid");
    expect(sql).not.toContain(
      "grant update on table public.worker_runtime_resource_reservations",
    );
    expect(sql).not.toContain(
      "grant delete on table public.worker_runtime_resource_reservations",
    );
  });

  test("keeps direct service relation grants least-privilege", () => {
    const sql = migrationSql();
    expect(sql).not.toContain("grant select, insert, update, delete on table");
    expect(sql).toContain(
      "grant insert, update on table public.company_discovery_controls, public.company_discovery_allowlist to service_role",
    );
    expect(sql).not.toContain("to service_role with grant option");
    expect(sql).toContain(
      "grant insert on table public.worker_runtime_slots to service_role",
    );
    expect(sql).toContain(
      "grant select, insert, update on table public.company_discovery_subscription_bindings to service_role",
    );
    expect(sql).not.toContain(
      "grant select on table public.company_discovery_subscription_bindings to authenticated",
    );
    expect(sql).toContain("provider text not null default 'openai-codex'");
    expect(sql).toContain("auth_kind text not null default 'chatgpt_subscription_oauth'");
    expect(sql).toContain("model text not null default 'gpt-5.6-sol'");
    expect(sql).toContain("expected_account_hash text not null");
    expect(sql).toContain("credential_owner_id uuid not null");
    expect(sql).toContain("credential_generation bigint not null");
    expect(sql).toContain("company_discovery_subscription_owner_account_mismatch");
    expect(sql).not.toMatch(/(?<!extensions[.])digest\(/);
    expect(sql).not.toMatch(/(?<!extensions[.])gen_random_bytes\(/);
  });

  test("enforces idempotency, immutable normalized origin, retries, and exact current fencing proof", () => {
    const sql = migrationSql();
    expect(sql).toContain("unique (tenant_id, idempotency_key)");
    expect(sql).toContain("company_discovery_idempotency_conflict");
    expect(sql).toContain("normalized_origin");
    expect(sql).toContain("origin_host text not null");
    expect(sql).toContain("registrable_domain text");
    expect(sql).not.toContain("registrable_domain text not null");
    const submit = functionBody(
      sql,
      "submit_company_discovery(text,text)",
      "revoke all on function public.submit_company_discovery(text,text)",
    );
    expect(submit).toContain("origin_host, registrable_domain");
    expect(submit).toContain("v_host, null");
    expect(sql).toContain("request_hash");
    expect(sql).toContain("attempt_number");
    expect(sql).toContain("unique (job_id, attempt_number)");
    expect(sql).toContain("fence_generation = fence_generation + 1");
    expect(sql).toContain("company_discovery_stale_fence");
    expect(sql).toContain("claim_token_hash");
    expect(sql).toContain("digest(p_claim_token, 'sha256')");
    expect(sql).toContain("v_job.current_attempt_id is distinct from v_attempt.id");
    expect(sql).toContain("v_attempt.fence_generation is distinct from p_fence_generation");
    expect(sql).toContain("p_adapter_id");
  });

  test("keeps cancelled slots unavailable until attempt-bound terminal cleanup", () => {
    const sql = migrationSql();
    const cancel = functionBody(
      sql,
      "cancel_company_discovery(uuid,bigint)",
      "revoke all on function public.cancel_company_discovery(uuid,bigint)",
    );
    const cleanup = functionBody(
      sql,
      "record_company_discovery_cleanup(uuid,bigint,text,jsonb)",
      "revoke all on function public.record_company_discovery_cleanup(uuid,bigint,text,jsonb)",
    );
    expect(cancel).not.toContain("set status = 'available'");
    expect(cancel).toContain("selected_attempt_id = null");
    expect(cancel).toContain("invalidated_at = clock_timestamp()");
    expect(cancel).toContain("then 'superseded'");
    expect(cleanup).toContain(
      "v_attempt.status not in ('validated', 'selected', 'cancelled', 'failed', 'superseded')",
    );
    expect(cleanup).toContain("current_attempt_id = v_attempt.id");
    expect(cleanup).toContain("slot_updated");
    expect(cleanup).toContain("bridge_removed");
    expect(cleanup).toContain("config_removed");
    expect(cleanup).toContain("identity_process_absent");
    expect(cleanup).toContain("company_discovery_cleanup_proof_invalid");
  });

  test("keeps controls default-off and requires an active owner allowlist row", () => {
    const sql = migrationSql();
    expect(sql).toContain("enabled boolean not null default false");
    expect(sql).toContain("company_discovery_disabled");
    expect(sql).toContain("company_discovery_tenant_not_allowlisted");
    expect(sql).toContain("a.expires_at is null or a.expires_at > clock_timestamp()");
  });

  test("makes candidate results and evidence immutable and rejects authority-shaped worker output", () => {
    const sql = migrationSql();
    const commit = functionBody(
      sql,
      "commit_company_discovery_result(uuid,bigint,text,jsonb,text)",
      "revoke all on function public.commit_company_discovery_result(uuid,bigint,text,jsonb,text)",
    );
    for (const table of [
      "worker_results",
      "discovery_source_snapshots",
      "discovery_claims",
      "discovery_decisions",
      "business_profile_versions",
    ]) {
      expect(sql).toContain(`create trigger ${table}_append_only`);
    }
    expect(sql).toContain("company_discovery_result_hash_mismatch");
    expect(commit).toContain("returns jsonb");
    for (const field of [
      "job_id", "attempt_id", "result_id", "job_version", "fence_generation",
    ]) expect(commit).toContain(`'${field}'`);
    expect(sql).toContain("company_discovery_forbidden_result_field");
    expect(sql).toContain("company_discovery_owner_private_fact_forbidden");
    expect(sql).toContain("company_discovery_json_has_forbidden_keys(p_result)");
    for (const field of [
      "tenant_id",
      "canonical_id",
      "policy_group",
      "approval",
      "status",
      "effective",
      "policy_hash",
      "action_completion",
    ]) expect(sql).toContain(`'${field}'`);
    expect(sql).not.toContain("into v_snapshot_ids[");
    expect(sql).toContain("v_snapshot_ids := array_append(v_snapshot_ids, v_snapshot_id)");
    expect(sql).toContain("company_discovery_result_top_level_invalid");
    expect(sql).toContain("company_discovery_result_payload_too_large");
    expect(sql).toContain("octet_length(p_result::text) > 10485760");
    expect(sql).toContain(
      "coalesce(sum((snapshot->>'byte_length')::bigint), 0) > 10485760",
    );
    expect(sql).toContain("company_discovery_json_has_forbidden_keys(p_result)");
    expect(sql).toContain("jsonb_array_length(p_result->'candidate_facts') > 100");
    expect(sql).toContain("octet_length((v_claim->'normalized_value')::text) > 65536");
    expect(sql).toContain("company_discovery_claim_materialization_type_invalid");
    expect(sql).toContain("uncertainty jsonb not null default '[]'::jsonb");
    expect(sql).toContain("check (jsonb_typeof(uncertainty) = 'array')");
    expect(commit).toContain("jsonb_typeof(p_result->'uncertainty') <> 'array'");
    expect(commit).toContain("jsonb_array_length(p_result->'uncertainty') > 50");
    expect(commit).toContain("jsonb_typeof(v_claim->'uncertainty') <> 'array'");
    expect(commit).toContain("jsonb_array_length(v_claim->'uncertainty') > 20");
    expect(commit).toContain("length(item #>> '{}') not between 1 and 1000");
    for (const privateWorkerField of [
      "price_mode",
      "negotiation_mode",
      "price_target",
      "price_min",
      "duration_min",
    ]) expect(commit).not.toContain(`'${privateWorkerField}'`);
    for (const publicWorkerField of [
      "service_type",
      "service_names",
      "public_price",
      "duration_minutes",
    ]) expect(commit).toContain(`'${publicWorkerField}'`);
    expect(commit).toContain(
      "(v_claim->'normalized_value'->'public_price') - array[ 'amount', 'currency', 'qualifier' ]::text[]",
    );
    expect(commit).toContain("public_price' = 'null'::jsonb");
    expect(commit).toContain("duration_minutes' = 'null'::jsonb");
    expect(commit).toContain("'^(0|[1-9][0-9]{0,8})[.][0-9]{2}$'");
    expect(commit).toContain("'^[a-z]{3}$'");
    expect(commit).toContain("in ('exact', 'starting_at')");
  });

  test("allows exactly one selected validated result and rejects late or superseded attempts", () => {
    const sql = migrationSql();
    const selection = functionBody(
      sql,
      "select_company_discovery_result(uuid,uuid,bigint)",
      "revoke all on function public.select_company_discovery_result(uuid,uuid,bigint)",
    );
    expect(sql).toContain("selected_attempt_id uuid");
    expect(selection).toContain("v_job.selected_attempt_id is not null");
    expect(selection).not.toContain("update public.worker_results");
    expect(sql).toContain("company_discovery_result_not_validated");
    expect(sql).toContain("company_discovery_result_already_selected");
    expect(sql).toContain("company_discovery_attempt_not_current");
    expect(sql).toContain("company_discovery_attempt_lease_expired");
    expect(sql).toContain("company_discovery_attempt_terminal");
  });

  test("requires atomic grouped owner review by class and never auto-activates pending claims", () => {
    const sql = migrationSql();
    const review = functionBody(
      sql,
      "review_company_discovery_claims(uuid,uuid,bigint,jsonb,text)",
      "revoke all on function public.review_company_discovery_claims(uuid,uuid,bigint,jsonb,text)",
    );
    expect(review).toContain("for update");
    expect(review).toContain("company_discovery_review_nonce_invalid");
    expect(review).toContain("company_discovery_review_claim_set_mismatch");
    expect(review).toContain("company_discovery_operational_confirmation_required");
    expect(review).toContain("company_discovery_safety_evidence_ack_required");
    expect(review).toContain("company_discovery_owner_private_fact_forbidden");
    expect(review).toContain("company_discovery_review_decision_schema_invalid");
    expect(review).toContain("v_claim.claim_class = 'operational' and v_claim.claim_type = 'service'");
    expect(review).toContain("v_claim.claim_class = 'safety_critical' and v_claim.claim_type = 'emergency'");
    expect(review).toContain("'ligou.rule.service.v2'");
    expect(review).toContain("'ligou.rule.emergency.v2'");
    expect(review).not.toContain("v_decision->'materialization'");
    expect(review).toContain("'price_mode', 'owner_review'");
    expect(review).toContain("'quoteable', false");
    expect(review).toContain("'negotiable', false");
    expect(review).toContain("'operational_state', 'owner_review_required'");
    expect(review).toContain("'public_price', v_value->'public_price'");
    expect(review).toContain("'service.private_pricing'");
    expect(review).toContain("'duration_min', v_value->'duration_minutes'");
    expect(review).not.toContain("'price_target'");
    expect(review).not.toContain("'price_min'");
    expect(review).not.toContain("'negotiation_mode'");
    expect(review).toContain("'ligou.v0_2.rules_versioning:' || v_job.tenant_id::text");
    expect(review).toContain("v_rule_group_id");
    expect(review).toContain("v_rule_version");
    expect(review).toContain("r.structured->>'materialization_key' = v_materialization_key");
    expect(review).toContain("v_structured := v_derived_structured || jsonb_build_object(");
    expect(review).toContain("v_value");
    expect(review).toContain("insert into public.discovery_decisions");
    expect(review).toContain("insert into public.business_profile_versions");
    expect(review).toContain("insert into public.rules");
    expect(review).toContain("'aprovado'");
    expect(review).not.toContain("'sugerido'");
    expect(sql).not.toContain("create trigger discovery_claims_effective");
    expect(sql).not.toContain("insert into public.effective_rules");
  });

  test("requires selected awaiting-review state and invalidates nonces across cancellation and retry", () => {
    const sql = migrationSql();
    const nonce = functionBody(
      sql,
      "create_company_discovery_review_nonce(uuid,uuid,uuid[])",
      "revoke all on function public.create_company_discovery_review_nonce(uuid,uuid,uuid[])",
    );
    const review = functionBody(
      sql,
      "review_company_discovery_claims(uuid,uuid,bigint,jsonb,text)",
      "revoke all on function public.review_company_discovery_claims(uuid,uuid,bigint,jsonb,text)",
    );
    const retry = functionBody(
      sql,
      "retry_company_discovery(uuid,bigint)",
      "revoke all on function public.retry_company_discovery(uuid,bigint)",
    );
    expect(nonce).toContain("j.status = 'awaiting_review'");
    expect(review).toContain("j.status = 'awaiting_review'");
    expect(review).toContain("v_nonce.invalidated_at is not null");
    expect(retry).toContain("selected_attempt_id = null");
    expect(retry).toContain("invalidated_at = clock_timestamp()");
  });

  test("records source-neutral discovery provenance without fabricating a call", () => {
    const sql = migrationSql();
    expect(sql).toContain("'source_kind', 'company_discovery'");
    expect(sql).toContain("'source_job_id'");
    expect(sql).toContain("'source_result_id'");
    expect(sql).toContain("'source_claim_id'");
    expect(sql).toContain("'source_decision_id'");
    expect(sql).not.toContain("'source_call_id', gen_random_uuid()");
    expect(sql).toContain("v_value - array[");
    for (const forbidden of [
      "source_kind",
      "source_call_id",
      "source_job_id",
      "source_result_id",
      "source_claim_id",
      "source_decision_id",
      "coverage_revision",
      "materialization_key",
      "operational_state",
      "effective",
      "active",
      "authority",
      "capability",
      "grant",
    ]) expect(sql).toContain(`'${forbidden}'`);
  });
});

describe("DirectModel company discovery Stage 0B database authority", () => {
  test("stores v2 provenance in one onboarding draft without activating rules or powers", () => {
    const sql = stage0bMigrationSql();
    expect(sql).toContain("company_discovery.result.v2");
    expect(sql).toContain("company_discovery.claim.v2");
    for (const column of [
      "adapter_id", "provider", "model", "confidence", "contradiction_status",
      "missing_fields", "ambiguous_fields", "claim_schema_version",
    ]) expect(sql).toContain(`add column ${column}`);
    expect(sql).toContain("create table public.company_discovery_onboarding_drafts");
    expect(sql).toContain("unique (tenant_id, version)");
    expect(sql).toContain("alter table public.company_discovery_onboarding_drafts enable row level security");
    expect(sql).toContain("alter table public.company_discovery_onboarding_drafts force row level security");
    expect(sql).toContain("create trigger company_discovery_onboarding_drafts_append_only");

    const commit = functionBody(
      sql,
      "commit_company_discovery_result_v2(uuid,bigint,text,jsonb,text)",
      "revoke all on function public.commit_company_discovery_result_v2(",
    );
    expect(commit).toContain("v_attempt.adapter_id = 'direct_model'");
    expect(commit).toContain("p_result->>'schema_version' <> 'company_discovery.result.v2'");
    expect(commit).toContain("'provider', 'openai-codex'");
    expect(commit).toContain("'model', 'gpt-5.6-sol'");

    const review = functionBody(
      sql,
      "review_company_discovery_claims_v2(uuid,uuid,bigint,jsonb,text)",
      "revoke all on function public.review_company_discovery_claims_v2(",
    );
    expect(review).toContain("insert into public.company_discovery_onboarding_drafts");
    expect(review).toContain("insert into public.discovery_decisions");
    expect(review).toContain("'rules_approved', false");
    expect(review).toContain("'powers_granted', false");
    expect(review).toContain("'operational_mode_changed', false");
    expect(review).toContain("'missing_fields', v_effective_missing");
    expect(review).toContain("'ambiguous_fields', v_effective_ambiguous");
    expect(review).toContain("'contradictions', v_effective_contradictions");
    expect(review).toContain("'uncertainty', v_effective_uncertainty");
    expect(review).toContain("'website_missing_fields', v_claim.missing_fields");
    expect(review).toContain("'website_ambiguous_fields', v_claim.ambiguous_fields");
    expect(review).toContain("'website_contradictions', v_claim.contradictions");
    expect(review).toContain("'website_uncertainty', v_claim.uncertainty");
    expect(review).toContain("v_complete_claim_ids");
    expect(review).toContain("company_discovery_review_claim_set_mismatch");
    expect(review).not.toContain("insert into public.rules");
    expect(review).not.toContain("insert into public.powers");
    expect(review).not.toContain("insert into public.effective_rules");
  });

  test("initializes a service-only call-bound prefill and leaves ordinary onboarding available", () => {
    const sql = stage0bMigrationSql();
    const signature = "initialize_company_discovery_onboarding_prefill(uuid,uuid,uuid,uuid,jsonb)";
    const prefill = functionBody(
      sql,
      signature,
      "revoke all on function public.initialize_company_discovery_onboarding_prefill(",
    );
    expect(prefill).toContain("security definer");
    expect(prefill).toContain("set search_path = ''");
    expect(prefill).toContain("request.jwt.claim.role");
    expect(prefill).toContain("service_role_required");
    expect(prefill).toContain("'ligou.company_discovery.onboarding_draft:' || p_tenant::text");
    expect(prefill).toContain("t.owner_user_id = p_owner");
    expect(prefill).toContain("'transition_kind', 'discovery_prefill'");
    expect(prefill).toContain("'rules_approved', false");
    expect(prefill).toContain("'powers_granted', false");
    expect(prefill).toContain("insert into public.receipts");
    expect(sql).toContain("revoke all on function public.initialize_company_discovery_onboarding_prefill(");
    expect(sql).toContain("grant execute on function public.initialize_company_discovery_onboarding_prefill(");
  });

  test("derives queued, fetching, analyzing, and review stages from durable transitions", () => {
    const sql = stage0bMigrationSql();
    expect(sql).toContain("add column processing_stage");
    expect(sql).toContain("processing_stage in ( 'queued','fetching','analyzing','ready_for_review','reviewed','failed','cancelled' )");
    expect(sql).toContain("create trigger company_discovery_attempt_fetching_stage");
    expect(sql).toContain("create trigger company_discovery_subscription_analyzing_stage");
    expect(sql).toContain("create trigger company_discovery_result_review_stage");
    expect(sql).toContain("create trigger company_discovery_job_status_stage");
  });
});

function postgresJsonbText(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(postgresJsonbText).join(", ")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) =>
    Buffer.byteLength(left) - Buffer.byteLength(right) ||
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}: ${postgresJsonbText(record[key])}`
  ).join(", ")}}`;
}

function postgresJsonbHash(value: unknown): string {
  return createHash("sha256").update(postgresJsonbText(value), "utf8").digest("hex");
}

function runtimeIdentity(
  label: string,
  loopbackPort: number,
  platform: "linux/arm64" | "linux/amd64" = "linux/arm64",
) {
  const prefix = `ligou-${label}`;
  const subscriptionSocketId = createHash("sha256")
    .update(`subscription:${label}`, "utf8")
    .digest("hex")
    .slice(0, 48);
  const openClawIndex = `sha256:${"e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4"}`;
  const bridgeIndex = `sha256:${"b".repeat(64)}`;
  return {
    runtime_kind: "openclaw_cell" as const,
    cell_container_name: `${prefix}-cell`,
    bridge_container_name: `${prefix}-bridge`,
    internal_network_name: `${prefix}-internal`,
    egress_network_name: `${prefix}-egress`,
    config_volume_name: `${prefix}-config`,
    state_volume_name: `${prefix}-state`,
    workspace_volume_name: `${prefix}-workspace`,
    output_volume_name: `${prefix}-output`,
    gateway_secret_volume_name: `${prefix}-gateway-secret`,
    bridge_secret_volume_name: `${prefix}-bridge-secret`,
    profile_name: `${prefix}-profile`,
    loopback_port: loopbackPort,
    subscription_socket_path:
      `/run/ligou-discovery/${subscriptionSocketId}/subscription.sock`,
    cell_image: {
      reference: `ghcr.io/openclaw/openclaw@${openClawIndex}`,
      index_digest: openClawIndex,
      platform,
      selected_manifest_digest: `sha256:${"c".repeat(64)}`,
      image_id: `sha256:${"d".repeat(64)}`,
      config_digest: `sha256:${"e".repeat(64)}`,
    },
    bridge_image: {
      reference: `registry.example.invalid/ligou/discovery-bridge@${bridgeIndex}`,
      index_digest: bridgeIndex,
      platform,
      selected_manifest_digest: platform === "linux/arm64"
        ? `sha256:${"9".repeat(64)}`
        : `sha256:${"8".repeat(64)}`,
      image_id: `sha256:${"f".repeat(64)}`,
      config_digest: `sha256:${"0".repeat(64)}`,
    },
  };
}

function directRuntimeIdentity(label: string) {
  const subscriptionSocketId = createHash("sha256")
    .update(`direct-subscription:${label}`, "utf8")
    .digest("hex")
    .slice(0, 48);
  return {
    runtime_kind: "direct_model_subscription" as const,
    subscription_socket_path:
      `/run/ligou-discovery/${subscriptionSocketId}/subscription.sock`,
  };
}

interface ClaimedAttempt {
  tenant_id: string;
  credential_owner_id: string;
  credential_generation: number;
  job_id: string;
  attempt_id: string;
  attempt_number: number;
  adapter_id: "openclaw" | "direct_model";
  fence_generation: number;
  claim_token: string;
  runtime_slot_id: string;
  job_version: number;
  normalized_origin: string;
  deadline_at: string;
  budget: Record<string, unknown>;
  subscription_account_hash: string;
}

interface CommittedResult {
  job_id: string;
  attempt_id: string;
  result_id: string;
  job_version: number;
  fence_generation: number;
}

interface CleanupRecovery {
  job_id: string;
  attempt_id: string;
  adapter_id: string;
  runtime_slot_id: string;
  runtime_identity: Record<string, unknown>;
  fence_generation: number;
  claim_token: string | null;
  job_version: number;
  recovery_outcome: "cleanup_claimed" | "runtime_not_bound";
}

const completeDirectCleanupProof = {
  subscription_lease_revoked: true,
  subscription_requests_drained: true,
  subscription_listener_closed: true,
  subscription_socket_absent: true,
  identity_process_absent: true,
  late_result_rejected: true,
};

const completeOpenClawCleanupProof = {
  gateway_exited: true,
  container_removed: true,
  bridge_removed: true,
  config_removed: true,
  state_removed: true,
  workspace_removed: true,
  output_removed: true,
  network_removed: true,
  credential_material_removed: true,
  subscription_lease_revoked: true,
  subscription_requests_drained: true,
  subscription_listener_closed: true,
  subscription_socket_absent: true,
  listener_closed: true,
  identity_process_absent: true,
  late_result_rejected: true,
} as const;

test.skipIf(process.env.LIGOU_LOCAL_DB_TEST !== "1")(
  "real Postgres keeps discovery fenced, owner-bound, atomic, and non-effective before review",
  async () => {
    const { priceRules, servicePolicies } = await import("../src/rules.ts");
    const apiUrl = process.env.SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SECRET_KEY!;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY!;
    const service = createClient(apiUrl, serviceKey, { auth: { persistSession: false } });
    const serviceB = createClient(apiUrl, serviceKey, { auth: { persistSession: false } });
    const owner = createClient(apiUrl, publishableKey, { auth: { persistSession: false } });
    const intruder = createClient(apiUrl, publishableKey, { auth: { persistSession: false } });
    const ownerEmail = `discovery-owner-${randomUUID()}@example.invalid`;
    const intruderEmail = `discovery-intruder-${randomUUID()}@example.invalid`;
    const ownerPassword = `Owner-${randomUUID()}-Aa1!`;
    const intruderPassword = `Intruder-${randomUUID()}-Aa1!`;
    const ownerTenant = randomUUID();
    const intruderTenant = randomUUID();
    const ownerSubscriptionAccountHash = "1".repeat(64);
    // Both tenants deliberately share one central credential owner/generation;
    // therefore the authoritative account hash must be identical.
    const intruderSubscriptionAccountHash = ownerSubscriptionAccountHash;
    const designatedCredentialOwnerId = randomUUID();
    let runtimeSequence = 0;
    const bindClaim = async (claimed: ClaimedAttempt, label: string) => {
      runtimeSequence += 1;
      const identity = claimed.adapter_id === "openclaw"
        ? runtimeIdentity(label, 30_000 + runtimeSequence)
        : directRuntimeIdentity(label);
      const bound = await service.rpc("bind_company_discovery_runtime", {
        p_attempt_id: claimed.attempt_id,
        p_fence_generation: claimed.fence_generation,
        p_claim_token: claimed.claim_token,
        p_runtime_identity: identity,
      });
      expect(bound.error).toBeNull();
      expect(bound.data).toMatchObject({
        attempt_id: claimed.attempt_id,
        runtime_slot_id: claimed.runtime_slot_id,
        job_id: claimed.job_id,
        job_version: claimed.job_version,
        fence_generation: claimed.fence_generation,
        runtime_identity: identity,
        runtime_identity_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      return identity;
    };

    const ownerCreated = await service.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
    });
    const intruderCreated = await service.auth.admin.createUser({
      email: intruderEmail,
      password: intruderPassword,
      email_confirm: true,
    });
    expect(ownerCreated.error).toBeNull();
    expect(intruderCreated.error).toBeNull();
    const ownerId = ownerCreated.data.user!.id;
    const intruderId = intruderCreated.data.user!.id;
    expect((await service.from("tenants").insert([{
      id: ownerTenant,
      slug: `discovery-${ownerTenant.slice(0, 8)}`,
      name: "Discovery Owner",
      owner_user_id: ownerId,
      status: "onboarding",
      operational_mode: "simulation_only",
    }, {
      id: intruderTenant,
      slug: `discovery-${intruderTenant.slice(0, 8)}`,
      name: "Discovery Intruder",
      owner_user_id: intruderId,
      status: "onboarding",
      operational_mode: "simulation_only",
    }])).error).toBeNull();
    expect((await service.from("company_discovery_subscription_bindings").insert({
      tenant_id: ownerTenant,
      credential_owner_id: designatedCredentialOwnerId,
      expected_account_hash: ownerSubscriptionAccountHash,
      credential_generation: 1,
      active: true,
    })).error).toBeNull();
    const mismatchedSharedOwner = await service
      .from("company_discovery_subscription_bindings")
      .insert({
        tenant_id: intruderTenant,
        credential_owner_id: designatedCredentialOwnerId,
        expected_account_hash: "2".repeat(64),
        credential_generation: 1,
        active: true,
      });
    expect(mismatchedSharedOwner.error?.message).toContain(
      "company_discovery_subscription_owner_account_mismatch",
    );
    expect((await service.from("company_discovery_subscription_bindings").insert({
      tenant_id: intruderTenant,
      credential_owner_id: designatedCredentialOwnerId,
      expected_account_hash: intruderSubscriptionAccountHash,
      credential_generation: 1,
      active: true,
    })).error).toBeNull();
    expect((await service.from("company_discovery_controls")
      .update({ enabled: true }).eq("singleton", true)).error).toBeNull();
    expect((await service.from("company_discovery_allowlist").insert({
      tenant_id: ownerTenant,
      active: true,
    })).error).toBeNull();
    expect((await owner.auth.signInWithPassword({
      email: ownerEmail,
      password: ownerPassword,
    })).error).toBeNull();
    expect((await intruder.auth.signInWithPassword({
      email: intruderEmail,
      password: intruderPassword,
    })).error).toBeNull();
    const privateBindingRead = await owner
      .from("company_discovery_subscription_bindings")
      .select("tenant_id,credential_owner_id,expected_account_hash,credential_generation");
    expect(privateBindingRead.error).not.toBeNull();
    expect(privateBindingRead.data).toBeNull();
    for (const privateTable of [
      "company_discovery_subscription_governors",
      "company_discovery_subscription_reservations",
    ]) {
      const privateRead = await owner.from(privateTable).select("*");
      expect(privateRead.error).not.toBeNull();
      expect(privateRead.data).toBeNull();
    }
    expect((await service.from("company_discovery_controls")
      .update({ enabled: false }).eq("singleton", true)).error).toBeNull();
    const disabledOwnerStatus = await owner.rpc("company_discovery_owner_status");
    expect(disabledOwnerStatus.error).toBeNull();
    expect(Object.keys(disabledOwnerStatus.data).sort()).toEqual([
      "allowlisted", "available", "enabled", "expires_at",
    ]);
    expect(disabledOwnerStatus.data).toEqual({
      enabled: false,
      allowlisted: true,
      expires_at: null,
      available: false,
    });
    const intruderStatus = await intruder.rpc("company_discovery_owner_status");
    expect(intruderStatus.error).toBeNull();
    expect(intruderStatus.data).toEqual({
      enabled: false,
      allowlisted: false,
      expires_at: null,
      available: false,
    });
    expect((await service.from("company_discovery_controls")
      .update({ enabled: true }).eq("singleton", true)).error).toBeNull();
    const enabledOwnerStatus = await owner.rpc("company_discovery_owner_status");
    expect(enabledOwnerStatus.error).toBeNull();
    expect(enabledOwnerStatus.data).toEqual({
      enabled: true,
      allowlisted: true,
      expires_at: null,
      available: true,
    });

    const firstSubmit = await owner.rpc("submit_company_discovery", {
      p_url: "https://example.com/about",
      p_idempotency_key: "stage0-owner-first",
    });
    expect(firstSubmit.error).toBeNull();
    const firstJob = String(firstSubmit.data);
    const submittedJob = await owner.from("worker_jobs")
      .select("origin_host,registrable_domain")
      .eq("id", firstJob)
      .single();
    expect(submittedJob.error).toBeNull();
    expect(submittedJob.data).toEqual({
      origin_host: "example.com",
      registrable_domain: null,
    });
    const replay = await owner.rpc("submit_company_discovery", {
      p_url: "https://example.com/about",
      p_idempotency_key: "stage0-owner-first",
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(firstJob);
    const idempotencyConflict = await owner.rpc("submit_company_discovery", {
      p_url: "https://example.com/different",
      p_idempotency_key: "stage0-owner-first",
    });
    expect(idempotencyConflict.error?.message).toContain(
      "company_discovery_idempotency_conflict",
    );
    const intruderRead = await intruder.from("worker_jobs").select("id").eq("id", firstJob);
    expect(intruderRead.error).toBeNull();
    expect(intruderRead.data).toEqual([]);
    const intruderCancel = await intruder.rpc("cancel_company_discovery", {
      p_job: firstJob,
      p_expected_version: 1,
    });
    expect(intruderCancel.error?.message).toContain("company_discovery_job_not_owner");

    const firstClaim = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: `stage0-worker-${randomUUID()}`,
      p_adapter_id: "openclaw",
      p_lease_seconds: 300,
    });
    expect(firstClaim.error).toBeNull();
    expect(firstClaim.data).toHaveLength(1);
    const claim = firstClaim.data![0] as ClaimedAttempt;
    expect(claim.job_id).toBe(firstJob);
    expect(Object.keys(claim).sort()).toEqual([
      "adapter_id", "attempt_id", "attempt_number", "budget", "claim_token",
      "credential_generation", "credential_owner_id", "deadline_at",
      "fence_generation", "job_id", "job_version", "normalized_origin",
      "runtime_slot_id", "subscription_account_hash", "tenant_id",
    ]);
    expect(claim.adapter_id).toBe("openclaw");
    expect(claim.job_version).toBe(2);
    expect(claim.tenant_id).toBe(ownerTenant);
    expect(claim.subscription_account_hash).toBe(ownerSubscriptionAccountHash);
    expect(claim.credential_owner_id).toBe(designatedCredentialOwnerId);
    expect(claim.credential_generation).toBe(1);
    const unboundCommit = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: claim.attempt_id,
      p_fence_generation: claim.fence_generation,
      p_claim_token: claim.claim_token,
      p_result: {},
      p_result_hash: "0".repeat(64),
    });
    expect(unboundCommit.error?.message).toContain("company_discovery_runtime_not_bound");
    const invalidRuntime = runtimeIdentity(`invalid-${randomUUID()}`, 30_100);
    const invalidBind = await service.rpc("bind_company_discovery_runtime", {
      p_attempt_id: claim.attempt_id,
      p_fence_generation: claim.fence_generation,
      p_claim_token: claim.claim_token,
      p_runtime_identity: { ...invalidRuntime, config_path: "/tmp/escape" },
    });
    expect(invalidBind.error?.message).toContain(
      "company_discovery_runtime_identity_invalid",
    );
    const invalidImageBind = (identity: unknown) => service.rpc(
      "bind_company_discovery_runtime",
      {
        p_attempt_id: claim.attempt_id,
        p_fence_generation: claim.fence_generation,
        p_claim_token: claim.claim_token,
        p_runtime_identity: identity,
      },
    );
    expect((await invalidImageBind({
      ...invalidRuntime,
      cell_image: { ...invalidRuntime.cell_image, unexpected: true },
    })).error?.message).toContain("company_discovery_runtime_identity_invalid");
    expect((await invalidImageBind(directRuntimeIdentity("wrong-openclaw-kind")))
      .error?.message).toContain("company_discovery_runtime_identity_invalid");
    expect((await invalidImageBind({
      ...invalidRuntime,
      cell_image: {
        ...invalidRuntime.cell_image,
        index_digest: `sha256:${"1".repeat(64)}`,
      },
    })).error?.message).toContain("company_discovery_runtime_identity_invalid");
    expect((await invalidImageBind({
      ...invalidRuntime,
      bridge_image: {
        ...invalidRuntime.bridge_image,
        selected_manifest_digest: `sha256:${"G".repeat(64)}`,
      },
    })).error?.message).toContain("company_discovery_runtime_identity_invalid");
    expect((await invalidImageBind({
      ...invalidRuntime,
      bridge_image: {
        ...invalidRuntime.bridge_image,
        reference: `registry.example.invalid/ligou/discovery-bridge@sha256:${"2".repeat(64)}`,
      },
    })).error?.message).toContain("company_discovery_runtime_identity_invalid");
    expect((await invalidImageBind({
      ...invalidRuntime,
      bridge_image: { ...invalidRuntime.bridge_image, platform: "linux/ppc64" },
    })).error?.message).toContain("company_discovery_runtime_identity_invalid");
    const firstRuntime = await bindClaim(claim, `first-${randomUUID()}`);
    const staleModelAccess = await service.rpc("read_company_discovery_model_access", {
      p_attempt_id: claim.attempt_id,
      p_fence_generation: claim.fence_generation,
      p_claim_token: claim.claim_token,
      p_credential_generation: 2,
    });
    expect(staleModelAccess.error?.message).toContain(
      "company_discovery_subscription_binding_stale",
    );
    const modelAccess = await service.rpc("read_company_discovery_model_access", {
      p_attempt_id: claim.attempt_id,
      p_fence_generation: claim.fence_generation,
      p_claim_token: claim.claim_token,
      p_credential_generation: claim.credential_generation,
    });
    expect(modelAccess.error).toBeNull();
    expect(modelAccess.data).toEqual({
      tenant_id: ownerTenant,
      job_id: firstJob,
      attempt_id: claim.attempt_id,
      fence_generation: claim.fence_generation,
      runtime_slot_id: claim.runtime_slot_id,
      adapter_id: "openclaw",
      deadline_at: claim.deadline_at,
      credential_owner_id: designatedCredentialOwnerId,
      expected_account_hash: ownerSubscriptionAccountHash,
      credential_generation: 1,
      subscription_socket_path: firstRuntime.subscription_socket_path,
      runtime_identity_hash: postgresJsonbHash(firstRuntime),
      provider: "openai-codex",
      auth_kind: "chatgpt_subscription_oauth",
      model: "gpt-5.6-sol",
    });
    const subscriptionRecovery = await service.rpc(
      "read_company_discovery_subscription_recovery",
      {
        p_attempt_id: claim.attempt_id,
        p_fence_generation: claim.fence_generation,
        p_claim_token: claim.claim_token,
      },
    );
    expect(subscriptionRecovery.error?.message).toContain(
      "company_discovery_subscription_recovery_not_current",
    );

    const reserveSubscription = (
      candidate: ClaimedAttempt,
      requestKey: string,
      inputBytes = 1_000,
      outputBytes = 4_194_304,
      leaseSeconds = 120,
      client = service,
    ) => client.rpc("reserve_company_discovery_subscription_request", {
      p_attempt_id: candidate.attempt_id,
      p_fence_generation: candidate.fence_generation,
      p_claim_token: candidate.claim_token,
      p_credential_generation: candidate.credential_generation,
      p_request_key: requestKey,
      p_input_bytes: inputBytes,
      p_output_bytes: outputBytes,
      p_lease_seconds: leaseSeconds,
    });
    const settleSubscription = (
      candidate: ClaimedAttempt,
      reservation: Record<string, unknown>,
      options: {
        input_bytes: number;
        output_bytes: number;
        observed_input_tokens: number | null;
        observed_output_tokens: number | null;
        usage_complete: boolean;
        quota_state: "available" | "cooldown" | "unknown";
        retry_after_seconds: number | null;
      },
    ) => service.rpc("settle_company_discovery_subscription_request", {
      p_attempt_id: candidate.attempt_id,
      p_fence_generation: candidate.fence_generation,
      p_claim_token: candidate.claim_token,
      p_reservation_id: reservation.reservation_id,
      p_reservation_token: reservation.reservation_token,
      p_input_bytes: options.input_bytes,
      p_output_bytes: options.output_bytes,
      p_observed_input_tokens: options.observed_input_tokens,
      p_observed_output_tokens: options.observed_output_tokens,
      p_usage_complete: options.usage_complete,
      p_quota_state: options.quota_state,
      p_retry_after_seconds: options.retry_after_seconds,
    });

    // Two independent service clients contend on one credential-owner row.
    // PostgreSQL serializes the admission and global concurrency=1 permits
    // exactly one reservation; no process-local counter participates.
    const concurrencyRace = await Promise.all([
      reserveSubscription(claim, randomUUID(), 1_000, 1_024, 120, service),
      reserveSubscription(claim, randomUUID(), 1_000, 1_024, 120, serviceB),
    ]);
    const reservationWinners = concurrencyRace.filter((response) => response.error === null);
    const reservationLosers = concurrencyRace.filter((response) => response.error !== null);
    expect(reservationWinners).toHaveLength(1);
    expect(reservationLosers).toHaveLength(1);
    expect(reservationLosers[0]!.error?.message).toContain(
      "company_discovery_subscription_owner_limit_exceeded",
    );
    const firstReservation = reservationWinners[0]!.data as Record<string, unknown>;
    expect(firstReservation).toMatchObject({
      quota_state: "available",
      current_requests: 1,
      max_requests: 28,
      max_input_bytes: 400_000,
      max_output_bytes: 8_388_608,
      owner_current_requests: 1,
      owner_max_requests: 140,
      owner_max_input_bytes: 2_000_000,
      owner_max_output_bytes: 40_000_000,
      max_concurrency: 1,
    });
    const firstSettlement = {
      input_bytes: 1_000,
      output_bytes: 0,
      observed_input_tokens: null,
      observed_output_tokens: null,
      usage_complete: false,
      quota_state: "available",
      retry_after_seconds: null,
    } as const;
    expect((await settleSubscription(claim, firstReservation, firstSettlement)).error)
      .toBeNull();
    const settlementRetry = await settleSubscription(
      claim,
      firstReservation,
      firstSettlement,
    );
    expect(settlementRetry.error).toBeNull();
    expect(settlementRetry.data.current_requests).toBe(1);

    // Prospective bytes, not merely settled bytes, are checked against the
    // tenant's fair share. Two full response reservations fit exactly; the
    // next byte is rejected even though the owner-wide pool still has room.
    for (let index = 0; index < 2; index += 1) {
      const reserved = await reserveSubscription(
        claim,
        randomUUID(),
        1_000,
        4_194_304,
      );
      expect(reserved.error).toBeNull();
      expect((await settleSubscription(claim, reserved.data, {
        input_bytes: 1_000,
        output_bytes: 4_194_304,
        observed_input_tokens: 250,
        observed_output_tokens: 1_024,
        usage_complete: true,
        quota_state: "available",
        retry_after_seconds: null,
      })).error).toBeNull();
    }
    const tenantLimit = await reserveSubscription(claim, randomUUID(), 1, 1);
    expect(tenantLimit.error?.message).toContain(
      "company_discovery_subscription_tenant_limit_exceeded",
    );

    // A second allowlisted tenant mapped to the same owner/generation retains
    // its own fair share while contributing to the same owner-wide totals.
    expect((await service.from("company_discovery_allowlist").insert({
      tenant_id: intruderTenant,
      active: true,
    })).error).toBeNull();
    const sharedOwnerSubmit = await intruder.rpc("submit_company_discovery", {
      p_url: "https://example.net/",
      p_idempotency_key: `shared-owner-${randomUUID()}`,
    });
    expect(sharedOwnerSubmit.error).toBeNull();
    const sharedOwnerClaimResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: `shared-owner-worker-${randomUUID()}`,
      p_adapter_id: "direct_model",
      p_lease_seconds: 300,
    });
    expect(sharedOwnerClaimResult.error).toBeNull();
    const sharedOwnerClaim = sharedOwnerClaimResult.data![0] as ClaimedAttempt;
    expect(sharedOwnerClaim.tenant_id).toBe(intruderTenant);
    await bindClaim(sharedOwnerClaim, `shared-owner-${randomUUID()}`);
    const sharedReservation = await reserveSubscription(
      sharedOwnerClaim,
      randomUUID(),
      2_000,
      2_048,
    );
    expect(sharedReservation.error).toBeNull();
    expect(sharedReservation.data).toMatchObject({
      current_requests: 1,
      owner_current_requests: 4,
      max_requests: 28,
      owner_max_requests: 140,
    });
    const invalidRetryAfter = await settleSubscription(
      sharedOwnerClaim,
      sharedReservation.data,
      {
        input_bytes: 2_000,
        output_bytes: 2_048,
        observed_input_tokens: null,
        observed_output_tokens: null,
        usage_complete: false,
        quota_state: "cooldown",
        retry_after_seconds: 0,
      },
    );
    expect(invalidRetryAfter.error?.message).toContain(
      "company_discovery_subscription_settlement_invalid",
    );
    expect((await settleSubscription(sharedOwnerClaim, sharedReservation.data, {
      input_bytes: 2_000,
      output_bytes: 2_048,
      observed_input_tokens: 500,
      observed_output_tokens: 200,
      usage_complete: true,
      quota_state: "cooldown",
      retry_after_seconds: 2,
    })).error).toBeNull();
    expect((await reserveSubscription(sharedOwnerClaim, randomUUID(), 1, 1))
      .error?.message).toContain("company_discovery_subscription_cooldown");
    await runDisposableLocalSql(`
      update public.company_discovery_subscription_governors
      set cooldown_until = clock_timestamp() - interval '1 second'
      where credential_owner_id = ${localSqlUuid(designatedCredentialOwnerId)}
        and credential_generation = 1;
    `);

    // An abandoned reservation is conservatively charged at its prospective
    // byte ceilings and makes provider quota state unknown until intervention.
    const abandoned = await reserveSubscription(
      sharedOwnerClaim,
      randomUUID(),
      3_000,
      4_096,
      1,
    );
    expect(abandoned.error).toBeNull();
    await runDisposableLocalSql(`
      update public.company_discovery_subscription_reservations
      set created_at = clock_timestamp() - interval '2 seconds',
          lease_until = clock_timestamp() - interval '1 second'
      where id = ${localSqlUuid(String(abandoned.data.reservation_id))};
    `);
    expect((await service.rpc("reap_company_discovery_subscription_reservations", {
      p_limit: null,
    })).error?.message).toContain("company_discovery_subscription_reap_limit_invalid");
    expect((await service.rpc("reap_company_discovery_subscription_reservations", {
      p_limit: 100,
    })).data).toBe(1);
    expect((await reserveSubscription(sharedOwnerClaim, randomUUID(), 1, 1))
      .error?.message).toContain("company_discovery_subscription_quota_unknown");
    expect(await runDisposableLocalSql(`
      select concat_ws(':', state, quota_state, usage_complete::text,
        settled_input_bytes::text, settled_output_bytes::text)
      from public.company_discovery_subscription_reservations
      where id = ${localSqlUuid(String(abandoned.data.reservation_id))};
    `)).toBe("expired:unknown:false:3000:4096");

    const duplicateBind = await service.rpc("bind_company_discovery_runtime", {
      p_attempt_id: claim.attempt_id,
      p_fence_generation: claim.fence_generation,
      p_claim_token: claim.claim_token,
      p_runtime_identity: firstRuntime,
    });
    expect(duplicateBind.error?.message).toContain("company_discovery_runtime_already_bound");
    const missingAttempt = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: randomUUID(),
      p_fence_generation: claim.fence_generation,
      p_claim_token: claim.claim_token,
      p_result: {},
      p_result_hash: "0".repeat(64),
    });
    expect(missingAttempt.error?.message).toContain("company_discovery_attempt_not_found");
    const wrongFence = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: claim.attempt_id,
      p_fence_generation: claim.fence_generation + 1,
      p_claim_token: claim.claim_token,
      p_result: {},
      p_result_hash: "0".repeat(64),
    });
    expect(wrongFence.error?.message).toContain("company_discovery_stale_fence");
    const wrongClaim = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: claim.attempt_id,
      p_fence_generation: claim.fence_generation,
      p_claim_token: "wrong-claim-token",
      p_result: {},
      p_result_hash: "0".repeat(64),
    });
    expect(wrongClaim.error?.message).toContain("company_discovery_claim_token_invalid");

    const resultPayload = {
      schema_version: "company_discovery.result.v1",
      source_snapshots: [{
        url: "https://example.com/about",
        retrieved_at: "2026-09-01T10:00:00.000Z",
        http_status: 200,
        mime_type: "text/html",
        byte_length: 128,
        content_hash: "a".repeat(64),
        excerpt: "Example Plumbing serves Orange County. Emergency gas guidance is public.",
        crawl_order: 0,
        crawl_depth: 0,
      }],
      candidate_facts: [{
        claim_class: "descriptive",
        claim_type: "business_name",
        normalized_value: "Example Plumbing",
        evidence_refs: [0],
        contradictions: [],
        uncertainty: [],
      }, {
        claim_class: "operational",
        claim_type: "service",
        normalized_value: {
          service_type: "drain_cleaning",
          service_names: ["Drain cleaning"],
          public_price: {
            amount: "149.00",
            currency: "USD",
            qualifier: "exact",
          },
          duration_minutes: 90,
        },
        evidence_refs: [0],
        contradictions: [],
        uncertainty: [],
      }, {
        claim_class: "safety_critical",
        claim_type: "emergency",
        normalized_value: {
          guidance: "Leave the area and call emergency services.",
        },
        evidence_refs: [0],
        contradictions: [],
        uncertainty: [],
      }],
      missing_questions: ["Qual é o preço mínimo privado autorizado?"],
      contradictions: [],
      uncertainty: [],
    };
    const tryCandidate = (candidate: unknown) =>
      service.rpc("commit_company_discovery_result", {
        p_attempt_id: claim.attempt_id,
        p_fence_generation: claim.fence_generation,
        p_claim_token: claim.claim_token,
        p_result: candidate,
        p_result_hash: postgresJsonbHash(candidate),
      });
    const extraTopLevel = await tryCandidate({ ...resultPayload, effective: true });
    expect(extraTopLevel.error?.message).toContain(
      "company_discovery_result_top_level_invalid",
    );
    const nestedAuthority = structuredClone(resultPayload);
    nestedAuthority.candidate_facts[1]!.normalized_value = {
      ...nestedAuthority.candidate_facts[1]!.normalized_value as Record<string, unknown>,
      source_call_id: randomUUID(),
    };
    const nestedAuthorityResult = await tryCandidate(nestedAuthority);
    expect(nestedAuthorityResult.error?.message).toContain(
      "company_discovery_forbidden_result_field",
    );
    const operationalEmergency = structuredClone(resultPayload);
    operationalEmergency.candidate_facts[1]!.claim_type = "emergency";
    const operationalEmergencyResult = await tryCandidate(operationalEmergency);
    expect(operationalEmergencyResult.error?.message).toContain(
      "company_discovery_claim_materialization_type_invalid",
    );
    const legacyPrivatePrice = structuredClone(resultPayload);
    legacyPrivatePrice.candidate_facts[1]!.normalized_value = {
      ...legacyPrivatePrice.candidate_facts[1]!.normalized_value as Record<string, unknown>,
      price_min: "120.00",
    };
    const legacyPrivatePriceResult = await tryCandidate(legacyPrivatePrice);
    expect(legacyPrivatePriceResult.error?.message).toContain(
      "company_discovery_claim_materialization_type_invalid",
    );
    const invalidTopUncertainty = await tryCandidate({
      ...resultPayload,
      uncertainty: {},
    });
    expect(invalidTopUncertainty.error?.message).toContain(
      "company_discovery_result_schema_invalid",
    );
    const invalidClaimUncertainty = structuredClone(resultPayload);
    invalidClaimUncertainty.candidate_facts[1]!.uncertainty = {} as never;
    const invalidClaimUncertaintyResult = await tryCandidate(invalidClaimUncertainty);
    expect(invalidClaimUncertaintyResult.error?.message).toContain(
      "company_discovery_claim_schema_invalid",
    );
    const authorityMasquerade = structuredClone(resultPayload);
    authorityMasquerade.candidate_facts[1]!.claim_type = "authority";
    const authorityMasqueradeResult = await tryCandidate(authorityMasquerade);
    expect(authorityMasqueradeResult.error?.message).toContain(
      "company_discovery_claim_materialization_type_invalid",
    );
    const oversizeValue = structuredClone(resultPayload);
    oversizeValue.candidate_facts[1]!.normalized_value = {
      ...oversizeValue.candidate_facts[1]!.normalized_value as Record<string, unknown>,
      service_names: ["x".repeat(65_537)],
    };
    const oversizeResult = await tryCandidate(oversizeValue);
    expect(oversizeResult.error?.message).toContain(
      "company_discovery_claim_value_too_large",
    );
    const jobBytesExceeded = structuredClone(resultPayload);
    jobBytesExceeded.source_snapshots = Array.from({ length: 11 }, (_, index) => ({
      ...resultPayload.source_snapshots[0]!,
      url: `https://example.com/page-${index}`,
      byte_length: 1_048_576,
      content_hash: String(index % 10).repeat(64),
      crawl_order: index,
    }));
    const jobBytesResult = await tryCandidate(jobBytesExceeded);
    expect(jobBytesResult.error?.message).toContain(
      "company_discovery_job_byte_limit_exceeded",
    );
    const commit = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: claim.attempt_id,
      p_fence_generation: claim.fence_generation,
      p_claim_token: claim.claim_token,
      p_result: resultPayload,
      p_result_hash: postgresJsonbHash(resultPayload),
    });
    expect(commit.error).toBeNull();
    expect(Object.keys(commit.data).sort()).toEqual([
      "attempt_id", "fence_generation", "job_id", "job_version", "result_id",
    ]);
    const committed = commit.data as CommittedResult;
    expect(committed).toEqual({
      job_id: firstJob,
      attempt_id: claim.attempt_id,
      result_id: expect.stringMatching(UUID_PATTERN),
      job_version: claim.job_version + 1,
      fence_generation: claim.fence_generation,
    });
    const resultId = committed.result_id;
    const selected = await service.rpc("select_company_discovery_result", {
      p_job_id: firstJob,
      p_attempt_id: claim.attempt_id,
      p_expected_version: committed.job_version,
    });
    expect(selected.error).toBeNull();
    const selectedRecovery = await service.rpc(
      "read_company_discovery_subscription_recovery",
      {
        p_attempt_id: claim.attempt_id,
        p_fence_generation: claim.fence_generation,
        p_claim_token: claim.claim_token,
      },
    );
    expect(selectedRecovery.error).toBeNull();
    expect(selectedRecovery.data).toEqual({
      job_id: firstJob,
      attempt_id: claim.attempt_id,
      fence_generation: claim.fence_generation,
      subscription_socket_path: firstRuntime.subscription_socket_path,
      runtime_kind: "openclaw_cell",
      late_result_rejected: true,
    });
    expect((await owner.from("effective_rules").select("id").eq("tenant_id", ownerTenant)).data)
      .toEqual([]);
    const claimRows = await owner.from("discovery_claims")
      .select("id,claim_class,evidence_refs")
      .eq("result_id", resultId);
    expect(claimRows.error).toBeNull();
    expect(claimRows.data).toHaveLength(3);
    const byClass = Object.fromEntries(
      claimRows.data!.map((row) => [row.claim_class, row]),
    ) as Record<string, { id: string; evidence_refs: string[] }>;
    const claimIds = claimRows.data!.map((row) => row.id);
    const nonceResult = await owner.rpc("create_company_discovery_review_nonce", {
      p_job: firstJob,
      p_result: resultId,
      p_claim_ids: claimIds,
    });
    expect(nonceResult.error).toBeNull();
    const nonce = String(nonceResult.data);
    const decisions = (acknowledgeSafety: boolean) => [{
      claim_id: byClass.descriptive.id,
      decision: "approve",
    }, {
      claim_id: byClass.operational.id,
      decision: "approve",
      group_confirmed: true,
    }, {
      claim_id: byClass.safety_critical.id,
      decision: "approve",
      group_confirmed: true,
      evidence_acknowledged: acknowledgeSafety,
      acknowledged_evidence_refs: acknowledgeSafety
        ? byClass.safety_critical.evidence_refs
        : [],
    }];
    const fakeProvenanceDecision = decisions(true);
    (fakeProvenanceDecision[1] as Record<string, unknown>).source_call_id = randomUUID();
    const fakeProvenanceReview = await owner.rpc("review_company_discovery_claims", {
      p_job: firstJob,
      p_result: resultId,
      p_expected_version: 4,
      p_decisions: fakeProvenanceDecision,
      p_confirmation_nonce: nonce,
    });
    expect(fakeProvenanceReview.error?.message).toContain(
      "company_discovery_review_decision_schema_invalid",
    );
    const atomicFailure = await owner.rpc("review_company_discovery_claims", {
      p_job: firstJob,
      p_result: resultId,
      p_expected_version: 4,
      p_decisions: decisions(false),
      p_confirmation_nonce: nonce,
    });
    expect(atomicFailure.error?.message).toContain(
      "company_discovery_safety_evidence_ack_required",
    );
    expect((await owner.from("discovery_decisions").select("id").eq("job_id", firstJob)).data)
      .toEqual([]);
    expect((await owner.from("business_profile_versions").select("id").eq("tenant_id", ownerTenant)).data)
      .toEqual([]);
    expect((await owner.from("effective_rules").select("id").eq("tenant_id", ownerTenant)).data)
      .toEqual([]);
    const acceptedReview = await owner.rpc("review_company_discovery_claims", {
      p_job: firstJob,
      p_result: resultId,
      p_expected_version: 4,
      p_decisions: decisions(true),
      p_confirmation_nonce: nonce,
    });
    expect(acceptedReview.error).toBeNull();
    expect((await owner.from("discovery_decisions").select("id").eq("job_id", firstJob)).data)
      .toHaveLength(3);
    expect((await owner.from("business_profile_versions").select("id").eq("tenant_id", ownerTenant)).data)
      .toHaveLength(1);
    const effective = await owner.from("effective_rules")
      .select("id,rule_group_id,version,category,escopo,text,structured")
      .eq("tenant_id", ownerTenant);
    expect(effective.error).toBeNull();
    expect(effective.data).toHaveLength(2);
    const firstServiceRule = effective.data!.find((row) => row.category === "preco")!;
    expect(firstServiceRule.structured)
      .toMatchObject({
        source_kind: "company_discovery",
        source_job_id: firstJob,
        source_result_id: resultId,
        service_type: "drain_cleaning",
        price_mode: "owner_review",
        quoteable: false,
        negotiable: false,
        operational_state: "owner_review_required",
        public_price: {
          amount: "149.00",
          currency: "USD",
          qualifier: "exact",
        },
        duration_min: 90,
      });
    expect(firstServiceRule.structured).not.toHaveProperty("price_target");
    expect(firstServiceRule.structured).not.toHaveProperty("price_min");
    expect(firstServiceRule.structured).not.toHaveProperty("negotiation_mode");
    const projectedPublicPrice = servicePolicies(effective.data as any);
    expect(projectedPublicPrice).toEqual([
      expect.objectContaining({
        rule_id: firstServiceRule.id,
        price_mode: "owner_review",
        quoteable: false,
        negotiable: false,
        public_price: {
          amount: "149.00",
          currency: "USD",
          qualifier: "exact",
        },
        duration_min: 90,
      }),
    ]);
    expect(priceRules(effective.data as any)).toEqual([]);
    expect(effective.data!.some((row) => "source_call_id" in row.structured)).toBe(false);

    const duplicateSubmit = await owner.rpc("submit_company_discovery", {
      p_url: "https://example.com/services",
      p_idempotency_key: "stage0-owner-duplicate-service",
    });
    expect(duplicateSubmit.error).toBeNull();
    const duplicateJob = String(duplicateSubmit.data);
    const duplicateClaimResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: `stage0-worker-${randomUUID()}`,
      p_adapter_id: "direct_model",
      p_lease_seconds: 300,
    });
    expect(duplicateClaimResult.error).toBeNull();
    const duplicateClaim = duplicateClaimResult.data![0] as ClaimedAttempt;
    expect(duplicateClaim.job_id).toBe(duplicateJob);
    expect(duplicateClaim.adapter_id).toBe("direct_model");
    const falseOpenClawBinding = await service.rpc("bind_company_discovery_runtime", {
      p_attempt_id: duplicateClaim.attempt_id,
      p_fence_generation: duplicateClaim.fence_generation,
      p_claim_token: duplicateClaim.claim_token,
      p_runtime_identity: runtimeIdentity(`false-direct-cell-${randomUUID()}`, 30_900),
    });
    expect(falseOpenClawBinding.error?.message).toContain(
      "company_discovery_runtime_identity_invalid",
    );
    const duplicateRuntime = await bindClaim(duplicateClaim, `duplicate-${randomUUID()}`);
    const duplicateCommit = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: duplicateClaim.attempt_id,
      p_fence_generation: duplicateClaim.fence_generation,
      p_claim_token: duplicateClaim.claim_token,
      p_result: resultPayload,
      p_result_hash: postgresJsonbHash(resultPayload),
    });
    expect(duplicateCommit.error).toBeNull();
    const duplicateCommitted = duplicateCommit.data as CommittedResult;
    const duplicateResult = duplicateCommitted.result_id;
    expect((await service.rpc("select_company_discovery_result", {
      p_job_id: duplicateJob,
      p_attempt_id: duplicateClaim.attempt_id,
      p_expected_version: duplicateCommitted.job_version,
    })).error).toBeNull();
    const duplicateClaims = await owner.from("discovery_claims")
      .select("id,claim_class,evidence_refs")
      .eq("result_id", duplicateResult);
    expect(duplicateClaims.error).toBeNull();
    const duplicateByClass = Object.fromEntries(
      duplicateClaims.data!.map((row) => [row.claim_class, row]),
    ) as Record<string, { id: string; evidence_refs: string[] }>;
    const duplicateNonce = await owner.rpc("create_company_discovery_review_nonce", {
      p_job: duplicateJob,
      p_result: duplicateResult,
      p_claim_ids: duplicateClaims.data!.map((row) => row.id),
    });
    expect(duplicateNonce.error).toBeNull();
    const duplicateEditedService = {
      ...(resultPayload.candidate_facts[1]!.normalized_value as Record<string, unknown>),
      public_price: {
        amount: "175.00",
        currency: "USD",
        qualifier: "starting_at",
      },
    };
    const duplicateReview = await owner.rpc("review_company_discovery_claims", {
      p_job: duplicateJob,
      p_result: duplicateResult,
      p_expected_version: 4,
      p_decisions: [{
        claim_id: duplicateByClass.descriptive.id,
        decision: "approve",
      }, {
        claim_id: duplicateByClass.operational.id,
        decision: "edit",
        value: duplicateEditedService,
        group_confirmed: true,
      }, {
        claim_id: duplicateByClass.safety_critical.id,
        decision: "approve",
        group_confirmed: true,
        evidence_acknowledged: true,
        acknowledged_evidence_refs: duplicateByClass.safety_critical.evidence_refs,
      }],
      p_confirmation_nonce: String(duplicateNonce.data),
    });
    expect(duplicateReview.error).toBeNull();
    const crossKindDirectCleanup = await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: duplicateClaim.attempt_id,
      p_fence_generation: duplicateClaim.fence_generation,
      p_claim_token: duplicateClaim.claim_token,
      p_proof: completeOpenClawCleanupProof,
    });
    expect(crossKindDirectCleanup.error?.message).toContain(
      "company_discovery_cleanup_proof_kind_invalid",
    );
    expect((await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: duplicateClaim.attempt_id,
      p_fence_generation: duplicateClaim.fence_generation,
      p_claim_token: duplicateClaim.claim_token,
      p_proof: completeDirectCleanupProof,
    })).error).toBeNull();
    expect(await runDisposableLocalSql(`
      select count(*)::text || '|' ||
        count(*) filter (where resource_kind = 'socket_identifier')::text || '|' ||
        count(*) filter (where released_at is not null)::text
      from public.worker_runtime_resource_reservations
      where attempt_id = ${localSqlUuid(duplicateClaim.attempt_id)};
    `)).toBe("1|1|1");
    expect(duplicateRuntime).toEqual(expect.objectContaining({
      runtime_kind: "direct_model_subscription",
    }));
    const singularService = await owner.from("effective_rules")
      .select("rule_group_id,version,category,structured")
      .eq("tenant_id", ownerTenant)
      .eq("category", "preco");
    expect(singularService.error).toBeNull();
    expect(singularService.data).toHaveLength(1);
    expect(singularService.data![0]).toMatchObject({
      rule_group_id: firstServiceRule.rule_group_id,
      version: 2,
      structured: {
        source_job_id: duplicateJob,
        source_result_id: duplicateResult,
        price_mode: "owner_review",
        quoteable: false,
        negotiable: false,
        public_price: {
          amount: "175.00",
          currency: "USD",
          qualifier: "starting_at",
        },
      },
    });

    const failureSubmit = await owner.rpc("submit_company_discovery", {
      p_url: "https://failure.example.com/",
      p_idempotency_key: "stage0-explicit-failure",
    });
    expect(failureSubmit.error).toBeNull();
    const failureJob = String(failureSubmit.data);
    const failureClaimResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: `stage0-failure-${randomUUID()}`,
      p_adapter_id: "openclaw",
      p_lease_seconds: 300,
    });
    expect(failureClaimResult.error).toBeNull();
    const failureClaim = failureClaimResult.data![0] as ClaimedAttempt;
    expect(failureClaim.job_id).toBe(failureJob);
    await bindClaim(failureClaim, `failure-${randomUUID()}`);
    const terminalized = await service.rpc("terminalize_company_discovery_attempt", {
      p_attempt_id: failureClaim.attempt_id,
      p_fence_generation: failureClaim.fence_generation,
      p_claim_token: failureClaim.claim_token,
      p_outcome: "failed",
      p_reason: "adapter_failed",
    });
    expect(terminalized.error).toBeNull();
    expect(terminalized.data).toMatchObject({
      job_id: failureJob,
      attempt_id: failureClaim.attempt_id,
      runtime_slot_id: failureClaim.runtime_slot_id,
      job_version: 3,
      fence_generation: failureClaim.fence_generation + 1,
      status: "failed",
      cleanup_state: "pending",
    });
    const terminalAuthority = terminalized.data as {
      fence_generation: number;
      claim_token: string;
      job_version: number;
    };

    const terminalAttemptAuthority = await service.from("worker_attempts")
      .select("claim_token_hash,fence_generation")
      .eq("id", failureClaim.attempt_id)
      .single();
    expect(terminalAttemptAuthority.error).toBeNull();
    expect(typeof terminalAuthority.claim_token).toBe("string");
    expect(terminalAuthority.claim_token).not.toBe(failureClaim.claim_token);
    expect(String(terminalAttemptAuthority.data?.claim_token_hash).replace(/^\\x/, ""))
      .toBe(createHash("sha256").update(terminalAuthority.claim_token, "utf8").digest("hex"));
    expect(terminalAttemptAuthority.data?.fence_generation).toBe(
      terminalAuthority.fence_generation,
    );
    const terminalLateCommit = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: failureClaim.attempt_id,
      p_fence_generation: failureClaim.fence_generation,
      p_claim_token: failureClaim.claim_token,
      p_result: resultPayload,
      p_result_hash: postgresJsonbHash(resultPayload),
    });
    expect(terminalLateCommit.error).not.toBeNull();
    const staleTerminalCleanup = await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: failureClaim.attempt_id,
      p_fence_generation: failureClaim.fence_generation,
      p_claim_token: failureClaim.claim_token,
      p_proof: completeOpenClawCleanupProof,
    });
    expect(staleTerminalCleanup.error?.message).toContain("company_discovery_stale_fence");
    const terminalCleanup = await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: failureClaim.attempt_id,
      p_fence_generation: terminalAuthority.fence_generation,
      p_claim_token: terminalAuthority.claim_token,
      p_proof: { ...completeOpenClawCleanupProof, identity_process_absent: false },
    });
    expect(terminalCleanup.error).toBeNull();
    expect(terminalCleanup.data).toMatchObject({
      cleanup_state: "cleanup_unresolved",
      slot_updated: true,
    });
    expect((await service.from("worker_runtime_slots")
      .select("status,quarantine_reason")
      .eq("id", failureClaim.runtime_slot_id)
      .single()).data).toEqual({
        status: "quarantined",
        quarantine_reason: "cleanup_unresolved",
      });
    const failureRetry = await owner.rpc("retry_company_discovery", {
      p_job: failureJob,
      p_expected_version: terminalAuthority.job_version,
    });
    expect(failureRetry.error).toBeNull();
    const failureReplacementResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: `stage0-failure-replacement-${randomUUID()}`,
      p_adapter_id: "direct_model",
      p_lease_seconds: 300,
    });
    expect(failureReplacementResult.error).toBeNull();
    const failureReplacement = failureReplacementResult.data![0] as ClaimedAttempt;
    expect(failureReplacement.job_id).toBe(failureJob);
    expect(failureReplacement.runtime_slot_id).not.toBe(failureClaim.runtime_slot_id);
    await bindClaim(failureReplacement, `failure-replacement-${randomUUID()}`);

    const expiredSubmit = await owner.rpc("submit_company_discovery", {
      p_url: "https://expired.example.com/",
      p_idempotency_key: "stage0-expired-cleanup",
    });
    expect(expiredSubmit.error).toBeNull();
    const expiredJob = String(expiredSubmit.data);
    const expiredWorker = `stage0-expired-${randomUUID()}`;
    const expiredClaimResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: expiredWorker,
      p_adapter_id: "openclaw",
      p_lease_seconds: 1,
    });
    expect(expiredClaimResult.error).toBeNull();
    const expiredClaim = expiredClaimResult.data![0] as ClaimedAttempt;
    expect(expiredClaim.job_id).toBe(expiredJob);
    const expiredRuntime = await bindClaim(expiredClaim, `expired-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const expiredCleanupClaimResult = await service.rpc(
      "claim_expired_company_discovery_cleanup",
      {
        p_worker_id: expiredWorker,
        p_lease_seconds: 300,
      },
    );
    expect(expiredCleanupClaimResult.error).toBeNull();
    expect(expiredCleanupClaimResult.data).toHaveLength(1);
    const expiredAuthority = expiredCleanupClaimResult.data![0] as {
      job_id: string;
      attempt_id: string;
      adapter_id: string;
      runtime_slot_id: string;
      runtime_identity: Record<string, unknown>;
      fence_generation: number;
      claim_token: string;
      job_version: number;
      recovery_outcome: string;
    };
    expect(expiredAuthority).toMatchObject({
      job_id: expiredJob,
      attempt_id: expiredClaim.attempt_id,
      adapter_id: "openclaw",
      runtime_slot_id: expiredClaim.runtime_slot_id,
      runtime_identity: expiredRuntime,
      fence_generation: expiredClaim.fence_generation + 1,
      job_version: 3,
      recovery_outcome: "cleanup_claimed",
    });
    expect(expiredAuthority.claim_token).not.toBe(expiredClaim.claim_token);
    const expiredOldCommit = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: expiredClaim.attempt_id,
      p_fence_generation: expiredClaim.fence_generation,
      p_claim_token: expiredClaim.claim_token,
      p_result: resultPayload,
      p_result_hash: postgresJsonbHash(resultPayload),
    });
    expect(expiredOldCommit.error).not.toBeNull();
    const expiredOldTerminalize = await service.rpc("terminalize_company_discovery_attempt", {
      p_attempt_id: expiredClaim.attempt_id,
      p_fence_generation: expiredClaim.fence_generation,
      p_claim_token: expiredClaim.claim_token,
      p_outcome: "failed",
      p_reason: "stale_worker",
    });
    expect(expiredOldTerminalize.error).not.toBeNull();
    const expiredOldCleanup = await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: expiredClaim.attempt_id,
      p_fence_generation: expiredClaim.fence_generation,
      p_claim_token: expiredClaim.claim_token,
      p_proof: completeOpenClawCleanupProof,
    });
    expect(expiredOldCleanup.error?.message).toContain("company_discovery_stale_fence");
    const expiredCleanup = await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: expiredAuthority.attempt_id,
      p_fence_generation: expiredAuthority.fence_generation,
      p_claim_token: expiredAuthority.claim_token,
      p_proof: completeOpenClawCleanupProof,
    });
    expect(expiredCleanup.error).toBeNull();
    expect(expiredCleanup.data).toMatchObject({
      cleanup_state: "proved",
      slot_updated: true,
    });
    const expiredRetry = await owner.rpc("retry_company_discovery", {
      p_job: expiredJob,
      p_expected_version: expiredAuthority.job_version,
    });
    expect(expiredRetry.error).toBeNull();
    const expiredReplacementResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: `stage0-expired-replacement-${randomUUID()}`,
      p_adapter_id: "openclaw",
      p_lease_seconds: 300,
    });
    expect(expiredReplacementResult.error).toBeNull();
    const expiredReplacement = expiredReplacementResult.data![0] as ClaimedAttempt;
    expect(expiredReplacement.job_id).toBe(expiredJob);
    expect(expiredReplacement.runtime_slot_id).not.toBe(expiredClaim.runtime_slot_id);
    await bindClaim(expiredReplacement, `expired-replacement-${randomUUID()}`);

    const retrySubmit = await owner.rpc("submit_company_discovery", {
      p_url: "https://example.org/",
      p_idempotency_key: "stage0-owner-retry",
    });
    expect(retrySubmit.error).toBeNull();
    const retryJob = String(retrySubmit.data);
    const retryClaimResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: `stage0-worker-${randomUUID()}`,
      p_adapter_id: "openclaw",
      p_lease_seconds: 300,
    });
    expect(retryClaimResult.error).toBeNull();
    const oldAttempt = retryClaimResult.data![0] as ClaimedAttempt;
    expect(oldAttempt.job_id).toBe(retryJob);
    await bindClaim(oldAttempt, `retry-old-${randomUUID()}`);
    const oldAttemptRow = await service.from("worker_attempts")
      .select("runtime_slot_id")
      .eq("id", oldAttempt.attempt_id)
      .single();
    expect(oldAttemptRow.error).toBeNull();
    const oldSlotId = oldAttemptRow.data!.runtime_slot_id;
    const oldCommit = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: oldAttempt.attempt_id,
      p_fence_generation: oldAttempt.fence_generation,
      p_claim_token: oldAttempt.claim_token,
      p_result: resultPayload,
      p_result_hash: postgresJsonbHash(resultPayload),
    });
    expect(oldCommit.error).toBeNull();
    const oldCommitted = oldCommit.data as CommittedResult;
    const oldResultId = oldCommitted.result_id;
    expect((await service.rpc("select_company_discovery_result", {
      p_job_id: retryJob,
      p_attempt_id: oldAttempt.attempt_id,
      p_expected_version: oldCommitted.job_version,
    })).error).toBeNull();
    const oldClaims = await owner.from("discovery_claims")
      .select("id")
      .eq("result_id", oldResultId);
    expect(oldClaims.error).toBeNull();
    const oldNonce = await owner.rpc("create_company_discovery_review_nonce", {
      p_job: retryJob,
      p_result: oldResultId,
      p_claim_ids: oldClaims.data!.map((row) => row.id),
    });
    expect(oldNonce.error).toBeNull();
    const cancelled = await owner.rpc("cancel_company_discovery", {
      p_job: retryJob,
      p_expected_version: 4,
    });
    expect(cancelled.error).toBeNull();
    const cancelledJob = await owner.from("worker_jobs")
      .select("status,version,selected_attempt_id,current_attempt_id")
      .eq("id", retryJob)
      .single();
    expect(cancelledJob.data).toEqual({
      status: "cancelled",
      version: 5,
      selected_attempt_id: null,
      current_attempt_id: oldAttempt.attempt_id,
    });
    expect((await service.from("worker_attempts")
      .select("status")
      .eq("id", oldAttempt.attempt_id)
      .single()).data?.status).toBe("superseded");
    const invalidatedNonce = await owner.from("company_discovery_review_nonces")
      .select("invalidated_at")
      .eq("job_id", retryJob)
      .single();
    expect(invalidatedNonce.error).toBeNull();
    expect(invalidatedNonce.data?.invalidated_at).not.toBeNull();
    const slotAfterCancel = await service.from("worker_runtime_slots")
      .select("status,current_attempt_id")
      .eq("id", oldSlotId)
      .single();
    expect(slotAfterCancel.data).toEqual({
      status: "busy",
      current_attempt_id: oldAttempt.attempt_id,
    });
    const cancelledReview = await owner.rpc("review_company_discovery_claims", {
      p_job: retryJob,
      p_result: oldResultId,
      p_expected_version: 5,
      p_decisions: [],
      p_confirmation_nonce: String(oldNonce.data),
    });
    expect(cancelledReview.error?.message).toContain(
      "company_discovery_review_not_awaiting",
    );
    const lateCommit = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: oldAttempt.attempt_id,
      p_fence_generation: oldAttempt.fence_generation,
      p_claim_token: oldAttempt.claim_token,
      p_result: resultPayload,
      p_result_hash: postgresJsonbHash(resultPayload),
    });
    expect(lateCommit.error?.message).toContain("company_discovery_attempt_terminal");
    const retried = await owner.rpc("retry_company_discovery", {
      p_job: retryJob,
      p_expected_version: 5,
    });
    expect(retried.error).toBeNull();
    const directWorker = `stage0-direct-${randomUUID()}`;
    expect((await service.from("worker_runtime_slots").insert({
      slot_name: `${directWorker}:direct_model`,
      supervisor_worker_id: directWorker,
      adapter_id: "direct_model",
    })).error).toBeNull();
    const newClaimResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: directWorker,
      p_adapter_id: "direct_model",
      p_lease_seconds: 300,
    });
    expect(newClaimResult.error).toBeNull();
    const newAttempt = newClaimResult.data![0] as ClaimedAttempt;
    expect(newAttempt.job_id).toBe(retryJob);
    expect(newAttempt.attempt_id).not.toBe(oldAttempt.attempt_id);
    expect(newAttempt.fence_generation).toBe(oldAttempt.fence_generation + 3);
    await bindClaim(newAttempt, `retry-new-${randomUUID()}`);
    const directAttempt = await service.from("worker_attempts")
      .select("adapter_id,runtime_slot_id")
      .eq("id", newAttempt.attempt_id)
      .single();
    expect(directAttempt.error).toBeNull();
    expect(directAttempt.data?.adapter_id).toBe("direct_model");
    const newSlotId = directAttempt.data!.runtime_slot_id;
    const prematureCleanup = await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: newAttempt.attempt_id,
      p_fence_generation: newAttempt.fence_generation,
      p_claim_token: newAttempt.claim_token,
      p_proof: {},
    });
    expect(prematureCleanup.error?.message).toContain(
      "company_discovery_cleanup_attempt_not_terminal",
    );
    const wrongJobAttempt = await service.rpc("select_company_discovery_result", {
      p_job_id: retryJob,
      p_attempt_id: claim.attempt_id,
      p_expected_version: 7,
    });
    expect(wrongJobAttempt.error?.message).toContain("company_discovery_attempt_not_current");
    const staleOldAttempt = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: oldAttempt.attempt_id,
      p_fence_generation: oldAttempt.fence_generation,
      p_claim_token: oldAttempt.claim_token,
      p_result: resultPayload,
      p_result_hash: postgresJsonbHash(resultPayload),
    });
    expect(staleOldAttempt.error?.message).toContain("company_discovery_attempt_terminal");
    const cleanupProof = {
      gateway_exited: true,
      container_removed: true,
      bridge_removed: true,
      config_removed: true,
      state_removed: true,
      workspace_removed: true,
      output_removed: true,
      network_removed: true,
      credential_material_removed: true,
      subscription_lease_revoked: true,
      subscription_requests_drained: true,
      subscription_listener_closed: true,
      subscription_socket_absent: true,
      listener_closed: true,
      identity_process_absent: true,
      late_result_rejected: true,
    };
    const lateCleanup = await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: oldAttempt.attempt_id,
      p_fence_generation: oldAttempt.fence_generation,
      p_claim_token: oldAttempt.claim_token,
      p_proof: cleanupProof,
    });
    expect(lateCleanup.error).toBeNull();
    expect(lateCleanup.data).toMatchObject({
      attempt_id: oldAttempt.attempt_id,
      cleanup_state: "proved",
      slot_updated: true,
    });
    expect((await service.from("worker_runtime_slots")
      .select("status,current_attempt_id")
      .eq("id", oldSlotId)
      .single()).data).toEqual({ status: "available", current_attempt_id: null });
    expect((await service.from("worker_runtime_slots")
      .select("status,current_attempt_id")
      .eq("id", newSlotId)
      .single()).data).toEqual({
        status: "busy",
        current_attempt_id: newAttempt.attempt_id,
      });
    const v2Fact = (
      claimClass: "descriptive" | "operational" | "safety_critical",
      claimType: string,
      value: unknown,
      overrides: Record<string, unknown> = {},
    ) => ({
      claim_class: claimClass,
      claim_type: claimType,
      normalized_value: value,
      evidence_refs: [0],
      confidence: "high",
      contradiction_status: "none",
      contradictions: [],
      missing_fields: [],
      ambiguous_fields: [],
      uncertainty: [],
      claim_schema_version: "company_discovery.claim.v2",
      ...overrides,
    });
    const directV2Result = {
      schema_version: "company_discovery.result.v2",
      source_snapshots: resultPayload.source_snapshots,
      candidate_facts: [
        v2Fact("descriptive", "business_name", "Example Plumbing"),
        v2Fact("operational", "service_territory", {
          service_type: null,
          included_areas: [{
            kind: "marketing_region",
            name: "the whole Bay Area",
            region_state: "CA",
            country_code: "US",
          }],
          excluded_areas: [],
          radius: null,
        }),
        v2Fact("operational", "business_hours", {
          timezone: "America/Los_Angeles",
          ordinary_intervals: [{
            days: ["mon", "tue", "wed", "thu", "fri"],
            opens: "08:00",
            closes: "17:00",
          }],
          closed_days: ["sat", "sun"],
          ordinary_24_7: false,
          emergency_24_7: false,
          after_hours: "unavailable",
          holiday_policy: null,
        }, { missing_fields: ["holiday_policy"] }),
        v2Fact("operational", "guarantee", {
          guarantee_kind: "satisfaction_statement",
          service_type: null,
          coverage: ["satisfaction"],
          duration: null,
          conditions: ["Satisfaction guaranteed"],
          exclusions: [],
        }),
        v2Fact("operational", "booking_restriction", {
          restriction_type: "sunday",
          service_type: null,
          rule: "not_allowed",
          notice_minutes: null,
          public_fee: null,
          conditions: ["No Sunday appointments"],
        }),
        v2Fact("safety_critical", "emergency", {
          guidance: "Leave the property and call 911 for a gas emergency.",
        }),
      ],
      missing_questions: ["Qual é o preço mínimo privado autorizado?"],
      contradictions: [],
      uncertainty: [],
    };
    const newCommit = await service.rpc("commit_company_discovery_result_v2", {
      p_attempt_id: newAttempt.attempt_id,
      p_fence_generation: newAttempt.fence_generation,
      p_claim_token: newAttempt.claim_token,
      p_result: directV2Result,
      p_result_hash: postgresJsonbHash(directV2Result),
    });
    expect(newCommit.error).toBeNull();
    const newCommitted = newCommit.data as CommittedResult;
    const replacementSelect = await service.rpc("select_company_discovery_result", {
      p_job_id: retryJob,
      p_attempt_id: newAttempt.attempt_id,
      p_expected_version: newCommitted.job_version,
    });
    expect(replacementSelect.error).toBeNull();
    const rulesBeforeV2Review = Number(await runDisposableLocalSql(`
      select count(*)::text from public.rules
      where tenant_id = ${localSqlUuid(ownerTenant)};
    `));
    const v2Claims = await owner.from("discovery_claims")
      .select("id,claim_class,claim_type,evidence_refs,adapter_id,provider,model,confidence,contradiction_status,missing_fields,ambiguous_fields,claim_schema_version")
      .eq("result_id", newCommitted.result_id)
      .order("claim_type", { ascending: true });
    expect(v2Claims.error).toBeNull();
    expect(v2Claims.data).toHaveLength(6);
    expect(v2Claims.data!.every((row) =>
      row.adapter_id === "direct_model" && row.provider === "openai-codex" &&
      row.model === "gpt-5.6-sol" && row.claim_schema_version ===
        "company_discovery.claim.v2"
    )).toBe(true);
    expect((await intruder.from("discovery_claims")
      .select("id").eq("result_id", newCommitted.result_id)).data).toEqual([]);
    const partialClaim = v2Claims.data![0]!;
    const partialNonce = await owner.rpc("create_company_discovery_review_nonce", {
      p_job: retryJob,
      p_result: newCommitted.result_id,
      p_claim_ids: [partialClaim.id],
    });
    expect(partialNonce.error).toBeNull();
    const partialReview = await owner.rpc("review_company_discovery_claims_v2", {
      p_job: retryJob,
      p_result: newCommitted.result_id,
      p_expected_version: replacementSelect.data.version,
      p_decisions: [{
        claim_id: partialClaim.id,
        decision: "approve",
        value: directV2Result.candidate_facts.find((fact) =>
          fact.claim_type === partialClaim.claim_type
        )!.normalized_value,
        group_confirmed: partialClaim.claim_class !== "descriptive",
        evidence_acknowledged: partialClaim.claim_class === "safety_critical",
        acknowledged_evidence_refs: partialClaim.claim_class === "safety_critical"
          ? partialClaim.evidence_refs
          : [],
      }],
      p_confirmation_nonce: String(partialNonce.data),
    });
    expect(partialReview.error?.message).toContain(
      "company_discovery_review_claim_set_mismatch",
    );
    expect((await owner.from("company_discovery_onboarding_drafts")
      .select("id").eq("source_result_id", newCommitted.result_id)).data).toEqual([]);
    const v2Nonce = await owner.rpc("create_company_discovery_review_nonce", {
      p_job: retryJob,
      p_result: newCommitted.result_id,
      p_claim_ids: v2Claims.data!.map((row) => row.id),
    });
    expect(v2Nonce.error).toBeNull();
    const v2Review = await owner.rpc("review_company_discovery_claims_v2", {
      p_job: retryJob,
      p_result: newCommitted.result_id,
      p_expected_version: replacementSelect.data.version,
      p_decisions: v2Claims.data!.map((row) => {
        const original = directV2Result.candidate_facts.find((fact) =>
          fact.claim_type === row.claim_type
        )!.normalized_value;
        return {
          claim_id: row.id,
          decision: row.claim_type === "booking_restriction"
            ? "reject"
            : row.claim_type === "business_hours" ? "edit" : "approve",
          value: row.claim_type === "business_hours"
            ? { ...(original as Record<string, unknown>), holiday_policy: "Closed on federal holidays" }
            : original,
          group_confirmed: row.claim_class !== "descriptive",
          evidence_acknowledged: row.claim_class === "safety_critical",
          acknowledged_evidence_refs: row.claim_class === "safety_critical"
            ? row.evidence_refs
            : [],
        };
      }),
      p_confirmation_nonce: String(v2Nonce.data),
    });
    expect(v2Review.error).toBeNull();
    const v2DraftId = String(v2Review.data.onboarding_draft_id);
    const v2DraftHash = String(v2Review.data.onboarding_draft_hash);
    expect(v2DraftId).toMatch(UUID_PATTERN);
    expect(v2DraftHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v2Review.data).toMatchObject({
      reviewed: 6,
      authority: {
        rules_approved: false,
        powers_granted: false,
        operational_mode_changed: false,
      },
    });
    expect(Number(await runDisposableLocalSql(`
      select count(*)::text from public.rules
      where tenant_id = ${localSqlUuid(ownerTenant)};
    `))).toBe(rulesBeforeV2Review);
    expect((await owner.from("effective_rules")
      .select("id").eq("tenant_id", ownerTenant)).data).toHaveLength(2);
    const draftRows = await owner.from("company_discovery_onboarding_drafts")
      .select("id,version,draft_hash,draft,source_job_id,source_result_id")
      .eq("id", v2DraftId);
    expect(draftRows.error).toBeNull();
    expect(draftRows.data).toHaveLength(1);
    expect(draftRows.data![0]!.draft).toMatchObject({
      schema_version: "company_discovery.onboarding_draft.v1",
      source_job_id: retryJob,
      source_result_id: newCommitted.result_id,
      authority: {
        rules_approved: false,
        powers_granted: false,
        operational_mode_changed: false,
      },
    });
    expect(draftRows.data![0]!.draft.approved_facts).toHaveLength(5);
    expect(draftRows.data![0]!.draft.rejected_claim_ids).toHaveLength(1);
    const reviewedHours = draftRows.data![0]!.draft.approved_facts.find(
      (fact: Record<string, unknown>) => fact.claim_type === "business_hours",
    );
    expect(reviewedHours).toMatchObject({
      decision: "edit",
      edited_by_owner: true,
      missing_fields: [],
      website_missing_fields: ["holiday_policy"],
    });
    expect((await intruder.from("company_discovery_onboarding_drafts")
      .select("id").eq("id", v2DraftId)).data).toEqual([]);
    const draftReadback = await service.rpc(
      "read_company_discovery_onboarding_draft",
      { p_tenant: ownerTenant, p_owner: ownerId },
    );
    expect(draftReadback.error).toBeNull();
    expect(draftReadback.data).toMatchObject({
      draft_id: v2DraftId,
      draft_hash: v2DraftHash,
    });
    expect((await owner.rpc("read_company_discovery_onboarding_draft", {
      p_tenant: ownerTenant,
      p_owner: ownerId,
    })).error).not.toBeNull();

    const prefillCall = randomUUID();
    const prefillRequest = randomUUID();
    expect((await service.from("calls").insert({
      id: prefillCall,
      tenant_id: ownerTenant,
      channel: "browser",
      session_type: "onboarding",
      status: "active",
    })).error).toBeNull();
    expect((await service.from("browser_session_requests").insert({
      id: prefillRequest,
      tenant_id: ownerTenant,
      user_id: ownerId,
      session_type: "onboarding",
      offer_sdp: `stage0b-offer-${prefillRequest}`,
    })).error).toBeNull();
    expect((await service.from("browser_session_requests").update({
      status: "ready",
      answer_sdp: `stage0b-answer-${prefillRequest}`,
      call_id: prefillCall,
      handled_at: new Date().toISOString(),
    }).eq("id", prefillRequest)).error).toBeNull();
    const { buildCompanyDiscoveryPrefill } = await import(
      "../src/company-discovery-prefill.ts"
    );
    const prefillProjection = buildCompanyDiscoveryPrefill({
      tenant_id: ownerTenant,
      call_id: prefillCall,
      draft_readback: draftReadback.data,
      localities: [],
    });
    const initializedPrefill = await service.rpc(
      "initialize_company_discovery_onboarding_prefill",
      {
        p_tenant: ownerTenant,
        p_target_call: prefillCall,
        p_owner: ownerId,
        p_draft: prefillProjection.draft_id,
        p_coverage: prefillProjection.coverage,
      },
    );
    expect(initializedPrefill.error).toBeNull();
    const prefillReceiptId = String(initializedPrefill.data.coverage_receipt_id);
    const prefillDigest = String(initializedPrefill.data.snapshot_digest);
    expect(prefillReceiptId).toMatch(UUID_PATTERN);
    expect(prefillDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(initializedPrefill.data).toMatchObject({
      status: "initialized",
      draft_id: prefillProjection.draft_id,
      revision: 1,
    });
    expect(initializedPrefill.data.coverage).toMatchObject({
      transition_kind: "discovery_prefill",
      selected_rule_ids: [],
      materializations: [],
      authority: {
        rules_approved: false,
        powers_granted: false,
        operational_mode_changed: false,
      },
    });
    expect((await service.from("receipts")
      .select("id,readback,detail")
      .eq("id", prefillReceiptId).single()).data)
      .toMatchObject({
        readback: { transition_kind: "discovery_prefill", revision: 1 },
        detail: {
          transition_kind: "discovery_prefill",
          draft_id: prefillProjection.draft_id,
        },
      });
    const unresolvedCleanup = await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: newAttempt.attempt_id,
      p_fence_generation: newAttempt.fence_generation,
      p_claim_token: newAttempt.claim_token,
      p_proof: { ...completeDirectCleanupProof, subscription_socket_absent: false },
    });
    expect(unresolvedCleanup.error).toBeNull();
    expect(unresolvedCleanup.data).toMatchObject({
      cleanup_state: "cleanup_unresolved",
      slot_updated: true,
    });
    expect((await service.from("worker_runtime_slots")
      .select("status,current_attempt_id,quarantine_reason")
      .eq("id", newSlotId)
      .single()).data).toEqual({
        status: "quarantined",
        current_attempt_id: null,
        quarantine_reason: "cleanup_unresolved",
      });
  },
);

test.skipIf(process.env.LIGOU_LOCAL_DB_TEST !== "1")(
  "real Postgres recovers cleanup authority races while releasing only proved loopback endpoints",
  async () => {
    const apiUrl = process.env.SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SECRET_KEY!;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY!;
    const serviceA = createClient(apiUrl, serviceKey, { auth: { persistSession: false } });
    const serviceB = createClient(apiUrl, serviceKey, { auth: { persistSession: false } });
    const owner = createClient(apiUrl, publishableKey, { auth: { persistSession: false } });
    const ambiguousOwner = createClient(apiUrl, publishableKey, {
      auth: { persistSession: false },
    });
    const ownerEmail = `discovery-recovery-${randomUUID()}@example.invalid`;
    const ownerPassword = `Recovery-${randomUUID()}-Aa1!`;
    const ambiguousEmail = `discovery-ambiguous-${randomUUID()}@example.invalid`;
    const ambiguousPassword = `Ambiguous-${randomUUID()}-Aa1!`;
    const ownerTenant = randomUUID();
    const ambiguousTenantA = randomUUID();
    const ambiguousTenantB = randomUUID();

    const ownerCreated = await serviceA.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
    });
    const ambiguousCreated = await serviceA.auth.admin.createUser({
      email: ambiguousEmail,
      password: ambiguousPassword,
      email_confirm: true,
    });
    expect(ownerCreated.error).toBeNull();
    expect(ambiguousCreated.error).toBeNull();
    const ownerId = ownerCreated.data.user!.id;
    const ambiguousId = ambiguousCreated.data.user!.id;
    expect((await serviceA.from("tenants").insert([{
      id: ownerTenant,
      slug: `discovery-recovery-${ownerTenant.slice(0, 8)}`,
      name: "Discovery Recovery Owner",
      owner_user_id: ownerId,
      status: "onboarding",
      operational_mode: "simulation_only",
    }, {
      id: ambiguousTenantA,
      slug: `discovery-ambiguous-a-${ambiguousTenantA.slice(0, 8)}`,
      name: "Discovery Ambiguous A",
      owner_user_id: ambiguousId,
      status: "onboarding",
      operational_mode: "simulation_only",
    }, {
      id: ambiguousTenantB,
      slug: `discovery-ambiguous-b-${ambiguousTenantB.slice(0, 8)}`,
      name: "Discovery Ambiguous B",
      owner_user_id: ambiguousId,
      status: "onboarding",
      operational_mode: "simulation_only",
    }])).error).toBeNull();
    expect((await serviceA.from("company_discovery_subscription_bindings").insert({
      tenant_id: ownerTenant,
      credential_owner_id: randomUUID(),
      expected_account_hash: "3".repeat(64),
      credential_generation: 1,
      active: true,
    })).error).toBeNull();
    expect((await serviceA.from("company_discovery_controls")
      .update({ enabled: true }).eq("singleton", true)).error).toBeNull();
    expect((await serviceA.from("company_discovery_allowlist").insert({
      tenant_id: ownerTenant,
      active: true,
    })).error).toBeNull();
    expect((await owner.auth.signInWithPassword({
      email: ownerEmail,
      password: ownerPassword,
    })).error).toBeNull();
    expect((await ambiguousOwner.auth.signInWithPassword({
      email: ambiguousEmail,
      password: ambiguousPassword,
    })).error).toBeNull();

    await runDisposableLocalSql(`
      update public.company_discovery_allowlist
      set created_at = clock_timestamp() - interval '2 hours',
          expires_at = clock_timestamp() - interval '1 hour'
      where tenant_id = ${localSqlUuid(ownerTenant)};
    `);
    const expiredStatus = await owner.rpc("company_discovery_owner_status");
    expect(expiredStatus.error).toBeNull();
    expect(expiredStatus.data).toMatchObject({
      enabled: true,
      allowlisted: true,
      available: false,
    });
    expect(expiredStatus.data.expires_at).not.toBeNull();
    const ambiguousStatus = await ambiguousOwner.rpc("company_discovery_owner_status");
    expect(ambiguousStatus.error?.message).toContain(
      "company_discovery_owner_tenant_ambiguous",
    );
    expect((await serviceA.from("company_discovery_allowlist")
      .update({ expires_at: null }).eq("tenant_id", ownerTenant)).error).toBeNull();

    let identitySequence = 0;
    const nextIdentity = (
      label: string,
      port?: number,
      platform: "linux/arm64" | "linux/amd64" = "linux/arm64",
    ) => {
      identitySequence += 1;
      return runtimeIdentity(
        `${label}-${randomUUID()}`,
        port ?? 40_000 + identitySequence,
        platform,
      );
    };
    const resultPayload = (origin: string) => ({
      schema_version: "company_discovery.result.v1",
      source_snapshots: [{
        url: origin,
        retrieved_at: "2026-09-01T10:00:00.000Z",
        http_status: 200,
        mime_type: "text/html",
        byte_length: 64,
        content_hash: "b".repeat(64),
        excerpt: "Recovery-safe discovery evidence.",
        crawl_order: 0,
        crawl_depth: 0,
      }],
      candidate_facts: [{
        claim_class: "descriptive",
        claim_type: "business_name",
        normalized_value: "Recovery Safe Company",
        evidence_refs: [0],
        contradictions: [],
        uncertainty: [],
      }],
      missing_questions: [],
      contradictions: [],
      uncertainty: [],
    });
    const submit = async (label: string, host = "recovery.example.com") => {
      const response = await owner.rpc("submit_company_discovery", {
        p_url: `https://${host}/${label}`,
        p_idempotency_key: `${label}-${randomUUID()}`,
      });
      expect(response.error).toBeNull();
      return String(response.data);
    };
    const claim = async (
      workerId: string,
      adapter: "openclaw" | "direct_model" = "openclaw",
      client = serviceA,
    ) => {
      const response = await client.rpc("claim_company_discovery_attempt", {
        p_worker_id: workerId,
        p_adapter_id: adapter,
        p_lease_seconds: 300,
      });
      expect(response.error).toBeNull();
      expect(response.data).toHaveLength(1);
      return response.data![0] as ClaimedAttempt;
    };
    const bind = async (
      claimed: ClaimedAttempt,
      identity: ReturnType<typeof runtimeIdentity>,
      client = serviceA,
    ) => client.rpc("bind_company_discovery_runtime", {
      p_attempt_id: claimed.attempt_id,
      p_fence_generation: claimed.fence_generation,
      p_claim_token: claimed.claim_token,
      p_runtime_identity: identity,
    });
    const expireLease = (attemptId: string) => runDisposableLocalSql(`
      update public.worker_attempts
      set claimed_at = clock_timestamp() - interval '2 seconds',
          lease_until = clock_timestamp() - interval '1 second'
      where id = ${localSqlUuid(attemptId)};
    `);
    const concurrentRpc = async (
      calls: Array<() => Promise<{ data: any; error: any }>>,
    ) => {
      const settled = await Promise.allSettled(calls.map((call) => call()));
      expect(settled.every((item) => item.status === "fulfilled")).toBe(true);
      return settled.map((item) => {
        if (item.status !== "fulfilled") throw item.reason;
        return item.value;
      });
    };
    const oneCleanupClaim = (responses: Array<{ data: any; error: any }>) => {
      for (const response of responses) expect(response.error).toBeNull();
      const rows = responses.flatMap((response) => response.data ?? []);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recovery_outcome).toBe("cleanup_claimed");
      expect(rows[0]?.claim_token).toEqual(expect.any(String));
      return rows[0] as CleanupRecovery & { claim_token: string };
    };

    // A claim crash before bind is database-proven absence of a bound runtime
    // identity. It needs no worker cleanup token and can immediately free only
    // its exact logical slot.
    const unboundJob = await submit("unbound-requeue");
    const unboundWorker = `stage0-unbound-${randomUUID()}`;
    const unboundClaim = await claim(unboundWorker);
    expect(unboundClaim.job_id).toBe(unboundJob);
    const unboundTerminalize = await serviceA.rpc(
      "terminalize_company_discovery_attempt",
      {
        p_attempt_id: unboundClaim.attempt_id,
        p_fence_generation: unboundClaim.fence_generation,
        p_claim_token: unboundClaim.claim_token,
        p_outcome: "failed",
        p_reason: "bind_failed",
      },
    );
    expect(unboundTerminalize.error?.message).toContain(
      "company_discovery_runtime_not_bound",
    );
    await expireLease(unboundClaim.attempt_id);
    const foreignHostRecovery = await serviceB.rpc(
      "claim_expired_company_discovery_cleanup",
      { p_worker_id: `stage0-foreign-host-${randomUUID()}`, p_lease_seconds: 300 },
    );
    expect(foreignHostRecovery.error).toBeNull();
    expect(foreignHostRecovery.data).toEqual([]);
    const unboundRecovery = await serviceA.rpc(
      "claim_expired_company_discovery_cleanup",
      { p_worker_id: unboundWorker, p_lease_seconds: 300 },
    );
    expect(unboundRecovery.error).toBeNull();
    expect(unboundRecovery.data).toHaveLength(1);
    const unboundOutcome = unboundRecovery.data![0] as CleanupRecovery;
    expect(unboundOutcome).toEqual({
      job_id: unboundJob,
      attempt_id: unboundClaim.attempt_id,
      adapter_id: "openclaw",
      runtime_slot_id: unboundClaim.runtime_slot_id,
      runtime_identity: {},
      fence_generation: unboundClaim.fence_generation + 1,
      claim_token: null,
      job_version: unboundClaim.job_version + 1,
      recovery_outcome: "runtime_not_bound",
    });
    const trulyIdleRecovery = await serviceA.rpc(
      "claim_expired_company_discovery_cleanup",
      { p_worker_id: unboundWorker, p_lease_seconds: 300 },
    );
    expect(trulyIdleRecovery.error).toBeNull();
    expect(trulyIdleRecovery.data).toEqual([]);
    const unboundAttempt = await serviceA.from("worker_attempts")
      .select("status,fence_generation,runtime_identity,runtime_identity_hash,terminal_reason,cleanup_state,cleanup_outcome,cleanup_proof")
      .eq("id", unboundClaim.attempt_id)
      .single();
    expect(unboundAttempt.error).toBeNull();
    expect(unboundAttempt.data).toEqual({
      status: "failed",
      fence_generation: unboundClaim.fence_generation + 1,
      runtime_identity: {},
      runtime_identity_hash: null,
      terminal_reason: "runtime_not_bound",
      cleanup_state: "proved",
      cleanup_outcome: "runtime_not_bound",
      cleanup_proof: {
        outcome: "runtime_not_bound",
        database_proven: true,
        runtime_identity_bound: false,
      },
    });
    expect((await serviceA.from("worker_jobs")
      .select("status,version,fence_generation,current_attempt_id")
      .eq("id", unboundJob).single()).data).toEqual({
      status: "queued",
      version: unboundClaim.job_version + 1,
      fence_generation: unboundClaim.fence_generation + 1,
      current_attempt_id: null,
    });
    expect((await serviceA.from("worker_runtime_slots")
      .select("status,tenant_id,current_attempt_id")
      .eq("id", unboundClaim.runtime_slot_id).single()).data).toEqual({
      status: "available",
      tenant_id: null,
      current_attempt_id: null,
    });
    const staleUnboundBind = await bind(
      unboundClaim,
      nextIdentity("stale-unbound"),
    );
    expect(staleUnboundBind.error).not.toBeNull();
    const staleUnboundPayload = resultPayload(unboundClaim.normalized_origin);
    const staleUnboundCommit = await serviceA.rpc("commit_company_discovery_result", {
      p_attempt_id: unboundClaim.attempt_id,
      p_fence_generation: unboundClaim.fence_generation,
      p_claim_token: unboundClaim.claim_token,
      p_result: staleUnboundPayload,
      p_result_hash: postgresJsonbHash(staleUnboundPayload),
    });
    expect(staleUnboundCommit.error).not.toBeNull();
    const staleUnboundTerminalize = await serviceA.rpc(
      "terminalize_company_discovery_attempt",
      {
        p_attempt_id: unboundClaim.attempt_id,
        p_fence_generation: unboundClaim.fence_generation,
        p_claim_token: unboundClaim.claim_token,
        p_outcome: "failed",
        p_reason: "stale_worker",
      },
    );
    expect(staleUnboundTerminalize.error).not.toBeNull();

    const reboundClaim = await claim(unboundWorker);
    expect(reboundClaim.job_id).toBe(unboundJob);
    expect(reboundClaim.attempt_id).not.toBe(unboundClaim.attempt_id);
    expect(reboundClaim.runtime_slot_id).toBe(unboundClaim.runtime_slot_id);
    const firstIdentity = nextIdentity("first-bound", undefined, "linux/amd64");
    expect((await bind(reboundClaim, firstIdentity)).error).toBeNull();
    const terminalized = await serviceA.rpc("terminalize_company_discovery_attempt", {
      p_attempt_id: reboundClaim.attempt_id,
      p_fence_generation: reboundClaim.fence_generation,
      p_claim_token: reboundClaim.claim_token,
      p_outcome: "failed",
      p_reason: "adapter_failed",
    });
    expect(terminalized.error).toBeNull();
    const terminalAuthority = terminalized.data as {
      fence_generation: number;
      claim_token: string;
      job_version: number;
    };

    // A bound endpoint stays reserved while cleanup is pending, and the
    // service role cannot bypass the cleanup RPC to retire or delete it.
    const activePortJob = await submit("active-port-collision");
    const activePortClaim = await claim(`stage0-active-port-${randomUUID()}`);
    expect(activePortClaim.job_id).toBe(activePortJob);
    const activePortCollision = await bind(activePortClaim, {
      ...nextIdentity("active-port-collision"),
      loopback_port: firstIdentity.loopback_port,
    });
    expect(activePortCollision.error?.message).toContain(
      "company_discovery_runtime_identity_conflict",
    );
    const activeSocketCollision = await bind(activePortClaim, {
      ...nextIdentity("active-socket-collision"),
      subscription_socket_path: firstIdentity.subscription_socket_path,
    });
    expect(activeSocketCollision.error?.message).toContain(
      "company_discovery_runtime_identity_conflict",
    );
    const directRelease = await serviceA
      .from("worker_runtime_resource_reservations")
      .update({ released_at: "2026-09-01T10:00:00.000Z" })
      .eq("attempt_id", reboundClaim.attempt_id)
      .eq("resource_kind", "loopback_port");
    expect(directRelease.error).not.toBeNull();
    const directDelete = await serviceA
      .from("worker_runtime_resource_reservations")
      .delete()
      .eq("attempt_id", reboundClaim.attempt_id);
    expect(directDelete.error).not.toBeNull();

    // Two independent clients race for one expired cleanup lease. SKIP LOCKED
    // gives exactly one rotated authority; losing plaintext is recoverable by
    // another lease expiry and another rotation.
    await expireLease(reboundClaim.attempt_id);
    const firstReaperRace = await concurrentRpc([
      () => serviceA.rpc("claim_expired_company_discovery_cleanup", {
        p_worker_id: unboundWorker,
        p_lease_seconds: 300,
      }),
      () => serviceB.rpc("claim_expired_company_discovery_cleanup", {
        p_worker_id: unboundWorker,
        p_lease_seconds: 300,
      }),
    ]);
    const firstReaper = oneCleanupClaim(firstReaperRace);
    expect(firstReaper).toMatchObject({
      job_id: unboundJob,
      attempt_id: reboundClaim.attempt_id,
      adapter_id: "openclaw",
      runtime_slot_id: reboundClaim.runtime_slot_id,
      runtime_identity: firstIdentity,
      fence_generation: terminalAuthority.fence_generation + 1,
      job_version: terminalAuthority.job_version,
      recovery_outcome: "cleanup_claimed",
    });
    expect(firstReaper.claim_token).not.toBe(terminalAuthority.claim_token);
    expect((await serviceA.from("worker_runtime_slots")
      .select("status,current_attempt_id")
      .eq("id", reboundClaim.runtime_slot_id).single()).data).toEqual({
      status: "quarantined",
      current_attempt_id: reboundClaim.attempt_id,
    });
    const staleTerminalCleanup = await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: reboundClaim.attempt_id,
      p_fence_generation: terminalAuthority.fence_generation,
      p_claim_token: terminalAuthority.claim_token,
      p_proof: completeOpenClawCleanupProof,
    });
    expect(staleTerminalCleanup.error?.message).toContain(
      "company_discovery_stale_fence",
    );
    const malformedCleanup = await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: reboundClaim.attempt_id,
      p_fence_generation: firstReaper.fence_generation,
      p_claim_token: firstReaper.claim_token,
      p_proof: { ...completeOpenClawCleanupProof, unexpected: true },
    });
    expect(malformedCleanup.error?.message).toContain(
      "company_discovery_cleanup_proof_kind_invalid",
    );
    expect((await serviceA.from("worker_attempts")
      .select("cleanup_state,cleanup_outcome")
      .eq("id", reboundClaim.attempt_id).single()).data).toEqual({
      cleanup_state: "pending",
      cleanup_outcome: "pending",
    });

    await expireLease(reboundClaim.attempt_id);
    const secondReaperRace = await concurrentRpc([
      () => serviceA.rpc("claim_expired_company_discovery_cleanup", {
        p_worker_id: unboundWorker,
        p_lease_seconds: 300,
      }),
      () => serviceB.rpc("claim_expired_company_discovery_cleanup", {
        p_worker_id: unboundWorker,
        p_lease_seconds: 300,
      }),
    ]);
    const secondReaper = oneCleanupClaim(secondReaperRace);
    expect(secondReaper.fence_generation).toBe(firstReaper.fence_generation + 1);
    expect(secondReaper.job_version).toBe(firstReaper.job_version);
    expect(secondReaper.claim_token).not.toBe(firstReaper.claim_token);
    expect(secondReaper.runtime_identity).toEqual(firstIdentity);
    const firstReaperStale = await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: reboundClaim.attempt_id,
      p_fence_generation: firstReaper.fence_generation,
      p_claim_token: firstReaper.claim_token,
      p_proof: completeOpenClawCleanupProof,
    });
    expect(firstReaperStale.error?.message).toContain("company_discovery_stale_fence");
    const provedCleanup = await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: reboundClaim.attempt_id,
      p_fence_generation: secondReaper.fence_generation,
      p_claim_token: secondReaper.claim_token,
      p_proof: completeOpenClawCleanupProof,
    });
    expect(provedCleanup.error).toBeNull();
    expect(provedCleanup.data).toMatchObject({
      cleanup_state: "proved",
      slot_updated: true,
    });
    expect((await serviceA.from("worker_attempts")
      .select("adapter_id,runtime_identity,runtime_identity_hash,cleanup_outcome")
      .eq("id", reboundClaim.attempt_id).single()).data).toMatchObject({
      adapter_id: "openclaw",
      runtime_identity: firstIdentity,
      runtime_identity_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      cleanup_outcome: "runtime_cleanup_proved",
    });
    const reservationKinds = await runDisposableLocalSql(`
      select string_agg(resource_kind, ',' order by resource_kind)
      from public.worker_runtime_resource_reservations
      where attempt_id = ${localSqlUuid(reboundClaim.attempt_id)};
    `);
    expect(reservationKinds).toBe([
      "bridge_container", "bridge_secret_volume", "bundle_hash", "cell_container",
      "config_identifier", "config_volume", "egress_network", "gateway_secret_volume",
      "internal_network", "loopback_port", "output_identifier", "output_volume",
      "profile", "socket_identifier", "state_volume", "workspace_volume",
    ].sort().join(","));
    const releasedReservationCounts = await runDisposableLocalSql(`
      select
        count(*) filter (
          where resource_kind in ('loopback_port', 'socket_identifier')
            and released_at is not null
        )::text || '|' ||
        count(*) filter (
          where resource_kind not in ('loopback_port', 'socket_identifier')
            and released_at is not null
        )::text
      from public.worker_runtime_resource_reservations
      where attempt_id = ${localSqlUuid(reboundClaim.attempt_id)};
    `);
    expect(releasedReservationCounts).toBe("2|0");

    const provedRetry = await owner.rpc("retry_company_discovery", {
      p_job: unboundJob,
      p_expected_version: secondReaper.job_version,
    });
    expect(provedRetry.error).toBeNull();
    const reusedSlotClaim = await claim(unboundWorker);
    expect(reusedSlotClaim.runtime_slot_id).toBe(reboundClaim.runtime_slot_id);
    expect(reusedSlotClaim.attempt_id).not.toBe(reboundClaim.attempt_id);
    const exactBundleReuse = await bind(reusedSlotClaim, firstIdentity);
    expect(exactBundleReuse.error?.message).toContain(
      "company_discovery_runtime_identity_conflict",
    );
    const containerCollisionBase = nextIdentity("container-collision");
    const containerCollision = await bind(reusedSlotClaim, {
      ...containerCollisionBase,
      cell_container_name: firstIdentity.bridge_container_name,
    });
    expect(containerCollision.error?.message).toContain(
      "company_discovery_runtime_identity_conflict",
    );
    const volumeCollisionBase = nextIdentity("volume-collision");
    const volumeCollision = await bind(reusedSlotClaim, {
      ...volumeCollisionBase,
      output_volume_name: firstIdentity.config_volume_name,
    });
    expect(volumeCollision.error?.message).toContain(
      "company_discovery_runtime_identity_conflict",
    );
    const secondIdentity = {
      ...nextIdentity("released-port-reuse"),
      loopback_port: firstIdentity.loopback_port,
      subscription_socket_path: firstIdentity.subscription_socket_path,
    };
    expect((await bind(reusedSlotClaim, secondIdentity)).error).toBeNull();

    // Commit and terminalization contend on the same attempt lock. Exactly one
    // state transition and, at most, one immutable result can become authority.
    const racePayload = resultPayload(reusedSlotClaim.normalized_origin);
    const terminalCommitRace = await concurrentRpc([
      () => serviceA.rpc("terminalize_company_discovery_attempt", {
        p_attempt_id: reusedSlotClaim.attempt_id,
        p_fence_generation: reusedSlotClaim.fence_generation,
        p_claim_token: reusedSlotClaim.claim_token,
        p_outcome: "failed",
        p_reason: "race_failed",
      }),
      () => serviceB.rpc("commit_company_discovery_result", {
        p_attempt_id: reusedSlotClaim.attempt_id,
        p_fence_generation: reusedSlotClaim.fence_generation,
        p_claim_token: reusedSlotClaim.claim_token,
        p_result: racePayload,
        p_result_hash: postgresJsonbHash(racePayload),
      }),
    ]);
    expect(terminalCommitRace.filter((response) => response.error === null)).toHaveLength(1);
    const terminalWon = terminalCommitRace[0]!.error === null;
    const raceAttempt = await serviceA.from("worker_attempts")
      .select("status,fence_generation")
      .eq("id", reusedSlotClaim.attempt_id).single();
    expect(raceAttempt.error).toBeNull();
    const raceResults = await serviceA.from("worker_results")
      .select("id").eq("attempt_id", reusedSlotClaim.attempt_id);
    expect(raceResults.error).toBeNull();
    if (terminalWon) {
      expect(raceAttempt.data?.status).toBe("failed");
      expect(raceResults.data).toEqual([]);
      const authority = terminalCommitRace[0]!.data as {
        fence_generation: number;
        claim_token: string;
      };
      expect((await serviceA.rpc("record_company_discovery_cleanup", {
        p_attempt_id: reusedSlotClaim.attempt_id,
        p_fence_generation: authority.fence_generation,
        p_claim_token: authority.claim_token,
        p_proof: completeOpenClawCleanupProof,
      })).error).toBeNull();
    } else {
      expect(raceAttempt.data?.status).toBe("validated");
      expect(raceResults.data).toHaveLength(1);
      expect((await serviceA.rpc("record_company_discovery_cleanup", {
        p_attempt_id: reusedSlotClaim.attempt_id,
        p_fence_generation: reusedSlotClaim.fence_generation,
        p_claim_token: reusedSlotClaim.claim_token,
        p_proof: completeOpenClawCleanupProof,
      })).error).toBeNull();
    }

    // Once proved cleanup retires the finite endpoint, two later attempts may
    // contend for that port, but the active partial uniqueness has one winner.
    const portReuseRaceJobA = await submit("port-reuse-race-a");
    const portReuseRaceJobB = await submit("port-reuse-race-b");
    const portReuseClaimA = await claim(`stage0-port-reuse-a-${randomUUID()}`);
    const portReuseClaimB = await claim(`stage0-port-reuse-b-${randomUUID()}`);
    expect(new Set([portReuseClaimA.job_id, portReuseClaimB.job_id])).toEqual(
      new Set([portReuseRaceJobA, portReuseRaceJobB]),
    );
    const contestedPort = secondIdentity.loopback_port;
    const contestedSocket = secondIdentity.subscription_socket_path;
    const portReuseRace = await concurrentRpc([
      () => bind(portReuseClaimA, {
        ...nextIdentity("port-reuse-race-a", contestedPort),
        subscription_socket_path: contestedSocket,
      }),
      () => bind(portReuseClaimB, {
        ...nextIdentity("port-reuse-race-b", contestedPort),
        subscription_socket_path: contestedSocket,
      }, serviceB),
    ]);
    expect(portReuseRace.filter((response) => response.error === null)).toHaveLength(1);
    expect(portReuseRace.filter((response) => response.error !== null)).toHaveLength(1);
    expect(portReuseRace.find((response) => response.error !== null)?.error?.message)
      .toContain("company_discovery_runtime_identity_conflict");
    expect(await runDisposableLocalSql(`
      select count(*)::text || '|' ||
        count(*) filter (where resource_kind = 'socket_identifier')::text
      from public.worker_runtime_resource_reservations
      where (
          (resource_kind = 'loopback_port' and resource_identifier = '${contestedPort}')
          or (resource_kind = 'socket_identifier' and resource_identifier = '${contestedSocket}')
        )
        and released_at is null;
    `)).toBe("2|1");

    // The safe unbound policy fails instead of requeueing while the global gate
    // is disabled, while still proving no runtime and releasing the exact slot.
    const disabledUnboundJob = await submit("unbound-disabled");
    const disabledWorker = `stage0-unbound-disabled-${randomUUID()}`;
    const disabledUnboundClaim = await claim(disabledWorker);
    await expireLease(disabledUnboundClaim.attempt_id);
    expect((await serviceA.from("company_discovery_controls")
      .update({ enabled: false }).eq("singleton", true)).error).toBeNull();
    const disabledRecovery = await serviceA.rpc(
      "claim_expired_company_discovery_cleanup",
      { p_worker_id: disabledWorker, p_lease_seconds: 300 },
    );
    expect(disabledRecovery.error).toBeNull();
    expect(disabledRecovery.data).toHaveLength(1);
    expect(disabledRecovery.data![0]).toMatchObject({
      job_id: disabledUnboundJob,
      attempt_id: disabledUnboundClaim.attempt_id,
      runtime_slot_id: disabledUnboundClaim.runtime_slot_id,
      runtime_identity: {},
      fence_generation: disabledUnboundClaim.fence_generation + 1,
      claim_token: null,
      job_version: disabledUnboundClaim.job_version + 1,
      recovery_outcome: "runtime_not_bound",
    });
    expect((await serviceA.from("worker_jobs")
      .select("status,current_attempt_id")
      .eq("id", disabledUnboundJob).single()).data).toEqual({
      status: "failed",
      current_attempt_id: disabledUnboundClaim.attempt_id,
    });
    expect((await serviceA.from("worker_runtime_slots")
      .select("status,current_attempt_id")
      .eq("id", disabledUnboundClaim.runtime_slot_id).single()).data).toEqual({
      status: "available",
      current_attempt_id: null,
    });
    expect((await serviceA.from("company_discovery_controls")
      .update({ enabled: true }).eq("singleton", true)).error).toBeNull();

    // An expired worker can never beat the reaper even when both requests hit
    // PostgreSQL concurrently: the reaper rotates authority and the commit is stale.
    const staleCommitJob = await submit("reaper-stale-commit");
    const staleCommitWorker = `stage0-stale-commit-${randomUUID()}`;
    const staleCommitClaim = await claim(staleCommitWorker);
    const staleCommitIdentity = nextIdentity("stale-commit");
    expect((await bind(staleCommitClaim, staleCommitIdentity)).error).toBeNull();
    await expireLease(staleCommitClaim.attempt_id);
    const stalePayload = resultPayload(staleCommitClaim.normalized_origin);
    const reclaimCommitRace = await concurrentRpc([
      () => serviceA.rpc("claim_expired_company_discovery_cleanup", {
        p_worker_id: staleCommitWorker,
        p_lease_seconds: 300,
      }),
      () => serviceB.rpc("commit_company_discovery_result", {
        p_attempt_id: staleCommitClaim.attempt_id,
        p_fence_generation: staleCommitClaim.fence_generation,
        p_claim_token: staleCommitClaim.claim_token,
        p_result: stalePayload,
        p_result_hash: postgresJsonbHash(stalePayload),
      }),
    ]);
    const reclaimResponse = reclaimCommitRace[0]!;
    const staleCommitResponse = reclaimCommitRace[1]!;
    expect(reclaimResponse.error).toBeNull();
    expect(staleCommitResponse.error).not.toBeNull();
    expect(reclaimResponse.data.length).toBeLessThanOrEqual(1);
    const eventualReclaim = reclaimResponse.data.length === 1
      ? reclaimResponse
      : await serviceA.rpc("claim_expired_company_discovery_cleanup", {
        p_worker_id: staleCommitWorker,
        p_lease_seconds: 300,
      });
    expect(eventualReclaim.error).toBeNull();
    expect(eventualReclaim.data).toHaveLength(1);
    const reclaimed = eventualReclaim.data![0] as {
      attempt_id: string;
      fence_generation: number;
      claim_token: string;
    };
    expect(reclaimed.attempt_id).toBe(staleCommitClaim.attempt_id);
    expect((await serviceA.from("worker_results")
      .select("id").eq("attempt_id", staleCommitClaim.attempt_id)).data).toEqual([]);
    expect((await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: staleCommitClaim.attempt_id,
      p_fence_generation: reclaimed.fence_generation,
      p_claim_token: reclaimed.claim_token,
      p_proof: completeOpenClawCleanupProof,
    })).error).toBeNull();

    // Cancelled terminal cleanup gets the same repeatable rotation path without
    // changing its terminal outcome or its bound adapter/runtime identity.
    const cancelledJob = await submit("cancelled-cleanup");
    const cancelledWorker = `stage0-cancelled-${randomUUID()}`;
    const cancelledClaim = await claim(cancelledWorker);
    const cancelledIdentity = nextIdentity("cancelled");
    expect((await bind(cancelledClaim, cancelledIdentity)).error).toBeNull();
    const cancelledTerminal = await serviceA.rpc(
      "terminalize_company_discovery_attempt",
      {
        p_attempt_id: cancelledClaim.attempt_id,
        p_fence_generation: cancelledClaim.fence_generation,
        p_claim_token: cancelledClaim.claim_token,
        p_outcome: "cancelled",
        p_reason: "worker_cancelled",
      },
    );
    expect(cancelledTerminal.error).toBeNull();
    await expireLease(cancelledClaim.attempt_id);
    const cancelledReclaim = await serviceA.rpc(
      "claim_expired_company_discovery_cleanup",
      { p_worker_id: cancelledWorker, p_lease_seconds: 300 },
    );
    expect(cancelledReclaim.error).toBeNull();
    expect(cancelledReclaim.data).toHaveLength(1);
    const cancelledAuthority = cancelledReclaim.data![0] as {
      attempt_id: string;
      adapter_id: string;
      runtime_identity: Record<string, unknown>;
      fence_generation: number;
      claim_token: string;
      recovery_outcome: string;
    };
    expect(cancelledAuthority).toMatchObject({
      attempt_id: cancelledClaim.attempt_id,
      adapter_id: "openclaw",
      runtime_identity: cancelledIdentity,
      recovery_outcome: "cleanup_claimed",
    });
    expect((await serviceA.from("worker_attempts")
      .select("status").eq("id", cancelledClaim.attempt_id).single()).data?.status)
      .toBe("cancelled");
    expect((await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: cancelledClaim.attempt_id,
      p_fence_generation: cancelledAuthority.fence_generation,
      p_claim_token: cancelledAuthority.claim_token,
      p_proof: completeOpenClawCleanupProof,
    })).error).toBeNull();

    // A retry may move job.current_attempt_id before the old terminal slot is
    // cleaned. Reclaim must stay attempt/slot-local and cannot fence or mutate
    // the live replacement attempt.
    const detachedCleanupJob = await submit("detached-terminal-cleanup");
    const detachedOldWorker = `stage0-detached-old-${randomUUID()}`;
    const detachedOldClaim = await claim(detachedOldWorker);
    const detachedOldIdentity = nextIdentity("detached-old");
    expect((await bind(detachedOldClaim, detachedOldIdentity)).error).toBeNull();
    const detachedTerminal = await serviceA.rpc(
      "terminalize_company_discovery_attempt",
      {
        p_attempt_id: detachedOldClaim.attempt_id,
        p_fence_generation: detachedOldClaim.fence_generation,
        p_claim_token: detachedOldClaim.claim_token,
        p_outcome: "failed",
        p_reason: "detached_failed",
      },
    );
    expect(detachedTerminal.error).toBeNull();
    expect((await owner.rpc("retry_company_discovery", {
      p_job: detachedCleanupJob,
      p_expected_version: detachedTerminal.data.job_version,
    })).error).toBeNull();
    const detachedReplacement = await claim(`stage0-detached-new-${randomUUID()}`);
    expect(detachedReplacement.job_id).toBe(detachedCleanupJob);
    expect(detachedReplacement.runtime_slot_id).not.toBe(detachedOldClaim.runtime_slot_id);
    expect((await bind(detachedReplacement, nextIdentity("detached-new"))).error)
      .toBeNull();
    const replacementBeforeReclaim = await serviceA.from("worker_jobs")
      .select("status,version,fence_generation,current_attempt_id")
      .eq("id", detachedCleanupJob).single();
    expect(replacementBeforeReclaim.error).toBeNull();
    await expireLease(detachedOldClaim.attempt_id);
    const detachedReclaim = await serviceA.rpc(
      "claim_expired_company_discovery_cleanup",
      { p_worker_id: detachedOldWorker, p_lease_seconds: 300 },
    );
    expect(detachedReclaim.error).toBeNull();
    expect(detachedReclaim.data).toHaveLength(1);
    const detachedAuthority = detachedReclaim.data![0] as {
      attempt_id: string;
      runtime_slot_id: string;
      runtime_identity: Record<string, unknown>;
      fence_generation: number;
      claim_token: string;
      job_version: number;
      recovery_outcome: string;
    };
    expect(detachedAuthority).toMatchObject({
      attempt_id: detachedOldClaim.attempt_id,
      runtime_slot_id: detachedOldClaim.runtime_slot_id,
      runtime_identity: detachedOldIdentity,
      job_version: replacementBeforeReclaim.data!.version,
      recovery_outcome: "cleanup_claimed",
    });
    expect((await serviceA.from("worker_jobs")
      .select("status,version,fence_generation,current_attempt_id")
      .eq("id", detachedCleanupJob).single()).data).toEqual(
      replacementBeforeReclaim.data,
    );
    expect((await serviceA.from("worker_attempts")
      .select("status,fence_generation")
      .eq("id", detachedReplacement.attempt_id).single()).data).toEqual({
      status: "running",
      fence_generation: detachedReplacement.fence_generation,
    });
    expect((await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: detachedOldClaim.attempt_id,
      p_fence_generation: detachedAuthority.fence_generation,
      p_claim_token: detachedAuthority.claim_token,
      p_proof: completeOpenClawCleanupProof,
    })).error).toBeNull();
    const detachedReplacementTerminal = await serviceA.rpc(
      "terminalize_company_discovery_attempt",
      {
        p_attempt_id: detachedReplacement.attempt_id,
        p_fence_generation: detachedReplacement.fence_generation,
        p_claim_token: detachedReplacement.claim_token,
        p_outcome: "failed",
        p_reason: "replacement_cleanup",
      },
    );
    expect(detachedReplacementTerminal.error).toBeNull();
    expect((await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: detachedReplacement.attempt_id,
      p_fence_generation: detachedReplacementTerminal.data.fence_generation,
      p_claim_token: detachedReplacementTerminal.data.claim_token,
      p_proof: completeOpenClawCleanupProof,
    })).error).toBeNull();

    // A prior selected result/nonce cannot cross a retry whose replacement is
    // terminalized; both stale selection and nonce paths remain fail-closed.
    const staleBoundaryJob = await submit("stale-select-nonce");
    const staleBoundaryWorker = `stage0-stale-boundary-${randomUUID()}`;
    const oldBoundaryClaim = await claim(staleBoundaryWorker);
    expect((await bind(oldBoundaryClaim, nextIdentity("stale-boundary-old"))).error)
      .toBeNull();
    const boundaryPayload = resultPayload(oldBoundaryClaim.normalized_origin);
    const boundaryCommit = await serviceA.rpc("commit_company_discovery_result", {
      p_attempt_id: oldBoundaryClaim.attempt_id,
      p_fence_generation: oldBoundaryClaim.fence_generation,
      p_claim_token: oldBoundaryClaim.claim_token,
      p_result: boundaryPayload,
      p_result_hash: postgresJsonbHash(boundaryPayload),
    });
    expect(boundaryCommit.error).toBeNull();
    const boundaryCommitted = boundaryCommit.data as CommittedResult;
    const boundaryResult = boundaryCommitted.result_id;
    const boundarySelect = await serviceA.rpc("select_company_discovery_result", {
      p_job_id: staleBoundaryJob,
      p_attempt_id: oldBoundaryClaim.attempt_id,
      p_expected_version: boundaryCommitted.job_version,
    });
    expect(boundarySelect.error).toBeNull();
    const boundaryClaims = await owner.from("discovery_claims")
      .select("id").eq("result_id", boundaryResult);
    expect(boundaryClaims.error).toBeNull();
    const boundaryNonce = await owner.rpc("create_company_discovery_review_nonce", {
      p_job: staleBoundaryJob,
      p_result: boundaryResult,
      p_claim_ids: boundaryClaims.data!.map((row) => row.id),
    });
    expect(boundaryNonce.error).toBeNull();
    const boundaryCancel = await owner.rpc("cancel_company_discovery", {
      p_job: staleBoundaryJob,
      p_expected_version: boundarySelect.data.version,
    });
    expect(boundaryCancel.error).toBeNull();
    expect((await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: oldBoundaryClaim.attempt_id,
      p_fence_generation: oldBoundaryClaim.fence_generation,
      p_claim_token: oldBoundaryClaim.claim_token,
      p_proof: completeOpenClawCleanupProof,
    })).error).toBeNull();
    const boundaryRetry = await owner.rpc("retry_company_discovery", {
      p_job: staleBoundaryJob,
      p_expected_version: boundaryCancel.data.version,
    });
    expect(boundaryRetry.error).toBeNull();
    const replacementBoundary = await claim(staleBoundaryWorker);
    expect((await bind(replacementBoundary, nextIdentity("stale-boundary-new"))).error)
      .toBeNull();
    const replacementTerminal = await serviceA.rpc(
      "terminalize_company_discovery_attempt",
      {
        p_attempt_id: replacementBoundary.attempt_id,
        p_fence_generation: replacementBoundary.fence_generation,
        p_claim_token: replacementBoundary.claim_token,
        p_outcome: "failed",
        p_reason: "replacement_failed",
      },
    );
    expect(replacementTerminal.error).toBeNull();
    const staleSelect = await serviceA.rpc("select_company_discovery_result", {
      p_job_id: staleBoundaryJob,
      p_attempt_id: oldBoundaryClaim.attempt_id,
      p_expected_version: replacementTerminal.data.job_version,
    });
    expect(staleSelect.error?.message).toContain("company_discovery_attempt_not_current");
    const staleNonce = await owner.rpc("create_company_discovery_review_nonce", {
      p_job: staleBoundaryJob,
      p_result: boundaryResult,
      p_claim_ids: boundaryClaims.data!.map((row) => row.id),
    });
    expect(staleNonce.error?.message).toContain(
      "company_discovery_review_result_not_owner",
    );
    const staleReview = await owner.rpc("review_company_discovery_claims", {
      p_job: staleBoundaryJob,
      p_result: boundaryResult,
      p_expected_version: replacementTerminal.data.job_version,
      p_decisions: [],
      p_confirmation_nonce: String(boundaryNonce.data),
    });
    expect(staleReview.error?.message).toContain("company_discovery_review_not_awaiting");
    expect((await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: replacementBoundary.attempt_id,
      p_fence_generation: replacementTerminal.data.fence_generation,
      p_claim_token: replacementTerminal.data.claim_token,
      p_proof: completeOpenClawCleanupProof,
    })).error).toBeNull();

    // A successful commit can lose its plaintext cleanup token before the
    // slot is released. Reclaim rotates only cleanup authority, cleanup keeps
    // the immutable result, and the validated attempt remains selectable with
    // the exact returned job version and synchronized fence.
    const validatedCleanupJob = await submit("validated-cleanup-reclaim");
    const validatedCleanupWorker = `stage0-validated-cleanup-${randomUUID()}`;
    const validatedCleanupClaim = await claim(validatedCleanupWorker);
    expect(validatedCleanupClaim.job_id).toBe(validatedCleanupJob);
    const validatedCleanupIdentity = nextIdentity("validated-cleanup");
    expect((await bind(validatedCleanupClaim, validatedCleanupIdentity)).error)
      .toBeNull();
    const validatedCleanupPayload = resultPayload(
      validatedCleanupClaim.normalized_origin,
    );
    const validatedCleanupCommit = await serviceA.rpc(
      "commit_company_discovery_result",
      {
        p_attempt_id: validatedCleanupClaim.attempt_id,
        p_fence_generation: validatedCleanupClaim.fence_generation,
        p_claim_token: validatedCleanupClaim.claim_token,
        p_result: validatedCleanupPayload,
        p_result_hash: postgresJsonbHash(validatedCleanupPayload),
      },
    );
    expect(validatedCleanupCommit.error).toBeNull();
    const validatedCleanupCommitted = validatedCleanupCommit.data as CommittedResult;
    const validatedCleanupResult = validatedCleanupCommitted.result_id;
    await expireLease(validatedCleanupClaim.attempt_id);
    const validatedCleanupReclaim = await serviceA.rpc(
      "claim_expired_company_discovery_cleanup",
      {
        p_worker_id: validatedCleanupWorker,
        p_lease_seconds: 300,
      },
    );
    expect(validatedCleanupReclaim.error).toBeNull();
    expect(validatedCleanupReclaim.data).toHaveLength(1);
    const validatedCleanupAuthority = validatedCleanupReclaim.data![0] as {
      job_id: string;
      attempt_id: string;
      adapter_id: string;
      runtime_slot_id: string;
      runtime_identity: Record<string, unknown>;
      fence_generation: number;
      claim_token: string;
      job_version: number;
      recovery_outcome: string;
    };
    expect(validatedCleanupAuthority).toMatchObject({
      job_id: validatedCleanupJob,
      attempt_id: validatedCleanupClaim.attempt_id,
      adapter_id: "openclaw",
      runtime_slot_id: validatedCleanupClaim.runtime_slot_id,
      runtime_identity: validatedCleanupIdentity,
      fence_generation: validatedCleanupClaim.fence_generation + 1,
      job_version: validatedCleanupCommitted.job_version,
      recovery_outcome: "cleanup_claimed",
    });
    expect(validatedCleanupAuthority.claim_token)
      .not.toBe(validatedCleanupClaim.claim_token);
    const staleValidatedCleanup = await serviceA.rpc(
      "record_company_discovery_cleanup",
      {
        p_attempt_id: validatedCleanupClaim.attempt_id,
        p_fence_generation: validatedCleanupClaim.fence_generation,
        p_claim_token: validatedCleanupClaim.claim_token,
        p_proof: completeOpenClawCleanupProof,
      },
    );
    expect(staleValidatedCleanup.error?.message)
      .toContain("company_discovery_stale_fence");
    expect((await serviceA.from("worker_attempts")
      .select("status,result_id,fence_generation,cleanup_state")
      .eq("id", validatedCleanupClaim.attempt_id).single()).data).toEqual({
      status: "validated",
      result_id: validatedCleanupResult,
      fence_generation: validatedCleanupAuthority.fence_generation,
      cleanup_state: "pending",
    });
    expect((await serviceA.from("worker_jobs")
      .select("status,version,fence_generation,current_attempt_id,selected_attempt_id")
      .eq("id", validatedCleanupJob).single()).data).toEqual({
      status: "awaiting_review",
      version: validatedCleanupAuthority.job_version,
      fence_generation: validatedCleanupAuthority.fence_generation,
      current_attempt_id: validatedCleanupClaim.attempt_id,
      selected_attempt_id: null,
    });
    expect((await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: validatedCleanupClaim.attempt_id,
      p_fence_generation: validatedCleanupAuthority.fence_generation,
      p_claim_token: validatedCleanupAuthority.claim_token,
      p_proof: completeOpenClawCleanupProof,
    })).error).toBeNull();
    const validatedCleanupSelect = await serviceA.rpc(
      "select_company_discovery_result",
      {
        p_job_id: validatedCleanupJob,
        p_attempt_id: validatedCleanupClaim.attempt_id,
        p_expected_version: validatedCleanupAuthority.job_version,
      },
    );
    expect(validatedCleanupSelect.error).toBeNull();
    expect(validatedCleanupSelect.data).toMatchObject({
      job_id: validatedCleanupJob,
      attempt_id: validatedCleanupClaim.attempt_id,
      result_id: validatedCleanupResult,
      version: validatedCleanupAuthority.job_version + 1,
      fence_generation: validatedCleanupAuthority.fence_generation + 1,
    });
    expect((await serviceA.from("worker_attempts")
      .select("status,result_id,cleanup_state")
      .eq("id", validatedCleanupClaim.attempt_id).single()).data).toEqual({
      status: "selected",
      result_id: validatedCleanupResult,
      cleanup_state: "proved",
    });

    // Selection and reclaim contend on the same attempt/job authority. Select
    // remains successful in either lock order, and any SKIP LOCKED miss is
    // reclaimed immediately afterward without invalidating selected state.
    const reclaimSelectJob = await submit("reclaim-select-race");
    const reclaimSelectWorker = `stage0-reclaim-select-${randomUUID()}`;
    const reclaimSelectClaim = await claim(reclaimSelectWorker);
    expect(reclaimSelectClaim.job_id).toBe(reclaimSelectJob);
    expect((await bind(reclaimSelectClaim, nextIdentity("reclaim-select"))).error)
      .toBeNull();
    const reclaimSelectPayload = resultPayload(reclaimSelectClaim.normalized_origin);
    const reclaimSelectCommit = await serviceA.rpc("commit_company_discovery_result", {
      p_attempt_id: reclaimSelectClaim.attempt_id,
      p_fence_generation: reclaimSelectClaim.fence_generation,
      p_claim_token: reclaimSelectClaim.claim_token,
      p_result: reclaimSelectPayload,
      p_result_hash: postgresJsonbHash(reclaimSelectPayload),
    });
    expect(reclaimSelectCommit.error).toBeNull();
    const reclaimSelectCommitted = reclaimSelectCommit.data as CommittedResult;
    await expireLease(reclaimSelectClaim.attempt_id);
    const reclaimSelectRace = await concurrentRpc([
      () => serviceA.rpc("claim_expired_company_discovery_cleanup", {
        p_worker_id: reclaimSelectWorker,
        p_lease_seconds: 300,
      }),
      () => serviceB.rpc("select_company_discovery_result", {
        p_job_id: reclaimSelectJob,
        p_attempt_id: reclaimSelectClaim.attempt_id,
        p_expected_version: reclaimSelectCommitted.job_version,
      }),
    ]);
    expect(reclaimSelectRace[0]!.error).toBeNull();
    expect(reclaimSelectRace[1]!.error).toBeNull();
    const reclaimSelectResult = reclaimSelectRace[1]!.data as {
      version: number;
      fence_generation: number;
    };
    const eventualReclaimSelect = reclaimSelectRace[0]!.data.length === 1
      ? reclaimSelectRace[0]!
      : await serviceA.rpc("claim_expired_company_discovery_cleanup", {
        p_worker_id: reclaimSelectWorker,
        p_lease_seconds: 300,
      });
    expect(eventualReclaimSelect.error).toBeNull();
    expect(eventualReclaimSelect.data).toHaveLength(1);
    const reclaimSelectAuthority = eventualReclaimSelect.data![0] as {
      attempt_id: string;
      fence_generation: number;
      claim_token: string;
      job_version: number;
      recovery_outcome: string;
    };
    expect(reclaimSelectAuthority.attempt_id).toBe(reclaimSelectClaim.attempt_id);
    expect(reclaimSelectAuthority.recovery_outcome).toBe("cleanup_claimed");
    expect([
      reclaimSelectCommitted.job_version,
      reclaimSelectResult.version,
    ]).toContain(reclaimSelectAuthority.job_version);
    expect((await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: reclaimSelectClaim.attempt_id,
      p_fence_generation: reclaimSelectAuthority.fence_generation,
      p_claim_token: reclaimSelectAuthority.claim_token,
      p_proof: completeOpenClawCleanupProof,
    })).error).toBeNull();
    expect((await serviceA.from("worker_jobs")
      .select("status,version,selected_attempt_id")
      .eq("id", reclaimSelectJob).single()).data).toEqual({
      status: "awaiting_review",
      version: reclaimSelectResult.version,
      selected_attempt_id: reclaimSelectClaim.attempt_id,
    });

    // A selected result survives repeated cleanup-reaper crashes. Each claim
    // rotates the cleanup token/fence, the prior authority is rejected, and a
    // pre-existing review nonce stays valid through proved cleanup and review.
    const selectedCleanupJob = await submit("selected-cleanup-reclaim");
    const selectedCleanupWorker = `stage0-selected-cleanup-${randomUUID()}`;
    const selectedCleanupClaim = await claim(selectedCleanupWorker);
    expect(selectedCleanupClaim.job_id).toBe(selectedCleanupJob);
    const selectedCleanupIdentity = nextIdentity("selected-cleanup");
    expect((await bind(selectedCleanupClaim, selectedCleanupIdentity)).error)
      .toBeNull();
    const selectedCleanupPayload = resultPayload(selectedCleanupClaim.normalized_origin);
    const selectedCleanupCommit = await serviceA.rpc("commit_company_discovery_result", {
      p_attempt_id: selectedCleanupClaim.attempt_id,
      p_fence_generation: selectedCleanupClaim.fence_generation,
      p_claim_token: selectedCleanupClaim.claim_token,
      p_result: selectedCleanupPayload,
      p_result_hash: postgresJsonbHash(selectedCleanupPayload),
    });
    expect(selectedCleanupCommit.error).toBeNull();
    const selectedCleanupCommitted = selectedCleanupCommit.data as CommittedResult;
    const selectedCleanupResult = selectedCleanupCommitted.result_id;
    const selectedCleanupSelect = await serviceA.rpc(
      "select_company_discovery_result",
      {
        p_job_id: selectedCleanupJob,
        p_attempt_id: selectedCleanupClaim.attempt_id,
        p_expected_version: selectedCleanupCommitted.job_version,
      },
    );
    expect(selectedCleanupSelect.error).toBeNull();
    const selectedCleanupClaims = await owner.from("discovery_claims")
      .select("id").eq("result_id", selectedCleanupResult);
    expect(selectedCleanupClaims.error).toBeNull();
    expect(selectedCleanupClaims.data).toHaveLength(1);
    const selectedCleanupNonce = await owner.rpc(
      "create_company_discovery_review_nonce",
      {
        p_job: selectedCleanupJob,
        p_result: selectedCleanupResult,
        p_claim_ids: selectedCleanupClaims.data!.map((row) => row.id),
      },
    );
    expect(selectedCleanupNonce.error).toBeNull();
    await expireLease(selectedCleanupClaim.attempt_id);
    const selectedCleanupReclaimOne = await serviceA.rpc(
      "claim_expired_company_discovery_cleanup",
      {
        p_worker_id: selectedCleanupWorker,
        p_lease_seconds: 300,
      },
    );
    expect(selectedCleanupReclaimOne.error).toBeNull();
    expect(selectedCleanupReclaimOne.data).toHaveLength(1);
    const selectedAuthorityOne = selectedCleanupReclaimOne.data![0] as {
      job_id: string;
      attempt_id: string;
      adapter_id: string;
      runtime_slot_id: string;
      runtime_identity: Record<string, unknown>;
      fence_generation: number;
      claim_token: string;
      job_version: number;
      recovery_outcome: string;
    };
    expect(selectedAuthorityOne).toMatchObject({
      job_id: selectedCleanupJob,
      attempt_id: selectedCleanupClaim.attempt_id,
      adapter_id: "openclaw",
      runtime_slot_id: selectedCleanupClaim.runtime_slot_id,
      runtime_identity: selectedCleanupIdentity,
      job_version: selectedCleanupSelect.data.version,
      recovery_outcome: "cleanup_claimed",
    });
    expect(selectedAuthorityOne.claim_token).not.toBe(selectedCleanupClaim.claim_token);
    expect((await serviceA.from("worker_attempts")
      .select("status,result_id,cleanup_state")
      .eq("id", selectedCleanupClaim.attempt_id).single()).data).toEqual({
      status: "selected",
      result_id: selectedCleanupResult,
      cleanup_state: "pending",
    });
    expect((await serviceA.from("worker_jobs")
      .select("status,version,selected_attempt_id,fallback_state")
      .eq("id", selectedCleanupJob).single()).data).toEqual({
      status: "awaiting_review",
      version: selectedCleanupSelect.data.version,
      selected_attempt_id: selectedCleanupClaim.attempt_id,
      fallback_state: "discovery_selected",
    });
    await expireLease(selectedCleanupClaim.attempt_id);
    const selectedCleanupReclaimTwo = await serviceA.rpc(
      "claim_expired_company_discovery_cleanup",
      {
        p_worker_id: selectedCleanupWorker,
        p_lease_seconds: 300,
      },
    );
    expect(selectedCleanupReclaimTwo.error).toBeNull();
    expect(selectedCleanupReclaimTwo.data).toHaveLength(1);
    const selectedAuthorityTwo = selectedCleanupReclaimTwo.data![0] as {
      fence_generation: number;
      claim_token: string;
      job_version: number;
      recovery_outcome: string;
    };
    expect(selectedAuthorityTwo.fence_generation)
      .toBe(selectedAuthorityOne.fence_generation + 1);
    expect(selectedAuthorityTwo.job_version).toBe(selectedAuthorityOne.job_version);
    expect(selectedAuthorityTwo.recovery_outcome).toBe("cleanup_claimed");
    expect(selectedAuthorityTwo.claim_token).not.toBe(selectedAuthorityOne.claim_token);
    const staleSelectedCleanup = await serviceA.rpc(
      "record_company_discovery_cleanup",
      {
        p_attempt_id: selectedCleanupClaim.attempt_id,
        p_fence_generation: selectedAuthorityOne.fence_generation,
        p_claim_token: selectedAuthorityOne.claim_token,
        p_proof: completeOpenClawCleanupProof,
      },
    );
    expect(staleSelectedCleanup.error?.message)
      .toContain("company_discovery_stale_fence");
    expect((await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: selectedCleanupClaim.attempt_id,
      p_fence_generation: selectedAuthorityTwo.fence_generation,
      p_claim_token: selectedAuthorityTwo.claim_token,
      p_proof: completeOpenClawCleanupProof,
    })).error).toBeNull();
    const nonceAfterCleanup = await owner.from("company_discovery_review_nonces")
      .select("invalidated_at,consumed_at")
      .eq("job_id", selectedCleanupJob).single();
    expect(nonceAfterCleanup.error).toBeNull();
    expect(nonceAfterCleanup.data).toEqual({
      invalidated_at: null,
      consumed_at: null,
    });
    const selectedCleanupReview = await owner.rpc(
      "review_company_discovery_claims",
      {
        p_job: selectedCleanupJob,
        p_result: selectedCleanupResult,
        p_expected_version: selectedCleanupSelect.data.version,
        p_decisions: [{
          claim_id: selectedCleanupClaims.data![0]!.id,
          decision: "approve",
        }],
        p_confirmation_nonce: String(selectedCleanupNonce.data),
      },
    );
    expect(selectedCleanupReview.error).toBeNull();
    expect((await serviceA.from("worker_jobs")
      .select("status,selected_attempt_id")
      .eq("id", selectedCleanupJob).single()).data).toEqual({
      status: "reviewed",
      selected_attempt_id: selectedCleanupClaim.attempt_id,
    });
    expect((await serviceA.from("worker_attempts")
      .select("status,result_id,cleanup_state")
      .eq("id", selectedCleanupClaim.attempt_id).single()).data).toEqual({
      status: "selected",
      result_id: selectedCleanupResult,
      cleanup_state: "proved",
    });

    // Concurrent claims for one logical slot have one winner. An unresolved
    // proof quarantines that slot, so queued work cannot reuse it.
    const slotRaceJobA = await submit("slot-race-a");
    const slotRaceJobB = await submit("slot-race-b");
    const slotRaceWorker = `stage0-slot-race-${randomUUID()}`;
    const slotRace = await concurrentRpc([
      () => serviceA.rpc("claim_company_discovery_attempt", {
        p_worker_id: slotRaceWorker,
        p_adapter_id: "openclaw",
        p_lease_seconds: 300,
      }),
      () => serviceB.rpc("claim_company_discovery_attempt", {
        p_worker_id: slotRaceWorker,
        p_adapter_id: "openclaw",
        p_lease_seconds: 300,
      }),
    ]);
    for (const response of slotRace) expect(response.error).toBeNull();
    const slotClaims = slotRace.flatMap((response) => response.data ?? []);
    expect(slotClaims).toHaveLength(1);
    const slotClaim = slotClaims[0] as ClaimedAttempt;
    expect([slotRaceJobA, slotRaceJobB]).toContain(slotClaim.job_id);
    expect((await serviceA.from("worker_runtime_slots")
      .select("id,current_attempt_id").eq("slot_name", `${slotRaceWorker}:openclaw`)).data)
      .toEqual([{ id: slotClaim.runtime_slot_id, current_attempt_id: slotClaim.attempt_id }]);
    const unresolvedIdentity = nextIdentity("slot-race");
    expect((await bind(slotClaim, unresolvedIdentity)).error).toBeNull();
    const slotTerminal = await serviceA.rpc("terminalize_company_discovery_attempt", {
      p_attempt_id: slotClaim.attempt_id,
      p_fence_generation: slotClaim.fence_generation,
      p_claim_token: slotClaim.claim_token,
      p_outcome: "failed",
      p_reason: "cleanup_unproved",
    });
    expect(slotTerminal.error).toBeNull();
    const unresolved = await serviceA.rpc("record_company_discovery_cleanup", {
      p_attempt_id: slotClaim.attempt_id,
      p_fence_generation: slotTerminal.data.fence_generation,
      p_claim_token: slotTerminal.data.claim_token,
      p_proof: { ...completeOpenClawCleanupProof, subscription_socket_absent: false },
    });
    expect(unresolved.error).toBeNull();
    expect(unresolved.data).toMatchObject({
      cleanup_state: "cleanup_unresolved",
      slot_updated: true,
    });
    expect((await owner.rpc("retry_company_discovery", {
      p_job: slotClaim.job_id,
      p_expected_version: slotTerminal.data.job_version,
    })).error).toBeNull();
    const quarantinedClaim = await serviceA.rpc("claim_company_discovery_attempt", {
      p_worker_id: slotRaceWorker,
      p_adapter_id: "openclaw",
      p_lease_seconds: 300,
    });
    expect(quarantinedClaim.error).toBeNull();
    expect(quarantinedClaim.data).toEqual([]);
    expect((await serviceA.from("worker_runtime_slots")
      .select("status,current_attempt_id,quarantine_reason")
      .eq("id", slotClaim.runtime_slot_id).single()).data).toEqual({
      status: "quarantined",
      current_attempt_id: null,
      quarantine_reason: "cleanup_unresolved",
    });
    expect(await runDisposableLocalSql(`
      select count(*)::text
      from public.worker_runtime_resource_reservations
      where attempt_id = ${localSqlUuid(slotClaim.attempt_id)}
        and resource_kind in ('loopback_port', 'socket_identifier')
        and released_at is null;
    `)).toBe("2");
    const unresolvedPortClaim = await claim(
      `stage0-unresolved-port-${randomUUID()}`,
    );
    const unresolvedPortCollision = await bind(unresolvedPortClaim, {
      ...nextIdentity("unresolved-port-collision"),
      loopback_port: unresolvedIdentity.loopback_port,
      subscription_socket_path: unresolvedIdentity.subscription_socket_path,
    });
    expect(unresolvedPortCollision.error?.message).toContain(
      "company_discovery_runtime_identity_conflict",
    );

    // Dynamic adapter selection uses two durable slot identities for one
    // supervisor process, so a slot first seen as OpenClaw cannot make the
    // later Direct baseline poll idle forever (or vice versa).
    await submit("dual-adapter-a");
    await submit("dual-adapter-b");
    const dualAdapterWorker = `stage0-dual-adapter-${randomUUID()}`;
    const dualAdapterClaims = await concurrentRpc([
      () => serviceA.rpc("claim_company_discovery_attempt", {
        p_worker_id: dualAdapterWorker,
        p_adapter_id: "openclaw",
        p_lease_seconds: 300,
      }),
      () => serviceB.rpc("claim_company_discovery_attempt", {
        p_worker_id: dualAdapterWorker,
        p_adapter_id: "direct_model",
        p_lease_seconds: 300,
      }),
    ]);
    for (const response of dualAdapterClaims) {
      expect(response.error).toBeNull();
      expect(response.data).toHaveLength(1);
    }
    expect((await serviceA.from("worker_runtime_slots")
      .select("slot_name,adapter_id")
      .eq("supervisor_worker_id", dualAdapterWorker)
      .order("adapter_id")).data).toEqual([
      { slot_name: `${dualAdapterWorker}:direct_model`, adapter_id: "direct_model" },
      { slot_name: `${dualAdapterWorker}:openclaw`, adapter_id: "openclaw" },
    ]);
  },
);
