import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

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

  test("makes every supervisor mutation service-role-only with an empty search path", () => {
    const sql = migrationSql();
    for (const signature of [
      "claim_company_discovery_attempt(text,integer)",
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
    expect(sql).toContain("v_slot.adapter_id");
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

test.skipIf(process.env.LIGOU_LOCAL_DB_TEST !== "1")(
  "real Postgres keeps discovery fenced, owner-bound, atomic, and non-effective before review",
  async () => {
    const { priceRules, servicePolicies } = await import("../src/rules.ts");
    const apiUrl = process.env.SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SECRET_KEY!;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY!;
    const service = createClient(apiUrl, serviceKey, { auth: { persistSession: false } });
    const owner = createClient(apiUrl, publishableKey, { auth: { persistSession: false } });
    const intruder = createClient(apiUrl, publishableKey, { auth: { persistSession: false } });
    const ownerEmail = `discovery-owner-${randomUUID()}@example.invalid`;
    const intruderEmail = `discovery-intruder-${randomUUID()}@example.invalid`;
    const ownerPassword = `Owner-${randomUUID()}-Aa1!`;
    const intruderPassword = `Intruder-${randomUUID()}-Aa1!`;
    const ownerTenant = randomUUID();
    const intruderTenant = randomUUID();

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
      p_lease_seconds: 300,
    });
    expect(firstClaim.error).toBeNull();
    expect(firstClaim.data).toHaveLength(1);
    const claim = firstClaim.data![0] as {
      job_id: string;
      attempt_id: string;
      fence_generation: number;
      claim_token: string;
    };
    expect(claim.job_id).toBe(firstJob);
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
    const resultId = String(commit.data);
    const selected = await service.rpc("select_company_discovery_result", {
      p_job_id: firstJob,
      p_attempt_id: claim.attempt_id,
      p_expected_version: 3,
    });
    expect(selected.error).toBeNull();
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
      p_lease_seconds: 300,
    });
    expect(duplicateClaimResult.error).toBeNull();
    const duplicateClaim = duplicateClaimResult.data![0] as typeof claim;
    expect(duplicateClaim.job_id).toBe(duplicateJob);
    const duplicateCommit = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: duplicateClaim.attempt_id,
      p_fence_generation: duplicateClaim.fence_generation,
      p_claim_token: duplicateClaim.claim_token,
      p_result: resultPayload,
      p_result_hash: postgresJsonbHash(resultPayload),
    });
    expect(duplicateCommit.error).toBeNull();
    const duplicateResult = String(duplicateCommit.data);
    expect((await service.rpc("select_company_discovery_result", {
      p_job_id: duplicateJob,
      p_attempt_id: duplicateClaim.attempt_id,
      p_expected_version: 3,
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

    const retrySubmit = await owner.rpc("submit_company_discovery", {
      p_url: "https://example.org/",
      p_idempotency_key: "stage0-owner-retry",
    });
    expect(retrySubmit.error).toBeNull();
    const retryJob = String(retrySubmit.data);
    const retryClaimResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: `stage0-worker-${randomUUID()}`,
      p_lease_seconds: 300,
    });
    expect(retryClaimResult.error).toBeNull();
    const oldAttempt = retryClaimResult.data![0] as typeof claim;
    expect(oldAttempt.job_id).toBe(retryJob);
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
    const oldResultId = String(oldCommit.data);
    expect((await service.rpc("select_company_discovery_result", {
      p_job_id: retryJob,
      p_attempt_id: oldAttempt.attempt_id,
      p_expected_version: 3,
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
      slot_name: directWorker,
      supervisor_worker_id: directWorker,
      adapter_id: "direct_model",
    })).error).toBeNull();
    const newClaimResult = await service.rpc("claim_company_discovery_attempt", {
      p_worker_id: directWorker,
      p_lease_seconds: 300,
    });
    expect(newClaimResult.error).toBeNull();
    const newAttempt = newClaimResult.data![0] as typeof claim;
    expect(newAttempt.job_id).toBe(retryJob);
    expect(newAttempt.attempt_id).not.toBe(oldAttempt.attempt_id);
    expect(newAttempt.fence_generation).toBe(oldAttempt.fence_generation + 3);
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
      state_removed: true,
      workspace_removed: true,
      output_removed: true,
      network_removed: true,
      credential_revoked: true,
      listener_closed: true,
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
    const noPublicPriceResult = structuredClone(resultPayload);
    noPublicPriceResult.candidate_facts[1]!.normalized_value = {
      ...(noPublicPriceResult.candidate_facts[1]!.normalized_value as Record<string, unknown>),
      public_price: null,
      duration_minutes: null,
    };
    const newCommit = await service.rpc("commit_company_discovery_result", {
      p_attempt_id: newAttempt.attempt_id,
      p_fence_generation: newAttempt.fence_generation,
      p_claim_token: newAttempt.claim_token,
      p_result: noPublicPriceResult,
      p_result_hash: postgresJsonbHash(noPublicPriceResult),
    });
    expect(newCommit.error).toBeNull();
    const replacementSelect = await service.rpc("select_company_discovery_result", {
      p_job_id: retryJob,
      p_attempt_id: newAttempt.attempt_id,
      p_expected_version: 8,
    });
    expect(replacementSelect.error).toBeNull();
    const unresolvedCleanup = await service.rpc("record_company_discovery_cleanup", {
      p_attempt_id: newAttempt.attempt_id,
      p_fence_generation: newAttempt.fence_generation,
      p_claim_token: newAttempt.claim_token,
      p_proof: { ...cleanupProof, listener_closed: false },
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
