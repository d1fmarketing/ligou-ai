import { createHash } from "node:crypto";
import {
  coverageKey,
  isDeclaredCitiesValue,
  isExecutableBusinessHours,
  type CoverageCell,
  type CoverageDisposition,
  type CoverageField,
  type CoverageProgress,
  type CoverageRef,
  type CoverageSnapshot,
} from "./onboarding-coverage.ts";

export type MaterializationKey =
  | `service:${string}`
  | "domain:area"
  | "domain:schedule"
  | "domain:emergency"
  | "domain:business"
  | "domain:policy"
  | "domain:authority";

export type MaterializationState =
  | "active"
  | "owner_review_required"
  | "incomplete"
  | "disabled";

export interface MaterializedRuleV2 {
  key: MaterializationKey;
  category:
    | "preco"
    | "area"
    | "agenda"
    | "emergencia"
    | "negocio"
    | "politica"
    | "autoridade";
  scope: "servico" | "localizacao" | "geral";
  state: MaterializationState;
  reviewReady: boolean;
  text: string;
  structured: Record<string, unknown>;
  sourceRefs: string[];
  materializationHash: string;
}

export interface CoverageSummaryEntryV2 {
  key: string;
  field: CoverageField | "service.catalog_overflow";
  subject?: string;
  disposition: CoverageDisposition;
  labelPt: string;
  valuePt: string;
}

export interface CoverageSummaryProjectionV2 {
  schemaVersion: 2;
  entries: CoverageSummaryEntryV2[];
  anchors: string[];
  summaryHash: string;
}

export interface OnboardingMaterialization {
  rules: MaterializedRuleV2[];
  summary: CoverageSummaryProjectionV2 | null;
}

const FIELD_LABELS: Record<CoverageField, string> = {
  "business.customer_types": "Tipos de clientes",
  "business.excluded_work": "Serviços excluídos",
  "business.languages_tone": "Idioma e tom",
  "area.coverage": "Área atendida",
  "area.out_of_area_policy": "Pedidos fora da área",
  "area.travel_fee": "Taxa de deslocamento",
  "schedule.business_hours": "Horário comercial",
  "schedule.same_day_lead_time": "Antecedência no mesmo dia",
  "schedule.capacity_buffer": "Capacidade e intervalo",
  "schedule.reschedule_cancel": "Remarcação e cancelamento",
  "schedule.holidays": "Feriados",
  "emergency.types": "Tipos de emergência",
  "emergency.safety_escalation": "Orientação de segurança",
  "emergency.after_hours": "Emergência fora do horário",
  "emergency.fee_authority": "Taxa de emergência",
  "policy.payment_estimate": "Pagamento e orçamento",
  "policy.warranty_materials": "Garantia e materiais",
  "policy.access_cancellation": "Acesso e cancelamento",
  "policy.complaints_returns": "Reclamações e retornos",
  "authority.quote_price": "Autonomia para informar preço",
  "authority.negotiate_floor": "Autonomia para negociar",
  "authority.read_calendar": "Autonomia para consultar agenda",
  "authority.book": "Autonomia para agendar",
  "authority.reschedule_cancel": "Autonomia para remarcar ou cancelar",
  "authority.charge_fee": "Autonomia para confirmar taxa",
  "authority.emergency": "Autonomia em emergência",
  "authority.out_of_area": "Autonomia fora da área",
  "service.catalog_closure": "Catálogo de serviços",
  "service.name_synonyms": "Nomes do serviço",
  "service.price_mode": "Modo de preço",
  "service.price_target": "Preço público",
  "service.negotiation": "Negociação",
  "service.duration": "Duração",
  "service.inclusions_exclusions": "Inclusões e exclusões",
  "service.materials_parts": "Materiais e peças",
  "service.warranty": "Garantia",
  "service.emergency_eligibility": "Elegibilidade de emergência",
  "service.escalation": "Escalonamento",
};

const DOMAIN_DEFINITIONS = [
  {
    key: "domain:business" as const,
    category: "negocio" as const,
    scope: "geral" as const,
    schema: "ligou.rule.business.v2",
    fields: [
      "business.customer_types",
      "business.excluded_work",
      "business.languages_tone",
    ] as CoverageField[],
  },
  {
    key: "domain:area" as const,
    category: "area" as const,
    scope: "localizacao" as const,
    schema: "ligou.rule.area.v2",
    fields: [
      "area.coverage",
      "area.out_of_area_policy",
      "area.travel_fee",
    ] as CoverageField[],
  },
  {
    key: "domain:schedule" as const,
    category: "agenda" as const,
    scope: "geral" as const,
    schema: "ligou.rule.schedule.v2",
    fields: [
      "schedule.business_hours",
      "schedule.same_day_lead_time",
      "schedule.capacity_buffer",
      "schedule.reschedule_cancel",
      "schedule.holidays",
    ] as CoverageField[],
  },
  {
    key: "domain:emergency" as const,
    category: "emergencia" as const,
    scope: "geral" as const,
    schema: "ligou.rule.emergency.v2",
    fields: [
      "emergency.types",
      "emergency.safety_escalation",
      "emergency.after_hours",
      "emergency.fee_authority",
    ] as CoverageField[],
  },
  {
    key: "domain:policy" as const,
    category: "politica" as const,
    scope: "geral" as const,
    schema: "ligou.rule.policy.v2",
    fields: [
      "policy.payment_estimate",
      "policy.warranty_materials",
      "policy.access_cancellation",
      "policy.complaints_returns",
    ] as CoverageField[],
  },
  {
    key: "domain:authority" as const,
    category: "autoridade" as const,
    scope: "geral" as const,
    schema: "ligou.rule.authority.v2",
    fields: [
      "authority.quote_price",
      "authority.negotiate_floor",
      "authority.read_calendar",
      "authority.book",
      "authority.reschedule_cancel",
      "authority.charge_fee",
      "authority.emergency",
      "authority.out_of_area",
    ] as CoverageField[],
  },
];

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function scalarValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  if (typeof value === "boolean") return [value ? "sim" : "não"];
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => {
        const rank = (key: string) => {
          const normalized = key.toLowerCase();
          if (["day", "days", "weekdays"].includes(normalized)) return 0;
          if (["open", "opens", "opening", "start", "starts"].includes(normalized)) return 1;
          if (["close", "closes", "closing", "end", "ends"].includes(normalized)) return 2;
          return 3;
        };
        return rank(left) - rank(right) || left.localeCompare(right);
      })
      .flatMap(([, nested]) => scalarValues(nested));
  return [];
}

function renderAnswered(field: CoverageField, value: unknown): string {
  if (field === "service.price_mode")
    return ({
      fixed: "fixo",
      starting_at: "a partir de",
      estimate: "estimativa",
      owner_review: "revisão do dono",
    } as Record<string, string>)[String(value)] ?? String(value);
  if (field === "service.negotiation" && value && typeof value === "object") {
    const negotiation = value as { mode?: unknown; floor?: unknown };
    if (negotiation.mode === "non_negotiable")
      return typeof negotiation.floor === "number"
        ? `não negociável (${negotiation.floor})`
        : "não negociável";
    if (
      negotiation.mode === "negotiable" &&
      typeof negotiation.floor === "number"
    )
      return `mínimo ${negotiation.floor}`;
  }
  if (field === "service.duration") {
    const valuePt = scalarValues(value).join(", ");
    return valuePt ? `${valuePt} minutos` : "";
  }
  return scalarValues(value).join(", ");
}

function cellFor(
  snapshot: CoverageSnapshot,
  ref: CoverageRef,
): CoverageCell | undefined {
  return snapshot.cells[coverageKey(ref.field, ref.subject)];
}

function entryFor(
  snapshot: CoverageSnapshot,
  ref: CoverageRef,
): CoverageSummaryEntryV2 | null {
  const cell = cellFor(snapshot, ref);
  if (!cell || cell.state === "missing" || cell.state === "ambiguous")
    return null;
  const disposition: CoverageDisposition = cell.state === "answered"
    ? "answered"
    : cell.state === "not_applicable"
      ? "not_applicable"
      : "owner_review_required";
  const valuePt = cell.state === "answered"
    ? renderAnswered(ref.field, cell.value)
    : cell.state === "not_applicable"
      ? "Não se aplica"
      : cell.safeRestriction;
  if (!valuePt) return null;
  return {
    key: coverageKey(ref.field, ref.subject),
    field: ref.field,
    ...(ref.subject ? { subject: ref.subject } : {}),
    disposition,
    labelPt: FIELD_LABELS[ref.field],
    valuePt,
  };
}

function activeRefs(progress: CoverageProgress): CoverageRef[] {
  const refs = new Map<string, CoverageRef>();
  for (const ref of [...progress.requiredFields, ...progress.conditionalFields])
    refs.set(coverageKey(ref.field, ref.subject), ref);
  return [...refs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, ref]) => ref);
}

function summaryProjection(
  snapshot: CoverageSnapshot,
  progress: CoverageProgress,
): CoverageSummaryProjectionV2 | null {
  if (!progress.readyForReview) return null;
  const entries: CoverageSummaryEntryV2[] = [];
  for (const ref of activeRefs(progress)) {
    const entry = entryFor(snapshot, ref);
    if (!entry) return null;
    entries.push(entry);
  }
  if (snapshot.catalogOverflow)
    entries.push({
      key: "service.catalog_overflow",
      field: "service.catalog_overflow",
      disposition: "owner_review_required",
      labelPt: "Catálogo excedente",
      valuePt: snapshot.catalogOverflow.safeRestriction,
    });
  entries.sort((left, right) => left.key.localeCompare(right.key));
  const anchors = entries.map((entry) =>
    entry.subject
      ? `${entry.labelPt} (${entry.subject.replace(/_/g, " ")}): ${entry.valuePt}`
      : `${entry.labelPt}: ${entry.valuePt}`
  );
  return {
    schemaVersion: 2,
    entries,
    anchors,
    summaryHash: sha256({ schemaVersion: 2, entries, anchors }),
  };
}

function stateForCells(cells: Array<CoverageCell | undefined>): {
  state: MaterializationState;
  reviewReady: boolean;
  ownerReview: boolean;
} {
  const incomplete = cells.some(
    (cell) => !cell || cell.state === "missing" || cell.state === "ambiguous",
  );
  const ownerReview = cells.some(
    (cell) => cell?.state === "owner_review_required",
  );
  return {
    state: incomplete
      ? "incomplete"
      : ownerReview
        ? "owner_review_required"
        : "active",
    reviewReady: !incomplete,
    ownerReview,
  };
}

function withHash(
  rule: Omit<MaterializedRuleV2, "materializationHash">,
): MaterializedRuleV2 {
  const {
    coverage_revision: _coverageRevision,
    materialization_hash: _priorHash,
    ...semanticStructured
  } = rule.structured;
  const materializationHash = sha256({
    ...rule,
    structured: semanticStructured,
  });
  return {
    ...rule,
    materializationHash,
    structured: {
      ...rule.structured,
      materialization_hash: materializationHash,
    },
  };
}

function serviceRule(
  snapshot: CoverageSnapshot,
  progress: CoverageProgress,
  subject: string,
): MaterializedRuleV2 {
  const refs = activeRefs(progress).filter((ref) => ref.subject === subject);
  const cells = refs.map((ref) => cellFor(snapshot, ref));
  const status = stateForCells(cells);
  const ownerReviewFields = refs
    .filter((ref) => cellFor(snapshot, ref)?.state === "owner_review_required")
    .map((ref) => ref.field)
    .sort();
  const value = (field: CoverageField) => {
    const cell = cellFor(snapshot, { field, subject });
    return cell?.state === "answered" ? cell.value : undefined;
  };
  const modeCell = cellFor(snapshot, {
    field: "service.price_mode",
    subject,
  });
  const mode = modeCell?.state === "answered" &&
      ["fixed", "starting_at", "estimate", "owner_review"].includes(
        String(modeCell.value),
      )
    ? String(modeCell.value) as
      | "fixed"
      | "starting_at"
      | "estimate"
      | "owner_review"
    : "owner_review";
  const target = value("service.price_target");
  const negotiation = value("service.negotiation") as
    | { mode?: unknown; floor?: unknown }
    | undefined;
  const duration = value("service.duration");
  const targetValid = typeof target === "number" && Number.isFinite(target) && target >= 0;
  const durationValid = typeof duration === "number" && Number.isFinite(duration) && duration > 0;
  const floor = negotiation?.floor;
  const floorValid = typeof floor === "number" && Number.isFinite(floor) && floor >= 0 && targetValid && floor <= target;
  const pricingMode = mode === "fixed" || mode === "starting_at";
  const quoteable = status.reviewReady && status.state === "active" &&
    pricingMode && targetValid && floorValid && durationValid;
  const negotiable = quoteable && negotiation?.mode === "negotiable";
  const names = value("service.name_synonyms");
  const serviceNames = Array.isArray(names) && names.every((name) => typeof name === "string")
    ? names.map((name) => String(name).trim()).filter(Boolean)
    : [subject.replace(/_/g, " ")];
  const resolvedEntries = refs.flatMap((ref) => {
    const entry = entryFor(snapshot, ref);
    return entry ? [entry] : [];
  });
  const text = [
    `Serviço ${serviceNames.join(" / ")}.`,
    ...resolvedEntries.map((entry) => `${entry.labelPt}: ${entry.valuePt}.`),
  ].join(" ");
  const sourceRefs = refs.map((ref) => coverageKey(ref.field, ref.subject)).sort();
  const structured: Record<string, unknown> = {
    schema: "ligou.rule.service.v2",
    service_type: subject,
    service_names: serviceNames,
    price_mode: mode,
    quoteable,
    negotiable,
    operational_state:
      mode === "owner_review" && status.reviewReady
        ? "owner_review_required"
        : status.state,
    owner_review_fields: mode === "owner_review" && status.reviewReady
      ? [...new Set(["service.price_mode", ...ownerReviewFields])].sort()
      : ownerReviewFields,
    materialization_key: `service:${subject}`,
    materialization_eligible: status.reviewReady,
    review_ready: status.reviewReady,
    coverage_revision: snapshot.revision,
    source_call_id: snapshot.callId,
    source_refs: sourceRefs,
    ...(durationValid ? { duration_min: duration } : {}),
    ...(quoteable
      ? {
          price_target: target,
          price_min: floor,
        }
      : {}),
    ...(value("service.inclusions_exclusions") !== undefined
      ? { inclusions_exclusions: value("service.inclusions_exclusions") }
      : {}),
    ...(cellFor(snapshot, { field: "service.materials_parts", subject })?.state ===
        "not_applicable"
      ? { materials_parts: null }
      : value("service.materials_parts") !== undefined
        ? { materials_parts: value("service.materials_parts") }
        : {}),
    ...(value("service.warranty") !== undefined
      ? { warranty: value("service.warranty") }
      : {}),
    ...(typeof value("service.emergency_eligibility") === "boolean"
      ? { emergency_eligible: value("service.emergency_eligibility") }
      : {}),
    ...(value("service.escalation") !== undefined
      ? { escalation: value("service.escalation") }
      : {}),
  };
  const state = mode === "owner_review" && status.reviewReady
    ? "owner_review_required"
    : status.state;
  return withHash({
    key: `service:${subject}`,
    category: "preco",
    scope: "servico",
    state,
    reviewReady: status.reviewReady,
    text,
    structured,
    sourceRefs,
  });
}

function domainRule(
  snapshot: CoverageSnapshot,
  progress: CoverageProgress,
  definition: typeof DOMAIN_DEFINITIONS[number],
): MaterializedRuleV2 {
  const active = new Set(activeRefs(progress).map((ref) => coverageKey(ref.field, ref.subject)));
  const refs = definition.fields
    .map((field) => ({ field }))
    .filter((ref) => active.has(coverageKey(ref.field)));
  const cells = refs.map((ref) => cellFor(snapshot, ref));
  const baseStatus = stateForCells(cells);
  const area = definition.key === "domain:area"
    ? cellFor(snapshot, { field: "area.coverage" })
    : undefined;
  const hours = definition.key === "domain:schedule"
    ? cellFor(snapshot, { field: "schedule.business_hours" })
    : undefined;
  const invalidEnforcementValue =
    (area?.state === "answered" && !isDeclaredCitiesValue(area.value)) ||
    (hours?.state === "answered" && !isExecutableBusinessHours(hours.value));
  const status = invalidEnforcementValue
    ? { ...baseStatus, state: "incomplete" as const, reviewReady: false }
    : baseStatus;
  const entries = refs.flatMap((ref) => {
    const entry = entryFor(snapshot, ref);
    return entry ? [entry] : [];
  });
  const ownerReviewFields = refs
    .filter((ref) => cellFor(snapshot, ref)?.state === "owner_review_required")
    .map((ref) => ref.field)
    .sort();
  const sourceRefs = refs.map((ref) => coverageKey(ref.field)).sort();
  const fieldValues = Object.fromEntries(entries.map((entry) => [
    entry.field.slice(entry.field.indexOf(".") + 1),
    entry.valuePt,
  ]));
  const structured: Record<string, unknown> = {
    schema: definition.schema,
    materialization_key: definition.key,
    operational_state: status.state,
    materialization_eligible: status.reviewReady,
    review_ready: status.reviewReady,
    owner_review_fields: ownerReviewFields,
    coverage_revision: snapshot.revision,
    source_call_id: snapshot.callId,
    source_refs: sourceRefs,
    fields: fieldValues,
  };
  if (definition.key === "domain:area") {
    if (area?.state === "answered" && isDeclaredCitiesValue(area.value)) {
      structured.coverage_labels = area.value.cities;
      structured.cities = area.value.cities;
    }
  }
  if (definition.key === "domain:schedule") {
    if (hours?.state === "answered" && isExecutableBusinessHours(hours.value))
      structured.business_hours = canonicalValue(hours.value);
  }
  const text = entries.map((entry) => `${entry.labelPt}: ${entry.valuePt}.`).join(" ");
  return withHash({
    key: definition.key,
    category: definition.category,
    scope: definition.scope,
    state: status.state,
    reviewReady: status.reviewReady,
    text,
    structured,
    sourceRefs,
  });
}

export function materializeCoverage(
  snapshot: CoverageSnapshot,
  progress: CoverageProgress,
): OnboardingMaterialization {
  const rules = [
    ...snapshot.services.map((subject) => serviceRule(snapshot, progress, subject)),
    ...DOMAIN_DEFINITIONS.map((definition) =>
      domainRule(snapshot, progress, definition)
    ),
  ].sort((left, right) => left.key.localeCompare(right.key));
  const summary = rules.every((rule) => rule.reviewReady)
    ? summaryProjection(snapshot, progress)
    : null;
  return {
    rules,
    summary,
  };
}
