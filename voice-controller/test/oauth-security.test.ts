import { describe, expect, test } from "bun:test";
import {
  buildOAuthState,
  parseOAuthState,
  validateOAuthStateRecord,
} from "../../supabase/functions/_shared/oauth-state.ts";
import {
  decryptConnectorToken,
  encryptConnectorToken,
} from "../../supabase/functions/_shared/connector-crypto.ts";
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
