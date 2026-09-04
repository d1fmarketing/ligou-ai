#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runConcurrencySuite } from "../supabase/tests/local-db-concurrency.mjs";
import { runAuthenticatedRlsSuite } from "../supabase/tests/local-db-rls.mjs";
import { runUpgradeRehearsal } from "../supabase/tests/local-db-upgrade-rehearsal.mjs";
import { runWebsiteInterviewActualSchemaSuite } from "../supabase/tests/local-website-interview-actual-schema.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const LOCAL_PROJECT_ID = "ligou-v0-1-rc1";
const PASSTHROUGH_ENV = [
  "CI",
  "LANG",
  "LC_ALL",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TMPDIR",
];

export function assertSafeLocalProjectId(projectId) {
  if (projectId !== LOCAL_PROJECT_ID) {
    throw new Error("Local database gate requires the disposable RC1 project identity");
  }
  return projectId;
}

export function assertExactLocalDatabaseIdentity(databaseUrl, projectId) {
  assertSafeLocalProjectId(projectId);
  if (databaseUrl.protocol !== "postgresql:"
      || databaseUrl.hostname !== "127.0.0.1"
      || databaseUrl.port !== "54322"
      || databaseUrl.pathname !== "/postgres"
      || decodeURIComponent(databaseUrl.username) !== "postgres"
      || !databaseUrl.password) {
    throw new Error("Local gate requires the exact disposable database identity");
  }
  return databaseUrl;
}

export function assertCanonicalColimaIdentity(input) {
  if (typeof input.inheritedDockerHost === "string" && input.inheritedDockerHost.length > 0) {
    throw new Error("Local gate rejects inherited DOCKER_HOST");
  }
  const expectedSocketPath = `${input.runtimeRootRealpath}/docker.sock`;
  const expectedSocketUrl = `unix://${expectedSocketPath}`;
  if (input.status?.display_name !== "colima [profile=ligou-rc1]"
      || input.status?.runtime !== "docker"
      || input.status?.docker_socket !== expectedSocketUrl
      || input.contextHost !== expectedSocketUrl
      || input.socketRealpath !== expectedSocketPath
      || !input.socketRealpath.startsWith(`${input.runtimeRootRealpath}/`)
      || input.profileConfig?.runtime !== "docker"
      || input.profileConfig?.autoActivate !== false
      || input.profileConfig?.portForwarder !== "none"
      || input.profileConfig?.mountLocation !== input.expectedMountLocation
      || input.profileConfig?.mountWritable !== true
      || input.sshConfigRealpath !== input.expectedSshConfigRealpath) {
    throw new Error("Local gate requires the canonical Colima socket");
  }
  return expectedSocketUrl;
}

export function assertOwnedForwardListeners(listeners, forwardPid) {
  const ordered = [...listeners].sort((left, right) => left.port - right.port);
  if (!Number.isSafeInteger(forwardPid) || forwardPid <= 0
      || ordered.length !== 2
      || ordered[0]?.pid !== forwardPid
      || ordered[1]?.pid !== forwardPid
      || ordered[0]?.address !== "127.0.0.1"
      || ordered[1]?.address !== "127.0.0.1"
      || ordered[0]?.port !== 54321
      || ordered[1]?.port !== 54322) {
    throw new Error("Local gate requires its owned loopback SSH forwards");
  }
  return listeners;
}

export function assertDisposableStackIdentity(stack, options) {
  const labels = stack?.Config?.Labels ?? {};
  const bindings = stack?.NetworkSettings?.Ports?.["5432/tcp"];
  const workdir = labels["com.supabase.cli.workdir"];
  const volume = (stack?.Mounts ?? []).find((mount) => mount.Destination === "/var/lib/postgresql/data");
  if (stack?.Name !== `/supabase_db_${LOCAL_PROJECT_ID}`
      || stack?.Config?.Image !== "public.ecr.aws/supabase/postgres:17.6.1.159"
      || labels["com.docker.compose.project"] !== LOCAL_PROJECT_ID
      || labels["com.supabase.cli.project"] !== LOCAL_PROJECT_ID
      || !options.allowedWorkdirs.includes(workdir)
      || stack?.State?.Running !== true
      || stack?.State?.Health?.Status !== "healthy"
      || !Array.isArray(bindings)
      || bindings.length < 1
      || bindings.some((binding) => binding?.HostPort !== "54322")
      || !bindings.some((binding) => binding?.HostIp === "0.0.0.0")
      || volume?.Type !== "volume"
      || volume?.Name !== `supabase_db_${LOCAL_PROJECT_ID}`) {
    throw new Error("Local gate rejected the disposable stack identity");
  }
  if (options.forwardListeners) assertOwnedForwardListeners(options.forwardListeners, options.forwardPid);
  return stack;
}

export function guardedDestructiveAction(stack, options, action) {
  assertDisposableStackIdentity(stack, options);
  return action();
}

export function buildSanitizedChildEnv(sourceEnv, isolatedHome) {
  const childEnv = {};
  for (const name of PASSTHROUGH_ENV) {
    if (typeof sourceEnv[name] === "string") childEnv[name] = sourceEnv[name];
  }
  childEnv.HOME = isolatedHome;
  childEnv.XDG_CACHE_HOME = `${isolatedHome}/.cache`;
  childEnv.XDG_CONFIG_HOME = `${isolatedHome}/.config`;
  childEnv.SUPABASE_NO_UPDATE_NOTIFIER = "1";
  return childEnv;
}

export function assertLoopbackDatabaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Local database URL is invalid");
  }

  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("Local database URL must use PostgreSQL");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("Local database URL must use a loopback host");
  }

  return parsed;
}

export function parseLocalStatus(rawStatus) {
  let status;
  try {
    status = JSON.parse(rawStatus);
  } catch {
    throw new Error("Supabase local status did not return valid JSON");
  }

  const rawDatabaseUrl = status?.DB_URL ?? status?.db_url;
  if (typeof rawDatabaseUrl !== "string") {
    throw new Error("Supabase local status did not include a database URL");
  }

  return { databaseUrl: assertLoopbackDatabaseUrl(rawDatabaseUrl) };
}

export function parseLocalRuntimeStatus(rawStatus) {
  let status;
  try {
    status = JSON.parse(rawStatus);
  } catch {
    throw new Error("Supabase local status did not return valid JSON");
  }
  const databaseUrl = assertLoopbackDatabaseUrl(status?.DB_URL ?? status?.db_url ?? "");
  assertExactLocalDatabaseIdentity(databaseUrl, LOCAL_PROJECT_ID);
  let apiUrl;
  try {
    apiUrl = new URL(status?.API_URL ?? status?.api_url ?? "");
  } catch {
    throw new Error("Local gate requires the exact disposable API identity");
  }
  if (apiUrl.protocol !== "http:"
      || apiUrl.hostname !== "127.0.0.1"
      || apiUrl.port !== "54321"
      || apiUrl.pathname !== "/") {
    throw new Error("Local gate requires the exact disposable API identity");
  }
  const serviceRoleKey = status?.SERVICE_ROLE_KEY ?? status?.SECRET_KEY ?? status?.service_role_key ?? status?.secret_key;
  const publishableKey = status?.ANON_KEY ?? status?.PUBLISHABLE_KEY ?? status?.anon_key ?? status?.publishable_key;
  if (typeof serviceRoleKey !== "string" || !serviceRoleKey
      || typeof publishableKey !== "string" || !publishableKey) {
    throw new Error("Supabase local status did not include ephemeral local API keys");
  }
  return { databaseUrl, apiUrl: apiUrl.origin, serviceRoleKey, publishableKey };
}

export function orderMigrationFiles(fileNames) {
  const seen = new Set();
  const migrations = fileNames.map((fileName) => {
    const match = /^(\d+)_.*[.]sql$/.exec(fileName);
    if (!match) throw new Error("Invalid migration filename");
    const version = match[1];
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
    return { fileName, version, numericVersion: BigInt(version) };
  });

  migrations.sort((left, right) => (
    left.numericVersion < right.numericVersion ? -1 : left.numericVersion > right.numericVersion ? 1 : 0
  ));
  return migrations.map(({ fileName }) => fileName);
}

export function assertMigrationHistory(fileNames, historyVersions) {
  const orderedFiles = orderMigrationFiles(fileNames);
  const expectedVersions = orderedFiles.map((fileName) => fileName.slice(0, fileName.indexOf("_")));
  const actualVersions = [...historyVersions];
  const exact = expectedVersions.length === actualVersions.length
    && expectedVersions.every((version, index) => version === actualVersions[index]);
  if (!exact || new Set(actualVersions).size !== actualVersions.length) {
    throw new Error("Local migration history does not match repository migrations exactly once");
  }
  return { migrationCount: expectedVersions.length, missing0008: !expectedVersions.includes("0008") };
}

export function assertNoExtensionVersionClauses(migrations) {
  let extensionStatements = 0;
  for (const migration of migrations) {
    const statements = migration.sql.match(/create\s+extension\b[^;]*;/gi) ?? [];
    extensionStatements += statements.length;
    if (statements.some((statement) => /\bversion\b/i.test(statement))) {
      throw new Error("Extension version clauses are forbidden in migrations");
    }
  }
  return extensionStatements;
}

function sanitize(value, secrets = []) {
  let sanitized = String(value);
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-db-url]");
}

function run(command, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(input ?? "");
  });
}

function successful(result, label, secrets = []) {
  if (result.code !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${label} failed: ${sanitize(detail, secrets) || "command exited non-zero"}`);
  }
  return result.stdout;
}

async function firstAccessible(paths) {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next explicit local candidate.
    }
  }
  return null;
}

const COLIMA_PROFILE = "ligou-rc1";
const COLIMA_CONTEXT = "colima-ligou-rc1";
const COLIMA_SSH_HOST = "lima-colima-ligou-rc1";

function parseDedicatedProfileConfig(rawConfig) {
  const value = (name) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(rawConfig)?.[1]?.trim();
  const mount = /^mounts:\s*\n\s*- location:\s*(.+)\n\s*writable:\s*(true|false)$/m.exec(rawConfig);
  return {
    runtime: value("runtime"),
    autoActivate: value("autoActivate") === "false" ? false : value("autoActivate") === "true" ? true : null,
    portForwarder: value("portForwarder"),
    mountLocation: mount?.[1]?.trim(),
    mountWritable: mount?.[2] === "true",
  };
}

async function discoverCanonicalColimaSocket(sourceEnv, repoRoot) {
  if (typeof sourceEnv.DOCKER_HOST === "string" && sourceEnv.DOCKER_HOST.length > 0) {
    throw new Error("Local gate rejects inherited DOCKER_HOST");
  }
  const discoveryEnv = {
    PATH: sourceEnv.PATH ?? "/usr/bin:/bin",
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
  };
  const profileRoot = path.join(os.homedir(), `.colima/${COLIMA_PROFILE}`);
  const profileConfigPath = path.join(profileRoot, "colima.yaml");
  let profileExists = true;
  try {
    await access(profileConfigPath);
  } catch {
    profileExists = false;
  }
  if (!profileExists) {
    successful(await run("colima", [
      "start", "--profile", COLIMA_PROFILE,
      "--runtime", "docker",
      "--port-forwarder", "none",
      "--activate=false",
      "--mount", `${repoRoot}:w`,
      "--ssh-config=false",
    ], { env: discoveryEnv }), "Dedicated Colima profile creation");
  } else {
    const existingConfig = parseDedicatedProfileConfig(await readFile(profileConfigPath, "utf8"));
    if (existingConfig.runtime !== "docker"
        || existingConfig.autoActivate !== false
        || existingConfig.portForwarder !== "none"
        || existingConfig.mountLocation !== repoRoot
        || existingConfig.mountWritable !== true) {
      throw new Error("Dedicated Colima profile configuration is not fail-closed");
    }
    const beforeStart = await run("colima", ["status", "--profile", COLIMA_PROFILE, "--json"], { env: discoveryEnv });
    if (beforeStart.code !== 0) {
      successful(await run("colima", ["start", "--profile", COLIMA_PROFILE, "--activate=false"], { env: discoveryEnv }), "Dedicated Colima profile start");
    }
  }
  const status = JSON.parse(successful(
    await run("colima", ["status", "--profile", COLIMA_PROFILE, "--json"], { env: discoveryEnv }),
    "Dedicated Colima status",
  ));
  const contextHost = JSON.parse(successful(
    await run("docker", ["context", "inspect", COLIMA_CONTEXT, "--format", "{{json .Endpoints.docker.Host}}"], { env: discoveryEnv }),
    "Dedicated Colima Docker context",
  ));
  const runtimeRootRealpath = await realpath(profileRoot);
  const socketUrl = String(status.docker_socket ?? "");
  if (!socketUrl.startsWith("unix://")) throw new Error("Local gate requires the canonical Colima socket");
  const socketRealpath = await realpath(socketUrl.slice("unix://".length));
  if (!(await lstat(socketRealpath)).isSocket()) throw new Error("Canonical Colima Docker path is not a socket");
  const profileConfig = parseDedicatedProfileConfig(await readFile(profileConfigPath, "utf8"));
  const expectedSshConfigRealpath = path.join(os.homedir(), `.colima/_lima/colima-${COLIMA_PROFILE}/ssh.config`);
  const sshConfigRealpath = await realpath(expectedSshConfigRealpath);
  const dockerHost = assertCanonicalColimaIdentity({
    inheritedDockerHost: sourceEnv.DOCKER_HOST,
    status,
    contextHost,
    runtimeRootRealpath,
    socketRealpath,
    profileConfig,
    expectedMountLocation: repoRoot,
    sshConfigRealpath,
    expectedSshConfigRealpath,
  });
  const daemonEnv = { ...discoveryEnv, DOCKER_HOST: dockerHost };
  successful(await run("docker", ["info", "--format", "{{.ServerVersion}}"], { env: daemonEnv }), "Colima Docker daemon");
  const activeContext = successful(await run("docker", ["context", "show"], { env: discoveryEnv }), "Default Docker context check").trim();
  if (activeContext === COLIMA_CONTEXT) throw new Error("Dedicated Colima profile must not become the active Docker context");
  return { dockerHost, daemonEnv, discoveryEnv, sshConfigRealpath, activeContext };
}

async function inspectDisposableStack(daemonEnv, allowedWorkdirs, { allowMissing = false, forwardListeners, forwardPid } = {}) {
  const format = "{{json .Name}}@@{{json .Config.Image}}@@{{json .Config.Labels}}@@{{json .State}}@@{{json .HostConfig.PortBindings}}@@{{json .NetworkSettings.Ports}}@@{{json .Mounts}}";
  const result = await run("docker", ["inspect", "--format", format, `supabase_db_${LOCAL_PROJECT_ID}`], { env: daemonEnv });
  if (result.code !== 0 && allowMissing && /No such (object|container)/i.test(result.stderr)) return null;
  const output = successful(result, "Disposable database container inspection");
  const fields = output.split("@@");
  if (fields.length !== 7) throw new Error("Local gate rejected the disposable stack identity");
  const [Name, Image, Labels, State, PortBindings, Ports, Mounts] = fields.map((field) => JSON.parse(field));
  return assertDisposableStackIdentity({
    Name,
    Config: { Image, Labels },
    State,
    HostConfig: { PortBindings },
    NetworkSettings: { Ports },
    Mounts,
  }, { allowedWorkdirs, forwardListeners, forwardPid });
}

async function hostForwardListeners(environment) {
  const result = await run("lsof", [
    "-nP", "-iTCP:54321", "-iTCP:54322", "-sTCP:LISTEN", "-Fpn",
  ], { env: environment });
  if (result.code !== 0) {
    if (result.code === 1 && !result.stdout) return [];
    throw new Error(`Host listener inspection failed: ${sanitize(result.stderr)}`);
  }
  const listeners = [];
  let pid = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("n") && pid) {
      const endpoint = line.slice(1);
      const match = /^(127[.]0[.]0[.]1):(54321|54322)$/.exec(endpoint);
      listeners.push({ pid, address: match?.[1] ?? endpoint.split(":")[0], port: Number(match?.[2] ?? endpoint.split(":").at(-1)) });
    }
  }
  return listeners;
}

async function startOwnedSshForwards(colima, runnerRoot) {
  const before = await hostForwardListeners(colima.discoveryEnv);
  if (before.length !== 0) throw new Error("Local DB/API ports already have host listeners");
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(runnerRoot, "ssh-home"),
    TMPDIR: runnerRoot,
  };
  await mkdir(environment.HOME, { recursive: true });
  const child = spawn("ssh", [
    "-F", colima.sshConfigRealpath,
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
    "-o", "ExitOnForwardFailure=yes",
    "-N", "-T",
    "-L", "127.0.0.1:54321:127.0.0.1:54321",
    "-L", "127.0.0.1:54322:127.0.0.1:54322",
    COLIMA_SSH_HOST,
  ], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const exitPromise = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`SSH forward process exited: ${sanitize(stderr)}`);
    const listeners = await hostForwardListeners(colima.discoveryEnv);
    try {
      assertOwnedForwardListeners(listeners, child.pid);
      return { child, pid: child.pid, exitPromise, listeners: () => hostForwardListeners(colima.discoveryEnv) };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill("SIGTERM");
  await exitPromise;
  throw new Error(`SSH forwards did not bind exact loopback ports: ${sanitize(stderr)}`);
}

async function stopOwnedSshForwards(forward, discoveryEnv) {
  if (!forward) return;
  const listeners = await forward.listeners();
  let ownershipError = null;
  try {
    assertOwnedForwardListeners(listeners, forward.pid);
  } catch (error) {
    ownershipError = error;
  }
  if (forward.child.exitCode === null) forward.child.kill("SIGTERM");
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3_000));
  const exit = await Promise.race([forward.exitPromise, timeout]);
  if (exit?.timeout && forward.child.exitCode === null) {
    forward.child.kill("SIGKILL");
    await forward.exitPromise;
  }
  const remaining = await hostForwardListeners(discoveryEnv);
  if (remaining.some((listener) => listener.pid === forward.pid)) {
    throw new Error("Test-owned SSH forward process remained after termination");
  }
  if (ownershipError) throw ownershipError;
  if (remaining.length !== 0) {
    throw new Error("Test-owned SSH forward listeners remained after termination");
  }
}

async function stopDedicatedColimaProfile(colima) {
  successful(await run("colima", ["stop", "--profile", COLIMA_PROFILE], { env: colima.discoveryEnv }), "Dedicated Colima profile stop");
  const status = await run("colima", ["status", "--profile", COLIMA_PROFILE, "--json"], { env: colima.discoveryEnv });
  if (status.code === 0) throw new Error("Dedicated Colima profile remained running after stop");
  const activeContext = successful(await run("docker", ["context", "show"], { env: colima.discoveryEnv }), "Default Docker context postflight").trim();
  if (activeContext !== colima.activeContext) throw new Error("Dedicated profile changed the active Docker context");
}

async function resolvePsql() {
  const executable = await firstAccessible([
    "/opt/homebrew/opt/libpq/bin/psql",
    "/usr/local/bin/psql",
    "/usr/bin/psql",
  ]);
  if (!executable) throw new Error("psql is required for the local concurrency and upgrade gate");
  return executable;
}

async function runPsql(connection, psqlBin, isolatedHome, sql) {
  return run(psqlBin, [
    "-X", "--set=ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--quiet", "--file=-",
  ], {
    input: sql,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: isolatedHome,
      LANG: "C",
      PGAPPNAME: "ligou_rc1_local_gate",
      PGCONNECT_TIMEOUT: "5",
      PGHOST: connection.hostname,
      PGPORT: connection.port,
      PGDATABASE: connection.pathname.slice(1),
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: decodeURIComponent(connection.password),
    },
  });
}

function issueCounts(rows) {
  const levels = {};
  const names = {};
  for (const row of rows) {
    const level = String(row.level ?? "unknown").toUpperCase();
    levels[level] = (levels[level] ?? 0) + 1;
    if (row.name) names[row.name] = (names[row.name] ?? 0) + 1;
  }
  return { total: rows.length, levels, names };
}

function lintCounts(functions) {
  const levels = {};
  let total = 0;
  for (const entry of functions) {
    for (const issue of entry.issues ?? []) {
      total += 1;
      const level = String(issue.level ?? "unknown").split(/\s+/)[0].toUpperCase();
      levels[level] = (levels[level] ?? 0) + 1;
    }
  }
  return { total, levels };
}

function assertExpectedLegacyLint(functions) {
  const actual = functions.flatMap((entry) => (entry.issues ?? []).map((issue) => (
    `${entry.function}|${String(issue.level).split(/\s+/)[0]}|${issue.message}`
  ))).sort();
  // Exactly the remaining legacy hygiene warning documented by the migration
  // runbook. The reset-boundary migration now uses decide_case.v_tenant to lock
  // the tenant first; retaining its old warning here would make a real fix fail
  // the gate. Anything beyond the compatibility parameter below is a regression.
  const expected = [
    'public.claim_budget_reconciliation|warning|unused parameter "p_worker"',
  ].sort();
  assert.deepEqual(actual, expected, "database lint introduced a new or changed warning/error");
  return lintCounts(functions);
}

async function seedApplicationIntegrationFixture(connection, psqlBin, isolatedHome, databaseSecret) {
  const tenantId = "70000000-0000-4000-8000-000000000001";
  const slug = "rc1-local-integration";
  successful(await runPsql(connection, psqlBin, isolatedHome, `
    insert into public.tenants (id, slug, name, vertical, status, daily_budget_usd)
    values ('${tenantId}', '${slug}', 'RC1 Local Integration', 'plumbing', 'active', 100);
    insert into public.rules (
      id, tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured
    ) values (
      '70000000-0000-4000-8000-000000000002', '${tenantId}',
      '70000000-0000-4000-8000-000000000003', 1, 'edicao_manual', 'servico', 'aprovado', 'preco',
      'Drain cleaning $149-$225',
      '{"service_type":"drain_cleaning","price_min":149,"price_target":225,"duration_min":60,"grant":"AZUL"}'::jsonb
    );
    insert into public.powers (
      id, tenant_id, subject, capability, resource, conditions, monetary_limit
    ) values (
      '70000000-0000-4000-8000-000000000004', '${tenantId}',
      'voice_agent', 'create_booking', 'drain_cleaning', '{}', 225
    );
  `), "application integration fixture", [databaseSecret]);
  return { tenantId, slug };
}

async function runBunTestFile(file, expectedPasses, environment, cwd) {
  const result = await run("bun", ["test", file], { cwd, env: environment });
  const output = successful(result, `Bun integration test ${path.basename(file)}`, [
    environment.SUPABASE_SECRET_KEY,
    environment.SUPABASE_PUBLISHABLE_KEY,
    environment.PGPASSWORD,
  ]);
  const passCount = Number(/\b(\d+) pass\b/.exec(`${output}\n${result.stderr}`)?.[1]);
  assert.equal(passCount, expectedPasses, `${path.basename(file)} did not execute every required test`);
  return passCount;
}

async function runVoiceControllerStartup(repoRoot, runtime, fixture, runnerRoot) {
  const port = 18790;
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(runnerRoot, "voice-controller-home"),
    TMPDIR: runnerRoot,
    NODE_ENV: "test",
    PORT: String(port),
    SUPABASE_URL: runtime.apiUrl,
    SUPABASE_SECRET_KEY: runtime.serviceRoleKey,
    SUPABASE_PUBLISHABLE_KEY: runtime.publishableKey,
    OPENAI_API_KEY: "synthetic-local-openai-key",
    HERMES_API_KEY: "synthetic-local-hermes-key",
    CALENDAR_PROVIDER: "fake",
    LIGOU_SYNTHETIC_TEST_CALENDAR: "1",
    LIGOU_TENANT: fixture.slug,
    LIGOU_MODEL: "gpt-realtime-2.1",
    LIGOU_FALLBACK_MODEL: "gpt-realtime-2.1-mini",
  };
  await mkdir(environment.HOME, { recursive: true });
  const child = spawn("bun", [path.join(repoRoot, "voice-controller/src/server.ts")], {
    cwd: runnerRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const exitPromise = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  try {
    let health = null;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        // The test-owned process is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!health) {
      throw new Error(`voice-controller startup failed: ${sanitize(`${stdout}\n${stderr}`, [runtime.serviceRoleKey, runtime.publishableKey])}`);
    }
    assert.deepEqual({ ok: health.ok, model: health.model, openai: health.openai }, {
      ok: true,
      model: "gpt-realtime-2.1",
      openai: true,
    });
    return 1;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3_000));
    const exit = await Promise.race([exitPromise, timeout]);
    if (exit?.timeout && child.exitCode === null) {
      child.kill("SIGKILL");
      await exitPromise;
    }
  }
}

export async function runLocalDatabaseGate() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runnerRoot = await mkdtemp(path.join(os.tmpdir(), "ligou-rc1-local-gate-"));
  const isolatedHome = path.join(runnerRoot, "home");
  const beforeStatus = await run("git", ["status", "--porcelain=v1"], { cwd: repoRoot, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  successful(beforeStatus, "Git status preflight");
  let daemonEnv;
  let colima;
  let forward;
  let runSupabase;
  let summary;
  const allowedWorkdirs = [repoRoot];
  try {
    assert.equal(process.version, "v22.22.3", "Node must be exactly 22.22.3 before the local gate runs");
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    assert.equal(packageJson.packageManager, "bun@1.2.13");
    assert.equal(packageJson.devDependencies?.supabase, "2.115.0");
    const installedSupabase = JSON.parse(await readFile(path.join(repoRoot, "node_modules/supabase/package.json"), "utf8"));
    assert.equal(installedSupabase.version, "2.115.0");
    const toolchain = JSON.parse(await readFile(path.join(repoRoot, "infra/toolchain.json"), "utf8"));
    assert.deepEqual({ node: toolchain.node, bun: toolchain.bun, deno: toolchain.deno, supabase: toolchain.supabase_cli }, {
      node: "22.22.3", bun: "1.2.13", deno: "2.9.4", supabase: "2.115.0",
    });

    const config = await readFile(path.join(repoRoot, "supabase/config.toml"), "utf8");
    const projectMatch = /^project_id\s*=\s*"([^"]+)"$/m.exec(config);
    assertSafeLocalProjectId(projectMatch?.[1]);
    if (/env\s*\(/i.test(config)) throw new Error("Local Supabase config must not reference environment values");

    await mkdir(isolatedHome, { recursive: true });
    await symlink(path.join(repoRoot, "node_modules"), path.join(runnerRoot, "node_modules"));
    colima = await discoverCanonicalColimaSocket(process.env, repoRoot);
    daemonEnv = colima.daemonEnv;
    forward = await startOwnedSshForwards(colima, runnerRoot);
    const cliEnv = buildSanitizedChildEnv(process.env, isolatedHome);
    cliEnv.DOCKER_HOST = colima.dockerHost;
    const bunVersion = successful(await run("bun", ["--version"], { cwd: runnerRoot, env: cliEnv }), "Bun version").trim();
    assert.equal(bunVersion, "1.2.13");
    const denoVersionLine = successful(await run("deno", ["--version"], { cwd: runnerRoot, env: cliEnv }), "Deno version").split("\n")[0];
    assert.equal(denoVersionLine, "deno 2.9.4 (stable, release, aarch64-apple-darwin)");

    runSupabase = async (args, label, secrets = []) => successful(await run(
      "bunx",
      ["supabase", "--workdir", repoRoot, ...args],
      { cwd: runnerRoot, env: cliEnv },
    ), label, secrets);

    await runSupabase(["--help"], "Supabase help preflight");
    const cliVersion = (await runSupabase(["--version"], "Supabase version preflight")).trim();
    assert.equal(cliVersion, "2.115.0");

    const verifyIdentity = async (workdirs = allowedWorkdirs) => {
      const listeners = await forward.listeners();
      assertOwnedForwardListeners(listeners, forward.pid);
      const runtime = parseLocalRuntimeStatus(await runSupabase(["status", "-o", "json"], "Supabase local status"));
      await inspectDisposableStack(daemonEnv, workdirs, { forwardListeners: listeners, forwardPid: forward.pid });
      return runtime;
    };
    const stopExactStack = async (workdirs = allowedWorkdirs) => {
      const listeners = await forward.listeners();
      assertOwnedForwardListeners(listeners, forward.pid);
      const stack = await inspectDisposableStack(daemonEnv, workdirs, {
        allowMissing: true, forwardListeners: listeners, forwardPid: forward.pid,
      });
      if (!stack) return false;
      const localStatus = parseLocalStatus(await runSupabase(["status", "-o", "json"], "pre-stop Supabase local status"));
      assertExactLocalDatabaseIdentity(localStatus.databaseUrl, LOCAL_PROJECT_ID);
      await guardedDestructiveAction(stack, { allowedWorkdirs: workdirs }, () => runSupabase([
        "stop", "--project-id", LOCAL_PROJECT_ID, "--no-backup",
      ], "exact local stack stop", [decodeURIComponent(localStatus.databaseUrl.password)]));
      assert.equal(await inspectDisposableStack(daemonEnv, workdirs, {
        allowMissing: true, forwardListeners: listeners, forwardPid: forward.pid,
      }), null);
      return true;
    };

    // A prior interrupted gate may leave only this exact healthy stack. Never stop an uncertain container.
    const initialListeners = await forward.listeners();
    if (await inspectDisposableStack(daemonEnv, allowedWorkdirs, {
      allowMissing: true, forwardListeners: initialListeners, forwardPid: forward.pid,
    })) {
      await stopExactStack(allowedWorkdirs);
    }
    await runSupabase(["start"], "local API stack start");
    let runtime = await verifyIdentity([repoRoot]);
    let connection = runtime.databaseUrl;
    let databaseSecret = decodeURIComponent(connection.password);
    const psqlBin = await resolvePsql();

    const migrationDir = path.join(repoRoot, "supabase/migrations");
    const migrationFiles = orderMigrationFiles((await readdir(migrationDir)).filter((name) => name.endsWith(".sql")));
    const extensionStatements = assertNoExtensionVersionClauses(await Promise.all(migrationFiles.map(async (name) => ({
      name,
      sql: await readFile(path.join(migrationDir, name), "utf8"),
    }))));

    await verifyIdentity([repoRoot]);
    await runSupabase(["db", "reset", "--local", "--no-seed"], "fresh local database reset", [databaseSecret]);
    runtime = await verifyIdentity([repoRoot]);
    connection = runtime.databaseUrl;
    databaseSecret = decodeURIComponent(connection.password);
    await runSupabase(["migration", "list", "--local"], "local migration list", [databaseSecret]);
    const historyOutput = successful(await runPsql(connection, psqlBin, isolatedHome, `
      select version from supabase_migrations.schema_migrations order by version;
    `), "local migration history", [databaseSecret]);
    const history = historyOutput.split("\n").filter(Boolean);
    const migrationEvidence = assertMigrationHistory(migrationFiles, history);
    const postgresVersion = successful(await runPsql(connection, psqlBin, isolatedHome, `
      select current_setting('server_version');
    `), "Postgres version", [databaseSecret]).trim();

    const pgTapOutput = await runSupabase([
      "test", "db", "--local", path.join(repoRoot, "supabase/tests/database/00_schema_security.sql"),
    ], "database pgTAP assertions", [databaseSecret]);
    const pgTapCount = Number(/Tests=(\d+)/.exec(pgTapOutput)?.[1]);
    assert.equal(pgTapCount, 29);

    const testEnvironment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PGHOST: connection.hostname,
      PGPORT: connection.port,
      PGDATABASE: connection.pathname.slice(1),
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: databaseSecret,
      LIGOU_LOCAL_PROJECT_ID: LOCAL_PROJECT_ID,
      LIGOU_PSQL_BIN: psqlBin,
      LIGOU_DOCKER_HOST: colima.dockerHost,
    };
    const concurrency = await runConcurrencySuite(testEnvironment);
    const websiteInterview = await runWebsiteInterviewActualSchemaSuite(testEnvironment);
    const upgrade = await runUpgradeRehearsal(testEnvironment, {
      beforeDestructive: async ({ rehearsalRoot }) => {
        if (!allowedWorkdirs.includes(rehearsalRoot)) allowedWorkdirs.push(rehearsalRoot);
        await verifyIdentity(allowedWorkdirs);
      },
    });
    assert.equal(upgrade.finalMigrations, migrationFiles.length);
    if (!allowedWorkdirs.includes(upgrade.stackWorkdir)) allowedWorkdirs.push(upgrade.stackWorkdir);

    // Recreate the API stack from the committed workdir after the staged upgrade changed DB labels.
    await stopExactStack(allowedWorkdirs);
    await runSupabase(["start"], "post-upgrade local API stack start");
    runtime = await verifyIdentity([repoRoot]);
    connection = runtime.databaseUrl;
    databaseSecret = decodeURIComponent(connection.password);
    await verifyIdentity([repoRoot]);
    await runSupabase(["db", "reset", "--local", "--no-seed"], "post-upgrade clean database reset", [databaseSecret]);
    runtime = await verifyIdentity([repoRoot]);
    connection = runtime.databaseUrl;
    databaseSecret = decodeURIComponent(connection.password);

    const finalPgTapOutput = await runSupabase([
      "test", "db", "--local", path.join(repoRoot, "supabase/tests/database/00_schema_security.sql"),
    ], "post-upgrade pgTAP assertions", [databaseSecret]);
    assert.equal(Number(/Tests=(\d+)/.exec(finalPgTapOutput)?.[1]), pgTapCount);

    const finalHistoryOutput = successful(await runPsql(connection, psqlBin, isolatedHome, `
      select version from supabase_migrations.schema_migrations order by version;
    `), "post-upgrade migration history", [databaseSecret]);
    assertMigrationHistory(migrationFiles, finalHistoryOutput.split("\n").filter(Boolean));

    const fixture = await seedApplicationIntegrationFixture(connection, psqlBin, isolatedHome, databaseSecret);
    const authenticatedRls = await runAuthenticatedRlsSuite({
      apiUrl: runtime.apiUrl,
      projectId: LOCAL_PROJECT_ID,
      serviceRoleKey: runtime.serviceRoleKey,
      publishableKey: runtime.publishableKey,
      psqlBin,
      home: isolatedHome,
      pgHost: connection.hostname,
      pgPort: connection.port,
      pgDatabase: connection.pathname.slice(1),
      pgUser: decodeURIComponent(connection.username),
      pgPassword: databaseSecret,
    });
    assert.equal(authenticatedRls.tests, 38);
    const applicationEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: path.join(runnerRoot, "application-home"),
      TMPDIR: runnerRoot,
      NODE_ENV: "test",
      SUPABASE_URL: runtime.apiUrl,
      SUPABASE_SECRET_KEY: runtime.serviceRoleKey,
      SUPABASE_PUBLISHABLE_KEY: runtime.publishableKey,
      OPENAI_API_KEY: "synthetic-local-openai-key",
      HERMES_API_KEY: "synthetic-local-hermes-key",
      GOOGLE_OAUTH_CLIENT_ID: "synthetic-local-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-local-secret",
      CONTACT_HASH_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      CALENDAR_PROVIDER: "fake",
      LIGOU_SYNTHETIC_TEST_CALENDAR: "1",
      LIGOU_TEST_PRESEEDED_TENANT_ID: fixture.tenantId,
      LIGOU_TEST_PRESEEDED_TENANT_SLUG: fixture.slug,
      LIGOU_LOCAL_DB_TEST: "1",
      LIGOU_LOCAL_PROJECT_ID: LOCAL_PROJECT_ID,
      LIGOU_PSQL_BIN: psqlBin,
      PGHOST: connection.hostname,
      PGPORT: connection.port,
      PGDATABASE: connection.pathname.slice(1),
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: databaseSecret,
    };
    await mkdir(applicationEnv.HOME, { recursive: true });
    const applicationIntegrationTests = await runBunTestFile(
      path.join(repoRoot, "voice-controller/test/booking.integration.test.ts"), 6, applicationEnv, runnerRoot,
    );
    const onboardingPolicyIntegrationTests = await runBunTestFile(
      path.join(repoRoot, "voice-controller/test/onboarding-policy.local.integration.test.ts"), 1, applicationEnv, runnerRoot,
    );
    const companyDiscoveryIntegrationTests = await runBunTestFile(
      path.join(repoRoot, "voice-controller/test/company-discovery-migration.test.ts"), 31, applicationEnv, runnerRoot,
    );
    const summarySubscriptionIntegrationTests = await runBunTestFile(
      path.join(repoRoot, "voice-controller/test/summary-subscription.test.ts"), 16, applicationEnv, runnerRoot,
    );
    const budgetRuntimeTests = await runBunTestFile(
      path.join(repoRoot, "voice-controller/test/budget.local.integration.test.ts"), 2, applicationEnv, runnerRoot,
    );
    const startupTests = await runVoiceControllerStartup(repoRoot, runtime, fixture, runnerRoot);

    const beforeNoop = successful(await runPsql(connection, psqlBin, isolatedHome, `
      select version from supabase_migrations.schema_migrations order by version;
    `), "pre-noop migration history", [databaseSecret]).split("\n").filter(Boolean);
    await verifyIdentity([repoRoot]);
    const noopOutput = await runSupabase(["migration", "up", "--local"], "local migration no-op", [databaseSecret]);
    assert.match(noopOutput, /Local database is up to date/i);
    const afterNoop = successful(await runPsql(connection, psqlBin, isolatedHome, `
      select version from supabase_migrations.schema_migrations order by version;
    `), "post-noop migration history", [databaseSecret]).split("\n").filter(Boolean);
    assert.deepEqual(afterNoop, beforeNoop);
    assertMigrationHistory(migrationFiles, afterNoop);

    const lintRows = JSON.parse(await runSupabase([
      "db", "lint", "--local", "--schema", "public", "--level", "warning", "--fail-on", "none",
    ], "database lint", [databaseSecret]));
    const advisorRows = JSON.parse(await runSupabase([
      "db", "advisors", "--local", "--type", "all", "--level", "info", "--fail-on", "warn",
    ], "database advisors", [databaseSecret]));
    const afterStatus = await run("git", ["status", "--porcelain=v1"], { cwd: repoRoot, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    successful(afterStatus, "Git status postflight");
    assert.equal(afterStatus.stdout, beforeStatus.stdout, "local database gate must not mutate tracked worktree state");

    summary = {
      status: "passed",
      projectId: LOCAL_PROJECT_ID,
      versions: {
        supabaseCli: cliVersion,
        postgres: postgresVersion,
        bun: bunVersion,
        node: process.versions.node,
        deno: "2.9.4",
      },
      migrations: migrationEvidence.migrationCount,
      missing0008: migrationEvidence.missing0008,
      extensionStatementsWithoutVersionClauses: extensionStatements,
      sqlAssertions: pgTapCount,
      concurrencyTests: concurrency.tests,
      websiteInterview,
      upgradeTests: upgrade.tests,
      applicationIntegrationTests,
      onboardingPolicyIntegrationTests,
      companyDiscoveryIntegrationTests,
      summarySubscriptionIntegrationTests,
      budgetRuntimeTests,
      startupTests,
      authenticatedRlsTests: authenticatedRls.tests,
      migrationNoop: true,
      lint: assertExpectedLegacyLint(lintRows),
      advisors: issueCounts(advisorRows),
      trackedTreeMutated: false,
    };
  } finally {
    let cleanupError = null;
    if (daemonEnv && runSupabase) {
      try {
        const listeners = forward ? await forward.listeners() : [];
        if (forward) assertOwnedForwardListeners(listeners, forward.pid);
        const current = await inspectDisposableStack(daemonEnv, allowedWorkdirs, {
          allowMissing: true,
          forwardListeners: forward ? listeners : undefined,
          forwardPid: forward?.pid,
        });
        if (current) {
          const localStatus = parseLocalStatus(await runSupabase(["status", "-o", "json"], "final pre-stop Supabase local status"));
          assertExactLocalDatabaseIdentity(localStatus.databaseUrl, LOCAL_PROJECT_ID);
          await guardedDestructiveAction(current, { allowedWorkdirs }, () => runSupabase([
            "stop", "--project-id", LOCAL_PROJECT_ID, "--no-backup",
          ], "final exact local stack stop", [decodeURIComponent(localStatus.databaseUrl.password)]));
          assert.equal(await inspectDisposableStack(daemonEnv, allowedWorkdirs, {
            allowMissing: true, forwardListeners: listeners, forwardPid: forward.pid,
          }), null);
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      if (forward && colima) await stopOwnedSshForwards(forward, colima.discoveryEnv);
    } catch (error) {
      cleanupError ??= error;
    }
    if (!cleanupError && colima) {
      try {
        await stopDedicatedColimaProfile(colima);
      } catch (error) {
        cleanupError = error;
      }
    }
    await rm(runnerRoot, { recursive: true, force: true });
    if (cleanupError) throw cleanupError;
  }
  summary.stackStoppedAndDestroyed = true;
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(await runLocalDatabaseGate(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : "Local database gate failed");
    process.exitCode = 1;
  }
}
