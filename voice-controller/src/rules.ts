// Approved-rules projection: the Supabase ledger is the truth; this cache is derived and refreshable.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.ts";

export interface Rule {
  id: string;
  rule_group_id: string;
  version: number;
  category: string;
  escopo: string;
  text: string;
  structured: Record<string, unknown> | null;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  vertical: string | null;
  languages: string[];
  timezone: string;
  session_max_minutes: number;
  owner_user_id: string | null;
  auth_epoch: number;
  policy_epoch: number;
  status: string;
  operational_mode: string;
}

let client: SupabaseClient | null = null;
export function supa(): SupabaseClient {
  if (!client) client = createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false } });
  return client;
}
// test seam
export function _setClient(c: SupabaseClient | null) { client = c; }

const tenantCache = new Map<string, { authEpoch: number; policyEpoch: number; rules: Rule[] }>();

async function loadTenantRow(column: "slug" | "id", value: string): Promise<{ tenant: Tenant; rules: Rule[] }> {
  const s = supa();
  const { data: tenant, error: te } = await s.from("tenants").select("*").eq(column, value).single();
  if (te || !tenant) throw new Error(`tenant_not_found: ${value}`);
  const typedTenant = tenant as Tenant;
  if (!Number.isInteger(typedTenant.auth_epoch) || !Number.isInteger(typedTenant.policy_epoch)) {
    throw new Error("tenant_authority_epochs_missing");
  }

  const hit = tenantCache.get(typedTenant.slug);
  if (hit && hit.authEpoch === typedTenant.auth_epoch && hit.policyEpoch === typedTenant.policy_epoch) {
    return { tenant: typedTenant, rules: hit.rules };
  }

  const { data: rules, error: re } = await s
    .from("effective_rules")
    .select("id,rule_group_id,version,category,escopo,text,structured")
    .eq("tenant_id", typedTenant.id);
  if (re) throw new Error(`rules_load_failed: ${re.message}`);
  const effectiveRules = (rules ?? []) as Rule[];
  tenantCache.set(typedTenant.slug, {
    authEpoch: typedTenant.auth_epoch,
    policyEpoch: typedTenant.policy_epoch,
    rules: effectiveRules,
  });
  return { tenant: typedTenant, rules: effectiveRules };
}

export async function loadTenant(slug: string): Promise<{ tenant: Tenant; rules: Rule[] }> {
  return loadTenantRow("slug", slug);
}

export async function loadTenantById(id: string): Promise<{ tenant: Tenant; rules: Rule[] }> {
  return loadTenantRow("id", id);
}

export function invalidateTenant(slug: string) { tenantCache.delete(slug); }

export function priceRules(rules: Rule[]) {
  return rules
    .filter((r) => r.category === "preco" && r.structured && (r.structured as any).service_type)
    .map((r) => ({ rule_id: r.id, ...(r.structured as any), description: r.text })) as Array<{
      rule_id: string; service_type: string; price_min?: number; price_target?: number;
      duration_min?: number; grant?: string; surcharge?: number; amarelo_above?: number; description: string;
    }>;
}

export function ruleByCategory(rules: Rule[], category: string): Rule | undefined {
  return rules.find((r) => r.category === category);
}
