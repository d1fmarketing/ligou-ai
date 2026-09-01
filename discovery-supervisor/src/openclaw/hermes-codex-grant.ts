import { createHash } from "node:crypto";
import type { CommandRunner, CommandSpec } from "./cell-runtime";
import type { CodexAccessGrant } from "./model-proxy";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const EXPIRY_SKEW_SECONDS = 120;

export interface CredentialOwnerBinding {
  readonly credential_owner_id: string;
  readonly credential_generation: number;
  readonly account_id_sha256: string;
}

export interface CredentialOwnerRuntime {
  readonly container_name: string;
  readonly model_auth_volume: string;
  readonly image_reference: string;
  readonly image_id: string;
  readonly interpreter_path: "/opt/hermes/.venv/bin/python";
}

export interface CredentialOwnerRegistry {
  resolve(credentialOwnerId: string, generation: number): CredentialOwnerRuntime;
}

export interface CredentialOwnerCommandRunner extends CommandRunner {
  runSensitive(command: CommandSpec, signal?: AbortSignal): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

export interface HermesCodexGrantResolverOptions {
  readonly command_runner: CredentialOwnerCommandRunner;
  readonly credential_owner_registry: CredentialOwnerRegistry;
  readonly now?: () => number;
  readonly command_timeout_ms?: number;
}

interface GrantEnvelope extends CodexAccessGrant {
  readonly provider: "openai-codex";
  readonly auth_mode: "chatgpt";
  readonly base_url: typeof CODEX_BASE_URL;
}

const HERMES_GRANT_SCRIPT = String.raw`
import base64, json, os, sys, time
if "/opt/hermes" not in sys.path:
    sys.path.insert(0, "/opt/hermes")
from hermes_cli.auth import resolve_codex_runtime_credentials

deadline = int(sys.argv[1])
if os.environ.get("HERMES_AUTH_HOME") != "/opt/model-auth":
    raise RuntimeError("grant_auth_home_invalid")
remaining = max(1, deadline - int(time.time()))
creds = resolve_codex_runtime_credentials(
    refresh_if_expiring=True,
    refresh_skew_seconds=remaining + 120,
)
token = str(creds.get("api_key") or "").strip()
parts = token.split(".")
if len(parts) != 3:
    raise RuntimeError("grant_token_invalid")
payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
auth = payload.get("https://api.openai.com/auth") or {}
account_id = auth.get("chatgpt_account_id")
expires_at = payload.get("exp")
source = str(creds.get("source") or "")
base_url = str(creds.get("base_url") or "").rstrip("/")
if not isinstance(account_id, str) or not account_id:
    raise RuntimeError("grant_account_invalid")
if not isinstance(expires_at, int):
    raise RuntimeError("grant_expiry_invalid")
if source not in ("hermes-auth-store", "credential_pool"):
    raise RuntimeError("grant_source_invalid")
if base_url != "https://chatgpt.com/backend-api/codex":
    raise RuntimeError("grant_base_url_invalid")
print(json.dumps({
    "access_token": token,
    "account_id": account_id,
    "expires_at": expires_at,
    "source": source,
    "provider": "openai-codex",
    "auth_mode": "chatgpt",
    "base_url": base_url,
}, separators=(",", ":")))
`;

function validateOwner(owner: CredentialOwnerBinding): string {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner) ||
      Object.keys(owner).length !== 3 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.credential_owner_id) ||
      !Number.isSafeInteger(owner.credential_generation) || owner.credential_generation < 1 ||
      !/^[0-9a-f]{64}$/.test(owner.account_id_sha256)) {
    throw new Error("credential owner binding is invalid");
  }
  return `${owner.credential_owner_id}:${owner.credential_generation}`;
}

function validateRuntime(
  runtime: CredentialOwnerRuntime,
  credentialOwnerId: string,
): CredentialOwnerRuntime {
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime) ||
      Object.keys(runtime).length !== 5 ||
      runtime.container_name !== `ligou-cell-${credentialOwnerId}` ||
      runtime.model_auth_volume !== `ligou-${credentialOwnerId}-hermes-model-auth` ||
      !/^[-./a-z0-9]+@sha256:[0-9a-f]{64}$/.test(runtime.image_reference) ||
      !/^sha256:[0-9a-f]{64}$/.test(runtime.image_id) ||
      runtime.interpreter_path !== "/opt/hermes/.venv/bin/python") {
    throw new Error("credential owner runtime is invalid");
  }
  return Object.freeze({ ...runtime });
}

function helperCommand(
  runtime: CredentialOwnerRuntime,
  containerId: string,
  deadlineSeconds: number,
): CommandSpec {
  return Object.freeze({
    label: "resolve-hermes-codex-access-grant",
    argv: Object.freeze([
      "docker", "exec", "-i", "--user", "10000:10000", containerId,
      runtime.interpreter_path, "-I", "-c", HERMES_GRANT_SCRIPT, String(deadlineSeconds),
    ]),
    env: Object.freeze({}),
    sensitive_stdout: true,
  });
}

function inspectCommand(runtime: CredentialOwnerRuntime): CommandSpec {
  return Object.freeze({
    label: "verify-credential-owner-runtime",
    argv: Object.freeze([
      "docker", "inspect", "--format",
      '{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Image":{{json .Config.Image}},"Env":{{json .Config.Env}}},"Image":{{json .Image}},"State":{"Running":{{json .State.Running}}},"Mounts":{{json .Mounts}}}',
      runtime.container_name,
    ]),
    env: Object.freeze({}),
    sensitive_stdout: true,
  });
}

function codeIntegrityCommand(containerId: string): CommandSpec {
  return Object.freeze({
    label: "verify-credential-owner-code",
    argv: Object.freeze(["docker", "diff", containerId]),
    env: Object.freeze({}),
  });
}

const PROTECTED_RUNTIME_TARGETS = [
  "/opt/hermes", "/usr", "/bin", "/sbin", "/lib", "/lib64",
  "/etc/ld.so.preload", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d",
] as const;

function protectedRuntimePath(path: string): boolean {
  if (["/etc/ld.so.preload", "/etc/ld.so.cache", "/etc/ld.so.conf"].includes(path)) {
    return true;
  }
  if (path === "/etc/ld.so.conf.d" || path.startsWith("/etc/ld.so.conf.d/")) {
    return true;
  }
  return ["/opt/hermes", "/usr", "/bin", "/sbin", "/lib", "/lib64"].some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function protectedMountDestination(path: string): boolean {
  if (protectedRuntimePath(path)) return true;
  const prefix = path === "/" ? "/" : `${path}/`;
  return PROTECTED_RUNTIME_TARGETS.some((target) => target.startsWith(prefix));
}

function verifyCodeIntegrityReadback(raw: string): void {
  for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
    const match = /^[ACD] (\/[\S]*)$/.exec(line);
    if (match === null) throw new Error("credential owner code readback is invalid");
    if (protectedRuntimePath(match[1]!)) {
      throw new Error("credential owner code differs from pinned image");
    }
  }
}

function verifyRuntimeReadback(raw: string, runtime: CredentialOwnerRuntime): string {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("credential owner runtime readback is invalid"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credential owner runtime readback is invalid");
  }
  const inspect = value as Record<string, any>;
  const environment = inspect.Config?.Env;
  const expectedEnvironment = new Set([
    "HERMES_AUTH_HOME=/opt/model-auth",
    "API_SERVER_ENABLED=true",
    "API_SERVER_HOST=0.0.0.0",
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
  const apiServerKeys = Array.isArray(environment)
    ? environment.filter((item: unknown) => typeof item === "string" &&
      item.startsWith("API_SERVER_KEY=") && item.length > "API_SERVER_KEY=".length)
    : [];
  const mounts = inspect.Mounts;
  const authMounts = Array.isArray(mounts)
    ? mounts.filter((mount) => mount?.Destination === "/opt/model-auth")
    : [];
  const shadowingMount = Array.isArray(mounts) && mounts.some((mount) =>
    typeof mount?.Destination === "string" && (
      mount.Destination.startsWith("/opt/model-auth/") ||
      protectedMountDestination(mount.Destination)
    )
  );
  if (typeof inspect.Id !== "string" || !/^[a-f0-9]{64}$/.test(inspect.Id) ||
      inspect.Name !== `/${runtime.container_name}` || inspect.Config?.Image !== runtime.image_reference ||
      inspect.Image !== runtime.image_id || inspect.State?.Running !== true ||
      !Array.isArray(environment) || environment.length > 128 ||
      apiServerKeys.length !== 1 || environment.length !== expectedEnvironment.size + 1 ||
      [...expectedEnvironment].some((item) => !environment.includes(item)) ||
      environment.some((item: unknown) => typeof item !== "string" || item.length > 4_096 ||
        (!expectedEnvironment.has(item) && !item.startsWith("API_SERVER_KEY="))) ||
      authMounts.length !== 1 || authMounts[0]?.Type !== "volume" ||
      authMounts[0]?.Name !== runtime.model_auth_volume || authMounts[0]?.RW !== true ||
      shadowingMount) {
    throw new Error("credential owner runtime binding mismatch");
  }
  return inspect.Id;
}

function envelope(value: unknown, owner: CredentialOwnerBinding, deadlineSeconds: number): GrantEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hermes Codex grant readback is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const keys = [
    "access_token", "account_id", "expires_at", "source",
    "provider", "auth_mode", "base_url",
  ];
  if (Object.keys(candidate).length !== keys.length || keys.some((key) => !Object.hasOwn(candidate, key)) ||
      typeof candidate.access_token !== "string" || candidate.access_token.length < 16 ||
      candidate.access_token.length > 65_536 || typeof candidate.account_id !== "string" ||
      candidate.account_id.length < 1 || candidate.account_id.length > 256 ||
      !Number.isSafeInteger(candidate.expires_at) ||
      (candidate.source !== "hermes-auth-store" && candidate.source !== "credential_pool") ||
      candidate.provider !== "openai-codex" || candidate.auth_mode !== "chatgpt" ||
      candidate.base_url !== CODEX_BASE_URL) {
    throw new Error("Hermes Codex grant readback is invalid");
  }
  if (Number(candidate.expires_at) < deadlineSeconds + EXPIRY_SKEW_SECONDS) {
    throw new Error("Hermes Codex grant cannot cover the attempt deadline");
  }
  const accountHash = createHash("sha256").update(candidate.account_id, "utf8").digest("hex");
  if (accountHash !== owner.account_id_sha256) {
    throw new Error("Hermes Codex grant account binding mismatch");
  }
  return Object.freeze(candidate as unknown as GrantEnvelope);
}

export class HermesCodexGrantResolver {
  readonly #runner: CredentialOwnerCommandRunner;
  readonly #registry: CredentialOwnerRegistry;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #inflight = new Map<string, Promise<CodexAccessGrant>>();

  constructor(options: HermesCodexGrantResolverOptions) {
    this.#runner = options.command_runner;
    this.#registry = options.credential_owner_registry;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.command_timeout_ms ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 60_000) {
      throw new Error("Hermes Codex grant command timeout is invalid");
    }
  }

  resolve(owner: CredentialOwnerBinding, deadlineAt: string): Promise<CodexAccessGrant> {
    const ownerKey = validateOwner(owner);
    const deadlineMs = Date.parse(deadlineAt);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= this.#now() || deadlineMs - this.#now() > 600_000) {
      throw new Error("Hermes Codex grant deadline is invalid");
    }
    const deadlineSeconds = Math.ceil(deadlineMs / 1_000);
    const existing = this.#inflight.get(ownerKey);
    if (existing !== undefined) {
      return existing.then((grant) => {
        if (grant.expires_at < deadlineSeconds + EXPIRY_SKEW_SECONDS) {
          return this.resolve(owner, deadlineAt);
        }
        return grant;
      });
    }
    const runtime = validateRuntime(
      this.#registry.resolve(owner.credential_owner_id, owner.credential_generation),
      owner.credential_owner_id,
    );
    const resolving = this.#resolveOnce(owner, runtime, deadlineSeconds).finally(() => {
      if (this.#inflight.get(ownerKey) === resolving) this.#inflight.delete(ownerKey);
    });
    this.#inflight.set(ownerKey, resolving);
    return resolving;
  }

  async #resolveOnce(
    owner: CredentialOwnerBinding,
    runtime: CredentialOwnerRuntime,
    deadlineSeconds: number,
  ): Promise<CodexAccessGrant> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const inspect = await this.#runner.runSensitive(inspectCommand(runtime), controller.signal);
      if (inspect.exitCode !== 0 || inspect.stderr.trim() !== "") {
        throw new Error("credential owner runtime verification failed");
      }
      const containerId = verifyRuntimeReadback(inspect.stdout, runtime);
      const code = await this.#runner.run(codeIntegrityCommand(containerId), controller.signal);
      if (code.exitCode !== 0 || code.stderr.trim() !== "") {
        throw new Error("credential owner code verification failed");
      }
      verifyCodeIntegrityReadback(code.stdout);
      const result = await this.#runner.runSensitive(
        helperCommand(runtime, containerId, deadlineSeconds),
        controller.signal,
      );
      if (result.exitCode !== 0 || result.stderr.trim() !== "") {
        throw new Error("Hermes Codex grant helper failed");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout); }
      catch { throw new Error("Hermes Codex grant readback is invalid"); }
      const validated = envelope(parsed, owner, deadlineSeconds);
      return Object.freeze({
        access_token: validated.access_token,
        account_id: validated.account_id,
        expires_at: validated.expires_at,
        source: validated.source,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
