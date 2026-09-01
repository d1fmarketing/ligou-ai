import type {
  DiscoveryBudget,
  DiscoverySourceSnapshot,
} from "../contracts";
import {
  OPENCLAW_CELL_IMAGE,
  type RuntimeIdentity,
  type RuntimeIdentityBinding,
} from "./runtime-identity";

const MCP_TOOL_NAMES = [
  "discovery__fetch_discovery_page",
  "discovery__submit_discovery_result",
] as const;

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
      bind: "lan",
      auth: Object.freeze({
        mode: "token",
        token: Object.freeze({ source: "file", provider: "attempt_gateway", id: "/gateway_token" }),
      }),
      reload: Object.freeze({ mode: "off" }),
      controlUi: Object.freeze({ enabled: false }),
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
        models: Object.freeze({ [modelRef]: Object.freeze({ alias: "Stage 0 bounded discovery" }) }),
        sandbox: Object.freeze({
          mode: "all",
          backend: "docker",
          scope: "session",
          workspaceAccess: "none",
          docker: Object.freeze({
            readOnlyRoot: true,
            tmpfs: Object.freeze(["/tmp", "/var/tmp", "/run"]),
            network: "none",
            capDrop: Object.freeze(["ALL"]),
          }),
          browser: Object.freeze({ enabled: false, allowHostControl: false }),
        }),
      }),
      entries: Object.freeze({
        discovery: Object.freeze({
          workspace: identity.workspace_path,
          model: Object.freeze({ primary: modelRef, fallbacks: Object.freeze([]) }),
          tools: Object.freeze({
            profile: "minimal",
            allow: Object.freeze([...MCP_TOOL_NAMES]),
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
          baseUrl: `http://bridge:${identity.bridge_http_port}/v1`,
          apiKey: marker,
          api: "openai-responses",
          models: Object.freeze([Object.freeze({
            id: model,
            name: "Stage 0 bounded discovery",
            reasoning: true,
            input: Object.freeze(["text"]),
            cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
            contextWindow: 128_000,
            maxTokens: 16_384,
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
      profile: "minimal",
      allow: Object.freeze([...MCP_TOOL_NAMES]),
      deny: Object.freeze([...DENIED_TOOLS]),
      codeMode: Object.freeze({ enabled: false }),
      elevated: Object.freeze({ enabled: false }),
      exec: Object.freeze({ security: "deny", ask: "always" }),
      fs: Object.freeze({ workspaceOnly: true }),
      sandbox: Object.freeze({
        tools: Object.freeze({ allow: Object.freeze([...MCP_TOOL_NAMES]), deny: Object.freeze([...DENIED_TOOLS]) }),
      }),
    }),
    skills: Object.freeze({ allowBundled: Object.freeze([]), entries: Object.freeze({}) }),
    update: Object.freeze({ checkOnStart: false, auto: Object.freeze({ enabled: false }) }),
    telemetry: Object.freeze({ enabled: false }),
    cron: Object.freeze({ enabled: false, triggers: Object.freeze({ enabled: false }), sessionRetention: false }),
    acp: Object.freeze({ enabled: false, dispatch: Object.freeze({ enabled: false }) }),
  });
}

export interface BridgeSecret {
  readonly upstream_api_key: string;
  readonly upstream_url: string;
  readonly upstream_model: string;
  readonly proxy_marker: string;
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
  readonly bridge_image: string;
}

export interface CommandSpec {
  readonly label: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly sensitive_stdin?: boolean;
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
} = {}): CommandSpec {
  return Object.freeze({ label, argv: Object.freeze([...argv]), env: Object.freeze({}), ...options });
}

function assertDigestImage(image: string, name: string): void {
  if (!/^[-./a-z0-9]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(`${name} must use an exact sha256 digest`);
  }
}

function volumeWriter(
  label: string,
  volume: string,
  filename: string,
  contents: string,
  sensitive: boolean,
): CommandSpec {
  return command(label, [
    "docker", "run", "--rm", "--network", "none",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=32", "--memory=67108864", "--cpus=0.25",
    "--user", "0:0",
    "--mount", `type=volume,src=${volume},dst=/target`,
    "--entrypoint", "/bin/sh", OPENCLAW_CELL_IMAGE,
    "-c", `umask 077; cat > /target/${filename}; chown 1000:1000 /target/${filename}; chmod 0600 /target/${filename}; chown 1000:1000 /target; chmod 0700 /target`,
  ], { stdin: contents, sensitive_stdin: sensitive });
}

function volumePreparer(label: string, volume: string): CommandSpec {
  return command(label, [
    "docker", "run", "--rm", "--network", "none",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=32", "--memory=67108864", "--cpus=0.25",
    "--user", "0:0",
    "--mount", `type=volume,src=${volume},dst=/target`,
    "--entrypoint", "/bin/sh", OPENCLAW_CELL_IMAGE,
    "-c", "chown 1000:1000 /target; chmod 0700 /target",
  ]);
}

export function buildCellLifecyclePlan(input: CellLifecyclePlanInput): readonly CommandSpec[] {
  assertDigestImage(OPENCLAW_CELL_IMAGE, "OpenClaw cell image");
  assertDigestImage(input.bridge_image, "trusted bridge image");
  nonEmpty(input.gateway_token, "Gateway token");
  nonEmpty(input.bridge_secret.upstream_api_key, "upstream API key");
  const id = input.identity;
  const plan: CommandSpec[] = [
    command("create-internal-network", ["docker", "network", "create", "--internal", id.internal_network_name]),
    command("create-egress-network", ["docker", "network", "create", id.egress_network_name]),
  ];
  for (const [key, volume] of Object.entries(id.volume_names)) {
    plan.push(command(`create-${key.replaceAll("_", "-")}-volume`, ["docker", "volume", "create", volume]));
  }
  plan.push(volumePreparer("prepare-state-volume", id.volume_names.state));
  plan.push(volumePreparer("prepare-workspace-volume", id.volume_names.workspace));
  plan.push(volumePreparer("prepare-output-volume", id.volume_names.output));
  plan.push(volumeWriter(
    "write-openclaw-config",
    id.volume_names.config,
    "openclaw.json",
    JSON.stringify(input.config),
    false,
  ));
  plan.push(volumeWriter(
    "write-gateway-secret",
    id.volume_names.gateway_secret,
    "secret.json",
    JSON.stringify({ gateway_token: input.gateway_token }),
    true,
  ));
  plan.push(volumeWriter(
    "write-bridge-secret",
    id.volume_names.bridge_secret,
    "secret.json",
    JSON.stringify(input.bridge_secret),
    true,
  ));
  plan.push(command("start-bridge", [
    "docker", "run", "--detach",
    "--name", id.bridge_container_name,
    "--hostname", "bridge",
    "--network", id.egress_network_name,
    "--network-alias", "bridge",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=128", "--memory=268435456", "--cpus=0.5",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864",
    "--mount", `type=volume,src=${id.volume_names.bridge_secret},dst=${id.bridge_secret_path},readonly`,
    "--mount", `type=volume,src=${id.volume_names.output},dst=${id.output_path}`,
    "--env", `BRIDGE_SECRET_PATH=${id.bridge_secret_path}/secret.json`,
    "--env", `BRIDGE_OUTPUT_PATH=${id.output_path}/result.json`,
    "--env", `BRIDGE_HTTP_PORT=${id.bridge_http_port}`,
    "--env", `BRIDGE_RELAY_PORT=${id.bridge_relay_port}`,
    "--env", `OPENCLAW_CELL_HOST=cell`,
    "--env", `OPENCLAW_CELL_GATEWAY_PORT=${id.gateway_port}`,
    "-p", `127.0.0.1:${id.host_gateway_port}:${id.bridge_relay_port}`,
    input.bridge_image,
  ]));
  plan.push(command("connect-bridge-internal", [
    "docker", "network", "connect", "--alias", "bridge",
    id.internal_network_name, id.bridge_container_name,
  ]));
  plan.push(command("start-cell", [
    "docker", "run", "--detach",
    "--name", id.cell_container_name,
    "--hostname", "cell",
    "--network", id.internal_network_name,
    "--network-alias", "cell",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--no-healthcheck",
    "--pids-limit=256", "--memory=1073741824", "--cpus=1",
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
    OPENCLAW_CELL_IMAGE,
    "node", "/app/openclaw.mjs",
    "--profile", id.profile_name,
    "gateway", "run", "--port", String(id.gateway_port),
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
}

export interface RuntimeCleanupProof {
  readonly gateway_exited: boolean;
  readonly cell_removed: boolean;
  readonly bridge_removed: boolean;
  readonly config_removed: boolean;
  readonly state_removed: boolean;
  readonly workspace_removed: boolean;
  readonly output_removed: boolean;
  readonly network_removed: boolean;
  readonly credential_revoked: boolean;
  readonly listener_closed: boolean;
  readonly no_identity_process: boolean;
  readonly late_result_rejected: boolean;
}

export interface DetailedCleanupProof {
  readonly gateway_exited: boolean;
  readonly container_removed: boolean;
  readonly bridge_removed: boolean;
  readonly config_removed: boolean;
  readonly state_removed: boolean;
  readonly workspace_removed: boolean;
  readonly output_removed: boolean;
  readonly network_removed: boolean;
  readonly credential_revoked: boolean;
  readonly listener_closed: boolean;
  readonly identity_process_absent: boolean;
  readonly late_result_rejected: boolean;
}

export interface CellRuntimeDependencies {
  readonly command_runner: CommandRunner;
  readonly listener_closed: (identity: RuntimeCleanupTarget) => Promise<boolean>;
  readonly identity_process_absent: (identity: RuntimeCleanupTarget) => Promise<boolean>;
}

async function runCleanup(runner: CommandRunner, label: string, argv: readonly string[]): Promise<boolean> {
  try {
    return (await runner.run(command(label, argv))).exitCode === 0;
  } catch {
    return false;
  }
}

export class CellRuntime {
  constructor(private readonly dependencies: CellRuntimeDependencies) {}

  async start(plan: readonly CommandSpec[], signal?: AbortSignal): Promise<void> {
    for (const step of plan) {
      if (signal?.aborted) throw new Error("OpenClaw cell startup cancelled");
      const result = await this.dependencies.command_runner.run(step, signal);
      if (result.exitCode !== 0) {
        throw new Error(`${step.label} failed: ${result.stderr || `exit ${result.exitCode}`}`);
      }
    }
  }

  async readSubmittedResult(handle: CellRuntimeHandle): Promise<unknown> {
    const id = handle.identity;
    const result = await this.dependencies.command_runner.run(command("read-submitted-result", [
      "docker", "run", "--rm", "--network", "none",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--pids-limit=32", "--memory=67108864", "--cpus=0.25",
      "--mount", `type=volume,src=${id.volume_names.output},dst=${id.output_path},readonly`,
      "--entrypoint", "/bin/sh", OPENCLAW_CELL_IMAGE,
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

  async cleanup(
    handle: CellRuntimeHandle,
    options: { readonly late_result_rejected: boolean },
  ): Promise<RuntimeCleanupProof> {
    return this.#cleanupTarget(handle.identity, options);
  }

  async cleanupBoundRuntime(
    binding: RuntimeIdentityBinding,
    options: { readonly late_result_rejected: boolean },
  ): Promise<RuntimeCleanupProof> {
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
    }, options);
  }

  async #cleanupTarget(
    id: RuntimeCleanupTarget,
    options: { readonly late_result_rejected: boolean },
  ): Promise<RuntimeCleanupProof> {
    const gatewayExited = await runCleanup(this.dependencies.command_runner, "stop-cell", [
      "docker", "stop", "--time", "10", id.cell_container_name,
    ]);
    const cellRemoved = await runCleanup(this.dependencies.command_runner, "remove-cell", [
      "docker", "rm", "--force", id.cell_container_name,
    ]);
    const bridgeRemoved = await runCleanup(this.dependencies.command_runner, "remove-bridge", [
      "docker", "rm", "--force", id.bridge_container_name,
    ]);
    const configRemoved = await runCleanup(this.dependencies.command_runner, "remove-config-volume", [
      "docker", "volume", "rm", id.volume_names.config,
    ]);
    const stateRemoved = await runCleanup(this.dependencies.command_runner, "remove-state-volume", [
      "docker", "volume", "rm", id.volume_names.state,
    ]);
    const workspaceRemoved = await runCleanup(this.dependencies.command_runner, "remove-workspace-volume", [
      "docker", "volume", "rm", id.volume_names.workspace,
    ]);
    const outputRemoved = await runCleanup(this.dependencies.command_runner, "remove-output-volume", [
      "docker", "volume", "rm", id.volume_names.output,
    ]);
    const gatewaySecretRemoved = await runCleanup(
      this.dependencies.command_runner,
      "remove-gateway-secret-volume",
      ["docker", "volume", "rm", id.volume_names.gateway_secret],
    );
    const bridgeSecretRemoved = await runCleanup(
      this.dependencies.command_runner,
      "remove-bridge-secret-volume",
      ["docker", "volume", "rm", id.volume_names.bridge_secret],
    );
    const internalNetworkRemoved = await runCleanup(
      this.dependencies.command_runner,
      "remove-internal-network",
      ["docker", "network", "rm", id.internal_network_name],
    );
    const egressNetworkRemoved = await runCleanup(
      this.dependencies.command_runner,
      "remove-egress-network",
      ["docker", "network", "rm", id.egress_network_name],
    );
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
      gateway_exited: gatewayExited,
      cell_removed: cellRemoved,
      bridge_removed: bridgeRemoved,
      config_removed: configRemoved,
      state_removed: stateRemoved,
      workspace_removed: workspaceRemoved,
      output_removed: outputRemoved,
      network_removed: internalNetworkRemoved && egressNetworkRemoved,
      credential_revoked: gatewaySecretRemoved && bridgeSecretRemoved,
      listener_closed: listenerClosed,
      no_identity_process: noIdentityProcess,
      late_result_rejected: options.late_result_rejected,
    });
  }
}

export function storeCleanupProof(proof: RuntimeCleanupProof): DetailedCleanupProof {
  return Object.freeze({
    gateway_exited: proof.gateway_exited,
    container_removed: proof.cell_removed,
    bridge_removed: proof.bridge_removed,
    config_removed: proof.config_removed,
    state_removed: proof.state_removed,
    workspace_removed: proof.workspace_removed,
    output_removed: proof.output_removed,
    network_removed: proof.network_removed,
    credential_revoked: proof.credential_revoked,
    listener_closed: proof.listener_closed,
    identity_process_absent: proof.no_identity_process,
    late_result_rejected: proof.late_result_rejected,
  });
}
