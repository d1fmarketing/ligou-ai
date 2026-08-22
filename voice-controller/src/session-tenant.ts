// Session tenant resolution. The queue row carries the tenant the EDGE resolved
// for the authenticated owner; this re-verifies ownership against a fresh read
// before any call or reservation write. Without a tenant id, the legacy env slug
// path remains (local HTTP transport and the Rocha pilot).
import { config } from "./config.ts";
import { loadTenant, loadTenantById, supa, type Rule, type Tenant } from "./rules.ts";
import { requireTenantOwner } from "../../supabase/functions/_shared/tenant-ownership.ts";

export async function resolveSessionTenant(
  userId: string,
  tenantId: string | undefined,
): Promise<{ tenant: Tenant; rules: Rule[] }> {
  if (tenantId) {
    const { tenant, rules } = await loadTenantById(tenantId);
    if (!tenant.owner_user_id) {
      throw Object.assign(new Error("tenant_provisioning_required"), { status: 409 });
    }
    if (tenant.owner_user_id !== userId) {
      throw Object.assign(new Error("not_tenant_owner"), { status: 403 });
    }
    return { tenant, rules };
  }
  const ownedTenant = await requireTenantOwner(supa(), config.defaultTenantSlug, userId);
  const { tenant, rules } = await loadTenant(config.defaultTenantSlug);
  // The ownership read is intentionally fresh and occurs before any call or reservation write.
  tenant.owner_user_id = ownedTenant.owner_user_id;
  return { tenant, rules };
}
