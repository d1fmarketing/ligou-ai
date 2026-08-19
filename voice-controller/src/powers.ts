// Powers check — the grant ledger is the authority; colors are just product language derived from grants.
import { supa } from "./rules.ts";

export interface PowerCheck {
  granted: boolean;
  powerId?: string;
  reason?: string; // when denied
  authEpoch?: number;
}

export async function checkPower(
  tenantId: string,
  subject: "voice_agent" | "hermes",
  capability: string,
  resource: string,
  amountUsd?: number
): Promise<PowerCheck> {
  const { data: tenant } = await supa().from("tenants").select("auth_epoch").eq("id", tenantId).single();
  const { data: powers, error } = await supa()
    .from("powers")
    .select("id,resource,monetary_limit,expires_at,conditions")
    .eq("tenant_id", tenantId)
    .eq("subject", subject)
    .eq("capability", capability)
    .is("revoked_at", null);
  if (error) return { granted: false, reason: `power_lookup_failed: ${error.message}` };

  const now = Date.now();
  for (const p of powers ?? []) {
    if (p.resource !== "*" && p.resource !== resource) continue;
    if (p.expires_at && new Date(p.expires_at).getTime() < now) continue;
    if (amountUsd != null && p.monetary_limit != null && amountUsd > Number(p.monetary_limit)) {
      return { granted: false, powerId: p.id, reason: "monetary_limit_exceeded", authEpoch: tenant?.auth_epoch };
    }
    return { granted: true, powerId: p.id, authEpoch: tenant?.auth_epoch };
  }
  return { granted: false, reason: "no_grant_for_capability", authEpoch: tenant?.auth_epoch };
}
