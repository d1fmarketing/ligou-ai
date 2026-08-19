// Approved-rules projection: the Supabase ledger is the truth; this cache is derived and refreshable.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.ts";

export interface Rule {
  id: string;
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
}

let client: SupabaseClient | null = null;
export function supa(): SupabaseClient {
  if (!client) client = createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false } });
  return client;
}
// test seam
export function _setClient(c: SupabaseClient | null) { client = c; }

const tenantCache = new Map<string, { tenant: Tenant; rules: Rule[]; at: number }>();
const TTL_MS = 30_000;

export async function loadTenant(slug: string): Promise<{ tenant: Tenant; rules: Rule[] }> {
  const hit = tenantCache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const s = supa();
  const { data: tenant, error: te } = await s.from("tenants").select("*").eq("slug", slug).single();
  if (te || !tenant) throw new Error(`tenant_not_found: ${slug}`);
  const { data: rules, error: re } = await s
    .from("rules")
    .select("id,category,escopo,text,structured")
    .eq("tenant_id", tenant.id)
    .eq("status", "aprovado");
  if (re) throw new Error(`rules_load_failed: ${re.message}`);
  const entry = { tenant: tenant as Tenant, rules: (rules ?? []) as Rule[], at: Date.now() };
  tenantCache.set(slug, entry);
  return entry;
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
