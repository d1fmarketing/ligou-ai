// Session tenant resolution for the authenticated owner: their own self-service
// V0.2 tenant first (oldest wins — the bootstrap enforces one per owner), the
// legacy env-slug tenant as fallback. Fails closed when the caller owns neither.
import { requireTenantOwner } from "./tenant-ownership.ts";

export interface OwnedSessionTenant {
  id: string;
  slug: string;
  name: string;
  owner_user_id: string;
}

export async function resolveOwnedTenantForSession(
  client: {
    from: (table: string) => any;
  },
  userId: string,
  fallbackSlug: string,
): Promise<OwnedSessionTenant> {
  const { data, error } = await client
    .from("tenants")
    .select("id,slug,name,owner_user_id")
    .eq("owner_user_id", userId)
    .eq("bootstrap_origin", "v0_2_google")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw Object.assign(new Error("tenant_lookup_failed"), { status: 503, detail: error.message });
  const own = (data ?? [])[0];
  if (own?.id && own.owner_user_id === userId && typeof own.name === "string") {
    return { id: own.id, slug: own.slug, name: own.name, owner_user_id: own.owner_user_id };
  }
  const legacy = await requireTenantOwner(client as never, fallbackSlug, userId);
  const { data: namedLegacy, error: namedLegacyError } = await client
    .from("tenants")
    .select("id,slug,name,owner_user_id")
    .eq("id", legacy.id)
    .single();
  if (namedLegacyError || !namedLegacy?.name) {
    throw Object.assign(new Error("tenant_lookup_failed"), {
      status: 503,
      detail: namedLegacyError?.message ?? "tenant_name_missing",
    });
  }
  return {
    id: legacy.id,
    slug: legacy.slug,
    name: namedLegacy.name,
    owner_user_id: legacy.owner_user_id as string,
  };
}
