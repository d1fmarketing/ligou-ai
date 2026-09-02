import { describe, expect, test } from "bun:test";
import type {
  ModelAccessCapability,
  RegisteredSubscriptionLease,
  SubscriptionGateway,
  SubscriptionLeaseCapability,
  SubscriptionPolicy,
  SubscriptionRevocationReadback,
  SubscriptionRecoveryCapability,
  SubscriptionUsage,
  WorkerJob,
  WorkerResult,
} from "../src/contracts";
import {
  DirectModelDiscoveryAdapter,
  type DirectModelClock,
} from "../src/adapters/direct-model";

const sourceSnapshot = {
  url: "https://example.com/about",
  retrieved_at: "2026-09-01T10:00:00.000Z",
  http_status: 200,
  mime_type: "text/html" as const,
  byte_length: 164,
  content_hash: "c".repeat(64),
  excerpt: "Example Plumbing. Drain cleaning costs $149 and takes 90 minutes.",
  crawl_order: 0,
  crawl_depth: 0,
};

const job: WorkerJob = {
  job_type: "company_discovery.v1",
  job_id: "11111111-1111-4111-8111-111111111111",
  attempt_id: "22222222-2222-4222-8222-222222222222",
  attempt_number: 1,
  fence_generation: 7,
  normalized_origin: "https://example.com/",
  deadline_at: "2026-09-01T10:10:00.000Z",
  budget: {
    max_pages: 25,
    max_depth: 2,
    max_page_bytes: 1_048_576,
    max_job_bytes: 10_485_760,
    deadline_seconds: 600,
  },
  source_snapshots: [sourceSnapshot],
};

const candidate = {
  candidate_facts: [{
    claim_class: "descriptive",
    claim_type: "business_name",
    normalized_value: "Example Plumbing",
    evidence_refs: [0],
    confidence: "high",
    contradiction_status: "none",
    contradictions: [],
    missing_fields: [],
    ambiguous_fields: [],
    uncertainty: [],
    claim_schema_version: "company_discovery.claim.v2",
  }],
  missing_questions: ["Qual é o preço mínimo privado autorizado?"],
  contradictions: [],
  uncertainty: [],
};

const stage0bCandidate = {
  candidate_facts: [{
    claim_class: "operational",
    claim_type: "service_territory",
    normalized_value: {
      service_type: null,
      included_areas: [{
        kind: "city",
        name: "Novato",
        region_state: "CA",
        country_code: "US",
      }],
      excluded_areas: [],
      radius: null,
    },
    evidence_refs: [0],
    confidence: "high",
    contradiction_status: "none",
    contradictions: [],
    missing_fields: [],
    ambiguous_fields: [],
    uncertainty: [],
    claim_schema_version: "company_discovery.claim.v2",
  }],
  missing_questions: ["Qual é a política para feriados?"],
  contradictions: [],
  uncertainty: [],
};

function subscriptionResponse(
  output: unknown,
  terminalType: "response.completed" | "response.done" = "response.completed",
): Response {
  const response = {
    status: "completed",
    error: null,
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(output) }],
    }],
  };
  return new Response(
    `event: ${terminalType}\ndata: ${JSON.stringify({
      type: terminalType,
      response,
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function duplicateTerminalResponse(output: unknown): Response {
  const response = {
    status: "completed",
    error: null,
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(output) }],
    }],
  };
  const event = JSON.stringify({ type: "response.completed", response });
  return new Response(`data: ${event}\n\ndata: ${event}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function streamedSubscriptionResponse(output: unknown, outputIndex = 0): Response {
  const text = JSON.stringify(output);
  return new Response([
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      output_index: outputIndex,
      content_index: 0,
      item_id: "msg_streamed",
      delta: text,
    })}`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { status: "completed", error: null, output: [] },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const policy: SubscriptionPolicy = Object.freeze({
  model: "gpt-5.6-sol",
  deadline_at: job.deadline_at,
  max_requests: 4,
  max_input_bytes: 400_000,
  max_output_bytes: 8_388_608,
  max_response_bytes: 4_194_304,
  concurrency: 1,
  cache_retention: "none",
});

const usage: SubscriptionUsage = Object.freeze({
  schema_version: "ligou.subscription_usage.v1",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  billing_basis: "chatgpt_subscription",
  marginal_api_charge_usd: 0,
  request_count: 1,
  active_requests: 0,
  input_bytes: 1_000,
  output_bytes: 2_000,
  input_tokens: 100,
  cached_input_tokens: 0,
  output_tokens: 50,
  total_tokens: 150,
  usage_complete: true,
  quota_state: "available",
  retry_after_seconds: null,
  cooldown_until: null,
  revoked: false,
});

const capability = Object.freeze(Object.create(null)) as ModelAccessCapability;

class FakeSubscriptionGateway implements SubscriptionGateway {
  readonly #accepted = new WeakSet<object>();
  readonly #leases = new WeakSet<object>();
  readonly requests: Request[] = [];
  readonly registrations: ModelAccessCapability[] = [];
  readonly revocations: SubscriptionLeaseCapability[] = [];
  helperCalls = 0;
  response: Response | (() => Promise<Response>) = subscriptionResponse(candidate);
  usageValue: SubscriptionUsage = usage;
  revokeError?: Error;

  constructor(accepted: readonly ModelAccessCapability[] = [capability]) {
    accepted.forEach((item) => this.#accepted.add(item));
  }

  async register(modelAccess: ModelAccessCapability): Promise<RegisteredSubscriptionLease> {
    this.registrations.push(modelAccess);
    if (!this.#accepted.has(modelAccess)) throw new Error("store-issued model access required");
    this.helperCalls += 1;
    const lease = Object.freeze(Object.create(null)) as SubscriptionLeaseCapability;
    this.#leases.add(lease);
    return Object.freeze({
      lease,
      attempt_marker: "marker." + "a".repeat(43),
      subscription_socket_path:
        `/run/ligou-discovery/${"a".repeat(48)}/subscription.sock`,
      session_id: "session_opaque_direct_model",
      policy,
    });
  }

  async forward(
    lease: SubscriptionLeaseCapability,
    request: Request,
    _signal?: AbortSignal,
  ): Promise<Response> {
    if (!this.#leases.has(lease)) throw new Error("subscription lease invalid");
    this.requests.push(request);
    return typeof this.response === "function" ? this.response() : this.response.clone();
  }

  usage(_lease: SubscriptionLeaseCapability): Readonly<SubscriptionUsage> {
    return this.usageValue;
  }

  async revoke(lease: SubscriptionLeaseCapability): Promise<SubscriptionRevocationReadback> {
    this.revocations.push(lease);
    if (this.revokeError !== undefined) throw this.revokeError;
    return Object.freeze({
      generation: 1,
      subscription_lease_revoked: true,
      subscription_requests_drained: true,
      subscription_listener_closed: true,
      subscription_socket_absent: true,
    });
  }

  async recover(
    _authority: SubscriptionRecoveryCapability,
  ): Promise<SubscriptionRevocationReadback> {
    return Object.freeze({
      generation: 1,
      subscription_lease_revoked: true,
      subscription_requests_drained: true,
      subscription_listener_closed: true,
      subscription_socket_absent: true,
    });
  }
}

function controlledClock(now = Date.parse("2026-09-01T10:00:00.000Z")) {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const clock: DirectModelClock = {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id as number); },
  };
  return {
    clock,
    delays: () => [...timers.values()].map((timer) => timer.delay),
    fireNext() {
      const entry = timers.entries().next().value as [number, { callback: () => void }] | undefined;
      if (entry === undefined) throw new Error("no timer");
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

describe("DirectModelDiscoveryAdapter subscription boundary", () => {
  test("requests and returns the Stage 0B v2 contract through one subscription call", async () => {
    const gateway = new FakeSubscriptionGateway();
    gateway.response = subscriptionResponse(stage0bCandidate);
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: controlledClock().clock,
    });

    const handle = await adapter.submit(job, capability);
    const result = await adapter.result(handle);
    const body = await gateway.requests[0]!.clone().json() as any;
    const evidenceEnvelope = JSON.parse(body.input[0].content[0].text);
    const serializedContract = JSON.stringify(evidenceEnvelope.output_contract);

    expect(result.schema_version).toBe("company_discovery.result.v2");
    expect(result.candidate_facts[0]!.claim_type).toBe("service_territory");
    expect(evidenceEnvelope.schema_version).toBe("company_discovery.evidence.v2");
    expect(serializedContract).toContain("business_hours");
    expect(serializedContract).toContain("guarantee");
    expect(serializedContract).toContain("booking_restriction");
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.usageValue.billing_basis).toBe("chatgpt_subscription");
    expect(gateway.usageValue.marginal_api_charge_usd).toBe(0);
  });

  test("uses only the injected gpt-5.6-sol subscription gateway", async () => {
    const gateway = new FakeSubscriptionGateway();
    const timer = controlledClock();
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: timer.clock,
    });

    const handle = await adapter.submit(job, capability);
    const result = await adapter.result(handle);

    expect(gateway.registrations).toEqual([capability]);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.url).not.toContain("api.openai.com");
    expect(gateway.requests[0]!.url).toBe(
      "http://ligou-subscription.local/codex/responses",
    );
    const body = await gateway.requests[0]!.clone().json() as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
    });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("text");
    expect(JSON.stringify(body)).toContain("candidate_facts");
    expect(JSON.stringify(body)).not.toContain("tenant_id");
    expect(JSON.stringify(body)).not.toContain(job.job_id);
    expect(result).toEqual({
      schema_version: "company_discovery.result.v2",
      source_snapshots: [sourceSnapshot],
      ...candidate,
    } as WorkerResult);
    expect(adapter.subscriptionUsage(handle)).toEqual(gateway.usageValue);
    expect(timer.delays()).toEqual([]);
    expect(await adapter.retire(handle)).toMatchObject({
      subscription_lease_revoked: true,
      subscription_requests_drained: true,
      subscription_listener_closed: true,
      subscription_socket_absent: true,
    });
    expect(gateway.revocations).toHaveLength(1);
    await expect(adapter.status(handle)).rejects.toThrow("retired");
    await expect(adapter.result(handle)).rejects.toThrow("retired");
    expect(() => adapter.subscriptionUsage(handle)).toThrow("retired");
    await expect(adapter.submit(job, capability)).rejects.toThrow("retired");
    expect(gateway.registrations).toHaveLength(1);
  });

  test("accepts exactly one response.done terminal event", async () => {
    const gateway = new FakeSubscriptionGateway();
    gateway.response = subscriptionResponse(candidate, "response.done");
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: controlledClock().clock,
    });
    const handle = await adapter.submit({ ...job, attempt_id: crypto.randomUUID() }, capability);
    expect(await adapter.result(handle)).toMatchObject({
      schema_version: "company_discovery.result.v2",
    });
  });

  test("accepts one bounded streamed output_text when the terminal omits expanded output", async () => {
    const gateway = new FakeSubscriptionGateway();
    gateway.response = streamedSubscriptionResponse(candidate);
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: controlledClock().clock,
    });

    const handle = await adapter.submit(job, capability);
    expect(await adapter.result(handle)).toEqual({
      schema_version: "company_discovery.result.v2",
      source_snapshots: job.source_snapshots,
      ...candidate,
    } as WorkerResult);
    await adapter.retire(handle);
  });

  test("accepts one streamed output_text after preceding reasoning items", async () => {
    const gateway = new FakeSubscriptionGateway();
    gateway.response = streamedSubscriptionResponse(candidate, 2);
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: controlledClock().clock,
    });

    const handle = await adapter.submit({ ...job, attempt_id: crypto.randomUUID() }, capability);
    expect(await adapter.result(handle)).toEqual({
      schema_version: "company_discovery.result.v2",
      source_snapshots: job.source_snapshots,
      ...candidate,
    } as WorkerResult);
    await adapter.retire(handle);
  });

  test("tombstones and releases adapter references even when revoke is ambiguous", async () => {
    const gateway = new FakeSubscriptionGateway();
    gateway.response = () => new Promise<Response>(() => {});
    gateway.revokeError = new Error("revoke receipt unavailable");
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: controlledClock().clock,
    });
    const candidateJob = { ...job, attempt_id: crypto.randomUUID() };
    const handle = await adapter.submit(candidateJob, capability);

    await expect(adapter.retire(handle)).rejects.toThrow("revoke receipt unavailable");
    await expect(adapter.status(handle)).rejects.toThrow("retired");
    await expect(adapter.result(handle)).rejects.toThrow("retired");
    expect(() => adapter.subscriptionUsage(handle)).toThrow("retired");
    await expect(adapter.submit(candidateJob, capability)).rejects.toThrow("retired");
    expect(gateway.registrations).toHaveLength(1);
    expect(gateway.revocations).toHaveLength(1);
  });

  test("checks deadline and duplicates before register and revokes invalid registration", async () => {
    const expiredGateway = new FakeSubscriptionGateway();
    const expired = new DirectModelDiscoveryAdapter({
      subscription_gateway: expiredGateway,
      clock: controlledClock(Date.parse(job.deadline_at)).clock,
    });
    await expect(expired.submit(job, capability)).rejects.toThrow("deadline");
    expect(expiredGateway.registrations).toEqual([]);

    const gateway = new FakeSubscriptionGateway();
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: controlledClock().clock,
    });
    const handle = await adapter.submit(job, capability);
    await adapter.result(handle);
    await expect(adapter.submit(job, capability)).rejects.toThrow("already submitted");
    expect(gateway.registrations).toHaveLength(1);

    class InvalidRegistrationGateway extends FakeSubscriptionGateway {
      override async register(access: ModelAccessCapability): Promise<RegisteredSubscriptionLease> {
        const registered = await super.register(access);
        return Object.freeze({
          ...registered,
          policy: Object.freeze({ ...registered.policy, model: "gpt-5.4-mini" as never }),
        });
      }
    }
    const invalidGateway = new InvalidRegistrationGateway();
    const invalid = new DirectModelDiscoveryAdapter({
      subscription_gateway: invalidGateway,
      clock: controlledClock().clock,
    });
    await expect(invalid.submit({ ...job, attempt_id: crypto.randomUUID() }, capability))
      .rejects.toThrow("registration invalid");
    expect(invalidGateway.revocations).toHaveLength(1);
  });

  test("rejects incomplete or multi-request subscription usage", async () => {
    for (const mutation of [
      { usage_complete: false },
      { request_count: 2 },
      { active_requests: 1 },
      { provider: "openai" },
    ]) {
      const gateway = new FakeSubscriptionGateway();
      gateway.usageValue = Object.freeze({ ...usage, ...mutation }) as SubscriptionUsage;
      const adapter = new DirectModelDiscoveryAdapter({
        subscription_gateway: gateway,
        clock: controlledClock().clock,
      });
      const candidateJob = { ...job, attempt_id: crypto.randomUUID() };
      const handle = await adapter.submit(candidateJob, capability);
      await expect(adapter.result(handle)).rejects.toThrow("usage incomplete");
      expect(gateway.revocations).toHaveLength(1);
    }
  });

  test("rejects forged capability before helper or forwarding", async () => {
    const gateway = new FakeSubscriptionGateway();
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: controlledClock().clock,
    });
    const forged = Object.freeze(Object.create(null)) as ModelAccessCapability;

    await expect(adapter.submit(job, forged)).rejects.toThrow("store-issued");
    expect(gateway.helperCalls).toBe(0);
    expect(gateway.requests).toEqual([]);
  });

  test("ignores poisoned API-key environment and never calls global fetch", async () => {
    const priorKey = process.env.OPENAI_API_KEY;
    const priorFetch = globalThis.fetch;
    let globalFetchCalls = 0;
    process.env.OPENAI_API_KEY = "forbidden-openai-api-key-sentinel";
    globalThis.fetch = (async () => {
      globalFetchCalls += 1;
      throw new Error("global fetch forbidden");
    }) as unknown as typeof fetch;
    try {
      const gateway = new FakeSubscriptionGateway();
      const adapter = new DirectModelDiscoveryAdapter({
        subscription_gateway: gateway,
        clock: controlledClock().clock,
      });
      const handle = await adapter.submit(job, capability);
      expect(await adapter.result(handle)).toMatchObject({
        schema_version: "company_discovery.result.v2",
      });
      expect(globalFetchCalls).toBe(0);
      expect(gateway.requests[0]!.url).not.toContain("api.openai.com");
    } finally {
      globalThis.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
    }
  });

  test("supports exactly company_discovery.v1", () => {
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: new FakeSubscriptionGateway(),
    });
    expect(adapter.supports("company_discovery.v1")).toBe(true);
    expect(adapter.supports("other" as "company_discovery.v1")).toBe(false);
  });

  test("surfaces subscription HTTP and malformed response failures", async () => {
    for (const response of [
      new Response("subscription unavailable", { status: 503 }),
      new Response("not json", { status: 200 }),
      new Response(`data: ${JSON.stringify({ type: "response.failed" })}\n\n`, { status: 200 }),
      duplicateTerminalResponse(candidate),
    ]) {
      const gateway = new FakeSubscriptionGateway();
      gateway.response = response;
      const adapter = new DirectModelDiscoveryAdapter({
        subscription_gateway: gateway,
        clock: controlledClock().clock,
      });
      const handle = await adapter.submit(job, capability);
      await expect(adapter.result(handle)).rejects.toThrow();
      expect(await adapter.status(handle)).toEqual({ state: "failed" });
    }
  });

  test("rejects model attempts to author evidence or trusted identity", async () => {
    for (const forged of [
      { ...candidate, source_snapshots: [sourceSnapshot] },
      { ...candidate, tenant_id: "attacker" },
      { ...candidate, approved: true },
    ]) {
      const gateway = new FakeSubscriptionGateway();
      gateway.response = subscriptionResponse(forged);
      const adapter = new DirectModelDiscoveryAdapter({
        subscription_gateway: gateway,
        clock: controlledClock().clock,
      });
      const handle = await adapter.submit(job, capability);
      await expect(adapter.result(handle)).rejects.toThrow();
    }
  });

  test("cancellation is terminal even when subscription forwarding ignores abort", async () => {
    let resolve!: (response: Response) => void;
    const gateway = new FakeSubscriptionGateway();
    gateway.response = () => new Promise<Response>((done) => { resolve = done; });
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: controlledClock().clock,
    });
    const handle = await adapter.submit(job, capability);
    await adapter.cancel(handle);

    expect(await adapter.status(handle)).toEqual({ state: "cancelled" });
    await expect(adapter.result(handle)).rejects.toThrow("cancelled");
    resolve(subscriptionResponse(candidate));
    await new Promise((done) => setTimeout(done, 0));
    expect(await adapter.status(handle)).toEqual({ state: "cancelled" });
  });

  test("deadline terminates a never-resolving subscription request", async () => {
    const timer = controlledClock();
    const gateway = new FakeSubscriptionGateway();
    gateway.response = () => new Promise<Response>(() => undefined);
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: timer.clock,
    });
    const handle = await adapter.submit(job, capability);
    expect(timer.delays()).toEqual([600_000]);
    timer.fireNext();
    await expect(adapter.result(handle)).rejects.toThrow("deadline");
    expect(await adapter.status(handle)).toEqual({ state: "failed" });
  });
});
