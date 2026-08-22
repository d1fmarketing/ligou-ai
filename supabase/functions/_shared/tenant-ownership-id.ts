// UUID-scoped variant of the read-only ownership check. Kept in its own module so
// the frozen release identity of functions that import tenant-ownership.ts (by slug)
// is untouched. Owner assignment remains the exclusive job of the provisioning RPCs.

export interface TenantOwnershipById {
  id: string;
  owner_user_id: string | null;
  timezone: string | null;
  status: string;
  operational_mode: string | null;
  name: string;
}

export interface HttpError extends Error {
  status: number;
  detail?: string;
}

function httpError(message: string, status: number, detail?: string): HttpError {
  return Object.assign(new Error(message), { status, detail });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function requireTenantOwnerById(
  client: any,
  tenantId: string,
  userId: string,
): Promise<TenantOwnershipById> {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) {
    throw httpError("tenant_required", 400);
  }
  const { data: tenant, error } = await client
    .from("tenants")
    .select("id,owner_user_id,timezone,status,operational_mode,name")
    .eq("id", tenantId)
    .single();

  if (error || !tenant) {
    throw httpError("tenant_not_found", 404, error?.message);
  }
  if (!tenant.owner_user_id) {
    throw httpError("tenant_provisioning_required", 409);
  }
  if (tenant.owner_user_id !== userId) {
    throw httpError("not_tenant_owner", 403);
  }
  return tenant as TenantOwnershipById;
}
