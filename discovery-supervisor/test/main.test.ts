import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { PassThrough, Writable } from "node:stream";
import {
  ReleaseCredentialOwnerRegistry,
  assertSupervisorIdentity,
  loadProtectedSecret,
  parseSupervisorConfig,
  readSupervisorConfig,
} from "../src/runtime/config";
import { ArgvCommandRunner } from "../src/runtime/command-runner";
import { SupabaseServiceRpcClient } from "../src/runtime/service-rpc";
import {
  proveDockerIdentityProcessesAbsent,
  proveLoopbackListenerClosed,
} from "../src/runtime/proofs";
import {
  HealthEndpoint,
  SingletonAuthority,
  SupervisorLoop,
  SupervisorService,
} from "../src/runtime/process";
import {
  composeProductionSupervisor,
  supervisorCredentialPaths,
} from "../src/main";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.OPENAI_API_KEY;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function runtimeConfig() {
  const cellIndex = `sha256:${"1".repeat(64)}`;
  const bridgeIndex = `sha256:${"2".repeat(64)}`;
  return {
    schema_version: "ligou.discovery_supervisor.config.v1",
    worker_id: "ligou-stage0-worker",
    adapter_sequence: ["direct_model", "openclaw"],
    lease_seconds: 300,
    poll_interval_ms: 250,
    shutdown_timeout_ms: 10_000,
    supervisor_uid: 1_000,
    supervisor_gid: 1_000,
    supabase_url: "https://example.supabase.co",
    health_host: "127.0.0.1",
    health_port: 4318,
    singleton_directory: "/var/lib/ligou-discovery-supervisor/authority",
    credential_owners: [{
      credential_owner_id: "11111111-1111-4111-8111-111111111111",
      credential_generation: 3,
      account_id_sha256: "a".repeat(64),
      container_name: "ligou-cell-11111111-1111-4111-8111-111111111111",
      model_auth_volume: "ligou-11111111-1111-4111-8111-111111111111-hermes-model-auth",
      image_reference: `ligou-hermes@sha256:${"3".repeat(64)}`,
      image_id: `sha256:${"4".repeat(64)}`,
      interpreter_path: "/opt/hermes/.venv/bin/python",
    }],
    image_evidence: {
      cell_image: {
        reference: "ghcr.io/openclaw/openclaw@sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4",
        index_digest: "sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4",
        platform: "linux/arm64",
        selected_manifest_digest: cellIndex,
        image_id: cellIndex,
        config_digest: cellIndex,
      },
      bridge_image: {
        reference: `123456789012.dkr.ecr.us-east-1.amazonaws.com/ligou-discovery-bridge@${bridgeIndex}`,
        index_digest: bridgeIndex,
        platform: "linux/arm64",
        selected_manifest_digest: `sha256:${"6".repeat(64)}`,
        image_id: `sha256:${"5".repeat(64)}`,
        config_digest: `sha256:${"5".repeat(64)}`,
      },
    },
  };
}

describe("release-owned supervisor configuration", () => {
  test("accepts only the exact nonsecret configuration and resolves pinned credential owners", () => {
    const parsed = parseSupervisorConfig(runtimeConfig());
    const registry = new ReleaseCredentialOwnerRegistry(parsed.credential_owners);

    expect(parsed.adapter_sequence).toEqual(["direct_model", "openclaw"]);
    expect(parseSupervisorConfig({ ...runtimeConfig(), adapter_sequence: ["openclaw"] })
      .adapter_sequence).toEqual(["openclaw"]);
    expect(() => assertSupervisorIdentity(parsed, 1_000, 1_000)).not.toThrow();
    expect(() => assertSupervisorIdentity(parsed, 501, 20)).toThrow("numeric identity");
    expect(registry.resolve("11111111-1111-4111-8111-111111111111", 3)).toEqual({
      container_name: "ligou-cell-11111111-1111-4111-8111-111111111111",
      model_auth_volume: "ligou-11111111-1111-4111-8111-111111111111-hermes-model-auth",
      image_reference: `ligou-hermes@sha256:${"3".repeat(64)}`,
      image_id: `sha256:${"4".repeat(64)}`,
      interpreter_path: "/opt/hermes/.venv/bin/python",
    });
    expect(() => registry.resolve("11111111-1111-4111-8111-111111111111", 4))
      .toThrow("not configured");
    expect(JSON.stringify(parsed)).not.toMatch(/access_token|api_key|service_role/i);
  });

  test("rejects unknown fields, inline credentials, duplicate adapters, and duplicate owner generations", () => {
    const base = runtimeConfig();
    for (const candidate of [
      { ...base, OPENAI_API_KEY: "forbidden" },
      { ...base, supabase_service_key: "forbidden" },
      { ...base, adapter_sequence: ["openclaw", "openclaw"] },
      { ...base, adapter_sequence: ["unknown_adapter"] },
      { ...base, worker_id: "w".repeat(181) },
      { ...base, credential_owners: [base.credential_owners[0], base.credential_owners[0]] },
      {
        ...base,
        credential_owners: [base.credential_owners[0], {
          ...base.credential_owners[0],
          credential_owner_id: "22222222-2222-4222-8222-222222222222",
          container_name: "ligou-cell-22222222-2222-4222-8222-222222222222",
        }],
      },
    ]) {
      expect(() => parseSupervisorConfig(candidate)).toThrow();
    }
  });

  test("loads a bounded protected secret file and rejects group-readable or symlinked material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ligou-stage0-secret-"));
    temporaryDirectories.push(directory);
    const secret = join(directory, "service-key");
    await writeFile(secret, "synthetic-service-key\n", { mode: 0o600 });

    expect(await loadProtectedSecret(secret, "Supabase service key")).toBe("synthetic-service-key");
    await chmod(secret, 0o640);
    await expect(loadProtectedSecret(secret, "Supabase service key")).rejects.toThrow("permissions");
    await chmod(secret, 0o600);
    const linkedSecret = join(directory, "linked-service-key");
    await symlink(secret, linkedSecret);
    await expect(loadProtectedSecret(linkedSecret, "Supabase service key"))
      .rejects.toThrow("protected file");
  });

  test("reads authority config through one protected non-symlink handle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ligou-stage0-config-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "supervisor.json");
    await writeFile(configPath, JSON.stringify(runtimeConfig()), { mode: 0o600 });
    expect((await readSupervisorConfig(configPath)).worker_id).toBe("ligou-stage0-worker");
    const linkedConfig = join(directory, "linked-config.json");
    await symlink(configPath, linkedConfig);
    await expect(readSupervisorConfig(linkedConfig)).rejects.toThrow("protected file");
  });

  test("derives both credential files from the exact systemd credential directory", () => {
    const directory = "/run/credentials/ligou-discovery-supervisor.service";
    expect(supervisorCredentialPaths(
      ["--config", `${directory}/supervisor_config`],
      { CREDENTIALS_DIRECTORY: directory },
    )).toEqual({
      config_path: `${directory}/supervisor_config`,
      service_key_path: `${directory}/supabase_service_key`,
    });
    expect(() => supervisorCredentialPaths(
      ["--config", "/tmp/attacker-config"],
      { CREDENTIALS_DIRECTORY: directory },
    )).toThrow("credential path");
    expect(() => supervisorCredentialPaths([], { CREDENTIALS_DIRECTORY: undefined }))
      .toThrow("credential directory");
  });
});

describe("secret-redacting argv command runner", () => {
  test("uses no shell, inherits no ambient secrets, and logs labels without command output", async () => {
    process.env.OPENAI_API_KEY = "ambient-secret-must-not-cross";
    const events: unknown[] = [];
    const runner = new ArgvCommandRunner({
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      on_event: (event) => events.push(event),
    });
    const result = await runner.run({
      label: "inspect-sanitized-environment",
      argv: ["/usr/bin/env"],
      env: { LIGOU_SAFE_MARKER: "present" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("LIGOU_SAFE_MARKER=present");
    expect(result.stdout).not.toContain("OPENAI_API_KEY");
    expect(result.stdout).not.toContain("ambient-secret-must-not-cross");
    expect(JSON.stringify(events)).not.toContain(result.stdout);
    expect(events).toEqual([{
      label: "inspect-sanitized-environment",
      outcome: "exited",
      exit_code: 0,
      sensitive: false,
    }]);
  });

  test("requires the sensitive channel and never logs sensitive stdout", async () => {
    const events: unknown[] = [];
    const runner = new ArgvCommandRunner({ on_event: (event) => events.push(event) });
    const command = {
      label: "resolve-sensitive-grant",
      argv: ["/usr/bin/printf", "%s", "synthetic-sensitive-value"],
      env: {},
      sensitive_stdout: true,
    } as const;

    await expect(runner.run(command)).rejects.toThrow("runSensitive");
    expect((await runner.runSensitive(command)).stdout).toBe("synthetic-sensitive-value");
    expect(JSON.stringify(events)).not.toContain("synthetic-sensitive-value");
  });

  test("rejects secret-like argv and environment values before spawning", async () => {
    const runner = new ArgvCommandRunner();
    await expect(runner.run({
      label: "forbidden-argv",
      argv: ["/usr/bin/printf", "Bearer secret"],
      env: {},
    })).rejects.toThrow("secret-like");
    await expect(runner.run({
      label: "forbidden-env",
      argv: ["/usr/bin/true"],
      env: { OPENAI_API_KEY: "forbidden" },
    })).rejects.toThrow("environment");
  });

  test("handles immediate abort and output overflow with one terminal outcome", async () => {
    const events: unknown[] = [];
    const runner = new ArgvCommandRunner({
      max_output_bytes: 1_024,
      on_event: (event) => events.push(event),
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(runner.run({
      label: "already-aborted",
      argv: ["/usr/bin/true"],
      env: {},
    }, alreadyAborted.signal)).rejects.toThrow("aborted");
    const controller = new AbortController();
    const pending = runner.run({
      label: "abort-after-spawn",
      argv: ["/bin/sh", "-c", "sleep 5"],
      env: {},
    }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    await expect(runner.run({
      label: "overflow-output",
      argv: ["/usr/bin/yes", "bounded"],
      env: {},
    })).rejects.toThrow("output limit");
    expect(events.filter((event: any) => event.label === "already-aborted")).toHaveLength(1);
    expect(events.filter((event: any) => event.label === "abort-after-spawn")).toHaveLength(1);
    expect(events.filter((event: any) => event.label === "overflow-output")).toHaveLength(1);
  });

  test("handles deterministic stdin EPIPE with one terminal outcome", async () => {
    const events: unknown[] = [];
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: Writable;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      let closeScheduled = false;
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          const error = Object.assign(new Error("synthetic closed stdin"), { code: "EPIPE" });
          callback(error);
        },
      });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        if (!closeScheduled) {
          closeScheduled = true;
          queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        }
        return true;
      };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const runner = new ArgvCommandRunner({
      on_event: (event) => events.push(event),
      spawn_process: fakeSpawn,
    });

    await expect(runner.run({
      label: "closed-stdin",
      argv: ["/synthetic/child"],
      env: {},
      stdin: "not-secret",
      sensitive_stdin: true,
    })).rejects.toThrow("stdin");
    expect(events.filter((event: any) => event.label === "closed-stdin")).toHaveLength(1);
  });
});

describe("narrow Supabase service RPC transport", () => {
  test("puts the protected key only in HTTP headers and returns parsed RPC data", async () => {
    const requests: Request[] = [];
    const redirects: Array<RequestRedirect | undefined> = [];
    const client = new SupabaseServiceRpcClient({
      url: "https://example.supabase.co",
      service_key: "synthetic-protected-key",
      fetch: async (input, init) => {
        redirects.push(init?.redirect);
        requests.push(new Request(input, init));
        return new Response(JSON.stringify([{ job_id: "ok" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(await client.rpc("claim_company_discovery_attempt", {
      p_worker_id: "worker",
      p_adapter_id: "direct_model",
      p_lease_seconds: 300,
    })).toEqual({ data: [{ job_id: "ok" }], error: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "https://example.supabase.co/rest/v1/rpc/claim_company_discovery_attempt",
    );
    expect(redirects).toEqual(["error"]);
    expect(requests[0]!.headers.get("apikey")).toBe("synthetic-protected-key");
    expect(await requests[0]!.clone().text()).not.toContain("synthetic-protected-key");
  });

  test("rejects arbitrary RPC names and redacts remote bodies and credentials from errors", async () => {
    let calls = 0;
    const client = new SupabaseServiceRpcClient({
      url: "https://example.supabase.co",
      service_key: "synthetic-protected-key",
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ message: "synthetic-protected-key leaked" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(client.rpc("arbitrary_sql", {})).rejects.toThrow("not allowlisted");
    const response = await client.rpc("claim_company_discovery_attempt", {});
    expect(calls).toBe(1);
    expect(response.data).toBeNull();
    expect(JSON.stringify(response.error)).not.toContain("synthetic-protected-key");
  });
});

describe("singleton process loop and passive health", () => {
  test("holds an exclusive fail-closed authority directory until graceful release", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ligou-stage0-lock-"));
    temporaryDirectories.push(parent);
    const path = join(parent, "authority");
    const identity = {
      pid: 31,
      process_start_id: "901",
      boot_id: "11111111-1111-4111-8111-111111111111",
    };
    const options = { identity, is_owner_current: async () => true };
    const first = await SingletonAuthority.acquire(path, options);
    await expect(SingletonAuthority.acquire(path, options)).rejects.toThrow("already held");
    await first.release();
    const second = await SingletonAuthority.acquire(path, options);
    await second.release();
  });

  test("refuses a live exact owner and reclaims only a proved stale process identity", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ligou-stage0-stale-lock-"));
    temporaryDirectories.push(parent);
    const path = join(parent, "authority");
    const oldIdentity = {
      pid: 41,
      process_start_id: "1001",
      boot_id: "11111111-1111-4111-8111-111111111111",
    };
    const replacementIdentity = {
      pid: 42,
      process_start_id: "1002",
      boot_id: "11111111-1111-4111-8111-111111111111",
    };
    const old = await SingletonAuthority.acquire(path, {
      identity: oldIdentity,
      is_owner_current: async () => true,
    });
    await expect(SingletonAuthority.acquire(path, {
      identity: replacementIdentity,
      is_owner_current: async (owner) => owner.pid === oldIdentity.pid,
    })).rejects.toThrow("already held");

    const replacement = await SingletonAuthority.acquire(path, {
      identity: replacementIdentity,
      is_owner_current: async () => false,
    });
    expect(replacement.stale_owner_recovered).toBe(true);
    await expect(old.release()).rejects.toThrow("no longer owns");
    await replacement.release();
  });

  test("health requests expose bounded process state and never run supervisor work", async () => {
    let runs = 0;
    const loop = new SupervisorLoop({
      run_once: async () => { runs += 1; return { state: "idle" }; },
      poll_interval_ms: 100,
      sleep: async () => undefined,
    });
    const health = new HealthEndpoint({ host: "127.0.0.1", port: 0, state: loop.health });
    const address = await health.start();

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema_version: "ligou.discovery_supervisor.health.v1",
      status: "starting",
      loop_active: false,
      last_poll_at: null,
      last_outcome: null,
      consecutive_failures: 0,
    });
    expect(runs).toBe(0);
    await health.close();
  });

  test("runs one supervisor operation at a time and stops on abort without another poll", async () => {
    const controller = new AbortController();
    let active = 0;
    let peak = 0;
    let calls = 0;
    const loop = new SupervisorLoop({
      run_once: async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        active -= 1;
        controller.abort();
        return { state: "idle" };
      },
      poll_interval_ms: 10,
      sleep: async () => undefined,
      now: () => Date.parse("2026-09-01T10:00:00.000Z"),
    });

    await loop.run(controller.signal);
    expect(calls).toBe(1);
    expect(peak).toBe(1);
    expect(loop.health).toMatchObject({
      status: "stopped",
      loop_active: false,
      last_poll_at: "2026-09-01T10:00:00.000Z",
      last_outcome: "idle",
      consecutive_failures: 0,
    });
  });

  test("bounded shutdown releases authority only after the loop actually drains", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ligou-stage0-shutdown-"));
    temporaryDirectories.push(parent);
    const path = join(parent, "authority");
    const identity = {
      pid: 51,
      process_start_id: "2001",
      boot_id: "11111111-1111-4111-8111-111111111111",
    };
    const lock = await SingletonAuthority.acquire(path, {
      identity,
      is_owner_current: async () => true,
    });
    const loop = new SupervisorLoop({
      run_once: async () => new Promise(() => undefined),
      poll_interval_ms: 10,
    });
    const health = new HealthEndpoint({ host: "127.0.0.1", port: 0, state: loop.health });
    const service = new SupervisorService({
      loop,
      health,
      authority: lock,
      shutdown_timeout_ms: 5,
    });
    await service.start();

    expect(await service.shutdown()).toEqual({ drained: false });
    await expect(SingletonAuthority.acquire(path, {
      identity: { ...identity, pid: 52, process_start_id: "2002" },
      is_owner_current: async () => true,
    })).rejects.toThrow("already held");
  });
});

describe("runtime cleanup observers", () => {
  test("distinguishes an active loopback listener from a closed endpoint", async () => {
    const server = createTcpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test address");

    expect(await proveLoopbackListenerClosed(address.port, 100)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await proveLoopbackListenerClosed(address.port, 100)).toBe(true);
  });

  test("requires exact empty Docker process readback for every attempt container", async () => {
    const commands: string[] = [];
    const absent = await proveDockerIdentityProcessesAbsent({
      async run(command) {
        commands.push(command.argv.join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }, {
      cell_container_name: "ligou-oc-cell-abcdefabcdefabcd",
      bridge_container_name: "ligou-oc-bridge-abcdefabcdefabcd",
    });
    expect(absent).toBe(true);
    expect(commands).toHaveLength(3);
    expect(commands[2]).toContain("ligou-oc-volume-keeper-abcdefabcdefabcd");

    expect(await proveDockerIdentityProcessesAbsent({
      async run() { return { exitCode: 0, stdout: "container-id\n", stderr: "" }; },
    }, {
      cell_container_name: "ligou-oc-cell-abcdefabcdefabcd",
      bridge_container_name: "ligou-oc-bridge-abcdefabcdefabcd",
    })).toBe(false);
  });

});

describe("concrete supervisor composition", () => {
  test("constructs one gateway and both fixed adapters without claims, grants, models, or Docker", async () => {
    const config = parseSupervisorConfig({ ...runtimeConfig(), adapter_sequence: ["openclaw"] });
    let runtimeRootPreparations = 0;
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let commandCalls = 0;
    let modelCalls = 0;
    const composition = await composeProductionSupervisor(
      config,
      "synthetic-protected-key",
      {
        rpc_client: {
          async rpc(name, args) {
            rpcCalls.push({ name, args });
            return { data: [], error: null };
          },
        },
        command_runner: {
          async run() {
            commandCalls += 1;
            return { exitCode: 1, stdout: "", stderr: "not invoked" };
          },
          async runSensitive() {
            commandCalls += 1;
            return { exitCode: 1, stdout: "", stderr: "not invoked" };
          },
        },
        listener_manager: {
          async prepareRuntimeRoot() {
            runtimeRootPreparations += 1;
            return {
              path: "/run/ligou-discovery" as const,
              owner_uid: 1_000,
              bridge_uid: 1_000 as const,
              bridge_gid: 1_000 as const,
              mode: 0o710 as const,
              no_symlink: true as const,
            };
          },
          async open() { throw new Error("must not register a subscription lease"); },
          async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        },
        model_fetch: async () => {
          modelCalls += 1;
          throw new Error("must not call the model during composition");
        },
      },
    );

    expect(composition.adapter_ids).toEqual(["direct_model", "openclaw"]);
    expect(runtimeRootPreparations).toBe(1);
    expect(rpcCalls).toEqual([]);
    expect(commandCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(JSON.stringify(composition)).not.toContain("synthetic-protected-key");
    expect(await composition.run_once()).toEqual({ state: "idle" });
    expect(rpcCalls).toEqual([
      {
        name: "claim_expired_company_discovery_cleanup",
        args: { p_worker_id: "ligou-stage0-worker-direct_model", p_lease_seconds: 300 },
      },
      {
        name: "claim_expired_company_discovery_cleanup",
        args: { p_worker_id: "ligou-stage0-worker-openclaw", p_lease_seconds: 300 },
      },
      {
        name: "claim_company_discovery_attempt",
        args: {
          p_worker_id: "ligou-stage0-worker-openclaw",
          p_adapter_id: "openclaw",
          p_lease_seconds: 300,
        },
      },
    ]);
    expect(commandCalls).toBe(0);
    expect(modelCalls).toBe(0);
  });

  test("ships a bounded service unit with fixed systemd credentials and split runtime/state modes", async () => {
    const unit = await Bun.file(join(
      import.meta.dir,
      "..",
      "..",
      "infra",
      "ligou-discovery-supervisor.service",
    )).text();
    for (const directive of [
      "User=ec2-user",
      "Group=ec2-user",
      "SupplementaryGroups=docker",
      "LoadCredential=supervisor_config:",
      "LoadCredential=supabase_service_key:",
      "RuntimeDirectory=ligou-discovery",
      "RuntimeDirectoryMode=0710",
      "StateDirectory=ligou-discovery-supervisor",
      "StateDirectoryMode=0700",
      "MemoryMax=1G",
      "TasksMax=256",
      "LimitNOFILE=1024",
      "CPUQuota=100%",
    ]) expect(unit).toContain(directive);
    expect(unit).not.toContain("OPENAI_API_KEY");
    expect(unit).not.toContain("/run/ligou-discovery-supervisor");
  });
});
