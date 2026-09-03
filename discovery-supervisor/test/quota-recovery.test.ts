import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  ModelAccessCapability,
  SubscriptionCredentialOwnerBinding,
  SubscriptionQuotaRecoveryCapability,
  SubscriptionQuotaRecoverySettlement,
  SubscriptionRequestReservationCapability,
} from "../src/contracts";
import { CODEX_RESPONSES_URL } from "../src/openclaw/model-proxy";
import { CentralSubscriptionGateway } from "../src/openclaw/subscription-gateway";

const NOW = Date.parse("2099-09-03T10:00:00.000Z");
const OWNER_ID = "55555555-5555-4555-8555-555555555555";
const PROBE_ID = "66666666-6666-4666-8666-666666666666";
const ACCOUNT_ID = "acct_quota_recovery_owner";
const ACCOUNT_HASH = createHash("sha256").update(ACCOUNT_ID).digest("hex");

function jwt(accountId: string, expiresAt: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    exp: expiresAt,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.${"s".repeat(43)}`;
}

function completedProbeSse(withUsage = true) {
  const terminal: Record<string, unknown> = {
    status: "completed",
    error: null,
    output: [],
  };
  if (withUsage) {
    terminal.usage = {
      input_tokens: 9,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      total_tokens: 11,
    };
  }
  return [
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      item_id: "msg_probe",
      output_index: 0,
      content_index: 0,
      delta: "OK",
    })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: terminal })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function unusedModelAuthority() {
  const reservation = Object.freeze(Object.create(null)) as SubscriptionRequestReservationCapability;
  return {
    async assertModelAccessCurrent(_capability: ModelAccessCapability) {
      throw new Error("ordinary model access must not participate in quota recovery");
    },
    async assertSubscriptionRecoveryCurrent() {
      throw new Error("attempt cleanup recovery must not participate in quota recovery");
    },
    async reserveSubscriptionRequest() {
      throw new Error("ordinary subscription reservation must not be invented");
    },
    async settleSubscriptionRequest() {
      throw new Error("ordinary subscription settlement must not participate");
    },
    reservation,
  };
}

function recoveryClaim(capability: object) {
  return {
    capability,
    probe_id: PROBE_ID,
    recovery_generation: 1,
    lease_until: "2099-09-03T10:01:00.000Z",
    deadline_at: "2099-09-03T10:01:00.000Z",
    credential_owner_id: OWNER_ID,
    credential_generation: 3,
    expected_account_hash: ACCOUNT_HASH,
    provider: "openai-codex",
    auth_kind: "chatgpt_subscription_oauth",
    model: "gpt-5.6-sol",
  };
}

describe("stale subscription quota recovery", () => {
  test("keeps ordinary work blocked when unknown is not yet eligible for a probe", async () => {
    let upstream = 0;
    let settlements = 0;
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: unusedModelAuthority(),
      quota_recovery_authority: {
        async claimSubscriptionQuotaRecovery() {
          return { state: "blocked" as const };
        },
        async settleSubscriptionQuotaRecovery() {
          settlements += 1;
          throw new Error("blocked recovery cannot settle");
        },
      },
      quota_recovery_worker_id: "quota-recovery-test",
      credential_owner: {
        credential_owner_id: OWNER_ID,
        credential_generation: 3,
        account_id_sha256: ACCOUNT_HASH,
      },
      resolve_codex_grant: async () => { throw new Error("blocked recovery cannot resolve grant"); },
      listener_manager: {
        async open() { throw new Error("not used"); },
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
      },
      now: () => NOW,
      fetch: async () => { upstream += 1; throw new Error("not used"); },
    } as never);

    await expect((gateway as any).recoverStaleQuota()).resolves.toEqual({ state: "blocked" });
    expect(upstream).toBe(0);
    expect(settlements).toBe(0);
  });

  test("single-flights one bounded Hermes subscription probe and records only measured usage", async () => {
    const capability = Object.freeze(Object.create(null));
    const settlements: unknown[] = [];
    let claims = 0;
    let upstream = 0;
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "poisoned-paid-api-key";
    try {
      const gateway = new CentralSubscriptionGateway({
        model_access_authority: unusedModelAuthority(),
        quota_recovery_authority: {
          async claimSubscriptionQuotaRecovery(
            owner: SubscriptionCredentialOwnerBinding,
            workerId: string,
            leaseSeconds: number,
          ) {
            claims += 1;
            expect(owner).toEqual({
              credential_owner_id: OWNER_ID,
              credential_generation: 3,
              account_id_sha256: ACCOUNT_HASH,
            });
            expect(workerId).toBe("quota-recovery-test");
            expect(leaseSeconds).toBe(60);
            return recoveryClaim(capability);
          },
          async settleSubscriptionQuotaRecovery(
            received: SubscriptionQuotaRecoveryCapability,
            settlement: SubscriptionQuotaRecoverySettlement,
          ) {
            expect(received).toBe(capability);
            settlements.push(settlement);
            return {
              probe_id: PROBE_ID,
              recovery_generation: 1,
              status: "succeeded",
              quota_state: "available",
              next_probe_at: null,
              governor_recovered: true,
            };
          },
        },
        quota_recovery_worker_id: "quota-recovery-test",
        credential_owner: {
          credential_owner_id: OWNER_ID,
          credential_generation: 3,
          account_id_sha256: ACCOUNT_HASH,
        },
        resolve_codex_grant: async (
          _owner: SubscriptionCredentialOwnerBinding,
          deadlineAt: string,
        ) => ({
          access_token: jwt(ACCOUNT_ID, Math.floor(Date.parse(deadlineAt) / 1_000) + 180),
          account_id: ACCOUNT_ID,
          expires_at: Math.floor(Date.parse(deadlineAt) / 1_000) + 180,
          source: "hermes-auth-store" as const,
        }),
        listener_manager: {
          async open() { throw new Error("quota recovery must not open a listener"); },
          async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
        },
        now: () => NOW,
        random_bytes: () => Buffer.alloc(24, 0x51),
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          upstream += 1;
          expect(String(input)).toBe(CODEX_RESPONSES_URL);
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).not.toContain("poisoned-paid-api-key");
          const body = JSON.parse(String(init?.body));
          expect(body).toMatchObject({
            model: "gpt-5.6-sol",
            store: false,
            stream: true,
            reasoning: { effort: "low" },
            text: { verbosity: "low" },
          });
          const serialized = JSON.stringify(body);
          expect(serialized).not.toMatch(/website|claim|openclaw|api[_. -]?key/i);
          return new Response(completedProbeSse(true), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      } as never);

      const [first, second] = await Promise.all([
        (gateway as any).recoverStaleQuota(),
        (gateway as any).recoverStaleQuota(),
      ]);
      expect(first).toEqual({ state: "recovered", probe_id: PROBE_ID });
      expect(second).toEqual(first);
      expect(claims).toBe(1);
      expect(upstream).toBe(1);
      expect(settlements).toHaveLength(1);
      expect(settlements[0]).toMatchObject({
        outcome: "available",
        terminal_reason: "probe_succeeded",
        observation: {
          usage_complete: true,
          terminal_complete: true,
          input_tokens: 9,
          output_tokens: 2,
          total_tokens: 11,
        },
      });
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  test("keeps quota unknown and renews the block when terminal usage is ambiguous", async () => {
    const capability = Object.freeze(Object.create(null));
    let settlement: any;
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: unusedModelAuthority(),
      quota_recovery_authority: {
        async claimSubscriptionQuotaRecovery() { return recoveryClaim(capability); },
        async settleSubscriptionQuotaRecovery(
          _received: SubscriptionQuotaRecoveryCapability,
          value: SubscriptionQuotaRecoverySettlement,
        ) {
          settlement = value;
          return {
            probe_id: PROBE_ID,
            recovery_generation: 1,
            status: "ambiguous",
            quota_state: "unknown",
            next_probe_at: "2099-09-03T11:00:00.000Z",
            governor_recovered: false,
          };
        },
      },
      quota_recovery_worker_id: "quota-recovery-test",
      credential_owner: {
        credential_owner_id: OWNER_ID,
        credential_generation: 3,
        account_id_sha256: ACCOUNT_HASH,
      },
      resolve_codex_grant: async (
        _owner: SubscriptionCredentialOwnerBinding,
        deadlineAt: string,
      ) => ({
        access_token: jwt(ACCOUNT_ID, Math.floor(Date.parse(deadlineAt) / 1_000) + 180),
        account_id: ACCOUNT_ID,
        expires_at: Math.floor(Date.parse(deadlineAt) / 1_000) + 180,
        source: "hermes-auth-store" as const,
      }),
      listener_manager: {
        async open() { throw new Error("not used"); },
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
      },
      now: () => NOW,
      random_bytes: () => Buffer.alloc(24, 0x52),
      fetch: async () => new Response(completedProbeSse(false), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    } as never);

    await expect((gateway as any).recoverStaleQuota()).resolves.toEqual({
      state: "ambiguous",
      probe_id: PROBE_ID,
    });
    expect(settlement).toMatchObject({
      outcome: "unknown",
      terminal_reason: "probe_usage_ambiguous",
      observation: {
        usage_complete: false,
        terminal_complete: true,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
      },
    });
  });

  test("reconciles a committed settlement after transport loss without another probe or model call", async () => {
    const capability = Object.freeze(Object.create(null));
    let claims = 0;
    let settlements = 0;
    let upstream = 0;
    const durableReadback = {
      probe_id: PROBE_ID,
      recovery_generation: 1,
      status: "succeeded" as const,
      quota_state: "available" as const,
      next_probe_at: null,
      governor_recovered: true,
    };
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: unusedModelAuthority(),
      quota_recovery_authority: {
        async claimSubscriptionQuotaRecovery() {
          claims += 1;
          return claims === 1 ? recoveryClaim(capability) : null;
        },
        async settleSubscriptionQuotaRecovery(
          _received: SubscriptionQuotaRecoveryCapability,
          _value: SubscriptionQuotaRecoverySettlement,
        ) {
          settlements += 1;
          if (settlements === 1) {
            throw new Error("response lost after durable commit");
          }
          return durableReadback;
        },
      },
      quota_recovery_worker_id: "quota-recovery-test",
      credential_owner: {
        credential_owner_id: OWNER_ID,
        credential_generation: 3,
        account_id_sha256: ACCOUNT_HASH,
      },
      resolve_codex_grant: async (
        _owner: SubscriptionCredentialOwnerBinding,
        deadlineAt: string,
      ) => ({
        access_token: jwt(ACCOUNT_ID, Math.floor(Date.parse(deadlineAt) / 1_000) + 180),
        account_id: ACCOUNT_ID,
        expires_at: Math.floor(Date.parse(deadlineAt) / 1_000) + 180,
        source: "hermes-auth-store" as const,
      }),
      listener_manager: {
        async open() { throw new Error("not used"); },
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
      },
      now: () => NOW,
      random_bytes: () => Buffer.alloc(24, 0x53),
      fetch: async () => {
        upstream += 1;
        return new Response(completedProbeSse(true), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    } as never);

    await expect((gateway as any).recoverStaleQuota()).resolves.toEqual({
      state: "unresolved",
      probe_id: PROBE_ID,
    });
    await expect((gateway as any).recoverStaleQuota()).resolves.toEqual({
      state: "recovered",
      probe_id: PROBE_ID,
    });
    expect(claims).toBe(1);
    expect(settlements).toBe(2);
    expect(upstream).toBe(1);
  });

  test("reconciles a server-downgraded ambiguous settlement after transport loss", async () => {
    const capability = Object.freeze(Object.create(null));
    let claims = 0;
    let settlements = 0;
    let upstream = 0;
    const gateway = new CentralSubscriptionGateway({
      model_access_authority: unusedModelAuthority(),
      quota_recovery_authority: {
        async claimSubscriptionQuotaRecovery() {
          claims += 1;
          return recoveryClaim(capability);
        },
        async settleSubscriptionQuotaRecovery(
          _received: SubscriptionQuotaRecoveryCapability,
          value: SubscriptionQuotaRecoverySettlement,
        ) {
          settlements += 1;
          expect(value.outcome).toBe("available");
          if (settlements === 1) throw new Error("response lost after ambiguous downgrade");
          return {
            probe_id: PROBE_ID,
            recovery_generation: 1,
            status: "ambiguous" as const,
            quota_state: "unknown" as const,
            next_probe_at: "2099-09-03T11:00:00.000Z",
            governor_recovered: false,
          };
        },
      },
      quota_recovery_worker_id: "quota-recovery-test",
      credential_owner: {
        credential_owner_id: OWNER_ID,
        credential_generation: 3,
        account_id_sha256: ACCOUNT_HASH,
      },
      resolve_codex_grant: async (
        _owner: SubscriptionCredentialOwnerBinding,
        deadlineAt: string,
      ) => ({
        access_token: jwt(ACCOUNT_ID, Math.floor(Date.parse(deadlineAt) / 1_000) + 180),
        account_id: ACCOUNT_ID,
        expires_at: Math.floor(Date.parse(deadlineAt) / 1_000) + 180,
        source: "hermes-auth-store" as const,
      }),
      listener_manager: {
        async open() { throw new Error("not used"); },
        async proveAbsent() { return { listener_closed: true, socket_absent: true }; },
      },
      now: () => NOW,
      random_bytes: () => Buffer.alloc(24, 0x54),
      fetch: async () => {
        upstream += 1;
        return new Response(completedProbeSse(true), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    } as never);

    await expect((gateway as any).recoverStaleQuota()).resolves.toEqual({
      state: "unresolved",
      probe_id: PROBE_ID,
    });
    await expect((gateway as any).recoverStaleQuota()).resolves.toEqual({
      state: "ambiguous",
      probe_id: PROBE_ID,
    });
    expect(claims).toBe(1);
    expect(settlements).toBe(2);
    expect(upstream).toBe(1);
  });
});
