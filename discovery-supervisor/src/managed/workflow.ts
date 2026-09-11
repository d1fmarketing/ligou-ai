import type OpenAI from "openai";
import type { AgentSession, AgentSessionItem, TokenUsage } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import type { SessionCreateParamsNonStreaming } from "openai/resources/beta/agents/sessions/sessions";
import { createHash } from "node:crypto";
import { parseWorkerResult, type DiscoverySourceSnapshot, type WorkerResult } from "../contracts";
import { buildDirectModelEvidenceInput, COMPACT_MODEL_SCHEMA, DIRECT_MODEL_SYSTEM_INSTRUCTION, parseAndMapDirectModelExtraction } from "../adapters/direct-model-extraction";

export const MANAGED_ANALYSIS_MODEL = "gpt-5.6-terra";
export type AnalysisState = "prepared" | "launching" | "running" | "completed" | "failed" | "cancel_requested" | "cancelled";
export interface ManagedAnalysisJob {
  job_id: string;
  tenant_id: string;
  attempt_id: string;
  input_version: string;
  state: AnalysisState;
  session_id: string | null;
  turn_id: string | null;
  result_id: string | null;
  usage?: TokenUsage | null;
  provider_status?: string | null;
  cost_state?: "unreconciled";
  created_at: string;
  source_snapshots: readonly DiscoverySourceSnapshot[];
}
export interface AnalysisIdentity { jobId: string; tenantId: string }
export interface AnalysisObservation {
  session_id: string;
  turn_id: string | null;
  state: AnalysisState;
  provider_status: string;
  usage: TokenUsage | null;
  output_item_id?: string;
  output_sha256?: string;
  error_code?: string;
}
export interface ManagedAnalysisStore {
  read(identity: AnalysisIdentity): Promise<ManagedAnalysisJob>;
  claimLaunch(identity: AnalysisIdentity): Promise<{ claimed: boolean; job: ManagedAnalysisJob }>;
  bind(identity: AnalysisIdentity, sessionId: string): Promise<void>;
  observe(identity: AnalysisIdentity, observation: AnalysisObservation, result?: WorkerResult): Promise<ManagedAnalysisJob>;
  requestCancel(identity: AnalysisIdentity): Promise<ManagedAnalysisJob>;
  findBySession(sessionId: string): Promise<ManagedAnalysisJob | null>;
}

// These methods are the public OpenAI 7.15.0 Agents API, not the local Agents SDK.
export interface ManagedAnalysisClient {
  beta: { agents: { sessions: {
    create(body: SessionCreateParamsNonStreaming, options?: { maxRetries?: number }): PromiseLike<AgentSession>;
    retrieve(id: string): PromiseLike<AgentSession>;
    list(query: { order: "desc"; limit: number }): AsyncIterable<AgentSession>;
    turns: { list(id: string, query: { order: "asc"; limit: number }): AsyncIterable<Turn> };
    items: { list(id: string, query: { order: "asc"; limit: number }): AsyncIterable<AgentSessionItem> };
    events: { create(id: string, body: { events: [{ type: "agent.session.input.cancel" }] }): PromiseLike<unknown> };
  } } };
  webhooks: Pick<OpenAI["webhooks"], "verifySignature">;
}

export function managedAnalysisRequest(job: ManagedAnalysisJob): SessionCreateParamsNonStreaming {
  return {
    environment: { type: "none" },
    agent: {
      model: MANAGED_ANALYSIS_MODEL,
      reasoning: { effort: "medium" },
      instructions: DIRECT_MODEL_SYSTEM_INSTRUCTION,
      tools: [],
      multi_agent: { enabled: false },
      text: { format: { type: "json_schema", schema: COMPACT_MODEL_SCHEMA } },
    },
    input: JSON.stringify(buildDirectModelEvidenceInput(job.source_snapshots)),
    metadata: { workflow: "ligou_onboarding_analysis_v1", job_id: job.job_id, tenant_id: job.tenant_id, input_version: job.input_version },
    stream: false,
  };
}

function assertSession(job: ManagedAnalysisJob, session: AgentSession): void {
  if ((job.session_id && job.session_id !== session.id) ||
      session.metadata.workflow !== "ligou_onboarding_analysis_v1" ||
      session.metadata.job_id !== job.job_id || session.metadata.tenant_id !== job.tenant_id ||
      session.metadata.input_version !== job.input_version || session.agent.model !== MANAGED_ANALYSIS_MODEL ||
      session.environment.type !== "none") throw new Error("managed_analysis_session_scope_mismatch");
}

export class ManagedDiscoveryWorkflow {
  constructor(private readonly options: {
    client: ManagedAnalysisClient;
    store: ManagedAnalysisStore;
    // The host supplies its existing spend authority. No new hard-coded ceiling.
    authorizeLaunch: (job: ManagedAnalysisJob) => Promise<void>;
  }) {}

  async launch(identity: AnalysisIdentity): Promise<ManagedAnalysisJob> {
    const previous = await this.options.store.read(identity);
    if (previous.state !== "prepared") return this.reconcile(identity);
    await this.options.authorizeLaunch(previous);
    const { claimed, job } = await this.options.store.claimLaunch(identity);
    if (!claimed) return this.reconcile(identity);
    // No automatic POST retries: a lost create response is an uncertain launch.
    // Reconcile the provider metadata instead of issuing another mission.
    const session = await this.options.client.beta.agents.sessions.create(managedAnalysisRequest(job), { maxRetries: 0 });
    assertSession(job, session);
    await this.options.store.bind(identity, session.id);
    return this.reconcile(identity);
  }

  async reconcile(identity: AnalysisIdentity): Promise<ManagedAnalysisJob> {
    let job = await this.options.store.read(identity);
    if (job.state === "prepared" || (job.state === "cancelled" && !job.session_id)) return job;
    const sessions = this.options.client.beta.agents.sessions;
    if (!job.session_id) {
      // Pagination is the SDK's; this is recovery of one unknown launch only.
      const matches: AgentSession[] = [];
      for await (const candidate of sessions.list({ order: "desc", limit: 100 })) {
        if (candidate.created_at < Math.floor(Date.parse(job.created_at) / 1000) - 1) break;
        if (candidate.metadata.job_id === job.job_id && candidate.metadata.tenant_id === job.tenant_id && candidate.metadata.input_version === job.input_version) {
          assertSession(job, candidate); matches.push(candidate);
        }
      }
      if (matches.length > 1) throw new Error("managed_analysis_multiple_provider_sessions");
      if (matches.length === 0) return job;
      await this.options.store.bind(identity, matches[0]!.id);
      job = await this.options.store.read(identity);
    }
    const session = await sessions.retrieve(job.session_id!);
    assertSession(job, session);
    const turns: Turn[] = [];
    for await (const turn of sessions.turns.list(session.id, { order: "asc", limit: 100 })) {
      if (turn.session_id !== session.id) throw new Error("managed_analysis_turn_scope_mismatch");
      if (turn.subagent_id === null) turns.push(turn);
    }
    if (turns.length > 1 || (job.turn_id && turns[0]?.id !== job.turn_id)) throw new Error("managed_analysis_unexpected_turn");
    const turn = turns[0];
    const observation: AnalysisObservation = {
      session_id: session.id, turn_id: turn?.id ?? null,
      state: job.state === "cancel_requested" ? "cancel_requested" : "running",
      provider_status: turn?.status ?? session.status,
      usage: turn?.usage ?? session.usage,
    };
    if (turn?.status === "cancelled" || turn?.status === "failed" || session.status === "failed") {
      observation.state = turn?.status === "cancelled" ? "cancelled" : "failed";
      observation.error_code = turn?.error?.code ?? (session.error ? "provider_session_failed" : undefined);
      return this.options.store.observe(identity, observation);
    }
    if (turn?.status !== "completed") return this.options.store.observe(identity, observation);
    if (job.state === "cancel_requested" || job.state === "cancelled") {
      // Cancel raced completion; preserve the true provider outcome, discard its candidate.
      observation.state = "cancelled";
      return this.options.store.observe(identity, observation);
    }
    const finals = [];
    for await (const item of sessions.items.list(session.id, { order: "asc", limit: 100 })) {
      if (item.type === "message" && item.role === "assistant" && item.turn_id === turn.id && item.status === "completed" && item.phase === "final_answer") finals.push(item);
    }
    if (finals.length !== 1) return this.options.store.observe(identity, { ...observation, state: "failed", error_code: "final_output_missing_or_ambiguous" });
    const item = finals[0]!;
    const output = item.content.filter(part => part.type === "output_text").map(part => part.text).join("");
    if (!item.id) return this.options.store.observe(identity, { ...observation, state: "failed", error_code: "output_item_id_missing" });
    let result: WorkerResult;
    try {
      const mapped = parseAndMapDirectModelExtraction(JSON.parse(output), buildDirectModelEvidenceInput(job.source_snapshots));
      result = parseWorkerResult({ schema_version: "company_discovery.result.v2", source_snapshots: job.source_snapshots, ...mapped });
    } catch {
      return this.options.store.observe(identity, { ...observation, state: "failed", error_code: "output_validation_failed" });
    }
    return this.options.store.observe(identity, {
      ...observation, state: "completed", output_item_id: item.id,
      output_sha256: createHash("sha256").update(output).digest("hex"),
    }, result);
  }

  async cancel(identity: AnalysisIdentity): Promise<ManagedAnalysisJob> {
    const job = await this.options.store.requestCancel(identity);
    if (job.state !== "cancel_requested") return job;
    const bound = job.session_id ? job : await this.reconcile(identity);
    if (bound.session_id && bound.state === "cancel_requested") {
      await this.options.client.beta.agents.sessions.events.create(bound.session_id, { events: [{ type: "agent.session.input.cancel" }] });
    }
    return this.reconcile(identity);
  }

  async webhook(payload: string, headers: Headers): Promise<ManagedAnalysisJob | null> {
    await this.options.client.webhooks.verifySignature(payload, headers);
    const event = JSON.parse(payload);
    if (!["agent.session.created", "agent.session.in_progress", "agent.session.action_required", "agent.session.idle", "agent.session.failed"].includes(event.type)) return null;
    if (typeof event.id !== "string" || typeof event.data?.id !== "string") throw new Error("managed_analysis_webhook_invalid");
    let job = await this.options.store.findBySession(event.data.id);
    if (!job) {
      // A created webhook can arrive before the create response is bound locally.
      const session = await this.options.client.beta.agents.sessions.retrieve(event.data.id);
      if (session.metadata.workflow !== "ligou_onboarding_analysis_v1") return null;
      if (!session.metadata.job_id || !session.metadata.tenant_id) return null;
      job = await this.options.store.read({ jobId: session.metadata.job_id, tenantId: session.metadata.tenant_id });
      assertSession(job, session);
      if (job.state !== "launching" && job.state !== "cancel_requested") return null;
      await this.options.store.bind({ jobId: job.job_id, tenantId: job.tenant_id }, session.id);
    }
    // Read canonical state; repeated/out-of-order notifications never launch work.
    // The transactional store deduplicates the result by attempt and input version.
    return this.reconcile({ jobId: job.job_id, tenantId: job.tenant_id });
  }
}
