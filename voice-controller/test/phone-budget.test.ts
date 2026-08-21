import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleIncoming } from "../src/phone.ts";
import { _setClient, invalidateTenant } from "../src/rules.ts";

const TENANT = {
  id: "tenant-1", slug: "rocha-plumbing", name: "Rocha Plumbing", vertical: "plumbing",
  languages: ["en", "es"], timezone: "America/Los_Angeles", session_max_minutes: 15,
  owner_user_id: "owner-1", auth_epoch: 2, policy_epoch: 3,
};
const EVENT = { id: "event-1", openai_call_id: "rtc-1" };

type ProviderAction = "accept" | "reject" | "hangup";
type ProviderPlan = Response | Error | (() => Promise<Response>);

class SyntheticPhoneStore {
  tenant = { ...TENANT };
  event: any = {
    ...EVENT,
    status: "pending",
    lifecycle_state: "pending",
    lifecycle_owner: null,
    lifecycle_claim_token: null,
    tenant_id: null,
    call_id: null,
    provider_accept_state: "not_attempted",
    provider_termination_state: "not_required",
    provider_termination_mode: null,
    sideband_state: "not_attached",
    lifecycle_last_error: null,
  };
  calls = new Map<string, any>();
  reservations = new Map<string, any>();
  history: Array<{ status: string; lifecycle: string; accept: string; termination: string; sideband: string }> = [];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  providerCalls: ProviderAction[] = [];
  providerUrls: string[] = [];
  callInsertAttempts = 0;
  claimAttempts: string[] = [];
  failures = new Set<string>();
  providerPlan: Record<ProviderAction, ProviderPlan> = {
    accept: new Response(null, { status: 200 }),
    reject: new Response(null, { status: 200 }),
    hangup: new Response(null, { status: 200 }),
  };
  private claimSequence = 0;

  constructor() { this.record(); }

  client() {
    return {
      from: (table: string) => new SyntheticQuery(this, table),
      rpc: (name: string, args: Record<string, unknown>) => this.rpc(name, args),
    } as any;
  }

  fetch = async (input: string | URL | Request): Promise<Response> => {
    this.providerUrls.push(String(input));
    const action = String(input).split("/").at(-1) as ProviderAction;
    if (!(["accept", "reject", "hangup"] as string[]).includes(action)) throw new Error(`unexpected_provider_action:${action}`);
    this.providerCalls.push(action);
    const plan = this.providerPlan[action];
    if (plan instanceof Error) throw plan;
    return typeof plan === "function" ? await plan() : plan.clone();
  };

  record() {
    const snapshot = {
      status: this.event.status,
      lifecycle: this.event.lifecycle_state,
      accept: this.event.provider_accept_state,
      termination: this.event.provider_termination_state,
      sideband: this.event.sideband_state,
    };
    const previous = this.history.at(-1);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(snapshot)) this.history.push(snapshot);
  }

  mutateEvent(values: Record<string, unknown>) {
    Object.assign(this.event, values);
    this.record();
  }

  private owns(args: Record<string, unknown>) {
    return this.event.id === args.p_event_id && this.event.lifecycle_claim_token === args.p_claim_token;
  }

  async rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    if (name === "claim_phone_event") {
      const worker = String(args.p_worker);
      this.claimAttempts.push(worker);
      if (this.event.status !== "pending" || this.event.lifecycle_state !== "pending") return { data: null, error: null };
      const token = `00000000-0000-4000-8000-${String(++this.claimSequence).padStart(12, "0")}`;
      this.mutateEvent({ lifecycle_state: "claimed", lifecycle_owner: worker, lifecycle_claim_token: token });
      return { data: { id: this.event.id, claim_token: token, openai_call_id: this.event.openai_call_id }, error: null };
    }
    if (name === "persist_phone_call") {
      if (this.failures.has(name)) return { data: null, error: { message: "synthetic call insert failure" } };
      if (!this.owns(args) || this.event.lifecycle_state !== "claimed") return { data: null, error: { message: "phone_claim_lost" } };
      this.callInsertAttempts += 1;
      const id = "call-1";
      this.calls.set(id, {
        id, tenant_id: args.p_tenant_id, phone_event_id: this.event.id, openai_call_id: this.event.openai_call_id,
        status: "active", provider_termination_state: "active", provider_termination_mode: "reject",
        provider_usage_state: "unknown", duration_seconds: null, cost_estimate_usd: null,
      });
      this.mutateEvent({ tenant_id: args.p_tenant_id, call_id: id, lifecycle_state: "call_persisted" });
      return { data: id, error: null };
    }
    if (name === "reserve_phone_call_budget") {
      if (this.failures.has(name)) return { data: null, error: { message: "synthetic budget denial" } };
      if (!this.owns(args) || this.event.lifecycle_state !== "call_persisted") return { data: null, error: { message: "phone_claim_lost" } };
      this.reservations.set(this.event.call_id, { id: "reservation-1", call_id: this.event.call_id, status: "active" });
      this.mutateEvent({ lifecycle_state: "budget_reserved" });
      return { data: "reservation-1", error: null };
    }
    if (name === "begin_phone_provider_accept") {
      if (this.failures.has(name)) return { data: null, error: { message: "synthetic accept intent failure" } };
      if (!this.owns(args) || this.event.lifecycle_state !== "budget_reserved") return { data: null, error: { message: "phone_claim_lost" } };
      this.mutateEvent({ lifecycle_state: "accepting", provider_accept_state: "attempting" });
      return { data: true, error: null };
    }
    if (name === "confirm_phone_provider_accept") {
      if (this.failures.has(name)) return { data: null, error: { message: "synthetic accept persistence failure" } };
      if (!this.owns(args) || this.event.lifecycle_state !== "accepting") return { data: null, error: { message: "phone_claim_lost" } };
      this.mutateEvent({ status: "accepted", lifecycle_state: "accepted", provider_accept_state: "accepted" });
      Object.assign(this.calls.get(this.event.call_id), { provider_termination_mode: "hangup", provider_termination_state: "active" });
      return { data: true, error: null };
    }
    if (name === "begin_phone_sideband") {
      if (this.failures.has(name)) return { data: null, error: { message: "synthetic sideband ownership failure" } };
      if (!this.owns(args) || this.event.lifecycle_state !== "accepted") return { data: null, error: { message: "phone_claim_lost" } };
      this.mutateEvent({ lifecycle_state: "sideband_attaching", sideband_state: "attaching" });
      return { data: true, error: null };
    }
    if (name === "confirm_phone_sideband") {
      if (this.failures.has(name)) return { data: null, error: { message: "synthetic sideband persistence failure" } };
      if (!this.owns(args) || this.event.lifecycle_state !== "sideband_attaching") return { data: null, error: { message: "phone_claim_lost" } };
      this.mutateEvent({ lifecycle_state: "active", sideband_state: "attached" });
      return { data: true, error: null };
    }
    if (name === "begin_phone_termination") {
      if (!this.owns(args)) return { data: null, error: { message: "phone_claim_lost" } };
      if (["pending", "confirmed", "unknown"].includes(this.event.provider_termination_state)) {
        return { data: { should_attempt: false }, error: null };
      }
      const mode = String(args.p_mode);
      this.mutateEvent({
        provider_accept_state: args.p_accept_state ?? this.event.provider_accept_state,
        provider_termination_state: "pending",
        provider_termination_mode: mode,
        lifecycle_last_error: args.p_reason,
        sideband_state: this.event.sideband_state === "attaching" ? "failed" : this.event.sideband_state,
      });
      const call = this.calls.get(this.event.call_id);
      if (call) Object.assign(call, {
        status: "error", provider_termination_state: "pending", provider_termination_mode: mode,
        provider_termination_reason: args.p_reason, provider_usage_state: "unknown",
        duration_seconds: null, cost_estimate_usd: null,
      });
      return { data: { should_attempt: true, openai_call_id: this.event.openai_call_id }, error: null };
    }
    if (name === "complete_phone_termination") {
      if (!this.owns(args)) return { data: null, error: { message: "phone_claim_lost" } };
      const confirmed = args.p_confirmed === true;
      const rejected = confirmed && this.event.provider_termination_mode === "reject"
        && this.event.provider_accept_state !== "accepted" && this.event.provider_accept_state !== "unknown";
      this.mutateEvent(confirmed ? {
        status: rejected ? "rejected" : "error",
        lifecycle_state: rejected ? "rejected" : "terminated",
        provider_termination_state: "confirmed",
        lifecycle_last_error: args.p_error ?? this.event.lifecycle_last_error,
      } : {
        status: "error",
        lifecycle_state: "reconciliation_required",
        provider_termination_state: "unknown",
        lifecycle_last_error: args.p_error,
      });
      const call = this.calls.get(this.event.call_id);
      if (call) Object.assign(call, { provider_termination_state: confirmed ? "confirmed" : "unknown" });
      return { data: true, error: null };
    }
    if (name === "claim_phone_lifecycle_reconciliation") {
      const worker = String(args.p_worker);
      if (this.event.lifecycle_state !== "reconciliation_required") return { data: null, error: null };
      const token = `00000000-0000-4000-8000-${String(++this.claimSequence).padStart(12, "0")}`;
      this.mutateEvent({
        lifecycle_owner: worker,
        lifecycle_claim_token: token,
        provider_termination_state: "pending",
      });
      return { data: {
        event_id: this.event.id,
        claim_token: token,
        action: "terminate",
        openai_call_id: this.event.openai_call_id,
        provider_termination_mode: this.event.provider_termination_mode,
      }, error: null };
    }
    if (name === "reserve_call_budget") {
      if (this.failures.has("reserve_phone_call_budget")) return { data: null, error: { message: "synthetic budget denial" } };
      const callId = String(args.p_call);
      this.reservations.set(callId, { id: "reservation-1", call_id: callId, status: "active" });
      return { data: "reservation-1", error: null };
    }
    if (name === "settle_call_budget") {
      const reservation = this.reservations.get(String(args.p_call));
      if (reservation) reservation.status = "settled";
      return { data: reservation?.id ?? null, error: reservation ? null : { message: "reservation_not_found" } };
    }
    return { data: null, error: null };
  }
}

class SyntheticQuery {
  private operation: "select" | "update" | "insert" = "select";
  private values: any = null;
  private filters: Array<[string, unknown]> = [];
  private wantsData = false;

  constructor(private store: SyntheticPhoneStore, private table: string) {}
  select() { this.wantsData = true; return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  lt() { return this; }
  limit() { return this; }
  update(values: any) { this.operation = "update"; this.values = values; return this; }
  insert(values: any) { this.operation = "insert"; this.values = values; return this; }
  single() { return this.execute(true); }
  then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) { return this.execute(false).then(resolve, reject); }

  private matches(row: any) { return this.filters.every(([column, value]) => row?.[column] === value); }

  private async execute(single: boolean) {
    if (this.operation === "select") {
      if (this.table === "tenants") return { data: { ...this.store.tenant }, error: null };
      if (this.table === "effective_rules") return { data: [], error: null };
      if (this.table === "phone_events") {
        const rows = this.matches(this.store.event) ? [{ ...this.store.event }] : [];
        return { data: single ? rows[0] ?? null : rows, error: null };
      }
      return { data: single ? null : [], error: null };
    }
    if (this.operation === "insert" && this.table === "calls") {
      this.store.callInsertAttempts += 1;
      if (this.store.failures.has("persist_phone_call")) return { data: null, error: { message: "synthetic call insert failure" } };
      const call = { id: "call-1", ...this.values };
      this.store.calls.set(call.id, call);
      return { data: single || this.wantsData ? call : null, error: null };
    }
    if (this.operation === "update" && this.table === "phone_events") {
      if (!this.matches(this.store.event)) return { data: this.wantsData ? [] : null, error: null };
      this.store.mutateEvent(this.values);
      return { data: this.wantsData ? [{ id: this.store.event.id }] : null, error: null };
    }
    if (this.operation === "update" && this.table === "calls") {
      const call = [...this.store.calls.values()].find((candidate) => this.matches(candidate));
      if (call) Object.assign(call, this.values);
      return { data: null, error: null };
    }
    if (this.operation === "update" && this.table === "budget_reservations") {
      const reservation = [...this.store.reservations.values()].find((candidate) => this.matches(candidate));
      if (reservation) Object.assign(reservation, this.values);
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let activeStore: SyntheticPhoneStore;

function activate(store = new SyntheticPhoneStore()) {
  activeStore = store;
  invalidateTenant(TENANT.slug);
  _setClient(store.client());
  globalThis.fetch = store.fetch as typeof fetch;
  globalThis.WebSocket = class { constructor() { throw new Error("unexpected_real_sideband"); } } as any;
  return store;
}

async function runPhone(store: SyntheticPhoneStore, options: Record<string, unknown> = {}, row: any = EVENT) {
  try {
    await handleIncoming(row, {
      workerId: "worker-a",
      fetchImpl: store.fetch,
      attachSidebandImpl: () => ({}),
      ...options,
    } as any);
    return null;
  } catch (error) {
    return error as Error;
  }
}

beforeEach(() => activate());
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});
afterAll(() => _setClient(null));

describe("durable inbound phone lifecycle", () => {
  test("1. calls insert failure rejects before provider acceptance", async () => {
    activeStore.failures.add("persist_phone_call");
    await runPhone(activeStore);

    expect(activeStore.providerCalls).toEqual(["reject"]);
    expect(activeStore.event).toMatchObject({ status: "rejected", lifecycle_state: "rejected", provider_accept_state: "not_attempted" });
    expect(activeStore.calls.size).toBe(0);
    expect(activeStore.reservations.size).toBe(0);
  });

  test("2. budget reservation failure rejects before provider acceptance", async () => {
    activeStore.failures.add("reserve_phone_call_budget");
    await runPhone(activeStore);

    expect(activeStore.providerCalls).toEqual(["reject"]);
    expect(activeStore.event).toMatchObject({ status: "rejected", lifecycle_state: "rejected", call_id: "call-1" });
    expect(activeStore.reservations.size).toBe(0);
  });

  test("3. confirmed provider reject is a durable terminal phone-event state", async () => {
    activeStore.tenant.owner_user_id = null;
    await runPhone(activeStore);

    expect(activeStore.providerCalls).toEqual(["reject"]);
    expect(activeStore.event).toMatchObject({
      status: "rejected", lifecycle_state: "rejected", provider_termination_state: "confirmed", provider_termination_mode: "reject",
    });
  });

  test("4. ambiguous provider reject remains executable reconciliation without a calls row", async () => {
    activeStore.failures.add("persist_phone_call");
    activeStore.providerPlan.reject = new Error("reject transport unknown");
    await runPhone(activeStore);

    expect(activeStore.calls.size).toBe(0);
    expect(activeStore.event).toMatchObject({
      status: "error", lifecycle_state: "reconciliation_required", provider_termination_state: "unknown", provider_termination_mode: "reject",
    });
    expect(activeStore.event.openai_call_id).toBe("rtc-1");
  });

  test("5. provider accept success followed by durable acceptance failure hangs up", async () => {
    activeStore.failures.add("confirm_phone_provider_accept");
    await runPhone(activeStore);

    expect(activeStore.providerCalls).toEqual(["accept", "hangup"]);
    expect(activeStore.event).toMatchObject({ status: "error", lifecycle_state: "terminated", provider_termination_state: "confirmed" });
  });

  test("6. every post-accept pre-sideband failure uses hangup rather than reject", async () => {
    activeStore.failures.add("begin_phone_sideband");
    await runPhone(activeStore);

    expect(activeStore.providerCalls).toEqual(["accept", "hangup"]);
    expect(activeStore.event.provider_termination_mode).toBe("hangup");
  });

  test("7. ambiguous hangup persists reconciliation_required", async () => {
    activeStore.failures.add("begin_phone_sideband");
    activeStore.providerPlan.hangup = new Response("unavailable", { status: 503 });
    await runPhone(activeStore);

    expect(activeStore.providerCalls).toEqual(["accept", "hangup"]);
    expect(activeStore.event).toMatchObject({
      status: "error", lifecycle_state: "reconciliation_required", provider_termination_state: "unknown", provider_termination_mode: "hangup",
    });
  });

  test("8. sideband is never attached after failed durable ownership", async () => {
    activeStore.failures.add("persist_phone_call");
    let sidebandAttaches = 0;
    await runPhone(activeStore, { attachSidebandImpl: () => { sidebandAttaches += 1; return {}; } });

    expect(sidebandAttaches).toBe(0);
    expect(activeStore.providerCalls).toEqual(["reject"]);
  });

  test("9. handler retries do not double-accept, double-reject, or double-hangup", async () => {
    const rejected = activate();
    rejected.failures.add("persist_phone_call");
    await runPhone(rejected);
    await runPhone(rejected, { workerId: "worker-b" });
    expect(rejected.providerCalls).toEqual(["reject"]);

    const accepted = activate();
    accepted.failures.add("begin_phone_sideband");
    await runPhone(accepted);
    await runPhone(accepted, { workerId: "worker-b" });
    expect(accepted.providerCalls).toEqual(["accept", "hangup"]);
  });

  test("10. termination before sideband preserves an active reservation and never invents zero settlement", async () => {
    activeStore.failures.add("begin_phone_sideband");
    await runPhone(activeStore);

    expect(activeStore.reservations.get("call-1")?.status).toBe("active");
    expect(activeStore.rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
    expect(activeStore.calls.get("call-1")).toMatchObject({
      provider_usage_state: "unknown", duration_seconds: null, cost_estimate_usd: null,
    });
  });

  test("11. phone-event status stays truthful through claim, persistence, reservation, accept, and sideband", async () => {
    let sidebandAttaches = 0;
    const error = await runPhone(activeStore, { attachSidebandImpl: () => { sidebandAttaches += 1; return {}; } });

    expect(error).toBeNull();
    expect(sidebandAttaches).toBe(1);
    expect(activeStore.history.map((entry) => entry.lifecycle)).toEqual([
      "pending", "claimed", "call_persisted", "budget_reserved", "accepting", "accepted", "sideband_attaching", "active",
    ]);
    expect(activeStore.history.slice(0, 5).every((entry) => entry.status === "pending")).toBe(true);
    expect(activeStore.event).toMatchObject({ status: "accepted", lifecycle_state: "active", sideband_state: "attached" });
  });

  test("12. a second worker cannot take ownership after the first commits a lifecycle transition", async () => {
    let releaseAccept!: () => void;
    let markAcceptStarted!: () => void;
    const acceptGate = new Promise<void>((resolve) => { releaseAccept = resolve; });
    const acceptStarted = new Promise<void>((resolve) => { markAcceptStarted = resolve; });
    activeStore.providerPlan.accept = async () => {
      markAcceptStarted();
      await acceptGate;
      return new Response(null, { status: 200 });
    };
    let sidebandAttaches = 0;
    const first = runPhone(activeStore, { workerId: "worker-a", attachSidebandImpl: () => { sidebandAttaches += 1; return {}; } });
    await acceptStarted;
    const second = runPhone(activeStore, { workerId: "worker-b", attachSidebandImpl: () => { sidebandAttaches += 1; return {}; } });
    releaseAccept();
    await Promise.all([first, second]);

    expect(activeStore.event.lifecycle_owner).toBe("worker-a");
    expect(activeStore.claimAttempts).toEqual(["worker-a", "worker-b"]);
    expect(activeStore.callInsertAttempts).toBe(1);
    expect(activeStore.reservations.size).toBe(1);
    expect(activeStore.providerCalls).toEqual(["accept"]);
    expect(sidebandAttaches).toBe(1);
  });

  test("13. accept transport unknown is potentially accepted and therefore hangs up", async () => {
    activeStore.providerPlan.accept = new Error("accept transport unknown");
    await runPhone(activeStore);

    expect(activeStore.providerCalls).toEqual(["accept", "hangup"]);
    expect(activeStore.event).toMatchObject({
      provider_accept_state: "unknown", provider_termination_mode: "hangup", lifecycle_state: "terminated",
    });
    expect(activeStore.reservations.get("call-1")?.status).toBe("active");
  });

  test("14. phone-event reconciliation executes and idempotently confirms reject without a calls row", async () => {
    activeStore.failures.add("persist_phone_call");
    activeStore.providerPlan.reject = new Error("reject transport unknown");
    await runPhone(activeStore);
    activeStore.providerPlan.reject = new Response(null, { status: 200 });
    const phone = await import("../src/phone.ts") as any;

    expect(typeof phone.reconcilePhoneLifecycles).toBe("function");
    expect(await phone.reconcilePhoneLifecycles({ workerId: "reconciler-a", fetchImpl: activeStore.fetch })).toBe(1);
    expect(await phone.reconcilePhoneLifecycles({ workerId: "reconciler-b", fetchImpl: activeStore.fetch })).toBe(0);
    expect(activeStore.calls.size).toBe(0);
    expect(activeStore.providerCalls).toEqual(["reject", "reject"]);
    expect(activeStore.event).toMatchObject({ lifecycle_state: "rejected", provider_termination_state: "confirmed" });
  });

  test("15. attachSideband throw hangs up and never settles the reservation", async () => {
    await runPhone(activeStore, { attachSidebandImpl: () => { throw new Error("sideband attach failed"); } });

    expect(activeStore.providerCalls).toEqual(["accept", "hangup"]);
    expect(activeStore.event.sideband_state).toBe("failed");
    expect(activeStore.reservations.get("call-1")?.status).toBe("active");
    expect(activeStore.rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });

  test("16. sideband confirmation persistence failure hangs up after one attach", async () => {
    activeStore.failures.add("confirm_phone_sideband");
    let sidebandAttaches = 0;
    await runPhone(activeStore, { attachSidebandImpl: () => { sidebandAttaches += 1; return {}; } });

    expect(sidebandAttaches).toBe(1);
    expect(activeStore.providerCalls).toEqual(["accept", "hangup"]);
    expect(activeStore.event).toMatchObject({ status: "error", lifecycle_state: "terminated", sideband_state: "failed" });
  });

  test("17. provider writes use the canonical claimed call id, never the untrusted realtime payload", async () => {
    await runPhone(activeStore, { attachSidebandImpl: () => ({}) }, { ...EVENT, openai_call_id: "rtc-attacker" });

    expect(activeStore.providerCalls).toEqual(["accept"]);
    expect(activeStore.providerUrls[0]).toContain("/rtc-1/accept");
    expect(activeStore.providerUrls.join("\n")).not.toContain("rtc-attacker");
  });
});
