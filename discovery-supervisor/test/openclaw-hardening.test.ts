import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import {
  buildCellLifecyclePlan,
  buildOpenClawConfig,
  BRIDGE_SUBSCRIPTION_SOCKET_PATH,
  CellRuntime,
  type CommandSpec,
} from "../src/openclaw/cell-runtime";
import {
  OPENCLAW_CELL_IMAGE,
  allocateRuntimeIdentity,
  directModelRuntimeIdentityBinding,
  runtimeIdentityBinding,
  type RuntimeImageEvidenceSet,
} from "../src/openclaw/runtime-identity";
import {
  FixedModelProxy,
} from "../src/openclaw/model-proxy";
import {
  AttemptMcpBridge,
  DISCOVERY_MCP_TOOL_PARAMETERS,
} from "../src/openclaw/mcp-bridge";
import { TrustedBridgeServer } from "../src/openclaw/trusted-bridge";
import { createDiscoveryAttemptContext } from "../src/fetch/discovery-fetch-gateway";
import { HermesCodexGrantResolver } from "../src/openclaw/hermes-codex-grant";
import { ArgvCommandRunner } from "../src/runtime/command-runner";
import {
  EphemeralOpenClawAttemptFactory,
  OpenClawDiscoveryAdapter,
} from "../src/adapters/openclaw";
import { DirectModelDiscoveryAdapter } from "../src/adapters/direct-model";
import {
  CentralSubscriptionGateway,
  UnixSubscriptionListenerManager,
  type SubscriptionRuntimeFileSystem,
} from "../src/openclaw/subscription-gateway";
import type {
  ModelAccessCapability,
  ModelAccessContext,
  SubscriptionLeaseCapability,
  SubscriptionRequestSettlement,
  SubscriptionRequestReservationCapability,
  SubscriptionRecoveryCapability,
  SubscriptionUsage,
  WorkerJob,
  WorkerResult,
} from "../src/contracts";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

const images: RuntimeImageEvidenceSet = {
  cell_image: {
    reference: OPENCLAW_CELL_IMAGE,
    index_digest: digest("e").replace(
      digest("e"),
      "sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4",
    ),
    platform: "linux/arm64",
    selected_manifest_digest: digest("c"),
    image_id: digest("d"),
    config_digest: digest("d"),
  },
  bridge_image: {
    reference: `ligou-discovery-bridge@${digest("b")}`,
    index_digest: digest("b"),
    platform: "linux/arm64",
    selected_manifest_digest: digest("6"),
    image_id: digest("f"),
    config_digest: digest("f"),
  },
};

const hermesRuntimeEnv = Object.freeze([
  "HERMES_AUTH_HOME=/opt/model-auth",
  "API_SERVER_ENABLED=true",
  "API_SERVER_HOST=0.0.0.0",
  "API_SERVER_KEY=synthetic-local-only",
  "PATH=/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "PYTHONUNBUFFERED=1",
  "PYTHONDONTWRITEBYTECODE=1",
  "PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright",
  "npm_config_install_links=false",
  "HERMES_WEB_DIST=/opt/hermes/hermes_cli/web_dist",
  "HERMES_TUI_DIR=/opt/hermes/ui-tui",
  "HERMES_HOME=/opt/data",
  "HERMES_WRITE_SAFE_ROOT=/opt/data",
  "HERMES_DISABLE_LAZY_INSTALLS=1",
  "HERMES_LAZY_INSTALL_TARGET=/opt/data/lazy-packages",
]);

async function identity() {
  return allocateRuntimeIdentity({
    image_evidence: images,
    reserveLoopbackPort: async () => 29_401,
    randomBytes: () => Buffer.alloc(24, 0x61),
  });
}

describe("outer-cell security boundary", () => {
  test("updates vulnerable Alpine runtime packages without changing the pinned Bun base", () => {
    const dockerfile = readFileSync(new URL("../openclaw/Dockerfile.bridge", import.meta.url), "utf8");
    const pinnedBase = "oven/bun:1.2.13-alpine@sha256:3476c857e7c05a7950b3a8a684ffbc82f5cbeffe1b523ea1a92bdefc4539dc57";
    expect(dockerfile.match(new RegExp(`FROM ${pinnedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g")))
      .toHaveLength(2);
    expect(dockerfile.slice(dockerfile.lastIndexOf("FROM "))).toContain("RUN apk upgrade --no-cache");
  });

  test("disables OpenClaw nested Docker sandbox while preserving deny-by-default tools", async () => {
    const runtime = await identity();
    const config = buildOpenClawConfig({
      identity: runtime,
      proxy_marker: "opaque-cell-marker",
      upstream_model: "gpt-5.6-sol",
    });

    expect(config.agents.defaults.sandbox).toEqual({
      mode: "off",
      workspaceAccess: "none",
      browser: { enabled: false, allowHostControl: false },
    });
    expect(config.tools.allow).toEqual([
      "bundle-mcp",
      "discovery__fetch_discovery_page",
      "discovery__submit_discovery_result",
    ]);
    expect(config.tools.profile).toBe("coding");
    expect(config.tools.deny).toEqual(expect.arrayContaining([
      "exec", "process", "browser", "read", "write", "web_fetch", "gateway",
    ]));
    expect(config.models.providers.stage0_bridge).toMatchObject({
      baseUrl: `http://bridge:${runtime.bridge_http_port}/codex`,
      api: "openai-chatgpt-responses",
    });
    expect(config.agents.defaults.models[`stage0_bridge/gpt-5.6-sol`].params).toEqual({
      transport: "sse",
      cacheRetention: "none",
      maxRetries: 0,
    });
  });

  test("binds exact multi-platform image evidence and launches selected child manifests", async () => {
    const runtime = await identity();
    expect(runtimeIdentityBinding(runtime)).toMatchObject({ runtime_kind: "openclaw_cell", ...images });
    expect(directModelRuntimeIdentityBinding(
      `/run/ligou-discovery/${"f".repeat(48)}/subscription.sock`,
    )).toEqual({
      runtime_kind: "direct_model_subscription",
      subscription_socket_path: `/run/ligou-discovery/${"f".repeat(48)}/subscription.sock`,
    });
    const config = buildOpenClawConfig({
      identity: runtime,
      proxy_marker: "opaque-cell-marker",
      upstream_model: "gpt-5.6-sol",
    });
    const plan = buildCellLifecyclePlan({
      identity: runtime,
      config,
      gateway_token: "synthetic-gateway-token",
      bridge_secret: {
        upstream_model: "gpt-5.6-sol",
        proxy_marker: "opaque-cell-marker",
        subscription_socket_path: BRIDGE_SUBSCRIPTION_SOCKET_PATH,
        normalized_origin: "https://example.com/",
        deadline_at: "2099-09-01T10:10:00.000Z",
        budget: {
          max_pages: 1,
          max_depth: 0,
          max_page_bytes: 1_024,
          max_job_bytes: 1_024,
          deadline_seconds: 600,
        },
        source_snapshots: [],
      },
    });

    const cell = plan.find((entry) => entry.label === "start-cell")!;
    const bridge = plan.find((entry) => entry.label === "start-bridge")!;
    const cellChild = `ghcr.io/openclaw/openclaw@${images.cell_image.selected_manifest_digest}`;
    const bridgeChild = `ligou-discovery-bridge@${images.bridge_image.selected_manifest_digest}`;
    expect(cell.argv).toEqual(expect.arrayContaining([
      "--platform", "linux/arm64", "--pull=never", cellChild,
    ]));
    expect(bridge.argv).toEqual(expect.arrayContaining([
      "--platform", "linux/arm64", "--pull=never", bridgeChild,
    ]));
    for (const launch of [cell, bridge]) {
      expect(launch.argv).toEqual(expect.arrayContaining([
        "--log-driver=local", "--log-opt=max-size=10m", "--log-opt=max-file=2",
      ]));
      expect(launch.argv.some((value) => value.includes("docker.sock"))).toBe(false);
    }
  });

  test("uses bounded tmpfs-backed named volumes and only the Ligou image for bridge-secret initialization", async () => {
    const runtime = await identity();
    const config = buildOpenClawConfig({
      identity: runtime,
      proxy_marker: "opaque-cell-marker",
      upstream_model: "gpt-5.6-sol",
    });
    const plan = buildCellLifecyclePlan({
      identity: runtime,
      config,
      gateway_token: "synthetic-gateway-token",
      bridge_secret: {
        upstream_model: "gpt-5.6-sol",
        proxy_marker: "opaque-cell-marker",
        subscription_socket_path: BRIDGE_SUBSCRIPTION_SOCKET_PATH,
        normalized_origin: "https://example.com/",
        deadline_at: "2099-09-01T10:10:00.000Z",
        budget: {
          max_pages: 1,
          max_depth: 0,
          max_page_bytes: 1_024,
          max_job_bytes: 1_024,
          deadline_seconds: 600,
        },
        source_snapshots: [],
      },
    });

    for (const name of ["config", "state", "workspace", "output", "gateway-secret", "bridge-secret"]) {
      const create = plan.find((entry) => entry.label === `create-${name}-volume`)!;
      expect(create.argv).toEqual(expect.arrayContaining([
        "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs",
      ]));
      expect(create.argv.join(" ")).toMatch(/o=size=[0-9]+,uid=1000,gid=1000,mode=0700/);
    }
    const keeperName = `ligou-oc-volume-keeper-${runtime.opaque_id.slice(0, 16)}`;
    const keeper = plan.find((entry) => entry.label === "start-volume-keeper")!;
    expect(keeper.argv).toEqual(expect.arrayContaining([
      "--name", keeperName,
      "--network", "none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user", "1000:1000",
    ]));
    for (const [name, volume] of Object.entries(runtime.volume_names)) {
      expect(keeper.argv).toContain(`type=volume,src=${volume},dst=/volumes/${name}`);
    }
    for (const [label, target] of [
      ["prepare-state-volume", "/volumes/state"],
      ["prepare-workspace-volume", "/volumes/workspace"],
      ["prepare-output-volume", "/volumes/output"],
    ] as const) {
      const prepare = plan.find((entry) => entry.label === label)!;
      expect(prepare.argv).toEqual(expect.arrayContaining([
        "docker", "exec", "--user", "1000:1000", keeperName,
      ]));
      expect(prepare.argv).not.toContain("run");
      const shell = prepare.argv[prepare.argv.indexOf("-c") + 1]!;
      expect(shell).toContain('stat -c %u:%g:%a "$1"');
      expect(shell).not.toMatch(/chown|chmod/);
      expect(prepare.argv.at(-1)).toBe(target);
    }
    const writeSecret = plan.find((entry) => entry.label === "write-bridge-secret")!;
    const writeConfig = plan.find((entry) => entry.label === "write-openclaw-config")!;
    const writeGateway = plan.find((entry) => entry.label === "write-gateway-secret")!;
    for (const writer of [writeConfig, writeGateway, writeSecret]) {
      expect(writer.argv).toEqual(expect.arrayContaining([
        "docker", "exec", "-i", "--user", "1000:1000", keeperName,
      ]));
      expect(writer.argv).not.toContain("run");
      const shell = writer.argv[writer.argv.indexOf("-c") + 1]!;
      expect(shell).toContain('stat -c %u:%g:%a "$1"');
      expect(shell).toContain('stat -c %u:%g:%a "$target"');
      expect(shell).not.toContain("chown");
    }
    const startCellIndex = plan.findIndex((entry) => entry.label === "start-cell");
    const stopKeeperIndex = plan.findIndex((entry) => entry.label === "stop-volume-keeper");
    const removeKeeperIndex = plan.findIndex((entry) => entry.label === "remove-volume-keeper");
    expect(startCellIndex).toBeGreaterThan(plan.findIndex((entry) => entry.label === "start-volume-keeper"));
    expect(stopKeeperIndex).toBeGreaterThan(startCellIndex);
    expect(removeKeeperIndex).toBeGreaterThan(stopKeeperIndex);
    expect(writeConfig.sensitive_stdin).toBe(true);
    expect(keeper.argv).toContain(`ligou-discovery-bridge@${images.bridge_image.selected_manifest_digest}`);
    expect(keeper.argv).not.toContain(`ghcr.io/openclaw/openclaw@${images.cell_image.selected_manifest_digest}`);
    const cell = plan.find((entry) => entry.label === "start-cell")!;
    expect(cell.argv.join(" ")).not.toContain(runtime.volume_names.bridge_secret);

    let spawned = 0;
    const fakeSpawn = (() => {
      spawned += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdin: Writable;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdin.once("finish", () => queueMicrotask(() => child.emit("close", 0, null)));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const runner = new ArgvCommandRunner({ spawn_process: fakeSpawn });
    for (const label of [
      "write-openclaw-config",
      "write-gateway-secret",
      "write-bridge-secret",
    ]) {
      await expect(runner.run(plan.find((entry) => entry.label === label)!)).resolves.toMatchObject({
        exitCode: 0,
      });
    }
    expect(spawned).toBe(3);
  });

  test("fails startup when local image ID or platform differs from recorded evidence", async () => {
    const runtimeIdentity = await identity();
    const runtime = new CellRuntime({
      command_runner: {
        async run(command) {
          if (command.label === "verify-cell-image") {
            return {
              exitCode: 0,
              stdout: JSON.stringify([{
                Id: images.cell_image.image_id,
                Os: "linux",
                Architecture: "amd64",
              }]),
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      listener_closed: async () => true,
      identity_process_absent: async () => true,
    });
    const config = buildOpenClawConfig({
      identity: runtimeIdentity,
      proxy_marker: "opaque-cell-marker",
      upstream_model: "gpt-5.6-sol",
    });
    const plan = buildCellLifecyclePlan({
      identity: runtimeIdentity,
      config,
      gateway_token: "synthetic-gateway-token",
      bridge_secret: {
        upstream_model: "gpt-5.6-sol",
        proxy_marker: "opaque-cell-marker",
        subscription_socket_path: BRIDGE_SUBSCRIPTION_SOCKET_PATH,
        normalized_origin: "https://example.com/",
        deadline_at: "2099-09-01T10:10:00.000Z",
        budget: {
          max_pages: 1,
          max_depth: 0,
          max_page_bytes: 1_024,
          max_job_bytes: 1_024,
          deadline_seconds: 600,
        },
        source_snapshots: [],
      },
    });

    await expect(runtime.start(plan)).rejects.toThrow("image evidence");
  });
});

const codexTools = [{
  type: "function",
  name: "discovery__fetch_discovery_page",
  description: "Fetch one immutable discovery page.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", format: "uri", minLength: 9, maxLength: 2_048 },
    },
  },
  strict: true,
}, {
  type: "function",
  name: "discovery__submit_discovery_result",
  description: "Submit one candidate discovery result.",
  parameters: DISCOVERY_MCP_TOOL_PARAMETERS.submit_discovery_result,
  strict: true,
}] as const;

function jwt(accountId: string, expiresAt: number, signature = "synthetic-signature") {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    exp: expiresAt,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.${signature}`;
}

function markerJwt(now: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    exp: Math.floor(now / 1_000) + 3_600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "ligou-stage0-abcdefghijklmnopqrstuvwx",
    },
  })}.${"m".repeat(43)}`;
}

function syntheticGrant(deadline: string, accountId = "acct_synthetic_only") {
  const expiresAt = Math.floor(Date.parse(deadline) / 1_000) + 180;
  return {
    access_token: jwt(accountId, expiresAt),
    account_id: accountId,
    expires_at: expiresAt,
    source: "hermes-auth-store" as const,
  };
}

function codexRequest(marker: string, extras: Record<string, unknown> = {}) {
  return new Request("http://bridge:4310/codex/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${marker}`,
      "content-type": "application/json",
      "x-client-request-id": "cell-selected-id-must-be-replaced",
      "chatgpt-account-id": "cell-fake-account",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      instructions: "Use only the two discovery tools.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "discover" }] }],
      tools: codexTools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "cell-selected-cache-key",
      ...extras,
    }),
  });
}

function observedOpenClawRequest(marker: string, extras: Record<string, unknown> = {}) {
  return new Request("http://bridge:4310/codex/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${marker}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      instructions: "Use only the two discovery tools.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "discover" }] }],
      tools: codexTools,
      reasoning: { effort: "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 8_192,
      ...extras,
    }),
  });
}

function directCodexRequest(marker: string, extras: Record<string, unknown> = {}) {
  return new Request("http://bridge:4310/codex/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${marker}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      instructions: "Return only one JSON company discovery candidate object.",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "immutable discovery evidence" }],
      }],
      ...extras,
    }),
  });
}

function completedSse(usage = {
  input_tokens: 101,
  input_tokens_details: { cached_tokens: 11 },
  output_tokens: 23,
  total_tokens: 124,
}) {
  return [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test" } })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}`,
    "data: [DONE]",
    "",
  ].join("\n");
}

function subscriptionGovernorStubs(now: number) {
  const reservation = Object.freeze(Object.create(null)) as SubscriptionRequestReservationCapability;
  return {
    async reserveSubscriptionRequest(
      _capability: ModelAccessCapability,
      prospective: { input_bytes: number; output_bytes: number; lease_seconds: number },
    ) {
      return {
        reservation,
        request_number: 1,
        lease_until: new Date(now + prospective.lease_seconds * 1_000).toISOString(),
        quota_state: "available" as const,
        current_requests: 1,
        current_input_bytes: prospective.input_bytes,
        current_output_bytes: prospective.output_bytes,
        max_requests: 28 as const,
        max_input_bytes: 400_000 as const,
        max_output_bytes: 8_388_608 as const,
        owner_current_requests: 1,
        owner_current_input_bytes: prospective.input_bytes,
        owner_current_output_bytes: prospective.output_bytes,
        owner_max_requests: 140 as const,
        owner_max_input_bytes: 2_000_000 as const,
        owner_max_output_bytes: 40_000_000 as const,
        max_concurrency: 1 as const,
      };
    },
    async settleSubscriptionRequest(
      _reservation: SubscriptionRequestReservationCapability,
      settlement: SubscriptionRequestSettlement,
    ) {
      if (settlement.usage_complete &&
          (settlement.observed_input_tokens === null || settlement.observed_output_tokens === null)) {
        throw new Error("production settlement contract requires complete token evidence");
      }
      return {
        settled: true as const,
        quota_state: settlement.quota_state,
        cooldown_until: settlement.quota_state === "cooldown"
          ? new Date(now + 30_000).toISOString()
          : null,
        current_requests: 1,
        current_input_bytes: settlement.input_bytes,
        current_output_bytes: settlement.output_bytes,
        max_requests: 28 as const,
        max_input_bytes: 400_000 as const,
        max_output_bytes: 8_388_608 as const,
        owner_current_requests: 1,
        owner_current_input_bytes: settlement.input_bytes,
        owner_current_output_bytes: settlement.output_bytes,
        owner_max_requests: 140 as const,
        owner_max_input_bytes: 2_000_000 as const,
        owner_max_output_bytes: 40_000_000 as const,
        max_concurrency: 1 as const,
      };
    },
  };
}

const adapterSnapshot = {
  url: "https://example.com/",
  retrieved_at: "2099-09-01T10:00:00.000Z",
  http_status: 200,
  mime_type: "text/html" as const,
  byte_length: 16,
  content_hash: "a".repeat(64),
  excerpt: "Example Plumbing",
  crawl_order: 0,
  crawl_depth: 0,
};

const adapterJob: WorkerJob = {
  job_type: "company_discovery.v1",
  job_id: "11111111-1111-4111-8111-111111111111",
  attempt_id: "22222222-2222-4222-8222-222222222222",
  attempt_number: 1,
  fence_generation: 7,
  normalized_origin: "https://example.com/",
  deadline_at: "2099-09-01T10:10:00.000Z",
  budget: {
    max_pages: 25,
    max_depth: 2,
    max_page_bytes: 1_048_576,
    max_job_bytes: 10_485_760,
    deadline_seconds: 600,
  },
  source_snapshots: [adapterSnapshot],
};

const adapterResult: WorkerResult = {
  schema_version: "company_discovery.result.v1",
  source_snapshots: [adapterSnapshot],
  candidate_facts: [{
    claim_class: "descriptive",
    claim_type: "business_name",
    normalized_value: "Example Plumbing",
    evidence_refs: [0],
    contradictions: [],
    uncertainty: [],
  }],
  missing_questions: [],
  contradictions: [],
  uncertainty: [],
};

function subscriptionUsage(overrides: Partial<SubscriptionUsage> = {}): SubscriptionUsage {
  return {
    schema_version: "ligou.subscription_usage.v1",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    billing_basis: "chatgpt_subscription",
    marginal_api_charge_usd: 0,
    request_count: 1,
    active_requests: 0,
    input_bytes: 100,
    output_bytes: 200,
    input_tokens: 10,
    cached_input_tokens: 0,
    output_tokens: 20,
    total_tokens: 30,
    usage_complete: true,
    quota_state: "available",
    retry_after_seconds: null,
    cooldown_until: null,
    revoked: false,
    ...overrides,
  };
}

function centralContext(overrides: Partial<ModelAccessContext> = {}): ModelAccessContext {
  return {
    adapter_id: "openclaw",
    job_id: "11111111-1111-4111-8111-111111111111",
    attempt_id: "22222222-2222-4222-8222-222222222222",
    fence_generation: 7,
    runtime_slot_id: "33333333-3333-4333-8333-333333333333",
    tenant_id: "44444444-4444-4444-8444-444444444444",
    credential_owner_id: "55555555-5555-4555-8555-555555555555",
    credential_generation: 3,
    expected_account_hash: createHash("sha256").update("acct-central-owner").digest("hex"),
    deadline_at: "2099-09-01T10:10:00.000Z",
    source_snapshot_count: 1,
    subscription_socket_path: `/run/ligou-discovery/${"5".repeat(48)}/subscription.sock`,
    runtime_identity_hash: "4".repeat(64),
    provider: "openai-codex",
    auth_kind: "chatgpt_subscription_oauth",
    model: "gpt-5.6-sol",
    ...overrides,
  };
}

describe("trusted Codex subscription proxy", () => {
  test("replaces every cell-selected authority field and forwards only to the fixed Codex endpoint", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const deadline = "2099-09-01T10:10:00.000Z";
    const accountId = "acct_trusted_123";
    const accessToken = jwt(accountId, Math.floor(Date.parse(deadline) / 1_000) + 180);
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const proxy = new FixedModelProxy({
      proxy_marker: markerJwt(now),
      adapter_id: "openclaw",
      codex_access_grant: {
        access_token: accessToken,
        account_id: accountId,
        expires_at: Math.floor(Date.parse(deadline) / 1_000) + 180,
        source: "hermes-auth-store",
      },
      upstream_model: "gpt-5.6-sol",
      deadline_at: deadline,
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      create_request_id: () => "stage0_req_1234567890",
      fetch: async (input, init) => {
        calls.push({ input, init });
        return new Response(completedSse(), { status: 200 });
      },
    });

    const inboundRequest = observedOpenClawRequest(markerJwt(now));
    const inboundBytes = (await inboundRequest.clone().arrayBuffer()).byteLength;
    const response = await proxy.forward(inboundRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toContain("response.completed");
    expect(String(calls[0]!.input)).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe(accountId);
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("user-agent")).toBe("codex_cli_rs/0.0.0 (Ligou via Hermes)");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(headers.get("session_id")).toBe("stage0_session_abcdefghijklmnop");
    expect(headers.get("x-client-request-id")).toBe("stage0_req_1234567890");
    expect(calls[0]!.init?.redirect).toBe("error");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      parallel_tool_calls: false,
    });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("prompt_cache_key");
    const forwardedTools = body.tools as Array<Record<string, any>>;
    expect(forwardedTools[0]!.parameters.properties.url).toEqual({
      type: "string",
      minLength: 9,
      maxLength: 2_048,
    });
    expect(forwardedTools[0]!.parameters.properties.url).not.toHaveProperty("format");
    expect(forwardedTools[0]!.strict).toBe(true);
    expect(forwardedTools[1]!.strict).toBe(false);
    expect(proxy.usage()).toEqual({
      request_count: 1,
      upstream_request_count: 1,
      active_requests: 0,
      input_bytes: inboundBytes,
      output_bytes: Buffer.byteLength(completedSse()),
      input_tokens: 101,
      cached_input_tokens: 11,
      output_tokens: 23,
      total_tokens: 124,
      usage_complete: true,
      retired: false,
    });
  });

  test("rejects every unapproved top-level field before any subscription request", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const marker = markerJwt(now);
    const accountId = "acct_trusted_123";
    let calls = 0;
    const proxy = new FixedModelProxy({
      proxy_marker: marker,
      adapter_id: "openclaw",
      codex_access_grant: {
        access_token: jwt(accountId, Math.floor(now / 1_000) + 900),
        account_id: accountId,
        expires_at: Math.floor(now / 1_000) + 900,
        source: "hermes-auth-store",
      },
      upstream_model: "gpt-5.6-sol",
      deadline_at: "2099-09-01T10:10:00.000Z",
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      fetch: async () => { calls += 1; return new Response(); },
    });

    for (const field of ["service_tier", "conversation", "metadata", "previous_response_id", "temperature"]) {
      await expect(proxy.forward(codexRequest(marker, { [field]: "forbidden" })))
        .rejects.toThrow("unexpected fields");
    }
    expect(calls).toBe(0);
  });

  test("rejects a headerless upstream body unless it is a complete metered SSE stream", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const deadline = "2099-09-01T10:10:00.000Z";
    const proxy = new FixedModelProxy({
      proxy_marker: markerJwt(now),
      adapter_id: "openclaw",
      codex_access_grant: syntheticGrant(deadline),
      upstream_model: "gpt-5.6-sol",
      deadline_at: deadline,
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      fetch: async () => new Response(JSON.stringify({ status: "completed" }), { status: 200 }),
    });

    await expect(proxy.forward(observedOpenClawRequest(markerJwt(now))))
      .rejects.toThrow("SSE terminal usage");
    expect(proxy.usage().usage_complete).toBe(false);
  });

  test("rejects non-text and authority-expanding input items at every nested boundary", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const marker = markerJwt(now);
    const accountId = "acct_trusted_123";
    const proxy = new FixedModelProxy({
      proxy_marker: marker,
      adapter_id: "openclaw",
      codex_access_grant: {
        access_token: jwt(accountId, Math.floor(now / 1_000) + 900),
        account_id: accountId,
        expires_at: Math.floor(now / 1_000) + 900,
        source: "hermes-auth-store",
      },
      upstream_model: "gpt-5.6-sol",
      deadline_at: "2099-09-01T10:10:00.000Z",
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      fetch: async () => { throw new Error("must not reach upstream"); },
    });
    const inputs = [
      [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://evil.invalid/x" }] }],
      [{ type: "message", role: "user", content: [{ type: "file", file_id: "file-secret" }] }],
      [{ type: "computer_call", id: "computer-1" }],
      [{ type: "hosted_tool", name: "web_search" }],
      [{ type: "message", role: "user", content: [{ type: "input_text", text: "ok", extra: true }] }],
      [{ type: "function_call", name: "exec", arguments: "{}", call_id: "call-1" }],
    ];
    for (const input of inputs) {
      const request = codexRequest(marker);
      const body = await request.json() as Record<string, unknown>;
      body.input = input;
      await expect(proxy.forward(new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }))).rejects.toThrow("input");
    }
  });

  test("normalizes only pinned benign replay fields and keeps arbitrary replay metadata rejected", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const marker = markerJwt(now);
    const accountId = "acct_trusted_123";
    const bodies: Record<string, unknown>[] = [];
    const proxy = new FixedModelProxy({
      proxy_marker: marker,
      adapter_id: "openclaw",
      codex_access_grant: {
        access_token: jwt(accountId, Math.floor(now / 1_000) + 900),
        account_id: accountId,
        expires_at: Math.floor(now / 1_000) + 900,
        source: "credential_pool",
      },
      upstream_model: "gpt-5.6-sol",
      deadline_at: "2099-09-01T10:10:00.000Z",
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(completedSse(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const request = codexRequest(marker);
    const body = await request.json() as Record<string, unknown>;
    body.input = [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "prior answer", annotations: [] }],
    }];
    await proxy.forward(new Request(request.url, {
      method: "POST", headers: request.headers, body: JSON.stringify(body),
    }));
    const forwardedInput = bodies[0]!.input as Array<Record<string, unknown>>;
    expect(forwardedInput[0]).not.toHaveProperty("status");
    expect((forwardedInput[0]!.content as Array<Record<string, unknown>>)[0])
      .not.toHaveProperty("annotations");

    for (const mutation of [
      { status: "in_progress", annotations: [] },
      { status: "completed", annotations: [{ type: "url_citation", url: "https://evil.invalid" }] },
    ]) {
      const candidate = codexRequest(marker);
      const candidateBody = await candidate.json() as Record<string, unknown>;
      candidateBody.input = [{
        type: "message",
        role: "assistant",
        status: mutation.status,
        content: [{ type: "output_text", text: "prior answer", annotations: mutation.annotations }],
      }];
      await expect(proxy.forward(new Request(candidate.url, {
        method: "POST", headers: candidate.headers, body: JSON.stringify(candidateBody),
      }))).rejects.toThrow();
    }
  });

  test("uses the native Direct subscription profile without unsupported format or token fields", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const deadline = "2099-09-01T10:10:00.000Z";
    const accountId = "acct_trusted_123";
    let forwarded: Record<string, unknown> | undefined;
    const proxy = new FixedModelProxy({
      proxy_marker: markerJwt(now),
      adapter_id: "direct_model",
      codex_access_grant: syntheticGrant(deadline, accountId),
      upstream_model: "gpt-5.6-sol",
      deadline_at: deadline,
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      fetch: async (_input, init) => {
        forwarded = JSON.parse(String(init?.body));
        return new Response(completedSse(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    await proxy.forward(directCodexRequest(markerJwt(now)));
    expect(forwarded).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      text: { verbosity: "low" },
    });
    expect(forwarded).not.toHaveProperty("max_output_tokens");
    expect((forwarded!.text as Record<string, unknown>)).not.toHaveProperty("format");
    await expect(proxy.forward(directCodexRequest(markerJwt(now), {
      text: { format: { type: "json_schema" } },
    }))).rejects.toThrow("unexpected fields");
    await expect(proxy.forward(directCodexRequest(markerJwt(now), {
      input: [{
        type: "message",
        role: "user",
        status: "completed",
        content: [{ type: "input_text", text: "evidence", annotations: [] }],
      }],
    }))).rejects.toThrow("direct model input");
  });

  test("propagates only validated provider cooldown headers", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const deadline = "2099-09-01T10:10:00.000Z";
    const makeProxy = (headers: HeadersInit) => new FixedModelProxy({
      proxy_marker: markerJwt(now),
      adapter_id: "openclaw",
      codex_access_grant: syntheticGrant(deadline),
      upstream_model: "gpt-5.6-sol",
      deadline_at: deadline,
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      fetch: async () => new Response("rate limited", { status: 429, headers }),
    });
    const valid = await makeProxy({ "retry-after": "17", "retry-after-ms": "1250" })
      .forward(codexRequest(markerJwt(now)));
    expect(valid.headers.get("retry-after")).toBe("17");
    expect(valid.headers.get("retry-after-ms")).toBe("1250");
    const invalid = await makeProxy({ "retry-after": "999999", "retry-after-ms": "nan" })
      .forward(codexRequest(markerJwt(now)));
    expect(invalid.headers.has("retry-after")).toBe(false);
    expect(invalid.headers.has("retry-after-ms")).toBe(false);
  });

  test("charges authenticated malformed and already-aborted requests against the request budget", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const marker = markerJwt(now);
    const accountId = "acct_trusted_123";
    const proxy = new FixedModelProxy({
      proxy_marker: marker,
      adapter_id: "openclaw",
      codex_access_grant: {
        access_token: jwt(accountId, Math.floor(now / 1_000) + 900),
        account_id: accountId,
        expires_at: Math.floor(now / 1_000) + 900,
        source: "hermes-auth-store",
      },
      upstream_model: "gpt-5.6-sol",
      deadline_at: "2099-09-01T10:10:00.000Z",
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      max_request_count: 2,
      fetch: async () => { throw new Error("must not reach upstream"); },
    });
    await expect(proxy.forward(codexRequest(marker, { metadata: {} }))).rejects.toThrow("unexpected fields");
    const controller = new AbortController();
    controller.abort();
    const aborted = codexRequest(marker);
    await expect(proxy.forward(new Request(aborted, { signal: controller.signal }))).rejects.toThrow("aborted");
    await expect(proxy.forward(codexRequest(marker))).rejects.toThrow("request count");
    expect(proxy.usage().request_count).toBe(2);
  });

  test("enforces concurrency, aggregate bytes, hard deadline, and retirement cancellation", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const marker = markerJwt(now);
    const accountId = "acct_trusted_123";
    let release!: () => void;
    let observedSignal: AbortSignal | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const proxy = new FixedModelProxy({
      proxy_marker: marker,
      adapter_id: "openclaw",
      codex_access_grant: {
        access_token: jwt(accountId, Math.floor(now / 1_000) + 900),
        account_id: accountId,
        expires_at: Math.floor(now / 1_000) + 900,
        source: "hermes-auth-store",
      },
      upstream_model: "gpt-5.6-sol",
      deadline_at: "2099-09-01T10:10:00.000Z",
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      max_request_count: 2,
      max_input_bytes: 400_000,
      max_output_bytes: 8_388_608,
      max_concurrency: 1,
      fetch: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        await pending;
        if (observedSignal?.aborted) throw new Error("upstream aborted");
        return new Response(completedSse(), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const first = proxy.forward(codexRequest(marker));
    await Promise.resolve();
    await expect(proxy.forward(codexRequest(marker))).rejects.toThrow("concurrency");
    proxy.retire();
    expect(observedSignal?.aborted).toBe(true);
    release();
    await expect(first).rejects.toThrow();
    await expect(proxy.forward(codexRequest(marker))).rejects.toThrow("retired");
  });

  test("rejects a buffered response whose observed usage exceeds the post-response token cap", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const deadline = "2099-09-01T10:10:00.000Z";
    const marker = markerJwt(now);
    const proxy = new FixedModelProxy({
      proxy_marker: marker,
      adapter_id: "openclaw",
      codex_access_grant: syntheticGrant(deadline),
      upstream_model: "gpt-5.6-sol",
      deadline_at: deadline,
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      fetch: async () => new Response(completedSse({
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 8_193,
        total_tokens: 8_293,
      }), { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(proxy.forward(codexRequest(marker))).rejects.toThrow("observed token limit");
    expect(proxy.usage().usage_complete).toBe(false);
  });

  test("rejects a grant that cannot survive the whole attempt plus safety skew", () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const deadline = "2099-09-01T10:10:00.000Z";
    const accountId = "acct_trusted_123";
    const expiresAt = Math.floor(Date.parse(deadline) / 1_000) + 119;
    expect(() => new FixedModelProxy({
      proxy_marker: markerJwt(now),
      adapter_id: "openclaw",
      codex_access_grant: {
        access_token: jwt(accountId, expiresAt),
        account_id: accountId,
        expires_at: expiresAt,
        source: "hermes-auth-store",
      },
      upstream_model: "gpt-5.6-sol",
      deadline_at: deadline,
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      fetch: async () => new Response(),
    })).toThrow("expiry");
  });
});

describe("inspect-after cleanup proof", () => {
  test("rejects direct-model runtime substitution before any Docker command", async () => {
    let commands = 0;
    const runtime = new CellRuntime({
      command_runner: {
        async run() { commands += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
      },
      listener_closed: async () => true,
      identity_process_absent: async () => true,
    });
    const direct = directModelRuntimeIdentityBinding(
      `/run/ligou-discovery/${"e".repeat(48)}/subscription.sock`,
    );
    await expect(runtime.cleanupBoundRuntime(direct as never)).rejects.toThrow("OpenClaw cell");
    expect(commands).toBe(0);
  });

  test("treats destructive-command not-found as idempotent only after exact inspect absence", async () => {
    const runtimeIdentity = await identity();
    const commands: CommandSpec[] = [];
    const runtime = new CellRuntime({
      command_runner: {
        async run(command) {
          commands.push(command);
          if (command.label.startsWith("inspect-")) {
            const resource = command.label.includes("volume-keeper")
              ? "No such object"
              : command.label.includes("volume")
              ? "No such volume"
              : command.label.includes("network")
                ? "network not found"
                : "No such object";
            return { exitCode: 1, stdout: "", stderr: resource };
          }
          return { exitCode: 1, stdout: "", stderr: "already absent" };
        },
      },
      listener_closed: async () => true,
      identity_process_absent: async () => true,
      cleanup_command_timeout_ms: 50,
    });

    const proof = await runtime.cleanup({ identity: runtimeIdentity });
    expect(proof).toEqual({
      gateway_exited: true,
      cell_removed: true,
      bridge_removed: true,
      config_removed: true,
      state_removed: true,
      workspace_removed: true,
      output_removed: true,
      network_removed: true,
      credential_material_removed: true,
      listener_closed: true,
      no_identity_process: true,
    });
    expect(commands.some((entry) => entry.label === "inspect-cell-absence")).toBe(true);
    expect(commands.some((entry) => entry.label === "inspect-output-volume-absence")).toBe(true);
  });

  test("keeps daemon errors, timeouts, and host identity ambiguity unresolved", async () => {
    const runtimeIdentity = await identity();
    const runtime = new CellRuntime({
      command_runner: {
        async run(command, signal) {
          if (command.label === "inspect-cell-absence") {
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("bounded abort")), { once: true });
            });
          }
          if (command.label.startsWith("inspect-")) {
            return { exitCode: 2, stdout: "", stderr: "Cannot connect to the Docker daemon" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      listener_closed: async () => false,
      identity_process_absent: async () => false,
      cleanup_command_timeout_ms: 5,
    });

    const proof = await runtime.cleanup({ identity: runtimeIdentity });
    expect(proof.cell_removed).toBe(false);
    expect(proof.bridge_removed).toBe(false);
    expect(proof.output_removed).toBe(false);
    expect(proof.network_removed).toBe(false);
    expect(proof.listener_closed).toBe(false);
    expect(proof.no_identity_process).toBe(false);
  });

  test("exposes bounded disk observations through the Ligou helper image", async () => {
    const runtimeIdentity = await identity();
    const commands: CommandSpec[] = [];
    const runtime = new CellRuntime({
      command_runner: {
        async run(command) {
          commands.push(command);
          return {
            exitCode: 0,
            stdout: "12\t/state\n3\t/workspace\n7\t/output\n",
            stderr: "",
          };
        },
      },
      listener_closed: async () => true,
      identity_process_absent: async () => true,
    });

    expect(await runtime.observeDiskUsage({ identity: runtimeIdentity })).toEqual({
      state_bytes: 12 * 1_024,
      workspace_bytes: 3 * 1_024,
      output_bytes: 7 * 1_024,
    });
    const command = commands[0]!;
    expect(command.label).toBe("observe-runtime-disk-usage");
    expect(command.argv).toContain(`ligou-discovery-bridge@${images.bridge_image.selected_manifest_digest}`);
    expect(command.argv.join(" ")).not.toContain(`ghcr.io/openclaw/openclaw@${images.cell_image.selected_manifest_digest}`);
    expect(command.argv.filter((value) => value.includes(",readonly"))).toHaveLength(3);
  });
});

describe("OpenClaw terminal usage evidence", () => {
  const localCleanup = {
    gateway_exited: true,
    cell_removed: true,
    bridge_removed: true,
    config_removed: true,
    state_removed: true,
    workspace_removed: true,
    output_removed: true,
    network_removed: true,
    credential_material_removed: true,
    listener_closed: true,
    no_identity_process: true,
  } as const;

  test("rejects a submitted result when terminal subscription usage is incomplete", async () => {
    const runtimeIdentity = await identity();
    const lease = Object.freeze(Object.create(null)) as SubscriptionLeaseCapability;
    const modelAccess = Object.freeze(Object.create(null)) as ModelAccessCapability;
    let resultReads = 0;
    const incomplete = subscriptionUsage({ usage_complete: false, quota_state: "unknown" });
    const factory = new EphemeralOpenClawAttemptFactory({
      runtime: {
        async start() {},
        async readSubmittedResult() { resultReads += 1; return adapterResult; },
        async cleanup() { return localCleanup; },
      },
      gateway_client: {
        async run() {
          return {
            run_id: "run-usage",
            connection: { hello: {} as never, async request() { return {}; }, close() {} },
          };
        },
        async close() {},
      },
      upstream_model: "gpt-5.6-sol",
      resolve_identity: async () => runtimeIdentity,
      subscription_gateway: {
        async register() {
          return {
            lease,
            attempt_marker: markerJwt(Date.parse("2099-09-01T10:00:00.000Z")),
            subscription_socket_path: runtimeIdentity.subscription_socket_path,
            session_id: "stage0_session_abcdefghijklmnop",
            policy: {
              model: "gpt-5.6-sol",
              deadline_at: adapterJob.deadline_at,
              max_requests: 4,
              max_input_bytes: 400_000,
              max_output_bytes: 8_388_608,
              max_response_bytes: 4_194_304,
              concurrency: 1,
              cache_retention: "none",
            },
          };
        },
        async forward() { throw new Error("not used"); },
        usage(received) { expect(received).toBe(lease); return incomplete; },
        async revoke() { throw new Error("supervisor recovery owns revocation"); },
        async recover() { throw new Error("not used"); },
      },
      random_bytes: () => Buffer.alloc(32, 0x44),
    });
    const session = await factory.start(adapterJob, modelAccess);
    await expect(session.result).rejects.toThrow("usage is incomplete");
    expect(resultReads).toBe(0);
    expect(session.usage()).toEqual(incomplete);
    expect(await session.cleanup()).toEqual(localCleanup);
  });

  test("exposes trusted usage only while the adapter execution remains active", async () => {
    const complete = subscriptionUsage();
    const adapter = new OpenClawDiscoveryAdapter({
      attempts: {
        async start() {
          return {
            result: Promise.resolve(adapterResult),
            async cancel() {},
            async cleanup() { return localCleanup; },
            usage: () => complete,
          };
        },
      },
    });
    const handle = await adapter.submit(
      adapterJob,
      Object.freeze(Object.create(null)) as ModelAccessCapability,
    );
    expect(await adapter.result(handle)).toEqual(adapterResult);
    expect(adapter.subscriptionUsage(handle)).toEqual(complete);
    expect(await adapter.retire(handle)).toEqual(localCleanup);
    expect(() => adapter.subscriptionUsage(handle)).toThrow("retired");
  });
});

describe("trusted bridge ingress bounds", () => {
  test("rejects oversized MCP bodies before reaching tools", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const deadline = "2099-09-01T10:10:00.000Z";
    const marker = markerJwt(now);
    const context = createDiscoveryAttemptContext({
      normalized_origin: "https://example.com/",
      deadline_at: deadline,
      budget: {
        max_pages: 1,
        max_depth: 0,
        max_page_bytes: 1_024,
        max_job_bytes: 1_024,
        deadline_seconds: 600,
      },
    });
    let toolCalls = 0;
    const source = {
      url: "https://example.com/",
      retrieved_at: "2099-09-01T10:00:00.000Z",
      http_status: 200,
      mime_type: "text/html" as const,
      byte_length: 16,
      content_hash: "a".repeat(64),
      excerpt: "Example Plumbing",
      crawl_order: 0,
      crawl_depth: 0,
    };
    const mcp = new AttemptMcpBridge({
      proxy_marker: marker,
      expected_remote_address: "127.0.0.1",
      fetch_context: context,
      source_snapshots: [source],
      fetch_page: async () => { toolCalls += 1; throw new Error("not expected"); },
      submit_result: async () => { toolCalls += 1; },
    });
    const proxy = new FixedModelProxy({
      proxy_marker: marker,
      adapter_id: "openclaw",
      codex_access_grant: syntheticGrant(deadline),
      upstream_model: "gpt-5.6-sol",
      deadline_at: deadline,
      lease_session_id: "stage0_session_abcdefghijklmnop",
      now: () => now,
      fetch: async () => { throw new Error("not expected"); },
    });
    const server = new TrustedBridgeServer({
      host: "127.0.0.1",
      http_port: 0,
      relay_port: 0,
      relay_target: { host: "127.0.0.1", port: 9 },
      mcp_bridge: mcp,
      model_proxy: proxy,
      max_mcp_request_bytes: 128,
      unauthenticated_admission_timeout_ms: 5,
    });
    const address = await server.start();
    try {
      const response = await fetch(`${address.http_url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${marker}`,
          "content-type": "application/json",
        },
        body: "x".repeat(129),
      });
      expect(response.status).toBe(413);
      await response.arrayBuffer();
      expect(toolCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("keeps authenticated model work alive beyond the unauthenticated admission window", async () => {
    const deadline = "2099-09-01T10:10:00.000Z";
    const context = createDiscoveryAttemptContext({
      normalized_origin: "https://example.com/",
      deadline_at: deadline,
      budget: {
        max_pages: 1,
        max_depth: 0,
        max_page_bytes: 1_024,
        max_job_bytes: 1_024,
        deadline_seconds: 600,
      },
    });
    const marker = "m".repeat(43);
    const source = {
      url: "https://example.com/",
      retrieved_at: "2099-09-01T10:00:00.000Z",
      http_status: 200,
      mime_type: "text/html" as const,
      byte_length: 16,
      content_hash: "a".repeat(64),
      excerpt: "Example Plumbing",
      crawl_order: 0,
      crawl_depth: 0,
    };
    const mcp = new AttemptMcpBridge({
      proxy_marker: marker,
      expected_remote_address: "127.0.0.1",
      fetch_context: context,
      source_snapshots: [source],
      fetch_page: async () => { throw new Error("not used"); },
      submit_result: async () => { throw new Error("not used"); },
    });
    const server = new TrustedBridgeServer({
      host: "127.0.0.1",
      http_port: 0,
      relay_port: 0,
      relay_target: { host: "127.0.0.1", port: 9 },
      mcp_bridge: mcp,
      model_proxy: {
        retire() {},
        async forward(request) {
          expect(request.headers.get("authorization")).toBe(`Bearer ${marker}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
          return new Response(completedSse(), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
      unauthenticated_admission_timeout_ms: 5,
      authenticated_session_timeout_ms: 100,
    });
    const address = await server.start();
    try {
      const response = await fetch(`${address.http_url}/codex/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${marker}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("response.completed");
    } finally {
      await server.close();
    }
  });
});

describe("central Hermes credential-owner grant", () => {
  test("single-flights resolution and emits only a deadline-bound access grant", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const deadline = "2099-09-01T10:10:00.000Z";
    const accountId = "acct-central-owner";
    const expiresAt = Math.ceil(Date.parse(deadline) / 1_000) + 180;
    const containerId = "c".repeat(64);
    let calls = 0;
    let observed: CommandSpec | undefined;
    let inspectObserved: CommandSpec | undefined;
    let codeObserved: CommandSpec | undefined;
    const runtime = {
      container_name: "ligou-cell-11111111-1111-4111-8111-111111111111",
      model_auth_volume: "ligou-11111111-1111-4111-8111-111111111111-hermes-model-auth",
      image_reference: `registry.example/ligou/hermes@sha256:${"a".repeat(64)}`,
      image_id: `sha256:${"b".repeat(64)}`,
      interpreter_path: "/opt/hermes/.venv/bin/python" as const,
    };
    const resolver = new HermesCodexGrantResolver({
      now: () => now,
      credential_owner_registry: {
        resolve(ownerId, generation) {
          expect(ownerId).toBe("11111111-1111-4111-8111-111111111111");
          expect(generation).toBe(7);
          return runtime;
        },
      },
      command_runner: {
        async run(command) {
          expect(command.label).toBe("verify-credential-owner-code");
          codeObserved = command;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        async runSensitive(command) {
          if (command.label === "verify-credential-owner-runtime") {
            inspectObserved = command;
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Id: containerId,
                Name: `/${runtime.container_name}`,
                Config: {
                  Image: runtime.image_reference,
                  Env: hermesRuntimeEnv,
                },
                Image: runtime.image_id,
                State: { Running: true },
                Mounts: [{
                  Type: "volume",
                  Name: runtime.model_auth_volume,
                  Destination: "/opt/model-auth",
                  RW: true,
                }],
              }),
              stderr: "",
            };
          }
          calls += 1;
          observed = command;
          await Promise.resolve();
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              access_token: jwt(accountId, expiresAt),
              account_id: accountId,
              expires_at: expiresAt,
              source: "credential_pool",
              provider: "openai-codex",
              auth_mode: "chatgpt",
              base_url: "https://chatgpt.com/backend-api/codex",
            }),
            stderr: "",
          };
        },
      },
    });
    const owner = {
      credential_owner_id: "11111111-1111-4111-8111-111111111111",
      credential_generation: 7,
      account_id_sha256: createHash("sha256").update(accountId).digest("hex"),
    };

    const [first, second] = await Promise.all([
      resolver.resolve(owner, deadline),
      resolver.resolve(owner, deadline),
    ]);
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(first.source).toBe("credential_pool");
    expect(inspectObserved?.argv).toEqual([
      "docker", "inspect", "--format",
      '{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Image":{{json .Config.Image}},"Env":{{json .Config.Env}}},"Image":{{json .Image}},"State":{"Running":{{json .State.Running}}},"Mounts":{{json .Mounts}}}',
      runtime.container_name,
    ]);
    expect(inspectObserved?.sensitive_stdout).toBe(true);
    expect(codeObserved?.argv).toEqual(["docker", "diff", containerId]);
    expect(observed?.sensitive_stdout).toBe(true);
    expect(observed?.argv.slice(0, 6)).toEqual([
      "docker", "exec", "-i", "--user", "10000:10000", containerId,
    ]);
    expect(observed?.argv.join(" ")).not.toContain(first.access_token);
    expect(JSON.stringify(observed?.env)).toBe("{}");
  });

  test("fails closed on short pool TTL, account mismatch, owner-runtime mismatch, and redacts helper errors", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const deadline = "2099-09-01T10:10:00.000Z";
    const accountId = "acct-central-owner";
    const deadlineSeconds = Math.ceil(Date.parse(deadline) / 1_000);
    const containerId = "d".repeat(64);
    const owner = {
      credential_owner_id: "11111111-1111-4111-8111-111111111111",
      credential_generation: 7,
      account_id_sha256: createHash("sha256").update(accountId).digest("hex"),
    };
    const runtime = {
      container_name: "ligou-cell-11111111-1111-4111-8111-111111111111",
      model_auth_volume: "ligou-11111111-1111-4111-8111-111111111111-hermes-model-auth",
      image_reference: `registry.example/ligou/hermes@sha256:${"a".repeat(64)}`,
      image_id: `sha256:${"b".repeat(64)}`,
      interpreter_path: "/opt/hermes/.venv/bin/python" as const,
    };
    const resolver = (options: {
      expiresAt?: number;
      returnedAccount?: string;
      inspectedImage?: string;
      stderr?: string;
    }) => new HermesCodexGrantResolver({
      now: () => now,
      credential_owner_registry: { resolve: () => runtime },
      command_runner: {
        async run(command) {
          expect(command.label).toBe("verify-credential-owner-code");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        async runSensitive(command) {
          if (command.label === "verify-credential-owner-runtime") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Id: containerId,
                Name: `/${runtime.container_name}`,
                Config: {
                  Image: runtime.image_reference,
                  Env: hermesRuntimeEnv,
                },
                Image: options.inspectedImage ?? runtime.image_id,
                State: { Running: true },
                Mounts: [{
                  Type: "volume",
                  Name: runtime.model_auth_volume,
                  Destination: "/opt/model-auth",
                  RW: true,
                }],
              }),
              stderr: "",
            };
          }
          const returnedAccount = options.returnedAccount ?? accountId;
          const expiresAt = options.expiresAt ?? deadlineSeconds + 180;
          return {
            exitCode: options.stderr ? 1 : 0,
            stdout: JSON.stringify({
              access_token: jwt(returnedAccount, expiresAt),
              account_id: returnedAccount,
              expires_at: expiresAt,
              source: "credential_pool",
              provider: "openai-codex",
              auth_mode: "chatgpt",
              base_url: "https://chatgpt.com/backend-api/codex",
            }),
            stderr: options.stderr ?? "",
          };
        },
      },
    });

    await expect(resolver({ expiresAt: deadlineSeconds + 119 }).resolve(owner, deadline))
      .rejects.toThrow("cannot cover");
    await expect(resolver({ returnedAccount: "acct-wrong-owner" }).resolve(owner, deadline))
      .rejects.toThrow("account binding mismatch");
    await expect(resolver({ inspectedImage: `sha256:${"c".repeat(64)}` }).resolve(owner, deadline))
      .rejects.toThrow("runtime binding mismatch");
    const sensitive = "synthetic_access_token_must_not_escape";
    const failure = resolver({ stderr: sensitive }).resolve(owner, deadline);
    await expect(failure).rejects.toThrow("helper failed");
    await failure.catch((error) => {
      expect(String(error)).not.toContain(sensitive);
    });
  });
});

describe("subscription UDS host boundary", () => {
  function fakeFileSystem(initial: Record<string, {
    type: "directory" | "socket" | "symlink";
    uid: number;
    gid: number;
    mode: number;
  }>) {
    const entries = new Map(Object.entries(initial).map(([path, value]) => [path, { ...value }]));
    const missing = (path: string) => Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
    const fileSystem: SubscriptionRuntimeFileSystem = {
      async lstat(path) {
        const value = entries.get(path);
        if (value === undefined) throw missing(path);
        return {
          dev: 1,
          ino: [...entries.keys()].indexOf(path) + 1,
          uid: value.uid,
          gid: value.gid,
          mode: value.mode,
          isDirectory: () => value.type === "directory",
          isSymbolicLink: () => value.type === "symlink",
          isSocket: () => value.type === "socket",
        };
      },
      async mkdir(path, options) {
        if (entries.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        entries.set(path, { type: "directory", uid: 501, gid: 20, mode: options.mode });
      },
      async chmod(path, mode) {
        const value = entries.get(path);
        if (value === undefined) throw missing(path);
        value.mode = mode;
      },
      async lchown(path, uid, gid) {
        const value = entries.get(path);
        if (value === undefined) throw missing(path);
        value.uid = uid;
        value.gid = gid;
      },
      async secureDirectory(path, uid, gid, mode) {
        const value = entries.get(path);
        if (value === undefined) throw missing(path);
        if (value.type !== "directory") throw new Error("not directory");
        value.uid = uid;
        value.gid = gid;
        value.mode = mode;
      },
      async unlink(path) {
        if (!entries.delete(path)) throw missing(path);
      },
      async rmdir(path) {
        if (![...entries.keys()].some((candidate) => candidate.startsWith(`${path}/`))) {
          if (!entries.delete(path)) throw missing(path);
          return;
        }
        throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
      },
    };
    return { entries, fileSystem };
  }

  test("creates and validates a non-symlink runtime root with bridge-traversable ownership", async () => {
    const fake = fakeFileSystem({
      "/run": { type: "directory", uid: 0, gid: 0, mode: 0o755 },
    });
    const manager = new UnixSubscriptionListenerManager({
      supervisor_uid: 501,
      file_system: fake.fileSystem,
    });
    expect(await manager.prepareRuntimeRoot()).toEqual({
      path: "/run/ligou-discovery",
      owner_uid: 501,
      bridge_uid: 1_000,
      bridge_gid: 1_000,
      mode: 0o710,
      no_symlink: true,
    });
    expect(fake.entries.get("/run/ligou-discovery")).toEqual({
      type: "directory", uid: 501, gid: 1_000, mode: 0o710,
    });

    const poisoned = fakeFileSystem({
      "/run": { type: "directory", uid: 0, gid: 0, mode: 0o755 },
      "/run/ligou-discovery": { type: "symlink", uid: 501, gid: 1_000, mode: 0o710 },
    });
    await expect(new UnixSubscriptionListenerManager({
      supervisor_uid: 501,
      file_system: poisoned.fileSystem,
    }).prepareRuntimeRoot()).rejects.toThrow("ownership or type");
  });

  test("reclaims a stale owned socket only after the authoritative host absence hook", async () => {
    const suffix = "d".repeat(48);
    const directory = `/run/ligou-discovery/${suffix}`;
    const socketPath = `${directory}/subscription.sock`;
    const context = {
      job_id: "11111111-1111-4111-8111-111111111111",
      attempt_id: "22222222-2222-4222-8222-222222222222",
      fence_generation: 9,
      subscription_socket_path: socketPath,
      runtime_kind: "openclaw_cell" as const,
      late_result_rejected: true as const,
    };
    const initial = {
      "/run": { type: "directory" as const, uid: 0, gid: 0, mode: 0o755 },
      "/run/ligou-discovery": { type: "directory" as const, uid: 501, gid: 1_000, mode: 0o710 },
      [directory]: { type: "directory" as const, uid: 501, gid: 1_000, mode: 0o710 },
      [socketPath]: { type: "socket" as const, uid: 501, gid: 1_000, mode: 0o660 },
    };
    const unresolved = fakeFileSystem(initial);
    const withoutProof = new UnixSubscriptionListenerManager({
      supervisor_uid: 501,
      file_system: unresolved.fileSystem,
    });
    expect(await withoutProof.recoverAbsent(context)).toEqual({
      listener_closed: false,
      socket_absent: false,
    });
    expect(unresolved.entries.has(socketPath)).toBe(true);
    expect(() => new UnixSubscriptionListenerManager({
      supervisor_uid: 501,
      file_system: unresolved.fileSystem,
      stale_socket_identity_absent: async () => true,
    } as never)).toThrow("options are invalid");
    expect(unresolved.entries.has(socketPath)).toBe(true);

    const reclaimable = fakeFileSystem(initial);
    let observedContext: unknown;
    const withProof = new UnixSubscriptionListenerManager({
      supervisor_uid: 501,
      file_system: reclaimable.fileSystem,
      prove_stale_socket_identity_absent: async (received) => {
        observedContext = received;
        return { ...received, identity_process_absent: true as const };
      },
    });
    expect(await withProof.recoverAbsent(context)).toEqual({
      listener_closed: true,
      socket_absent: true,
    });
    expect(observedContext).toEqual(context);
    expect(reclaimable.entries.has(socketPath)).toBe(false);
    expect(reclaimable.entries.has(directory)).toBe(false);
  });
});

describe("central multi-lease subscription gateway", () => {
  test("authenticates the in-process DirectModel path without exposing the local marker", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const context = centralContext({ adapter_id: "direct_model" });
    const capability = Object.freeze(Object.create(null)) as ModelAccessCapability;
    let upstreamCalls = 0;
    const governor = subscriptionGovernorStubs(now);
    const completed = {
      status: "completed",
      error: null,
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            candidate_facts: adapterResult.candidate_facts,
            missing_questions: adapterResult.missing_questions,
            contradictions: adapterResult.contradictions,
            uncertainty: adapterResult.uncertainty,
          }),
        }],
      }],
      usage: {
        input_tokens: 101,
        input_tokens_details: { cached_tokens: 11 },
        output_tokens: 23,
        total_tokens: 124,
      },
    };
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...governor,
        async assertSubscriptionRecoveryCurrent() { throw new Error("not used"); },
        async assertModelAccessCurrent(received) {
          expect(received).toBe(capability);
          return context;
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(
        context.deadline_at,
        "acct-central-owner",
      ),
      listener_manager: {
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        async open() {
          return {
            async close() {
              return { listener_closed: true, socket_absent: true };
            },
          };
        },
      },
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x6a),
      fetch: async () => {
        upstreamCalls += 1;
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const adapter = new DirectModelDiscoveryAdapter({
      subscription_gateway: gateway,
      clock: {
        now: () => now,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
    });

    const handle = await adapter.submit(adapterJob, capability);
    expect(await adapter.result(handle)).toEqual(adapterResult);
    expect(upstreamCalls).toBe(1);
    await expect(adapter.retire(handle)).resolves.toMatchObject({
      subscription_lease_revoked: true,
      subscription_requests_drained: true,
      subscription_listener_closed: true,
      subscription_socket_absent: true,
    });
  });

  test("derives policy from opaque authority and revalidates before every upstream request", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const context: ModelAccessContext = {
      adapter_id: "openclaw",
      job_id: "11111111-1111-4111-8111-111111111111",
      attempt_id: "22222222-2222-4222-8222-222222222222",
      fence_generation: 7,
      runtime_slot_id: "33333333-3333-4333-8333-333333333333",
      tenant_id: "44444444-4444-4444-8444-444444444444",
      credential_owner_id: "55555555-5555-4555-8555-555555555555",
      credential_generation: 3,
      expected_account_hash: createHash("sha256").update("acct-central-owner").digest("hex"),
      deadline_at: "2099-09-01T10:10:00.000Z",
      source_snapshot_count: 4,
      subscription_socket_path: `/run/ligou-discovery/${"a".repeat(48)}/subscription.sock`,
      runtime_identity_hash: "b".repeat(64),
      provider: "openai-codex",
      auth_kind: "chatgpt_subscription_oauth",
      model: "gpt-5.6-sol",
    };
    const capability = Object.freeze(Object.create(null)) as ModelAccessCapability;
    let authorityReads = 0;
    let upstreamCalls = 0;
    let closeCalls = 0;
    let reservedProspective: { input_bytes: number; output_bytes: number; lease_seconds: number } | undefined;
    let settledUsage: {
      input_bytes: number;
      output_bytes: number;
      observed_input_tokens: number | null;
      observed_output_tokens: number | null;
      usage_complete: boolean;
    } | undefined;
    const governor = subscriptionGovernorStubs(now);
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...governor,
        async reserveSubscriptionRequest(received, prospective) {
          expect(received).toBe(capability);
          reservedProspective = prospective;
          return governor.reserveSubscriptionRequest(received, prospective);
        },
        async settleSubscriptionRequest(reservation, settlement) {
          settledUsage = settlement;
          return governor.settleSubscriptionRequest(reservation, settlement);
        },
        async assertSubscriptionRecoveryCurrent() { throw new Error("not used"); },
        async assertModelAccessCurrent(received, expected) {
          expect(received).toBe(capability);
          if (expected !== undefined) expect(expected).toEqual({
            adapter_id: context.adapter_id,
            job_id: context.job_id,
            attempt_id: context.attempt_id,
            fence_generation: context.fence_generation,
            runtime_slot_id: context.runtime_slot_id,
          });
          authorityReads += 1;
          return context;
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(context.deadline_at, "acct-central-owner"),
      listener_manager: {
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        async open(_path, _marker, _forward) {
          return {
            async close() {
              closeCalls += 1;
              return { listener_closed: true, socket_absent: true };
            },
          };
        },
      },
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x71),
      fetch: async () => {
        upstreamCalls += 1;
        return new Response(completedSse(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const registered = await gateway.register(capability);
    expect(registered.policy).toEqual({
      model: "gpt-5.6-sol",
      deadline_at: context.deadline_at,
      max_requests: 7,
      max_input_bytes: 400_000,
      max_output_bytes: 8_388_608,
      max_response_bytes: 4_194_304,
      concurrency: 1,
      cache_retention: "none",
    });
    const forwardedRequest = codexRequest(registered.attempt_marker);
    const rawInputBytes = (await forwardedRequest.clone().arrayBuffer()).byteLength;
    const response = await gateway.forward(registered.lease, forwardedRequest);
    expect(response.status).toBe(200);
    expect(authorityReads).toBe(3);
    expect(upstreamCalls).toBe(1);
    expect(reservedProspective).toEqual({
      input_bytes: rawInputBytes,
      output_bytes: 4_194_304,
      lease_seconds: 600,
    });
    expect(settledUsage).toMatchObject({
      input_bytes: rawInputBytes,
      output_bytes: Buffer.byteLength(completedSse()),
      observed_input_tokens: 101,
      observed_output_tokens: 23,
      usage_complete: true,
    });
    expect(gateway.usage(registered.lease)).toMatchObject({
      schema_version: "ligou.subscription_usage.v1",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      billing_basis: "chatgpt_subscription",
      marginal_api_charge_usd: 0,
      request_count: 1,
      usage_complete: true,
      quota_state: "available",
      revoked: false,
    });
    expect(await gateway.revoke(registered.lease)).toEqual({
      generation: 7,
      subscription_lease_revoked: true,
      subscription_requests_drained: true,
      subscription_listener_closed: true,
      subscription_socket_absent: true,
    });
    expect(closeCalls).toBe(1);
  });

  test("revokes and aborts when per-request fenced revalidation changes", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const capability = Object.freeze(Object.create(null)) as ModelAccessCapability;
    const context: ModelAccessContext = {
      adapter_id: "direct_model",
      job_id: "11111111-1111-4111-8111-111111111111",
      attempt_id: "22222222-2222-4222-8222-222222222222",
      fence_generation: 7,
      runtime_slot_id: "33333333-3333-4333-8333-333333333333",
      tenant_id: "44444444-4444-4444-8444-444444444444",
      credential_owner_id: "55555555-5555-4555-8555-555555555555",
      credential_generation: 3,
      expected_account_hash: createHash("sha256").update("acct-central-owner").digest("hex"),
      deadline_at: "2099-09-01T10:10:00.000Z",
      source_snapshot_count: 1,
      subscription_socket_path: `/run/ligou-discovery/${"c".repeat(48)}/subscription.sock`,
      runtime_identity_hash: "d".repeat(64),
      provider: "openai-codex",
      auth_kind: "chatgpt_subscription_oauth",
      model: "gpt-5.6-sol",
    };
    let reads = 0;
    let closed = false;
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...subscriptionGovernorStubs(now),
        async assertSubscriptionRecoveryCurrent() { throw new Error("not used"); },
        async assertModelAccessCurrent() {
          reads += 1;
          if (reads > 2) throw new Error("stale model access fence");
          return context;
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(context.deadline_at, "acct-central-owner"),
      listener_manager: {
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        async open() {
          return {
            async close() {
              closed = true;
              return { listener_closed: true, socket_absent: true };
            },
          };
        },
      },
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x72),
      fetch: async () => { throw new Error("must not reach upstream"); },
    });
    const registered = await gateway.register(capability);
    await expect(gateway.forward(registered.lease, codexRequest(registered.attempt_marker)))
      .rejects.toThrow("stale model access fence");
    expect(closed).toBe(true);
    expect(gateway.usage(registered.lease).revoked).toBe(true);
    await expect(gateway.forward(registered.lease, codexRequest(registered.attempt_marker)))
      .rejects.toThrow("revoked");
  });

  test("recovers listener-open failure and post-register crashes idempotently", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const socketPath = `/run/ligou-discovery/${"9".repeat(48)}/subscription.sock`;
    let context: ModelAccessContext = {
      adapter_id: "openclaw",
      job_id: "11111111-1111-4111-8111-111111111111",
      attempt_id: "22222222-2222-4222-8222-222222222222",
      fence_generation: 7,
      runtime_slot_id: "33333333-3333-4333-8333-333333333333",
      tenant_id: "44444444-4444-4444-8444-444444444444",
      credential_owner_id: "55555555-5555-4555-8555-555555555555",
      credential_generation: 3,
      expected_account_hash: createHash("sha256").update("acct-central-owner").digest("hex"),
      deadline_at: "2099-09-01T10:10:00.000Z",
      source_snapshot_count: 1,
      subscription_socket_path: socketPath,
      runtime_identity_hash: "8".repeat(64),
      provider: "openai-codex",
      auth_kind: "chatgpt_subscription_oauth",
      model: "gpt-5.6-sol",
    };
    const modelCapability = Object.freeze(Object.create(null)) as ModelAccessCapability;
    const recoveryCapability = Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
    let recoveryFence = context.fence_generation;
    let recoveryJobId = context.job_id;
    let listenerOpenMode: "ok" | "fail" = "ok";
    let activeListener = false;
    const listenerManager = {
      async proveAbsent() {
        return { listener_closed: !activeListener, socket_absent: !activeListener };
      },
      async open() {
        activeListener = true;
        if (listenerOpenMode === "fail") {
          activeListener = false;
          throw new Error("listener open failed after cleanup");
        }
        return {
          async close() {
            activeListener = false;
            return { listener_closed: true, socket_absent: true };
          },
        };
      },
    };
    const makeGateway = () => new CentralSubscriptionGateway({
      model_access_authority: {
        ...subscriptionGovernorStubs(now),
        async assertModelAccessCurrent() { return context; },
        async assertSubscriptionRecoveryCurrent(received) {
          expect(received).toBe(recoveryCapability);
          return {
            job_id: recoveryJobId,
            attempt_id: context.attempt_id,
            fence_generation: recoveryFence,
            subscription_socket_path: context.subscription_socket_path,
            runtime_kind: "openclaw_cell" as const,
            late_result_rejected: true as const,
          };
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(context.deadline_at, "acct-central-owner"),
      listener_manager: listenerManager,
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x79),
      fetch: async () => { throw new Error("not used"); },
    });

    let gateway = makeGateway();
    listenerOpenMode = "fail";
    await expect(gateway.register(modelCapability)).rejects.toThrow("listener open failed");
    expect((await gateway.recover(recoveryCapability)).subscription_listener_closed).toBe(true);

    context = {
      ...context,
      subscription_socket_path: `/run/ligou-discovery/${"a".repeat(48)}/subscription.sock`,
      runtime_identity_hash: "7".repeat(64),
    };
    recoveryFence = context.fence_generation;
    recoveryJobId = context.job_id;
    gateway = makeGateway();
    const secondModelCapability = Object.freeze(Object.create(null)) as ModelAccessCapability;
    listenerOpenMode = "ok";
    const registered = await gateway.register(secondModelCapability);
    expect(activeListener).toBe(true);
    recoveryFence = 8;
    const recovered = await gateway.recover(recoveryCapability);
    expect(recovered.generation).toBe(8);
    expect(recovered.subscription_lease_revoked).toBe(true);
    expect(activeListener).toBe(false);
    recoveryFence = 9;
    expect((await gateway.recover(recoveryCapability)).generation).toBe(9);
    recoveryFence = 8;
    await expect(gateway.recover(recoveryCapability)).rejects.toThrow("regressed");
    recoveryFence = 10;
    recoveryJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await expect(gateway.recover(recoveryCapability)).rejects.toThrow("prior binding");
    expect(() => gateway.usage(registered.lease)).not.toThrow();
  });

  test("bounds revocation drain and leaves cleanup unresolved until the request actually exits", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const context: ModelAccessContext = {
      adapter_id: "openclaw",
      job_id: "11111111-1111-4111-8111-111111111111",
      attempt_id: "22222222-2222-4222-8222-222222222222",
      fence_generation: 7,
      runtime_slot_id: "33333333-3333-4333-8333-333333333333",
      tenant_id: "44444444-4444-4444-8444-444444444444",
      credential_owner_id: "55555555-5555-4555-8555-555555555555",
      credential_generation: 3,
      expected_account_hash: createHash("sha256").update("acct-central-owner").digest("hex"),
      deadline_at: "2099-09-01T10:10:00.000Z",
      source_snapshot_count: 1,
      subscription_socket_path: `/run/ligou-discovery/${"7".repeat(48)}/subscription.sock`,
      runtime_identity_hash: "6".repeat(64),
      provider: "openai-codex",
      auth_kind: "chatgpt_subscription_oauth",
      model: "gpt-5.6-sol",
    };
    const capability = Object.freeze(Object.create(null)) as ModelAccessCapability;
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...subscriptionGovernorStubs(now),
        async assertSubscriptionRecoveryCurrent() { throw new Error("not used"); },
        async assertModelAccessCurrent() { return context; },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(context.deadline_at, "acct-central-owner"),
      listener_manager: {
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        async open() { return { async close() { return { listener_closed: true, socket_absent: true }; } }; },
      },
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x73),
      revoke_drain_timeout_ms: 5,
      fetch: async () => {
        markStarted();
        await blocked;
        return new Response(completedSse(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const registered = await gateway.register(capability);
    const forwarding = gateway.forward(registered.lease, codexRequest(registered.attempt_marker));
    const forwardingOutcome = forwarding.then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    );
    await started;
    await expect(gateway.revoke(registered.lease)).rejects.toThrow("drain timed out");
    release();
    expect((await forwardingOutcome).error).toBeInstanceOf(Error);
    expect((await gateway.revoke(registered.lease)).subscription_requests_drained).toBe(true);
  });

  test("serializes overlapping rotated recovery and never regresses the newest generation", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const context = centralContext({
      subscription_socket_path: `/run/ligou-discovery/${"1".repeat(48)}/subscription.sock`,
    });
    const modelAccess = Object.freeze(Object.create(null)) as ModelAccessCapability;
    const recovery8 = Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
    const recovery9 = Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
    const generations = new WeakMap<object, number>([[recovery8 as object, 8], [recovery9 as object, 9]]);
    let releaseClose!: () => void;
    let markCloseStarted!: () => void;
    const closeBlocked = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closeStarted = new Promise<void>((resolve) => { markCloseStarted = resolve; });
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...subscriptionGovernorStubs(now),
        async assertModelAccessCurrent() { return context; },
        async assertSubscriptionRecoveryCurrent(capability) {
          const generation = generations.get(capability as object);
          if (generation === undefined) throw new Error("untrusted recovery capability");
          return {
            job_id: context.job_id,
            attempt_id: context.attempt_id,
            fence_generation: generation,
            subscription_socket_path: context.subscription_socket_path,
            runtime_kind: "openclaw_cell" as const,
            late_result_rejected: true as const,
          };
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(context.deadline_at, "acct-central-owner"),
      listener_manager: {
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        async open() {
          return {
            async close() {
              markCloseStarted();
              await closeBlocked;
              return { listener_closed: true, socket_absent: true };
            },
          };
        },
      },
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x41),
      fetch: async () => { throw new Error("not used"); },
    });
    await gateway.register(modelAccess);
    const first = gateway.recover(recovery8);
    await closeStarted;
    const second = gateway.recover(recovery9);
    releaseClose();
    const [firstReadback, secondReadback] = await Promise.all([first, second]);
    expect(firstReadback.generation).toBe(9);
    expect(secondReadback.generation).toBe(9);
    await expect(gateway.recover(recovery8)).rejects.toThrow("regressed");
  });

  test("keeps absence-only recovery monotonic when an older proof completes last", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const context = centralContext({
      subscription_socket_path: `/run/ligou-discovery/${"0".repeat(48)}/subscription.sock`,
    });
    const recovery8 = Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
    const recovery9 = Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
    const generations = new WeakMap<object, number>([[recovery8 as object, 8], [recovery9 as object, 9]]);
    let absenceCalls = 0;
    let releaseOlder!: () => void;
    let markOlderStarted!: () => void;
    const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const olderStarted = new Promise<void>((resolve) => { markOlderStarted = resolve; });
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...subscriptionGovernorStubs(now),
        async assertModelAccessCurrent() { throw new Error("not used"); },
        async assertSubscriptionRecoveryCurrent(capability) {
          const generation = generations.get(capability as object);
          if (generation === undefined) throw new Error("untrusted recovery capability");
          return {
            job_id: context.job_id,
            attempt_id: context.attempt_id,
            fence_generation: generation,
            subscription_socket_path: context.subscription_socket_path,
            runtime_kind: "openclaw_cell" as const,
            late_result_rejected: true as const,
          };
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(context.deadline_at, "acct-central-owner"),
      listener_manager: {
        async open() { throw new Error("not used"); },
        async proveAbsent() {
          absenceCalls += 1;
          if (absenceCalls === 1) {
            markOlderStarted();
            await olderBlocked;
          }
          return { listener_closed: true, socket_absent: true };
        },
      },
      now: () => now,
      fetch: async () => { throw new Error("not used"); },
    });
    const older = gateway.recover(recovery8);
    await olderStarted;
    expect((await gateway.recover(recovery9)).generation).toBe(9);
    releaseOlder();
    expect((await older).generation).toBe(9);
    await expect(gateway.recover(recovery8)).rejects.toThrow("regressed");
  });

  test("rechecks after an absence proof and revokes only an emerged same-binding registration", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const runRace = async (foreign: boolean) => {
      const recoveryContext = centralContext({
        subscription_socket_path: `/run/ligou-discovery/${(foreign ? "8" : "7").repeat(48)}/subscription.sock`,
      });
      const registrationContext = foreign
        ? centralContext({
            job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            subscription_socket_path: recoveryContext.subscription_socket_path,
            runtime_identity_hash: "3".repeat(64),
          })
        : recoveryContext;
      const modelAccess = Object.freeze(Object.create(null)) as ModelAccessCapability;
      const recovery = Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
      let releaseAbsence!: () => void;
      let markAbsenceStarted!: () => void;
      const absenceBlocked = new Promise<void>((resolve) => { releaseAbsence = resolve; });
      const absenceStarted = new Promise<void>((resolve) => { markAbsenceStarted = resolve; });
      let closeCalls = 0;
      const gateway = new CentralSubscriptionGateway({
        model_access_authority: {
          ...subscriptionGovernorStubs(now),
          async assertModelAccessCurrent() { return registrationContext; },
          async assertSubscriptionRecoveryCurrent() {
            return {
              job_id: recoveryContext.job_id,
              attempt_id: recoveryContext.attempt_id,
              fence_generation: 8,
              subscription_socket_path: recoveryContext.subscription_socket_path,
              runtime_kind: "openclaw_cell" as const,
              late_result_rejected: true as const,
            };
          },
        },
        credential_owner: {
          credential_owner_id: recoveryContext.credential_owner_id,
          credential_generation: recoveryContext.credential_generation,
          account_id_sha256: recoveryContext.expected_account_hash,
        },
        resolve_codex_grant: async () => syntheticGrant(
          registrationContext.deadline_at,
          "acct-central-owner",
        ),
        listener_manager: {
          async proveAbsent() {
            markAbsenceStarted();
            await absenceBlocked;
            return { listener_closed: true, socket_absent: true };
          },
          async open() {
            return {
              async close() {
                closeCalls += 1;
                return { listener_closed: true, socket_absent: true };
              },
            };
          },
        },
        now: () => now,
        random_bytes: () => Buffer.alloc(24, foreign ? 0x47 : 0x46),
        fetch: async () => { throw new Error("not used"); },
      });
      const recovering = gateway.recover(recovery);
      const recoveryOutcome = recovering.then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      );
      await absenceStarted;
      const registered = await gateway.register(modelAccess);
      releaseAbsence();
      const outcome = await recoveryOutcome;
      if (foreign) {
        expect(outcome.value).toBeUndefined();
        expect(String(outcome.error)).toContain("mismatched emerged lease");
        expect(closeCalls).toBe(0);
        await gateway.revoke(registered.lease);
        expect(closeCalls).toBe(1);
      } else {
        expect(outcome.error).toBeUndefined();
        expect(outcome.value?.generation).toBe(8);
        expect(closeCalls).toBe(1);
        expect(gateway.usage(registered.lease).revoked).toBe(true);
      }
    };
    await runRace(false);
    await runRace(true);
  });

  test("settles a reservation without upstream work when recovery wins the reservation handoff", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const context = centralContext({
      subscription_socket_path: `/run/ligou-discovery/${"2".repeat(48)}/subscription.sock`,
    });
    const modelAccess = Object.freeze(Object.create(null)) as ModelAccessCapability;
    const recovery = Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
    const governor = subscriptionGovernorStubs(now);
    let releaseReservation!: () => void;
    let markReservationStarted!: () => void;
    const reservationBlocked = new Promise<void>((resolve) => { releaseReservation = resolve; });
    const reservationStarted = new Promise<void>((resolve) => { markReservationStarted = resolve; });
    let settlement: SubscriptionRequestSettlement | undefined;
    let upstreamCalls = 0;
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...governor,
        async assertModelAccessCurrent() { return context; },
        async assertSubscriptionRecoveryCurrent() {
          return {
            job_id: context.job_id,
            attempt_id: context.attempt_id,
            fence_generation: 8,
            subscription_socket_path: context.subscription_socket_path,
            runtime_kind: "openclaw_cell" as const,
            late_result_rejected: true as const,
          };
        },
        async reserveSubscriptionRequest(capability, prospective) {
          markReservationStarted();
          await reservationBlocked;
          return governor.reserveSubscriptionRequest(capability, prospective);
        },
        async settleSubscriptionRequest(reservation, value) {
          settlement = value;
          return governor.settleSubscriptionRequest(reservation, value);
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(context.deadline_at, "acct-central-owner"),
      listener_manager: {
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        async open() { return { async close() { return { listener_closed: true, socket_absent: true }; } }; },
      },
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x42),
      fetch: async () => { upstreamCalls += 1; return new Response(completedSse()); },
    });
    const registered = await gateway.register(modelAccess);
    const forwarding = gateway.forward(registered.lease, codexRequest(registered.attempt_marker));
    await reservationStarted;
    expect((await gateway.recover(recovery)).generation).toBe(8);
    releaseReservation();
    await expect(forwarding).rejects.toThrow("revoked after reservation");
    expect(upstreamCalls).toBe(0);
    expect(settlement).toEqual({
      input_bytes: 0,
      output_bytes: 0,
      observed_input_tokens: 0,
      observed_output_tokens: 0,
      usage_complete: true,
      quota_state: "available",
      retry_after_seconds: null,
    });
  });

  test("accepts an idempotent cooldown settlement whose durable window is already available", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const context = centralContext({
      subscription_socket_path: `/run/ligou-discovery/${"e".repeat(48)}/subscription.sock`,
    });
    const modelAccess = Object.freeze(Object.create(null)) as ModelAccessCapability;
    const governor = subscriptionGovernorStubs(now);
    let observedSettlement: SubscriptionRequestSettlement | undefined;
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...governor,
        async assertModelAccessCurrent() { return context; },
        async assertSubscriptionRecoveryCurrent() { throw new Error("not used"); },
        async settleSubscriptionRequest(reservation, settlement) {
          expect(settlement.quota_state).toBe("cooldown");
          observedSettlement = settlement;
          const readback = await governor.settleSubscriptionRequest(reservation, settlement);
          return { ...readback, quota_state: "available" as const, cooldown_until: null };
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(context.deadline_at, "acct-central-owner"),
      listener_manager: {
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        async open() { return { async close() { return { listener_closed: true, socket_absent: true }; } }; },
      },
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x45),
      fetch: async () => new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "17" },
      }),
    });
    const registered = await gateway.register(modelAccess);
    const response = await gateway.forward(
      registered.lease,
      codexRequest(registered.attempt_marker),
    );
    expect(response.status).toBe(429);
    expect(observedSettlement).toMatchObject({
      observed_input_tokens: 0,
      observed_output_tokens: 0,
      usage_complete: true,
      quota_state: "cooldown",
      retry_after_seconds: 17,
    });
    expect(gateway.usage(registered.lease)).toMatchObject({
      usage_complete: true,
      quota_state: "available",
      retry_after_seconds: null,
      cooldown_until: null,
    });
  });

  test("revalidates after grant resolution and a recovery tombstone blocks stale registration", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const context = centralContext({
      subscription_socket_path: `/run/ligou-discovery/${"3".repeat(48)}/subscription.sock`,
    });
    const modelAccess = Object.freeze(Object.create(null)) as ModelAccessCapability;
    const recovery = Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
    let accessReads = 0;
    let openCalls = 0;
    let releaseGrant!: () => void;
    let markGrantStarted!: () => void;
    const grantBlocked = new Promise<void>((resolve) => { releaseGrant = resolve; });
    const grantStarted = new Promise<void>((resolve) => { markGrantStarted = resolve; });
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...subscriptionGovernorStubs(now),
        async assertModelAccessCurrent() { accessReads += 1; return context; },
        async assertSubscriptionRecoveryCurrent() {
          return {
            job_id: context.job_id,
            attempt_id: context.attempt_id,
            fence_generation: 8,
            subscription_socket_path: context.subscription_socket_path,
            runtime_kind: "openclaw_cell" as const,
            late_result_rejected: true as const,
          };
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => {
        markGrantStarted();
        await grantBlocked;
        return syntheticGrant(context.deadline_at, "acct-central-owner");
      },
      listener_manager: {
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        async open() {
          openCalls += 1;
          return { async close() { return { listener_closed: true, socket_absent: true }; } };
        },
      },
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x43),
      fetch: async () => { throw new Error("not used"); },
    });
    const registering = gateway.register(modelAccess);
    await grantStarted;
    expect((await gateway.recover(recovery)).generation).toBe(8);
    releaseGrant();
    await expect(registering).rejects.toThrow("already recovered");
    expect(accessReads).toBe(2);
    expect(openCalls).toBe(0);
  });

  test("closes a newly opened listener when recovery wins while listener open is pending", async () => {
    const now = Date.parse("2099-09-01T10:00:00.000Z");
    const context = centralContext({
      subscription_socket_path: `/run/ligou-discovery/${"6".repeat(48)}/subscription.sock`,
    });
    const modelAccess = Object.freeze(Object.create(null)) as ModelAccessCapability;
    const recovery = Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
    let releaseOpen!: () => void;
    let markOpenStarted!: () => void;
    const openBlocked = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const openStarted = new Promise<void>((resolve) => { markOpenStarted = resolve; });
    let closeCalls = 0;
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: {
        ...subscriptionGovernorStubs(now),
        async assertModelAccessCurrent() { return context; },
        async assertSubscriptionRecoveryCurrent() {
          return {
            job_id: context.job_id,
            attempt_id: context.attempt_id,
            fence_generation: 8,
            subscription_socket_path: context.subscription_socket_path,
            runtime_kind: "openclaw_cell" as const,
            late_result_rejected: true as const,
          };
        },
      },
      credential_owner: {
        credential_owner_id: context.credential_owner_id,
        credential_generation: context.credential_generation,
        account_id_sha256: context.expected_account_hash,
      },
      resolve_codex_grant: async () => syntheticGrant(context.deadline_at, "acct-central-owner"),
      listener_manager: {
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        async open() {
          markOpenStarted();
          await openBlocked;
          return {
            async close() {
              closeCalls += 1;
              return { listener_closed: true, socket_absent: true };
            },
          };
        },
      },
      now: () => now,
      random_bytes: () => Buffer.alloc(24, 0x44),
      fetch: async () => { throw new Error("not used"); },
    });
    const registering = gateway.register(modelAccess);
    const registrationOutcome = registering.then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    );
    await openStarted;
    let recoverySettled = false;
    const recovering = gateway.recover(recovery).finally(() => { recoverySettled = true; });
    await Promise.resolve();
    expect(recoverySettled).toBe(false);
    releaseOpen();
    expect((await recovering).generation).toBe(8);
    const outcome = await registrationOutcome;
    expect(outcome.value).toBeUndefined();
    expect(String(outcome.error)).toContain("revoked while listener opened");
    expect(closeCalls).toBe(1);
  });
});
