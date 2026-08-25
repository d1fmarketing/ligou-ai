export type CoverageField =
  | "business.customer_types"
  | "business.excluded_work"
  | "business.languages_tone"
  | "area.coverage"
  | "area.out_of_area_policy"
  | "area.travel_fee"
  | "schedule.business_hours"
  | "schedule.same_day_lead_time"
  | "schedule.capacity_buffer"
  | "schedule.reschedule_cancel"
  | "schedule.holidays"
  | "emergency.types"
  | "emergency.safety_escalation"
  | "emergency.after_hours"
  | "emergency.fee_authority"
  | "policy.payment_estimate"
  | "policy.warranty_materials"
  | "policy.access_cancellation"
  | "policy.complaints_returns"
  | "authority.quote_price"
  | "authority.negotiate_floor"
  | "authority.read_calendar"
  | "authority.book"
  | "authority.reschedule_cancel"
  | "authority.charge_fee"
  | "authority.emergency"
  | "authority.out_of_area"
  | "service.catalog_closure"
  | "service.name_synonyms"
  | "service.price_mode"
  | "service.price_target"
  | "service.negotiation"
  | "service.duration"
  | "service.inclusions_exclusions"
  | "service.materials_parts"
  | "service.warranty"
  | "service.emergency_eligibility"
  | "service.escalation";
export type CoverageDisposition =
  | "answered"
  | "not_applicable"
  | "owner_review_required";
export interface CoverageFact {
  field: CoverageField;
  subject?: string;
  disposition: CoverageDisposition;
  value: unknown;
  ruleText?: string;
  ownerWords: string;
}
export type CoverageCell =
  | { state: "missing"; attempts: number }
  | { state: "answered"; attempts: number; value: unknown }
  | { state: "ambiguous"; attempts: number; reason: string }
  | { state: "not_applicable"; attempts: number }
  | {
      state: "owner_review_required";
      attempts: number;
      safeRestriction: string;
    };
export interface CoverageRef {
  field: CoverageField;
  subject?: string;
}
export type CoverageProgressRef =
  | CoverageRef
  | { field: "service.catalog_overflow"; applicationOwned: true };
export interface CoverageQuestion extends CoverageRef {
  questionPt: string;
}
export interface CoverageSnapshot {
  tenantId: string;
  callId: string;
  revision: number;
  services: string[];
  currentSubject?: string;
  cells: Record<string, CoverageCell>;
  followUps: number;
  followUpGroups: Record<string, number>;
  catalogOverflow?: {
    services: string[];
    safeRestriction: string;
    ownerWords: string;
  };
  summaryInvalidated: boolean;
}
export interface CoverageProgress {
  readyForReview: boolean;
  requiredFields: CoverageRef[];
  conditionalFields: CoverageRef[];
  missingRequired: CoverageRef[];
  ambiguous: CoverageRef[];
  answered: CoverageRef[];
  ownerReviewRequired: CoverageProgressRef[];
  notApplicable: CoverageRef[];
  nextQuestion: CoverageQuestion | null;
  catalogNormallyComplete: boolean;
  summaryInvalidated: boolean;
}

const serviceFields: CoverageField[] = [
  "service.name_synonyms",
  "service.price_mode",
  "service.price_target",
  "service.negotiation",
  "service.duration",
  "service.inclusions_exclusions",
  "service.materials_parts",
  "service.warranty",
  "service.emergency_eligibility",
  "service.escalation",
];
const safetyAuthorityFields: CoverageField[] = [
  "emergency.types",
  "emergency.safety_escalation",
  "emergency.after_hours",
  "emergency.fee_authority",
  "authority.quote_price",
  "authority.negotiate_floor",
  "authority.read_calendar",
  "authority.book",
  "authority.reschedule_cancel",
  "authority.charge_fee",
  "authority.emergency",
  "authority.out_of_area",
];
const areaScheduleFields: CoverageField[] = [
  "area.coverage",
  "area.out_of_area_policy",
  "area.travel_fee",
  "schedule.business_hours",
  "schedule.same_day_lead_time",
  "schedule.capacity_buffer",
  "schedule.reschedule_cancel",
  "schedule.holidays",
];
const commercialFields: CoverageField[] = [
  "policy.payment_estimate",
  "policy.warranty_materials",
  "policy.access_cancellation",
  "policy.complaints_returns",
];
const businessFields: CoverageField[] = [
  "business.customer_types",
  "business.excluded_work",
  "business.languages_tone",
];
const notApplicableFields = new Set<CoverageField>([
  "area.travel_fee",
  "service.materials_parts",
]);
const textFields = new Set<CoverageField>([
  "business.excluded_work",
  "business.languages_tone",
  "area.out_of_area_policy",
  "area.travel_fee",
  "schedule.business_hours",
  "schedule.same_day_lead_time",
  "schedule.capacity_buffer",
  "schedule.reschedule_cancel",
  "schedule.holidays",
  "emergency.safety_escalation",
  "emergency.after_hours",
  "emergency.fee_authority",
  "policy.payment_estimate",
  "policy.warranty_materials",
  "policy.access_cancellation",
  "policy.complaints_returns",
  "authority.quote_price",
  "authority.negotiate_floor",
  "authority.read_calendar",
  "authority.book",
  "authority.reschedule_cancel",
  "authority.charge_fee",
  "authority.emergency",
  "authority.out_of_area",
  "service.inclusions_exclusions",
  "service.materials_parts",
  "service.warranty",
  "service.escalation",
]);
const customerTypes = new Set(["residencial", "comercial", "ambos"]);
const restrictionSubjects: Record<CoverageField, string> = {
  "business.customer_types": "tipos de clientes",
  "business.excluded_work": "serviços excluídos",
  "business.languages_tone": "idioma e tom",
  "area.coverage": "área atendida",
  "area.out_of_area_policy": "pedidos fora da área",
  "area.travel_fee": "taxa de deslocamento",
  "schedule.business_hours": "horário comercial",
  "schedule.same_day_lead_time": "antecedência no mesmo dia",
  "schedule.capacity_buffer": "capacidade e intervalo",
  "schedule.reschedule_cancel": "remarcação e cancelamento",
  "schedule.holidays": "feriados",
  "emergency.types": "tipos de emergência",
  "emergency.safety_escalation": "orientação de segurança",
  "emergency.after_hours": "atendimento fora do horário",
  "emergency.fee_authority": "taxa de emergência",
  "policy.payment_estimate": "pagamento e orçamento",
  "policy.warranty_materials": "garantia e materiais",
  "policy.access_cancellation": "acesso e cancelamento",
  "policy.complaints_returns": "reclamações e retornos",
  "authority.quote_price": "informação de preço",
  "authority.negotiate_floor": "negociação",
  "authority.read_calendar": "consulta da agenda",
  "authority.book": "agendamento",
  "authority.reschedule_cancel": "remarcação ou cancelamento",
  "authority.charge_fee": "confirmação de taxa",
  "authority.emergency": "decisão de emergência",
  "authority.out_of_area": "decisão fora da área",
  "service.catalog_closure": "fechamento do catálogo",
  "service.name_synonyms": "nomes do serviço",
  "service.price_mode": "modo de preço",
  "service.price_target": "preço público",
  "service.negotiation": "negociação do serviço",
  "service.duration": "duração do serviço",
  "service.inclusions_exclusions": "inclusões e exclusões",
  "service.materials_parts": "materiais e peças",
  "service.warranty": "garantia do serviço",
  "service.emergency_eligibility": "elegibilidade de emergência",
  "service.escalation": "escalonamento do serviço",
};
const safeRestrictionFor = (field: CoverageField) =>
  `Não executar nem confirmar ${restrictionSubjects[field]} autonomamente; encaminhar a decisão ao dono.`;
const catalogOverflowRestriction =
  "Não aceitar, precificar ou agendar serviços além dos vinte primeiros autonomamente; encaminhar o catálogo ao dono.";
const templates: Record<CoverageField, string> = {
  "service.catalog_closure":
    "Há mais algum serviço que devemos cadastrar antes de encerrar o catálogo?",
  "business.customer_types": "Quais tipos de clientes vocês atendem?",
  "business.excluded_work": "Que tipos de trabalho vocês não realizam?",
  "business.languages_tone":
    "Como a equipe deve se apresentar e em quais idiomas?",
  "area.coverage": "Quais cidades, regiões ou CEPs vocês atendem?",
  "area.out_of_area_policy":
    "Como devemos tratar pedidos fora da área atendida?",
  "area.travel_fee": "Existe taxa de deslocamento fora da área normal?",
  "schedule.business_hours":
    "Quais são os horários de atendimento, inclusive domingo?",
  "schedule.same_day_lead_time":
    "Qual é a regra para atendimento no mesmo dia e antecedência mínima?",
  "schedule.capacity_buffer":
    "Qual margem de capacidade ou intervalo devemos respeitar?",
  "schedule.reschedule_cancel":
    "Qual é a política de remarcação, cancelamento e ausência?",
  "schedule.holidays": "Como devemos agir em feriados?",
  "emergency.types": "Quais situações contam como emergência?",
  "emergency.safety_escalation":
    "Quais instruções de segurança e escalonamento devemos dar?",
  "emergency.after_hours":
    "Quais emergências podem ser tratadas fora do horário?",
  "emergency.fee_authority":
    "Quem pode confirmar taxa de emergência ou visita?",
  "policy.payment_estimate":
    "Quais pagamentos, depósitos e limites de orçamento são aceitos?",
  "policy.warranty_materials":
    "Qual é a política de garantia e materiais do cliente?",
  "policy.access_cancellation":
    "Como tratamos acesso impossível, visita e cancelamento?",
  "policy.complaints_returns":
    "Como devemos encaminhar reclamações, retornos ou retrabalho?",
  "authority.quote_price": "Quando a Ligou pode informar preço?",
  "authority.negotiate_floor":
    "Quando a Ligou pode negociar e qual é o limite?",
  "authority.read_calendar": "A Ligou pode consultar a agenda?",
  "authority.book": "A Ligou pode agendar serviços?",
  "authority.reschedule_cancel": "A Ligou pode remarcar ou cancelar?",
  "authority.charge_fee": "A Ligou pode confirmar ou cobrar taxas?",
  "authority.emergency": "Que autonomia a Ligou tem em emergências?",
  "authority.out_of_area": "Que autonomia a Ligou tem fora da área atendida?",
  "service.name_synonyms": "Quais nomes os clientes usam para este serviço?",
  "service.price_mode":
    "O preço deste serviço é fixo, a partir de, estimativa ou exige revisão do dono?",
  "service.price_target": "Qual é o preço público deste serviço?",
  "service.negotiation": "Este preço é negociável? Se sim, qual é o mínimo?",
  "service.duration": "Qual é a duração típica deste serviço?",
  "service.inclusions_exclusions": "O que este serviço inclui e exclui?",
  "service.materials_parts": "Como tratamos materiais e peças neste serviço?",
  "service.warranty": "Qual garantia vale para este serviço?",
  "service.emergency_eligibility":
    "Este serviço pode ser tratado como emergência?",
  "service.escalation": "Em que situação este serviço exige aprovação do dono?",
};
const inputFields = new Set<string>(Object.keys(templates));
const isServiceField = (field: CoverageField) =>
  field.startsWith("service.") && field !== "service.catalog_closure";
const keyFor = (field: CoverageField, subject?: string) =>
  subject && isServiceField(field) ? `service:${subject}:${field}` : field;
const normalizeSubject = (subject: string) =>
  subject
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const missing = (attempts = 0): CoverageCell => ({
  state: "missing",
  attempts,
});
const covered = (cell: CoverageCell) =>
  cell.state === "answered" ||
  cell.state === "not_applicable" ||
  cell.state === "owner_review_required";
const refForKey = (key: string): CoverageRef =>
  key.startsWith("service:")
    ? {
        field: key.slice(key.lastIndexOf(":") + 1) as CoverageField,
        subject: key.split(":")[1],
      }
    : { field: key as CoverageField };

export function createCoverage({
  tenantId,
  callId,
}: {
  tenantId: string;
  callId: string;
}): CoverageSnapshot {
  return {
    tenantId,
    callId,
    revision: 0,
    services: [],
    cells: {},
    followUps: 0,
    followUpGroups: {},
    summaryInvalidated: false,
  };
}

function activeFields(snapshot: CoverageSnapshot): {
  required: CoverageRef[];
  conditional: CoverageRef[];
} {
  const required: CoverageRef[] = [{ field: "service.catalog_closure" }];
  const conditional: CoverageRef[] = [];
  for (const subject of snapshot.services) {
    const mode = snapshot.cells[keyFor("service.price_mode", subject)];
    const ownerReview =
      mode?.state === "answered" && mode.value === "owner_review";
    for (const field of serviceFields)
      if (
        !ownerReview ||
        !["service.price_target", "service.negotiation"].includes(field)
      )
        required.push({ field, subject });
    if (!ownerReview)
      conditional.push(
        { field: "service.price_target", subject },
        { field: "service.negotiation", subject },
      );
  }
  for (const field of [
    ...safetyAuthorityFields,
    ...areaScheduleFields,
    ...commercialFields,
    ...businessFields,
  ])
    required.push({ field });
  return { required, conditional };
}
function ready(snapshot: CoverageSnapshot): boolean {
  return activeFields(snapshot).required.every((ref) =>
    covered(snapshot.cells[keyFor(ref.field, ref.subject)] ?? missing()),
  );
}
function nonEmptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}
function validBusinessHours(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hours = value as { days?: unknown; hours?: unknown };
  if (!nonEmptyStrings(hours.days)) return false;
  if (typeof hours.hours === "string") return hours.hours.trim().length > 0;
  if (
    !hours.hours ||
    typeof hours.hours !== "object" ||
    Array.isArray(hours.hours)
  )
    return false;
  const window = hours.hours as { opens?: unknown; closes?: unknown };
  return (
    typeof window.opens === "string" &&
    window.opens.trim().length > 0 &&
    typeof window.closes === "string" &&
    window.closes.trim().length > 0
  );
}
function validAnswer(
  field: CoverageField,
  value: unknown,
  snapshot: CoverageSnapshot,
  subject?: string,
): string | null {
  if (field === "service.catalog_closure")
    return value === true ? null : "catalog_closure_must_be_explicit";
  if (field === "service.price_target")
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? null
      : "price_target_must_be_nonnegative_number";
  if (field === "service.duration")
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? null
      : "duration_must_be_positive_number";
  if (field === "service.price_mode")
    return ["fixed", "starting_at", "estimate", "owner_review"].includes(
      String(value),
    )
      ? null
      : "invalid_price_mode";
  if (field === "service.negotiation") {
    if (["non_negotiable", "owner_review"].includes(String(value))) return null;
    const floor =
      typeof value === "number"
        ? value
        : value && typeof value === "object"
          ? (value as { floor?: unknown }).floor
          : undefined;
    const target = subject
      ? snapshot.cells[keyFor("service.price_target", subject)]
      : undefined;
    const price = target?.state === "answered" ? target.value : undefined;
    return typeof floor === "number" &&
      Number.isFinite(floor) &&
      typeof price === "number" &&
      floor >= 0 &&
      floor <= price
      ? null
      : "negotiation_floor_requires_public_price";
  }
  if (field === "service.emergency_eligibility")
    return typeof value === "boolean"
      ? null
      : "emergency_eligibility_must_be_boolean";
  if (field === "schedule.business_hours")
    return validBusinessHours(value) ? null : "must_be_business_hours";
  if (field === "business.customer_types")
    return nonEmptyStrings(value) &&
      value.every((item) => customerTypes.has(item.trim().toLowerCase()))
      ? null
      : "must_be_known_customer_types";
  if (
    ["area.coverage", "emergency.types", "service.name_synonyms"].includes(
      field,
    )
  )
    return nonEmptyStrings(value) ? null : "must_be_nonempty_string_list";
  if (textFields.has(field))
    return typeof value === "string" && value.trim().length > 0
      ? null
      : "must_be_nonempty_text";
  return "unknown_field_validator";
}
function applyOne(
  snapshot: CoverageSnapshot,
  fact: CoverageFact,
): CoverageSnapshot {
  if (!inputFields.has(fact.field)) return snapshot;
  const subject =
    fact.subject && isServiceField(fact.field)
      ? normalizeSubject(fact.subject)
      : undefined;
  if (isServiceField(fact.field) && !subject) return snapshot;
  const previouslyReady = ready(snapshot);
  const cells = { ...snapshot.cells };
  const services = [...snapshot.services];
  if (subject && !services.includes(subject)) {
    if (services.length >= 20) {
      return {
        ...snapshot,
        catalogOverflow: {
          services: [...(snapshot.catalogOverflow?.services ?? []), subject],
          safeRestriction: catalogOverflowRestriction,
          ownerWords: fact.ownerWords,
        },
        currentSubject: subject,
        revision: snapshot.revision + 1,
        summaryInvalidated: previouslyReady || snapshot.summaryInvalidated,
      };
    }
    services.push(subject);
    cells["service.catalog_closure"] = missing(
      cells["service.catalog_closure"]?.attempts ?? 0,
    );
  }
  const key = keyFor(fact.field, subject);
  const attempts = (cells[key]?.attempts ?? 0) + 1;
  let cell: CoverageCell;
  if (fact.disposition === "owner_review_required")
    cell =
      fact.ownerWords.trim().length > 0 &&
      fact.field !== "service.catalog_closure"
        ? {
            state: "owner_review_required",
            attempts,
            safeRestriction: safeRestrictionFor(fact.field),
          }
        : missing(attempts);
  else if (
    fact.disposition === "not_applicable" &&
    fact.field === "service.negotiation"
  ) {
    const target = subject
      ? cells[keyFor("service.price_target", subject)]
      : undefined;
    const price = target?.state === "answered" ? target.value : undefined;
    cell =
      fact.ownerWords.trim().length > 0 &&
      typeof price === "number" &&
      Number.isFinite(price) &&
      price >= 0
        ? {
            state: "answered",
            attempts,
            value: { mode: "non_negotiable", floor: price },
          }
        : {
            state: "ambiguous",
            attempts,
            reason: "non_negotiable_requires_public_target",
          };
  } else if (fact.disposition === "not_applicable")
    cell = notApplicableFields.has(fact.field)
      ? { state: "not_applicable", attempts }
      : missing(attempts);
  else if (fact.disposition !== "answered") cell = missing(attempts);
  else {
    const error = validAnswer(
      fact.field,
      fact.value,
      { ...snapshot, cells },
      subject,
    );
    const storedValue =
      fact.field === "service.negotiation" && error === null
        ? typeof fact.value === "string"
          ? { mode: "non_negotiable" }
          : {
              mode: "negotiable",
              floor:
                typeof fact.value === "number"
                  ? fact.value
                  : (fact.value as { floor: number }).floor,
            }
        : fact.value;
    cell = error
      ? fact.field === "service.catalog_closure"
        ? missing(attempts)
        : { state: "ambiguous", attempts, reason: error }
      : { state: "answered", attempts, value: storedValue };
  }
  cells[key] = cell;
  return {
    ...snapshot,
    services,
    currentSubject: subject ?? snapshot.currentSubject,
    cells,
    revision: snapshot.revision + 1,
    summaryInvalidated: previouslyReady || snapshot.summaryInvalidated,
  };
}
export function applyCoverageFact(
  snapshot: CoverageSnapshot,
  fact: CoverageFact,
): CoverageSnapshot {
  const bundled =
    fact.value && typeof fact.value === "object" && "fields" in fact.value
      ? (fact.value as { fields?: Record<string, unknown> }).fields
      : undefined;
  if (!bundled) return applyOne(snapshot, fact);
  const applied = Object.entries(bundled)
    .sort(([left], [right]) => {
      const a = serviceFields.indexOf(left as CoverageField);
      const b = serviceFields.indexOf(right as CoverageField);
      return (
        (a < 0 ? Number.MAX_SAFE_INTEGER : a) -
          (b < 0 ? Number.MAX_SAFE_INTEGER : b) || left.localeCompare(right)
      );
    })
    .reduce(
      (next, [field, value]) =>
        applyOne(next, { ...fact, field: field as CoverageField, value }),
      snapshot,
    );
  return {
    ...applied,
    revision: snapshot.revision + 1,
    summaryInvalidated: ready(snapshot) || snapshot.summaryInvalidated,
  };
}
function questionFor(ref: CoverageRef): CoverageQuestion {
  return {
    ...ref,
    questionPt: ref.subject
      ? `${templates[ref.field]} (${ref.subject.replace(/_/g, " ")})`
      : templates[ref.field],
  };
}
export function evaluateCoverage(snapshot: CoverageSnapshot): CoverageProgress {
  const active = activeFields(snapshot);
  const state = (ref: CoverageRef) =>
    snapshot.cells[keyFor(ref.field, ref.subject)] ?? missing();
  const missingRequired = active.required.filter(
    (ref) => state(ref).state === "missing",
  );
  const ambiguous = active.required.filter(
    (ref) => state(ref).state === "ambiguous",
  );
  const unresolved = (refs: CoverageRef[]) =>
    refs.filter((ref) => !covered(state(ref)));
  const currentAmbiguity = snapshot.currentSubject
    ? active.required.filter(
        (ref) =>
          ref.subject === snapshot.currentSubject &&
          state(ref).state === "ambiguous",
      )
    : [];
  const catalog = unresolved([{ field: "service.catalog_closure" }]);
  const service = snapshot.services.flatMap((subject) =>
    active.required.filter((ref) => ref.subject === subject),
  );
  const ordered = [
    ...currentAmbiguity,
    ...catalog,
    ...unresolved(service),
    ...unresolved(safetyAuthorityFields.map((field) => ({ field }))),
    ...unresolved(areaScheduleFields.map((field) => ({ field }))),
    ...unresolved(commercialFields.map((field) => ({ field }))),
    ...unresolved(businessFields.map((field) => ({ field }))),
  ] as CoverageRef[];
  const next =
    snapshot.followUps >= 12
      ? undefined
      : ordered.find(
          (ref) =>
            (snapshot.followUpGroups[keyFor(ref.field, ref.subject)] ?? 0) < 2,
        );
  const ownerReviewRequired: CoverageProgressRef[] = Object.entries(
    snapshot.cells,
  )
    .filter(([, cell]) => cell.state === "owner_review_required")
    .map(([key]) => refForKey(key));
  if (snapshot.catalogOverflow) {
    ownerReviewRequired.push({
      field: "service.catalog_overflow",
      applicationOwned: true,
    });
  }
  return {
    readyForReview:
      missingRequired.length === 0 &&
      ambiguous.length === 0 &&
      (!snapshot.catalogOverflow ||
        snapshot.catalogOverflow.ownerWords.trim().length > 0),
    requiredFields: active.required,
    conditionalFields: active.conditional,
    missingRequired,
    ambiguous,
    answered: Object.entries(snapshot.cells)
      .filter(([, cell]) => cell.state === "answered")
      .map(([key]) => refForKey(key)),
    ownerReviewRequired,
    notApplicable: Object.entries(snapshot.cells)
      .filter(([, cell]) => cell.state === "not_applicable")
      .map(([key]) => refForKey(key)),
    nextQuestion: next ? questionFor(next) : null,
    catalogNormallyComplete: !snapshot.catalogOverflow,
    summaryInvalidated: snapshot.summaryInvalidated,
  };
}
export function recordDirectedFollowUp(
  snapshot: CoverageSnapshot,
  ref: CoverageRef,
): CoverageSnapshot {
  const key = keyFor(ref.field, ref.subject);
  if (snapshot.followUps >= 12 || (snapshot.followUpGroups[key] ?? 0) >= 2)
    return snapshot;
  return {
    ...snapshot,
    followUps: snapshot.followUps + 1,
    followUpGroups: {
      ...snapshot.followUpGroups,
      [key]: (snapshot.followUpGroups[key] ?? 0) + 1,
    },
  };
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  return value;
}
export function canonicalCoverage(snapshot: CoverageSnapshot): string {
  const cells = Object.fromEntries(
    Object.entries(snapshot.cells)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, cell]) => [key, canonicalValue(cell)]),
  );
  return JSON.stringify(
    canonicalValue({
      tenantId: snapshot.tenantId,
      callId: snapshot.callId,
      revision: snapshot.revision,
      services: [...snapshot.services].sort(),
      currentSubject: snapshot.currentSubject,
      cells,
      followUps: snapshot.followUps,
      followUpGroups: snapshot.followUpGroups,
      catalogOverflow: snapshot.catalogOverflow,
    }),
  );
}
function scalarValues(value: unknown): string[] {
  if (typeof value === "string") {
    if (value === "non_negotiable") return ["não negociável"];
    if (value === "owner_review") return ["revisão do dono"];
    return value.trim() ? [value.trim()] : [];
  }
  if (typeof value === "number" && Number.isFinite(value))
    return [String(value)];
  if (typeof value === "boolean") return [value ? "sim" : "não"];
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === "object")
    return Object.values(value as Record<string, unknown>).flatMap(
      scalarValues,
    );
  return [];
}
function valueFor(
  snapshot: CoverageSnapshot,
  field: CoverageField,
  subject?: string,
): string | undefined {
  const cell = snapshot.cells[keyFor(field, subject)];
  return cell?.state === "answered"
    ? scalarValues(cell.value).join(", ") || undefined
    : cell?.state === "owner_review_required"
      ? cell.safeRestriction
      : undefined;
}
export function buildSummaryAnchors(snapshot: CoverageSnapshot): string[] {
  const anchors: string[] = [];
  for (const subject of snapshot.services) {
    const name =
      valueFor(snapshot, "service.name_synonyms", subject) ??
      subject.replace(/_/g, " ");
    const price = valueFor(snapshot, "service.price_target", subject);
    const negotiation = snapshot.cells[keyFor("service.negotiation", subject)];
    const duration = valueFor(snapshot, "service.duration", subject);
    anchors.push(`Serviço: ${name}`);
    if (price) anchors.push(`Preço público: ${price}`);
    if (negotiation?.state === "answered") {
      const value = negotiation.value as { mode?: unknown; floor?: unknown };
      if (
        value &&
        typeof value === "object" &&
        value.mode === "non_negotiable" &&
        typeof value.floor === "number"
      )
        anchors.push(`Mínimo: não negociável (${value.floor})`);
      else if (
        value &&
        typeof value === "object" &&
        value.mode === "negotiable" &&
        typeof value.floor === "number"
      )
        anchors.push(`Mínimo: ${value.floor}`);
      else if (
        value &&
        typeof value === "object" &&
        value.mode === "non_negotiable"
      )
        anchors.push("Mínimo: não negociável");
    }
    if (duration) anchors.push(`Duração: ${duration} minutos`);
  }
  const area = valueFor(snapshot, "area.coverage");
  const schedule = valueFor(snapshot, "schedule.business_hours");
  const safety = valueFor(snapshot, "emergency.safety_escalation");
  const fees =
    valueFor(snapshot, "emergency.fee_authority") ??
    valueFor(snapshot, "authority.charge_fee");
  const authority = valueFor(snapshot, "authority.book");
  if (area) anchors.push(`Área: ${area}`);
  if (schedule) anchors.push(`Horário: ${schedule}`);
  if (safety) anchors.push(`Segurança: ${safety}`);
  if (fees) anchors.push(`Taxas: ${fees}`);
  if (authority) anchors.push(`Autonomia: ${authority}`);
  return anchors;
}
