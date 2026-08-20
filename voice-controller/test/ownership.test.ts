import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { startSession } from "../src/server.ts";

const TENANT = {
  id: "tenant-1",
  slug: "rocha-plumbing",
  name: "Rocha Plumbing LLC",
  vertical: "plumbing",
  languages: ["en", "es"],
  timezone: "America/Los_Angeles",
  session_max_minutes: 15,
  owner_user_id: null,
  auth_epoch: 1,
  policy_epoch: 1,
};

let touchedTables: string[] = [];
let rpcNames: string[] = [];

function ownershipClient(ownerUserId: string | null) {
  const tenant = { ...TENANT, owner_user_id: ownerUserId };
  return {
    from(table: string) {
      touchedTables.push(table);
      const api: any = {
        select() { return api; },
        eq() { return api; },
        is() { return api; },
        update() { return api; },
        insert() { return api; },
        single: async () => {
          if (table === "tenants") return { data: tenant, error: null };
          if (table === "calls") return { data: null, error: { message: "call insert must not be reached" } };
          return { data: null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "rules" ? [] : null;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc(name: string) {
      rpcNames.push(name);
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

beforeEach(() => {
  touchedTables = [];
  rpcNames = [];
  invalidateTenant("rocha-plumbing");
});

afterAll(() => _setClient(null));

describe("tenant ownership is provisioned before session creation", () => {
  test("an unowned tenant fails before a call or budget reservation exists", async () => {
    _setClient(ownershipClient(null));

    await expect(startSession("user-a", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "tenant_provisioning_required",
      status: 409,
    });

    expect(touchedTables).not.toContain("calls");
    expect(rpcNames).not.toContain("reserve_call_budget");
  });

  test("a different user loses without mutating tenant ownership", async () => {
    _setClient(ownershipClient("owner-a"));

    await expect(startSession("user-b", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "not_tenant_owner",
      status: 403,
    });

    expect(touchedTables).not.toContain("calls");
    expect(rpcNames).toEqual([]);
  });
});
