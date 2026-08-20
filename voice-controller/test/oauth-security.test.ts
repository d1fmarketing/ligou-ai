import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOAuthState,
  parseOAuthState,
  validateOAuthStateRecord,
} from "../../supabase/functions/_shared/oauth-state.ts";
import {
  decryptConnectorToken,
  encryptConnectorToken,
} from "../../supabase/functions/_shared/connector-crypto.ts";
import { migrateTenantConnectorTokens } from "../../supabase/scripts/connector-token-migration-core.ts";
import { escapeHtml, renderCallbackPage } from "../../supabase/functions/_shared/callback-page.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const STATE = "33333333-3333-4333-8333-333333333333";
const REDIRECT = "https://project.supabase.co/functions/v1/google-callback";
const NOW = new Date("2026-08-20T12:00:00.000Z");
const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

describe("OAuth state proof", () => {
  async function fixture() {
    const built = await buildOAuthState({
      stateId: STATE,
      tenantId: TENANT,
      userId: USER,
      redirectUri: REDIRECT,
      now: NOW,
      ttlMs: 10 * 60_000,
      nonce: new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)),
    });
    return { built, proof: await parseOAuthState(built.publicState, REDIRECT) };
  }

  test("accepts the exact unexpired tenant, user, redirect, and nonce binding", async () => {
    const { built, proof } = await fixture();
    expect(validateOAuthStateRecord(built.record, proof, NOW)).toEqual({
      tenantId: TENANT,
      userId: USER,
      redirectUri: REDIRECT,
    });
  });

  test("rejects expired and already-consumed state", async () => {
    const { built, proof } = await fixture();
    expect(() => validateOAuthStateRecord(built.record, proof, new Date("2026-08-20T12:10:00.001Z")))
      .toThrow("oauth_state_expired");
    expect(() => validateOAuthStateRecord({ ...built.record, consumedAt: NOW.toISOString() }, proof, NOW))
      .toThrow("oauth_state_consumed");
  });

  test("rejects wrong user, tenant, redirect, or nonce", async () => {
    const { built, proof } = await fixture();
    const wrong = [
      { ...proof, userId: "44444444-4444-4444-8444-444444444444" },
      { ...proof, tenantId: "55555555-5555-4555-8555-555555555555" },
      { ...proof, redirectUri: "https://attacker.invalid/callback" },
      { ...proof, nonceHash: "00".repeat(32) },
    ];
    for (const candidate of wrong) {
      expect(() => validateOAuthStateRecord(built.record, candidate, NOW)).toThrow("oauth_state_binding_mismatch");
    }
  });
});

describe("versioned connector token encryption", () => {
  const aad = {
    tenantId: TENANT,
    provider: "google_calendar",
    accountRef: "owner@example.com",
    keyVersion: 1,
  } as const;

  test("AES-GCM roundtrips and uses a fresh 12-byte IV", async () => {
    const first = await encryptConnectorToken("refresh-token-value", aad, TEST_KEY);
    const second = await encryptConnectorToken("refresh-token-value", aad, TEST_KEY);
    expect(first.keyVersion).toBe(1);
    expect(first.iv).not.toBe(second.iv);
    expect(Uint8Array.from(atob(first.iv), (c) => c.charCodeAt(0))).toHaveLength(12);
    expect(await decryptConnectorToken(first, aad, { 1: TEST_KEY })).toBe("refresh-token-value");
  });

  test("tamper, wrong AAD, and unsupported key versions fail closed", async () => {
    const wire = await encryptConnectorToken("refresh-token-value", aad, TEST_KEY);
    const tampered = { ...wire, ciphertext: `${wire.ciphertext.slice(0, -2)}AA` };
    await expect(decryptConnectorToken(tampered, aad, { 1: TEST_KEY })).rejects.toThrow();
    await expect(decryptConnectorToken(wire, { ...aad, tenantId: USER }, { 1: TEST_KEY })).rejects.toThrow();
    await expect(decryptConnectorToken({ ...wire, keyVersion: 2 }, { ...aad, keyVersion: 2 }, { 1: TEST_KEY }))
      .rejects.toThrow("connector_token_key_version_unavailable");
  });

  test("wrong key, nonce, tenant, provider, and key version all fail without token disclosure", async () => {
    const token = "never-log-refresh-token";
    const wire = await encryptConnectorToken(token, aad, TEST_KEY);
    const failures = [
      () => decryptConnectorToken(wire, aad, { 1: "Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=" }),
      () => decryptConnectorToken({ ...wire, iv: btoa("wrong-nonce!") }, aad, { 1: TEST_KEY }),
      () => decryptConnectorToken(wire, { ...aad, tenantId: USER }, { 1: TEST_KEY }),
      () => decryptConnectorToken(wire, { ...aad, provider: "other_provider" }, { 1: TEST_KEY }),
      () => decryptConnectorToken({ ...wire, keyVersion: 2 }, { ...aad, keyVersion: 2 }, { 1: TEST_KEY }),
    ];
    for (const failure of failures) {
      try {
        await failure();
        throw new Error("expected_failure");
      } catch (error) {
        expect(String(error)).not.toContain(token);
      }
    }
  });
});

describe("tenant-scoped legacy connector migration", () => {
  function memoryStore(initialRows: any[], { corruptPersisted = false } = {}) {
    const state = initialRows.map((row) => ({ ...row }));
    let writes = 0;
    return {
      state,
      get writes() { return writes; },
      async transaction(operation: any) {
        const working = state.map((row) => ({ ...row }));
        const tx = {
          async lockLegacyRows(tenantId: string) {
            return working.filter((row) => row.tenant_id === tenantId && row.refresh_token !== null).map((row) => ({ ...row }));
          },
          async persistEncrypted(input: any) {
            const row = working.find((candidate) => candidate.id === input.id
              && candidate.tenant_id === input.tenantId && candidate.provider === input.provider
              && candidate.refresh_token === input.expectedPlaintext);
            if (!row) return false;
            writes += 1;
            row.refresh_token_ciphertext = corruptPersisted ? `${input.wire.ciphertext.slice(0, -2)}AA` : input.wire.ciphertext;
            row.refresh_token_iv = input.wire.iv;
            row.token_key_version = input.wire.keyVersion;
            row.token_account_ref = input.accountRef;
            row.refresh_token = null;
            row.status = "active";
            return true;
          },
          async readEncrypted(id: string) {
            const row = working.find((candidate) => candidate.id === id);
            return row ? { ...row } : null;
          },
        };
        const result = await operation(tx);
        state.splice(0, state.length, ...working);
        return result;
      },
    };
  }

  const legacy = {
    id: "connector-1",
    tenant_id: TENANT,
    provider: "google_calendar",
    account_email: "owner@example.com",
    token_account_ref: null,
    refresh_token: "legacy-never-log-token",
    refresh_token_ciphertext: null,
    refresh_token_iv: null,
    token_key_version: null,
    status: "reconnect_required",
  };

  test("dry-run is default behavior and performs no writes or token logging", async () => {
    const store = memoryStore([legacy]);
    const reports: unknown[] = [];
    const result = await migrateTenantConnectorTokens({
      tenantId: TENANT,
      encodedKey: TEST_KEY,
      apply: false,
      store,
      report: (value: unknown) => reports.push(value),
    });
    expect(result).toEqual({ tenant_id: TENANT, mode: "dry-run", eligible: 1, migrated: 0 });
    expect(store.writes).toBe(0);
    expect(store.state[0]?.refresh_token).toBe(legacy.refresh_token);
    expect(JSON.stringify(reports)).not.toContain(legacy.refresh_token);
  });

  test("apply verifies authenticated encryption before atomically clearing plaintext and is idempotent", async () => {
    const store = memoryStore([legacy]);
    const first = await migrateTenantConnectorTokens({ tenantId: TENANT, encodedKey: TEST_KEY, apply: true, store });
    expect(first).toEqual({ tenant_id: TENANT, mode: "apply", eligible: 1, migrated: 1 });
    expect(store.state[0]?.refresh_token).toBeNull();
    expect(typeof store.state[0]?.refresh_token_ciphertext).toBe("string");
    const second = await migrateTenantConnectorTokens({ tenantId: TENANT, encodedKey: TEST_KEY, apply: true, store });
    expect(second).toEqual({ tenant_id: TENANT, mode: "apply", eligible: 0, migrated: 0 });
    expect(store.writes).toBe(1);
  });

  test("encryption or persisted verification failure rolls back and leaves original plaintext unchanged", async () => {
    for (const [store, key] of [
      [memoryStore([legacy]), "invalid-key"],
      [memoryStore([legacy], { corruptPersisted: true }), TEST_KEY],
    ] as const) {
      await expect(migrateTenantConnectorTokens({ tenantId: TENANT, encodedKey: key, apply: true, store }))
        .rejects.toThrow();
      expect(store.state[0]?.refresh_token).toBe(legacy.refresh_token);
      expect(store.state[0]?.refresh_token_ciphertext).toBeNull();
    }
  });
});

test("OAuth callback HTML escapes provider-derived text and the return URL", () => {
  const html = renderCallbackPage({
    title: '<img src=x onerror="alert(1)">',
    body: "owner@example.com<script>alert(2)</script>",
    returnUrl: 'https://ligou.invalid/dashboard/\" onclick=\"alert(3)',
    ok: false,
  });
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("onclick=");
  expect(html).toContain(escapeHtml("owner@example.com<script>alert(2)</script>"));
});

test("service-role OAuth consumption checks the request claim, not the SECURITY DEFINER owner", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const migration = readFileSync(path.join(root, "supabase/migrations/20260820191044_connector_oauth_hardening.sql"), "utf8");
  expect(migration).toContain("current_setting('request.jwt.claim.role', true)");
  expect(migration).not.toContain("current_user <> 'service_role'");
});

test("migration CLI is pinned, tenant-locked, dry-run by default, and callback has no plaintext field", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const utility = readFileSync(path.join(root, "supabase/scripts/migrate-connector-tokens.ts"), "utf8").replace(/\s+/g, " ");
  const callback = readFileSync(path.join(root, "supabase/functions/google-callback/index.ts"), "utf8");
  expect(utility).toContain('from "npm:postgres@3.4.9"');
  expect(utility).toContain("where tenant_id = ${lockedTenant}::uuid and refresh_token is not null order by provider, id for update");
  expect(utility).toContain('const apply = args.includes("--apply")');
  expect(callback).not.toMatch(/^\s*refresh_token\s*:/m);
});
