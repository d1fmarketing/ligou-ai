import { createHash } from "node:crypto";

/** A question queue, not a lifecycle, policy writer, or owner-approval authority. */
export const ONBOARDING_AGENDA_VERSION = 1 as const;
export const MAX_AGENDA_ITEMS = 1024;
export type AgendaSource = "missing_website_information" | "ambiguity" | "contradiction" | "owner_private_requirement";
export type AgendaStatus = "open" | "awaiting_clarification" | "answered" | "corrected" | "not_applicable" | "deferred_owner_review";
export interface AgendaBinding {
  readonly interviewId: string;
  readonly callId: string;
  readonly draftId: string;
  readonly draftHash: string;
  readonly sourceResultId: string;
  readonly sourceResultHash: string;
}
export interface AgendaSeed {
  readonly id: string;
  readonly source: AgendaSource;
  readonly subject: string;
  readonly questionPt: string;
  readonly coverageRefs: readonly string[];
  readonly relatedItemIds: readonly string[];
  readonly blocking: boolean;
}
/** Source-bound correction catalog only; these are not initial questions. */
export interface AgendaCandidateContext {
  readonly id: string;
  readonly subject: string;
  readonly questionPt: string;
  readonly coverageRefs: readonly string[];
}
export interface OwnerTurnEvidence { readonly turnId: string; readonly text: string }
export interface AgendaItem extends AgendaSeed {
  readonly status: AgendaStatus;
  readonly answerRevision: number;
  readonly clarificationCount: number;
  readonly lastQuestionPt: string;
  readonly evidence: readonly OwnerTurnEvidence[];
}
export interface OnboardingAgenda {
  readonly version: typeof ONBOARDING_AGENDA_VERSION;
  readonly binding: AgendaBinding;
  readonly revision: number;
  readonly items: readonly AgendaItem[];
  readonly candidateContext: readonly AgendaCandidateContext[];
  readonly candidateOverrides: readonly AgendaItem[];
  readonly ownerTurns: readonly OwnerTurnEvidence[];
}
export type AgendaProposal =
  | { readonly kind: "answer"; readonly itemId: string; readonly relatedItemIds?: readonly string[] }
  | { readonly kind: "clarification"; readonly itemId: string | null; readonly questionPt?: string }
  | { readonly kind: "off_scope" }
  | { readonly kind: "defer" | "not_applicable"; readonly itemId: string }
  | { readonly kind: "correction";
      readonly affectedItems?: readonly { readonly itemId: string; readonly disposition: "corrected" | "reopen" }[];
      readonly affectedCandidates?: readonly { readonly candidateId: string; readonly disposition: "corrected" | "reopen" }[] };
/** Only the transcript-verifying adapter may construct this domain event. The
 * discriminator is not cryptographic proof; no model-asserted approval is read. */
export interface VerifiedOwnerTurnEvent extends OwnerTurnEvidence {
  readonly type: "verified_owner_turn";
  readonly binding: AgendaBinding;
  readonly proposal: AgendaProposal;
}
export type AgendaActionType = "ASK_NEXT_GAP" | "CLARIFY_CURRENT_GAP" | "CONFIRM_AND_ASK_NEXT" | "DEFER_OFF_SCOPE_AND_CONTINUE" | "GENERATE_FINAL_SUMMARY" | "HANDLE_OWNER_CORRECTION";
export interface AgendaAction {
  readonly type: AgendaActionType;
  readonly actionId: string;
  readonly itemId?: string;
  readonly questionPt?: string;
  readonly spokenPt: string;
}
export interface AgendaTransition {
  readonly agenda: OnboardingAgenda;
  readonly action: AgendaAction | null;
  readonly accepted: boolean;
  readonly replayed: boolean;
  readonly rejection?: string;
}
export interface AgendaSummary {
  readonly version: 1;
  readonly binding: AgendaBinding;
  readonly revision: number;
  readonly readyForSummary: boolean;
  readonly confirmed: readonly AgendaItem[];
  readonly corrected: readonly AgendaItem[];
  readonly deferred: readonly AgendaItem[];
  readonly notApplicable: readonly AgendaItem[];
  readonly unresolved: readonly AgendaItem[];
  readonly activationBlockingUnknowns: readonly AgendaItem[];
}

const bindingKeys = ["interviewId", "callId", "draftId", "draftHash", "sourceResultId", "sourceResultHash"] as const;
const sources: readonly string[] = ["missing_website_information", "ambiguity", "contradiction", "owner_private_requirement"];
function nonblank(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${label}: nonblank text within limit ${max} required`);
}
function list<T>(value: readonly T[], label: string, max = MAX_AGENDA_ITEMS): void {
  if (!Array.isArray(value) || value.length > max || Object.keys(value).length !== value.length) throw new Error(`Invalid ${label}: dense array within limit ${max} required`);
}
function ids(value: readonly string[], label: string, max = MAX_AGENDA_ITEMS): void {
  list(value, label, max);
  value.forEach(v => nonblank(v, label));
  if (new Set(value).size !== value.length) throw new Error(`Duplicate ${label}`);
}
function checkedBinding(binding: AgendaBinding): AgendaBinding {
  const result = {} as Record<typeof bindingKeys[number], string>;
  for (const key of bindingKeys) {
    nonblank(binding?.[key], `binding.${key}`);
    if (key.endsWith("Hash") && !/^[a-f0-9]{64}$/i.test(binding[key])) throw new Error(`Invalid binding.${key}`);
    result[key] = binding[key];
  }
  return Object.freeze(result);
}
function freezeItem(item: AgendaItem): AgendaItem {
  return Object.freeze({ ...item, coverageRefs: Object.freeze([...item.coverageRefs]), relatedItemIds: Object.freeze([...item.relatedItemIds]), evidence: Object.freeze(item.evidence.map(e => Object.freeze({ ...e }))) });
}
function freezeAgenda(agenda: OnboardingAgenda): OnboardingAgenda {
  return Object.freeze({ ...agenda, items: Object.freeze(agenda.items.map(freezeItem)),
    candidateContext: Object.freeze(agenda.candidateContext.map(context => Object.freeze({ ...context, coverageRefs: Object.freeze([...context.coverageRefs]) }))),
    candidateOverrides: Object.freeze(agenda.candidateOverrides.map(freezeItem)), ownerTurns: Object.freeze(agenda.ownerTurns.map(e => Object.freeze({ ...e }))) });
}
function checkedCandidateContext(context: readonly AgendaCandidateContext[], regularIds: Set<string>): AgendaCandidateContext[] {
  list(context, "candidateContext");
  ids(context.map(item => item?.id), "candidate ids");
  return context.map(item => {
    exactRecord(item, ["id", "subject", "questionPt", "coverageRefs"], "candidate context");
    if (!/^candidate:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id) || regularIds.has(item.id))
      throw new Error("Invalid candidate identity or namespace");
    nonblank(item.subject, "candidate subject", 4096);
    nonblank(item.questionPt, "candidate question", 8192);
    ids(item.coverageRefs, "candidate coverageRefs");
    if (item.coverageRefs.length !== 1 || item.coverageRefs[0] !== `discovery.candidate.${item.id.slice("candidate:".length).replaceAll("-", "")}`)
      throw new Error("Invalid candidate synthetic coverage ref");
    return { ...item, coverageRefs: [...item.coverageRefs] };
  });
}
function candidateItem(context: AgendaCandidateContext): AgendaItem {
  return { ...context, source: "contradiction", blocking: true, relatedItemIds: [], status: "open", answerRevision: 0,
    clarificationCount: 0, lastQuestionPt: context.questionPt, evidence: [] };
}
export function getAgendaItems(agenda: OnboardingAgenda): readonly AgendaItem[] {
  return [...agenda.items, ...agenda.candidateOverrides];
}
export function createOnboardingAgenda(binding: AgendaBinding, seeds: readonly AgendaSeed[], candidateContext: readonly AgendaCandidateContext[] = []): OnboardingAgenda {
  const bound = checkedBinding(binding);
  list(seeds, "seeds");
  ids(seeds.map(s => s?.id), "seed ids");
  const known = new Set(seeds.map(s => s.id));
  if (seeds.some(item => item.id.startsWith("candidate:"))) throw new Error("Regular item uses candidate namespace");
  const candidates = checkedCandidateContext(candidateContext, known);
  const items = seeds.map(s => {
    nonblank(s.subject, "subject", 4096);
    nonblank(s.questionPt, "questionPt", 8192);
    if (!sources.includes(s.source) || typeof s.blocking !== "boolean") throw new Error("Invalid seed source/blocking");
    ids(s.coverageRefs, "coverageRefs", 4096);
    ids(s.relatedItemIds, "relatedItemIds");
    if (s.relatedItemIds.some(id => id === s.id || !known.has(id))) throw new Error("Unknown or self-related seed id");
    return { id: s.id, source: s.source, subject: s.subject, questionPt: s.questionPt, coverageRefs: s.coverageRefs, relatedItemIds: s.relatedItemIds, blocking: s.blocking, status: "open" as const, answerRevision: 0, clarificationCount: 0, lastQuestionPt: s.questionPt, evidence: [] };
  });
  return freezeAgenda({ version: ONBOARDING_AGENDA_VERSION, binding: bound, revision: 0, items,
    candidateContext: candidates, candidateOverrides: [], ownerTurns: [] });
}
const unresolved = (item: AgendaItem) => item.status === "open" || item.status === "awaiting_clarification";
function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new Error(`Invalid ${label} fields`);
  return value as Record<string, unknown>;
}
function counter(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${label} counter`);
}
function parseEvidence(value: unknown): OwnerTurnEvidence {
  const row = exactRecord(value, ["turnId", "text"], "owner evidence");
  nonblank(row.turnId, "turnId");
  nonblank(row.text, "owner evidence", 32768);
  return { turnId: row.turnId, text: row.text };
}
/** Validate JSONB before use; this checks integrity, not transcript authenticity.
 * The store must separately bind persisted state to its trusted source/receipt. */
export function parseOnboardingAgenda(value: unknown, expectedBinding: AgendaBinding): OnboardingAgenda {
  const raw = exactRecord(value, ["version", "binding", "revision", "items", "candidateContext", "candidateOverrides", "ownerTurns"], "agenda");
  if (raw.version !== ONBOARDING_AGENDA_VERSION) throw new Error("Unsupported agenda version");
  exactRecord(raw.binding, bindingKeys, "binding");
  const bound = checkedBinding(raw.binding as AgendaBinding);
  const expected = checkedBinding(expectedBinding);
  if (bindingKeys.some(key => bound[key] !== expected[key])) throw new Error("Persisted agenda binding mismatch");
  counter(raw.revision, "revision");
  // History has no arbitrary spoken-turn cap. JSON/storage byte limits belong to
  // the store; JavaScript arrays and safe revision integers remain finite.
  const storedTurns = raw.ownerTurns as readonly unknown[];
  list(storedTurns, "ownerTurns", Number.MAX_SAFE_INTEGER);
  const ownerTurns = storedTurns.map(parseEvidence);
  const turnIndexes = new Map<string, number>();
  ownerTurns.forEach((turn, index) => {
    if (turnIndexes.has(turn.turnId)) throw new Error("Duplicate owner turn id");
    turnIndexes.set(turn.turnId, index);
  });
  if (raw.revision !== ownerTurns.length) throw new Error("Agenda revision does not match owner turns");
  const storedItems = raw.items as readonly unknown[];
  list(storedItems, "items");
  const itemKeys = ["id", "source", "subject", "questionPt", "coverageRefs", "relatedItemIds", "blocking", "status", "answerRevision", "clarificationCount", "lastQuestionPt", "evidence"];
  const rows = storedItems.map(item => exactRecord(item, itemKeys, "item"));
  // Reuse constructor's complete immutable seed validation; never coerce fields.
  const seedAgenda = createOnboardingAgenda(bound, rows.map(row => ({
    id: row.id, source: row.source, subject: row.subject, questionPt: row.questionPt,
    coverageRefs: row.coverageRefs, relatedItemIds: row.relatedItemIds, blocking: row.blocking,
  })) as unknown as readonly AgendaSeed[], raw.candidateContext as readonly AgendaCandidateContext[]);
  const statuses: readonly unknown[] = ["open", "awaiting_clarification", "answered", "corrected", "not_applicable", "deferred_owner_review"];
  const parseItem = (row: Record<string, unknown>, seed: AgendaItem): AgendaItem => {
    if (!statuses.includes(row.status)) throw new Error("Invalid agenda item status");
    counter(row.answerRevision, "answerRevision");
    counter(row.clarificationCount, "clarificationCount", 2);
    if (row.lastQuestionPt !== seed.questionPt) throw new Error("Invalid last question evidence");
    const storedEvidence = row.evidence as readonly unknown[];
    list(storedEvidence, "item evidence", ownerTurns.length);
    const evidence = storedEvidence.map(parseEvidence);
    let previousIndex = -1;
    for (const turn of evidence) {
      const turnIndex = turnIndexes.get(turn.turnId);
      if (turnIndex === undefined || turnIndex <= previousIndex || ownerTurns[turnIndex].text !== turn.text) throw new Error("Invalid item evidence linkage or order");
      previousIndex = turnIndex;
    }
    if (row.answerRevision + row.clarificationCount > evidence.length) throw new Error("Item counters lack evidence");
    if (["answered", "corrected", "not_applicable"].includes(row.status as string) && row.answerRevision < 1) throw new Error("Resolved item lacks answer evidence");
    if (row.status === "deferred_owner_review" && !evidence.length) throw new Error("Deferred item lacks owner evidence");
    if (row.status === "awaiting_clarification" && row.clarificationCount < 1) throw new Error("Clarification status lacks attempt evidence");
    return { ...seed, status: row.status as AgendaStatus, answerRevision: row.answerRevision, clarificationCount: row.clarificationCount, evidence };
  };
  const items = rows.map((row, index) => parseItem(row, seedAgenda.items[index]!));
  const overrideRows = raw.candidateOverrides as readonly unknown[];
  list(overrideRows, "candidateOverrides", seedAgenda.candidateContext.length);
  let previousCandidateIndex = -1;
  const candidateOverrides = overrideRows.map(value => {
    const row = exactRecord(value, itemKeys, "candidate override");
    const index = seedAgenda.candidateContext.findIndex(context => context.id === row.id);
    if (index < 0 || index <= previousCandidateIndex) throw new Error("Unknown, duplicate or reordered candidate override");
    previousCandidateIndex = index;
    const seed = candidateItem(seedAgenda.candidateContext[index]!);
    if (row.subject !== seed.subject || row.questionPt !== seed.questionPt || row.source !== seed.source || row.blocking !== true ||
      JSON.stringify(row.coverageRefs) !== JSON.stringify(seed.coverageRefs) || JSON.stringify(row.relatedItemIds) !== "[]")
      throw new Error("Candidate override metadata changed");
    const override = parseItem(row, seed);
    if (override.answerRevision < 1 || override.evidence.length < 1) throw new Error("Candidate override lacks owner correction evidence");
    return override;
  });
  return freezeAgenda({ version: ONBOARDING_AGENDA_VERSION, binding: bound, revision: raw.revision, items,
    candidateContext: seedAgenda.candidateContext, candidateOverrides, ownerTurns });
}
/** Presentation only: quote the latest resolved territory evidence without
 * inventing locality normalization, operational permission, or a next topic.
 * Mirrored by private SQL website_territory_confirmation. */
export function websiteTerritoryConfirmation(agenda: OnboardingAgenda): string {
  const fallback = "Obrigado, registrei sua resposta. ";
  const latest = agenda.ownerTurns.at(-1);
  if (!latest || !agenda.items.some(item => item.coverageRefs.includes("area.coverage") &&
    ["answered", "corrected"].includes(item.status) && item.answerRevision > 0 &&
    item.evidence.at(-1)?.turnId === latest.turnId && item.evidence.at(-1)?.text === latest.text)) return fallback;
  if ([...latest.text].length > 700 || /["“”<>\x00-\x1f\x7f]/.test(latest.text)) return fallback;
  const text = latest.text.trim().replace(/^(?:(?:uhum|aham|ah|entendi)[.!?, ]+)*/i, "").replace(/^olha[, ]+/i, "");
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const parts = text.split(/(?<=[.!?]) +/);
  if (!/^(?:(?:atendemos|atende) (?:so|somente|apenas|exclusivamente) |(?:a )?nossa area (?:fica|esta|e) restrita a )/.test(normalize(parts[0] ?? ""))) return fallback;
  const outside = parts.some(part => {
    const value = normalize(part);
    return /^(?:se .* fora\b|para sair dessas cidades\b|fora (?:da area|dessas cidades|da cobertura)\b)/.test(value) &&
      /\b(?:aprovacao|autorizacao)\b/.test(value) && /\b(?:dono|proprietario|minha|comigo)\b/.test(value);
  });
  if (!outside) return fallback;
  // Omit only a historical outside-city request aside whose entire current
  // restriction repeats the retained exclusive coverage. All other sentences,
  // including additional conditions and prohibitions, remain verbatim.
  const aside = /^ja (?:teve|tivemos|recebemos) pedidos? de (?:gente|pessoas|clientes) de outras cidades, mas nao e (?:pra|para) atender[.!]?$/;
  const excerpt = parts.filter(part => !aside.test(normalize(part)))
    .map(part => part.replace(/, *combinado[?!.]*$/i, "")).join(" ").replace(/[.!?]+$/, "").trim();
  if (!excerpt || [...excerpt].length > 480) return fallback; // No truncation of conditions.
  return `Registrado. Você informou: “${excerpt}”. `;
}

function actionFor(agenda: OnboardingAgenda, requested: AgendaActionType): AgendaAction {
  const item = getAgendaItems(agenda).find(unresolved);
  const type = !item && requested !== "HANDLE_OWNER_CORRECTION" && requested !== "DEFER_OFF_SCOPE_AND_CONTINUE" ? "GENERATE_FINAL_SUMMARY" : requested;
  const prefix: Record<AgendaActionType, string> = {
    ASK_NEXT_GAP: "", CLARIFY_CURRENT_GAP: "Para esclarecer: ", CONFIRM_AND_ASK_NEXT: websiteTerritoryConfirmation(agenda),
    DEFER_OFF_SCOPE_AND_CONTINUE: "Podemos tratar disso depois; agora vamos concluir sua configuração. ",
    GENERATE_FINAL_SUMMARY: "Vou preparar o resumo para sua revisão.", HANDLE_OWNER_CORRECTION: "Registrei sua correção. ",
  };
  const actionId = createHash("sha256").update(JSON.stringify([ONBOARDING_AGENDA_VERSION, ...bindingKeys.map(k => agenda.binding[k]), agenda.revision, item?.id ?? null, type])).digest("hex");
  return Object.freeze({ type, actionId, ...(item ? { itemId: item.id, questionPt: item.questionPt } : {}), spokenPt: prefix[type] + (item?.questionPt ?? (type === "GENERATE_FINAL_SUMMARY" ? "" : "Vou preparar o resumo para sua revisão.")) });
}
export function getAgendaAction(agenda: OnboardingAgenda): AgendaAction {
  return actionFor(agenda, getAgendaItems(agenda).find(unresolved)?.status === "awaiting_clarification" ? "CLARIFY_CURRENT_GAP" : "ASK_NEXT_GAP");
}

export function applyVerifiedOwnerTurn(agenda: OnboardingAgenda, event: VerifiedOwnerTurnEvent): AgendaTransition {
  checkedBinding(event.binding);
  if (event.type !== "verified_owner_turn" || bindingKeys.some(k => agenda.binding[k] !== event.binding[k])) throw new Error("Owner turn binding mismatch");
  nonblank(event.turnId, "turnId");
  nonblank(event.text, "owner evidence", 32768);
  const previous = agenda.ownerTurns.find(t => t.turnId === event.turnId);
  if (previous) {
    if (previous.text !== event.text) throw new Error("Conflicting owner turn evidence");
    return { agenda, action: null, accepted: true, replayed: true };
  }
  const proposal = event.proposal;
  const allItems = getAgendaItems(agenda);
  const current = allItems.find(unresolved);
  const reject = (rejection: string): AgendaTransition => ({ agenda, action: actionFor(agenda, "CLARIFY_CURRENT_GAP"), accepted: false, replayed: false, rejection });
  const updates = new Map<string, Partial<AgendaItem>>();
  const overrides = new Map(agenda.candidateOverrides.map(item => [item.id, item]));
  let action: AgendaActionType = "CONFIRM_AND_ASK_NEXT";
  if (proposal.kind === "off_scope") {
    action = "DEFER_OFF_SCOPE_AND_CONTINUE";
    if (current) updates.set(current.id, current.clarificationCount >= 2
      ? { status: "deferred_owner_review" }
      : { clarificationCount: current.clarificationCount + 1, lastQuestionPt: current.questionPt });
  } else if (proposal.kind === "correction") {
    const affectedItems = proposal.affectedItems === undefined ? [] : proposal.affectedItems;
    const affectedCandidates = proposal.affectedCandidates === undefined ? [] : proposal.affectedCandidates;
    list(affectedItems, "affectedItems"); list(affectedCandidates, "affectedCandidates");
    if (!affectedItems.length && !affectedCandidates.length) return reject("empty_correction");
    ids(affectedItems.map(i => i.itemId), "correction ids");
    ids(affectedCandidates.map(i => i.candidateId), "candidate correction ids");
    for (const affected of affectedItems) {
      const item = agenda.items.find(i => i.id === affected.itemId);
      if (!item || !["corrected", "reopen"].includes(affected.disposition)) return reject("invalid_correction_target");
      updates.set(item.id, { status: affected.disposition === "reopen" ? "open" : "corrected", answerRevision: item.answerRevision + 1 });
    }
    for (const affected of affectedCandidates) {
      const context = agenda.candidateContext.find(item => item.id === affected.candidateId);
      if (!context || !["corrected", "reopen"].includes(affected.disposition)) return reject("invalid_candidate_correction_target");
      const item = overrides.get(context.id) ?? candidateItem(context);
      overrides.set(context.id, item);
      updates.set(item.id, { status: affected.disposition === "reopen" ? "open" : "corrected", answerRevision: item.answerRevision + 1 });
    }
    action = "HANDLE_OWNER_CORRECTION";
  } else {
    if (!current || !("itemId" in proposal) || proposal.itemId !== current.id) return reject("answer_must_bind_current_item");
    if (proposal.kind === "answer") {
      const related = proposal.relatedItemIds ?? [];
      ids(related, "answer relatedItemIds");
      if (related.some(id => !current.relatedItemIds.includes(id) || !allItems.some(i => i.id === id))) return reject("unrelated_answer_target");
      for (const id of [current.id, ...related]) {
        const item = allItems.find(i => i.id === id)!;
        // Revising a resolved answer requires the explicit correction event.
        if (["answered", "corrected", "not_applicable"].includes(item.status)) return reject("resolved_target_requires_correction");
        updates.set(id, { status: item.answerRevision ? "corrected" : "answered", answerRevision: item.answerRevision + 1 });
      }
    } else if (proposal.kind === "clarification") {
      // Proposal text is never spoken; the trusted application question is immutable.
      if (current.clarificationCount >= 2) updates.set(current.id, { status: "deferred_owner_review" });
      else {
        updates.set(current.id, { status: "awaiting_clarification", clarificationCount: current.clarificationCount + 1, lastQuestionPt: current.questionPt });
        action = "CLARIFY_CURRENT_GAP";
      }
    } else if (proposal.kind === "defer") updates.set(current.id, { status: "deferred_owner_review" });
    else if (proposal.kind === "not_applicable") updates.set(current.id, { status: "not_applicable", answerRevision: current.answerRevision + 1 });
    else return reject("unsupported_proposal");
  }
  const evidence = { turnId: event.turnId, text: event.text };
  const updatedItem = (item: AgendaItem): AgendaItem => updates.has(item.id) ? { ...item, ...updates.get(item.id), evidence: [...item.evidence, evidence] } : item;
  const next = freezeAgenda({ ...agenda, revision: agenda.revision + 1, ownerTurns: [...agenda.ownerTurns, evidence],
    items: agenda.items.map(updatedItem), candidateOverrides: agenda.candidateContext.filter(context => overrides.has(context.id)).map(context => updatedItem(overrides.get(context.id)!)) });
  return { agenda: next, action: actionFor(next, action), accepted: true, replayed: false };
}

/** Deterministic projection of stored evidence. Deferred facts are not answers;
 * readyForSummary is permission to review only, never permission to activate. */
export function projectAgendaSummary(agenda: OnboardingAgenda): AgendaSummary {
  const items = getAgendaItems(agenda);
  const select = (predicate: (item: AgendaItem) => boolean) => Object.freeze(items.filter(predicate));
  return Object.freeze({ version: 1, binding: agenda.binding, revision: agenda.revision, readyForSummary: !items.some(unresolved),
    confirmed: select(i => i.status === "answered"), corrected: select(i => i.status === "corrected"), deferred: select(i => i.status === "deferred_owner_review"),
    notApplicable: select(i => i.status === "not_applicable"), unresolved: select(unresolved),
    activationBlockingUnknowns: select(i => i.blocking && (unresolved(i) || i.status === "deferred_owner_review")),
  });
}
