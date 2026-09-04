import { createHash } from "node:crypto";
import { MAX_AGENDA_ITEMS, type AgendaSeed, type AgendaSource } from "./onboarding-agenda.ts";
import { getCompanyDiscoveryUnresolvedItems } from "./company-discovery-prefill.ts";
import { websiteItemsMayShareAnswer } from "./onboarding-website-applicability.ts";
import {
  canonicalCoverage, coverageKey, evaluateCoverage, isCoverageField, isDiscoveryOwnerQuestionField,
  normalizeCoverageSubject, questionFor, type CoverageRef, type CoverageSnapshot,
} from "./onboarding-coverage.ts";

export interface WebsiteAgendaSourceItem {
  readonly unresolvedId: string;
  readonly sourceKind: string;
  readonly sourceIndex: number | null;
  readonly sourceClaimIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly coverageRef: string;
  readonly field: CoverageRef["field"];
  readonly subject?: string;
  readonly questionPt: string;
  readonly seedId: string;
}
export interface WebsiteCoverageObligation {
  readonly coverageRef: string;
  readonly field: string;
  readonly subject?: string;
  readonly initialState: string;
  readonly conditional: boolean;
  readonly blocking: true;
  readonly disposition: "ask" | "website_candidate_recap" | "not_applicable";
  readonly seedId: string | null;
}
export interface WebsiteAgendaRelationHint {
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly requirement: "explicit_owner_applicability" | "explicit_owner_authority";
}
export interface WebsiteAgendaSeedProjection {
  readonly version: 1;
  readonly seeds: readonly AgendaSeed[];
  readonly seedsHash: string;
  readonly provenance: {
    readonly draftId: string;
    readonly draftVersion: number;
    readonly draftHash: string;
    readonly sourceJobId: string;
    readonly sourceAttemptId: string;
    readonly sourceResultId: string;
    readonly sourceResultHash: string;
    readonly tenantId: string;
    readonly callId: string;
    readonly draftInputDigest: string;
    readonly coverageDigest: string;
    readonly authority: { readonly rules_approved: false; readonly powers_granted: false; readonly operational_mode_changed: false };
  };
  readonly sourceItems: readonly WebsiteAgendaSourceItem[];
  readonly coverageObligations: readonly WebsiteCoverageObligation[];
  readonly candidateRecap: readonly Readonly<Record<string, unknown>>[];
  /** Hints describe required evidence, not authority. Even an eligible graph
   * edge requires the unconditional exact-owner-text applicability gate. */
  readonly relationHints: readonly WebsiteAgendaRelationHint[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) frozen(nested);
    Object.freeze(value);
  }
  return value;
}
const words = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const recordValue = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
type MutableSeed = { -readonly [K in keyof AgendaSeed]: K extends "coverageRefs" | "relatedItemIds" ? string[] : AgendaSeed[K] };
const coverageSeedId = (ref: string) => `coverage:${hash(ref)}`;
const privateRef = (ref: string) => ref.startsWith("authority.") || ref.endsWith("service.negotiation") || ref.endsWith("service.escalation") || ref === "emergency.fee_authority";

/** Derive only from the selected, parsed voice draft and its initial coverage.
 * This preserves obligations; it does not turn website claims into authority. */
export function buildWebsiteAgendaSeeds(input: { draftReadback: unknown; initialCoverage: CoverageSnapshot }): WebsiteAgendaSeedProjection {
  const unresolvedItems = getCompanyDiscoveryUnresolvedItems(input.draftReadback);
  // The existing parser above validates the complete canonical draft shape.
  const readback = structuredClone(input.draftReadback) as {
    draft_id: string; draft_version: number; draft_hash: string;
    draft: { schema_version: string; source_job_id: string; source_attempt_id: string; source_result_id: string; source_result_hash: string; candidate_facts: Record<string, unknown>[] };
  };
  if (readback.draft.schema_version !== "company_discovery.onboarding_draft.v2") throw new Error("website_agenda_requires_voice_candidate_draft_v2");
  const snapshot = structuredClone(input.initialCoverage);
  if (!snapshot || typeof snapshot.tenantId !== "string" || !snapshot.tenantId || typeof snapshot.callId !== "string" || !snapshot.callId || !Array.isArray(snapshot.services) || new Set(snapshot.services).size !== snapshot.services.length || snapshot.services.some(subject => typeof subject !== "string" || !subject || normalizeCoverageSubject(subject) !== subject)) throw new Error("website_agenda_invalid_coverage_scope");
  snapshot.services.sort();
  for (const [key, cell] of Object.entries(snapshot.cells)) {
    const field = key.startsWith("service:") ? key.slice(key.lastIndexOf(":") + 1) : key;
    if (!isCoverageField(field) || !cell || !["missing", "ambiguous", "answered", "not_applicable", "owner_review_required"].includes(cell.state) || !Number.isSafeInteger(cell.attempts) || cell.attempts < 0) throw new Error(`website_agenda_invalid_coverage_cell:${key}`);
  }
  const progress = evaluateCoverage(snapshot);
  const activeRefs = progress.requiredFields;
  const conditional = new Set(progress.conditionalFields.map(ref => coverageKey(ref.field, ref.subject)));
  const needed = new Map(activeRefs.filter(ref => !["answered", "not_applicable"].includes(snapshot.cells[coverageKey(ref.field, ref.subject)]?.state ?? "missing")).map(ref => [coverageKey(ref.field, ref.subject), ref]));
  const candidateRecap = readback.draft.candidate_facts;
  const sourceItems: WebsiteAgendaSourceItem[] = [];
  const seeds: MutableSeed[] = [];
  const seedForRef = new Map<string, MutableSeed>();
  const claimedTargets = new Set<string>();

  for (const item of unresolvedItems) {
    if (item.review_status !== "pending_onboarding" || item.coverage_field === null) throw new Error("website_agenda_invalid_initial_source_status");
    let field = item.coverage_field;
    let subject = item.coverage_subject ?? undefined;
    let key = coverageKey(field, subject);
    // Match existing prefill's collision-preserving synthetic target. Never
    // collapse two original questions that happen to claim the same typed ref.
    if (!isDiscoveryOwnerQuestionField(field) && claimedTargets.has(key)) {
      field = `discovery.owner_question.${item.unresolved_id.replaceAll("-", "").toLowerCase()}`;
      subject = undefined;
      key = field;
    } else claimedTargets.add(key);
    const cell = snapshot.cells[key];
    if (!needed.has(key) || cell?.state !== "ambiguous" || cell.questionPt !== item.question_pt) throw new Error(`website_agenda_source_coverage_mismatch:${item.unresolved_id}`);
    // V2's existing parser reserves indices 100+ for explicit owner-private
    // questions, including private questions outside authority.* fields.
    const ownerPrivateSource = item.source_kind === "missing_question" && item.source_index !== null && item.source_index >= 100;
    const source: AgendaSource = ownerPrivateSource || privateRef(key) ? "owner_private_requirement" : item.source_kind === "contradiction" ? "contradiction" : item.source_kind === "uncertainty" ? "ambiguity" : "missing_website_information";
    const seed: MutableSeed = { id: item.unresolved_id, source, subject: subject ?? field, questionPt: item.question_pt, coverageRefs: [key], relatedItemIds: [], blocking: true };
    seeds.push(seed);
    seedForRef.set(key, seed);
    sourceItems.push({ unresolvedId: item.unresolved_id, sourceKind: item.source_kind, sourceIndex: item.source_index, sourceClaimIds: [...item.source_claim_ids], evidenceRefs: [...item.evidence_refs], coverageRef: key, field, ...(subject ? { subject } : {}), questionPt: item.question_pt, seedId: seed.id });
  }

  // Exact global holiday operating policy has the same obligation as the
  // typed holiday field. Do not merge holiday fees or other holiday subjects.
  const holidaySources = sourceItems.filter(item => item.sourceKind === "missing_question" && isDiscoveryOwnerQuestionField(item.field) && /\b(feriados|holidays?)\b/.test(words(item.questionPt)) && /\b(funcionamento|horarios|operating|operation|hours)\b/.test(words(item.questionPt)) && !/\b(taxa|taxas|preco|precos|fee|fees|price|prices|cancelamento|cancellation|booking|agendamento|deposito|deposit|emergencia|emergency|warranty|garantia)\b/.test(words(item.questionPt)));
  if (holidaySources.length === 1 && needed.has("schedule.holidays") && !seedForRef.has("schedule.holidays")) {
    const seed = seeds.find(item => item.id === holidaySources[0].seedId)!;
    seed.coverageRefs.push("schedule.holidays");
    seedForRef.set("schedule.holidays", seed);
  }

  function pricesFor(subject: string | undefined): Record<string, unknown>[] {
    if (!subject) return [];
    const prices = candidateRecap.filter(fact => fact.claim_type === "service" && recordValue(fact.value)?.service_type === subject).map(fact => recordValue(recordValue(fact.value)?.public_price)).filter((price): price is Record<string, unknown> => price !== null);
    return [...new Map(prices.map(price => [hash(price), price])).values()];
  }
  function publishedPrice(price: Record<string, unknown>): string {
    const published = [price.currency, price.amount].filter(value => typeof value === "string").join(" ");
    const condition = typeof price.condition === "string" && price.condition ? ` com a condição “${price.condition}”` : "";
    return published + condition;
  }
  function question(ref: CoverageRef): string {
    const existing = questionFor(ref, snapshot).questionPt;
    if (ref.field === "service.catalog_closure" && snapshot.services.length) {
      const names = snapshot.services.map(subject => {
        const cell = snapshot.cells[coverageKey("service.name_synonyms", subject)];
        return cell?.state === "answered" && Array.isArray(cell.value) && typeof cell.value[0] === "string" ? cell.value[0] : subject.replaceAll("_", " ");
      });
      return `Encontrei estes serviços no site: ${names.join("; ")}. Confirma essa lista? ${existing}`;
    }
    const prices = pricesFor(ref.subject);
    if (prices.length > 1 && ["service.price_mode", "service.price_target", "service.negotiation"].includes(ref.field)) {
      return `O site apresenta estes valores para ${ref.subject!.replaceAll("_", " ")}: ${prices.map(publishedPrice).join("; ")}. Qual valor está correto e em quais condições?${ref.field === "service.negotiation" ? ` ${existing}` : ""}`;
    }
    const price = prices[0];
    if (price && (ref.field === "service.price_target" || ref.field === "service.negotiation")) {
      const context = `Seu site publica ${publishedPrice(price)} para ${ref.subject!.replaceAll("_", " ")}.`;
      return ref.field === "service.price_target" ? `${context} Confirma esse valor público e suas condições?` : `${context} ${existing}`;
    }
    return existing;
  }
  for (const [key, ref] of needed) {
    if (seedForRef.has(key)) continue;
    const state = snapshot.cells[key]?.state ?? "missing";
    const seed: MutableSeed = { id: coverageSeedId(key), source: privateRef(key) || state === "owner_review_required" ? "owner_private_requirement" : state === "ambiguous" ? "ambiguity" : "missing_website_information", subject: ref.subject ?? ref.field, questionPt: question(ref), coverageRefs: [key], relatedItemIds: [], blocking: true };
    seeds.push(seed);
    seedForRef.set(key, seed);
  }
  if (snapshot.catalogOverflow) {
    const key = "service.catalog_overflow";
    const seed: MutableSeed = { id: coverageSeedId(key), source: "owner_private_requirement", subject: key, questionPt: `Os serviços adicionais ficaram fora do catálogo operacional: ${snapshot.catalogOverflow.services.join("; ")}. Como devemos encaminhar esses pedidos ao dono sem aceitá-los, precificá-los ou agendá-los automaticamente?`, coverageRefs: [key], relatedItemIds: [], blocking: true };
    seeds.push(seed);
    seedForRef.set(key, seed);
  }

  function link(left: MutableSeed | undefined, right: MutableSeed | undefined, explicitlyEligible = false) {
    if (!left || !right || left.id === right.id || (!explicitlyEligible && (left.source === "owner_private_requirement" || right.source === "owner_private_requirement" || [...left.coverageRefs, ...right.coverageRefs].some(privateRef)))) return;
    if (!left.relatedItemIds.includes(right.id)) left.relatedItemIds.push(right.id);
    if (!right.relatedItemIds.includes(left.id)) right.relatedItemIds.push(left.id);
  }
  const relationHints: WebsiteAgendaRelationHint[] = [];
  for (const source of sourceItems) {
    const text = words(source.questionPt);
    const seed = seeds.find(item => item.id === source.seedId)!;
    if (!isDiscoveryOwnerQuestionField(source.field)) continue;
    if (/\b(limites|cidades|territorio|cities|territory|boundaries)\b/.test(text) && /atendimento|atend|coverage|service area/.test(text)) {
      link(seed, seedForRef.get("area.coverage"));
      link(seed, seedForRef.get("area.out_of_area_policy"));
    }
    if (/garantia|warrant/.test(text)) {
      for (const [ref, target] of seedForRef) if (ref === "policy.warranty_materials" || ref.endsWith(":service.warranty")) relationHints.push({ fromItemId: seed.id, toItemId: target.id, requirement: "explicit_owner_applicability" });
    }
    if (/taxa|fee/.test(text) && /emergenc/.test(text)) {
      for (const ref of ["emergency.fee_authority", "authority.emergency", "authority.charge_fee"]) {
        const target = seedForRef.get(ref);
        if (target) relationHints.push({ fromItemId: seed.id, toItemId: target.id, requirement: "explicit_owner_authority" });
      }
    }
  }
  for (let index = 0; index < seeds.length; index++) {
    for (const target of seeds.slice(index + 1)) {
      if (websiteItemsMayShareAnswer(seeds[index], target)) link(seeds[index], target, true);
    }
  }
  const opening = seedForRef.get("area.coverage");
  if (opening && snapshot.cells["area.coverage"]?.state === "ambiguous") {
    seeds.splice(seeds.indexOf(opening), 1);
    seeds.unshift(opening);
  }
  if (seeds.length > MAX_AGENDA_ITEMS || new Set(seeds.map(seed => seed.id)).size !== seeds.length || seeds.some(seed => !seed.questionPt.trim() || seed.questionPt.length > 8192)) throw new Error("website_agenda_seed_contract_limit_or_identity");
  seeds.forEach(seed => seed.relatedItemIds.sort());
  const coverageObligations: WebsiteCoverageObligation[] = activeRefs.map(ref => {
    const key = coverageKey(ref.field, ref.subject);
    const state = snapshot.cells[key]?.state ?? "missing";
    return { coverageRef: key, field: ref.field, ...(ref.subject ? { subject: ref.subject } : {}), initialState: state, conditional: conditional.has(key), blocking: true, disposition: state === "not_applicable" ? "not_applicable" : seedForRef.has(key) ? "ask" : "website_candidate_recap", seedId: seedForRef.get(key)?.id ?? null };
  });
  if (snapshot.catalogOverflow) coverageObligations.push({ coverageRef: "service.catalog_overflow", field: "service.catalog_overflow", initialState: "owner_review_required", conditional: false, blocking: true, disposition: "ask", seedId: seedForRef.get("service.catalog_overflow")!.id });
  const provenance = { draftId: readback.draft_id, draftVersion: readback.draft_version, draftHash: readback.draft_hash, sourceJobId: readback.draft.source_job_id, sourceAttemptId: readback.draft.source_attempt_id, sourceResultId: readback.draft.source_result_id, sourceResultHash: readback.draft.source_result_hash, tenantId: snapshot.tenantId, callId: snapshot.callId, draftInputDigest: hash(readback), coverageDigest: createHash("sha256").update(canonicalCoverage(snapshot)).digest("hex"), authority: { rules_approved: false, powers_granted: false, operational_mode_changed: false } as const };
  const result = { version: 1 as const, seeds, provenance, sourceItems, coverageObligations, candidateRecap, relationHints };
  return frozen({ ...result, seedsHash: hash(result) });
}
