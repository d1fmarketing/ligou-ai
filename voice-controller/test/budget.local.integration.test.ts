import { expect, test } from "bun:test";

import { finalizeTerminalBudget, reserveCallBudget, settleCallBudget } from "../src/budget.ts";
import { supa } from "../src/rules.ts";

const tenantId = process.env.LIGOU_TEST_PRESEEDED_TENANT_ID ?? "";
if (!tenantId || process.env.LIGOU_LOCAL_DB_TEST !== "1") {
  throw new Error("local_budget_integration_environment_required");
}

test("voice-controller defers an unresolved reservation through the real service_role REST path", async () => {
  const { data: call, error: callError } = await supa().from("calls").insert({
    tenant_id: tenantId,
    channel: "eval",
    session_type: "customer",
    status: "error",
    ended_at: new Date().toISOString(),
    provider_termination_state: "not_required",
    provider_usage_state: "unknown",
  }).select("id").single();
  expect(callError).toBeNull();
  expect(call?.id).toBeTruthy();

  const reservationId = await reserveCallBudget(tenantId, call.id, 1.25);
  expect(reservationId).toBeTruthy();

  const settled = await finalizeTerminalBudget({
    tenantId,
    callId: call.id,
    actualCostUsd: 0,
    minutes: 0,
    outcome: "error",
    usageResolved: false,
  });
  expect(settled).toBe(false);

  const { data: reservation, error: reservationError } = await supa()
    .from("budget_reservations")
    .select("id,status,reconcile_last_error,reconcile_after,reconcile_lease_until")
    .eq("id", reservationId)
    .single();
  expect(reservationError).toBeNull();
  expect(reservation.status).toBe("active");
  expect(reservation.reconcile_last_error).toContain("provider_usage_unresolved");
  expect(reservation.reconcile_after).toBeTruthy();
  expect(reservation.reconcile_lease_until).toBeNull();
});

test("real settlement rejects cost above the exact session reservation ceiling", async () => {
  const { data: call, error: callError } = await supa().from("calls").insert({
    tenant_id: tenantId,
    channel: "eval",
    session_type: "customer",
    status: "ended",
    ended_at: new Date().toISOString(),
    provider_termination_state: "confirmed",
    provider_usage_state: "resolved",
    provider_usage_evidence: { source: "synthetic-terminal", terminal: true, continuous: true },
  }).select("id").single();
  expect(callError).toBeNull();
  const reservationId = await reserveCallBudget(tenantId, call.id, 1.5);

  await expect(settleCallBudget({
    tenantId,
    callId: call.id,
    actualCostUsd: 1.5001,
    minutes: 15,
    outcome: "ended",
  })).rejects.toMatchObject({ message: "budget_settlement_failed" });

  const { data: reservation } = await supa().from("budget_reservations")
    .select("status,final_cost_usd").eq("id", reservationId).single();
  expect(reservation.status).toBe("active");
  expect(reservation.final_cost_usd).toBeNull();
});
