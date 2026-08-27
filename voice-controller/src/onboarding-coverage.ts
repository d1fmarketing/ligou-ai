import { createHash } from "node:crypto";

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
  localityResolution?: LocalityResolution;
}
export interface LocalityInput {
  display_name: string;
  country_code: string;
  region_code: string;
}
export interface CanonicalLocality extends LocalityInput {
  locality_id: string;
}
export interface LocalityRegistryEntry extends CanonicalLocality {
  aliases: string[];
}
export type LocalityResolution =
  | { state: "resolved"; value: { localities: CanonicalLocality[] } }
  | {
      state: "ambiguous";
      reason: "locality_region_owner_evidence_required";
      value: { localities: CanonicalLocality[] };
      candidates: CanonicalLocality[];
      questionPt: string;
    }
  | { state: "unknown"; unknown: string[] };
export interface LocalityResolutionContext {
  ownerWords: string;
  priorCell?: CoverageCell;
  directedFollowUpQuestionPt?: string;
}
export type CoverageCell =
  | { state: "missing"; attempts: number }
  | { state: "answered"; attempts: number; value: unknown }
  | {
      state: "ambiguous";
      attempts: number;
      reason: string;
      value?: { localities: CanonicalLocality[] };
      candidates?: CanonicalLocality[];
      questionPt?: string;
    }
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

export const INITIAL_SERVICE_DISCOVERY_QUESTION_PT =
  "Quais serviços sua empresa oferece?";

// Twenty services produce at most 228 active refs. Allowing every ref one
// directed question plus 28 clarifications yields 256 question receipts; with
// 228 answer receipts, the 484-row history remains below the 512-row scan cap.
export const MAX_DIRECTED_FOLLOW_UPS = 256;

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
  "area.coverage":
    "Quais nomes exatos de cidades vocês atendem? Informe somente cidades, sem regiões, condados ou CEPs.",
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
export function isCoverageField(value: unknown): value is CoverageField {
  return typeof value === "string" && inputFields.has(value);
}
export const isServiceCoverageField = (field: CoverageField) =>
  field.startsWith("service.") && field !== "service.catalog_closure";
export const normalizeCoverageSubject = (subject: string) =>
  subject
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
export function coverageKey(field: CoverageField, subject?: string): string {
  if (isServiceCoverageField(field)) {
    const normalized = typeof subject === "string"
      ? normalizeCoverageSubject(subject)
      : "";
    if (!normalized) throw new Error("coverage_subject_required");
    return `service:${normalized}:${field}`;
  }
  if (subject !== undefined) throw new Error("coverage_subject_forbidden");
  return field;
}
const keyFor = coverageKey;
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
    const noQuoteInputs =
      mode?.state === "owner_review_required" ||
      (
        mode?.state === "answered" &&
        (mode.value === "owner_review" || mode.value === "estimate")
      );
    for (const field of serviceFields)
      if (
        !noQuoteInputs ||
        !["service.price_target", "service.negotiation"].includes(field)
      )
        required.push({ field, subject });
    if (!noQuoteInputs)
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
const EXECUTABLE_WEEKDAYS = new Set([
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
]);

function wholeHour(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^([01][0-9]|2[0-3]):00$/.exec(value);
  return match ? Number(match[1]) : null;
}

export function isExecutableBusinessHours(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hours = value as { days?: unknown; hours?: unknown };
  if (
    Object.keys(hours).sort().join(",") !== "days,hours" ||
    !hours.hours || typeof hours.hours !== "object" ||
    Array.isArray(hours.hours) ||
    Object.keys(hours.hours).sort().join(",") !== "closes,opens"
  ) return false;
  if (
    !nonEmptyStrings(hours.days) ||
    hours.days.some((day) => !EXECUTABLE_WEEKDAYS.has(day)) ||
    new Set(hours.days).size !== hours.days.length
  ) return false;
  const window = hours.hours as { opens?: unknown; closes?: unknown };
  const opens = wholeHour(window.opens);
  const closes = wholeHour(window.closes);
  return opens !== null && closes !== null && opens < closes;
}

const US_STATE_NAMES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
  "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york",
  "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota",
  "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming",
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi",
  "id", "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi",
  "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc",
  "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut",
  "vt", "va", "wa", "wv", "wi", "wy",
]);
const COUNTRY_NAMES = new Set([
  "unitedstates", "unitedstatesofamerica", "usa", "us", "america", "canada",
]);
const US_REGION_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI",
  "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT",
  "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);
const NON_CITY_FORM = /(?:^|[^\p{L}\p{M}])(?:county|condado|region|regiao|região|province|provincia|província|metropolitan|metro|area|área|zip|cep|postal)(?:$|[^\p{L}\p{M}])/iu;
const DIRECTIONAL_STATE_FORM = /^(?:north(?:ern)?|south(?:ern)?|east(?:ern)?|west(?:ern)?|central)\s+(.+)$/u;
export function isExactCityName(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const canonical = value.toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  const compactCountry = canonical.replace(/[^\p{L}\p{M}]/gu, "");
  const directionalState = DIRECTIONAL_STATE_FORM.exec(canonical)?.[1];
  const prefixedState = /^(?:state of|estado de) (.+)$/u.exec(canonical)?.[1];
  const suffixedState = /^(.+) (?:state|estado)$/u.exec(canonical)?.[1];
  if (
    value.length < 1 || value.length > 100 || /\d/.test(value) ||
    NON_CITY_FORM.test(value) || US_STATE_NAMES.has(canonical) ||
    COUNTRY_NAMES.has(compactCountry) || canonical === "state" ||
    canonical === "estado" ||
    (directionalState !== undefined && US_STATE_NAMES.has(directionalState)) ||
    (prefixedState !== undefined && US_STATE_NAMES.has(prefixedState)) ||
    (suffixedState !== undefined && US_STATE_NAMES.has(suffixedState))
  )
    return false;
  return /^[\p{L}\p{M}][\p{L}\p{M}.' -]*$/u.test(value);
}
export function isExactCityList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1) return false;
  if (!value.every(isExactCityName)) return false;
  const canonical = value.map((city) => city.toLocaleLowerCase("en-US"));
  return new Set(canonical).size === canonical.length;
}
export function isDeclaredCitiesValue(
  value: unknown,
): value is { cities: string[] } {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, "cities") &&
    isExactCityList((value as { cities?: unknown }).cities),
  );
}
function localityDisplayKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
function localityId(input: LocalityInput): string {
  return `loc_${createHash("sha256").update(
    `${input.country_code}:${input.region_code}:${localityDisplayKey(input.display_name)}`,
    "utf8",
  ).digest("hex").slice(0, 24)}`;
}
export function canonicalizeLocalityInput(
  value: unknown,
): CanonicalLocality | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !==
      "country_code,display_name,region_code" ||
    typeof row.display_name !== "string" ||
    typeof row.country_code !== "string" ||
    typeof row.region_code !== "string" ||
    row.display_name !== row.display_name.trim() ||
    row.country_code !== row.country_code.trim() ||
    row.region_code !== row.region_code.trim() ||
    row.country_code !== "US" ||
    !US_REGION_CODES.has(row.region_code) ||
    US_REGION_CODES.has(row.display_name.toUpperCase())
  ) return null;
  const collisionAllowed =
    (row.display_name === "New York" && row.region_code === "NY") ||
    (row.display_name === "Washington" && row.region_code === "DC");
  if (!collisionAllowed && !isExactCityName(row.display_name)) return null;
  const input: LocalityInput = {
    display_name: row.display_name,
    country_code: row.country_code,
    region_code: row.region_code,
  };
  return { ...input, locality_id: localityId(input) };
}
export function canonicalizeLocalityValue(
  value: unknown,
): { localities: CanonicalLocality[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(row, "localities") ||
    !Array.isArray(row.localities) ||
    row.localities.length === 0
  ) return null;
  return isCanonicalLocalityList(row.localities)
    ? { localities: row.localities }
    : null;
}

function normalizedLocalityLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function normalizedOwnerEvidence(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function ownerEvidenceContains(ownerEvidence: string, value: string): boolean {
  const candidate = normalizedOwnerEvidence(value);
  return candidate.length > 0 &&
    ` ${ownerEvidence} `.includes(` ${candidate} `);
}

const REGION_OWNER_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  CA: ["CA", "California", "Califórnia"],
  NH: ["NH", "New Hampshire"],
};

function canonicalRegistryLocality(
  entry: LocalityRegistryEntry,
): CanonicalLocality {
  return {
    locality_id: entry.locality_id,
    display_name: entry.display_name,
    country_code: entry.country_code,
    region_code: entry.region_code,
  };
}

function compareCanonicalLocalities(
  left: CanonicalLocality,
  right: CanonicalLocality,
): number {
  return left.display_name.localeCompare(right.display_name, "en-US") ||
    left.region_code.localeCompare(right.region_code, "en-US") ||
    left.country_code.localeCompare(right.country_code, "en-US") ||
    left.locality_id.localeCompare(right.locality_id, "en-US");
}

function regionMatchesOwnerEvidence(
  ownerEvidence: string,
  locality: CanonicalLocality,
): boolean {
  return (REGION_OWNER_EVIDENCE[locality.region_code] ?? []).some(
    (evidence) => ownerEvidenceContains(ownerEvidence, evidence),
  );
}

function localityQuestion(candidates: CanonicalLocality[]): string {
  const labels = candidates.map((candidate) =>
    `${candidate.display_name}, ${candidate.region_code}, ${candidate.country_code}`
  );
  const choices = labels.length === 2
    ? `${labels[0]} ou ${labels[1]}`
    : `${labels.slice(0, -1).join(", ")} ou ${labels.at(-1)}`;
  return `Você quer dizer ${choices}?`;
}

function priorLocalityAmbiguity(
  cell: CoverageCell | undefined,
): Extract<LocalityResolution, { state: "ambiguous" }> | null {
  if (
    !cell || cell.state !== "ambiguous" ||
    cell.reason !== "locality_region_owner_evidence_required" ||
    !Array.isArray(cell.candidates) ||
    !cell.candidates.every((candidate) =>
      isCanonicalLocalityList([candidate])
    ) ||
    typeof cell.questionPt !== "string" || !cell.questionPt ||
    !cell.value || typeof cell.value !== "object" ||
    !Array.isArray(cell.value.localities) ||
    !cell.value.localities.every((locality) =>
      isCanonicalLocalityList([locality])
    )
  ) return null;
  return {
    state: "ambiguous",
    reason: "locality_region_owner_evidence_required",
    value: { localities: [...cell.value.localities] },
    candidates: [...cell.candidates],
    questionPt: cell.questionPt,
  };
}

export function resolveLocalityValueFromRegistry(
  value: unknown,
  registry: LocalityRegistryEntry[],
  context: LocalityResolutionContext = { ownerWords: "" },
): LocalityResolution {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { state: "unknown", unknown: [] };
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 1 ||
    !Array.isArray(row.localities) || row.localities.length === 0
  ) return { state: "unknown", unknown: [] };
  const proposed: Array<{ display_name: string }> = [];
  for (const candidate of row.localities) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return { state: "unknown", unknown: [] };
    const input = candidate as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(",") !==
        "country_code,display_name,region_code" ||
      typeof input.display_name !== "string" ||
      typeof input.country_code !== "string" ||
      typeof input.region_code !== "string" ||
      !normalizedLocalityLabel(input.display_name)
    ) return { state: "unknown", unknown: [] };
    proposed.push({ display_name: input.display_name });
  }

  const ownerEvidence = normalizedOwnerEvidence(context.ownerWords);
  const prior = priorLocalityAmbiguity(context.priorCell);
  if (prior) {
    const proposedLabels = new Set(
      proposed.map(({ display_name }) => normalizedLocalityLabel(display_name)),
    );
    const samePendingLocality = prior.candidates.some((candidate) =>
      proposedLabels.has(normalizedLocalityLabel(candidate.display_name))
    );
    if (!samePendingLocality)
      return {
        state: "unknown",
        unknown: proposed.map(({ display_name }) => display_name).sort(),
      };
    if (context.directedFollowUpQuestionPt !== prior.questionPt) return prior;
    const selected = prior.candidates.filter((candidate) =>
      regionMatchesOwnerEvidence(ownerEvidence, candidate)
    );
    if (selected.length !== 1) return prior;
    return {
      state: "resolved",
      value: {
        localities: [...prior.value.localities, selected[0]!]
          .sort(compareCanonicalLocalities),
      },
    };
  }

  const resolved: CanonicalLocality[] = [];
  const unknown: string[] = [];
  let ambiguity: CanonicalLocality[] | null = null;
  for (const input of proposed) {
    const label = normalizedLocalityLabel(input.display_name);
    if (!ownerEvidenceContains(ownerEvidence, input.display_name)) {
      unknown.push(input.display_name.trim());
      continue;
    }
    const matches = registry.filter((entry) =>
      [entry.display_name, ...entry.aliases].some(
        (alias) => normalizedLocalityLabel(alias) === label,
      )
    ).map(canonicalRegistryLocality).sort(compareCanonicalLocalities);
    if (matches.length === 0) {
      unknown.push(input.display_name.trim());
      continue;
    }
    if (matches.length === 1) {
      resolved.push(matches[0]!);
      continue;
    }
    const selected = matches.filter((candidate) =>
      regionMatchesOwnerEvidence(ownerEvidence, candidate)
    );
    if (selected.length === 1) resolved.push(selected[0]!);
    else if (!ambiguity) ambiguity = matches;
  }
  if (unknown.length > 0)
    return { state: "unknown", unknown: [...new Set(unknown)].sort() };
  const uniqueResolved = [...new Map(
    resolved.map((locality) => [locality.locality_id, locality]),
  ).values()].sort(compareCanonicalLocalities);
  if (uniqueResolved.length !== resolved.length)
    return { state: "unknown", unknown: [] };
  if (ambiguity)
    return {
      state: "ambiguous",
      reason: "locality_region_owner_evidence_required",
      value: { localities: uniqueResolved },
      candidates: ambiguity,
      questionPt: localityQuestion(ambiguity),
    };
  return { state: "resolved", value: { localities: uniqueResolved } };
}
export function isCanonicalLocalityList(
  value: unknown,
): value is CanonicalLocality[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return false;
    const row = candidate as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !==
        "country_code,display_name,locality_id,region_code"
    ) return false;
    const canonical = canonicalizeLocalityInput({
      display_name: row.display_name,
      country_code: row.country_code,
      region_code: row.region_code,
    });
    if (!canonical || row.locality_id !== canonical.locality_id || seen.has(canonical.locality_id))
      return false;
    seen.add(canonical.locality_id);
  }
  return true;
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
    const target = subject
      ? snapshot.cells[keyFor("service.price_target", subject)]
      : undefined;
    const price = target?.state === "answered" ? target.value : undefined;
    if (value === "non_negotiable")
      return typeof price === "number" && Number.isFinite(price) && price >= 0
        ? null
        : "non_negotiable_requires_public_target";
    const floor =
      value && typeof value === "object" && !Array.isArray(value) &&
            Object.keys(value).length === 1 &&
            Object.prototype.hasOwnProperty.call(value, "floor")
        ? (value as { floor?: unknown }).floor
        : undefined;
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
    return isExecutableBusinessHours(value) ? null : "must_be_business_hours";
  if (field === "business.customer_types")
    return nonEmptyStrings(value) &&
      value.every((item) => customerTypes.has(item.trim().toLowerCase()))
      ? null
      : "must_be_known_customer_types";
  if (field === "area.coverage")
    return canonicalizeLocalityValue(value)
      ? null
      : "must_be_declared_localities";
  if (["emergency.types", "service.name_synonyms"].includes(field))
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
  let subject: string | undefined;
  try {
    coverageKey(fact.field, fact.subject);
    subject = isServiceCoverageField(fact.field)
      ? normalizeCoverageSubject(fact.subject!)
      : undefined;
  } catch {
    return snapshot;
  }
  const previouslyReady = ready(snapshot);
  const cells = { ...snapshot.cells };
  const services = [...snapshot.services];
  if (subject && !services.includes(subject)) {
    if (services.length >= 20) {
      const overflowServices = snapshot.catalogOverflow?.services ?? [];
      return {
        ...snapshot,
        catalogOverflow: {
          services: overflowServices.includes(subject)
            ? [...overflowServices]
            : [...overflowServices, subject],
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
  if (fact.field === "area.coverage" && fact.localityResolution?.state === "resolved")
    cell = {
      state: "answered",
      attempts,
      value: fact.localityResolution.value,
    };
  else if (
    fact.field === "area.coverage" &&
    fact.localityResolution?.state === "ambiguous"
  )
    cell = {
      state: "ambiguous",
      attempts,
      reason: fact.localityResolution.reason,
      value: fact.localityResolution.value,
      candidates: fact.localityResolution.candidates,
      questionPt: fact.localityResolution.questionPt,
    };
  else if (
    fact.field === "area.coverage" &&
    fact.localityResolution?.state === "unknown"
  )
    cell = fact.ownerWords.trim().length > 0
      ? {
          state: "owner_review_required",
          attempts,
          safeRestriction: safeRestrictionFor(fact.field),
        }
      : missing(attempts);
  else if (fact.disposition === "owner_review_required")
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
  else if (
    fact.field === "service.negotiation" &&
    fact.value === "non_negotiable" &&
    fact.ownerWords.trim().length === 0
  )
    cell = {
      state: "ambiguous",
      attempts,
      reason: "non_negotiable_requires_owner_words",
    };
  else {
    const error = validAnswer(
      fact.field,
      fact.value,
      { ...snapshot, cells },
      subject,
    );
    const publicTarget = subject
      ? cells[keyFor("service.price_target", subject)]
      : undefined;
    const publicPrice = publicTarget?.state === "answered"
      ? publicTarget.value
      : undefined;
    const storedValue = fact.field === "area.coverage" && error === null
      ? canonicalizeLocalityValue(fact.value)
      : fact.field === "service.negotiation" && error === null
        ? fact.value === "non_negotiable" && typeof publicPrice === "number"
          ? { mode: "non_negotiable", floor: publicPrice }
          : typeof fact.value === "string"
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
  if (fact.field === "service.price_target" && subject) {
    const negotiationKey = keyFor("service.negotiation", subject);
    const negotiation = cells[negotiationKey];
    if (negotiation?.state === "answered" && negotiation.value &&
        typeof negotiation.value === "object") {
      const value = negotiation.value as { mode?: unknown; floor?: unknown };
      if (value.mode === "non_negotiable")
        cells[negotiationKey] = cell.state === "answered" &&
            typeof cell.value === "number"
          ? {
              ...negotiation,
              value: { mode: "non_negotiable", floor: cell.value },
            }
          : {
              state: "ambiguous",
              attempts: negotiation.attempts,
              reason: "non_negotiable_requires_public_target",
            };
      else if (
        value.mode === "negotiable" &&
        (
          cell.state !== "answered" || typeof cell.value !== "number" ||
          typeof value.floor !== "number" || value.floor > cell.value
        )
      )
        cells[negotiationKey] = {
          state: "ambiguous",
          attempts: negotiation.attempts,
          reason: "negotiation_floor_requires_public_price",
        };
    }
  }
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
function questionFor(
  ref: CoverageRef,
  snapshot: CoverageSnapshot,
): CoverageQuestion {
  return {
    ...ref,
    questionPt:
      ref.field === "area.coverage" &&
          snapshot.cells["area.coverage"]?.state === "ambiguous" &&
          snapshot.cells["area.coverage"].questionPt
        ? snapshot.cells["area.coverage"].questionPt
        : ref.field === "service.catalog_closure" && snapshot.services.length === 0
        ? INITIAL_SERVICE_DISCOVERY_QUESTION_PT
        : ref.subject
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
  const localityAmbiguity = active.required.filter(
    (ref) => ref.field === "area.coverage" && state(ref).state === "ambiguous",
  );
  const catalog = unresolved([{ field: "service.catalog_closure" }]);
  const service = snapshot.services.flatMap((subject) =>
    active.required.filter((ref) => ref.subject === subject),
  );
  const ordered = [
    ...currentAmbiguity,
    ...localityAmbiguity,
    ...catalog,
    ...unresolved(service),
    ...unresolved(safetyAuthorityFields.map((field) => ({ field }))),
    ...unresolved(areaScheduleFields.map((field) => ({ field }))),
    ...unresolved(commercialFields.map((field) => ({ field }))),
    ...unresolved(businessFields.map((field) => ({ field }))),
  ] as CoverageRef[];
  const next =
    snapshot.followUps >= MAX_DIRECTED_FOLLOW_UPS
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
    nextQuestion: next ? questionFor(next, snapshot) : null,
    catalogNormallyComplete: !snapshot.catalogOverflow,
    summaryInvalidated: snapshot.summaryInvalidated,
  };
}
export function recordDirectedFollowUp(
  snapshot: CoverageSnapshot,
  ref: CoverageRef,
): CoverageSnapshot {
  const key = keyFor(ref.field, ref.subject);
  if (
    snapshot.followUps >= MAX_DIRECTED_FOLLOW_UPS ||
    (snapshot.followUpGroups[key] ?? 0) >= 2
  )
    return snapshot;
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
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
function scalarKeyOrder(key: string): number {
  const normalized = key.toLowerCase();
  if (["day", "days", "weekdays"].includes(normalized)) return 0;
  if (
    ["open", "opens", "opening", "start", "starts"].includes(normalized)
  )
    return 1;
  if (
    ["close", "closes", "closing", "end", "ends"].includes(normalized)
  )
    return 2;
  return 3;
}
function compareScalarKeys(left: string, right: string): number {
  const byMeaning = scalarKeyOrder(left) - scalarKeyOrder(right);
  if (byMeaning !== 0) return byMeaning;
  return left < right ? -1 : left > right ? 1 : 0;
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
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareScalarKeys(left, right))
      .flatMap(([, nested]) => scalarValues(nested));
  return [];
}
function valueFor(
  snapshot: CoverageSnapshot,
  field: CoverageField,
  subject?: string,
): string | undefined {
  const cell = snapshot.cells[keyFor(field, subject)];
  if (
    field === "area.coverage" && cell?.state === "answered" &&
    cell.value && typeof cell.value === "object" &&
    isCanonicalLocalityList(
      (cell.value as { localities?: unknown }).localities,
    )
  )
    return (cell.value as { localities: CanonicalLocality[] }).localities
      .map((locality) =>
        `${locality.display_name}, ${locality.region_code}, ${locality.country_code}`
      ).join("; ");
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
    const mode = snapshot.cells[keyFor("service.price_mode", subject)];
    const quoteFieldsActive = !(
      mode?.state === "owner_review_required" ||
      (
        mode?.state === "answered" &&
        (mode.value === "estimate" || mode.value === "owner_review")
      )
    );
    const price = quoteFieldsActive
      ? valueFor(snapshot, "service.price_target", subject)
      : undefined;
    const negotiation = quoteFieldsActive
      ? snapshot.cells[keyFor("service.negotiation", subject)]
      : undefined;
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
    } else if (negotiation?.state === "owner_review_required")
      anchors.push(`Negociação: ${negotiation.safeRestriction}`);
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
