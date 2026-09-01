import { randomBytes as systemRandomBytes } from "node:crypto";
import { createServer } from "node:net";

export const OPENCLAW_RELEASE = "2026.8.1" as const;
export const OPENCLAW_CELL_IMAGE =
  "ghcr.io/openclaw/openclaw@sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4" as const;

export interface RuntimeVolumeNames {
  readonly config: string;
  readonly state: string;
  readonly workspace: string;
  readonly output: string;
  readonly gateway_secret: string;
  readonly bridge_secret: string;
}

export interface RuntimeIdentity {
  readonly opaque_id: string;
  readonly profile_name: string;
  readonly cell_container_name: string;
  readonly bridge_container_name: string;
  readonly internal_network_name: string;
  readonly egress_network_name: string;
  readonly volume_names: RuntimeVolumeNames;
  readonly config_path: string;
  readonly state_path: string;
  readonly workspace_path: string;
  readonly output_path: string;
  readonly gateway_secret_path: string;
  readonly bridge_secret_path: string;
  readonly gateway_port: number;
  readonly host_gateway_port: number;
  readonly bridge_http_port: number;
  readonly bridge_relay_port: number;
}

export interface RuntimeIdentityAllocatorDependencies {
  readonly randomBytes?: (size: number) => Buffer;
  readonly reserveLoopbackPort?: () => Promise<number>;
}

export interface RuntimeIdentityBinding {
  readonly cell_container_name: string;
  readonly bridge_container_name: string;
  readonly internal_network_name: string;
  readonly egress_network_name: string;
  readonly config_volume_name: string;
  readonly state_volume_name: string;
  readonly workspace_volume_name: string;
  readonly output_volume_name: string;
  readonly gateway_secret_volume_name: string;
  readonly bridge_secret_volume_name: string;
  readonly profile_name: string;
  readonly loopback_port: number;
}

export interface RuntimeAttemptKey {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly fence_generation: number;
}

function runtimeAttemptKey(value: RuntimeAttemptKey): string {
  if (value.job_id.trim() === "" || value.attempt_id.trim() === "" ||
      !Number.isSafeInteger(value.fence_generation) || value.fence_generation < 1) {
    throw new Error("attempt runtime identity key is invalid");
  }
  return `${value.job_id}:${value.attempt_id}:${value.fence_generation}`;
}

export class AttemptRuntimeIdentityRegistry {
  readonly #identities = new Map<string, RuntimeIdentity>();

  bind(attempt: RuntimeAttemptKey, identity: RuntimeIdentity): void {
    const key = runtimeAttemptKey(attempt);
    const existing = this.#identities.get(key);
    if (existing !== undefined && existing !== identity) {
      throw new Error("attempt runtime identity is already bound");
    }
    this.#identities.set(key, identity);
  }

  resolve(attempt: RuntimeAttemptKey): RuntimeIdentity {
    const identity = this.#identities.get(runtimeAttemptKey(attempt));
    if (identity === undefined) throw new Error("attempt runtime identity is not bound");
    return identity;
  }

  retire(attempt: RuntimeAttemptKey): void {
    this.#identities.delete(runtimeAttemptKey(attempt));
  }
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(port);
      });
    });
  });
}

function opaqueBytes(random: (size: number) => Buffer): Buffer {
  const value = random(24);
  if (!Buffer.isBuffer(value) || value.byteLength !== 24) {
    throw new Error("runtime identity requires exactly 24 random bytes");
  }
  return Buffer.from(value);
}

export async function allocateRuntimeIdentity(
  dependencies: RuntimeIdentityAllocatorDependencies = {},
): Promise<RuntimeIdentity> {
  const bytes = opaqueBytes(dependencies.randomBytes ?? systemRandomBytes);
  const opaqueId = bytes.toString("hex");
  const tag = opaqueId.slice(0, 16);
  const gatewayPort = 20_000 + bytes.readUInt16BE(8) % 20_000;
  const hostGatewayPort = await (dependencies.reserveLoopbackPort ?? reserveLoopbackPort)();
  if (!Number.isSafeInteger(hostGatewayPort) || hostGatewayPort < 1_024 || hostGatewayPort > 65_535) {
    throw new Error("runtime identity received an invalid loopback port");
  }
  const root = `/openclaw/attempts/${tag}`;
  const volumeNames: RuntimeVolumeNames = Object.freeze({
    config: `ligou-oc-config-${tag}`,
    state: `ligou-oc-state-${tag}`,
    workspace: `ligou-oc-workspace-${tag}`,
    output: `ligou-oc-output-${tag}`,
    gateway_secret: `ligou-oc-gw-secret-${tag}`,
    bridge_secret: `ligou-oc-bridge-secret-${tag}`,
  });
  return Object.freeze({
    opaque_id: opaqueId,
    profile_name: `ligou-stage0-${tag}`,
    cell_container_name: `ligou-oc-cell-${tag}`,
    bridge_container_name: `ligou-oc-bridge-${tag}`,
    internal_network_name: `ligou-oc-internal-${tag}`,
    egress_network_name: `ligou-oc-egress-${tag}`,
    volume_names: volumeNames,
    config_path: `${root}/config`,
    state_path: `${root}/state`,
    workspace_path: `${root}/workspace`,
    output_path: `${root}/output`,
    gateway_secret_path: `${root}/secrets/gateway.json`,
    bridge_secret_path: `${root}/secrets/bridge.json`,
    gateway_port: gatewayPort,
    host_gateway_port: hostGatewayPort,
    bridge_http_port: 4_310,
    bridge_relay_port: 4_311,
  });
}

export function runtimeIdentityBinding(identity: RuntimeIdentity): RuntimeIdentityBinding {
  return Object.freeze({
    cell_container_name: identity.cell_container_name,
    bridge_container_name: identity.bridge_container_name,
    internal_network_name: identity.internal_network_name,
    egress_network_name: identity.egress_network_name,
    config_volume_name: identity.volume_names.config,
    state_volume_name: identity.volume_names.state,
    workspace_volume_name: identity.volume_names.workspace,
    output_volume_name: identity.volume_names.output,
    gateway_secret_volume_name: identity.volume_names.gateway_secret,
    bridge_secret_volume_name: identity.volume_names.bridge_secret,
    profile_name: identity.profile_name,
    loopback_port: identity.host_gateway_port,
  });
}
