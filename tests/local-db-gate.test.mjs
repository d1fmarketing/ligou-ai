import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertLoopbackDatabaseUrl,
  assertMigrationHistory,
  assertNoExtensionVersionClauses,
  assertSafeLocalProjectId,
  buildSanitizedChildEnv,
  orderMigrationFiles,
  parseLocalStatus,
} from "../scripts/local-db-gate.mjs";

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
  assert.equal(child.DOCKER_HOST, "unix:///synthetic/docker.sock");
  assert.equal(child.SUPABASE_NO_UPDATE_NOTIFIER, "1");
  for (const forbidden of [
    "DATABASE_URL",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
    "PGHOST",
    "DOTENV_CONFIG_PATH",
  ]) {
    assert.equal(child[forbidden], undefined);
  }
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
  assert.match(config, /^\[db[.]migrations\]$/m);
  assert.match(config, /^schema_paths = \[\]$/m);
  assert.doesNotMatch(config, /env\s*\(/i);
  assert.doesNotMatch(config, /project[_-]?ref|https?:\/\//i);
});
