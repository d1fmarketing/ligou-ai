// Approved-rules projection: the Supabase ledger is the truth; this cache is derived and refreshable.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
import {
  isExactCityList,
  isExecutableBusinessHours,
} from "./onboarding-coverage.ts";

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

function isV2MarkedRule(rule: Rule): boolean {
  const schema = String(rule.structured?.schema ?? "");
  const key = String(rule.structured?.materialization_key ?? "");
  return (
    schema.startsWith("ligou.rule.") &&
    schema.endsWith(".v2")
  ) ||
    /^(?:domain|service):/.test(key);
}

function v2ServiceSubject(rule: Rule): string | null {
  const structured = rule.structured;
  if (
    rule.category !== "preco" ||
    rule.escopo !== "servico" ||
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

function normalizedServiceSubject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const subject = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_]{0,199}$/.test(subject) ? subject : null;
}

function v2ServicePresenceSubjects(rule: Rule): string[] {
  const structured = rule.structured;
  if (!structured || !isV2MarkedRule(rule)) return [];
  const keyMatch = /^service:([a-z0-9][a-z0-9_]{0,199})$/.exec(
    String(structured.materialization_key ?? ""),
  );
  const claimsService = rule.category === "preco" ||
    structured.schema === "ligou.rule.service.v2" || Boolean(keyMatch);
  if (!claimsService) return [];
  return [...new Set([
    normalizedServiceSubject(structured.service_type),
    keyMatch?.[1] ?? null,
  ].filter((value): value is string => value !== null))];
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
  if (!serviceType || isV2MarkedRule(rule)) return null;
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
  const v2BySubject = new Map<string, Set<Rule>>();
  for (const rule of rules)
    for (const subject of v2ServicePresenceSubjects(rule)) {
      const candidates = v2BySubject.get(subject) ?? new Set<Rule>();
      candidates.add(rule);
      v2BySubject.set(subject, candidates);
    }
  const v2 = [...v2BySubject.entries()].flatMap(([subject, candidates]) => {
    if (candidates.size !== 1) return [];
    const parsed = parseV2Service([...candidates][0]!);
    return parsed?.service_type === subject ? [parsed] : [];
  });
  const legacy = rules.flatMap((rule) => {
    const parsed = parseLegacyService(rule);
    return parsed && !v2BySubject.has(parsed.service_type) ? [parsed] : [];
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
  return rules.find((rule) =>
    rule.category === category && !isV2MarkedRule(rule)
  );
}

const DOMAIN_SCHEMAS = {
  "domain:area": "ligou.rule.area.v2",
  "domain:schedule": "ligou.rule.schedule.v2",
  "domain:emergency": "ligou.rule.emergency.v2",
  "domain:business": "ligou.rule.business.v2",
  "domain:policy": "ligou.rule.policy.v2",
  "domain:authority": "ligou.rule.authority.v2",
} as const;

const DOMAIN_CATEGORIES: Record<keyof typeof DOMAIN_SCHEMAS, string> = {
  "domain:area": "area",
  "domain:schedule": "agenda",
  "domain:emergency": "emergencia",
  "domain:business": "negocio",
  "domain:policy": "politica",
  "domain:authority": "autoridade",
};

export function hasV2DomainRule(
  rules: Rule[],
  key: keyof typeof DOMAIN_SCHEMAS,
): boolean {
  return domainV2Candidates(rules, key).length > 0;
}

function domainV2Candidates(
  rules: Rule[],
  key: keyof typeof DOMAIN_SCHEMAS,
): Rule[] {
  const schema = DOMAIN_SCHEMAS[key];
  const category = DOMAIN_CATEGORIES[key];
  return rules.filter((rule) =>
    isV2MarkedRule(rule) &&
    (
      rule.structured?.schema === schema ||
      rule.structured?.materialization_key === key ||
      rule.category === category
    )
  );
}

function canonicalV2DomainRule(
  rule: Rule,
  key: keyof typeof DOMAIN_SCHEMAS,
): boolean {
  const structured = rule.structured;
  if (
    !structured || structured.schema !== DOMAIN_SCHEMAS[key] ||
    structured.materialization_key !== key ||
    rule.category !== DOMAIN_CATEGORIES[key] ||
    rule.escopo !== (key === "domain:area" ? "localizacao" : "geral") ||
    structured.materialization_eligible !== true ||
    structured.review_ready !== true ||
    !["active", "owner_review_required"].includes(
      String(structured.operational_state),
    ) ||
    !/^[0-9a-f]{64}$/.test(String(structured.materialization_hash ?? ""))
  ) return false;
  if (
    structured.operational_state === "active" && key === "domain:area"
  ) return isExactCityList(structured.cities);
  if (
    structured.operational_state === "active" && key === "domain:schedule"
  )
    return isExecutableBusinessHours(structured.business_hours);
  return true;
}

export function ruleByMaterializationKey(
  rules: Rule[],
  key: keyof typeof DOMAIN_SCHEMAS,
  legacyCategory?: string,
): Rule | undefined {
  const candidates = domainV2Candidates(rules, key);
  if (candidates.length > 0) {
    if (candidates.length !== 1) return undefined;
    const [rule] = candidates;
    return canonicalV2DomainRule(rule!, key) ? rule : undefined;
  }
  return legacyCategory ? ruleByCategory(rules, legacyCategory) : undefined;
}

export function operationalRuleByMaterializationKey(
  rules: Rule[],
  key: keyof typeof DOMAIN_SCHEMAS,
  legacyCategory?: string,
): Rule | undefined {
  const rule = ruleByMaterializationKey(rules, key, legacyCategory);
  if (!rule) return undefined;
  if (rule.structured?.schema !== DOMAIN_SCHEMAS[key]) return rule;
  return rule.structured.operational_state === "active" ? rule : undefined;
}
