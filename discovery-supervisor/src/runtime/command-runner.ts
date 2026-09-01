import { spawn } from "node:child_process";
import type {
  CommandResult,
  CommandRunner,
  CommandSpec,
} from "../openclaw/cell-runtime";
import type { CredentialOwnerCommandRunner } from "../openclaw/hermes-codex-grant";

export interface CommandEvent {
  readonly label: string;
  readonly outcome: "exited" | "aborted" | "failed";
  readonly exit_code: number | null;
  readonly sensitive: boolean;
}

export interface ArgvCommandRunnerOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly max_output_bytes?: number;
  readonly on_event?: (event: CommandEvent) => void;
  readonly spawn_process?: typeof spawn;
}

const SAFE_ENVIRONMENT_KEYS = new Set(["PATH", "LANG", "LC_ALL", "TZ"]);
const SAFE_COMMAND_ENVIRONMENT_KEY = /^LIGOU_[A-Z0-9_]{1,100}$/;
const SENSITIVE_ENVIRONMENT_KEY = /(?:TOKEN|SECRET|PASSWORD|API_KEY|SERVICE_KEY|AUTHORIZATION|COOKIE)/i;
const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~-]{6,}/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\bsb_secret_[A-Za-z0-9_-]{12,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}[.][A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}\b/,
] as const;

function boundedString(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function containsSecretLikeValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function validateCommand(command: CommandSpec, sensitive: boolean): void {
  boundedString(command.label, "command label", 200);
  if (!Array.isArray(command.argv) || command.argv.length < 1 || command.argv.length > 256) {
    throw new Error("command argv is invalid");
  }
  for (const [index, argument] of command.argv.entries()) {
    boundedString(argument, `command argv[${index}]`, 131_072);
    if (containsSecretLikeValue(argument)) throw new Error("command argv contains secret-like material");
  }
  if (command.sensitive_stdout === true && !sensitive) {
    throw new Error("sensitive stdout command requires runSensitive");
  }
  if (command.sensitive_stdout !== true && sensitive) {
    throw new Error("runSensitive requires sensitive_stdout");
  }
  for (const [key, value] of Object.entries(command.env)) {
    if (!SAFE_COMMAND_ENVIRONMENT_KEY.test(key) || SENSITIVE_ENVIRONMENT_KEY.test(key) ||
        value.length > 4_096 || value.includes("\0") || containsSecretLikeValue(value)) {
      throw new Error("command environment is not allowlisted");
    }
  }
  if (command.stdin !== undefined && command.sensitive_stdin !== true &&
      containsSecretLikeValue(command.stdin)) {
    throw new Error("command stdin contains unmarked secret-like material");
  }
}

function baseEnvironment(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const input = value ?? {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!SAFE_ENVIRONMENT_KEYS.has(key) || item.length > 4_096 || item.includes("\0") ||
        containsSecretLikeValue(item)) {
      throw new Error("base command environment is not allowlisted");
    }
    output[key] = item;
  }
  return Object.freeze(output);
}

export class ArgvCommandRunner implements CommandRunner, CredentialOwnerCommandRunner {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #maximum: number;
  readonly #event: (event: CommandEvent) => void;
  readonly #spawn: typeof spawn;

  constructor(options: ArgvCommandRunnerOptions = {}) {
    this.#environment = baseEnvironment(options.environment);
    this.#maximum = options.max_output_bytes ?? 16_777_216;
    if (!Number.isSafeInteger(this.#maximum) || this.#maximum < 1_024 || this.#maximum > 67_108_864) {
      throw new Error("command output limit is invalid");
    }
    this.#event = options.on_event ?? (() => undefined);
    this.#spawn = options.spawn_process ?? spawn;
  }

  async run(command: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
    return this.#execute(command, false, signal);
  }

  async runSensitive(command: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
    return this.#execute(command, true, signal);
  }

  #execute(command: CommandSpec, sensitive: boolean, signal?: AbortSignal): Promise<CommandResult> {
    validateCommand(command, sensitive);
    if (signal?.aborted) {
      this.#event({ label: command.label, outcome: "aborted", exit_code: null, sensitive });
      return Promise.reject(new Error(`${command.label} aborted`));
    }
    const environment = Object.freeze({ ...this.#environment, ...command.env });
    return new Promise<CommandResult>((resolve, reject) => {
      const child = this.#spawn(command.argv[0]!, [...command.argv.slice(1)], {
        shell: false,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let overflow = false;
      let stdinFailed = false;
      const abort = (): void => {
        if (settled) return;
        child.kill("SIGKILL");
      };
      const cleanup = (): void => signal?.removeEventListener("abort", abort);
      const append = (target: Buffer[], raw: Buffer, output: "stdout" | "stderr"): void => {
        if (settled || overflow) return;
        const bytes = Buffer.from(raw);
        if (output === "stdout") stdoutBytes += bytes.length;
        else stderrBytes += bytes.length;
        if (stdoutBytes > this.#maximum || stderrBytes > this.#maximum) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(bytes);
      };
      child.stdout.on("data", (raw: Buffer) => append(stdout, raw, "stdout"));
      child.stderr.on("data", (raw: Buffer) => append(stderr, raw, "stderr"));
      child.once("error", () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#event({ label: command.label, outcome: "failed", exit_code: null, sensitive });
        reject(new Error(`${command.label} failed to start`));
      });
      child.once("close", (code, closeSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (overflow) {
          this.#event({ label: command.label, outcome: "failed", exit_code: null, sensitive });
          reject(new Error(`${command.label} exceeded output limit`));
          return;
        }
        if (signal?.aborted) {
          this.#event({ label: command.label, outcome: "aborted", exit_code: null, sensitive });
          reject(new Error(`${command.label} aborted`));
          return;
        }
        if (stdinFailed) {
          this.#event({ label: command.label, outcome: "failed", exit_code: null, sensitive });
          reject(new Error(`${command.label} stdin failed`));
          return;
        }
        const exitCode = code ?? (closeSignal === null ? 1 : 128);
        this.#event({ label: command.label, outcome: "exited", exit_code: exitCode, sensitive });
        resolve(Object.freeze({
          exitCode,
          stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
        }));
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.on("error", () => {
        stdinFailed = true;
        child.kill("SIGKILL");
      });
      try {
        if (command.stdin === undefined) child.stdin.end();
        else child.stdin.end(command.stdin, "utf8");
      } catch {
        stdinFailed = true;
        child.kill("SIGKILL");
      }
    });
  }
}
