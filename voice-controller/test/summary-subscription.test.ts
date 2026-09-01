import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _setClient } from "../src/rules.ts";
import {
  HERMES_SUMMARY_IMAGE,
  summarizeCallViaHermesSubscription,
  type HermesSummaryCommand,
} from "../src/summary-subscription.ts";
import { tickSummaries } from "../src/worker.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tenantId = "a0000000-0000-4000-8000-000000000001";
const tenantSlug = "rocha-plumbing";
const containerName = `ligou-cell-${tenantId}`;
const containerId = "d".repeat(64);
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

function holdTenantThenCall(tenant: string, call: string): {
  locked: Promise<void>;
  done: Promise<void>;
} {
  if (process.env.LIGOU_LOCAL_DB_TEST !== "1" ||
      !/^[a-f0-9-]{36}$/i.test(tenant) || !/^[a-f0-9-]{36}$/i.test(call) ||
      !process.env.LIGOU_PSQL_BIN || !process.env.PGPASSWORD) {
    throw new Error("summary lock barrier requires disposable Postgres");
  }
  const sql = [
    "begin;",
    `select id from public.tenants where id = '${tenant}'::uuid for update;`,
    "select 'tenant_locked';",
    "select pg_sleep(1);",
    `select id from public.calls where id = '${call}'::uuid for update;`,
    "commit;",
  ].join("\n");
  const child = spawn(process.env.LIGOU_PSQL_BIN, [
    "-X", "--set=ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--quiet",
    "--file=-",
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C",
      PGAPPNAME: "ligou_summary_lock_barrier",
      PGCONNECT_TIMEOUT: "5",
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGDATABASE: process.env.PGDATABASE,
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let lockedResolve!: () => void;
  let lockedReject!: (error: Error) => void;
  let sawLock = false;
  let stderr = "";
  const locked = new Promise<void>((resolve, reject) => {
    lockedResolve = resolve;
    lockedReject = reject;
  });
  child.stdout.on("data", (chunk) => {
    if (!sawLock && String(chunk).includes("tenant_locked")) {
      sawLock = true;
      lockedResolve();
    }
  });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", () => {
      const error = new Error("summary lock barrier failed to start");
      if (!sawLock) lockedReject(error);
      reject(error);
    });
    child.once("close", (code) => {
      if (!sawLock) lockedReject(new Error("summary lock barrier did not acquire tenant"));
      if (code === 0) resolve();
      else reject(new Error(`summary lock barrier failed${stderr ? " with database error" : ""}`));
    });
  });
  child.stdin.end(sql);
  return { locked, done };
}

async function rotateTenantGenerationForFixture(tenant: string): Promise<void> {
  if (process.env.LIGOU_LOCAL_DB_TEST !== "1" ||
      process.env.LIGOU_LOCAL_PROJECT_ID !== "ligou-v0-1-rc1" ||
      !new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(
        process.env.PGHOST ?? "",
      ) ||
      !/^[a-f0-9-]{36}$/i.test(tenant) ||
      !process.env.LIGOU_PSQL_BIN || !process.env.PGPASSWORD) {
    throw new Error("summary generation fixture requires disposable Postgres");
  }
  const child = spawn(process.env.LIGOU_PSQL_BIN, [
    "-X", "--set=ON_ERROR_STOP=1", "--quiet",
    "--command",
    `update public.tenants set test_memory_generation = test_memory_generation + 1 where id = '${tenant}'::uuid;`,
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C",
      PGAPPNAME: "ligou_summary_generation_fixture",
      PGCONNECT_TIMEOUT: "5",
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGDATABASE: process.env.PGDATABASE,
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error(
      "summary generation fixture failed to start",
    )));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(
        `summary generation fixture failed${stderr ? " with database error" : ""}`,
      ));
    });
  });
}

function safeIdentity() {
  return {
    tenant_id: tenantId,
    tenant_slug: tenantSlug,
    container_name: containerName,
    model_auth_volume: `ligou-${tenantId}-hermes-model-auth`,
    hermes_url: "http://127.0.0.1:31001",
  };
}

describe("post-call summary uses only the Hermes Codex subscription", () => {
  test("has no paid text API or generic fallback path in production summary code", () => {
    const source = [
      "voice-controller/src/worker.ts",
      "voice-controller/src/summary-subscription.ts",
    ].map((file) => readFileSync(path.join(repoRoot, file), "utf8")).join("\n");
    expect(source).not.toContain("https://api.openai.com/v1");
    expect(source).not.toContain("config.openaiKey");
    expect(source).not.toContain("OPENAI_API_KEY");
    expect(source).not.toContain("call_llm");
    expect(source).not.toContain("AIAgent");
    expect(source).not.toContain('"previous_response_id"');
    expect(source).not.toContain('resolve_provider_client("auto"');
    expect(source).toContain('resolve_provider_client("openai-codex", "gpt-5.6-sol")');
  });

  test("keeps OPENAI_API_KEY and OAuth outside explicit no-tool raw inference", async () => {
    const priorKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "forbidden-openai-api-key-sentinel";
    const commands: HermesSummaryCommand[] = [];
    try {
      const result = await summarizeCallViaHermesSubscription({
        tenant: { id: tenantId, slug: tenantSlug },
        transcript: [
          { role: "caller", text: "Meu ralo está entupido." },
          { role: "agent", text: "Posso ajudar com isso." },
        ],
      }, {
        resolve_identity: () => safeIdentity(),
        runner: {
          async run(command) {
            commands.push(command);
            if (command.label === "verify-hermes-summary-runtime") {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  Id: containerId,
                  Name: `/${containerName}`,
                  Config: { Image: HERMES_SUMMARY_IMAGE, Env: hermesRuntimeEnv },
                  Image: `sha256:${"a".repeat(64)}`,
                  State: { Running: true },
                  Mounts: [{
                    Type: "volume",
                    Name: `ligou-${tenantId}-hermes-model-auth`,
                    Destination: "/opt/model-auth",
                    RW: true,
                  }],
                }),
                stderr: "",
              };
            }
            if (command.label === "verify-hermes-summary-code") {
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                summary_pt: "Cliente pediu ajuda com um ralo entupido.",
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                billing_basis: "chatgpt_subscription",
                usage: { input_tokens: 42, output_tokens: 11, total_tokens: 53 },
              }),
              stderr: "",
            };
          },
        },
      });

      expect(result.summary_pt).toBe("Cliente pediu ajuda com um ralo entupido.");
      expect(result.billing_basis).toBe("chatgpt_subscription");
      expect(commands).toHaveLength(3);
      expect(commands[1]!.argv).toEqual(["docker", "diff", containerId]);
      const inference = commands[2]!;
      expect(inference.argv.slice(0, 6)).toEqual([
        "docker", "exec", "-i", "--user", "10000:10000", containerId,
      ]);
      expect(inference.argv).toEqual(expect.arrayContaining([
        "/usr/bin/timeout", "--kill-after=2s", "35s",
        "/opt/hermes/.venv/bin/python", "-I", "-c",
      ]));
      const script = inference.argv.at(-1)!;
      expect(script).toContain("resolve_provider_client");
      expect(script).toContain("CodexAuxiliaryClient");
      expect(script).toContain("real_client.responses.create");
      expect(script).toContain("store=False");
      expect(script).toContain("stream=True");
      expect(script).toContain('base_url != "https://chatgpt.com/backend-api/codex"');
      expect(script).toContain('os.environ.get("HERMES_AUTH_HOME") != "/opt/model-auth"');
      expect(script).toContain("get_custom_provider_tls_settings");
      expect(script).toContain("tls_settings != {}");
      expect(script).toContain('sys.path.insert(0, "/opt/hermes")');
      expect(script).toContain('os.environ.pop(name, None)');
      expect(script).not.toContain("tools=");
      expect(script).not.toContain("call_llm");
      expect(script).not.toContain("previous_response_id=");
      expect(script).not.toContain("session=");
      expect(script).not.toContain("memory=");
      expect(script).not.toContain("OPENAI_API_KEY");
      expect(JSON.stringify(inference)).not.toContain(process.env.OPENAI_API_KEY);
      expect(inference.stdin).toContain("Meu ralo está entupido.");
      expect(inference.stdin).not.toContain(tenantId);
      expect(inference.sensitive_stdin).toBe(true);
      expect(inference.sensitive_stdout).toBe(true);
    } finally {
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
    }
  });

  test("keeps decoded transcript and escaped JSON envelope under separate bounds", async () => {
    const escaped = '"\\\n'.repeat(1_000);
    const result = await summarizeCallViaHermesSubscription({
      tenant: { id: tenantId, slug: tenantSlug },
      transcript: Array.from({ length: 4 }, (_, index) => ({
        role: index % 2 === 0 ? "caller" : "agent",
        text: escaped,
      })),
    }, {
      resolve_identity: () => safeIdentity(),
      runner: {
        async run(command) {
          if (command.label === "verify-hermes-summary-runtime") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Id: containerId,
                Name: `/${containerName}`,
                Config: { Image: HERMES_SUMMARY_IMAGE, Env: hermesRuntimeEnv },
                Image: `sha256:${"a".repeat(64)}`,
                State: { Running: true },
                Mounts: [{
                  Type: "volume",
                  Name: `ligou-${tenantId}-hermes-model-auth`,
                  Destination: "/opt/model-auth",
                  RW: true,
                }],
              }),
              stderr: "",
            };
          }
          if (command.label === "verify-hermes-summary-code") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          const envelopeBytes = Buffer.byteLength(command.stdin!, "utf8");
          expect(envelopeBytes).toBeGreaterThan(16_384);
          expect(envelopeBytes).toBeLessThanOrEqual(131_072);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary_pt: "Resumo limitado.",
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              billing_basis: "chatgpt_subscription",
              usage: { input_tokens: 4_000, output_tokens: 10, total_tokens: 4_010 },
            }),
            stderr: "",
          };
        },
      },
    });
    expect(result.summary_pt).toBe("Resumo limitado.");
  });

  test("rejects a stopped or substituted Hermes image before inference", async () => {
    let inferenceCalls = 0;
    await expect(summarizeCallViaHermesSubscription({
      tenant: { id: tenantId, slug: tenantSlug },
      transcript: [{ role: "caller", text: "Teste." }],
    }, {
      resolve_identity: () => safeIdentity(),
      runner: {
        async run(command) {
          if (command.label === "run-hermes-summary-subscription") inferenceCalls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: containerId,
              Name: `/${containerName}`,
              Config: { Image: "attacker.invalid/hermes:latest", Env: hermesRuntimeEnv },
              Image: `sha256:${"b".repeat(64)}`,
              State: { Running: true },
              Mounts: [{
                Type: "volume",
                Name: `ligou-${tenantId}-hermes-model-auth`,
                Destination: "/opt/model-auth",
                RW: true,
              }],
            }),
            stderr: "",
          };
        },
      },
    })).rejects.toThrow("runtime binding");
    expect(inferenceCalls).toBe(0);
  });

  test("rejects dangerous loader or Python environment before inference", async () => {
    let inferenceCalls = 0;
    await expect(summarizeCallViaHermesSubscription({
      tenant: { id: tenantId, slug: tenantSlug },
      transcript: [{ role: "caller", text: "Teste." }],
    }, {
      resolve_identity: () => safeIdentity(),
      runner: {
        async run(command) {
          if (command.label === "run-hermes-summary-subscription") inferenceCalls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: containerId,
              Name: `/${containerName}`,
              Config: {
                Image: HERMES_SUMMARY_IMAGE,
                Env: [
                  ...hermesRuntimeEnv,
                  "LD_PRELOAD=/opt/data/evil.so",
                  "PYTHONPATH=/opt/data/evil",
                  "HERMES_CA_BUNDLE=/opt/data/evil-ca.pem",
                  "SSLKEYLOGFILE=/opt/data/codex.keys",
                ],
              },
              Image: `sha256:${"a".repeat(64)}`,
              State: { Running: true },
              Mounts: [{
                Type: "volume",
                Name: `ligou-${tenantId}-hermes-model-auth`,
                Destination: "/opt/model-auth",
                RW: true,
              }],
            }),
            stderr: "",
          };
        },
      },
    })).rejects.toThrow("runtime binding");
    expect(inferenceCalls).toBe(0);
  });

  test("rejects a swapped tenant OAuth volume before inference", async () => {
    let inferenceCalls = 0;
    await expect(summarizeCallViaHermesSubscription({
      tenant: { id: tenantId, slug: tenantSlug },
      transcript: [{ role: "caller", text: "Teste." }],
    }, {
      resolve_identity: () => safeIdentity(),
      runner: {
        async run(command) {
          if (command.label === "run-hermes-summary-subscription") inferenceCalls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: containerId,
              Name: `/${containerName}`,
              Config: { Image: HERMES_SUMMARY_IMAGE, Env: hermesRuntimeEnv },
              Image: `sha256:${"a".repeat(64)}`,
              State: { Running: true },
              Mounts: [{
                Type: "volume",
                Name: "ligou-b0000000-0000-4000-8000-000000000002-hermes-model-auth",
                Destination: "/opt/model-auth",
                RW: true,
              }],
            }),
            stderr: "",
          };
        },
      },
    })).rejects.toThrow("runtime binding");
    expect(inferenceCalls).toBe(0);
  });

  test("rejects a nested mount shadowing the approved OAuth volume", async () => {
    let inferenceCalls = 0;
    await expect(summarizeCallViaHermesSubscription({
      tenant: { id: tenantId, slug: tenantSlug },
      transcript: [{ role: "caller", text: "Teste." }],
    }, {
      resolve_identity: () => safeIdentity(),
      runner: {
        async run(command) {
          if (command.label === "run-hermes-summary-subscription") inferenceCalls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: containerId,
              Name: `/${containerName}`,
              Config: { Image: HERMES_SUMMARY_IMAGE, Env: hermesRuntimeEnv },
              Image: `sha256:${"a".repeat(64)}`,
              State: { Running: true },
              Mounts: [{
                Type: "volume",
                Name: `ligou-${tenantId}-hermes-model-auth`,
                Destination: "/opt/model-auth",
                RW: true,
              }, {
                Type: "bind",
                Source: "/tmp/attacker-auth.json",
                Destination: "/opt/model-auth/auth.json",
                RW: false,
              }],
            }),
            stderr: "",
          };
        },
      },
    })).rejects.toThrow("runtime binding");
    expect(inferenceCalls).toBe(0);
  });

  test("rejects an ancestor mount overlaying the pinned Hermes inference code", async () => {
    let inferenceCalls = 0;
    await expect(summarizeCallViaHermesSubscription({
      tenant: { id: tenantId, slug: tenantSlug },
      transcript: [{ role: "caller", text: "Teste." }],
    }, {
      resolve_identity: () => safeIdentity(),
      runner: {
        async run(command) {
          if (command.label === "run-hermes-summary-subscription") inferenceCalls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: containerId,
              Name: `/${containerName}`,
              Config: { Image: HERMES_SUMMARY_IMAGE, Env: hermesRuntimeEnv },
              Image: `sha256:${"a".repeat(64)}`,
              State: { Running: true },
              Mounts: [{
                Type: "volume",
                Name: `ligou-${tenantId}-hermes-model-auth`,
                Destination: "/opt/model-auth",
                RW: true,
              }, {
                Type: "bind",
                Source: "/tmp/attacker-opt",
                Destination: "/opt",
                RW: false,
              }],
            }),
            stderr: "",
          };
        },
      },
    })).rejects.toThrow("runtime binding");
    expect(inferenceCalls).toBe(0);
  });

  test("rejects writable-layer changes to the pinned Hermes inference code", async () => {
    let inferenceCalls = 0;
    await expect(summarizeCallViaHermesSubscription({
      tenant: { id: tenantId, slug: tenantSlug },
      transcript: [{ role: "caller", text: "Teste." }],
    }, {
      resolve_identity: () => safeIdentity(),
      runner: {
        async run(command) {
          if (command.label === "run-hermes-summary-subscription") inferenceCalls += 1;
          if (command.label === "verify-hermes-summary-code") {
            return {
              exitCode: 0,
              stdout: "C /etc/ld.so.preload\n",
              stderr: "",
            };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: containerId,
              Name: `/${containerName}`,
              Config: { Image: HERMES_SUMMARY_IMAGE, Env: hermesRuntimeEnv },
              Image: `sha256:${"a".repeat(64)}`,
              State: { Running: true },
              Mounts: [{
                Type: "volume",
                Name: `ligou-${tenantId}-hermes-model-auth`,
                Destination: "/opt/model-auth",
                RW: true,
              }],
            }),
            stderr: "",
          };
        },
      },
    })).rejects.toThrow("differs from pinned image");
    expect(inferenceCalls).toBe(0);
  });

  test("fails closed on authority-shaped or malformed model output", async () => {
    await expect(summarizeCallViaHermesSubscription({
      tenant: { id: tenantId, slug: tenantSlug },
      transcript: [{ role: "caller", text: "Teste." }],
    }, {
      resolve_identity: () => safeIdentity(),
      runner: {
        async run(command) {
          if (command.label === "verify-hermes-summary-runtime") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Id: containerId,
                Name: `/${containerName}`,
                Config: { Image: HERMES_SUMMARY_IMAGE, Env: hermesRuntimeEnv },
                Image: `sha256:${"a".repeat(64)}`,
                State: { Running: true },
                Mounts: [{
                  Type: "volume",
                  Name: `ligou-${tenantId}-hermes-model-auth`,
                  Destination: "/opt/model-auth",
                  RW: true,
                }],
              }),
              stderr: "",
            };
          }
          if (command.label === "verify-hermes-summary-code") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary_pt: "ok",
              provider: "openai-api",
              model: "gpt-5.4-mini",
              billing_basis: "api",
              usage: {},
              approved: true,
            }),
            stderr: "",
          };
        },
      },
    })).rejects.toThrow("summary result");
  });

  test("rejects complete output whose observed subscription usage exceeds the cap", async () => {
    await expect(summarizeCallViaHermesSubscription({
      tenant: { id: tenantId, slug: tenantSlug },
      transcript: [{ role: "caller", text: "Teste." }],
    }, {
      resolve_identity: () => safeIdentity(),
      runner: {
        async run(command) {
          if (command.label === "verify-hermes-summary-runtime") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Id: containerId,
                Name: `/${containerName}`,
                Config: { Image: HERMES_SUMMARY_IMAGE, Env: hermesRuntimeEnv },
                Image: `sha256:${"a".repeat(64)}`,
                State: { Running: true },
                Mounts: [{
                  Type: "volume",
                  Name: `ligou-${tenantId}-hermes-model-auth`,
                  Destination: "/opt/model-auth",
                  RW: true,
                }],
              }),
              stderr: "",
            };
          }
          if (command.label === "verify-hermes-summary-code") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary_pt: "Resumo curto.",
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              billing_basis: "chatgpt_subscription",
              usage: { input_tokens: 10, output_tokens: 4_097, total_tokens: 4_107 },
            }),
            stderr: "",
          };
        },
      },
    })).rejects.toThrow("tokens");
  });
});

describe("durable summary claim and completion", () => {
  let claims: any[];
  let completions: any[];
  let claimArgs: any[];

  beforeEach(() => {
    claims = [{
      call_id: "11111111-1111-4111-8111-111111111111",
      tenant_id: tenantId,
      tenant_slug: tenantSlug,
      transcript: [{ role: "caller", text: "Preciso desentupir o ralo." }],
      test_memory_generation: 0,
      attempt_number: 1,
      claim_token: "c".repeat(64),
      lease_until: new Date(Date.now() + 120_000).toISOString(),
    }];
    completions = [];
    claimArgs = [];
    _setClient({
      async rpc(name: string, args: any) {
        if (name === "claim_call_summary_subscription") {
          claimArgs.push(args);
          return { data: claims.splice(0, 1), error: null };
        }
        if (name === "complete_call_summary_subscription") {
          completions.push(args);
          return { data: { summary_status: args.p_outcome === "ready" ? "ready" : "pending_ingest" }, error: null };
        }
        return { data: null, error: null };
      },
      from() { throw new Error("summary worker must use only authoritative RPCs"); },
    } as any);
  });

  afterAll(() => _setClient(null));

  test("claims once, summarizes on subscription, and completes with the opaque token", async () => {
    let summaries = 0;
    const count = await tickSummaries(async ({ tenant, transcript }) => {
      summaries += 1;
      expect(tenant).toEqual({ id: tenantId, slug: tenantSlug });
      expect(transcript).toHaveLength(1);
      return {
        summary_pt: "Cliente pediu desentupimento de ralo.",
        provider: "openai-codex" as const,
        model: "gpt-5.6-sol" as const,
        billing_basis: "chatgpt_subscription" as const,
        usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
      };
    });
    expect(count).toBe(1);
    expect(summaries).toBe(1);
    expect(claimArgs[0]).toMatchObject({ p_lease_seconds: 120 });
    expect(completions).toEqual([{
      p_call_id: "11111111-1111-4111-8111-111111111111",
      p_expected_generation: 0,
      p_claim_token: "c".repeat(64),
      p_outcome: "ready",
      p_summary_pt: "Cliente pediu desentupimento de ralo.",
    }]);
  });

  test("records retry without falling back when subscription inference fails", async () => {
    claims.push({ ...claims[0], attempt_number: 2, claim_token: "d".repeat(64) });
    expect(await tickSummaries(async () => {
      throw new Error("subscription unavailable");
    })).toBe(0);
    expect(claims).toHaveLength(1);
    expect(completions).toEqual([{
      p_call_id: "11111111-1111-4111-8111-111111111111",
      p_expected_generation: 0,
      p_claim_token: "c".repeat(64),
      p_outcome: "retry",
      p_summary_pt: null,
    }]);
  });
});

test("summary migration provides service-only lease/CAS authority", () => {
  const sql = readFileSync(path.join(
    repoRoot,
    "supabase/migrations/20260901203000_call_summary_subscription.sql",
  ), "utf8").replace(/\s+/g, " ").toLowerCase();
  expect(sql).toContain("claim_call_summary_subscription(text,integer)");
  expect(sql).toContain("for update of t skip locked");
  expect(sql.indexOf("for update of t skip locked")).toBeLessThan(
    sql.indexOf("where c.id = v_call_id"),
  );
  expect(sql).toContain("summary_lease_until");
  expect(sql).toContain("summary_retry_at");
  expect(sql).toContain("c.test_memory_generation = t.test_memory_generation");
  expect(sql).toContain("extensions.digest(v_claim_token, 'sha256')");
  expect(sql).toContain("complete_call_summary_subscription(uuid,bigint,text,text,text)");
  expect(sql).toContain("extensions.digest(p_claim_token, 'sha256')");
  expect(sql).toContain("grant execute on function public.claim_call_summary_subscription(text,integer) to service_role");
  expect(sql).toContain("grant execute on function public.complete_call_summary_subscription(uuid,bigint,text,text,text) to service_role");
  expect(sql).not.toContain("to authenticated");
});

test("summary generation fixture rejects every non-disposable Postgres identity", async () => {
  const saved = { ...process.env };
  try {
    process.env.LIGOU_LOCAL_DB_TEST = "1";
    process.env.LIGOU_LOCAL_PROJECT_ID = "production";
    process.env.LIGOU_PSQL_BIN = "/definitely/not/psql";
    process.env.PGPASSWORD = "synthetic";
    process.env.PGHOST = "db.production.invalid";
    await expect(rotateTenantGenerationForFixture(
      "11111111-1111-4111-8111-111111111111",
    )).rejects.toThrow("requires disposable Postgres");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(saved, key)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test.skipIf(process.env.LIGOU_LOCAL_DB_TEST !== "1")(
  "real Postgres leases one summary and accepts only its current claim token",
  async () => {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SECRET_KEY!;
    const tenant = randomUUID();
    const tenantSlug = `summary-${tenant.slice(0, 8)}`;
    const serviceA = createClient(url, key, { auth: { persistSession: false } });
    const serviceB = createClient(url, key, { auth: { persistSession: false } });
    expect((await serviceA.from("tenants").insert({
      id: tenant,
      slug: tenantSlug,
      name: "Summary Subscription Test",
      status: "active",
    })).error).toBeNull();
    const callId = randomUUID();
    expect((await serviceA.from("calls").insert({
      id: callId,
      tenant_id: tenant,
      channel: "phone",
      session_type: "customer",
      status: "ended",
      started_at: "2000-01-01T00:00:00.000Z",
      ended_at: "2000-01-01T00:01:00.000Z",
      transcript: [{ role: "caller", text: "Preciso de ajuda com o ralo." }],
      summary_status: "pending_ingest",
    })).error).toBeNull();

    const [left, right] = await Promise.all([
      serviceA.rpc("claim_call_summary_subscription", {
        p_worker_id: `summary-a-${randomUUID()}`,
        p_lease_seconds: 120,
      }),
      serviceB.rpc("claim_call_summary_subscription", {
        p_worker_id: `summary-b-${randomUUID()}`,
        p_lease_seconds: 120,
      }),
    ]);
    expect(left.error).toBeNull();
    expect(right.error).toBeNull();
    const rows = [...(left.data ?? []), ...(right.data ?? [])]
      .filter((row: any) => row.call_id === callId);
    expect(rows).toHaveLength(1);
    const claimed = rows[0] as {
      claim_token: string;
      attempt_number: number;
      test_memory_generation: number;
    };
    expect(claimed.claim_token).toMatch(/^[a-f0-9]{64}$/);
    expect(claimed.attempt_number).toBe(1);

    const duplicate = await serviceA.rpc("claim_call_summary_subscription", {
      p_worker_id: `summary-c-${randomUUID()}`,
      p_lease_seconds: 120,
    });
    expect(duplicate.error).toBeNull();
    expect((duplicate.data ?? []).some((row: any) => row.call_id === callId)).toBe(false);

    const forged = await serviceA.rpc("complete_call_summary_subscription", {
      p_call_id: callId,
      p_expected_generation: claimed.test_memory_generation,
      p_claim_token: "f".repeat(64),
      p_outcome: "ready",
      p_summary_pt: "Resumo forjado.",
    });
    expect(forged.error?.message).toContain("call_summary_subscription_claim_not_current");

    const lockBarrier = holdTenantThenCall(tenant, callId);
    await lockBarrier.locked;
    let completionSettled = false;
    const completionPromise = Promise.resolve(serviceA.rpc("complete_call_summary_subscription", {
      p_call_id: callId,
      p_expected_generation: claimed.test_memory_generation,
      p_claim_token: claimed.claim_token,
      p_outcome: "ready",
      p_summary_pt: "Cliente pediu ajuda com o ralo.",
    })).finally(() => { completionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(completionSettled).toBe(false);
    await lockBarrier.done;
    const completed = await completionPromise;
    expect(completed.error).toBeNull();
    expect(completed.data).toMatchObject({
      call_id: callId,
      summary_status: "ready",
      attempt_number: 1,
    });
    expect((await serviceA.from("calls")
      .select("summary_status,summary_pt,summary_claim_token_hash,summary_lease_until")
      .eq("id", callId).single()).data).toEqual({
      summary_status: "ready",
      summary_pt: "Cliente pediu ajuda com o ralo.",
      summary_claim_token_hash: null,
      summary_lease_until: null,
    });
    expect((await serviceA.from("notifications")
      .select("id").eq("tenant_id", tenant).eq("kind", "summary_ready")
      .contains("payload", { call_id: callId })).data).toHaveLength(1);

    const replay = await serviceB.rpc("complete_call_summary_subscription", {
      p_call_id: callId,
      p_expected_generation: claimed.test_memory_generation,
      p_claim_token: claimed.claim_token,
      p_outcome: "ready",
      p_summary_pt: "Replay.",
    });
    expect(replay.error?.message).toContain("call_summary_subscription_claim_not_current");

    const retryCallId = randomUUID();
    expect((await serviceA.from("calls").insert({
      id: retryCallId,
      tenant_id: tenant,
      channel: "phone",
      session_type: "customer",
      status: "ended",
      started_at: "1999-01-01T00:00:00.000Z",
      ended_at: "1999-01-01T00:01:00.000Z",
      transcript: [{ role: "caller", text: "Resumo com retry." }],
      summary_status: "pending_ingest",
    })).error).toBeNull();
    const retryOne = await serviceA.rpc("claim_call_summary_subscription", {
      p_worker_id: `summary-retry-one-${randomUUID()}`,
      p_lease_seconds: 120,
    });
    const retryClaimOne = (retryOne.data ?? []).find((row: any) => row.call_id === retryCallId);
    expect(retryClaimOne?.attempt_number).toBe(1);
    expect((await serviceA.from("calls").update({
      summary_claimed_at: new Date(Date.now() - 2_000).toISOString(),
      summary_lease_until: new Date(Date.now() - 1_000).toISOString(),
    }).eq("id", retryCallId)).error).toBeNull();
    const retryTwo = await serviceB.rpc("claim_call_summary_subscription", {
      p_worker_id: `summary-retry-two-${randomUUID()}`,
      p_lease_seconds: 120,
    });
    const retryClaimTwo = (retryTwo.data ?? []).find((row: any) => row.call_id === retryCallId);
    expect(retryClaimTwo?.attempt_number).toBe(2);
    const retryCompletion = await serviceB.rpc("complete_call_summary_subscription", {
      p_call_id: retryCallId,
      p_expected_generation: retryClaimTwo.test_memory_generation,
      p_claim_token: retryClaimTwo.claim_token,
      p_outcome: "retry",
      p_summary_pt: null,
    });
    expect(retryCompletion.error).toBeNull();
    const retryState = await serviceA.from("calls")
      .select("summary_status,summary_retry_at,summary_attempts")
      .eq("id", retryCallId).single();
    expect(retryState.data?.summary_status).toBe("pending_ingest");
    expect(Date.parse(retryState.data!.summary_retry_at)).toBeGreaterThan(Date.now());
    expect(retryState.data?.summary_attempts).toBe(2);
    const retryTooSoon = await serviceA.rpc("claim_call_summary_subscription", {
      p_worker_id: `summary-too-soon-${randomUUID()}`,
      p_lease_seconds: 120,
    });
    expect((retryTooSoon.data ?? []).some((row: any) => row.call_id === retryCallId)).toBe(false);
    expect((await serviceA.from("calls").update({
      summary_retry_at: new Date(Date.now() - 1_000).toISOString(),
    }).eq("id", retryCallId)).error).toBeNull();
    const retryThree = await serviceA.rpc("claim_call_summary_subscription", {
      p_worker_id: `summary-retry-three-${randomUUID()}`,
      p_lease_seconds: 120,
    });
    const retryClaimThree = (retryThree.data ?? []).find((row: any) => row.call_id === retryCallId);
    expect(retryClaimThree?.attempt_number).toBe(3);
    expect((await serviceA.rpc("complete_call_summary_subscription", {
      p_call_id: retryCallId,
      p_expected_generation: retryClaimThree.test_memory_generation,
      p_claim_token: retryClaimThree.claim_token,
      p_outcome: "retry",
      p_summary_pt: null,
    })).data?.summary_status).toBe("failed");

    const staleGenerationCallId = randomUUID();
    expect((await serviceA.from("calls").insert({
      id: staleGenerationCallId,
      tenant_id: tenant,
      channel: "onboarding",
      session_type: "onboarding",
      status: "ended",
      started_at: "1998-01-01T00:00:00.000Z",
      ended_at: "1998-01-01T00:01:00.000Z",
      transcript: [{ role: "caller", text: "Resumo anterior ao reset." }],
      summary_status: "pending_ingest",
    })).error).toBeNull();
    const staleClaimResponse = await serviceA.rpc("claim_call_summary_subscription", {
      p_worker_id: `summary-stale-generation-${randomUUID()}`,
      p_lease_seconds: 120,
    });
    const staleClaim = (staleClaimResponse.data ?? [])
      .find((row: any) => row.call_id === staleGenerationCallId);
    expect(staleClaim).toBeDefined();
    await rotateTenantGenerationForFixture(tenant);
    const staleCompletion = await serviceA.rpc("complete_call_summary_subscription", {
      p_call_id: staleGenerationCallId,
      p_expected_generation: staleClaim.test_memory_generation,
      p_claim_token: staleClaim.claim_token,
      p_outcome: "ready",
      p_summary_pt: "Resumo que não pode atravessar reset.",
    });
    expect(staleCompletion.error?.message).toContain(
      "call_summary_subscription_generation_stale",
    );
    expect((await serviceA.from("notifications").select("id")
      .eq("tenant_id", tenant).contains("payload", { call_id: staleGenerationCallId })).data)
      .toEqual([]);
    await serviceA.rpc("claim_call_summary_subscription", {
      p_worker_id: `summary-generation-sweep-${randomUUID()}`,
      p_lease_seconds: 120,
    });
    expect((await serviceA.from("calls").select("summary_status")
      .eq("id", staleGenerationCallId).single()).data?.summary_status).toBe("failed");
  },
);
