import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import type {
  CredentialOwnerRegistry,
  CredentialOwnerRuntime,
} from "../openclaw/hermes-codex-grant";
import {
  OPENCLAW_CELL_IMAGE,
  type RuntimeImageEvidence,
  type RuntimeImageEvidenceSet,
} from "../openclaw/runtime-identity";
import type { DiscoveryAdapterId } from "../contracts";

export interface ReleaseCredentialOwner extends CredentialOwnerRuntime {
  readonly credential_owner_id: string;
  readonly credential_generation: number;
  readonly account_id_sha256: string;
}

export interface SupervisorRuntimeConfig {
  readonly schema_version: "ligou.discovery_supervisor.config.v1";
  readonly worker_id: string;
  readonly adapter_sequence: readonly DiscoveryAdapterId[];
  readonly lease_seconds: number;
  readonly poll_interval_ms: number;
  readonly shutdown_timeout_ms: number;
  readonly supervisor_uid: 1_000;
  readonly supervisor_gid: 1_000;
  readonly supabase_url: string;
  readonly health_host: "127.0.0.1";
  readonly health_port: number;
  readonly singleton_directory: string;
  readonly credential_owners: readonly ReleaseCredentialOwner[];
  readonly image_evidence: RuntimeImageEvidenceSet;
}

const CONFIG_KEYS = [
  "schema_version",
  "worker_id",
  "adapter_sequence",
  "lease_seconds",
  "poll_interval_ms",
  "shutdown_timeout_ms",
  "supervisor_uid",
  "supervisor_gid",
  "supabase_url",
  "health_host",
  "health_port",
  "singleton_directory",
  "credential_owners",
  "image_evidence",
] as const;
const OWNER_KEYS = [
  "credential_owner_id",
  "credential_generation",
  "account_id_sha256",
  "container_name",
  "model_auth_volume",
  "image_reference",
  "image_id",
  "interpreter_path",
] as const;
const IMAGE_SET_KEYS = ["cell_image", "bridge_image"] as const;
const IMAGE_KEYS = [
  "reference",
  "index_digest",
  "platform",
  "selected_manifest_digest",
  "image_id",
  "config_digest",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REFERENCE = /^[-./a-z0-9]+@sha256:[0-9a-f]{64}$/;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${name}: expected plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${name}: unexpected fields`);
  }
}

function string(value: unknown, name: string, maximum = 512): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${name}: bounded string required`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name}: integer ${minimum}..${maximum} required`);
  }
  return value as number;
}

function absolutePath(value: unknown, name: string): string {
  const path = string(value, name, 4_096);
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error(`${name}: absolute normalized path required`);
  }
  return path;
}

function image(value: unknown, kind: "cell" | "bridge"): RuntimeImageEvidence {
  const candidate = record(value, `${kind} image evidence`);
  exactKeys(candidate, IMAGE_KEYS, `${kind} image evidence`);
  const reference = string(candidate.reference, `${kind} image reference`, 384);
  const indexDigest = string(candidate.index_digest, `${kind} index digest`, 71);
  const selectedManifest = string(
    candidate.selected_manifest_digest,
    `${kind} selected manifest digest`,
    71,
  );
  const imageId = string(candidate.image_id, `${kind} image id`, 71);
  const configDigest = string(candidate.config_digest, `${kind} config digest`, 71);
  if (!IMAGE_REFERENCE.test(reference) || !DIGEST.test(indexDigest) ||
      !DIGEST.test(selectedManifest) || !DIGEST.test(imageId) || !DIGEST.test(configDigest) ||
      reference.slice(reference.lastIndexOf("@") + 1) !== indexDigest ||
      (candidate.platform !== "linux/arm64" && candidate.platform !== "linux/amd64") ||
      (kind === "cell" && reference !== OPENCLAW_CELL_IMAGE)) {
    throw new Error(`${kind} image evidence is invalid`);
  }
  return Object.freeze({
    reference,
    index_digest: indexDigest,
    platform: candidate.platform,
    selected_manifest_digest: selectedManifest,
    image_id: imageId,
    config_digest: configDigest,
  });
}

function images(value: unknown): RuntimeImageEvidenceSet {
  const candidate = record(value, "image evidence");
  exactKeys(candidate, IMAGE_SET_KEYS, "image evidence");
  return Object.freeze({
    cell_image: image(candidate.cell_image, "cell"),
    bridge_image: image(candidate.bridge_image, "bridge"),
  });
}

function owner(value: unknown, index: number): ReleaseCredentialOwner {
  const name = `credential_owners[${index}]`;
  const candidate = record(value, name);
  exactKeys(candidate, OWNER_KEYS, name);
  const ownerId = string(candidate.credential_owner_id, `${name}.credential_owner_id`, 36);
  const accountHash = string(candidate.account_id_sha256, `${name}.account_id_sha256`, 64);
  const runtime: ReleaseCredentialOwner = {
    credential_owner_id: ownerId,
    credential_generation: integer(
      candidate.credential_generation,
      `${name}.credential_generation`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    account_id_sha256: accountHash,
    container_name: string(candidate.container_name, `${name}.container_name`, 128),
    model_auth_volume: string(candidate.model_auth_volume, `${name}.model_auth_volume`, 128),
    image_reference: string(candidate.image_reference, `${name}.image_reference`, 384),
    image_id: string(candidate.image_id, `${name}.image_id`, 71),
    interpreter_path: candidate.interpreter_path as "/opt/hermes/.venv/bin/python",
  };
  if (!UUID.test(runtime.credential_owner_id) || !HASH.test(runtime.account_id_sha256) ||
      runtime.container_name !== `ligou-cell-${runtime.credential_owner_id}` ||
      runtime.model_auth_volume !== `ligou-${runtime.credential_owner_id}-hermes-model-auth` ||
      !IMAGE_REFERENCE.test(runtime.image_reference) || !DIGEST.test(runtime.image_id) ||
      runtime.interpreter_path !== "/opt/hermes/.venv/bin/python") {
    throw new Error(`${name}: invalid release-owned credential runtime`);
  }
  return Object.freeze(runtime);
}

export function parseSupervisorConfig(value: unknown): SupervisorRuntimeConfig {
  const candidate = record(value, "supervisor config");
  exactKeys(candidate, CONFIG_KEYS, "supervisor config");
  if (candidate.schema_version !== "ligou.discovery_supervisor.config.v1") {
    throw new Error("supervisor config schema is invalid");
  }
  if (!Array.isArray(candidate.adapter_sequence) || candidate.adapter_sequence.length < 1 ||
      candidate.adapter_sequence.length > 2 ||
      new Set(candidate.adapter_sequence).size !== candidate.adapter_sequence.length ||
      candidate.adapter_sequence.some((adapter) =>
        adapter !== "direct_model" && adapter !== "openclaw"
      )) {
    throw new Error("supervisor config requires one adapter or the exact unique comparison pair");
  }
  if (!Array.isArray(candidate.credential_owners) || candidate.credential_owners.length !== 1) {
    throw new Error("supervisor config requires exactly one subscription credential owner");
  }
  const credentialOwners = candidate.credential_owners.map(owner);
  const ownerKeys = credentialOwners.map((item) =>
    `${item.credential_owner_id}:${item.credential_generation}`
  );
  if (new Set(ownerKeys).size !== ownerKeys.length) {
    throw new Error("supervisor config has duplicate credential owner generations");
  }
  let supabaseUrl: URL;
  try { supabaseUrl = new URL(string(candidate.supabase_url, "supabase_url", 2_048)); }
  catch { throw new Error("supervisor config Supabase URL is invalid"); }
  const localHttp = supabaseUrl.protocol === "http:" &&
    (supabaseUrl.hostname === "127.0.0.1" || supabaseUrl.hostname === "localhost");
  if ((supabaseUrl.protocol !== "https:" && !localHttp) || supabaseUrl.username !== "" ||
      supabaseUrl.password !== "" || supabaseUrl.search !== "" || supabaseUrl.hash !== "") {
    throw new Error("supervisor config Supabase URL is invalid");
  }
  if (candidate.health_host !== "127.0.0.1") {
    throw new Error("supervisor health must bind exact loopback");
  }
  return Object.freeze({
    schema_version: "ligou.discovery_supervisor.config.v1",
    worker_id: string(candidate.worker_id, "worker_id", 180),
    adapter_sequence: Object.freeze(candidate.adapter_sequence as DiscoveryAdapterId[]),
    lease_seconds: integer(candidate.lease_seconds, "lease_seconds", 1, 600),
    poll_interval_ms: integer(candidate.poll_interval_ms, "poll_interval_ms", 50, 60_000),
    shutdown_timeout_ms: integer(
      candidate.shutdown_timeout_ms,
      "shutdown_timeout_ms",
      1_000,
      60_000,
    ),
    supervisor_uid: integer(candidate.supervisor_uid, "supervisor_uid", 1_000, 1_000) as 1_000,
    supervisor_gid: integer(candidate.supervisor_gid, "supervisor_gid", 1_000, 1_000) as 1_000,
    supabase_url: supabaseUrl.href.replace(/\/$/u, ""),
    health_host: "127.0.0.1",
    health_port: integer(candidate.health_port, "health_port", 0, 65_535),
    singleton_directory: absolutePath(candidate.singleton_directory, "singleton_directory"),
    credential_owners: Object.freeze(credentialOwners),
    image_evidence: images(candidate.image_evidence),
  });
}

export function assertSupervisorIdentity(
  config: Pick<SupervisorRuntimeConfig, "supervisor_uid" | "supervisor_gid">,
  uid: number | undefined = process.getuid?.(),
  gid: number | undefined = process.getgid?.(),
): void {
  if (uid !== config.supervisor_uid || gid !== config.supervisor_gid) {
    throw new Error("supervisor numeric identity does not match the release configuration");
  }
}

export async function loadProtectedSecret(path: string, name: string): Promise<string> {
  const normalizedPath = absolutePath(path, `${name} path`);
  const raw = await readProtectedText(normalizedPath, name, 131_072);
  const secret = raw.trim();
  if (secret.length < 1 || secret.length > 131_072 || /[\r\n]/u.test(secret)) {
    throw new Error(`${name}: invalid secret material`);
  }
  return secret;
}

async function readProtectedText(path: string, name: string, maximum: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error(`${name}: protected file could not be opened`);
  }
  try {
    const before = await handle.stat();
    const uid = process.getuid?.();
    if (!before.isFile() || before.nlink !== 1 || uid === undefined ||
        (before.uid !== uid && before.uid !== 0) || (before.mode & 0o077) !== 0) {
      throw new Error(`${name}: unsafe file permissions or ownership`);
    }
    if (before.size < 1 || before.size > maximum) throw new Error(`${name}: invalid file size`);
    const raw = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || Buffer.byteLength(raw, "utf8") !== before.size) {
      throw new Error(`${name}: protected file changed while reading`);
    }
    return raw;
  } finally {
    await handle.close();
  }
}

export class ReleaseCredentialOwnerRegistry implements CredentialOwnerRegistry {
  readonly #owners = new Map<string, CredentialOwnerRuntime>();

  constructor(owners: readonly ReleaseCredentialOwner[]) {
    for (const item of owners) {
      const key = `${item.credential_owner_id}:${item.credential_generation}`;
      if (this.#owners.has(key)) throw new Error("duplicate credential owner generation");
      this.#owners.set(key, Object.freeze({
        container_name: item.container_name,
        model_auth_volume: item.model_auth_volume,
        image_reference: item.image_reference,
        image_id: item.image_id,
        interpreter_path: item.interpreter_path,
      }));
    }
  }

  resolve(credentialOwnerId: string, generation: number): CredentialOwnerRuntime {
    const runtime = this.#owners.get(`${credentialOwnerId}:${generation}`);
    if (runtime === undefined) throw new Error("credential owner generation is not configured");
    return runtime;
  }
}

export async function readSupervisorConfig(path: string): Promise<SupervisorRuntimeConfig> {
  const normalizedPath = absolutePath(path, "supervisor config path");
  const raw = await readProtectedText(normalizedPath, "supervisor config", 1_048_576);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("supervisor config could not be read"); }
  return parseSupervisorConfig(value);
}
