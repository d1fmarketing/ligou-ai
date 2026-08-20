export interface TenantOwnership {
  id: string;
  slug: string;
  owner_user_id: string | null;
}

export interface HttpError extends Error {
  status: number;
  detail?: string;
}

function httpError(message: string, status: number, detail?: string): HttpError {
  return Object.assign(new Error(message), { status, detail });
}

/**
 * Read-only session authorization. Owner assignment is deliberately absent:
 * the service-role-only provision_tenant_owner RPC is the sole write authority.
 */
export async function requireTenantOwner(
  client: any,
  tenantSlug: string,
  userId: string,
): Promise<TenantOwnership> {
  const { data: tenant, error } = await client
    .from("tenants")
    .select("id,slug,owner_user_id")
    .eq("slug", tenantSlug)
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
  return tenant as TenantOwnership;
}
