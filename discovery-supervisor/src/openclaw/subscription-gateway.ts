import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { constants as fsConstants } from "node:fs";
import { chmod, lchown, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  ModelAccessAuthority,
  ModelAccessCapability,
  ModelAccessContext,
  ModelAccessExpectation,
  RegisteredSubscriptionLease,
  SubscriptionGateway,
  SubscriptionLeaseCapability,
  SubscriptionPolicy,
  SubscriptionRequestProspective,
  SubscriptionReservationReadback,
  SubscriptionRecoveryCapability,
  SubscriptionRecoveryContext,
  SubscriptionRevocationReadback,
  SubscriptionSettlementReadback,
  SubscriptionUsage,
} from "../contracts";
import type { CredentialOwnerBinding } from "./hermes-codex-grant";
import {
  FixedModelProxy,
  type CodexAccessGrant,
  type ModelProxyFetch,
} from "./model-proxy";

export interface SubscriptionListener {
  close(): Promise<{ readonly listener_closed: boolean; readonly socket_absent: boolean }>;
}

export interface SubscriptionListenerManager {
  open(
    socketPath: string,
    attemptMarker: string,
    forward: (request: Request, signal?: AbortSignal) => Promise<Response>,
  ): Promise<SubscriptionListener>;
  proveAbsent(socketPath: string): Promise<{
    readonly listener_closed: boolean;
    readonly socket_absent: boolean;
  }>;
  recoverAbsent?(context: Readonly<SubscriptionRecoveryContext>): Promise<{
    readonly listener_closed: boolean;
    readonly socket_absent: boolean;
  }>;
}

interface RuntimePathStatus {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isSocket(): boolean;
}

export interface SubscriptionRuntimeFileSystem {
  lstat(path: string): Promise<RuntimePathStatus>;
  mkdir(path: string, options: { readonly recursive: false; readonly mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  lchown(path: string, uid: number, gid: number): Promise<void>;
  secureDirectory(path: string, uid: number, gid: number, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

export interface UnixSubscriptionListenerManagerOptions {
  readonly supervisor_uid?: number;
  readonly bridge_uid?: 1_000;
  readonly bridge_gid?: 1_000;
  readonly file_system?: SubscriptionRuntimeFileSystem;
  readonly prove_stale_socket_identity_absent?: (
    context: Readonly<SubscriptionRecoveryContext>,
  ) => Promise<Readonly<StaleSocketIdentityAbsenceReadback>>;
}

export interface StaleSocketIdentityAbsenceReadback extends SubscriptionRecoveryContext {
  readonly identity_process_absent: true;
}

export interface SubscriptionRuntimeRootReadback {
  readonly path: "/run/ligou-discovery";
  readonly owner_uid: number;
  readonly bridge_uid: 1_000;
  readonly bridge_gid: 1_000;
  readonly mode: 0o710;
  readonly no_symlink: true;
}

export interface CentralSubscriptionGatewayOptions {
  readonly model_access_authority: ModelAccessAuthority;
  readonly credential_owner: CredentialOwnerBinding;
  readonly resolve_codex_grant: (
    owner: CredentialOwnerBinding,
    deadlineAt: string,
  ) => Promise<CodexAccessGrant>;
  readonly listener_manager: SubscriptionListenerManager;
  readonly fetch: ModelProxyFetch;
  readonly now?: () => number;
  readonly random_bytes?: (size: number) => Buffer;
  readonly revoke_drain_timeout_ms?: number;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function incomingBearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
}

function jsonResponse(response: ServerResponse, status: number, error: string): void {
  const body = JSON.stringify({ error });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function incomingBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (typeof declared !== "string" || !/^[0-9]+$/.test(declared) || Number(declared) > 400_000) {
    throw new Error("subscription UDS request exceeds byte limit");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    if (signal.aborted) throw new Error("subscription UDS request aborted");
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > 400_000) throw new Error("subscription UDS request exceeds byte limit");
    chunks.push(chunk);
  }
  if (total === 0) throw new Error("subscription UDS request is empty");
  return Buffer.concat(chunks, total);
}

async function closeHttpServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export class UnixSubscriptionListenerManager implements SubscriptionListenerManager {
  static readonly runtimeRoot = "/run/ligou-discovery" as const;
  readonly #fileSystem: SubscriptionRuntimeFileSystem;
  readonly #supervisorUid: number;
  readonly #bridgeUid: 1_000;
  readonly #bridgeGid: 1_000;
  readonly #proveStaleSocketIdentityAbsent?: (
    context: Readonly<SubscriptionRecoveryContext>,
  ) => Promise<Readonly<StaleSocketIdentityAbsenceReadback>>;
  readonly #activePaths = new Set<string>();

  constructor(options: UnixSubscriptionListenerManagerOptions = {}) {
    const allowedOptions = new Set([
      "supervisor_uid",
      "bridge_uid",
      "bridge_gid",
      "file_system",
      "prove_stale_socket_identity_absent",
    ]);
    if (options === null || typeof options !== "object" || Array.isArray(options) ||
        Object.keys(options).some((key) => !allowedOptions.has(key))) {
      throw new Error("subscription UDS listener options are invalid");
    }
    const runtimeUid = typeof process.getuid === "function" ? process.getuid() : -1;
    this.#supervisorUid = options.supervisor_uid ?? runtimeUid;
    this.#bridgeUid = options.bridge_uid ?? 1_000;
    this.#bridgeGid = options.bridge_gid ?? 1_000;
    if (!Number.isSafeInteger(this.#supervisorUid) || this.#supervisorUid < 0 ||
        this.#bridgeUid !== 1_000 || this.#bridgeGid !== 1_000) {
      throw new Error("subscription UDS ownership configuration is invalid");
    }
    this.#fileSystem = options.file_system ?? {
      lstat,
      mkdir,
      chmod,
      lchown,
      unlink,
      rmdir,
      async secureDirectory(path, uid, gid, mode) {
        const handle = await open(
          path,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
        try {
          const before = await handle.stat();
          if (!before.isDirectory()) throw new Error("secure runtime path is not a directory");
          await handle.chown(uid, gid);
          await handle.chmod(mode);
          const after = await handle.stat();
          if (!after.isDirectory() || after.uid !== uid || after.gid !== gid ||
              (after.mode & 0o777) !== mode) {
            throw new Error("secure runtime directory ownership is invalid");
          }
        } finally {
          await handle.close();
        }
      },
    };
    this.#proveStaleSocketIdentityAbsent = options.prove_stale_socket_identity_absent;
  }

  async prepareRuntimeRoot(): Promise<SubscriptionRuntimeRootReadback> {
    await this.#assertDirectory("/run", 0, 0, 0o755, "subscription UDS parent");
    let root: RuntimePathStatus;
    try {
      root = await this.#fileSystem.lstat(UnixSubscriptionListenerManager.runtimeRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let created = false;
      try {
        await this.#fileSystem.mkdir(UnixSubscriptionListenerManager.runtimeRoot, {
          recursive: false,
          mode: 0o710,
        });
        created = true;
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      if (created) {
        await this.#fileSystem.secureDirectory(
          UnixSubscriptionListenerManager.runtimeRoot,
          this.#supervisorUid,
          this.#bridgeGid,
          0o710,
        );
      }
      root = await this.#fileSystem.lstat(UnixSubscriptionListenerManager.runtimeRoot);
    }
    this.#validateDirectory(
      root,
      this.#supervisorUid,
      this.#bridgeGid,
      0o710,
      "subscription UDS runtime root",
    );
    return Object.freeze({
      path: UnixSubscriptionListenerManager.runtimeRoot,
      owner_uid: this.#supervisorUid,
      bridge_uid: this.#bridgeUid,
      bridge_gid: this.#bridgeGid,
      mode: 0o710,
      no_symlink: true,
    });
  }

  async open(
    socketPath: string,
    attemptMarker: string,
    forward: (request: Request, signal?: AbortSignal) => Promise<Response>,
  ): Promise<SubscriptionListener> {
    const match = /^\/run\/ligou-discovery\/([0-9a-f]{48})\/subscription[.]sock$/.exec(socketPath);
    if (match === null || attemptMarker.length < 32 || attemptMarker.length > 4_096) {
      throw new Error("subscription UDS listener identity is invalid");
    }
    if (this.#activePaths.has(socketPath)) throw new Error("subscription UDS listener already exists");
    await this.prepareRuntimeRoot();
    const directory = `/run/ligou-discovery/${match[1]}`;
    try {
      await this.#fileSystem.mkdir(directory, { recursive: false, mode: 0o710 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("subscription UDS attempt directory requires authorized recovery");
      }
      throw error;
    }
    await this.#fileSystem.secureDirectory(directory, this.#supervisorUid, this.#bridgeGid, 0o710);
    await this.#assertDirectory(
      directory,
      this.#supervisorUid,
      this.#bridgeGid,
      0o710,
      "subscription UDS attempt directory",
    );
    const sockets = new Set<Socket>();
    let closed = false;
    const server = createHttpServer((request, response) => {
      void (async () => {
        if (closed) { jsonResponse(response, 503, "subscription_listener_closed"); return; }
        const url = new URL(request.url ?? "/", "http://subscription-gateway");
        const contentType = request.headers["content-type"];
        if (request.method !== "POST" || url.pathname !== "/codex/responses" || url.search ||
            typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim() !== "application/json") {
          jsonResponse(response, 404, "subscription_route_rejected");
          return;
        }
        if (!constantTimeEqual(incomingBearer(request), attemptMarker)) {
          jsonResponse(response, 401, "subscription_marker_rejected");
          return;
        }
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        request.once("aborted", abort);
        const responseClosed = (): void => { if (!response.writableEnded) abort(); };
        response.once("close", responseClosed);
        try {
          const body = await incomingBody(request, controller.signal);
          const upstream = await forward(new Request("http://subscription-gateway/codex/responses", {
            method: "POST",
            headers: { authorization: `Bearer ${attemptMarker}`, "content-type": "application/json" },
            body,
            signal: controller.signal,
          }), controller.signal);
          response.statusCode = upstream.status;
          response.statusMessage = upstream.statusText;
          upstream.headers.forEach((value, name) => response.setHeader(name, value));
          response.setHeader("cache-control", "no-store");
          if (upstream.body === null) response.end();
          else await pipeline(Readable.fromWeb(upstream.body as any), response, { signal: controller.signal });
        } catch {
          if (!response.headersSent) jsonResponse(response, 502, "subscription_forward_failed");
          else response.destroy();
        } finally {
          request.off("aborted", abort);
          response.off("close", responseClosed);
        }
      })();
    });
    server.maxConnections = 1;
    server.maxHeadersCount = 16;
    server.headersTimeout = 5_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 1_000;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { server.off("listening", ready); reject(error); };
        const ready = (): void => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(socketPath);
      });
      await this.#fileSystem.lchown(socketPath, this.#supervisorUid, this.#bridgeGid);
      await this.#fileSystem.chmod(socketPath, 0o660);
      const socket = await this.#fileSystem.lstat(socketPath);
      if (socket.isSymbolicLink() || !socket.isSocket() || socket.uid !== this.#supervisorUid ||
          socket.gid !== this.#bridgeGid || (socket.mode & 0o777) !== 0o660) {
        throw new Error("subscription UDS socket ownership is invalid");
      }
      this.#activePaths.add(socketPath);
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      await closeHttpServer(server).catch(() => undefined);
      await this.#removeSocketIfOwned(socketPath).catch(() => undefined);
      await this.#fileSystem.rmdir(directory).catch(() => undefined);
      throw error;
    }
    return Object.freeze({
      close: async () => {
        if (!closed) {
          closed = true;
          for (const socket of sockets) socket.destroy();
          await closeHttpServer(server);
          await this.#removeSocketIfOwned(socketPath).catch(() => undefined);
          await this.#fileSystem.rmdir(directory).catch(() => undefined);
          this.#activePaths.delete(socketPath);
        }
        let socketAbsent = false;
        try { await lstat(socketPath); }
        catch (error) { socketAbsent = (error as NodeJS.ErrnoException).code === "ENOENT"; }
        return Object.freeze({ listener_closed: !server.listening, socket_absent: socketAbsent });
      },
    });
  }

  async proveAbsent(socketPath: string): Promise<{
    readonly listener_closed: boolean;
    readonly socket_absent: boolean;
  }> {
    const match = /^\/run\/ligou-discovery\/([0-9a-f]{48})\/subscription[.]sock$/.exec(socketPath);
    if (match === null) throw new Error("subscription UDS recovery path is invalid");
    await this.prepareRuntimeRoot();
    if (this.#activePaths.has(socketPath)) {
      return Object.freeze({ listener_closed: false, socket_absent: false });
    }
    let socketAbsent = false;
    try { await this.#fileSystem.lstat(socketPath); }
    catch (error) { socketAbsent = (error as NodeJS.ErrnoException).code === "ENOENT"; }
    if (socketAbsent) {
      await this.#removeEmptyAttemptDirectory(`/run/ligou-discovery/${match[1]}`);
    }
    return Object.freeze({ listener_closed: true, socket_absent: socketAbsent });
  }

  async recoverAbsent(context: Readonly<SubscriptionRecoveryContext>): Promise<{
    readonly listener_closed: boolean;
    readonly socket_absent: boolean;
  }> {
    const match = /^\/run\/ligou-discovery\/([0-9a-f]{48})\/subscription[.]sock$/
      .exec(context.subscription_socket_path);
    if (match === null) throw new Error("subscription UDS recovery path is invalid");
    await this.prepareRuntimeRoot();
    if (this.#activePaths.has(context.subscription_socket_path)) {
      return Object.freeze({ listener_closed: false, socket_absent: false });
    }
    const directory = `/run/ligou-discovery/${match[1]}`;
    let status: RuntimePathStatus;
    try {
      status = await this.#fileSystem.lstat(context.subscription_socket_path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#removeEmptyAttemptDirectory(directory);
      return Object.freeze({ listener_closed: true, socket_absent: true });
    }
    await this.#assertDirectory(
      directory,
      this.#supervisorUid,
      this.#bridgeGid,
      0o710,
      "subscription UDS recovery directory",
    );
    if (status.isSymbolicLink() || !status.isSocket() || status.uid !== this.#supervisorUid ||
        status.gid !== this.#bridgeGid || (status.mode & 0o777) !== 0o660 ||
        this.#proveStaleSocketIdentityAbsent === undefined) {
      return Object.freeze({ listener_closed: false, socket_absent: false });
    }
    const absence = await this.#proveStaleSocketIdentityAbsent(context);
    const expectedAbsenceKeys = [
      "job_id", "attempt_id", "fence_generation", "subscription_socket_path",
      "runtime_kind", "late_result_rejected", "identity_process_absent",
    ];
    if (absence === null || typeof absence !== "object" || Array.isArray(absence) ||
        Object.keys(absence).length !== expectedAbsenceKeys.length ||
        expectedAbsenceKeys.some((key) => !Object.hasOwn(absence, key)) ||
        absence.job_id !== context.job_id || absence.attempt_id !== context.attempt_id ||
        absence.fence_generation !== context.fence_generation ||
        absence.subscription_socket_path !== context.subscription_socket_path ||
        absence.runtime_kind !== context.runtime_kind || absence.late_result_rejected !== true ||
        absence.identity_process_absent !== true) {
      return Object.freeze({ listener_closed: false, socket_absent: false });
    }
    const confirmed = await this.#fileSystem.lstat(context.subscription_socket_path);
    if (confirmed.dev !== status.dev || confirmed.ino !== status.ino ||
        confirmed.isSymbolicLink() || !confirmed.isSocket() ||
        confirmed.uid !== this.#supervisorUid || confirmed.gid !== this.#bridgeGid ||
        (confirmed.mode & 0o777) !== 0o660) {
      return Object.freeze({ listener_closed: false, socket_absent: false });
    }
    await this.#fileSystem.unlink(context.subscription_socket_path);
    try {
      await this.#fileSystem.lstat(context.subscription_socket_path);
      return Object.freeze({ listener_closed: false, socket_absent: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.#removeEmptyAttemptDirectory(directory);
    return Object.freeze({ listener_closed: true, socket_absent: true });
  }

  async #assertDirectory(
    path: string,
    uid: number | undefined,
    gid: number | undefined,
    mode: number | undefined,
    name: string,
  ): Promise<void> {
    const status = await this.#fileSystem.lstat(path);
    this.#validateDirectory(status, uid, gid, mode, name);
  }

  #validateDirectory(
    status: RuntimePathStatus,
    uid: number | undefined,
    gid: number | undefined,
    mode: number | undefined,
    name: string,
  ): void {
    if (status.isSymbolicLink() || !status.isDirectory() ||
        (uid !== undefined && status.uid !== uid) ||
        (gid !== undefined && status.gid !== gid) ||
        (mode !== undefined && (status.mode & 0o777) !== mode)) {
      throw new Error(`${name} ownership or type is invalid`);
    }
  }

  async #removeSocketIfOwned(socketPath: string): Promise<void> {
    let status: RuntimePathStatus;
    try { status = await this.#fileSystem.lstat(socketPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isSocket() || status.uid !== this.#supervisorUid ||
        status.gid !== this.#bridgeGid) {
      throw new Error("subscription UDS cleanup target changed identity");
    }
    await this.#fileSystem.unlink(socketPath);
  }

  async #removeEmptyAttemptDirectory(directory: string): Promise<void> {
    try {
      await this.#assertDirectory(
        directory,
        this.#supervisorUid,
        this.#bridgeGid,
        0o710,
        "subscription UDS attempt directory",
      );
      await this.#fileSystem.rmdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  }
}

interface Meter {
  window_started_at: number;
  request_count: number;
  input_bytes: number;
  output_bytes: number;
  input_tokens: number;
  output_tokens: number;
}

interface MeterLimits {
  readonly requests: number;
  readonly input_bytes: number;
  readonly output_bytes: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

interface LeaseState {
  readonly capability: ModelAccessCapability;
  readonly context: Readonly<ModelAccessContext>;
  readonly expectation: Readonly<ModelAccessExpectation>;
  readonly policy: Readonly<SubscriptionPolicy>;
  readonly marker: string;
  readonly proxy: FixedModelProxy;
  readonly tenant_id: string;
  listener?: SubscriptionListener;
  listener_opening?: Promise<SubscriptionListener>;
  active: number;
  drain?: Promise<void>;
  resolve_drain?: () => void;
  revoked: boolean;
  revocation_generation: number;
  usage_complete: boolean;
  revocation?: SubscriptionRevocationReadback;
  revoking?: Promise<void>;
}

interface RecoveryFence {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly generation: number;
}

const WINDOW_MS = 3_600_000;
const GLOBAL_LIMITS = Object.freeze({
  requests: 140,
  input_bytes: 2_000_000,
  output_bytes: 40_000_000,
  input_tokens: 2_000_000,
  output_tokens: 40_960,
});
const TENANT_LIMITS = Object.freeze({
  requests: 28,
  input_bytes: 400_000,
  output_bytes: 8_388_608,
  input_tokens: 400_000,
  output_tokens: 8_192,
});

function emptyMeter(now: number): Meter {
  return { window_started_at: now, request_count: 0, input_bytes: 0, output_bytes: 0, input_tokens: 0, output_tokens: 0 };
}

function exactContext(left: ModelAccessContext, right: ModelAccessContext): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectation(context: ModelAccessContext): Readonly<ModelAccessExpectation> {
  return Object.freeze({
    adapter_id: context.adapter_id,
    job_id: context.job_id,
    attempt_id: context.attempt_id,
    fence_generation: context.fence_generation,
    runtime_slot_id: context.runtime_slot_id,
  });
}

function validateContext(context: ModelAccessContext, owner: CredentialOwnerBinding, now: number): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(context.tenant_id) || !uuid.test(context.job_id) || !uuid.test(context.attempt_id) ||
      !uuid.test(context.runtime_slot_id) || context.credential_owner_id !== owner.credential_owner_id ||
      context.credential_generation !== owner.credential_generation ||
      context.expected_account_hash !== owner.account_id_sha256 ||
      context.provider !== "openai-codex" || context.auth_kind !== "chatgpt_subscription_oauth" ||
      context.model !== "gpt-5.6-sol" || !Number.isSafeInteger(context.fence_generation) ||
      context.fence_generation < 1 || !Number.isSafeInteger(context.source_snapshot_count) ||
      context.source_snapshot_count < 1 || context.source_snapshot_count > 25 ||
      !/^\/run\/ligou-discovery\/[0-9a-f]{48}\/subscription[.]sock$/.test(context.subscription_socket_path) ||
      !/^[0-9a-f]{64}$/.test(context.runtime_identity_hash)) {
    throw new Error("model access context is invalid");
  }
  const deadline = Date.parse(context.deadline_at);
  if (!Number.isFinite(deadline) || deadline <= now || deadline - now > 600_000) {
    throw new Error("model access deadline is invalid");
  }
}

function policy(context: ModelAccessContext): Readonly<SubscriptionPolicy> {
  return Object.freeze({
    model: "gpt-5.6-sol",
    deadline_at: context.deadline_at,
    max_requests: Math.min(context.source_snapshot_count + 3, 28),
    max_input_bytes: 400_000,
    max_output_bytes: 8_388_608,
    max_response_bytes: 4_194_304,
    concurrency: 1,
    cache_retention: "none",
  });
}

function opaqueBytes(random: (size: number) => Buffer): Buffer {
  const bytes = random(24);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 24) throw new Error("subscription identity requires 24 random bytes");
  return Buffer.from(bytes);
}

function marker(bytes: Buffer, deadlineAt: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const account = `ligou-stage0-${createHash("sha256").update("marker-account").update(bytes).digest("base64url").slice(0, 24)}`;
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({
      exp: Math.floor(Date.parse(deadlineAt) / 1_000) + 300,
      "https://api.openai.com/auth": { chatgpt_account_id: account },
    }),
    createHash("sha256").update("marker-signature").update(bytes).digest("base64url"),
  ].join(".");
}

function leaseCapability(): SubscriptionLeaseCapability {
  return Object.freeze(Object.create(null)) as SubscriptionLeaseCapability;
}

function retryAfterSeconds(response: Response, now: number): number | null {
  const milliseconds = response.headers.get("retry-after-ms");
  if (milliseconds !== null && /^\d+(?:[.]\d+)?$/.test(milliseconds)) {
    const seconds = Math.ceil(Number(milliseconds) / 1_000);
    return Number.isFinite(seconds) && seconds >= 1 && seconds <= 3_600 ? seconds : null;
  }
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3_600 ? seconds : null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.ceil((parsed - now) / 1_000);
  return seconds >= 1 && seconds <= 3_600 ? seconds : null;
}

export class CentralSubscriptionGateway implements SubscriptionGateway {
  readonly #options: CentralSubscriptionGatewayOptions;
  readonly #now: () => number;
  readonly #random: (size: number) => Buffer;
  readonly #revokeDrainTimeoutMs: number;
  readonly #leases = new WeakMap<SubscriptionLeaseCapability, LeaseState>();
  readonly #leaseByModelAccess = new WeakSet<ModelAccessCapability>();
  readonly #leaseBySocketPath = new Map<string, SubscriptionLeaseCapability>();
  readonly #recoveryFenceBySocket = new Map<string, RecoveryFence>();
  readonly #recoveryFenceOrder: string[] = [];
  readonly #tenantMeters = new Map<string, Meter>();
  #globalMeter: Meter;
  #globalActive = 0;
  #tenantActive = new Map<string, number>();
  #cooldownUntil: number | null = null;
  #quotaUnknown = false;

  constructor(options: CentralSubscriptionGatewayOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#random = options.random_bytes ?? systemRandomBytes;
    this.#revokeDrainTimeoutMs = options.revoke_drain_timeout_ms ?? 30_000;
    if (!Number.isSafeInteger(this.#revokeDrainTimeoutMs) ||
        this.#revokeDrainTimeoutMs < 1 || this.#revokeDrainTimeoutMs > 30_000) {
      throw new Error("subscription revoke drain timeout is invalid");
    }
    this.#globalMeter = emptyMeter(this.#now());
  }

  async register(modelAccess: ModelAccessCapability): Promise<RegisteredSubscriptionLease> {
    if (this.#leaseByModelAccess.has(modelAccess)) {
      throw new Error("model access capability already registered a subscription lease");
    }
    const context = await this.#options.model_access_authority.assertModelAccessCurrent(modelAccess);
    validateContext(context, this.#options.credential_owner, this.#now());
    const grant = await this.#options.resolve_codex_grant(this.#options.credential_owner, context.deadline_at);
    const accountHash = createHash("sha256").update(grant.account_id, "utf8").digest("hex");
    if (accountHash !== context.expected_account_hash) throw new Error("subscription grant account binding mismatch");
    const current = await this.#options.model_access_authority.assertModelAccessCurrent(
      modelAccess,
      expectation(context),
    );
    validateContext(current, this.#options.credential_owner, this.#now());
    if (!exactContext(current, context)) throw new Error("model access context changed during grant resolution");
    const bytes = opaqueBytes(this.#random);
    const attemptMarker = marker(bytes, context.deadline_at);
    const socketPath = context.subscription_socket_path;
    const sessionId = `stage0_session_${createHash("sha256").update("session").update(bytes).digest("base64url").slice(0, 32)}`;
    const attemptPolicy = policy(context);
    if (this.#recoveryFenceBySocket.has(socketPath)) {
      throw new Error("subscription socket binding was already recovered");
    }
    const lease = leaseCapability();
    const proxy = new FixedModelProxy({
      proxy_marker: attemptMarker,
      adapter_id: context.adapter_id,
      codex_access_grant: grant,
      upstream_model: "gpt-5.6-sol",
      deadline_at: context.deadline_at,
      lease_session_id: sessionId,
      max_request_count: attemptPolicy.max_requests,
      max_input_bytes: attemptPolicy.max_input_bytes,
      max_output_bytes: attemptPolicy.max_output_bytes,
      max_concurrency: attemptPolicy.concurrency,
      now: this.#now,
      fetch: this.#options.fetch,
    });
    const state: LeaseState = {
      capability: modelAccess,
      context: Object.freeze({ ...context }),
      expectation: expectation(context),
      policy: attemptPolicy,
      marker: attemptMarker,
      proxy,
      tenant_id: context.tenant_id,
      active: 0,
      revoked: false,
      revocation_generation: 0,
      usage_complete: true,
    };
    this.#leases.set(lease, state);
    this.#leaseByModelAccess.add(modelAccess);
    if (this.#leaseBySocketPath.has(socketPath)) {
      state.revoked = true;
      proxy.retire();
      throw new Error("subscription socket path is already registered");
    }
    this.#leaseBySocketPath.set(socketPath, lease);
    try {
      const opening = this.#options.listener_manager.open(
        socketPath,
        attemptMarker,
        (request, signal) => this.forward(lease, request, signal),
      );
      state.listener_opening = opening;
      state.listener = await opening;
      state.listener_opening = undefined;
      if (state.revoked) {
        await this.#revokeState(
          state,
          Math.max(state.context.fence_generation, state.revocation_generation),
        );
        throw new Error("subscription lease revoked while listener opened");
      }
    } catch (error) {
      state.listener_opening = undefined;
      state.revoked = true;
      proxy.retire();
      await this.#revokeState(
        state,
        Math.max(state.context.fence_generation, state.revocation_generation),
      ).catch(() => undefined);
      throw error;
    }
    return Object.freeze({ lease, attempt_marker: attemptMarker, subscription_socket_path: socketPath, session_id: sessionId, policy: attemptPolicy });
  }

  async forward(lease: SubscriptionLeaseCapability, request: Request, signal?: AbortSignal): Promise<Response> {
    const state = this.#state(lease);
    if (state.revoked) throw new Error("subscription lease is revoked");
    let current: Readonly<ModelAccessContext>;
    try {
      current = await this.#options.model_access_authority.assertModelAccessCurrent(
        state.capability,
        state.expectation,
      );
      validateContext(current, this.#options.credential_owner, this.#now());
      if (!exactContext(current, state.context)) throw new Error("model access context changed");
    } catch (error) {
      await this.#revokeState(state);
      throw error;
    }
    const rawInputBytes = (await request.clone().arrayBuffer()).byteLength;
    const prospectiveInputBytes = Math.max(1, Math.min(
      state.policy.max_input_bytes,
      rawInputBytes,
    ));
    const prospective: SubscriptionRequestProspective = Object.freeze({
      input_bytes: prospectiveInputBytes,
      output_bytes: state.policy.max_response_bytes,
      lease_seconds: Math.max(1, Math.min(600,
        Math.ceil((Date.parse(state.context.deadline_at) - this.#now()) / 1_000))),
    });
    this.#resetWindows();
    this.#assertAdmission(state, prospective);
    const reserved = await this.#options.model_access_authority.reserveSubscriptionRequest(
      state.capability,
      prospective,
    );
    this.#validateReservation(reserved, state, prospective);
    if (state.revoked) {
      try {
        const settled = await this.#options.model_access_authority.settleSubscriptionRequest(
          reserved.reservation,
          Object.freeze({
            input_bytes: 0,
            output_bytes: 0,
            observed_input_tokens: 0,
            observed_output_tokens: 0,
            usage_complete: true,
            quota_state: "available" as const,
            retry_after_seconds: null,
          }),
        );
        this.#validateSettlement(settled, "available");
      } catch (error) {
        this.#quotaUnknown = true;
        state.usage_complete = false;
        throw new Error("subscription revoked reservation settlement unresolved", { cause: error });
      }
      throw new Error("subscription lease revoked after reservation");
    }
    const before = state.proxy.usage();
    this.#globalActive += 1;
    this.#tenantActive.set(state.tenant_id, (this.#tenantActive.get(state.tenant_id) ?? 0) + 1);
    state.active += 1;
    if (state.active === 1) {
      state.drain = new Promise<void>((resolve) => { state.resolve_drain = resolve; });
    }
    const signals = [request.signal, signal].filter((value): value is AbortSignal => value !== undefined);
    const forwardedHeaders = new Headers(request.headers);
    if (state.context.adapter_id === "direct_model") {
      // DirectModel already holds the opaque in-process lease capability. Add
      // the attempt-local proxy marker here so the adapter never needs to see
      // or transport even this non-OAuth credential.
      forwardedHeaders.set("authorization", `Bearer ${state.marker}`);
    }
    const forwarded = new Request(request, {
      headers: forwardedHeaders,
      signal: signals.length === 0
        ? request.signal
        : signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
    let response: Response | undefined;
    let quotaState: "available" | "cooldown" | "unknown" = "available";
    let retryAfter: number | null = null;
    let settlementError: unknown;
    try {
      response = await state.proxy.forward(forwarded);
      if (response.status === 429) {
        retryAfter = retryAfterSeconds(response, this.#now());
        quotaState = retryAfter === null ? "unknown" : "cooldown";
      } else if (!response.ok) {
        quotaState = "unknown";
      }
      return response;
    } catch (error) {
      const failed = state.proxy.usage();
      if (failed.upstream_request_count > before.upstream_request_count) quotaState = "unknown";
      throw error;
    } finally {
      const after = state.proxy.usage();
      this.#recordDelta(state, before, after);
      const actualInputBytes = Math.max(0, after.input_bytes - before.input_bytes);
      const upstreamAttempted = after.upstream_request_count > before.upstream_request_count;
      const observedAggregateExceeded = this.#observedLimitsExceeded(state);
      const requestUsageComplete = !observedAggregateExceeded &&
        actualInputBytes <= prospective.input_bytes && (
        !upstreamAttempted ||
        (response?.ok === true && after.usage_complete &&
          after.upstream_request_count === before.upstream_request_count + 1) ||
        (response?.status === 429 && retryAfter !== null)
      );
      if (!requestUsageComplete) quotaState = "unknown";
      state.usage_complete &&= requestUsageComplete;
      try {
        const completedWithoutModelUsage = requestUsageComplete &&
          (!upstreamAttempted || response?.status === 429);
        const settled = await this.#options.model_access_authority.settleSubscriptionRequest(
          reserved.reservation,
          Object.freeze({
            input_bytes: actualInputBytes,
            output_bytes: Math.max(0, after.output_bytes - before.output_bytes),
            observed_input_tokens: response?.ok && requestUsageComplete
              ? Math.max(0, after.input_tokens - before.input_tokens)
              : completedWithoutModelUsage ? 0 : null,
            observed_output_tokens: response?.ok && requestUsageComplete
              ? Math.max(0, after.output_tokens - before.output_tokens)
              : completedWithoutModelUsage ? 0 : null,
            usage_complete: requestUsageComplete,
            quota_state: quotaState,
            retry_after_seconds: retryAfter,
          }),
        );
        this.#validateSettlement(settled, quotaState);
        if (quotaState === "unknown" || settled.quota_state === "unknown") this.#quotaUnknown = true;
        if (settled.quota_state === "cooldown" && settled.cooldown_until !== null) {
          this.#cooldownUntil = Date.parse(settled.cooldown_until);
        }
      } catch (error) {
        this.#quotaUnknown = true;
        state.usage_complete = false;
        settlementError = error;
      }
      state.active -= 1;
      this.#globalActive -= 1;
      const tenantActive = Math.max(0, (this.#tenantActive.get(state.tenant_id) ?? 1) - 1);
      if (tenantActive === 0) this.#tenantActive.delete(state.tenant_id);
      else this.#tenantActive.set(state.tenant_id, tenantActive);
      if (state.active === 0) {
        state.resolve_drain?.();
        state.resolve_drain = undefined;
      }
      if (settlementError !== undefined) {
        throw new Error("subscription request settlement unresolved", { cause: settlementError });
      }
      if (observedAggregateExceeded) {
        this.#quotaUnknown = true;
        throw new Error("subscription observed aggregate governor exceeded");
      }
    }
  }

  usage(lease: SubscriptionLeaseCapability): Readonly<SubscriptionUsage> {
    const state = this.#state(lease);
    const observed = state.proxy.usage();
    const now = this.#now();
    const cooldown = this.#cooldownUntil !== null && this.#cooldownUntil > now;
    return Object.freeze({
      schema_version: "ligou.subscription_usage.v1",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      billing_basis: "chatgpt_subscription",
      marginal_api_charge_usd: 0,
      request_count: observed.request_count,
      active_requests: observed.active_requests,
      input_bytes: observed.input_bytes,
      output_bytes: observed.output_bytes,
      input_tokens: observed.input_tokens,
      cached_input_tokens: observed.cached_input_tokens,
      output_tokens: observed.output_tokens,
      total_tokens: observed.total_tokens,
      usage_complete: observed.usage_complete && state.usage_complete,
      quota_state: this.#quotaUnknown ? "unknown" : cooldown ? "cooldown" : "available",
      retry_after_seconds: cooldown ? Math.ceil((this.#cooldownUntil! - now) / 1_000) : null,
      cooldown_until: cooldown ? new Date(this.#cooldownUntil!).toISOString() : null,
      revoked: state.revoked,
    });
  }

  async revoke(lease: SubscriptionLeaseCapability): Promise<SubscriptionRevocationReadback> {
    return this.#revokeState(this.#state(lease));
  }

  async recover(
    authority: SubscriptionRecoveryCapability,
  ): Promise<SubscriptionRevocationReadback> {
    const context = await this.#options.model_access_authority
      .assertSubscriptionRecoveryCurrent(authority);
    this.#validateRecoveryContext(context);
    const previous = this.#recoveryFenceBySocket.get(context.subscription_socket_path);
    if (previous !== undefined &&
        (previous.job_id !== context.job_id || previous.attempt_id !== context.attempt_id)) {
      throw new Error("subscription recovery authority mismatched prior binding");
    }
    if (previous !== undefined && context.fence_generation < previous.generation) {
      throw new Error("subscription recovery authority fence regressed");
    }
    const lease = this.#leaseBySocketPath.get(context.subscription_socket_path);
    if (lease !== undefined) {
      const state = this.#state(lease);
      if (state.context.job_id !== context.job_id ||
          state.context.attempt_id !== context.attempt_id ||
          context.fence_generation < state.context.fence_generation ||
          state.context.subscription_socket_path !== context.subscription_socket_path) {
        throw new Error("subscription recovery authority mismatched active lease");
      }
      return this.#revokeState(state, context.fence_generation);
    }
    const absent = this.#options.listener_manager.recoverAbsent === undefined
      ? await this.#options.listener_manager.proveAbsent(context.subscription_socket_path)
      : await this.#options.listener_manager.recoverAbsent(context);
    if (!absent.listener_closed || !absent.socket_absent) {
      throw new Error("subscription recovery absence proof unresolved");
    }
    const emergedLease = this.#leaseBySocketPath.get(context.subscription_socket_path);
    if (emergedLease !== undefined) {
      const state = this.#state(emergedLease);
      if (state.context.job_id !== context.job_id ||
          state.context.attempt_id !== context.attempt_id ||
          context.fence_generation < state.context.fence_generation ||
          state.context.subscription_socket_path !== context.subscription_socket_path) {
        throw new Error("subscription recovery authority mismatched emerged lease");
      }
      return this.#revokeState(state, context.fence_generation);
    }
    const recoveredGeneration = this.#rememberRecoveryFence(context, context.fence_generation);
    return Object.freeze({
      generation: recoveredGeneration,
      subscription_lease_revoked: true,
      subscription_requests_drained: true,
      subscription_listener_closed: true,
      subscription_socket_absent: true,
    });
  }

  #state(lease: SubscriptionLeaseCapability): LeaseState {
    const state = this.#leases.get(lease);
    if (state === undefined) throw new Error("subscription lease capability is not trusted");
    return state;
  }

  async #revokeState(
    state: LeaseState,
    generation = state.context.fence_generation,
  ): Promise<SubscriptionRevocationReadback> {
    if (!Number.isSafeInteger(generation) || generation < state.context.fence_generation) {
      throw new Error("subscription revocation generation is invalid");
    }
    if (generation < state.revocation_generation) {
      throw new Error("subscription revocation generation regressed");
    }
    state.revocation_generation = Math.max(state.revocation_generation, generation);
    if (state.revocation !== undefined) {
      if (state.revocation.generation === state.revocation_generation) return state.revocation;
      state.revocation = Object.freeze({
        ...state.revocation,
        generation: state.revocation_generation,
      });
      this.#rememberRecoveryFence(state.context, state.revocation_generation);
      return state.revocation;
    }
    state.revoked = true;
    state.proxy.retire();
    if (state.revoking === undefined) {
      state.revoking = (async () => {
        if (state.active > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const drained = await Promise.race([
            state.drain!.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), this.#revokeDrainTimeoutMs);
            }),
          ]);
          if (timer !== undefined) clearTimeout(timer);
          if (!drained) throw new Error("subscription request drain timed out");
        }
        if (state.listener === undefined && state.listener_opening !== undefined) {
          try { state.listener = await state.listener_opening; }
          catch { state.listener = undefined; }
        }
        let listenerClosed = false;
        let socketAbsent = false;
        try {
          const closed = state.listener === undefined
            ? await this.#options.listener_manager.proveAbsent(state.context.subscription_socket_path)
            : await state.listener.close();
          listenerClosed = closed?.listener_closed === true;
          socketAbsent = closed?.socket_absent === true;
        } catch {}
        if (!listenerClosed || !socketAbsent || state.active !== 0) {
          throw new Error("subscription lease cleanup unresolved");
        }
        this.#leaseBySocketPath.delete(state.context.subscription_socket_path);
      })();
    }
    const revoking = state.revoking;
    try {
      await revoking;
    } finally {
      if (state.revoking === revoking) state.revoking = undefined;
    }
    state.revocation = Object.freeze({
      generation: state.revocation_generation,
      subscription_lease_revoked: true,
      subscription_requests_drained: true,
      subscription_listener_closed: true,
      subscription_socket_absent: true,
    });
    this.#rememberRecoveryFence(state.context, state.revocation_generation);
    return state.revocation;
  }

  #rememberRecoveryFence(
    context: Pick<SubscriptionRecoveryContext, "job_id" | "attempt_id" | "subscription_socket_path">,
    generation: number,
  ): number {
    const path = context.subscription_socket_path;
    const previous = this.#recoveryFenceBySocket.get(path);
    if (previous !== undefined &&
        (previous.job_id !== context.job_id || previous.attempt_id !== context.attempt_id)) {
      throw new Error("subscription recovery fence mismatched prior binding");
    }
    const monotonicGeneration = Math.max(previous?.generation ?? 0, generation);
    this.#recoveryFenceBySocket.set(path, Object.freeze({
      job_id: context.job_id,
      attempt_id: context.attempt_id,
      generation: monotonicGeneration,
    }));
    const previousIndex = this.#recoveryFenceOrder.indexOf(path);
    if (previousIndex >= 0) this.#recoveryFenceOrder.splice(previousIndex, 1);
    this.#recoveryFenceOrder.push(path);
    while (this.#recoveryFenceOrder.length > 1_024) {
      this.#recoveryFenceBySocket.delete(this.#recoveryFenceOrder.shift()!);
    }
    return monotonicGeneration;
  }

  #validateRecoveryContext(context: SubscriptionRecoveryContext): void {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(context.job_id) || !uuid.test(context.attempt_id) ||
        !Number.isSafeInteger(context.fence_generation) || context.fence_generation < 1 ||
        !/^\/run\/ligou-discovery\/[0-9a-f]{48}\/subscription[.]sock$/.test(context.subscription_socket_path) ||
        (context.runtime_kind !== "openclaw_cell" && context.runtime_kind !== "direct_model_subscription")) {
      throw new Error("subscription recovery context is invalid");
    }
  }

  #resetWindows(): void {
    const now = this.#now();
    if (now - this.#globalMeter.window_started_at >= WINDOW_MS) {
      this.#globalMeter = emptyMeter(now);
      this.#tenantMeters.clear();
    }
  }

  #tenantMeter(tenantId: string): Meter {
    let meter = this.#tenantMeters.get(tenantId);
    if (meter === undefined) {
      meter = emptyMeter(this.#globalMeter.window_started_at);
      this.#tenantMeters.set(tenantId, meter);
    }
    return meter;
  }

  #assertAdmission(state: LeaseState, prospective: SubscriptionRequestProspective): void {
    const now = this.#now();
    if (this.#quotaUnknown) throw new Error("subscription account quota is unknown");
    if (this.#cooldownUntil !== null && this.#cooldownUntil > now) {
      throw new Error("subscription account is in cooldown");
    }
    if (this.#globalActive >= 1 || (this.#tenantActive.get(state.tenant_id) ?? 0) >= 1) {
      throw new Error("subscription concurrency limit exceeded");
    }
    const tenant = this.#tenantMeter(state.tenant_id);
    const exhausted = (meter: Meter, limits: MeterLimits) =>
      meter.request_count + 1 > limits.requests ||
      meter.input_bytes + prospective.input_bytes > limits.input_bytes ||
      meter.output_bytes + prospective.output_bytes > limits.output_bytes ||
      meter.input_tokens >= limits.input_tokens || meter.output_tokens >= limits.output_tokens;
    if (exhausted(this.#globalMeter, GLOBAL_LIMITS) || exhausted(tenant, TENANT_LIMITS)) {
      throw new Error("subscription aggregate governor exhausted");
    }
  }

  #validateReservation(
    value: Readonly<SubscriptionReservationReadback>,
    state: LeaseState,
    prospective: SubscriptionRequestProspective,
  ): void {
    const deadline = Date.parse(value.lease_until);
    if (value === null || typeof value !== "object" || value.quota_state !== "available" ||
        !Number.isSafeInteger(value.request_number) || value.request_number < 1 ||
        !Number.isFinite(deadline) || deadline <= this.#now() ||
        deadline > Date.parse(state.context.deadline_at) ||
        value.max_requests !== 28 || value.max_input_bytes !== 400_000 ||
        value.max_output_bytes !== 8_388_608 || value.max_concurrency !== 1 ||
        !Number.isSafeInteger(value.current_requests) || value.current_requests < 1 ||
        value.current_requests > value.max_requests ||
        !Number.isSafeInteger(value.current_input_bytes) || value.current_input_bytes < 0 ||
        value.current_input_bytes > value.max_input_bytes ||
        value.current_input_bytes < prospective.input_bytes ||
        !Number.isSafeInteger(value.current_output_bytes) || value.current_output_bytes < 0 ||
        value.current_output_bytes > value.max_output_bytes ||
        value.current_output_bytes < prospective.output_bytes ||
        value.owner_max_requests !== 140 || value.owner_max_input_bytes !== 2_000_000 ||
        value.owner_max_output_bytes !== 40_000_000 ||
        !Number.isSafeInteger(value.owner_current_requests) || value.owner_current_requests < 1 ||
        value.owner_current_requests > value.owner_max_requests ||
        value.owner_current_requests < value.current_requests ||
        !Number.isSafeInteger(value.owner_current_input_bytes) || value.owner_current_input_bytes < 0 ||
        value.owner_current_input_bytes > value.owner_max_input_bytes ||
        value.owner_current_input_bytes < value.current_input_bytes ||
        !Number.isSafeInteger(value.owner_current_output_bytes) || value.owner_current_output_bytes < 0 ||
        value.owner_current_output_bytes > value.owner_max_output_bytes ||
        value.owner_current_output_bytes < value.current_output_bytes ||
        value.reservation === null || typeof value.reservation !== "object") {
      throw new Error("subscription reservation readback is invalid");
    }
  }

  #validateSettlement(
    value: Readonly<SubscriptionSettlementReadback>,
    _requested: "available" | "cooldown" | "unknown",
  ): void {
    // An identical idempotent settlement retry may observe a later durable
    // governor window (for example, an expired cooldown returning available).
    const mayReturn = new Set(["available", "cooldown", "unknown"]);
    if (value === null || typeof value !== "object" || value.settled !== true ||
        !mayReturn.has(value.quota_state) ||
        value.max_requests !== 28 || value.max_input_bytes !== 400_000 ||
        value.max_output_bytes !== 8_388_608 || value.max_concurrency !== 1 ||
        value.owner_max_requests !== 140 || value.owner_max_input_bytes !== 2_000_000 ||
        value.owner_max_output_bytes !== 40_000_000 ||
        (value.quota_state === "cooldown") !== (value.cooldown_until !== null) ||
        (value.cooldown_until !== null && !Number.isFinite(Date.parse(value.cooldown_until))) ||
        !Number.isSafeInteger(value.current_requests) || value.current_requests < 0 ||
        !Number.isSafeInteger(value.current_input_bytes) || value.current_input_bytes < 0 ||
        !Number.isSafeInteger(value.current_output_bytes) || value.current_output_bytes < 0 ||
        value.current_requests > value.max_requests ||
        value.current_input_bytes > value.max_input_bytes ||
        value.current_output_bytes > value.max_output_bytes ||
        !Number.isSafeInteger(value.owner_current_requests) || value.owner_current_requests < 0 ||
        value.owner_current_requests > value.owner_max_requests ||
        !Number.isSafeInteger(value.owner_current_input_bytes) || value.owner_current_input_bytes < 0 ||
        value.owner_current_input_bytes > value.owner_max_input_bytes ||
        !Number.isSafeInteger(value.owner_current_output_bytes) || value.owner_current_output_bytes < 0 ||
        value.owner_current_output_bytes > value.owner_max_output_bytes) {
      throw new Error("subscription settlement readback is invalid");
    }
  }

  #recordDelta(state: LeaseState, before: ReturnType<FixedModelProxy["usage"]>, after: ReturnType<FixedModelProxy["usage"]>): void {
    const tenant = this.#tenantMeter(state.tenant_id);
    const deltas = {
      request_count: Math.max(0, after.request_count - before.request_count),
      input_bytes: Math.max(0, after.input_bytes - before.input_bytes),
      output_bytes: Math.max(0, after.output_bytes - before.output_bytes),
      input_tokens: Math.max(0, after.input_tokens - before.input_tokens),
      output_tokens: Math.max(0, after.output_tokens - before.output_tokens),
    };
    for (const meter of [this.#globalMeter, tenant]) {
      meter.request_count += deltas.request_count;
      meter.input_bytes += deltas.input_bytes;
      meter.output_bytes += deltas.output_bytes;
      meter.input_tokens += deltas.input_tokens;
      meter.output_tokens += deltas.output_tokens;
    }
  }

  #observedLimitsExceeded(state: LeaseState): boolean {
    const tenant = this.#tenantMeter(state.tenant_id);
    const exceeded = (meter: Meter, limits: MeterLimits) =>
      meter.request_count > limits.requests || meter.input_bytes > limits.input_bytes ||
      meter.output_bytes > limits.output_bytes || meter.input_tokens > limits.input_tokens ||
      meter.output_tokens > limits.output_tokens;
    return exceeded(this.#globalMeter, GLOBAL_LIMITS) || exceeded(tenant, TENANT_LIMITS);
  }

  #recordCooldown(response: Response): void {
    const seconds = retryAfterSeconds(response, this.#now());
    if (seconds === null) {
      this.#quotaUnknown = true;
      return;
    }
    this.#cooldownUntil = this.#now() + seconds * 1_000;
  }
}
