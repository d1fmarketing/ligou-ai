#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOCAL_PROJECT_ID = "ligou-v0-1-rc1";

export function assertLocalRlsEnvironment(input) {
  let api;
  try { api = new URL(input.apiUrl); } catch { throw new Error("disposable RLS identity required"); }
  if (api.protocol !== "http:" || api.hostname !== "127.0.0.1" || api.port !== "54321" || api.pathname !== "/"
    || input.projectId !== LOCAL_PROJECT_ID
    || typeof input.serviceRoleKey !== "string" || !input.serviceRoleKey
    || typeof input.publishableKey !== "string" || !input.publishableKey) {
    throw new Error("disposable RLS identity required");
  }
  return { ...input, apiUrl: api.origin };
}

function psql(env, sql) {
  const executable = env.psqlBin === "psql" ? "psql" : env.psqlBin;
  if (executable !== "psql" && (!path.isAbsolute(executable) || path.basename(executable) !== "psql")) {
    throw new Error("disposable RLS identity required");
  }
  const result = spawnSync(executable, ["-X", "--set=ON_ERROR_STOP=1", "--quiet", "--file=-"], {
    input: sql,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: env.home,
      PGHOST: env.pgHost,
      PGPORT: env.pgPort,
      PGDATABASE: env.pgDatabase,
      PGUSER: env.pgUser,
      PGPASSWORD: env.pgPassword,
      PGCONNECT_TIMEOUT: "5",
    },
  });
  if (result.status !== 0) throw new Error("authenticated RLS fixture failed");
}

async function jsonRequest(url, init, secrets) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { response, body, safeError: () => {
    let value = text;
    for (const secret of secrets) value = value.split(secret).join("[redacted]");
    return value.slice(0, 300);
  } };
}

export async function runAuthenticatedRlsSuite(options) {
  const env = assertLocalRlsEnvironment(options);
  const serviceHeaders = {
    apikey: env.serviceRoleKey,
    Authorization: `Bearer ${env.serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  const createUser = async (email) => {
    const result = await jsonRequest(`${env.apiUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: serviceHeaders,
      body: JSON.stringify({ email, password: "Synthetic-RLS-Password-42!", email_confirm: true }),
    }, [env.serviceRoleKey, env.publishableKey]);
    if (!result.response.ok || typeof result.body?.id !== "string") {
      throw new Error(`authenticated RLS user creation failed: ${result.safeError()}`);
    }
    return result.body.id;
  };
  const userA = await createUser("rls-alpha@example.invalid");
  const userB = await createUser("rls-beta@example.invalid");
  if (![userA, userB].every((value) => /^[a-f0-9-]{36}$/i.test(value))) throw new Error("authenticated RLS user identity invalid");

  psql(env, `
    insert into public.tenants (id, slug, name, owner_user_id, status)
    values
      ('71000000-0000-4000-8000-000000000001', 'rls-alpha', 'RLS Alpha', '${userA}', 'active'),
      ('72000000-0000-4000-8000-000000000001', 'rls-beta', 'RLS Beta', '${userB}', 'active');
    insert into public.calls (id, tenant_id, channel, session_type, status)
    values
      ('71000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', 'eval', 'customer', 'ended'),
      ('72000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000001', 'eval', 'customer', 'ended');
    insert into public.rules (tenant_id, origem, escopo, status, category, text)
    values
      ('71000000-0000-4000-8000-000000000001', 'edicao_manual', 'geral', 'aprovado', 'geral', 'Alpha rule'),
      ('72000000-0000-4000-8000-000000000001', 'edicao_manual', 'geral', 'aprovado', 'geral', 'Beta rule');
  `);

  const signIn = async (email) => {
    const result = await jsonRequest(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: env.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Synthetic-RLS-Password-42!" }),
    }, [env.serviceRoleKey, env.publishableKey]);
    if (!result.response.ok || typeof result.body?.access_token !== "string") throw new Error("authenticated RLS sign-in failed");
    return result.body.access_token;
  };
  const tokenA = await signIn("rls-alpha@example.invalid");
  const tokenB = await signIn("rls-beta@example.invalid");
  const rest = async (token, pathname, init = {}) => jsonRequest(`${env.apiUrl}${pathname}`, {
    ...init,
    headers: { apikey: env.publishableKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  }, [env.serviceRoleKey, env.publishableKey, tokenA, tokenB]);

  let checks = 0;
  const tenantsA = await rest(tokenA, "/rest/v1/tenants?select=id,slug&order=slug");
  assert.equal(tenantsA.response.ok, true); assert.deepEqual(tenantsA.body, [{ id: "71000000-0000-4000-8000-000000000001", slug: "rls-alpha" }]); checks++;
  const tenantsB = await rest(tokenB, "/rest/v1/tenants?select=id,slug&order=slug");
  assert.equal(tenantsB.response.ok, true); assert.deepEqual(tenantsB.body, [{ id: "72000000-0000-4000-8000-000000000001", slug: "rls-beta" }]); checks++;
  const crossCalls = await rest(tokenA, "/rest/v1/calls?select=id&tenant_id=eq.72000000-0000-4000-8000-000000000001");
  assert.equal(crossCalls.response.ok, true); assert.deepEqual(crossCalls.body, []); checks++;
  const ownCalls = await rest(tokenA, "/rest/v1/calls?select=id&tenant_id=eq.71000000-0000-4000-8000-000000000001");
  assert.equal(ownCalls.response.ok, true); assert.equal(ownCalls.body.length, 1); checks++;
  const crossRules = await rest(tokenB, "/rest/v1/effective_rules?select=id&tenant_id=eq.71000000-0000-4000-8000-000000000001");
  assert.equal(crossRules.response.ok, true); assert.deepEqual(crossRules.body, []); checks++;
  const ownRules = await rest(tokenB, "/rest/v1/effective_rules?select=id&tenant_id=eq.72000000-0000-4000-8000-000000000001");
  assert.equal(ownRules.response.ok, true); assert.equal(ownRules.body.length, 1); checks++;
  const connectors = await rest(tokenA, "/rest/v1/connector_accounts?select=tenant_id");
  assert.equal(connectors.response.ok, false); checks++;
  const health = await rest(tokenA, "/rest/v1/rpc/release_health_state", {
    method: "POST", body: JSON.stringify({ p_tenant: "71000000-0000-4000-8000-000000000001", p_slug: "rls-alpha" }),
  });
  assert.equal(health.response.ok, false); checks++;
  const crossStatus = await rest(tokenA, "/rest/v1/rpc/get_connector_status", {
    method: "POST", body: JSON.stringify({ p_tenant: "72000000-0000-4000-8000-000000000001" }),
  });
  assert.equal(crossStatus.response.ok, false); checks++;
  return { suite: "authenticated-rest-rls-bola", tests: checks, passed: checks };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(await runAuthenticatedRlsSuite({
      apiUrl: process.env.SUPABASE_URL,
      projectId: process.env.LIGOU_LOCAL_PROJECT_ID,
      serviceRoleKey: process.env.SUPABASE_SECRET_KEY,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
      psqlBin: process.env.LIGOU_PSQL_BIN ?? "psql",
      home: process.env.HOME,
      pgHost: process.env.PGHOST,
      pgPort: process.env.PGPORT,
      pgDatabase: process.env.PGDATABASE,
      pgUser: process.env.PGUSER,
      pgPassword: process.env.PGPASSWORD,
    })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "authenticated RLS suite failed");
    process.exitCode = 1;
  }
}
