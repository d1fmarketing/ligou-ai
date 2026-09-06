// Action worker — leased execution of intents (outbox pattern), receipt commit with read-back proof,
// post-call summaries in PT, and 70/90% usage alerts. Runs in the same process as the controller (F2) or standalone.
import { supa } from "./rules.ts";
import { calendarPort } from "./calendar.ts";
import { reapAbandonedCalls, reconcileBudgetReservations, reconcileProviderTerminations } from "./budget.ts";
import { randomUUID } from "node:crypto";
import {
  isSummaryClaimToken,
  summarizeCallViaHermesSubscription,
  type HermesSummaryInput,
  type HermesSummaryResult,
} from "./summary-subscription.ts";

const WORKER_ID = `worker-${process.pid}`;

export async function tickIntents(): Promise<number> {
  const { data: claimed, error } = await supa().rpc("claim_intent", { p_worker: WORKER_ID });
  if (error || !claimed?.length) return 0;
  for (const intent of claimed) await executeIntent(intent);
  return claimed.length;
}

export async function executeIntent(intent: any, calendar = calendarPort()) {
  if (intent.kind !== "calendar_book") {
    await supa().rpc("transition_claimed_intent", {
      p_intent: intent.id, p_claim_token: intent.claim_token,
      p_transition: "fail", p_reason: "unsupported_kind", p_delay_seconds: 0,
    });
    return;
  }
  let result;
  if (intent.execution_mode === "reconcile") {
    const { data: providerInput, error: inputError } = await supa()
      .rpc("get_booking_provider_input", { p_intent: intent.id });
    if (inputError || !providerInput) return;
    const calendarInput = providerInput;
    result = await calendar.reconcile(calendarInput);
  } else {
    // Task 3's exact power/rule/epoch validator runs inside this preparation
    // transaction before the tenant/time-window exclusion is acquired.
    const { data: prepared, error: prepareError } = await supa()
      .rpc("prepare_booking_provider_write", { p_intent: intent.id, p_claim_token: intent.claim_token });
    if (prepareError) {
      await supa().rpc("transition_claimed_intent", {
        p_intent: intent.id, p_claim_token: intent.claim_token, p_transition: "defer",
        p_reason: `provider_write_prepare_failed: ${prepareError.message}`, p_delay_seconds: 5,
      });
      return;
    }
    if (!prepared?.ready || !prepared.provider_input) {
      // The atomic RPC records either Task 3's authority-stale result or the
      // slot-exclusion conflict while it still owns the relevant row locks.
      return;
    }

    // An offer is not a reservation. Recheck provider free/busy after the
    // internal exclusion and immediately before the only write method.
    const preparedInput = prepared.provider_input;
    const availability = await calendar.busy(intent.tenant_id, preparedInput.startIso, preparedInput.endIso);
    if (availability.unknown) {
      await supa().rpc("transition_claimed_intent", {
        p_intent: intent.id, p_claim_token: intent.claim_token, p_transition: "defer",
        p_reason: "free_busy_unknown", p_delay_seconds: 15,
      });
      return;
    }
    if (availability.intervals.some((busy) => {
      const start = Date.parse(preparedInput.startIso), end = Date.parse(preparedInput.endIso);
      return start < Date.parse(busy.end) && Date.parse(busy.start) < end;
    })) {
      await supa().rpc("transition_claimed_intent", {
        p_intent: intent.id, p_claim_token: intent.claim_token, p_transition: "fail",
        p_reason: "slot_became_busy", p_delay_seconds: 0,
      });
      return;
    }
    const { data: begun, error: beginError } = await supa()
      .rpc("begin_provider_write", { p_intent: intent.id, p_claim_token: intent.claim_token });
    if (beginError || !begun?.authorized || !begun.provider_input) return;
    result = await calendar.write(begun.provider_input);
  }

  const { data: delivery, error: deliveryError } = await supa().rpc("record_booking_delivery", {
    p_intent: intent.id,
    p_claim_token: intent.claim_token,
    p_attempt_key: randomUUID(),
    p_outcome: result.outcome,
    p_external_id: result.externalId ?? null,
    p_readback: result.readback ?? null,
    p_payload_hash: result.payloadHash ?? null,
    p_provider_request: {
      latency_ms: result.latencyMs,
      at: new Date().toISOString(),
      error: result.error ?? null,
    },
    p_expected: result.expected ?? null,
  });
  if (deliveryError || !delivery) return;
  if (result.outcome === "accepted" && delivery.authoritative !== true) return;
}

// ---------------------------------------------------------------- post-call summary (PT) — raw Codex subscription, no agent/tools/memory
type SummaryFunction = (input: HermesSummaryInput) => Promise<HermesSummaryResult>;

interface ClaimedSummary {
  readonly call_id: string;
  readonly tenant_id: string;
  readonly tenant_slug: string;
  readonly transcript: unknown;
  readonly test_memory_generation: number;
  readonly attempt_number: number;
  readonly claim_token: string;
  readonly lease_until: string;
}

function claimedSummary(value: unknown): ClaimedSummary {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("summary claim invalid");
  }
  const row = value as Record<string, unknown>;
  const keys = [
    "call_id", "tenant_id", "tenant_slug", "transcript", "test_memory_generation",
    "attempt_number", "claim_token", "lease_until",
  ];
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)) ||
      typeof row.call_id !== "string" || typeof row.tenant_id !== "string" ||
      typeof row.tenant_slug !== "string" || !Number.isSafeInteger(row.attempt_number) ||
      (row.attempt_number as number) < 1 || (row.attempt_number as number) > 3 ||
      !Number.isSafeInteger(row.test_memory_generation) ||
      (row.test_memory_generation as number) < 0 || !isSummaryClaimToken(row.claim_token) ||
      typeof row.lease_until !== "string" || !Number.isFinite(Date.parse(row.lease_until)) ||
      Date.parse(row.lease_until) <= Date.now()) {
    throw new Error("summary claim invalid");
  }
  return row as unknown as ClaimedSummary;
}

function summaryTranscript(value: unknown): Array<{ role: "caller" | "agent"; text: string }> {
  if (!Array.isArray(value) || value.length > 200) throw new Error("summary transcript invalid");
  return value.flatMap((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
    const entry = raw as Record<string, unknown>;
    if ((entry.role !== "caller" && entry.role !== "agent") ||
        typeof entry.text !== "string" || entry.text.trim() === "") return [];
    return [{ role: entry.role, text: entry.text }];
  });
}

async function completeSummary(
  claim: ClaimedSummary,
  outcome: "ready" | "retry",
  summary: string | null,
): Promise<boolean> {
  const { data, error } = await supa().rpc("complete_call_summary_subscription", {
    p_call_id: claim.call_id,
    p_expected_generation: claim.test_memory_generation,
    p_claim_token: claim.claim_token,
    p_outcome: outcome,
    p_summary_pt: summary,
  });
  return error === null && data?.summary_status === "ready";
}

export async function tickSummaries(
  summarize: SummaryFunction = summarizeCallViaHermesSubscription,
): Promise<number> {
  let n = 0;
  for (let index = 0; index < 3; index += 1) {
    const { data, error } = await supa().rpc("claim_call_summary_subscription", {
      p_worker_id: WORKER_ID,
      p_lease_seconds: 120,
    });
    if (error || !Array.isArray(data) || data.length === 0) break;
    let call: ClaimedSummary;
    try { call = claimedSummary(data[0]); }
    catch { break; }
    const transcript = summaryTranscript(call.transcript);
    if (!transcript.length) {
      if (await completeSummary(call, "ready", "Chamada sem fala registrada.")) n += 1;
      continue;
    }
    try {
      const result = await summarize({
        tenant: { id: call.tenant_id, slug: call.tenant_slug },
        transcript,
      });
      if (await completeSummary(call, "ready", result.summary_pt)) n += 1;
    } catch {
      console.warn(
        `summary subscription retry call=${call.call_id.slice(0, 8)} attempt=${call.attempt_number}`,
      );
      await completeSummary(call, "retry", null);
      break;
    }
  }
  return n;
}

// ---------------------------------------------------------------- 70/90% usage alerts
export async function tickUsageAlerts(): Promise<void> {
  const { data: tenants } = await supa().from("tenants").select("id,plan_minutes").eq("status", "active");
  for (const t of tenants ?? []) {
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const { data: rows } = await supa().from("usage_ledger")
      .select("minutes").eq("tenant_id", t.id).eq("kind", "usage").gte("created_at", monthStart.toISOString());
    const used = (rows ?? []).reduce((a, r) => a + Number(r.minutes ?? 0), 0);
    const pct = (used / Math.max(t.plan_minutes, 1)) * 100;
    for (const [threshold, kind] of [[70, "usage_70"], [90, "usage_90"]] as const) {
      if (pct >= threshold) {
        const { data: existing } = await supa().from("notifications")
          .select("id").eq("tenant_id", t.id).eq("kind", kind).gte("created_at", monthStart.toISOString()).limit(1);
        if (!existing?.length) {
          await supa().from("notifications").insert({ tenant_id: t.id, kind, payload: { minutes_used: Number(used.toFixed(1)), plan_minutes: t.plan_minutes, pct: Number(pct.toFixed(1)) } });
        }
      }
    }
  }
}

export function startWorkerLoop() {
  const loop = async () => {
    try { await tickIntents(); } catch (e) { console.error("intents", e); }
    try { await tickSummaries(); } catch (e) { console.error("summaries", e); }
    try { const { tickLearning } = await import("./learning.ts"); await tickLearning(); } catch (e) { console.error("learning", e); }
    try { await reconcileBudgetReservations(); } catch (e) { console.error("budget reconciliation", e); }
    try { await reconcileProviderTerminations(); } catch (e) { console.error("provider termination reconciliation", e); }
  };
  setInterval(loop, 1_000);
  setInterval(() => reapAbandonedCalls().catch((e) => console.error("abandoned call reaper", e)), 60_000);
  setInterval(() => tickUsageAlerts().catch((e) => console.error("usage", e)), 60_000);
  console.log("action worker loop started");
}

if (import.meta.main) startWorkerLoop();
