#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runConcurrencySuite } from "../supabase/tests/local-db-concurrency.mjs";
import { runUpgradeRehearsal } from "../supabase/tests/local-db-upgrade-rehearsal.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const LOCAL_PROJECT_ID = "ligou-v0-1-rc1";
const PASSTHROUGH_ENV = [
  "CI",
  "DOCKER_HOST",
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
    throw new Error(`${label} failed: ${sanitize(result.stderr, secrets) || "command exited non-zero"}`);
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

async function resolveDockerHost(sourceEnv) {
  if (typeof sourceEnv.DOCKER_HOST === "string" && sourceEnv.DOCKER_HOST.startsWith("unix://")) {
    return sourceEnv.DOCKER_HOST;
  }
  const socket = await firstAccessible([
    path.join(os.homedir(), ".colima/default/docker.sock"),
    "/var/run/docker.sock",
  ]);
  if (!socket) throw new Error("No local Unix Docker socket is available");
  return `unix://${socket}`;
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

export async function runLocalDatabaseGate() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runnerRoot = await mkdtemp(path.join(os.tmpdir(), "ligou-rc1-local-gate-"));
  const isolatedHome = path.join(runnerRoot, "home");
  const beforeStatus = await run("git", ["status", "--porcelain=v1"], { cwd: repoRoot, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  successful(beforeStatus, "Git status preflight");

  try {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    assert.equal(packageJson.packageManager, "bun@1.2.13");
    assert.equal(packageJson.devDependencies?.supabase, "2.115.0");
    const installedSupabase = JSON.parse(await readFile(path.join(repoRoot, "node_modules/supabase/package.json"), "utf8"));
    assert.equal(installedSupabase.version, "2.115.0");

    const config = await readFile(path.join(repoRoot, "supabase/config.toml"), "utf8");
    const projectMatch = /^project_id\s*=\s*"([^"]+)"$/m.exec(config);
    assertSafeLocalProjectId(projectMatch?.[1]);
    if (/env\s*\(/i.test(config)) throw new Error("Local Supabase config must not reference environment values");

    await mkdir(isolatedHome, { recursive: true });
    await symlink(path.join(repoRoot, "node_modules"), path.join(runnerRoot, "node_modules"));
    const dockerHost = await resolveDockerHost(process.env);
    const cliEnv = buildSanitizedChildEnv(process.env, isolatedHome);
    cliEnv.DOCKER_HOST = dockerHost;
    const runSupabase = async (args, label, secrets = []) => successful(await run(
      "bunx",
      ["supabase", "--workdir", repoRoot, ...args],
      { cwd: runnerRoot, env: cliEnv },
    ), label, secrets);

    await runSupabase(["--help"], "Supabase help preflight");
    const cliVersion = (await runSupabase(["--version"], "Supabase version preflight")).trim();
    assert.equal(cliVersion, "2.115.0");

    // This is the only source of connection coordinates. No environment database URL is consulted.
    const status = parseLocalStatus(await runSupabase(["status", "-o", "json"], "Supabase local status"));
    const connection = status.databaseUrl;
    const databaseSecret = decodeURIComponent(connection.password);
    const psqlBin = await resolvePsql();

    const migrationDir = path.join(repoRoot, "supabase/migrations");
    const migrationFiles = orderMigrationFiles((await readdir(migrationDir)).filter((name) => name.endsWith(".sql")));
    const extensionStatements = assertNoExtensionVersionClauses(await Promise.all(migrationFiles.map(async (name) => ({
      name,
      sql: await readFile(path.join(migrationDir, name), "utf8"),
    }))));

    await runSupabase(["db", "reset", "--local", "--no-seed"], "fresh local database reset", [databaseSecret]);
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
    assert.equal(pgTapCount, 24);

    const testEnvironment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PGHOST: connection.hostname,
      PGPORT: connection.port,
      PGDATABASE: connection.pathname.slice(1),
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: databaseSecret,
      LIGOU_LOCAL_PROJECT_ID: LOCAL_PROJECT_ID,
      LIGOU_PSQL_BIN: psqlBin,
      LIGOU_DOCKER_HOST: dockerHost,
    };
    const concurrency = await runConcurrencySuite(testEnvironment);
    const upgrade = await runUpgradeRehearsal(testEnvironment);
    assert.equal(upgrade.finalMigrations, migrationFiles.length);

    const finalPgTapOutput = await runSupabase([
      "test", "db", "--local", path.join(repoRoot, "supabase/tests/database/00_schema_security.sql"),
    ], "post-upgrade pgTAP assertions", [databaseSecret]);
    assert.equal(Number(/Tests=(\d+)/.exec(finalPgTapOutput)?.[1]), pgTapCount);

    const finalHistoryOutput = successful(await runPsql(connection, psqlBin, isolatedHome, `
      select version from supabase_migrations.schema_migrations order by version;
    `), "post-upgrade migration history", [databaseSecret]);
    assertMigrationHistory(migrationFiles, finalHistoryOutput.split("\n").filter(Boolean));

    const lintRows = JSON.parse(await runSupabase([
      "db", "lint", "--local", "--schema", "public", "--level", "warning", "--fail-on", "error",
    ], "database lint", [databaseSecret]));
    const advisorRows = JSON.parse(await runSupabase([
      "db", "advisors", "--local", "--type", "all", "--level", "info", "--fail-on", "none",
    ], "database advisors", [databaseSecret]));

    const bunVersion = successful(await run("bun", ["--version"], { cwd: runnerRoot, env: cliEnv }), "Bun version").trim();
    const denoVersion = successful(await run("deno", ["--version"], { cwd: runnerRoot, env: cliEnv }), "Deno version").split("\n")[0].replace(/^deno\s+/, "");
    const afterStatus = await run("git", ["status", "--porcelain=v1"], { cwd: repoRoot, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    successful(afterStatus, "Git status postflight");
    assert.equal(afterStatus.stdout, beforeStatus.stdout, "local database gate must not mutate tracked worktree state");

    return {
      status: "passed",
      projectId: LOCAL_PROJECT_ID,
      versions: {
        supabaseCli: cliVersion,
        postgres: postgresVersion,
        bun: bunVersion,
        node: process.versions.node,
        deno: denoVersion,
      },
      migrations: migrationEvidence.migrationCount,
      missing0008: migrationEvidence.missing0008,
      extensionStatementsWithoutVersionClauses: extensionStatements,
      sqlAssertions: pgTapCount,
      concurrencyTests: concurrency.tests,
      upgradeTests: upgrade.tests,
      lint: lintCounts(lintRows),
      advisors: issueCounts(advisorRows),
      trackedTreeMutated: false,
    };
  } finally {
    await rm(runnerRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(await runLocalDatabaseGate(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Local database gate failed");
    process.exitCode = 1;
  }
}
