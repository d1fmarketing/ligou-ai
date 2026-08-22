// M2 tenancy: sessions resolve the AUTHENTICATED OWNER's own tenant. The queue row
// carries tenant_id end to end; the env slug remains only as the legacy fallback.
import { describe, expect, test, beforeEach } from "bun:test";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { resolveSessionTenant } from "../src/session-tenant.ts";
import { _handleBrowserRequest } from "../src/browser-requests.ts";
import { resolveOwnedTenantForSession } from "../../supabase/functions/_shared/owned-tenant.ts";

const V02_TENANT = {
  id: "22222222-2222-4222-8222-222222222222", slug: "ligou-22222222", name: "D1f Marketing", vertical: null,
  languages: ["pt", "en"], timezone: "America/Los_Angeles", session_max_minutes: 15, owner_user_id: "owner-a",
  auth_epoch: 1, policy_epoch: 1, status: "onboarding", operational_mode: "simulation_only",
};
const LEGACY_TENANT = {
  id: "11111111-1111-4111-8111-111111111111", slug: "rocha-plumbing", name: "Rocha Plumbing LLC", vertical: "plumbing",
  languages: ["en", "es"], timezone: "America/Los_Angeles", session_max_minutes: 15, owner_user_id: "owner-legacy",
  auth_epoch: 1, policy_epoch: 1, status: "active", operational_mode: "live",
};

function tenantClient() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const api: any = {
        select() { return api; },
        eq(column: string, value: unknown) { filters[column] = value; return api; },
        single: async () => {
          if (table !== "tenants") return { data: null, error: { message: `unexpected table ${table}` } };
          if (filters.id === V02_TENANT.id) return { data: { ...V02_TENANT }, error: null };
          if (filters.slug === LEGACY_TENANT.slug) return { data: { ...LEGACY_TENANT }, error: null };
          return { data: null, error: { message: "not found" } };
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: table === "effective_rules" ? [] : [], error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc: async () => ({ data: null, error: { message: "unexpected rpc" } }),
  };
}

beforeEach(() => {
  _setClient(tenantClient() as any);
  invalidateTenant(V02_TENANT.slug);
  invalidateTenant(LEGACY_TENANT.slug);
});

describe("resolveSessionTenant", () => {
  test("a queue tenant_id resolves that tenant for its owner", async () => {
    const { tenant } = await resolveSessionTenant("owner-a", V02_TENANT.id);
    expect(tenant.id).toBe(V02_TENANT.id);
    expect(tenant.slug).toBe("ligou-22222222");
  });

  test("a queue tenant_id owned by someone else fails closed as not_tenant_owner", async () => {
    await expect(resolveSessionTenant("intruder", V02_TENANT.id)).rejects.toThrow(/not_tenant_owner/);
  });

  test("an unknown tenant id fails closed", async () => {
    await expect(resolveSessionTenant("owner-a", "33333333-3333-4333-8333-333333333333")).rejects.toThrow(/tenant_not_found/);
  });

  test("without a tenant id the legacy env slug still works for its own owner", async () => {
    const { tenant } = await resolveSessionTenant("owner-legacy", undefined);
    expect(tenant.slug).toBe("rocha-plumbing");
  });

  test("without a tenant id a non-owner of the legacy tenant is still refused", async () => {
    await expect(resolveSessionTenant("owner-a", undefined)).rejects.toThrow(/not_tenant_owner/);
  });
});

describe("browser request handling", () => {
  test("the claimed row's tenant_id reaches startSession", async () => {
    const seen: any[] = [];
    const updates: any[] = [];
    const rowClient = {
      from(table: string) {
        const api: any = {
          update(patch: any) { updates.push({ table, patch }); return api; },
          eq() { return api; },
          select: async () => ({ data: [{ id: "req-1" }], error: null }),
        };
        return api;
      },
    };
    _setClient(rowClient as any);
    await _handleBrowserRequest(
      { id: "req-1", user_id: "owner-a", tenant_id: V02_TENANT.id, session_type: "onboarding", offer_sdp: "sdp", model_override: null },
      async (userId: string, sessionType: string, sdp: string, model?: string, tenantId?: string) => {
        seen.push({ userId, sessionType, sdp, model, tenantId });
        return { sdp: "answer", call_id: "call-1" };
      },
    );
    expect(seen).toEqual([{ userId: "owner-a", sessionType: "onboarding", sdp: "sdp", model: undefined, tenantId: V02_TENANT.id }]);
    expect(updates.some((u) => u.patch?.status === "ready")).toBe(true);
  });
});

describe("edge owned-tenant resolution", () => {
  function edgeClient(rows: any[], legacy: any | null) {
    return {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const api: any = {
          select() { return api; },
          eq(column: string, value: unknown) { filters[column] = value; return api; },
          order() { return api; },
          limit: async () => ({ data: rows, error: null }),
          single: async () => (legacy ? { data: legacy, error: null } : { data: null, error: { message: "not found" } }),
        };
        return api;
      },
    };
  }

  test("an owner with a v0.2 tenant gets that tenant, not the env slug", async () => {
    const client = edgeClient([{ id: V02_TENANT.id, slug: V02_TENANT.slug, owner_user_id: "owner-a" }], null);
    const tenant = await resolveOwnedTenantForSession(client as any, "owner-a", "rocha-plumbing");
    expect(tenant.id).toBe(V02_TENANT.id);
  });

  test("an owner without a v0.2 tenant falls back to legacy slug ownership", async () => {
    const client = edgeClient([], { id: LEGACY_TENANT.id, slug: "rocha-plumbing", owner_user_id: "owner-legacy" });
    const tenant = await resolveOwnedTenantForSession(client as any, "owner-legacy", "rocha-plumbing");
    expect(tenant.id).toBe(LEGACY_TENANT.id);
  });

  test("no owned tenant anywhere fails closed", async () => {
    const client = edgeClient([], { id: LEGACY_TENANT.id, slug: "rocha-plumbing", owner_user_id: "owner-legacy" });
    await expect(resolveOwnedTenantForSession(client as any, "stranger", "rocha-plumbing")).rejects.toThrow(/not_tenant_owner/);
  });
});
