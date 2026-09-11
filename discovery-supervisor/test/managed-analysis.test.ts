import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import type { AgentSession, AgentSessionItem } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { ManagedDiscoveryWorkflow, managedAnalysisRequest, type ManagedAnalysisStore, type ManagedAnalysisClient, type ManagedAnalysisJob, type AnalysisIdentity } from "../src/managed/workflow";

const identity = { jobId: "job-1", tenantId: "tenant-1" };
const source = { url: "https://example.com/", retrieved_at: "2026-09-10T00:00:00.000Z", http_status: 200, mime_type: "text/html" as const,
  byte_length: 30, content_hash: "b".repeat(64), excerpt: "Example Plumbing", crawl_order: 0, crawl_depth: 0 };
const extraction = { company: { name: { value: "Example Plumbing", evidence: [{ source_id: "s0", excerpt: "Example Plumbing" }] }, description: null,
  public_phone: null, public_email: null, public_address: null }, services: [], public_prices_and_conditions: [], service_area: [], business_hours: null,
  guarantees: [], booking_restrictions: [], emergency_and_safety: [], missing_questions: ["Quais condições precisam ser confirmadas?"], contradictions: [] };
async function* values<T>(rows: T[]) { for (const row of rows) yield row; }
function fixture() {
  let job: ManagedAnalysisJob = { job_id: identity.jobId, tenant_id: identity.tenantId, attempt_id: "attempt-1", input_version: "a".repeat(64), state: "prepared",
    session_id: null, turn_id: null, result_id: null, created_at: "2026-09-10T00:00:00.000Z", source_snapshots: [source] };
  let commits = 0, launches = 0, cancelCalls = 0, lastResult: any, verified = false;
  const check = (i: AnalysisIdentity) => { if (i.jobId !== job.job_id || i.tenantId !== job.tenant_id) throw Error("not found"); };
  const store: ManagedAnalysisStore = {
    read: async i => { check(i); return structuredClone(job); },
    claimLaunch: async i => { check(i); const claimed = job.state === "prepared"; if (claimed) job.state = "launching"; return { claimed, job: structuredClone(job) }; },
    bind: async (i, id) => { check(i); if (job.session_id && job.session_id !== id) throw Error("session mismatch"); job.session_id = id; if (job.state === "launching") job.state = "running"; },
    observe: async (i, observation, result) => { check(i); job.turn_id = observation.turn_id;
      if (!["completed", "cancelled", "failed"].includes(job.state)) job.state = observation.state;
      if (result && !job.result_id && job.state === "completed") { commits++; lastResult = result; job.result_id = "result-new"; }
      return structuredClone(job); },
    requestCancel: async i => { check(i); if (!["completed", "failed", "cancelled"].includes(job.state)) job.state = job.state === "prepared" ? "cancelled" : "cancel_requested"; return structuredClone(job); },
    findBySession: async id => id === job.session_id ? structuredClone(job) : null,
  };
  const session = { id: "sess-1", object: "agent.session", created_at: Date.parse(job.created_at) / 1000, metadata: managedAnalysisRequest(job).metadata,
    agent: { model: "gpt-5.6-terra" }, environment: { type: "none" }, status: "idle", usage: null, required_actions: [], error: null } as unknown as AgentSession;
  const turn = { id: "turn-1", session_id: session.id, subagent_id: null, status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } }, error: null } as Turn;
  let items = [{ id: "item-1", type: "message", role: "assistant", phase: "final_answer", turn_id: turn.id, status: "completed", content: [{ type: "output_text", text: JSON.stringify(extraction) }] }] as AgentSessionItem[];
  let createFailure = false;
  let listedSessions: AgentSession[] = [session];
  const client: ManagedAnalysisClient = {
    beta: { agents: { sessions: {
      create: async (body, options) => { launches++; expect(body.environment.type).toBe("none"); expect(options?.maxRetries).toBe(0); if (createFailure) throw Error("lost response"); return session; },
      retrieve: async id => { expect(id).toBe(session.id); return session; },
      list: () => values(listedSessions),
      turns: { list: () => values([turn]) },
      items: { list: () => values(items) },
      events: { create: async (_, payload) => { cancelCalls++; expect(payload.events[0].type).toBe("agent.session.input.cancel"); turn.status = "cancelled"; } },
    } } },
    webhooks: { verifySignature: async () => { verified = true; } } as Pick<OpenAI["webhooks"], "verifySignature">,
  };
  const workflow = new ManagedDiscoveryWorkflow({ client, store, authorizeLaunch: async () => undefined });
  return { workflow, client, store, session, turn, job: () => job, counts: () => ({ commits, launches, cancelCalls }), lastResult: () => lastResult,
    loseCreate: () => { createFailure = true; }, noSession: () => { listedSessions = []; }, items: (next: AgentSessionItem[]) => { items = next; }, verified: () => verified };
}

describe("managed source-only discovery analysis", () => {
  test("launches one hosted agent, maps the actual final output to product v2 and preserves evidence", async () => {
    const f = fixture(); const result = await f.workflow.launch(identity);
    expect(result.state).toBe("completed"); expect(f.counts()).toEqual({ commits: 1, launches: 1, cancelCalls: 0 });
    expect(f.lastResult().source_snapshots).toEqual([source]);
    expect(f.lastResult().candidate_facts[0].normalized_value).toBe("Example Plumbing");
    expect(f.lastResult().schema_version).toBe("company_discovery.result.v2");
    const request = managedAnalysisRequest(f.job());
    expect(request.agent?.tools).toEqual([]); expect(request.agent?.multi_agent).toEqual({ enabled: false });
    expect(JSON.stringify(request)).not.toContain("subscription");
  });
  test("lost create response recovers the same session from metadata without another create", async () => {
    const f = fixture(); f.loseCreate(); await expect(f.workflow.launch(identity)).rejects.toThrow("lost response");
    expect((await f.workflow.launch(identity)).state).toBe("completed"); expect(f.counts().launches).toBe(1);
  });
  test("unknown launch with no provider match remains uncertain and never auto-resubmits", async () => {
    const f = fixture(); f.loseCreate(); f.noSession(); await expect(f.workflow.launch(identity)).rejects.toThrow();
    expect((await f.workflow.launch(identity)).state).toBe("launching"); expect(f.counts().launches).toBe(1);
  });
  test("repeat and concurrent launch/readback commit only one result", async () => {
    const f = fixture(); await Promise.all([f.workflow.launch(identity), f.workflow.launch(identity)]);
    await f.workflow.reconcile(identity); expect(f.counts().launches).toBe(1); expect(f.counts().commits).toBe(1);
  });
  test("session idle is not turn success", async () => {
    const f = fixture(); f.turn.status = "in_progress";
    expect((await f.workflow.launch(identity)).state).toBe("running"); expect(f.counts().commits).toBe(0);
  });
  test("provider failed turn stays failed and never persists a candidate", async () => {
    const f = fixture(); f.turn.status = "failed";
    expect((await f.workflow.launch(identity)).state).toBe("failed"); expect(f.counts().commits).toBe(0);
  });
  test("cross-tenant input is rejected before provider launch", async () => {
    const f = fixture(); await expect(f.workflow.launch({ ...identity, tenantId: "other" })).rejects.toThrow(); expect(f.counts().launches).toBe(0);
  });
  test("provider metadata cannot relabel a session to another input revision", async () => {
    const f = fixture(); f.session.metadata.input_version = "c".repeat(64);
    await expect(f.workflow.launch(identity)).rejects.toThrow("scope_mismatch"); expect(f.counts().commits).toBe(0);
  });
  test("invalid grounded output is recorded as failure", async () => {
    const f = fixture(); f.items([{ id: "bad", type: "message", role: "assistant", phase: "final_answer", turn_id: f.turn.id, status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ ...extraction, company: { ...extraction.company, name: { value: "Invented", evidence: [{ source_id: "s0", excerpt: "Invented" }] } } }) }] }]);
    expect((await f.workflow.launch(identity)).state).toBe("failed"); expect(f.counts().commits).toBe(0);
  });
  test("completed turn without a final saved item is recorded as failure", async () => {
    const f = fixture(); f.items([]); expect((await f.workflow.launch(identity)).state).toBe("failed"); expect(f.counts().commits).toBe(0);
  });
  test("cancel while running prevents raced completed output from committing", async () => {
    const f = fixture(); f.turn.status = "in_progress"; await f.workflow.launch(identity);
    f.turn.status = "completed"; await f.workflow.cancel(identity);
    expect(f.job().state).toBe("cancelled"); expect(f.counts().commits).toBe(0);
  });
  test("cancel before launch does not create a provider session", async () => {
    const f = fixture(); await f.workflow.cancel(identity); expect(f.counts().launches).toBe(0); expect(f.job().state).toBe("cancelled");
  });
  test("verified repeated webhook only reconciles, never reruns the mission", async () => {
    const f = fixture(); await f.workflow.launch(identity);
    const payload = JSON.stringify({ id: "evt-1", type: "agent.session.idle", data: { id: f.session.id } });
    await f.workflow.webhook(payload, new Headers()); await f.workflow.webhook(payload, new Headers());
    expect(f.verified()).toBe(true); expect(f.counts().launches).toBe(1); expect(f.counts().commits).toBe(1);
  });
  test("created webhook recovers a launch whose create response was lost", async () => {
    const f = fixture(); f.loseCreate(); await expect(f.workflow.launch(identity)).rejects.toThrow();
    const result = await f.workflow.webhook(JSON.stringify({ id: "evt-created", type: "agent.session.created", data: { id: f.session.id } }), new Headers());
    expect(result?.state).toBe("completed"); expect(f.counts().launches).toBe(1);
  });
  test("invalid webhook signature is rejected before any observation", async () => {
    const f = fixture(); f.client.webhooks.verifySignature = async () => { throw Error("invalid signature"); };
    await expect(f.workflow.webhook(JSON.stringify({ id: "evt-created", type: "agent.session.created", data: { id: f.session.id } }), new Headers())).rejects.toThrow("invalid signature");
    expect(f.job().state).toBe("prepared"); expect(f.counts().launches).toBe(0);
  });
  test("actual pinned public SDK uses managed endpoints and paginates saved items", async () => {
    const f = fixture(); const calls: string[] = [];
    const sdk = new OpenAI({ apiKey: "unused-local-fixture", fetch: async (url, init) => {
      const parsed = new URL(String(url)); calls.push(`${init?.method ?? "GET"} ${parsed.pathname}${parsed.search}`);
      expect(new Headers(init?.headers).get("openai-beta")).toBe("agents=v1");
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); expect(body.agent.model).toBe("gpt-5.6-terra"); expect(body.environment).toEqual({ type: "none" });
        expect(body.agent.text.format.type).toBe("json_schema"); expect(body.metadata.job_id).toBe(identity.jobId);
        return Response.json(f.session);
      }
      if (parsed.pathname.endsWith("/turns")) return Response.json({ object: "list", data: [f.turn], has_more: false });
      if (parsed.pathname.endsWith("/items")) {
        if (!parsed.searchParams.has("after")) return Response.json({ object: "list", data: [{ id: "commentary", turn_id: f.turn.id, type: "message", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Inspecting evidence." }] }], has_more: true, last_id: "commentary" });
        return Response.json({ object: "list", data: [{ id: "final-item", turn_id: f.turn.id, type: "message", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify(extraction) }] }], has_more: false });
      }
      return Response.json(f.session);
    } });
    const workflow = new ManagedDiscoveryWorkflow({ client: sdk, store: f.store, authorizeLaunch: async () => undefined });
    expect((await workflow.launch(identity)).state).toBe("completed");
    expect(calls[0]).toBe("POST /v1/agents/sessions"); expect(calls.some(call => call.includes("after=commentary"))).toBe(true);
    expect(calls.some(call => /responses|codex|chat\/completions/.test(call))).toBe(false);
  });
  test("denied existing spend authority prevents both claim and provider invocation", async () => {
    const f = fixture(); const blocked = new ManagedDiscoveryWorkflow({ client: f.client, store: f.store, authorizeLaunch: async () => { throw Error("existing allowance exhausted"); } });
    await expect(blocked.launch(identity)).rejects.toThrow("allowance"); expect(f.job().state).toBe("prepared"); expect(f.counts().launches).toBe(0);
  });
});
