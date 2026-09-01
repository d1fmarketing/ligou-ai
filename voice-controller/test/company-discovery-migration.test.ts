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

  test("keeps controls default-off and requires an active owner allowlist row", () => {
    const sql = migrationSql();
    expect(sql).toContain("enabled boolean not null default false");
    expect(sql).toContain("company_discovery_disabled");
    expect(sql).toContain("company_discovery_tenant_not_allowlisted");
    expect(sql).toContain("a.expires_at is null or a.expires_at > clock_timestamp()");
  });

  test("makes candidate results and evidence immutable and rejects authority-shaped worker output", () => {
    const sql = migrationSql();
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
    expect(sql).toContain("p_result ?| array[");
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
    expect(review).toContain("insert into public.discovery_decisions");
    expect(review).toContain("insert into public.business_profile_versions");
    expect(review).toContain("insert into public.rules");
    expect(review).toContain("'aprovado'");
    expect(review).not.toContain("'sugerido'");
    expect(sql).not.toContain("create trigger discovery_claims_effective");
    expect(sql).not.toContain("insert into public.effective_rules");
  });

  test("records source-neutral discovery provenance without fabricating a call", () => {
    const sql = migrationSql();
    expect(sql).toContain("'source_kind', 'company_discovery'");
    expect(sql).toContain("'source_job_id'");
    expect(sql).toContain("'source_result_id'");
    expect(sql).toContain("'source_claim_id'");
    expect(sql).toContain("'source_decision_id'");
    expect(sql).not.toContain("'source_call_id', gen_random_uuid()");
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
        uncertainty: {},
      }, {
        claim_class: "operational",
        claim_type: "service_drain_cleaning",
        normalized_value: { price: 149, duration_min: 90 },
        evidence_refs: [0],
        contradictions: [],
        uncertainty: {},
      }, {
        claim_class: "safety_critical",
        claim_type: "gas_emergency_guidance",
        normalized_value: "Leave the area and call emergency services.",
        evidence_refs: [0],
        contradictions: [],
        uncertainty: {},
      }],
      missing_questions: ["Qual é o preço mínimo privado autorizado?"],
      contradictions: [],
      uncertainty: {},
    };
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
    const serviceMaterialization = {
      category: "preco",
      scope: "servico",
      text: "Drain cleaning is $149 and takes 90 minutes.",
      structured: {
        schema: "ligou.rule.service.v2",
        materialization_key: "service:drain_cleaning",
        materialization_hash: "0".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        service_type: "drain_cleaning",
        service_names: ["Drain cleaning"],
        price_mode: "fixed",
        negotiation_mode: "non_negotiable",
        quoteable: true,
        negotiable: false,
        price_target: 149,
        price_min: 149,
        duration_min: 90,
        owner_review_fields: [],
      },
    };
    const safetyMaterialization = {
      category: "emergencia",
      scope: "geral",
      text: "Gas emergency: leave the area and call emergency services.",
      structured: {
        schema: "ligou.rule.emergency.v2",
        materialization_key: "domain:emergency",
        materialization_hash: "0".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        fields: { safety_escalation: "Leave and call emergency services." },
      },
    };
    const decisions = (acknowledgeSafety: boolean) => [{
      claim_id: byClass.descriptive.id,
      decision: "approve",
    }, {
      claim_id: byClass.operational.id,
      decision: "approve",
      group_confirmed: true,
      materialization: serviceMaterialization,
    }, {
      claim_id: byClass.safety_critical.id,
      decision: "approve",
      group_confirmed: true,
      evidence_acknowledged: acknowledgeSafety,
      acknowledged_evidence_refs: acknowledgeSafety
        ? byClass.safety_critical.evidence_refs
        : [],
      materialization: safetyMaterialization,
    }];
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
      .select("category,structured")
      .eq("tenant_id", ownerTenant);
    expect(effective.error).toBeNull();
    expect(effective.data).toHaveLength(2);
    expect(effective.data!.find((row) => row.category === "preco")!.structured)
      .toMatchObject({
        source_kind: "company_discovery",
        source_job_id: firstJob,
        source_result_id: resultId,
      });
    expect(effective.data!.some((row) => "source_call_id" in row.structured)).toBe(false);

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
    const cancelled = await owner.rpc("cancel_company_discovery", {
      p_job: retryJob,
      p_expected_version: 2,
    });
    expect(cancelled.error).toBeNull();
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
      p_expected_version: 3,
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
    expect(newAttempt.fence_generation).toBe(oldAttempt.fence_generation + 2);
    const directAttempt = await service.from("worker_attempts")
      .select("adapter_id")
      .eq("id", newAttempt.attempt_id)
      .single();
    expect(directAttempt.error).toBeNull();
    expect(directAttempt.data?.adapter_id).toBe("direct_model");
    const wrongJobAttempt = await service.rpc("select_company_discovery_result", {
      p_job_id: retryJob,
      p_attempt_id: claim.attempt_id,
      p_expected_version: 5,
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
  },
);
