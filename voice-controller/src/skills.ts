// Plan v4 §11 — skill autopromotion pipeline. The cell may WRITE skills; it may not certify them.
// Stages: manifest -> independent scanner -> power check -> Ligou-owned tests -> canary -> promotion,
// with automatic rollback. A skill using only existing powers promotes without a human click; one asking
// for a NEW power stops at needs_power (owner decides). The scanner runs OUTSIDE the cell, on purpose.
import { createHash } from "node:crypto";
import { supa } from "./rules.ts";
import { checkPower } from "./powers.ts";

export interface SkillManifest {
  capabilities: string[];   // powers the skill intends to use (e.g. create_booking, follow_up_message)
  channels?: string[];
  reads?: string[];
  writes?: string[];
}

export interface ScanFinding { rule: string; severity: "block" | "warn"; evidence: string }

export const skillDigest = (source: string): string => createHash("sha256").update(source).digest("hex");

/** Independent scanner. Deliberately conservative and pattern-based: it is a gate the cell cannot argue with.
 *  Anything that reaches for credentials, the host, the network outside our own surfaces, or other tenants is
 *  a hard block — those are exactly the moves a self-improving agent must never make on its own. */
export function scanSkill(source: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const add = (rule: string, severity: ScanFinding["severity"], m: RegExpMatchArray | null) => {
    if (m) findings.push({ rule, severity, evidence: m[0].slice(0, 120) });
  };

  add("credential_access", "block", source.match(/(process\.env|os\.environ|SUPABASE_[A-Z_]*KEY|OPENAI_API_KEY|auth\.json|\.aws\/credentials|SERVICE_ROLE)/));
  add("host_execution", "block", source.match(/\b(subprocess|child_process|os\.system|exec\s*\(|execSync|spawnSync|eval\s*\(|Function\s*\()/));
  add("filesystem_escape", "block", source.match(/(\/etc\/|\/root\/|\.\.\/\.\.\/|\/var\/run\/docker\.sock|\/proc\/)/));
  add("cross_tenant", "block", source.match(/(tenant_id\s*(!=|<>)|all_tenants|from\s+tenants\b(?![^\n]*where))/i));
  add("audit_tampering", "block", source.match(/\b(delete|drop|truncate)\b[^\n]{0,40}\b(audit|receipts|usage_ledger|powers|skill_pipeline_events)\b/i));
  add("self_grant", "block", source.match(/\b(insert|update)\b[^\n]{0,40}\bpowers\b/i));
  add("unbounded_network", "block", source.match(/https?:\/\/(?!(api\.openai\.com|[a-z0-9-]+\.supabase\.co|www\.googleapis\.com|oauth2\.googleapis\.com))[a-z0-9.-]+/i));
  add("silent_failure", "warn", source.match(/catch\s*\([^)]*\)\s*\{\s*\}/));

  return findings;
}

/** Ligou-owned behavioural tests every skill must satisfy, regardless of what it does. These are OUR tests,
 *  not tests the cell wrote for itself — that distinction is the whole point of the stage. */
export function runLigouSkillTests(source: string, manifest: SkillManifest): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!manifest.capabilities || manifest.capabilities.length === 0) failures.push("manifest_declares_no_capabilities");
  if (source.length > 20_000) failures.push("source_too_large");
  if (!/\breturn\b|\byield\b|=>/.test(source)) failures.push("skill_produces_no_result");
  // a skill that claims a capability it never calls is mislabelled; a skill calling one it did not declare is worse
  for (const cap of manifest.capabilities ?? []) {
    if (!source.includes(cap)) failures.push(`declared_capability_unused:${cap}`);
  }
  for (const known of ["create_booking", "follow_up_message", "quote_price", "close_deal"]) {
    if (source.includes(known) && !(manifest.capabilities ?? []).includes(known)) failures.push(`undeclared_capability_used:${known}`);
  }
  return { pass: failures.length === 0, failures };
}

async function logStage(tenantId: string, candidateId: string, stage: string, outcome: "pass" | "fail" | "defer", detail: unknown) {
  await supa().from("skill_pipeline_events").insert({ tenant_id: tenantId, candidate_id: candidateId, stage, outcome, detail: detail as any });
}

export interface PipelineResult { status: string; reason?: string; findings?: ScanFinding[]; missingPowers?: string[] }

/** Full pipeline for one candidate. Returns the terminal status; every stage is recorded append-only. */
export async function processSkillCandidate(args: {
  tenantId: string; name: string; source: string; manifest: SkillManifest;
}): Promise<PipelineResult> {
  const digest = skillDigest(args.source);
  const { data: cand, error } = await supa().from("skill_candidates").upsert({
    tenant_id: args.tenantId, name: args.name, source: args.source, digest,
    manifest: args.manifest as any, status: "scanning",
    required_powers: args.manifest.capabilities ?? [],
  }, { onConflict: "tenant_id,name,digest" }).select("id").single();
  if (error || !cand) return { status: "error", reason: error?.message };
  const id = cand.id as string;

  // 1) independent scanner
  const findings = scanSkill(args.source);
  const blockers = findings.filter((f) => f.severity === "block");
  await logStage(args.tenantId, id, "scan", blockers.length ? "fail" : "pass", { findings });
  if (blockers.length) {
    await supa().from("skill_candidates").update({ status: "rejected_scan", scan_findings: findings as any }).eq("id", id);
    return { status: "rejected_scan", findings: blockers };
  }

  // 2) power check — a new power is the owner's call, never the cell's
  const missing: string[] = [];
  for (const capability of args.manifest.capabilities ?? []) {
    const chk = await checkPower(args.tenantId, "hermes", capability, "*");
    if (!chk.granted) missing.push(capability);
  }
  await logStage(args.tenantId, id, "powers", missing.length ? "defer" : "pass", { missing });
  if (missing.length) {
    await supa().from("skill_candidates").update({ status: "needs_power", missing_powers: missing }).eq("id", id);
    return { status: "needs_power", missingPowers: missing };
  }

  // 3) Ligou-owned tests
  const tests = runLigouSkillTests(args.source, args.manifest);
  await logStage(args.tenantId, id, "tests", tests.pass ? "pass" : "fail", { failures: tests.failures });
  if (!tests.pass) {
    await supa().from("skill_candidates").update({ status: "failed_tests" }).eq("id", id);
    return { status: "failed_tests", reason: tests.failures.join(",") };
  }

  // 4) canary — enabled for this tenant only, promoted after clean runs
  await supa().from("skill_candidates").update({ status: "canary" }).eq("id", id);
  await logStage(args.tenantId, id, "canary_start", "pass", { digest });
  return { status: "canary" };
}

/** Called after each canary execution. Clean runs promote; a failure rolls the skill back automatically. */
export async function recordCanaryRun(candidateId: string, ok: boolean, opts?: { promoteAfter?: number }): Promise<string> {
  const promoteAfter = opts?.promoteAfter ?? 3;
  const { data: c } = await supa().from("skill_candidates")
    .select("id,tenant_id,status,canary_runs,canary_failures").eq("id", candidateId).single();
  if (!c) return "not_found";
  if (c.status !== "canary") return c.status;

  const runs = (c.canary_runs ?? 0) + 1;
  const failures = (c.canary_failures ?? 0) + (ok ? 0 : 1);

  if (!ok) {
    await supa().from("skill_candidates").update({
      status: "rolled_back", canary_runs: runs, canary_failures: failures,
      rolled_back_at: new Date().toISOString(), rollback_reason: "canary_failure",
    }).eq("id", candidateId);
    await logStage(c.tenant_id, candidateId, "canary_run", "fail", { runs, failures });
    return "rolled_back";
  }

  if (runs >= promoteAfter) {
    await supa().from("skill_candidates").update({
      status: "promoted", canary_runs: runs, promoted_at: new Date().toISOString(),
    }).eq("id", candidateId);
    await logStage(c.tenant_id, candidateId, "promotion", "pass", { runs });
    return "promoted";
  }

  await supa().from("skill_candidates").update({ canary_runs: runs }).eq("id", candidateId);
  await logStage(c.tenant_id, candidateId, "canary_run", "pass", { runs });
  return "canary";
}
