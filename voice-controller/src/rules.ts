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

export interface ServicePolicy {
  rule_id: string;
  service_type: string;
  service_names: string[];
  price_mode: "fixed" | "starting_at" | "estimate" | "owner_review" | "legacy";
  quoteable: boolean;
  negotiable: boolean;
  operational_state: "active" | "owner_review_required" | "legacy";
  price_min?: number;
  price_target?: number;
  duration_min?: number;
  grant?: string;
  surcharge?: number;
  amarelo_above?: number;
  description: string;
  schema?: "ligou.rule.service.v2";
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function v2ServiceSubject(rule: Rule): string | null {
  const structured = rule.structured;
  if (
    rule.category !== "preco" ||
    structured?.schema !== "ligou.rule.service.v2"
  ) return null;
  const serviceType = typeof structured.service_type === "string"
    ? structured.service_type.trim().toLowerCase()
    : "";
  return serviceType &&
      structured.materialization_key === `service:${serviceType}`
    ? serviceType
    : null;
}

function parseV2Service(rule: Rule): ServicePolicy | null {
  const structured = rule.structured;
  const serviceType = v2ServiceSubject(rule);
  if (!structured || !serviceType) return null;
  const names = Array.isArray(structured.service_names)
    ? structured.service_names.filter(
        (name): name is string => typeof name === "string" && name.trim().length > 0,
      ).map((name) => name.trim())
    : [];
  const mode = structured.price_mode;
  const state = structured.operational_state;
  if (
    structured.materialization_eligible !== true ||
    structured.review_ready !== true ||
    !/^[0-9a-f]{64}$/.test(String(structured.materialization_hash ?? "")) ||
    !Number.isSafeInteger(structured.coverage_revision) ||
    typeof structured.source_call_id !== "string" ||
    names.length === 0 ||
    !["fixed", "starting_at", "estimate", "owner_review"].includes(String(mode)) ||
    !["active", "owner_review_required", "disabled"].includes(String(state))
  ) return null;
  if (state === "disabled") return null;
  const pricingMode = mode === "fixed" || mode === "starting_at";
  const quoteable = structured.quoteable === true;
  const target = structured.price_target;
  const floor = structured.price_min;
  const duration = structured.duration_min;
  if (
    quoteable &&
    (
      state !== "active" || !pricingMode ||
      !finiteNonnegative(target) || !finiteNonnegative(floor) ||
      floor > target || !finitePositive(duration)
    )
  ) return null;
  if (
    (mode === "estimate" || mode === "owner_review" ||
      state === "owner_review_required") && quoteable
  ) return null;
  return {
    rule_id: rule.id,
    service_type: serviceType,
    service_names: names,
    price_mode: mode as ServicePolicy["price_mode"],
    quoteable,
    negotiable: quoteable && structured.negotiable === true,
    operational_state: state as ServicePolicy["operational_state"],
    ...(quoteable ? { price_target: target as number, price_min: floor as number } : {}),
    ...(finitePositive(duration) ? { duration_min: duration } : {}),
    description: rule.text,
    schema: "ligou.rule.service.v2",
  };
}

function parseLegacyService(rule: Rule): ServicePolicy | null {
  if (rule.category !== "preco" || !rule.structured) return null;
  const structured = rule.structured;
  const serviceType = typeof structured.service_type === "string"
    ? structured.service_type.trim().toLowerCase()
    : "";
  if (!serviceType || structured.schema === "ligou.rule.service.v2") return null;
  const target = structured.price_target;
  const floor = structured.price_min;
  const surcharge = structured.surcharge;
  const quoteable = finiteNonnegative(target) || finiteNonnegative(surcharge);
  return {
    rule_id: rule.id,
    service_type: serviceType,
    service_names: [serviceType.replace(/_/g, " ")],
    price_mode: "legacy",
    quoteable,
    negotiable: finiteNonnegative(floor) && finiteNonnegative(target) && floor < target,
    operational_state: "legacy",
    ...(finiteNonnegative(target) ? { price_target: target } : {}),
    ...(finiteNonnegative(floor) ? { price_min: floor } : {}),
    ...(finitePositive(structured.duration_min)
      ? { duration_min: structured.duration_min }
      : {}),
    ...(typeof structured.grant === "string" ? { grant: structured.grant } : {}),
    ...(finiteNonnegative(surcharge) ? { surcharge } : {}),
    ...(finiteNonnegative(structured.amarelo_above)
      ? { amarelo_above: structured.amarelo_above }
      : {}),
    description: rule.text,
  };
}

export function servicePolicies(rules: Rule[]): ServicePolicy[] {
  const v2Subjects = new Set(
    rules.map(v2ServiceSubject).filter((value): value is string => value !== null),
  );
  const v2 = rules.flatMap((rule) => {
    const parsed = parseV2Service(rule);
    return parsed ? [parsed] : [];
  });
  const legacy = rules.flatMap((rule) => {
    const parsed = parseLegacyService(rule);
    return parsed && !v2Subjects.has(parsed.service_type) ? [parsed] : [];
  });
  return [...v2, ...legacy].sort((left, right) =>
    left.service_type.localeCompare(right.service_type)
  );
}

export function priceRules(rules: Rule[]) {
  return servicePolicies(rules).filter((policy) =>
    policy.operational_state !== "owner_review_required" &&
    policy.quoteable &&
    (
      policy.surcharge !== undefined ||
      (
        finiteNonnegative(policy.price_target) &&
        finiteNonnegative(policy.price_min) &&
        (
          policy.schema !== "ligou.rule.service.v2" ||
          finitePositive(policy.duration_min)
        )
      )
    )
  );
}

export function ruleByCategory(rules: Rule[], category: string): Rule | undefined {
  return rules.find((r) => r.category === category);
}

const DOMAIN_SCHEMAS: Record<string, string> = {
  "domain:area": "ligou.rule.area.v2",
  "domain:schedule": "ligou.rule.schedule.v2",
  "domain:emergency": "ligou.rule.emergency.v2",
  "domain:business": "ligou.rule.business.v2",
  "domain:policy": "ligou.rule.policy.v2",
  "domain:authority": "ligou.rule.authority.v2",
};

export function ruleByMaterializationKey(
  rules: Rule[],
  key: keyof typeof DOMAIN_SCHEMAS,
  legacyCategory?: string,
): Rule | undefined {
  const candidates = rules.filter(
    (rule) => rule.structured?.materialization_key === key,
  );
  if (candidates.length > 0) {
    if (candidates.length !== 1) return undefined;
    const [rule] = candidates;
    const structured = rule!.structured!;
    return structured.schema === DOMAIN_SCHEMAS[key] &&
        structured.materialization_eligible === true &&
        structured.review_ready === true &&
        structured.operational_state !== "disabled" &&
        /^[0-9a-f]{64}$/.test(String(structured.materialization_hash ?? ""))
      ? rule
      : undefined;
  }
  return legacyCategory ? ruleByCategory(rules, legacyCategory) : undefined;
}
