import { getAgendaItems, parseOnboardingAgenda, type AgendaProposal, type OnboardingAgenda } from "./onboarding-agenda.ts";
import { cleanFact, type OnboardingAnswerArgs } from "./onboarding-store.ts";
import { validateWebsiteAnswerApplicability } from "./onboarding-website-applicability.ts";
import {
  applyCoverageFact, coverageKey, createCoverage, isServiceCoverageField,
  type CoverageDisposition, type CoverageField,
} from "./onboarding-coverage.ts";

export function validateWebsiteInterpretationFacts(input: {
  facts: unknown; proposal: AgendaProposal; currentItemId: string | null;
  agenda: OnboardingAgenda; ownerTranscript: string;
}): OnboardingAnswerArgs[] {
  const { facts, proposal, currentItemId, agenda, ownerTranscript } = input;
  validateWebsiteAnswerApplicability({agenda,currentItemId,ownerTranscript,proposal});
  if (!Array.isArray(facts) || facts.length > 16 || Buffer.byteLength(JSON.stringify(facts)) > 65_536)
    throw new Error("website_facts_invalid_batch");
  if (typeof ownerTranscript !== "string" || !ownerTranscript.trim() || ownerTranscript.length > 32768)
    throw new Error("website_facts_owner_evidence_invalid");
  // No typed facts is a valid outcome: the complete literal transcript remains
  // authoritative interview evidence, but is not materializable typed policy.
  if (facts.length === 0) return [];
  parseOnboardingAgenda(agenda, agenda.binding);
  const agendaItems=getAgendaItems(agenda);
  if (["off_scope", "clarification", "defer"].includes(proposal.kind)) throw new Error("website_facts_proposal_cannot_stage");
  const allowedItems = new Set<string>();
  if (proposal.kind === "correction") {
    if (!Array.isArray(proposal.affectedItems ?? []) ||
      (proposal.affectedItems?.length ?? 0)+(proposal.affectedCandidates?.length ?? 0)<1)
      throw new Error("website_facts_correction_targets_invalid");
    for (const target of proposal.affectedItems ?? []) {
      if (!agendaItems.some(item => item.id === target.itemId)) throw new Error("website_facts_unknown_correction_target");
      if (target.disposition === "corrected") allowedItems.add(target.itemId);
    }
  } else {
    if (!currentItemId || !("itemId" in proposal) || proposal.itemId !== currentItemId)
      throw new Error("website_facts_current_item_mismatch");
    const current = agendaItems.find(item => item.id === currentItemId);
    if (!current) throw new Error("website_facts_current_item_unknown");
    allowedItems.add(currentItemId);
    if (proposal.kind === "answer") for (const relatedId of proposal.relatedItemIds ?? []) {
      const related = agendaItems.find(item => item.id === relatedId);
      if (!related || !current.relatedItemIds.includes(relatedId))
        throw new Error("website_facts_related_target_not_explicit");
      allowedItems.add(relatedId);
    }
  }
  const allowedRefs = new Set(agendaItems.filter(item => allowedItems.has(item.id)).flatMap(item => [...item.coverageRefs]));
  const seenRefs = new Set<string>();
  const validated: OnboardingAnswerArgs[] = [];
  for (const value of facts) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key =>
      !["topic", "field", "subject", "disposition", "rule_text", "structured", "owner_words"].includes(key)))
      throw new Error("website_facts_unrecognized_fields");
    const raw = value as OnboardingAnswerArgs;
    const cleaned = cleanFact({ ...raw, owner_words: ownerTranscript }) as OnboardingAnswerArgs | null;
    if (!cleaned || (raw.subject !== undefined && !isServiceCoverageField(cleaned.field as CoverageField)))
      throw new Error("website_facts_policy_shape_invalid");
    const ref = coverageKey(cleaned.field as CoverageField, cleaned.subject);
    if (!allowedRefs.has(ref)) throw new Error(`website_facts_ref_not_allowed:${ref}`);
    const privateRef = agenda.items.some(item => allowedItems.has(item.id) && item.coverageRefs.includes(ref) &&
      (item.source === "owner_private_requirement" || ref.startsWith("authority.") || ref === "emergency.fee_authority" || ref.endsWith(":service.negotiation")));
    const ownerEvidence = ownerTranscript.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
    if (privateRef && cleaned.disposition === "answered" &&
      /^(?:eu )?(?:nao sei\b|nao tenho certeza\b|ainda nao decidi\b|preciso (?:revisar|confirmar|verificar|decidir)\b)/.test(ownerEvidence))
      throw new Error(`website_facts_private_evidence_undecided:${ref}`);
    if (seenRefs.has(ref)) throw new Error(`website_facts_duplicate_ref:${ref}`);
    if ((proposal.kind === "answer" && cleaned.disposition !== "answered") ||
      (proposal.kind === "not_applicable" && cleaned.disposition !== "not_applicable"))
      throw new Error("website_facts_disposition_mismatch");
    seenRefs.add(ref); validated.push(cleaned);
  }
  // Exercise the existing pure coverage value parsers, never a new policy
  // interpretation or DB write. Dependencies unavailable in this bounded input
  // fail explicitly (notably a negotiation floor without a validated price).
  let coverage = createCoverage({ tenantId: "website-facts-validation", callId: agenda.binding.callId });
  const priority = (field: string) => field === "service.price_mode" ? 0 : field === "service.price_target" ? 1 : 2;
  for (const fact of [...validated].sort((a, b) => priority(a.field) - priority(b.field))) {
    coverage = applyCoverageFact(coverage, { field: fact.field as CoverageField, subject: fact.subject,
      disposition: fact.disposition as CoverageDisposition, value: fact.structured.value, ownerWords: ownerTranscript, ruleText: fact.rule_text });
    const ref = coverageKey(fact.field as CoverageField, fact.subject);
    const state = coverage.cells[ref]?.state;
    if (fact.disposition === "answered" ? state !== "answered" : state !== fact.disposition)
      throw new Error(`website_facts_typed_value_invalid:${ref}:${coverage.cells[ref]?.reason ?? state ?? "missing"}`);
  }
  return validated;
}
