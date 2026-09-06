import type {
  DiscoveryBudget,
  DiscoverySourceSnapshot,
  SubscriptionRevocationReadback,
} from "../contracts";
import {
  OPENCLAW_CELL_IMAGE,
  selectedImageReference,
  type RuntimeImageEvidence,
  type RuntimeIdentity,
  type OpenClawRuntimeIdentityBinding,
} from "./runtime-identity";

const MCP_TOOL_NAMES = [
  "discovery__fetch_discovery_page",
  "discovery__submit_discovery_result",
] as const;
const MCP_TOOL_POLICY = ["bundle-mcp", ...MCP_TOOL_NAMES] as const;
const CELL_GATEWAY_RELAY_PORT = 4_313;
const CELL_GATEWAY_RELAY_SCRIPT = String.raw`
const net = require("node:net");
const listenPort = Number(process.argv[1]);
const targetPort = Number(process.argv[2]);
if (!Number.isSafeInteger(listenPort) || !Number.isSafeInteger(targetPort)) process.exit(64);
const pairs = new Set();
const server = net.createServer((downstream) => {
  if (pairs.size >= 8) { downstream.destroy(); return; }
  downstream.pause();
  const upstream = net.connect({ host: "127.0.0.1", port: targetPort });
  const pair = { downstream, upstream };
  pairs.add(pair);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    pairs.delete(pair);
    downstream.destroy();
    upstream.destroy();
  };
  for (const socket of [downstream, upstream]) {
    socket.setTimeout(610000, close);
    socket.once("error", close);
    socket.once("close", close);
  }
  upstream.once("connect", () => {
    if (closed) return;
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.resume();
  });
});
server.maxConnections=8;
server.on("error", () => process.exit(1));
server.listen(listenPort, "0.0.0.0");
const stop = () => {
  for (const pair of pairs) { pair.downstream.destroy(); pair.upstream.destroy(); }
  server.close(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
`;

export const BRIDGE_SUBSCRIPTION_SOCKET_PATH =
  "/run/ligou-subscription/subscription.sock" as const;

const DENIED_TOOLS = [
  "group:openclaw",
  "group:runtime",
  "group:fs",
  "group:web",
  "group:ui",
  "group:automation",
  "group:messaging",
  "group:nodes",
  "group:sessions",
  "group:memory",
  "group:agents",
  "group:media",
  "exec",
  "process",
  "code_execution",
  "browser",
  "screen",
  "dashboard",
  "terminal",
  "portal",
  "canvas",
  "read",
  "write",
  "edit",
  "apply_patch",
  "gateway",
  "nodes",
  "computer",
  "cron",
  "message",
  "web_search",
  "x_search",
  "web_fetch",
  "sessions",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "memory_search",
  "memory_get",
  "elevated",
] as const;

export interface OpenClawConfigInput {
  readonly identity: RuntimeIdentity;
  readonly proxy_marker: string;
  readonly upstream_model: string;
}

export interface OpenClawConfig {
  readonly gateway: Record<string, unknown>;
  readonly secrets: Record<string, unknown>;
  readonly agents: {
    readonly defaults: Record<string, any>;
    readonly entries: Record<string, unknown>;
  };
  readonly models: {
    readonly mode: "replace";
    readonly catalogRefresh: { readonly enabled: false };
    readonly providers: Record<string, any>;
  };
  readonly mcp: Record<string, any>;
  readonly tools: Record<string, any>;
  readonly update: Record<string, unknown>;
  readonly telemetry: Record<string, unknown>;
  readonly cron: Record<string, unknown>;
  readonly acp: Record<string, unknown>;
  readonly skills: Record<string, unknown>;
}

function nonEmpty(value: string, name: string, maximum = 512): string {
  if (value.trim() === "" || value.length > maximum) {
    throw new Error(`${name} must be a bounded non-empty string`);
  }
  return value;
}

export function buildOpenClawConfig(input: OpenClawConfigInput): OpenClawConfig {
  const marker = nonEmpty(input.proxy_marker, "proxy marker");
  const model = nonEmpty(input.upstream_model, "upstream model", 200);
  const identity = input.identity;
  const modelRef = `stage0_bridge/${model}`;
  return Object.freeze({
    gateway: Object.freeze({
      mode: "local",
      port: identity.gateway_port,
      bind: "loopback",
      auth: Object.freeze({
        mode: "token",
        token: Object.freeze({ source: "file", provider: "attempt_gateway", id: "/gateway_token" }),
      }),
      reload: Object.freeze({ mode: "off" }),
      controlUi: Object.freeze({
        enabled: false,
        allowedOrigins: Object.freeze([
          `http://127.0.0.1:${identity.host_gateway_port}`,
          `http://localhost:${identity.host_gateway_port}`,
        ]),
      }),
      terminal: Object.freeze({ enabled: false }),
      nodes: Object.freeze({
        allowSkills: false,
        pluginTools: Object.freeze({ enabled: false }),
        commands: Object.freeze({ allow: Object.freeze([]), deny: Object.freeze(["*"]) }),
      }),
    }),
    secrets: Object.freeze({
      providers: Object.freeze({
        attempt_gateway: Object.freeze({
          source: "file",
          path: `${identity.gateway_secret_path}/secret.json`,
          mode: "json",
        }),
      }),
    }),
    agents: Object.freeze({
      defaults: Object.freeze({
        workspace: identity.workspace_path,
        model: Object.freeze({ primary: modelRef, fallbacks: Object.freeze([]) }),
        models: Object.freeze({
          [modelRef]: Object.freeze({
            alias: "Stage 0 bounded discovery",
            params: Object.freeze({ transport: "sse", cacheRetention: "none", maxRetries: 0 }),
          }),
        }),
        sandbox: Object.freeze({
          mode: "off",
          workspaceAccess: "none",
          browser: Object.freeze({ enabled: false, allowHostControl: false }),
        }),
      }),
      entries: Object.freeze({
        discovery: Object.freeze({
          workspace: identity.workspace_path,
          model: Object.freeze({ primary: modelRef, fallbacks: Object.freeze([]) }),
          tools: Object.freeze({
            profile: "coding",
            allow: Object.freeze([...MCP_TOOL_POLICY]),
            deny: Object.freeze([...DENIED_TOOLS]),
            elevated: Object.freeze({ enabled: false }),
          }),
        }),
      }),
    }),
    models: Object.freeze({
      mode: "replace",
      catalogRefresh: Object.freeze({ enabled: false }),
      providers: Object.freeze({
        stage0_bridge: Object.freeze({
          baseUrl: `http://bridge:${identity.bridge_http_port}/codex`,
          apiKey: marker,
          api: "openai-chatgpt-responses",
          models: Object.freeze([Object.freeze({
            id: model,
            name: "Stage 0 bounded discovery",
            reasoning: true,
            input: Object.freeze(["text"]),
            cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
            contextWindow: 272_000,
            maxTokens: 8_192,
            compat: Object.freeze({
              supportsTools: true,
              supportsStrictMode: true,
              supportsInstructions: true,
            }),
          })]),
        }),
      }),
    }),
    mcp: Object.freeze({
      servers: Object.freeze({
        discovery: Object.freeze({
          url: `http://bridge:${identity.bridge_http_port}/mcp`,
          transport: "streamable-http",
          requestTimeoutMs: 30_000,
          connectionTimeoutMs: 5_000,
          supportsParallelToolCalls: false,
          headers: Object.freeze({ Authorization: `Bearer ${marker}` }),
          toolFilter: Object.freeze({
            include: Object.freeze(["fetch_discovery_page", "submit_discovery_result"]),
            exclude: Object.freeze(["resources_*", "prompts_*"]),
          }),
        }),
      }),
    }),
    tools: Object.freeze({
      profile: "coding",
      allow: Object.freeze([...MCP_TOOL_POLICY]),
      deny: Object.freeze([...DENIED_TOOLS]),
      codeMode: Object.freeze({ enabled: false }),
      elevated: Object.freeze({ enabled: false }),
      exec: Object.freeze({ security: "deny", ask: "always" }),
      fs: Object.freeze({ workspaceOnly: true }),
    }),
    skills: Object.freeze({ allowBundled: Object.freeze([]), entries: Object.freeze({}) }),
    update: Object.freeze({ checkOnStart: false, auto: Object.freeze({ enabled: false }) }),
    telemetry: Object.freeze({ enabled: false }),
    cron: Object.freeze({ enabled: false, triggers: Object.freeze({ enabled: false }), sessionRetention: false }),
    acp: Object.freeze({ enabled: false, dispatch: Object.freeze({ enabled: false }) }),
  });
}

export interface BridgeSecret {
  readonly upstream_model: string;
  readonly proxy_marker: string;
  readonly subscription_socket_path: string;
  readonly normalized_origin: string;
  readonly deadline_at: string;
  readonly budget: DiscoveryBudget;
  readonly source_snapshots: readonly DiscoverySourceSnapshot[];
}

export interface CellLifecyclePlanInput {
  readonly identity: RuntimeIdentity;
  readonly config: OpenClawConfig;
  readonly gateway_token: string;
  readonly bridge_secret: BridgeSecret;
}

export interface CommandSpec {
  readonly label: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly sensitive_stdin?: boolean;
  readonly sensitive_stdout?: boolean;
  readonly image_expectation?: RuntimeImageEvidence;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: CommandSpec, signal?: AbortSignal): Promise<CommandResult>;
}

function command(label: string, argv: readonly string[], options: {
  readonly stdin?: string;
  readonly sensitive_stdin?: boolean;
  readonly sensitive_stdout?: boolean;
  readonly image_expectation?: RuntimeImageEvidence;
} = {}): CommandSpec {
  return Object.freeze({ label, argv: Object.freeze([...argv]), env: Object.freeze({}), ...options });
}

function validateImageReadback(result: CommandResult, expected: RuntimeImageEvidence): void {
  let decoded: unknown;
  try { decoded = JSON.parse(result.stdout); }
  catch { throw new Error("runtime image evidence readback is invalid"); }
  if (!Array.isArray(decoded) || decoded.length !== 1 || decoded[0] === null ||
      typeof decoded[0] !== "object" || Array.isArray(decoded[0])) {
    throw new Error("runtime image evidence readback is invalid");
  }
  const image = decoded[0] as Record<string, unknown>;
  const architecture = expected.platform.slice("linux/".length);
  if (expected.image_id !== expected.config_digest || image.Id !== expected.image_id ||
      image.Os !== "linux" || image.Architecture !== architecture) {
    throw new Error("runtime image evidence mismatched local image");
  }
}

function assertDigestImage(image: string, name: string): void {
  if (!/^[-./a-z0-9]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(`${name} must use an exact sha256 digest`);
  }
}

function volumeWriter(
  label: string,
  keeperContainer: string,
  targetDirectory: string,
  filename: string,
  contents: string,
  sensitive: boolean,
): CommandSpec {
  return command(label, [
    "docker", "exec", "-i", "--user", "1000:1000", keeperContainer,
    "/bin/sh", "-c",
    'set -eu; target="$1/$2"; test "$(stat -c %u:%g:%a "$1")" = 1000:1000:700; umask 077; cat > "$target"; chmod 0600 "$target"; test "$(stat -c %u:%g:%a "$target")" = 1000:1000:600',
    "write-volume", targetDirectory, filename,
  ], { stdin: contents, sensitive_stdin: sensitive });
}

function volumePreparer(
  label: string,
  keeperContainer: string,
  targetDirectory: string,
): CommandSpec {
  return command(label, [
    "docker", "exec", "--user", "1000:1000", keeperContainer,
    "/bin/sh", "-c", 'set -eu; test "$(stat -c %u:%g:%a "$1")" = 1000:1000:700',
    "prepare-volume", targetDirectory,
  ]);
}

export function volumeKeeperContainerName(cellContainerName: string): string {
  const match = /^ligou-oc-cell-([0-9a-f]{16})$/.exec(cellContainerName);
  if (match === null) throw new Error("volume keeper cell identity is invalid");
  return `ligou-oc-volume-keeper-${match[1]}`;
}

export function buildCellLifecyclePlan(input: CellLifecyclePlanInput): readonly CommandSpec[] {
  assertDigestImage(OPENCLAW_CELL_IMAGE, "OpenClaw cell image");
  nonEmpty(input.gateway_token, "Gateway token");
  if (input.bridge_secret.subscription_socket_path !== BRIDGE_SUBSCRIPTION_SOCKET_PATH) {
    throw new Error("bridge subscription socket path must be fixed");
  }
  const id = input.identity;
  const cellImage = selectedImageReference(id.image_evidence.cell_image);
  const bridgeImage = selectedImageReference(id.image_evidence.bridge_image);
  const volumeKeeper = volumeKeeperContainerName(id.cell_container_name);
  assertDigestImage(cellImage, "selected OpenClaw cell image");
  assertDigestImage(bridgeImage, "selected trusted bridge image");
  const plan: CommandSpec[] = [
    command("verify-cell-image", ["docker", "image", "inspect", cellImage], {
      image_expectation: id.image_evidence.cell_image,
    }),
    command("verify-bridge-image", ["docker", "image", "inspect", bridgeImage], {
      image_expectation: id.image_evidence.bridge_image,
    }),
    command("create-internal-network", ["docker", "network", "create", "--internal", id.internal_network_name]),
    command("create-egress-network", ["docker", "network", "create", id.egress_network_name]),
  ];
  const volumeSizes = Object.freeze({
    config: 1_048_576,
    state: 134_217_728,
    workspace: 33_554_432,
    output: 16_777_216,
    gateway_secret: 1_048_576,
    bridge_secret: 16_777_216,
  });
  for (const [key, volume] of Object.entries(id.volume_names) as Array<
    [keyof typeof id.volume_names, string]
  >) {
    plan.push(command(`create-${key.replaceAll("_", "-")}-volume`, [
      "docker", "volume", "create",
      "--driver", "local",
      "--opt", "type=tmpfs",
      "--opt", "device=tmpfs",
      "--opt", `o=size=${volumeSizes[key]},uid=1000,gid=1000,mode=0700`,
      volume,
    ]));
  }
  plan.push(command("start-volume-keeper", [
    "docker", "run", "--detach",
    "--platform", id.image_evidence.bridge_image.platform, "--pull=never",
    "--name", volumeKeeper, "--network", "none",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=32", "--memory=33554432", "--cpus=0.25",
    "--user", "1000:1000",
    ...Object.entries(id.volume_names).flatMap(([key, volume]) => [
      "--mount", `type=volume,src=${volume},dst=/volumes/${key}`,
    ]),
    "--entrypoint", "/bin/sh", bridgeImage,
    "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600; done",
  ]));
  plan.push(volumePreparer("prepare-state-volume", volumeKeeper, "/volumes/state"));
  plan.push(volumePreparer("prepare-workspace-volume", volumeKeeper, "/volumes/workspace"));
  plan.push(volumePreparer("prepare-output-volume", volumeKeeper, "/volumes/output"));
  plan.push(volumeWriter(
    "write-openclaw-config",
    volumeKeeper,
    "/volumes/config",
    "openclaw.json",
    JSON.stringify(input.config),
    true,
  ));
  plan.push(volumeWriter(
    "write-gateway-secret",
    volumeKeeper,
    "/volumes/gateway_secret",
    "secret.json",
    JSON.stringify({ gateway_token: input.gateway_token }),
    true,
  ));
  plan.push(volumeWriter(
    "write-bridge-secret",
    volumeKeeper,
    "/volumes/bridge_secret",
    "secret.json",
    JSON.stringify(input.bridge_secret),
    true,
  ));
  plan.push(command("start-cell", [
    "docker", "run", "--detach",
    "--platform", id.image_evidence.cell_image.platform,
    "--pull=never",
    "--name", id.cell_container_name,
    "--hostname", "cell",
    "--network", id.internal_network_name,
    "--network-alias", "cell",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--no-healthcheck",
    "--pids-limit=256", "--memory=1073741824", "--cpus=1",
    "--ulimit", "fsize=16777216:16777216",
    "--log-driver=local", "--log-opt=max-size=10m", "--log-opt=max-file=2",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=134217728",
    "--tmpfs", "/var/tmp:rw,noexec,nosuid,nodev,size=67108864",
    "--tmpfs", "/run:rw,noexec,nosuid,nodev,size=16777216",
    "--mount", `type=volume,src=${id.volume_names.config},dst=${id.config_path},readonly`,
    "--mount", `type=volume,src=${id.volume_names.state},dst=${id.state_path}`,
    "--mount", `type=volume,src=${id.volume_names.workspace},dst=${id.workspace_path}`,
    "--mount", `type=volume,src=${id.volume_names.gateway_secret},dst=${id.gateway_secret_path},readonly`,
    "--env", `OPENCLAW_CONFIG_PATH=${id.config_path}/openclaw.json`,
    "--env", `OPENCLAW_STATE_DIR=${id.state_path}`,
    "--env", `OPENCLAW_NO_AUTO_UPDATE=1`,
    "--env", "XDG_CACHE_HOME=/tmp/openclaw-cache",
    "--env", "TMPDIR=/tmp",
    cellImage,
    "node", "/app/openclaw.mjs",
    "--profile", id.profile_name,
    "gateway", "run", "--port", String(id.gateway_port),
  ]));
  plan.push(command("start-cell-loopback-relay", [
    "docker", "exec", "--detach", "--user", "1000:1000",
    id.cell_container_name,
    "node", "-e", CELL_GATEWAY_RELAY_SCRIPT,
    String(CELL_GATEWAY_RELAY_PORT), String(id.gateway_port),
  ]));
  plan.push(command("start-bridge", [
    "docker", "run", "--detach",
    "--platform", id.image_evidence.bridge_image.platform,
    "--pull=never",
    "--name", id.bridge_container_name,
    "--hostname", "bridge",
    "--network", id.egress_network_name,
    "--network-alias", "bridge",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=128", "--memory=268435456", "--cpus=0.5",
    "--ulimit", "fsize=16777216:16777216",
    "--log-driver=local", "--log-opt=max-size=10m", "--log-opt=max-file=2",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864",
    "--mount", `type=volume,src=${id.volume_names.bridge_secret},dst=${id.bridge_secret_path},readonly`,
    "--mount", `type=volume,src=${id.volume_names.output},dst=${id.output_path}`,
    "--mount", `type=bind,src=${id.subscription_socket_path.slice(0, id.subscription_socket_path.lastIndexOf("/"))},dst=/run/ligou-subscription,readonly`,
    "--env", `BRIDGE_SECRET_PATH=${id.bridge_secret_path}/secret.json`,
    "--env", `BRIDGE_OUTPUT_PATH=${id.output_path}/result.json`,
    "--env", `BRIDGE_HTTP_PORT=${id.bridge_http_port}`,
    "--env", `BRIDGE_RELAY_PORT=${id.bridge_relay_port}`,
    "--env", "OPENCLAW_CELL_HOST=cell",
    "--env", `OPENCLAW_CELL_GATEWAY_PORT=${CELL_GATEWAY_RELAY_PORT}`,
    "-p", `127.0.0.1:${id.host_gateway_port}:${id.bridge_relay_port}`,
    bridgeImage,
  ]));
  plan.push(command("connect-bridge-internal", [
    "docker", "network", "connect", "--alias", "bridge",
    id.internal_network_name, id.bridge_container_name,
  ]));
  plan.push(command("stop-volume-keeper", [
    "docker", "stop", "--time", "2", volumeKeeper,
  ]));
  plan.push(command("remove-volume-keeper", [
    "docker", "rm", "--force", volumeKeeper,
  ]));
  return Object.freeze(plan);
}

export interface CellRuntimeHandle {
  readonly identity: RuntimeIdentity;
}

export interface RuntimeCleanupTarget {
  readonly cell_container_name: string;
  readonly bridge_container_name: string;
  readonly internal_network_name: string;
  readonly egress_network_name: string;
  readonly volume_names: {
    readonly config: string;
    readonly state: string;
    readonly workspace: string;
    readonly output: string;
    readonly gateway_secret: string;
    readonly bridge_secret: string;
  };
  readonly host_gateway_port: number;
  readonly image_evidence: RuntimeIdentity["image_evidence"];
}

export interface RuntimeDiskUsage {
  readonly state_bytes: number;
  readonly workspace_bytes: number;
  readonly output_bytes: number;
}

export interface LocalOpenClawCleanupProof {
  readonly gateway_exited: boolean;
  readonly cell_removed: boolean;
  readonly bridge_removed: boolean;
  readonly config_removed: boolean;
  readonly state_removed: boolean;
  readonly workspace_removed: boolean;
  readonly output_removed: boolean;
  readonly network_removed: boolean;
  readonly credential_material_removed: boolean;
  readonly listener_closed: boolean;
  readonly no_identity_process: boolean;
}

/** @deprecated Use LocalOpenClawCleanupProof. */
export type RuntimeCleanupProof = LocalOpenClawCleanupProof;

export interface DetailedCleanupProof {
  readonly gateway_exited: boolean;
  readonly container_removed: boolean;
  readonly bridge_removed: boolean;
  readonly config_removed: boolean;
  readonly state_removed: boolean;
  readonly workspace_removed: boolean;
  readonly output_removed: boolean;
  readonly network_removed: boolean;
  readonly credential_material_removed: boolean;
  readonly subscription_lease_revoked: boolean;
  readonly subscription_requests_drained: boolean;
  readonly subscription_listener_closed: boolean;
  readonly subscription_socket_absent: boolean;
  readonly listener_closed: boolean;
  readonly identity_process_absent: boolean;
  readonly late_result_rejected: boolean;
}

export interface CellRuntimeDependencies {
  readonly command_runner: CommandRunner;
  readonly listener_closed: (identity: RuntimeCleanupTarget) => Promise<boolean>;
  readonly identity_process_absent: (identity: RuntimeCleanupTarget) => Promise<boolean>;
  readonly cleanup_command_timeout_ms?: number;
}

async function runBounded(
  runner: CommandRunner,
  spec: CommandSpec,
  timeoutMs: number,
): Promise<CommandResult | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const running = runner.run(spec, controller.signal);
    running.catch(() => undefined);
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    return await Promise.race([running, timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type DockerResourceKind = "container" | "volume" | "network";

function provesAbsent(result: CommandResult | null, kind: DockerResourceKind): boolean {
  if (result === null || result.exitCode !== 1 ||
      (result.stdout.trim() !== "" && result.stdout.trim() !== "[]")) return false;
  const stderr = result.stderr.trim();
  if (kind === "container") return /(?:no such object|no such container)/iu.test(stderr);
  if (kind === "volume") return /no such volume/iu.test(stderr);
  return /(?:no such network|network(?:\s+[^\s]+)?\s+not found)/iu.test(stderr);
}

async function removeAndProveAbsent(
  runner: CommandRunner,
  timeoutMs: number,
  removeLabel: string,
  removeArgv: readonly string[],
  inspectLabel: string,
  inspectArgv: readonly string[],
  kind: DockerResourceKind,
): Promise<boolean> {
  await runBounded(runner, command(removeLabel, removeArgv), timeoutMs);
  return provesAbsent(await runBounded(runner, command(inspectLabel, inspectArgv), timeoutMs), kind);
}

export class CellRuntime {
  readonly #cleanupCommandTimeoutMs: number;

  constructor(private readonly dependencies: CellRuntimeDependencies) {
    this.#cleanupCommandTimeoutMs = dependencies.cleanup_command_timeout_ms ?? 5_000;
    if (!Number.isSafeInteger(this.#cleanupCommandTimeoutMs) ||
        this.#cleanupCommandTimeoutMs < 1 || this.#cleanupCommandTimeoutMs > 30_000) {
      throw new Error("cleanup command timeout is invalid");
    }
  }

  async start(plan: readonly CommandSpec[], signal?: AbortSignal): Promise<void> {
    for (const step of plan) {
      if (signal?.aborted) throw new Error("OpenClaw cell startup cancelled");
      const result = await this.dependencies.command_runner.run(step, signal);
      if (result.exitCode !== 0) {
        throw new Error(`${step.label} failed: ${result.stderr || `exit ${result.exitCode}`}`);
      }
      if (step.image_expectation !== undefined) {
        validateImageReadback(result, step.image_expectation);
      }
    }
  }

  async readSubmittedResult(handle: CellRuntimeHandle): Promise<unknown> {
    const id = handle.identity;
    const helperImage = selectedImageReference(id.image_evidence.bridge_image);
    const result = await this.dependencies.command_runner.run(command("read-submitted-result", [
      "docker", "run", "--rm", "--network", "none",
      "--platform", id.image_evidence.bridge_image.platform, "--pull=never",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--pids-limit=32", "--memory=67108864", "--cpus=0.25",
      "--mount", `type=volume,src=${id.volume_names.output},dst=${id.output_path},readonly`,
      "--entrypoint", "/bin/sh", helperImage,
      "-c", 'cat "$1"', "read-result", `${id.output_path}/result.json`,
    ]));
    if (result.exitCode !== 0) {
      throw new Error(`read-submitted-result failed: ${result.stderr || `exit ${result.exitCode}`}`);
    }
    if (Buffer.byteLength(result.stdout, "utf8") < 2 ||
        Buffer.byteLength(result.stdout, "utf8") > 10_485_760) {
      throw new Error("submitted result is missing or exceeds byte limit");
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error("submitted result is not valid JSON");
    }
  }

  async observeDiskUsage(handle: CellRuntimeHandle): Promise<RuntimeDiskUsage> {
    const id = handle.identity;
    const helperImage = selectedImageReference(id.image_evidence.bridge_image);
    const result = await runBounded(this.dependencies.command_runner, command(
      "observe-runtime-disk-usage",
      [
        "docker", "run", "--rm", "--network", "none",
        "--platform", id.image_evidence.bridge_image.platform, "--pull=never",
        "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--pids-limit=32", "--memory=67108864", "--cpus=0.25",
        "--mount", `type=volume,src=${id.volume_names.state},dst=${id.state_path},readonly`,
        "--mount", `type=volume,src=${id.volume_names.workspace},dst=${id.workspace_path},readonly`,
        "--mount", `type=volume,src=${id.volume_names.output},dst=${id.output_path},readonly`,
        "--entrypoint", "/bin/sh", helperImage,
        "-c", 'du -sk "$1" "$2" "$3"', "observe-disk",
        id.state_path, id.workspace_path, id.output_path,
      ],
    ), this.#cleanupCommandTimeoutMs);
    if (result === null || result.exitCode !== 0 || result.stderr.trim() !== "") {
      throw new Error("runtime disk usage observation is ambiguous");
    }
    const values = result.stdout.trim().split(/\r?\n/u).map((line) => {
      const match = /^([0-9]+)\s+/u.exec(line);
      if (match === null) throw new Error("runtime disk usage observation is invalid");
      const kibibytes = Number(match[1]);
      if (!Number.isSafeInteger(kibibytes)) throw new Error("runtime disk usage observation is invalid");
      return kibibytes * 1_024;
    });
    if (values.length !== 3 || values[0]! > 134_217_728 ||
        values[1]! > 33_554_432 || values[2]! > 16_777_216) {
      throw new Error("runtime disk usage exceeds the bounded volume ceiling");
    }
    return Object.freeze({
      state_bytes: values[0]!,
      workspace_bytes: values[1]!,
      output_bytes: values[2]!,
    });
  }

  async cleanup(
    handle: CellRuntimeHandle,
  ): Promise<RuntimeCleanupProof> {
    return this.#cleanupTarget(handle.identity);
  }

  async cleanupBoundRuntime(
    binding: OpenClawRuntimeIdentityBinding,
  ): Promise<RuntimeCleanupProof> {
    if (binding.runtime_kind !== "openclaw_cell") {
      throw new Error("OpenClaw cell runtime binding required");
    }
    return this.#cleanupTarget({
      cell_container_name: binding.cell_container_name,
      bridge_container_name: binding.bridge_container_name,
      internal_network_name: binding.internal_network_name,
      egress_network_name: binding.egress_network_name,
      volume_names: {
        config: binding.config_volume_name,
        state: binding.state_volume_name,
        workspace: binding.workspace_volume_name,
        output: binding.output_volume_name,
        gateway_secret: binding.gateway_secret_volume_name,
        bridge_secret: binding.bridge_secret_volume_name,
      },
      host_gateway_port: binding.loopback_port,
      image_evidence: {
        cell_image: binding.cell_image,
        bridge_image: binding.bridge_image,
      },
    });
  }

  async #cleanupTarget(
    id: RuntimeCleanupTarget,
  ): Promise<RuntimeCleanupProof> {
    const bridgeRemoved = await removeAndProveAbsent(
      this.dependencies.command_runner, this.#cleanupCommandTimeoutMs,
      "remove-bridge", ["docker", "rm", "--force", id.bridge_container_name],
      "inspect-bridge-absence", ["docker", "container", "inspect", id.bridge_container_name],
      "container",
    );
    await runBounded(this.dependencies.command_runner, command("stop-cell", [
      "docker", "stop", "--time", "10", id.cell_container_name,
    ]), this.#cleanupCommandTimeoutMs);
    const cellRemoved = await removeAndProveAbsent(
      this.dependencies.command_runner, this.#cleanupCommandTimeoutMs,
      "remove-cell", ["docker", "rm", "--force", id.cell_container_name],
      "inspect-cell-absence", ["docker", "container", "inspect", id.cell_container_name],
      "container",
    );
    const volumeKeeper = volumeKeeperContainerName(id.cell_container_name);
    const keeperRemoved = await removeAndProveAbsent(
      this.dependencies.command_runner, this.#cleanupCommandTimeoutMs,
      "remove-volume-keeper", ["docker", "rm", "--force", volumeKeeper],
      "inspect-volume-keeper-absence", ["docker", "container", "inspect", volumeKeeper],
      "container",
    );
    const removeVolume = (label: string, volume: string) => removeAndProveAbsent(
      this.dependencies.command_runner, this.#cleanupCommandTimeoutMs,
      `remove-${label}-volume`, ["docker", "volume", "rm", volume],
      `inspect-${label}-volume-absence`, ["docker", "volume", "inspect", volume],
      "volume",
    );
    const configRemoved = await removeVolume("config", id.volume_names.config);
    const stateRemoved = await removeVolume("state", id.volume_names.state);
    const workspaceRemoved = await removeVolume("workspace", id.volume_names.workspace);
    const outputRemoved = await removeVolume("output", id.volume_names.output);
    const gatewaySecretRemoved = await removeVolume("gateway-secret", id.volume_names.gateway_secret);
    const bridgeSecretRemoved = await removeVolume("bridge-secret", id.volume_names.bridge_secret);
    const removeNetwork = (label: string, network: string) => removeAndProveAbsent(
      this.dependencies.command_runner, this.#cleanupCommandTimeoutMs,
      `remove-${label}-network`, ["docker", "network", "rm", network],
      `inspect-${label}-network-absence`, ["docker", "network", "inspect", network],
      "network",
    );
    const internalNetworkRemoved = await removeNetwork("internal", id.internal_network_name);
    const egressNetworkRemoved = await removeNetwork("egress", id.egress_network_name);
    let listenerClosed = false;
    let noIdentityProcess = false;
    try {
      listenerClosed = await this.dependencies.listener_closed(id);
    } catch {
      listenerClosed = false;
    }
    try {
      noIdentityProcess = await this.dependencies.identity_process_absent(id);
    } catch {
      noIdentityProcess = false;
    }
    return Object.freeze({
      gateway_exited: cellRemoved && keeperRemoved,
      cell_removed: cellRemoved && keeperRemoved,
      bridge_removed: bridgeRemoved,
      config_removed: configRemoved,
      state_removed: stateRemoved,
      workspace_removed: workspaceRemoved,
      output_removed: outputRemoved,
      network_removed: internalNetworkRemoved && egressNetworkRemoved,
      credential_material_removed: gatewaySecretRemoved && bridgeSecretRemoved,
      listener_closed: listenerClosed,
      no_identity_process: noIdentityProcess,
    });
  }
}

export function storeCleanupProof(
  proof: LocalOpenClawCleanupProof,
  subscription: SubscriptionRevocationReadback,
  lateResultRejected: true,
): DetailedCleanupProof {
  return Object.freeze({
    gateway_exited: proof.gateway_exited,
    container_removed: proof.cell_removed,
    bridge_removed: proof.bridge_removed,
    config_removed: proof.config_removed,
    state_removed: proof.state_removed,
    workspace_removed: proof.workspace_removed,
    output_removed: proof.output_removed,
    network_removed: proof.network_removed,
    credential_material_removed: proof.credential_material_removed,
    subscription_lease_revoked: subscription.subscription_lease_revoked,
    subscription_requests_drained: subscription.subscription_requests_drained,
    subscription_listener_closed: subscription.subscription_listener_closed,
    subscription_socket_absent: subscription.subscription_socket_absent,
    listener_closed: proof.listener_closed,
    identity_process_absent: proof.no_identity_process,
    late_result_rejected: lateResultRejected,
  });
}
