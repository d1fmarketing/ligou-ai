import { describe, expect, test } from "bun:test";
import {
  REQUIRED_CALENDAR_SCOPES,
  decideConnectorTransition,
  nonceHashFromBase64Url,
  parseHandoffRequest,
  verifyTokenInfo,
} from "../../supabase/functions/_shared/handoff-core.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const INTENT = "33333333-3333-4333-8333-333333333333";
const NONCE_B64URL = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"; // bytes 1..32
const SECRET_ACCESS = "ya29.synthetic-access-token-value-0001";
const SECRET_REFRESH = "1//synthetic-refresh-token-value-0002";

function validBody(): Record<string, unknown> {
  return {
    intent_id: INTENT,
    nonce: NONCE_B64URL,
    tenant_id: TENANT,
    provider: "google",
    provider_token: SECRET_ACCESS,
    provider_refresh_token: SECRET_REFRESH,
  };
}

describe("handoff request parsing", () => {
  test("accepts a complete request and normalizes the refresh token", () => {
    const parsed = parseHandoffRequest(validBody());
    expect(parsed.intentId).toBe(INTENT);
    expect(parsed.tenantId).toBe(TENANT);
    expect(parsed.provider).toBe("google");
    expect(parsed.providerToken).toBe(SECRET_ACCESS);
    expect(parsed.providerRefreshToken).toBe(SECRET_REFRESH);
  });

  test("treats a missing or empty refresh token as null, never as an empty credential", () => {
    const withoutField = validBody();
    delete withoutField.provider_refresh_token;
    expect(parseHandoffRequest(withoutField).providerRefreshToken).toBeNull();
    const emptyField = { ...validBody(), provider_refresh_token: "" };
    expect(parseHandoffRequest(emptyField).providerRefreshToken).toBeNull();
  });

  test.each([
    ["intent_id", "not-a-uuid"],
    ["tenant_id", "also-not-a-uuid"],
    ["provider", "github"],
    ["nonce", "!!!"],
    ["nonce", "short"],
    ["provider_token", ""],
    ["provider_token", "x".repeat(20_000)],
  ])("rejects an invalid %s without echoing token material", (field, value) => {
    const body = { ...validBody(), [field]: value };
    let error: Error | null = null;
    try {
      parseHandoffRequest(body);
    } catch (thrown) {
      error = thrown as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).not.toContain(SECRET_ACCESS);
    expect(error!.message).not.toContain(SECRET_REFRESH);
    expect(error!.message.length).toBeLessThan(80);
  });

  test("rejects a non-object body", () => {
    expect(() => parseHandoffRequest(null)).toThrow();
    expect(() => parseHandoffRequest("token")).toThrow();
  });
});

describe("nonce hashing", () => {
  test("hashes the exact nonce bytes to lowercase hex", async () => {
    const bytes = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const expected = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await nonceHashFromBase64Url(NONCE_B64URL)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects malformed nonce encodings", async () => {
    await expect(nonceHashFromBase64Url("///")).rejects.toThrow();
    await expect(nonceHashFromBase64Url("shortvalue")).rejects.toThrow();
  });
});

describe("token info verification", () => {
  const scopeString = `openid email profile ${REQUIRED_CALENDAR_SCOPES.join(" ")}`;
  function info(overrides: Record<string, unknown> = {}) {
    return {
      aud: "expected-client",
      sub: "google-subject-1",
      email: "Owner@Example.com",
      scope: scopeString,
      expires_in: 3_500,
      ...overrides,
    };
  }
  const expectations = {
    clientId: "expected-client",
    expectedSubject: "google-subject-1",
    expectedEmail: "owner@example.com",
  };

  test("accepts matching audience, subject, email, and scopes", () => {
    const verified = verifyTokenInfo(info(), expectations);
    expect(verified.email).toBe("owner@example.com");
    expect(verified.scopes).toBe(scopeString);
  });

  test("requires every calendar scope", () => {
    expect(REQUIRED_CALENDAR_SCOPES).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(REQUIRED_CALENDAR_SCOPES).toContain("https://www.googleapis.com/auth/calendar.freebusy");
    expect(() => verifyTokenInfo(info({ scope: "openid email profile https://www.googleapis.com/auth/calendar.events" }), expectations))
      .toThrow("provider_scope_missing");
  });

  test("rejects an audience issued for another application", () => {
    expect(() => verifyTokenInfo(info({ aud: "someone-else" }), expectations)).toThrow("provider_audience_mismatch");
  });

  test("rejects a token from a different Google account subject", () => {
    expect(() => verifyTokenInfo(info({ sub: "other-subject" }), expectations)).toThrow("provider_subject_mismatch");
  });

  test("rejects a token whose account email diverges from the login identity", () => {
    expect(() => verifyTokenInfo(info({ email: "intruder@example.com" }), expectations)).toThrow("provider_account_mismatch");
  });

  test("rejects an already expired token", () => {
    expect(() => verifyTokenInfo(info({ expires_in: 0 }), expectations)).toThrow("provider_token_expired");
  });

  test("tolerates a missing stored subject or email by matching on what exists", () => {
    const verified = verifyTokenInfo(info(), { clientId: "expected-client", expectedSubject: null, expectedEmail: null });
    expect(verified.email).toBe("owner@example.com");
  });
});

describe("connector transition decisions", () => {
  test.each([
    ["active", "login", true, "activate"],
    ["active", "login", false, "preserve_active"],
    ["active", "reconnect", false, "preserve_active"],
    ["revoked", "login", true, "refuse_reactivation"],
    ["revoked", "login", false, "refuse_reactivation"],
    ["error", "login", true, "refuse_reactivation"],
    ["revoked", "reconnect", true, "activate"],
    ["error", "reconnect", true, "activate"],
    ["revoked", "reconnect", false, "needs_refresh_token"],
    ["reconnect_required", "login", true, "activate"],
    ["reconnect_required", "login", false, "needs_refresh_token"],
    ["reconnect_required", "reconnect", true, "activate"],
    [null, "login", true, "activate"],
    [null, "login", false, "needs_refresh_token"],
  ] as const)(
    "existing=%p kind=%p refresh=%p → %p",
    (existingStatus, kind, hasRefreshToken, expected) => {
      expect(decideConnectorTransition({ existingStatus, kind, hasRefreshToken })).toBe(expected);
    },
  );

  test("an unknown existing status fails closed", () => {
    expect(() => decideConnectorTransition({ existingStatus: "weird", kind: "login", hasRefreshToken: true } as never))
      .toThrow("connector_status_unknown");
  });

  test("an unknown intent kind fails closed", () => {
    expect(() => decideConnectorTransition({ existingStatus: null, kind: "install", hasRefreshToken: true } as never))
      .toThrow("handoff_kind_invalid");
  });
});
