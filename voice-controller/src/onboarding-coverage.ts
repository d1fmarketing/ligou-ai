export type CoverageField =
  | "business.customer_types" | "business.excluded_work" | "business.languages_tone"
  | "area.coverage" | "area.out_of_area_policy" | "area.travel_fee"
  | "schedule.business_hours" | "schedule.same_day_lead_time" | "schedule.capacity_buffer" | "schedule.reschedule_cancel" | "schedule.holidays"
  | "emergency.types" | "emergency.safety_escalation" | "emergency.after_hours" | "emergency.fee_authority"
  | "policy.payment_estimate" | "policy.warranty_materials" | "policy.access_cancellation" | "policy.complaints_returns"
  | "authority.quote_price" | "authority.negotiate_floor" | "authority.read_calendar" | "authority.book" | "authority.reschedule_cancel" | "authority.charge_fee" | "authority.emergency" | "authority.out_of_area"
  | "service.catalog_closure" | "service.name_synonyms" | "service.price_mode" | "service.price_target" | "service.negotiation" | "service.duration" | "service.inclusions_exclusions" | "service.materials_parts" | "service.warranty" | "service.emergency_eligibility" | "service.escalation";

export type CoverageDisposition = "answered" | "not_applicable" | "owner_review_required";

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
  | { state: "owner_review_required"; attempts: number; safeRestriction: string };

export interface CoverageSnapshot {
  tenantId: string;
  callId: string;
  revision: number;
  services: string[];
  cells: Record<string, CoverageCell>;
  followUps: number;
  summaryInvalidated: boolean;
}

export interface CoverageRef { field: CoverageField; subject?: string }
export interface CoverageQuestion extends CoverageRef { questionPt: string }
export interface CoverageProgress {
  readyForReview: boolean;
  missingRequired: CoverageRef[];
  ambiguous: CoverageRef[];
  answered: CoverageRef[];
  ownerReviewRequired: CoverageRef[];
  notApplicable: CoverageRef[];
  nextQuestion: CoverageQuestion | null;
  summaryInvalidated: boolean;
}

const universalFields: CoverageField[] = [
  "business.customer_types", "business.excluded_work", "business.languages_tone",
  "area.coverage", "area.out_of_area_policy", "area.travel_fee",
  "schedule.business_hours", "schedule.same_day_lead_time", "schedule.capacity_buffer", "schedule.reschedule_cancel", "schedule.holidays",
  "emergency.types", "emergency.safety_escalation", "emergency.after_hours", "emergency.fee_authority",
  "policy.payment_estimate", "policy.warranty_materials", "policy.access_cancellation", "policy.complaints_returns",
  "authority.quote_price", "authority.negotiate_floor", "authority.read_calendar", "authority.book", "authority.reschedule_cancel", "authority.charge_fee", "authority.emergency", "authority.out_of_area",
];

const serviceFields: CoverageField[] = [
  "service.name_synonyms", "service.price_mode", "service.price_target", "service.negotiation", "service.duration",
  "service.inclusions_exclusions", "service.materials_parts", "service.warranty", "service.emergency_eligibility", "service.escalation",
];

const templates: Record<CoverageField, string> = {
  "service.catalog_closure": "Há mais algum serviço que devemos cadastrar antes de encerrar o catálogo?",
  "business.customer_types": "Quais tipos de clientes vocês atendem?",
  "business.excluded_work": "Que tipos de trabalho vocês não realizam?",
  "business.languages_tone": "Como a equipe deve se apresentar e em quais idiomas?",
  "area.coverage": "Quais cidades, regiões ou CEPs vocês atendem?",
  "area.out_of_area_policy": "Como devemos tratar pedidos fora da área atendida?",
  "area.travel_fee": "Existe taxa de deslocamento fora da área normal?",
  "schedule.business_hours": "Quais são os horários de atendimento, inclusive domingo?",
  "schedule.same_day_lead_time": "Qual é a regra para atendimento no mesmo dia e antecedência mínima?",
  "schedule.capacity_buffer": "Qual margem de capacidade ou intervalo devemos respeitar?",
  "schedule.reschedule_cancel": "Qual é a política de remarcação, cancelamento e ausência?",
  "schedule.holidays": "Como devemos agir em feriados?",
  "emergency.types": "Quais situações contam como emergência?",
  "emergency.safety_escalation": "Quais instruções de segurança e escalonamento devemos dar?",
  "emergency.after_hours": "Quais emergências podem ser tratadas fora do horário?",
  "emergency.fee_authority": "Quem pode confirmar taxa de emergência ou visita?",
  "policy.payment_estimate": "Quais pagamentos, depósitos e limites de orçamento são aceitos?",
  "policy.warranty_materials": "Qual é a política de garantia e materiais do cliente?",
  "policy.access_cancellation": "Como tratamos acesso impossível, visita e cancelamento?",
  "policy.complaints_returns": "Como devemos encaminhar reclamações, retornos ou retrabalho?",
  "authority.quote_price": "Quando a Ligou pode informar preço?",
  "authority.negotiate_floor": "Quando a Ligou pode negociar e qual é o limite?",
  "authority.read_calendar": "A Ligou pode consultar a agenda?",
  "authority.book": "A Ligou pode agendar serviços?",
  "authority.reschedule_cancel": "A Ligou pode remarcar ou cancelar?",
  "authority.charge_fee": "A Ligou pode confirmar ou cobrar taxas?",
  "authority.emergency": "Que autonomia a Ligou tem em emergências?",
  "authority.out_of_area": "Que autonomia a Ligou tem fora da área atendida?",
  "service.name_synonyms": "Quais nomes os clientes usam para este serviço?",
  "service.price_mode": "O preço deste serviço é fixo, a partir de, estimativa ou exige revisão do dono?",
  "service.price_target": "Qual é o preço público deste serviço?",
  "service.negotiation": "Este preço é negociável? Se sim, qual é o mínimo?",
  "service.duration": "Qual é a duração típica deste serviço?",
  "service.inclusions_exclusions": "O que este serviço inclui e exclui?",
  "service.materials_parts": "Como tratamos materiais e peças neste serviço?",
  "service.warranty": "Qual garantia vale para este serviço?",
  "service.emergency_eligibility": "Este serviço pode ser tratado como emergência?",
  "service.escalation": "Em que situação este serviço exige aprovação do dono?",
};

const isServiceField = (field: CoverageField) => field.startsWith("service.") && field !== "service.catalog_closure";
const keyFor = (field: CoverageField, subject?: string) => subject && isServiceField(field) ? `service:${subject}:${field}` : field;
const subjectFromKey = (key: string): string | undefined => key.startsWith("service:") ? key.split(":")[1] : undefined;
const fieldFromKey = (key: string): CoverageField => (key.startsWith("service:") ? key.slice(key.lastIndexOf(":") + 1) : key) as CoverageField;
const normalizedSubject = (subject: string) => subject.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const missing = (attempts = 0): CoverageCell => ({ state: "missing", attempts });
const covered = (cell: CoverageCell) => cell.state === "answered" || cell.state === "not_applicable" || cell.state === "owner_review_required";

export function createCoverage({ tenantId, callId }: { tenantId: string; callId: string }): CoverageSnapshot {
  return { tenantId, callId, revision: 0, services: [], cells: {}, followUps: 0, summaryInvalidated: false };
}

function validAnswer(field: CoverageField, value: unknown, snapshot: CoverageSnapshot, subject?: string): string | null {
  if (field === "service.catalog_closure") return value === true ? null : "catalog_closure_must_be_explicit";
  if (field === "service.price_target") return typeof value === "number" && Number.isFinite(value) && value >= 0 ? null : "price_target_must_be_nonnegative_number";
  if (field === "service.duration") return typeof value === "number" && Number.isFinite(value) && value > 0 ? null : "duration_must_be_positive_number";
  if (field === "service.price_mode") return ["fixed", "starting_at", "estimate", "owner_review"].includes(String(value)) ? null : "invalid_price_mode";
  if (field === "service.negotiation") {
    if (["non_negotiable", "owner_review"].includes(String(value))) return null;
    const floor = typeof value === "number" ? value : value && typeof value === "object" ? (value as { floor?: unknown }).floor : undefined;
    const target = subject ? snapshot.cells[keyFor("service.price_target", subject)] : undefined;
    const publicPrice = target?.state === "answered" ? target.value : undefined;
    return typeof floor === "number" && Number.isFinite(floor) && typeof publicPrice === "number" && floor >= 0 && floor <= publicPrice
      ? null : "negotiation_floor_requires_public_price";
  }
  if (field === "service.emergency_eligibility") return typeof value === "boolean" ? null : "emergency_eligibility_must_be_boolean";
  if (["business.customer_types", "area.coverage", "emergency.types", "service.name_synonyms"].includes(field)) return Array.isArray(value) && value.length > 0 ? null : "must_be_nonempty_list";
  return typeof value === "string" && value.trim().length > 0 ? null : "must_be_nonempty";
}

function applyOne(snapshot: CoverageSnapshot, fact: CoverageFact): CoverageSnapshot {
  const subject = fact.subject && isServiceField(fact.field) ? normalizedSubject(fact.subject) : undefined;
  if (isServiceField(fact.field) && !subject) return snapshot;
  const cells = { ...snapshot.cells };
  const services = [...snapshot.services];
  if (subject && !services.includes(subject)) {
    if (services.length >= 20) {
      cells["service.catalog_closure"] = { state: "owner_review_required", attempts: (cells["service.catalog_closure"]?.attempts ?? 0) + 1, safeRestriction: "catalog_over_twenty_services_requires_owner_review" };
      return { ...snapshot, cells, revision: snapshot.revision + 1, summaryInvalidated: true };
    }
    services.push(subject);
    cells["service.catalog_closure"] = missing(cells["service.catalog_closure"]?.attempts ?? 0);
  }
  const key = keyFor(fact.field, subject);
  const prior = cells[key] ?? missing();
  const attempts = prior.attempts + 1;
  const disposition = fact.disposition as string;
  if (disposition === "owner_review_required") {
    cells[key] = { state: "owner_review_required", attempts, safeRestriction: "requires_owner_review_no_autonomy" };
  } else if (disposition === "not_applicable") {
    cells[key] = { state: "not_applicable", attempts };
  } else if (disposition !== "answered") {
    cells[key] = missing(attempts);
  } else {
    const error = validAnswer(fact.field, fact.value, { ...snapshot, cells }, subject);
    cells[key] = error
      ? fact.field === "service.catalog_closure" ? missing(attempts) : { state: "ambiguous", attempts, reason: error }
      : { state: "answered", attempts, value: fact.value };
  }
  const nextCell = cells[key];
  return {
    ...snapshot,
    services: services.sort(),
    cells,
    revision: snapshot.revision + 1,
    followUps: snapshot.followUps + (nextCell.state === "ambiguous" || nextCell.state === "missing" ? 1 : 0),
    summaryInvalidated: snapshot.revision > 0 || snapshot.summaryInvalidated,
  };
}

export function applyCoverageFact(snapshot: CoverageSnapshot, fact: CoverageFact): CoverageSnapshot {
  const bundled = fact.value && typeof fact.value === "object" && "fields" in fact.value
    ? (fact.value as { fields?: Record<string, unknown> }).fields : undefined;
  if (!bundled) return applyOne(snapshot, fact);
  const applied = Object.entries(bundled).reduce((next, [field, value]) => applyOne(next, { ...fact, field: field as CoverageField, value }), snapshot);
  return { ...applied, revision: snapshot.revision + 1, summaryInvalidated: snapshot.revision > 0 || snapshot.summaryInvalidated };
}

function allRequired(snapshot: CoverageSnapshot): CoverageRef[] {
  const fields: CoverageRef[] = [{ field: "service.catalog_closure" }, ...universalFields.map((field) => ({ field }))];
  for (const subject of [...snapshot.services].sort()) {
    const mode = snapshot.cells[keyFor("service.price_mode", subject)];
    for (const field of serviceFields) {
      if (field === "service.price_target" && mode?.state === "answered" && mode.value === "owner_review") continue;
      fields.push({ field, subject });
    }
  }
  return fields;
}

function refForKey(key: string): CoverageRef {
  const subject = subjectFromKey(key);
  return subject ? { field: fieldFromKey(key), subject } : { field: fieldFromKey(key) };
}

function questionFor(ref: CoverageRef): CoverageQuestion {
  const base = templates[ref.field];
  return { ...ref, questionPt: ref.subject ? `${base} (${ref.subject.replace(/_/g, " ")})` : base };
}

export function evaluateCoverage(snapshot: CoverageSnapshot): CoverageProgress {
  const required = allRequired(snapshot);
  const missingRequired = required.filter((ref) => (snapshot.cells[keyFor(ref.field, ref.subject)] ?? missing()).state === "missing");
  const ambiguous = required.filter((ref) => (snapshot.cells[keyFor(ref.field, ref.subject)] ?? missing()).state === "ambiguous");
  const answered = Object.entries(snapshot.cells).filter(([, cell]) => cell.state === "answered").map(([key]) => refForKey(key));
  const ownerReviewRequired = Object.entries(snapshot.cells).filter(([, cell]) => cell.state === "owner_review_required").map(([key]) => refForKey(key));
  const notApplicable = Object.entries(snapshot.cells).filter(([, cell]) => cell.state === "not_applicable").map(([key]) => refForKey(key));
  const unresolved = [...ambiguous, ...missingRequired];
  const candidate = snapshot.followUps >= 12 ? undefined : unresolved.find((ref) => (snapshot.cells[keyFor(ref.field, ref.subject)] ?? missing()).attempts < 2);
  return {
    readyForReview: missingRequired.length === 0 && ambiguous.length === 0,
    missingRequired,
    ambiguous,
    answered,
    ownerReviewRequired,
    notApplicable,
    nextQuestion: candidate ? questionFor(candidate) : null,
    summaryInvalidated: snapshot.summaryInvalidated,
  };
}

export function canonicalCoverage(snapshot: CoverageSnapshot): string {
  const cells = Object.fromEntries(Object.entries(snapshot.cells).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({ tenantId: snapshot.tenantId, callId: snapshot.callId, revision: snapshot.revision, services: [...snapshot.services].sort(), cells, followUps: snapshot.followUps });
}

export function buildSummaryAnchors(snapshot: CoverageSnapshot): string[] {
  return allRequired(snapshot)
    .filter((ref) => covered(snapshot.cells[keyFor(ref.field, ref.subject)] ?? missing()))
    .map((ref) => ref.subject ? `service:${ref.subject}:${ref.field}` : ref.field)
    .sort();
}
