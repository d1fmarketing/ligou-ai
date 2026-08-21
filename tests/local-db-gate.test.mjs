import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertCanonicalColimaIdentity,
  assertDisposableStackIdentity,
  assertExactLocalDatabaseIdentity,
  assertLoopbackDatabaseUrl,
  assertMigrationHistory,
  assertNoExtensionVersionClauses,
  assertOwnedForwardListeners,
  assertSafeLocalProjectId,
  buildSanitizedChildEnv,
  guardedDestructiveAction,
  orderMigrationFiles,
  parseLocalRuntimeStatus,
  parseLocalStatus,
} from "../scripts/local-db-gate.mjs";

const rlsModule = await import("../supabase/tests/local-db-rls.mjs").catch(() => ({}));

test("authenticated RLS gate accepts only the exact disposable REST identity", () => {
  assert.equal(typeof rlsModule.assertLocalRlsEnvironment, "function");
  const accepted = rlsModule.assertLocalRlsEnvironment({
    apiUrl: "http://127.0.0.1:54321",
    projectId: "ligou-v0-1-rc1",
    serviceRoleKey: "synthetic-service-role",
    publishableKey: "synthetic-publishable",
  });
  assert.equal(accepted.apiUrl, "http://127.0.0.1:54321");
  for (const unsafe of [
    { ...accepted, apiUrl: "https://production.invalid" },
    { ...accepted, apiUrl: "http://127.0.0.1:6543" },
    { ...accepted, projectId: "ligou-production" },
  ]) {
    assert.throws(() => rlsModule.assertLocalRlsEnvironment(unsafe), /disposable RLS identity/i);
  }
});

test("local DB gate rejects non-loopback database hosts without echoing credentials", () => {
  const secret = "synthetic-password-that-must-not-leak";

  assert.throws(
    () => assertLoopbackDatabaseUrl(`postgresql://postgres:${secret}@db.production.example:5432/postgres`),
    (error) => {
      assert.match(error.message, /loopback/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, /db[.]production[.]example/);
      return true;
    },
  );

  const exact = new URL("postgresql://postgres:synthetic@127.0.0.1:54322/postgres");
  assert.equal(assertExactLocalDatabaseIdentity(exact, "ligou-v0-1-rc1"), exact);
  for (const unsafe of [
    "postgresql://postgres:synthetic@127.0.0.1:6543/postgres",
    "postgresql://postgres:synthetic@127.0.0.1:54322/forwarded_prod",
    "postgresql://app:synthetic@127.0.0.1:54322/postgres",
  ]) {
    assert.throws(
      () => assertExactLocalDatabaseIdentity(new URL(unsafe), "ligou-v0-1-rc1"),
      /exact disposable database identity/i,
    );
  }
});

test("extension migrations reject explicit version clauses", () => {
  assert.equal(assertNoExtensionVersionClauses([
    { name: "0001.sql", sql: "create extension if not exists pgcrypto;" },
    { name: "0010.sql", sql: "create extension if not exists btree_gist with schema extensions;" },
  ]), 2);
  assert.throws(
    () => assertNoExtensionVersionClauses([{ name: "unsafe.sql", sql: "create extension pgcrypto version '1.3';" }]),
    /extension version clauses are forbidden/i,
  );
});

test("migration history must match every repository migration exactly once", () => {
  assert.deepEqual(
    assertMigrationHistory(
      ["0009_browser.sql", "0007_phone.sql", "20260821023201_forward.sql"],
      ["0007", "0009", "20260821023201"],
    ),
    { migrationCount: 3, missing0008: true },
  );
  assert.throws(
    () => assertMigrationHistory(["0007_phone.sql", "0009_browser.sql"], ["0007", "0007", "0009"]),
    /history does not match/i,
  );
  assert.throws(
    () => assertMigrationHistory(["0007_phone.sql", "0009_browser.sql"], ["0007"]),
    /history does not match/i,
  );
});

test("local DB gate strips inherited database, Supabase, and dotenv inputs", () => {
  const child = buildSanitizedChildEnv({
    PATH: "/synthetic/bin",
    HOME: "/Users/synthetic",
    DATABASE_URL: "postgresql://remote.invalid/prod",
    SUPABASE_ACCESS_TOKEN: "synthetic-remote-token",
    SUPABASE_DB_PASSWORD: "synthetic-remote-password",
    PGHOST: "remote.invalid",
    DOTENV_CONFIG_PATH: "/synthetic/.env",
    DOCKER_HOST: "unix:///synthetic/docker.sock",
  }, "/synthetic/isolated-home");

  assert.equal(child.PATH, "/synthetic/bin");
  assert.equal(child.HOME, "/synthetic/isolated-home");
  assert.equal(child.DOCKER_HOST, undefined);
  assert.equal(child.SUPABASE_NO_UPDATE_NOTIFIER, "1");
  for (const forbidden of [
    "DATABASE_URL",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
    "PGHOST",
    "DOTENV_CONFIG_PATH",
    "DOCKER_HOST",
  ]) {
    assert.equal(child[forbidden], undefined);
  }

  const colima = {
    inheritedDockerHost: undefined,
    status: {
      display_name: "colima [profile=ligou-rc1]",
      runtime: "docker",
      docker_socket: "unix:///Users/synthetic/.colima/ligou-rc1/docker.sock",
    },
    contextHost: "unix:///Users/synthetic/.colima/ligou-rc1/docker.sock",
    runtimeRootRealpath: "/Users/synthetic/.colima/ligou-rc1",
    socketRealpath: "/Users/synthetic/.colima/ligou-rc1/docker.sock",
    profileConfig: {
      runtime: "docker",
      autoActivate: false,
      portForwarder: "none",
      mountLocation: "/synthetic/rc1/Ligou.AI",
      mountWritable: true,
    },
    expectedMountLocation: "/synthetic/rc1/Ligou.AI",
    sshConfigRealpath: "/Users/synthetic/.colima/_lima/colima-ligou-rc1/ssh.config",
    expectedSshConfigRealpath: "/Users/synthetic/.colima/_lima/colima-ligou-rc1/ssh.config",
  };
  assert.equal(assertCanonicalColimaIdentity(colima), colima.status.docker_socket);
  assert.throws(
    () => assertCanonicalColimaIdentity({ ...colima, inheritedDockerHost: "unix:///tmp/forwarded.sock" }),
    /inherited docker_host/i,
  );
  assert.throws(
    () => assertCanonicalColimaIdentity({ ...colima, contextHost: "unix:///tmp/forwarded.sock" }),
    /canonical colima socket/i,
  );

  const stack = {
    Name: "/supabase_db_ligou-v0-1-rc1",
    Config: {
      Image: "public.ecr.aws/supabase/postgres:17.6.1.159",
      Labels: {
        "com.docker.compose.project": "ligou-v0-1-rc1",
        "com.supabase.cli.project": "ligou-v0-1-rc1",
        "com.supabase.cli.workdir": "/synthetic/rc1/Ligou.AI",
      },
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "", HostPort: "54322" }] } },
    NetworkSettings: { Ports: { "5432/tcp": [
      { HostIp: "0.0.0.0", HostPort: "54322" },
      { HostIp: "::", HostPort: "54322" },
    ] } },
    Mounts: [{ Type: "volume", Name: "supabase_db_ligou-v0-1-rc1", Destination: "/var/lib/postgresql/data" }],
  };
  const identityOptions = { allowedWorkdirs: ["/synthetic/rc1/Ligou.AI"] };
  const listeners = [
    { pid: 4242, address: "127.0.0.1", port: 54321 },
    { pid: 4242, address: "127.0.0.1", port: 54322 },
  ];
  assert.equal(assertOwnedForwardListeners(listeners, 4242), listeners);
  identityOptions.forwardListeners = listeners;
  identityOptions.forwardPid = 4242;
  assert.equal(assertDisposableStackIdentity(stack, identityOptions), stack);

  let destructiveCalls = 0;
  const invalidStacks = [
    { ...structuredClone(stack), Name: "/supabase_db_other-project" },
    (() => { const value = structuredClone(stack); value.Config.Labels["com.supabase.cli.project"] = "other-project"; return value; })(),
    (() => { const value = structuredClone(stack); value.NetworkSettings.Ports["5432/tcp"][0].HostPort = "6543"; return value; })(),
  ];
  for (const invalid of invalidStacks) {
    assert.throws(
      () => guardedDestructiveAction(invalid, identityOptions, () => { destructiveCalls += 1; }),
      /disposable stack identity/i,
    );
  }
  assert.throws(
    () => guardedDestructiveAction(stack, {
      ...identityOptions,
      forwardListeners: [{ pid: 4242, address: "0.0.0.0", port: 54322 }],
    }, () => { destructiveCalls += 1; }),
    /owned loopback ssh forwards/i,
  );
  assert.equal(destructiveCalls, 0);
  guardedDestructiveAction(stack, identityOptions, () => { destructiveCalls += 1; });
  assert.equal(destructiveCalls, 1);
});

test("local DB gate derives its database connection only from sanitized CLI status JSON", () => {
  const status = parseLocalStatus(JSON.stringify({
    API_URL: "http://127.0.0.1:54321",
    DB_URL: "postgresql://postgres:synthetic-local-only@127.0.0.1:54322/postgres",
    SERVICE_ROLE_KEY: "synthetic-local-key-that-must-not-be-returned",
  }));

  assert.equal(status.databaseUrl.hostname, "127.0.0.1");
  assert.equal(status.databaseUrl.port, "54322");
  assert.deepEqual(Object.keys(status), ["databaseUrl"]);

  const runtime = parseLocalRuntimeStatus(JSON.stringify({
    API_URL: "http://127.0.0.1:54321",
    DB_URL: "postgresql://postgres:synthetic-local-only@127.0.0.1:54322/postgres",
    SERVICE_ROLE_KEY: "synthetic-local-service-key",
    ANON_KEY: "synthetic-local-publishable-key",
  }));
  assert.equal(runtime.apiUrl, "http://127.0.0.1:54321");
  assert.equal(runtime.serviceRoleKey, "synthetic-local-service-key");
  assert.equal(runtime.publishableKey, "synthetic-local-publishable-key");
  assert.throws(
    () => parseLocalRuntimeStatus(JSON.stringify({
      API_URL: "http://127.0.0.1:6543",
      DB_URL: "postgresql://postgres:synthetic@127.0.0.1:54322/postgres",
      SERVICE_ROLE_KEY: "synthetic",
      ANON_KEY: "synthetic",
    })),
    /exact disposable api identity/i,
  );
});

test("local DB gate accepts only the disposable RC1 project identity", () => {
  assert.equal(assertSafeLocalProjectId("ligou-v0-1-rc1"), "ligou-v0-1-rc1");
  for (const unsafe of ["ligou-production", "ligou-staging", "project-ref-abcdefghijklmnopqrst"]) {
    assert.throws(() => assertSafeLocalProjectId(unsafe), /disposable RC1 project/i);
  }
});

test("migration ordering preserves the intentional missing 0008 boundary and rejects duplicate versions", () => {
  assert.deepEqual(
    orderMigrationFiles([
      "20260820150634_forward.sql",
      "0009_browser.sql",
      "0007_phone.sql",
      "0014_summary.sql",
    ]),
    ["0007_phone.sql", "0009_browser.sql", "0014_summary.sql", "20260820150634_forward.sql"],
  );
  assert.throws(
    () => orderMigrationFiles(["0007_phone.sql", "0007_duplicate.sql"]),
    /duplicate migration version 0007/i,
  );
});

test("repository exposes the exact pinned local Supabase gate", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.packageManager, "bun@1.2.13");
  assert.equal(packageJson.devDependencies?.supabase, "2.115.0");
  assert.equal(packageJson.scripts?.["db:gate:local"], "node scripts/local-db-gate.mjs");
});

test("Supabase config is disposable, imperative, and contains no secret indirection", async () => {
  const config = await readFile(new URL("../supabase/config.toml", import.meta.url), "utf8");
  assert.match(config, /^project_id = "ligou-v0-1-rc1"$/m);
  assert.match(config, /^\[api\]\nenabled = true$/m);
  assert.match(config, /^\[auth\]\nenabled = true$/m);
  assert.match(config, /^\[db[.]migrations\]$/m);
  assert.match(config, /^schema_paths = \[\]$/m);
  assert.doesNotMatch(config, /env\s*\(/i);
  assert.doesNotMatch(config, /project[_-]?ref|https?:\/\//i);
});
