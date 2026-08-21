#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const projectId = "ligou-v0-1-rc1";
const retirementVersion = "20260820214558";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function localConnection(env = process.env) {
  const result = {
    host: env.PGHOST ?? "",
    port: env.PGPORT ?? "",
    database: env.PGDATABASE ?? "",
    user: env.PGUSER ?? "",
    password: env.PGPASSWORD ?? "",
    psqlBin: env.LIGOU_PSQL_BIN ?? "psql",
    dockerHost: env.LIGOU_DOCKER_HOST ?? "",
  };
  if (env.LIGOU_LOCAL_PROJECT_ID !== projectId || !loopbackHosts.has(result.host)) {
    throw new Error("upgrade rehearsal requires the disposable loopback RC1 project");
  }
  if (/prod|production|live|staging/i.test(`${result.database}:${env.LIGOU_LOCAL_PROJECT_ID}`)) {
    throw new Error("upgrade rehearsal rejected a production-looking identity");
  }
  if (!/^\d{2,5}$/.test(result.port) || !result.database || !result.user || !result.password) {
    throw new Error("upgrade rehearsal local database configuration is incomplete");
  }
  if (result.psqlBin !== "psql"
      && (!path.isAbsolute(result.psqlBin) || path.basename(result.psqlBin) !== "psql")) {
    throw new Error("upgrade rehearsal rejected the psql executable");
  }
  if (!result.dockerHost.startsWith("unix://") || /prod|remote/i.test(result.dockerHost)) {
    throw new Error("upgrade rehearsal requires a local Unix Docker socket");
  }
  return result;
}

function databaseUrl(connection) {
  const url = new URL("postgresql://localhost/postgres");
  url.hostname = connection.host;
  url.port = connection.port;
  url.pathname = `/${connection.database}`;
  url.username = connection.user;
  url.password = connection.password;
  return url.toString();
}

function sanitize(value, password) {
  return String(value).split(password).join("[redacted]").replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-db-url]");
}

function run(command, args, { cwd, env, input } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), durationMs: Date.now() - startedAt }));
    child.stdin.end(input ?? "");
  });
}

function successful(result, label, password) {
  assert.equal(result.code, 0, `${label} failed: ${sanitize(result.stderr, password) || "command exited non-zero"}`);
  return result.stdout;
}

function migrationVersion(fileName) {
  const match = /^(\d+)_.*[.]sql$/.exec(fileName);
  if (!match) throw new Error("invalid migration filename in upgrade rehearsal");
  return match[1];
}

function orderMigrations(fileNames) {
  return [...fileNames].sort((left, right) => {
    const a = BigInt(migrationVersion(left));
    const b = BigInt(migrationVersion(right));
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

async function runPsql(connection, home, sql) {
  const result = await run(connection.psqlBin, [
    "-X", "--set=ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--quiet", "--file=-",
  ], {
    input: sql,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      LANG: "C",
      PGAPPNAME: "ligou_rc1_upgrade_rehearsal",
      PGCONNECT_TIMEOUT: "5",
      PGHOST: connection.host,
      PGPORT: connection.port,
      PGDATABASE: connection.database,
      PGUSER: connection.user,
      PGPASSWORD: connection.password,
    },
  });
  return result;
}

async function runDenoConverter(connection, home, tenantId, encodedKey, apply) {
  const args = [
    "run",
    "--quiet",
    "--allow-env",
    `--allow-net=${connection.host}:${connection.port}`,
    "--config", path.join(repoRoot, "supabase/deno.json"),
    "--lock", path.join(repoRoot, "supabase/deno.lock"),
    path.join(repoRoot, "supabase/scripts/migrate-connector-tokens.ts"),
    "--tenant", tenantId,
  ];
  if (apply) args.push("--apply");
  return run("deno", args, {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      DENO_DIR: path.join(home, ".deno"),
      DATABASE_URL: databaseUrl(connection),
      CONNECTOR_TOKEN_ENCRYPTION_KEY: encodedKey,
    },
  });
}

async function history(connection, home) {
  const output = successful(await runPsql(connection, home, `
    select version from supabase_migrations.schema_migrations order by version;
  `), "migration history query", connection.password);
  return output.split("\n").filter(Boolean);
}

function assertHistory(expectedFiles, actualVersions) {
  const expected = expectedFiles.map(migrationVersion);
  assert.deepEqual(actualVersions, expected, "migration history must equal each staged file exactly once");
  assert.equal(new Set(actualVersions).size, actualVersions.length, "migration history must not contain duplicates");
}

export async function runUpgradeRehearsal(env = process.env, hooks = {}) {
  const connection = localConnection(env);
  const rehearsalRoot = await mkdtemp(path.join(os.tmpdir(), "ligou-rc1-upgrade-"));
  const home = path.join(rehearsalRoot, "home");
  const supabaseRoot = path.join(rehearsalRoot, "supabase");
  const stagedMigrations = path.join(supabaseRoot, "migrations");
  const sourceMigrations = path.join(repoRoot, "supabase/migrations");
  const allMigrations = orderMigrations((await readdir(sourceMigrations)).filter((name) => name.endsWith(".sql")));
  const legacyMigrations = allMigrations.filter((name) => BigInt(migrationVersion(name)) <= 14n);
  const throughRetirement = allMigrations.filter((name) => BigInt(migrationVersion(name)) <= BigInt(retirementVersion));
  const tenantId = "60000000-0000-4000-8000-000000000001";
  let assertions = 0;

  await mkdir(home, { recursive: true });
  await mkdir(stagedMigrations, { recursive: true });
  await symlink(path.join(repoRoot, "node_modules"), path.join(rehearsalRoot, "node_modules"));
  const safeConfig = await readFile(path.join(repoRoot, "supabase/config.toml"), "utf8");
  assert.doesNotMatch(safeConfig, /env\s*\(/i);
  await writeFile(path.join(supabaseRoot, "config.toml"), safeConfig);

  const cliEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    TMPDIR: os.tmpdir(),
    DOCKER_HOST: connection.dockerHost,
    SUPABASE_NO_UPDATE_NOTIFIER: "1",
  };
  const runSupabase = async (args, label) => {
    const result = await run("bunx", ["supabase", "--workdir", rehearsalRoot, ...args], {
      cwd: rehearsalRoot,
      env: cliEnv,
    });
    return successful(result, label, connection.password);
  };
  const beforeDestructive = async (label) => {
    if (typeof hooks.beforeDestructive !== "function") {
      throw new Error("upgrade rehearsal requires a fail-closed stack identity hook");
    }
    await hooks.beforeDestructive({ label, rehearsalRoot });
  };
  const stage = async (fileName) => {
    await symlink(path.join(sourceMigrations, fileName), path.join(stagedMigrations, fileName));
  };

  try {
    await runSupabase(["--help"], "Supabase help preflight");
    assert.equal((await runSupabase(["--version"], "Supabase version preflight")).trim(), "2.115.0");
    assertions += 1;

    for (const fileName of legacyMigrations) await stage(fileName);
    await beforeDestructive("legacy database reset");
    await runSupabase(["db", "reset", "--local", "--no-seed"], "legacy database reset");
    assertHistory(legacyMigrations, await history(connection, home));
    assert.equal(legacyMigrations.some((name) => migrationVersion(name) === "0008"), false);
    assertions += 1;

    successful(await runPsql(connection, home, `
      insert into public.tenants (id, slug, name, status)
      values ('${tenantId}', 'synthetic-upgrade', 'Synthetic Upgrade', 'active');
      insert into public.calls (id, tenant_id, channel, session_type, status)
      values ('60000000-0000-4000-8000-000000000002', '${tenantId}', 'eval', 'customer', 'ended');
      insert into public.bookings (
        id, tenant_id, call_id, client_name, contact, service_type, price_agreed,
        slot_start, slot_end, status, idempotency_key
      ) values (
        '60000000-0000-4000-8000-000000000003', '${tenantId}',
        '60000000-0000-4000-8000-000000000002', 'Legacy', '5550600', 'plumbing', 120,
        '2030-12-01T17:00:00Z', '2030-12-01T18:00:00Z', 'confirmed', 'synthetic-legacy-booking'
      );
      insert into public.action_intents (
        id, tenant_id, call_id, booking_id, kind, payload, policy_snapshot, idempotency_key, status
      ) values (
        '60000000-0000-4000-8000-000000000004', '${tenantId}',
        '60000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000003',
        'calendar_book', '{}', '{}', 'synthetic-legacy-intent', 'succeeded'
      );
      update public.bookings set intent_id = '60000000-0000-4000-8000-000000000004'
      where id = '60000000-0000-4000-8000-000000000003';
      insert into public.receipts (
        id, tenant_id, intent_id, call_id, kind, outcome, external_id, readback, payload_hash
      ) values (
        '60000000-0000-4000-8000-000000000005', '${tenantId}',
        '60000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000002',
        'booking', 'accepted', 'synthetic-legacy-event', '{"synthetic":true}', 'synthetic-legacy-hash'
      );
      update public.bookings set receipt_id = '60000000-0000-4000-8000-000000000005'
      where id = '60000000-0000-4000-8000-000000000003';
      insert into public.connector_accounts (
        id, tenant_id, provider, refresh_token, calendar_id, account_email, status
      ) values (
        '60000000-0000-4000-8000-000000000006', '${tenantId}', 'google_calendar',
        'synthetic-legacy-refresh-token', 'synthetic-calendar', 'upgrade@example.invalid', 'active'
      );
    `), "sanitized legacy seed", connection.password);
    assert.equal(successful(await runPsql(connection, home, `
      select (select count(*) from public.receipts where intent_id = '60000000-0000-4000-8000-000000000004')::text || ':' ||
             (select (refresh_token is not null)::text from public.connector_accounts where tenant_id = '${tenantId}');
    `), "legacy seed proof", connection.password).trim(), "1:true");
    assertions += 1;

    for (const fileName of throughRetirement.slice(legacyMigrations.length)) await stage(fileName);
    await beforeDestructive("timestamp migrations through retirement");
    await runSupabase(["migration", "up", "--local", "--include-all"], "timestamp migrations through retirement");
    assertHistory(throughRetirement, await history(connection, home));
    assertions += 1;

    const failedConversion = await runDenoConverter(connection, home, tenantId, "synthetic-invalid-key", true);
    assert.notEqual(failedConversion.code, 0);
    assert.match(sanitize(failedConversion.stderr, connection.password), /connector_migration_failed/);
    assert.equal(successful(await runPsql(connection, home, `
      select (refresh_token is not null)::text || ':' || (refresh_token_ciphertext is null)::text || ':' || status
      from public.connector_accounts where tenant_id = '${tenantId}';
    `), "failed conversion preservation proof", connection.password).trim(), "true:true:reconnect_required");
    assertions += 1;

    const validKey = Buffer.alloc(32, 7).toString("base64");
    const dryRun = JSON.parse(successful(
      await runDenoConverter(connection, home, tenantId, validKey, false),
      "connector dry-run",
      connection.password,
    ).split("\n").at(-1));
    assert.deepEqual(dryRun, { tenant_id: tenantId, mode: "dry-run", eligible: 1, migrated: 0 });
    assert.equal(successful(await runPsql(connection, home, `
      select (refresh_token is not null)::text || ':' || (refresh_token_ciphertext is null)::text
      from public.connector_accounts where tenant_id = '${tenantId}';
    `), "dry-run preservation proof", connection.password).trim(), "true:true");
    assertions += 1;

    const applied = JSON.parse(successful(
      await runDenoConverter(connection, home, tenantId, validKey, true),
      "connector apply",
      connection.password,
    ).split("\n").at(-1));
    assert.deepEqual(applied, { tenant_id: tenantId, mode: "apply", eligible: 1, migrated: 1 });
    assert.equal(successful(await runPsql(connection, home, `
      select (refresh_token is null)::text || ':' || (refresh_token_ciphertext is not null)::text || ':' ||
             (token_key_version = 1)::text || ':' || status
      from public.connector_accounts where tenant_id = '${tenantId}';
    `), "connector apply proof", connection.password).trim(), "true:true:true:reconnect_required");
    assertions += 1;

    const idempotent = JSON.parse(successful(
      await runDenoConverter(connection, home, tenantId, validKey, true),
      "connector idempotency apply",
      connection.password,
    ).split("\n").at(-1));
    assert.deepEqual(idempotent, { tenant_id: tenantId, mode: "apply", eligible: 0, migrated: 0 });
    assertions += 1;

    for (const fileName of allMigrations.slice(throughRetirement.length)) await stage(fileName);
    await beforeDestructive("remaining timestamp migrations");
    await runSupabase(["migration", "up", "--local", "--include-all"], "remaining timestamp migrations");
    assertHistory(allMigrations, await history(connection, home));
    assertions += 1;

    assert.equal(successful(await runPsql(connection, home, `
      select count(*)::text || ':' || min(reason)
      from public.booking_receipt_conflicts
      where intent_id = '60000000-0000-4000-8000-000000000004';
    `), "legacy receipt quarantine proof", connection.password).trim(), "1:legacy_accepted_receipt_unverifiable");
    assertions += 1;

    assert.equal(successful(await runPsql(connection, home, `
      select (not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'connector_accounts' and column_name = 'refresh_token'
      ))::text;
    `), "plaintext column retirement proof", connection.password).trim(), "true");
    assertions += 1;

    return {
      suite: "local-db-upgrade-rehearsal",
      tests: assertions,
      passed: assertions,
      legacyMigrations: legacyMigrations.length,
      finalMigrations: allMigrations.length,
      missing0008: true,
      stackWorkdir: rehearsalRoot,
    };
  } finally {
    await rm(rehearsalRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(await runUpgradeRehearsal()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "local upgrade rehearsal failed");
    process.exitCode = 1;
  }
}
