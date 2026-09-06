import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export interface SupervisorHealthState {
  schema_version: "ligou.discovery_supervisor.health.v1";
  status: "starting" | "running" | "degraded" | "stopping" | "stopped";
  loop_active: boolean;
  last_poll_at: string | null;
  last_outcome: string | null;
  consecutive_failures: number;
}

export interface SupervisorLoopOptions {
  readonly run_once: (signal?: AbortSignal) => Promise<{ readonly state: string }>;
  readonly poll_interval_ms: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function sleepWithAbort(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const aborted = (): void => { cleanup(); resolve(); };
    const cleanup = (): void => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    sleep(milliseconds).then(
      () => { cleanup(); resolve(); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export class SupervisorLoop {
  readonly health: SupervisorHealthState = {
    schema_version: "ligou.discovery_supervisor.health.v1",
    status: "starting",
    loop_active: false,
    last_poll_at: null,
    last_outcome: null,
    consecutive_failures: 0,
  };
  readonly #runOnce: SupervisorLoopOptions["run_once"];
  readonly #pollIntervalMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  #running = false;

  constructor(options: SupervisorLoopOptions) {
    this.#runOnce = options.run_once;
    this.#pollIntervalMs = boundedInteger(
      options.poll_interval_ms,
      "supervisor poll interval",
      1,
      60_000,
    );
    this.#sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
    );
    this.#now = options.now ?? Date.now;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) throw new Error("supervisor loop is already running");
    this.#running = true;
    this.health.status = "running";
    this.health.loop_active = true;
    try {
      while (!signal.aborted) {
        try {
          const outcome = await this.#runOnce(signal);
          this.health.last_poll_at = new Date(this.#now()).toISOString();
          this.health.last_outcome = outcome.state.slice(0, 100);
          this.health.consecutive_failures = 0;
          this.health.status = "running";
        } catch {
          this.health.last_poll_at = new Date(this.#now()).toISOString();
          this.health.last_outcome = "failed";
          this.health.consecutive_failures = Math.min(
            Number.MAX_SAFE_INTEGER,
            this.health.consecutive_failures + 1,
          );
          this.health.status = "degraded";
        }
        if (signal.aborted) break;
        await sleepWithAbort(this.#sleep, this.#pollIntervalMs, signal);
      }
    } finally {
      this.#running = false;
      this.health.loop_active = false;
      this.health.status = "stopped";
    }
  }

  markStopping(): void {
    if (this.health.status !== "stopped") this.health.status = "stopping";
  }
}

export class SingletonAuthority {
  readonly #directory: string;
  readonly #identity: SingletonProcessIdentity;
  readonly stale_owner_recovered: boolean;
  #released = false;

  private constructor(
    directory: string,
    identity: SingletonProcessIdentity,
    staleOwnerRecovered: boolean,
  ) {
    this.#directory = directory;
    this.#identity = identity;
    this.stale_owner_recovered = staleOwnerRecovered;
  }

  static async acquire(
    directory: string,
    options: SingletonAuthorityOptions = {},
  ): Promise<SingletonAuthority> {
    if (!directory.startsWith("/") || directory.split("/").includes("..")) {
      throw new Error("singleton authority path is invalid");
    }
    await assertOwnedDirectory(dirname(directory), "singleton authority parent");
    const identity = options.identity ?? await currentProcessIdentity();
    validateProcessIdentity(identity);
    try {
      await createAuthorityDirectory(directory, identity);
      return new SingletonAuthority(directory, identity, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertOwnedDirectory(directory, "singleton authority");
    const previous = await readAuthorityIdentity(directory);
    const isCurrent = options.is_owner_current ?? isProcessIdentityCurrent;
    if (await isCurrent(previous)) {
      throw new Error("supervisor singleton authority is already held by a live owner");
    }
    const tombstone = `${directory}.stale-${previous.pid}-${randomUUID()}`;
    try {
      await rename(directory, tombstone);
    } catch {
      throw new Error("supervisor singleton authority changed during stale recovery");
    }
    try {
      const moved = await readAuthorityIdentity(tombstone);
      if (!sameProcessIdentity(moved, previous)) {
        throw new Error("supervisor singleton authority changed during stale recovery");
      }
      await createAuthorityDirectory(directory, identity);
    } finally {
      await removeExactAuthorityDirectory(tombstone);
    }
    return new SingletonAuthority(directory, identity, true);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    const current = await readAuthorityIdentity(this.#directory);
    if (!sameProcessIdentity(current, this.#identity)) {
      throw new Error("supervisor process no longer owns singleton authority");
    }
    await unlink(`${this.#directory}/owner.json`);
    await rmdir(this.#directory);
    this.#released = true;
  }
}

export interface SingletonProcessIdentity {
  readonly pid: number;
  readonly process_start_id: string;
  readonly boot_id: string;
}

export interface SingletonAuthorityOptions {
  readonly identity?: SingletonProcessIdentity;
  readonly is_owner_current?: (owner: SingletonProcessIdentity) => Promise<boolean>;
}

const OWNER_KEYS = ["schema_version", "pid", "process_start_id", "boot_id"] as const;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateProcessIdentity(value: SingletonProcessIdentity): void {
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 ||
      !/^[0-9]{1,30}$/.test(value.process_start_id) || !BOOT_ID.test(value.boot_id)) {
    throw new Error("supervisor process identity is invalid");
  }
}

function sameProcessIdentity(
  left: SingletonProcessIdentity,
  right: SingletonProcessIdentity,
): boolean {
  return left.pid === right.pid && left.process_start_id === right.process_start_id &&
    left.boot_id === right.boot_id;
}

async function assertOwnedDirectory(path: string, name: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || uid === undefined || gid === undefined ||
      metadata.uid !== uid || metadata.gid !== gid || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} must be a private process-owned directory`);
  }
}

async function createAuthorityDirectory(
  directory: string,
  identity: SingletonProcessIdentity,
): Promise<void> {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  try {
    await writeFile(`${directory}/owner.json`, JSON.stringify({
      schema_version: "ligou.discovery_supervisor.owner.v1",
      ...identity,
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await rmdir(directory).catch(() => undefined);
    throw error;
  }
}

async function readAuthorityIdentity(directory: string): Promise<SingletonProcessIdentity> {
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] !== "owner.json") {
    throw new Error("singleton authority directory contains unexpected state");
  }
  const path = `${directory}/owner.json`;
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_024 ||
      uid === undefined || gid === undefined || metadata.uid !== uid || metadata.gid !== gid ||
      (metadata.mode & 0o077) !== 0) {
    throw new Error("singleton authority owner marker is unsafe");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("singleton authority owner marker is invalid"); }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("singleton authority owner marker is invalid");
  }
  const candidate = decoded as Record<string, unknown>;
  if (Object.keys(candidate).length !== OWNER_KEYS.length ||
      OWNER_KEYS.some((key) => !Object.hasOwn(candidate, key)) ||
      candidate.schema_version !== "ligou.discovery_supervisor.owner.v1") {
    throw new Error("singleton authority owner marker is invalid");
  }
  const identity = {
    pid: candidate.pid,
    process_start_id: candidate.process_start_id,
    boot_id: candidate.boot_id,
  } as SingletonProcessIdentity;
  validateProcessIdentity(identity);
  return Object.freeze(identity);
}

async function removeExactAuthorityDirectory(directory: string): Promise<void> {
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] !== "owner.json") {
    throw new Error("stale singleton authority contains unexpected state");
  }
  await unlink(`${directory}/owner.json`);
  await rmdir(directory);
}

function processStartId(stat: string): string {
  const closing = stat.lastIndexOf(")");
  if (closing < 1) throw new Error("Linux process identity is invalid");
  const fields = stat.slice(closing + 1).trim().split(/\s+/u);
  const start = fields[19];
  if (start === undefined || !/^[0-9]+$/.test(start)) {
    throw new Error("Linux process identity is invalid");
  }
  return start;
}

async function currentProcessIdentity(): Promise<SingletonProcessIdentity> {
  try {
    const [bootId, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile("/proc/self/stat", "utf8"),
    ]);
    const identity = {
      pid: process.pid,
      process_start_id: processStartId(stat),
      boot_id: bootId.trim(),
    };
    validateProcessIdentity(identity);
    return Object.freeze(identity);
  } catch {
    throw new Error("Linux process identity is unavailable");
  }
}

async function isProcessIdentityCurrent(owner: SingletonProcessIdentity): Promise<boolean> {
  let bootId: string;
  try { bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); }
  catch { throw new Error("Linux boot identity is unavailable"); }
  if (bootId !== owner.boot_id) return false;
  try {
    return processStartId(await readFile(`/proc/${owner.pid}/stat`, "utf8")) ===
      owner.process_start_id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("singleton owner process state is unavailable");
  }
}

export interface HealthEndpointOptions {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly state: SupervisorHealthState;
}

function healthBody(state: SupervisorHealthState): string {
  return JSON.stringify({
    schema_version: "ligou.discovery_supervisor.health.v1",
    status: state.status,
    loop_active: state.loop_active,
    last_poll_at: state.last_poll_at,
    last_outcome: state.last_outcome,
    consecutive_failures: state.consecutive_failures,
  });
}

export class HealthEndpoint {
  readonly #options: HealthEndpointOptions;
  readonly #server: Server;
  #started = false;

  constructor(options: HealthEndpointOptions) {
    if (options.host !== "127.0.0.1") throw new Error("health endpoint requires loopback");
    boundedInteger(options.port, "health endpoint port", 0, 65_535);
    this.#options = options;
    this.#server = createServer((request, response) => {
      if ((request.method !== "GET" && request.method !== "HEAD") || request.url !== "/health") {
        response.writeHead(404, { "cache-control": "no-store", connection: "close" });
        response.end();
        return;
      }
      const body = healthBody(this.#options.state);
      response.writeHead(this.#options.state.status === "degraded" ? 503 : 200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        connection: "close",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    });
    this.#server.maxConnections = 8;
    this.#server.maxHeadersCount = 16;
    this.#server.headersTimeout = 2_000;
    this.#server.requestTimeout = 2_000;
    this.#server.keepAliveTimeout = 500;
  }

  async start(): Promise<{ readonly host: "127.0.0.1"; readonly port: number }> {
    if (this.#started) throw new Error("health endpoint is already started");
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => { cleanup(); reject(new Error("health endpoint failed to start")); };
      const ready = (): void => { cleanup(); resolve(); };
      const cleanup = (): void => {
        this.#server.off("error", failed);
        this.#server.off("listening", ready);
      };
      this.#server.once("error", failed);
      this.#server.once("listening", ready);
      this.#server.listen(this.#options.port, this.#options.host);
    });
    this.#started = true;
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      await this.close();
      throw new Error("health endpoint address is unavailable");
    }
    return Object.freeze({ host: "127.0.0.1", port: address.port });
  }

  async close(): Promise<void> {
    if (!this.#started || !this.#server.listening) return;
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#started = false;
  }
}

export interface SupervisorServiceOptions {
  readonly loop: SupervisorLoop;
  readonly health: HealthEndpoint;
  readonly authority: SingletonAuthority;
  readonly shutdown_timeout_ms: number;
}

export class SupervisorService {
  readonly #options: SupervisorServiceOptions;
  readonly #controller = new AbortController();
  #running: Promise<void> | undefined;
  #shutdown: Promise<{ readonly drained: boolean }> | undefined;

  constructor(options: SupervisorServiceOptions) {
    boundedInteger(options.shutdown_timeout_ms, "shutdown timeout", 1, 60_000);
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#running !== undefined) throw new Error("supervisor service is already started");
    await this.#options.health.start();
    this.#running = this.#options.loop.run(this.#controller.signal);
    this.#running.catch(() => undefined);
  }

  shutdown(): Promise<{ readonly drained: boolean }> {
    this.#shutdown ??= this.#shutdownOnce();
    return this.#shutdown;
  }

  async #shutdownOnce(): Promise<{ readonly drained: boolean }> {
    this.#options.loop.markStopping();
    this.#controller.abort();
    const running = this.#running ?? Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      running.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#options.shutdown_timeout_ms);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    await this.#options.health.close();
    if (drained) await this.#options.authority.release();
    return Object.freeze({ drained });
  }
}
