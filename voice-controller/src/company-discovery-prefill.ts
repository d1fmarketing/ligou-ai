import { createHash } from "node:crypto";
import {
  coverageKey,
  createCoverage,
  evaluateCoverage,
  isCoverageField,
  resolveLocalityValueFromRegistry,
  type CoverageCell,
  type CoverageField,
  type CoverageSnapshot,
  type LocalityRegistryEntry,
} from "./onboarding-coverage.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const FALSE_AUTHORITY = Object.freeze({
  rules_approved: false,
  powers_granted: false,
  operational_mode_changed: false,
});

interface ApprovedFact {
  claim_id: string;
  claim_class: "descriptive" | "operational" | "safety_critical";
  claim_type: string;
  value: unknown;
  decision: "approve" | "edit";
  edited_by_owner: boolean;
  evidence_refs: string[];
  confidence: "high" | "medium" | "low";
  contradiction_status: "none" | "possible" | "confirmed";
  adapter_id: "direct_model";
  provider: "openai-codex";
  model: "gpt-5.6-sol";
  claim_schema_version: "company_discovery.claim.v2";
  missing_fields: string[];
  ambiguous_fields: string[];
  contradictions: string[];
  uncertainty: string[];
  website_missing_fields: string[];
  website_ambiguous_fields: string[];
  website_contradictions: string[];
  website_uncertainty: string[];
}

interface UnresolvedItem {
  reason: string;
  claim_id: string | null;
  claim_type: string | null;
  field: string | null;
  coverage_field: CoverageField | null;
  coverage_subject: string | null;
  question_pt: string;
}

interface DraftReadback {
  draft_id: string;
  draft_version: number;
  draft_hash: string;
  draft: {
    schema_version: "company_discovery.onboarding_draft.v1";
    source_job_id: string;
    source_result_id: string;
    approved_facts: ApprovedFact[];
    rejected_claim_ids: string[];
    unresolved_items: UnresolvedItem[];
    authority: typeof FALSE_AUTHORITY;
  };
}

export interface CompanyDiscoveryPrefillInput {
  tenant_id: string;
  call_id: string;
  draft_readback: unknown;
  localities: LocalityRegistryEntry[];
}

export interface CompanyDiscoveryPrefillProjection {
  readonly draft_id: string;
  readonly draft_hash: string;
  readonly coverage: Readonly<Record<string, unknown>> & {
    readonly snapshot: CoverageSnapshot;
    readonly progress: ReturnType<typeof evaluateCoverage>;
    readonly next_action: Readonly<Record<string, unknown>>;
    readonly authority: typeof FALSE_AUTHORITY;
  };
}

function fail(message: string): never {
  throw new Error(`company_discovery_prefill_invalid:${message}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail(`${name}_object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${name}_keys`);
  }
}

function strings(value: unknown, name: string, maximum = 100): string[] {
  if (!Array.isArray(value) || value.length > maximum ||
      value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 2_000)) {
    fail(`${name}_strings`);
  }
  return value.slice();
}

function parseFact(value: unknown, index: number): ApprovedFact {
  const fact = record(value, `fact_${index}`);
  exact(fact, [
    "claim_id", "claim_class", "claim_type", "value", "decision",
    "edited_by_owner", "evidence_refs", "confidence", "contradiction_status",
    "adapter_id", "provider", "model", "claim_schema_version", "missing_fields",
    "ambiguous_fields", "contradictions", "uncertainty", "website_missing_fields",
    "website_ambiguous_fields", "website_contradictions", "website_uncertainty",
  ], `fact_${index}`);
  if (typeof fact.claim_id !== "string" || !UUID.test(fact.claim_id) ||
      !["descriptive", "operational", "safety_critical"].includes(String(fact.claim_class)) ||
      typeof fact.claim_type !== "string" || !fact.claim_type || fact.claim_type.length > 200 ||
      (fact.decision !== "approve" && fact.decision !== "edit") ||
      typeof fact.edited_by_owner !== "boolean" ||
      (fact.confidence !== "high" && fact.confidence !== "medium" && fact.confidence !== "low") ||
      !["none", "possible", "confirmed"].includes(String(fact.contradiction_status)) ||
      fact.adapter_id !== "direct_model" || fact.provider !== "openai-codex" ||
      fact.model !== "gpt-5.6-sol" ||
      fact.claim_schema_version !== "company_discovery.claim.v2") {
    fail(`fact_${index}_identity`);
  }
  const evidence = strings(fact.evidence_refs, `fact_${index}_evidence`, 25);
  if (evidence.length === 0 || evidence.some((id) => !UUID.test(id))) {
    fail(`fact_${index}_evidence`);
  }
  return {
    claim_id: fact.claim_id,
    claim_class: fact.claim_class as ApprovedFact["claim_class"],
    claim_type: fact.claim_type,
    value: structuredClone(fact.value),
    decision: fact.decision,
    edited_by_owner: fact.edited_by_owner,
    evidence_refs: evidence,
    confidence: fact.confidence,
    contradiction_status: fact.contradiction_status as ApprovedFact["contradiction_status"],
    adapter_id: "direct_model",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    claim_schema_version: "company_discovery.claim.v2",
    missing_fields: strings(fact.missing_fields, `fact_${index}_missing`, 50),
    ambiguous_fields: strings(fact.ambiguous_fields, `fact_${index}_ambiguous`, 50),
    contradictions: strings(fact.contradictions, `fact_${index}_contradictions`, 20),
    uncertainty: strings(fact.uncertainty, `fact_${index}_uncertainty`, 20),
    website_missing_fields: strings(fact.website_missing_fields, `fact_${index}_website_missing`, 50),
    website_ambiguous_fields: strings(fact.website_ambiguous_fields, `fact_${index}_website_ambiguous`, 50),
    website_contradictions: strings(fact.website_contradictions, `fact_${index}_website_contradictions`, 20),
    website_uncertainty: strings(fact.website_uncertainty, `fact_${index}_website_uncertainty`, 20),
  };
}

function parseUnresolvedItem(value: unknown, index: number): UnresolvedItem {
  const item = record(value, `unresolved_${index}`);
  exact(item, [
    "reason", "claim_id", "claim_type", "field", "coverage_field",
    "coverage_subject", "question_pt",
  ], `unresolved_${index}`);
  if (typeof item.reason !== "string" || !item.reason || item.reason.length > 100 ||
      !(item.claim_id === null || (typeof item.claim_id === "string" && UUID.test(item.claim_id))) ||
      !(item.claim_type === null || (typeof item.claim_type === "string" && item.claim_type.length > 0 && item.claim_type.length <= 200)) ||
      !(item.field === null || (typeof item.field === "string" && item.field.length > 0 && item.field.length <= 200)) ||
      !(item.coverage_field === null || isCoverageField(item.coverage_field)) ||
      !(item.coverage_subject === null || (typeof item.coverage_subject === "string" && /^[a-z0-9][a-z0-9_]{0,199}$/.test(item.coverage_subject))) ||
      typeof item.question_pt !== "string" || !item.question_pt.trim() || item.question_pt.length > 2_000) {
    fail(`unresolved_${index}_shape`);
  }
  if (item.coverage_field?.startsWith("service.") &&
      item.coverage_field !== "service.catalog_closure" && item.coverage_subject === null) {
    fail(`unresolved_${index}_subject`);
  }
  if (item.coverage_field !== null && !item.coverage_field.startsWith("service.") &&
      item.coverage_subject !== null) fail(`unresolved_${index}_subject`);
  return {
    reason: item.reason,
    claim_id: item.claim_id,
    claim_type: item.claim_type,
    field: item.field,
    coverage_field: item.coverage_field as CoverageField | null,
    coverage_subject: item.coverage_subject,
    question_pt: item.question_pt,
  };
}

function parseDraftReadback(value: unknown): DraftReadback {
  const readback = record(value, "readback");
  exact(readback, ["draft_id", "draft_version", "draft_hash", "draft"], "readback");
  const draft = record(readback.draft, "draft");
  exact(draft, [
    "schema_version", "source_job_id", "source_result_id", "approved_facts",
    "rejected_claim_ids", "unresolved_items", "authority",
  ], "draft");
  const authority = record(draft.authority, "authority");
  exact(authority, ["rules_approved", "powers_granted", "operational_mode_changed"], "authority");
  if (typeof readback.draft_id !== "string" || !UUID.test(readback.draft_id) ||
      !Number.isSafeInteger(readback.draft_version) || Number(readback.draft_version) < 1 ||
      typeof readback.draft_hash !== "string" || !HASH.test(readback.draft_hash) ||
      draft.schema_version !== "company_discovery.onboarding_draft.v1" ||
      typeof draft.source_job_id !== "string" || !UUID.test(draft.source_job_id) ||
      typeof draft.source_result_id !== "string" || !UUID.test(draft.source_result_id) ||
      authority.rules_approved !== false || authority.powers_granted !== false ||
      authority.operational_mode_changed !== false ||
      !Array.isArray(draft.approved_facts) || draft.approved_facts.length > 100 ||
      !Array.isArray(draft.unresolved_items) || draft.unresolved_items.length > 500) {
    fail("readback_shape");
  }
  const rejected = strings(draft.rejected_claim_ids, "rejected_claim_ids", 100);
  if (rejected.some((id) => !UUID.test(id))) fail("rejected_claim_ids");
  return {
    draft_id: readback.draft_id,
    draft_version: Number(readback.draft_version),
    draft_hash: readback.draft_hash,
    draft: {
      schema_version: "company_discovery.onboarding_draft.v1",
      source_job_id: draft.source_job_id,
      source_result_id: draft.source_result_id,
      approved_facts: draft.approved_facts.map(parseFact),
      rejected_claim_ids: rejected,
      unresolved_items: draft.unresolved_items.map(parseUnresolvedItem),
      authority: FALSE_AUTHORITY,
    },
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]));
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function semanticCell(cell: CoverageCell): unknown {
  const { attempts: _attempts, ...semantic } = cell;
  return canonicalValue(semantic);
}

function snapshotHashes(snapshot: CoverageSnapshot): Record<string, string> {
  return Object.fromEntries(Object.entries(snapshot.cells)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, cell]) => [key, hash({ coverage_key: key, cell: semanticCell(cell) })]));
}

function answered(value: unknown): CoverageCell {
  return { state: "answered", attempts: 0, value: structuredClone(value) };
}

function ambiguous(reason: string, questionPt: string): CoverageCell {
  return { state: "ambiguous", attempts: 0, reason, questionPt };
}

function addService(snapshot: CoverageSnapshot, subject: string): void {
  if (!/^[a-z0-9][a-z0-9_]{0,199}$/.test(subject)) return;
  if (!snapshot.services.includes(subject) && snapshot.services.length < 20) {
    snapshot.services.push(subject);
  }
}

function setCell(
  snapshot: CoverageSnapshot,
  field: CoverageField,
  cell: CoverageCell,
  subject?: string,
): void {
  const key = coverageKey(field, subject);
  const current = snapshot.cells[key];
  if (current?.state === "answered" && cell.state === "answered" &&
      typeof current.value === "string" && typeof cell.value === "string") {
    const values = [...new Set([current.value, cell.value])];
    snapshot.cells[key] = answered(values.join("; "));
    return;
  }
  snapshot.cells[key] = cell;
}

function disputed(fact: ApprovedFact): boolean {
  return fact.contradiction_status !== "none" || fact.contradictions.length > 0;
}

function restrictionText(value: Record<string, unknown>): string {
  const pieces = [String(value.rule ?? "")];
  if (typeof value.notice_minutes === "number") pieces.push(`${value.notice_minutes} minutes notice`);
  const fee = value.public_fee as Record<string, unknown> | null;
  if (fee?.amount && fee.currency) pieces.push(`${fee.currency} ${fee.amount}`);
  if (Array.isArray(value.conditions)) pieces.push(...value.conditions.map(String));
  return pieces.filter(Boolean).join(" — ");
}

function guaranteeText(value: Record<string, unknown>): string {
  const kind = ({
    company_guarantee: "company guarantee",
    manufacturer_warranty: "manufacturer warranty",
    satisfaction_statement: "satisfaction statement",
    case_by_case: "case-by-case guarantee",
  })[String(value.guarantee_kind)] ?? String(value.guarantee_kind ?? "");
  const pieces: string[] = kind ? [kind] : [];
  if (Array.isArray(value.coverage)) pieces.push(value.coverage.map(String).join(", "));
  const duration = value.duration as Record<string, unknown> | null;
  if (duration) pieces.push(`${duration.amount} ${duration.unit}`);
  if (Array.isArray(value.conditions)) pieces.push(...value.conditions.map(String));
  if (Array.isArray(value.exclusions) && value.exclusions.length) {
    pieces.push(`exclusions: ${value.exclusions.map(String).join(", ")}`);
  }
  return pieces.filter(Boolean).join(" — ");
}

function applyTerritory(
  snapshot: CoverageSnapshot,
  fact: ApprovedFact,
  localities: LocalityRegistryEntry[],
): void {
  const value = record(fact.value, "territory_value");
  const included = Array.isArray(value.included_areas) ? value.included_areas : [];
  const exactCities = included.every((area) => {
    const item = record(area, "territory_area");
    return item.kind === "city" && typeof item.name === "string" &&
      typeof item.region_state === "string" && typeof item.country_code === "string";
  });
  const safeWholeCompany = value.service_type === null &&
    Array.isArray(value.excluded_areas) && value.excluded_areas.length === 0 &&
    value.radius === null && exactCities && included.length > 0 &&
    fact.ambiguous_fields.length === 0 && !disputed(fact);
  if (!safeWholeCompany) {
    setCell(snapshot, "area.coverage", ambiguous(
      "website_territory_requires_owner_resolution",
      "O site descreve a área de atendimento de forma ampla ou ambígua. Quais cidades exatas sua empresa atende?",
    ));
    return;
  }
  const localityValue = { localities: included.map((area) => {
    const item = area as Record<string, unknown>;
    return {
      display_name: String(item.name),
      country_code: String(item.country_code),
      region_code: String(item.region_state),
    };
  }) };
  const resolution = resolveLocalityValueFromRegistry(localityValue, localities, {
    ownerWords: included.map((area) => String((area as Record<string, unknown>).name)).join(", "),
  });
  if (resolution.state === "resolved") {
    setCell(snapshot, "area.coverage", answered(resolution.value));
  } else {
    setCell(snapshot, "area.coverage", ambiguous(
      "website_territory_registry_resolution_required",
      resolution.state === "ambiguous"
        ? resolution.questionPt
        : "Não encontrei todas as cidades do site no cadastro. Quais cidades exatas sua empresa atende?",
    ));
  }
}

function applyHours(snapshot: CoverageSnapshot, fact: ApprovedFact): void {
  if (disputed(fact)) {
    setCell(snapshot, "schedule.business_hours", ambiguous(
      "website_hours_contradictory",
      "O site mostra horários diferentes. Quais são os horários corretos, inclusive domingo?",
    ));
    return;
  }
  const value = record(fact.value, "hours_value");
  const intervals = Array.isArray(value.ordinary_intervals) ? value.ordinary_intervals : [];
  const timezoneReady = typeof value.timezone === "string" &&
    !fact.missing_fields.includes("timezone") && !fact.ambiguous_fields.includes("timezone");
  if (intervals.length === 1 && value.ordinary_24_7 === false && timezoneReady) {
    const interval = record(intervals[0], "hours_interval");
    setCell(snapshot, "schedule.business_hours", answered({
      days: structuredClone(interval.days),
      hours: { opens: interval.opens, closes: interval.closes },
    }));
  } else {
    setCell(snapshot, "schedule.business_hours", ambiguous(
      "website_hours_need_owner_normalization",
      "Confirme os horários normais da empresa e o fuso horário, inclusive domingo.",
    ));
  }
  if (value.after_hours !== "not_stated" && !fact.missing_fields.includes("after_hours")) {
    const afterHours = value.emergency_24_7 === true || value.after_hours === "emergency_only"
      ? "Atendimento fora do horário somente para emergência; disponibilidade de emergência 24/7 quando publicada."
      : value.after_hours === "available"
        ? "O site informa atendimento fora do horário."
        : "O site informa indisponibilidade fora do horário.";
    setCell(snapshot, "emergency.after_hours", answered(afterHours));
  }
  if (typeof value.holiday_policy === "string" && !fact.missing_fields.includes("holiday_policy")) {
    setCell(snapshot, "schedule.holidays", answered(value.holiday_policy));
  }
}

function applyService(snapshot: CoverageSnapshot, fact: ApprovedFact): void {
  const value = record(fact.value, "service_value");
  const subject = String(value.service_type ?? "");
  if (!subject || disputed(fact) || fact.ambiguous_fields.length) return;
  addService(snapshot, subject);
  if (Array.isArray(value.service_names) && value.service_names.length) {
    setCell(snapshot, "service.name_synonyms", answered(value.service_names), subject);
  }
  const price = value.public_price as Record<string, unknown> | null;
  if (price) {
    const mode = price.qualifier === "fixed" || price.qualifier === "starting_at" ||
        price.qualifier === "estimate"
      ? price.qualifier
      : "owner_review";
    if (mode === "owner_review") {
      const published = [price.currency, price.amount].filter(Boolean).join(" ");
      const condition = typeof price.condition === "string" ? price.condition : "";
      setCell(snapshot, "service.price_mode", ambiguous(
        "website_conditional_public_price",
        `Seu site publica ${published || "um preço"}${condition ? ` com a condição “${condition}”` : ""} para ${subject.replaceAll("_", " ")}. Como esse preço deve ser tratado?`,
      ), subject);
    } else {
      setCell(snapshot, "service.price_mode", answered(mode), subject);
    }
    if ((mode === "fixed" || mode === "starting_at") && typeof price.amount === "string") {
      setCell(snapshot, "service.price_target", answered(Number(price.amount)), subject);
      setCell(snapshot, "service.negotiation", {
        state: "owner_review_required", attempts: 0,
        safeRestriction: "Preço mínimo e negociação permanecem privados e exigem resposta do dono.",
      }, subject);
    }
  }
  if (typeof value.duration_minutes === "number") {
    setCell(snapshot, "service.duration", answered(value.duration_minutes), subject);
  }
}

function applyUnresolved(snapshot: CoverageSnapshot, item: UnresolvedItem): void {
  if (item.coverage_field === null) return;
  const subject = item.coverage_subject ?? undefined;
  if (subject) addService(snapshot, subject);
  setCell(snapshot, item.coverage_field, ambiguous(
    `company_discovery_${item.reason}`,
    item.question_pt,
  ), subject);
}

function applyGuarantee(snapshot: CoverageSnapshot, fact: ApprovedFact): void {
  const value = record(fact.value, "guarantee_value");
  if (disputed(fact) || fact.ambiguous_fields.length) return;
  const text = guaranteeText(value);
  if (!text) return;
  if (typeof value.service_type === "string") {
    addService(snapshot, value.service_type);
    setCell(snapshot, "service.warranty", answered(text), value.service_type);
  } else {
    setCell(snapshot, "policy.warranty_materials", answered(text));
  }
}

function applyRestriction(snapshot: CoverageSnapshot, fact: ApprovedFact): void {
  const value = record(fact.value, "restriction_value");
  const type = String(value.restriction_type ?? "");
  if (disputed(fact) || fact.ambiguous_fields.length) return;
  const text = restrictionText(value);
  if (type === "same_day" || type === "advance_notice") {
    setCell(snapshot, "schedule.same_day_lead_time", answered(text));
  } else if (type === "sunday" || type === "weekend" || type === "emergency_only") {
    if (!snapshot.cells["schedule.business_hours"]) {
      setCell(snapshot, "schedule.business_hours", ambiguous(
        "website_partial_schedule_restriction",
        `O site informa esta restrição: ${text}. Quais são os horários completos, inclusive domingo?`,
      ));
    }
  } else if (type === "cancellation" || type === "no_show_fee" || type === "visit_fee") {
    setCell(snapshot, "schedule.reschedule_cancel", answered(text));
  } else if (type === "access" || type === "customer_presence") {
    setCell(snapshot, "policy.access_cancellation", answered(text));
  } else if (type === "deposit") {
    setCell(snapshot, "policy.payment_estimate", answered(text));
  } else if (type === "service_specific" && typeof value.service_type === "string") {
    addService(snapshot, value.service_type);
    setCell(snapshot, "service.inclusions_exclusions", answered(text), value.service_type);
  }
}

function applyFact(
  snapshot: CoverageSnapshot,
  fact: ApprovedFact,
  localities: LocalityRegistryEntry[],
): void {
  if (fact.claim_type === "service") return applyService(snapshot, fact);
  if (fact.claim_type === "service_territory") return applyTerritory(snapshot, fact, localities);
  if (fact.claim_type === "business_hours") return applyHours(snapshot, fact);
  if (fact.claim_type === "guarantee") return applyGuarantee(snapshot, fact);
  if (fact.claim_type === "booking_restriction") return applyRestriction(snapshot, fact);
  if (fact.claim_type === "emergency" && !disputed(fact) && fact.ambiguous_fields.length === 0) {
    const value = record(fact.value, "emergency_value");
    if (typeof value.guidance === "string") {
      setCell(snapshot, "emergency.safety_escalation", answered(value.guidance));
    }
  }
}

export function buildCompanyDiscoveryPrefill(
  input: CompanyDiscoveryPrefillInput,
): CompanyDiscoveryPrefillProjection {
  if (!UUID.test(input.tenant_id) || !UUID.test(input.call_id) ||
      !Array.isArray(input.localities) || input.localities.length > 10_000) {
    fail("scope");
  }
  const readback = parseDraftReadback(input.draft_readback);
  const snapshot = createCoverage({ tenantId: input.tenant_id, callId: input.call_id });
  for (const fact of readback.draft.approved_facts) {
    applyFact(snapshot, fact, input.localities);
  }
  for (const item of readback.draft.unresolved_items) {
    applyUnresolved(snapshot, item);
  }
  snapshot.services.sort();
  snapshot.revision = 1;
  const progress = evaluateCoverage(snapshot);
  if (progress.readyForReview || progress.nextQuestion === null) {
    fail("prefill_must_leave_owner_question");
  }
  const next = progress.nextQuestion;
  const nextAction = Object.freeze({
    type: "ask",
    field: next.field,
    ...(next.subject ? { subject: next.subject } : {}),
    question_pt: next.questionPt,
  });
  const coverage = Object.freeze({
    schema_version: 2,
    transition_kind: "discovery_prefill",
    tenant_id: input.tenant_id,
    call_id: input.call_id,
    revision: 1,
    complete: false,
    snapshot,
    progress,
    selected_rule_ids: Object.freeze([]),
    next_action: nextAction,
    current_answer_hashes: Object.freeze(snapshotHashes(snapshot)),
    materializations: Object.freeze([]),
    summary_projection: null,
    summary_hash: null,
    authority: FALSE_AUTHORITY,
    discovery_context: Object.freeze({
      draft_id: readback.draft_id,
      draft_version: readback.draft_version,
      draft_hash: readback.draft_hash,
      source_job_id: readback.draft.source_job_id,
      source_result_id: readback.draft.source_result_id,
    }),
  });
  return Object.freeze({
    draft_id: readback.draft_id,
    draft_hash: readback.draft_hash,
    coverage,
  });
}
