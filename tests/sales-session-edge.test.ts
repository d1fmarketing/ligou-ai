import { describe, expect, it } from "bun:test";
import { createSalesSessionHandler } from "../supabase/functions/sales-session/core.ts";
const origin = "https://sales.example.test",
  token = "a".repeat(43),
  id = "11000000-0000-4000-8000-000000000001";
function setup(overrides: Record<string, string> = {}) {
  const calls: any[] = [];
  const env = {
    SUPABASE_URL: "https://project.supabase.co",
    SERVICE_KEY: "private",
    SALES_ALLOWED_ORIGINS: origin,
    SALES_HASH_SECRET: "a".repeat(40),
    SALES_TRUSTED_PROXY_SECRET: "proxy-private",
    SALES_TRUSTED_NETWORK_HEADER: "x-sales-client-ip",
    SALES_ENABLED: "true",
    ...overrides,
  };
  const handler = createSalesSessionHandler({
    env: (n) => env[n as keyof typeof env],
    createClient: () => ({
      rpc: async (name, args) => {
        calls.push({ name, args });
        return {
          data: {
            session_id: id,
            status: "pending",
            max_minutes: 5,
            expires_at: "2026-09-04T00:00:00Z",
            token_hash: "secret",
            provider_call_id: "secret",
          },
          error: null,
        };
      },
    }),
  });
  const req = (body: any, headers: Record<string, string> = {}) =>
    new Request("https://project.supabase.co/functions/v1/sales-session", {
      method: "POST",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-sales-proxy-secret": "proxy-private",
        "x-sales-client-ip": "203.0.113.44",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { handler, req, calls };
}
describe("public sales Edge admission", () => {
  it("hashes capability and visitor/network identifiers and strips private response fields", async () => {
    const { handler, req, calls } = setup();
    const r = await handler(
      req({ action: "start", request_id: id, visitor_id: id, sdp: "v=0\r\n" }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      session_id: id,
      status: "pending",
      max_minutes: 5,
      expires_at: "2026-09-04T00:00:00Z",
    });
    expect(calls[0].name).toBe("sales_admit");
    expect(calls[0].args.p_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(calls)).not.toContain("203.0.113.44");
    expect(JSON.stringify(calls)).not.toContain(token);
  });
  it("rejects arbitrary origins before DB access", async () => {
    const { handler, req, calls } = setup();
    const r = await handler(
      req({ action: "status", session_id: id }, {
        origin: "https://evil.test",
      }),
    );
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it("rejects absent capabilities and client identity/model injection", async () => {
    const { handler, req, calls } = setup();
    expect(
      (await handler(
        req({ action: "start", request_id: id, visitor_id: id, sdp: "v=0" }, {
          authorization: "",
        }),
      )).status,
    ).toBe(401);
    expect(
      (await handler(
        req({
          action: "start",
          request_id: id,
          visitor_id: id,
          sdp: "v=0",
          model: "rogue",
        }),
      )).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it("requires trusted network ingress for starts", async () => {
    const { handler, req, calls } = setup();
    expect(
      (await handler(
        req({ action: "start", request_id: id, visitor_id: id, sdp: "v=0" }, {
          "x-sales-proxy-secret": "wrong",
        }),
      )).status,
    ).toBe(503);
    expect(calls).toHaveLength(0);
  });
  it("keeps end usable when new admissions disabled and without trusted ingress", async () => {
    const { handler, req, calls } = setup({ SALES_ENABLED: "false" });
    expect(
      (await handler(
        req({ action: "end", session_id: id }, { "x-sales-proxy-secret": "" }),
      )).status,
    ).toBe(200);
    expect(calls[0].args.p_end).toBe(true);
    expect(
      (await handler(
        req({ action: "start", request_id: id, visitor_id: id, sdp: "v=0" }),
      )).status,
    ).toBe(503);
  });
  it("bounds SDP and request bytes, fails safe on malformed JSON", async () => {
    const { handler, req, calls } = setup();
    expect(
      (await handler(
        req({
          action: "start",
          request_id: id,
          visitor_id: id,
          sdp: "v".repeat(65537),
        }),
      )).status,
    ).toBe(400);
    expect(
      (await handler(
        req({ action: "status", session_id: id }, {
          "content-length": "9999999",
        }),
      )).status,
    ).toBe(413);
    expect(calls).toHaveLength(0);
  });
  it("serves only exact-origin preflight with bearer/json headers", async () => {
    const { handler } = setup();
    const r = await handler(
      new Request("https://example.test", {
        method: "OPTIONS",
        headers: { origin },
      }),
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(origin);
    expect(r.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, apikey, x-client-info",
    );
  });
});
