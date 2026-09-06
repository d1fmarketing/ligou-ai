import { getAgendaAction, MAX_AGENDA_ITEMS, type AgendaProposal, type AgendaSeed, type OnboardingAgenda } from "./onboarding-agenda.ts";

const normalized = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const fields = (item: AgendaSeed) => item.coverageRefs.map(ref => ref.slice(ref.lastIndexOf(":") + 1));
const has = (item: AgendaSeed, field: string) => fields(item).includes(field);
const isSource = (item: AgendaSeed) => fields(item).some(field => field.startsWith("discovery.owner_question."));
const globalWarranty = (item: AgendaSeed) => isSource(item) && /garantia|warrant/.test(normalized(item.questionPt));
const globalEmergencyFee = (item: AgendaSeed) => isSource(item) && /taxa|fee/.test(normalized(item.questionPt)) && /emergenc/.test(normalized(item.questionPt));
const serviceFamilies = new Set(["service.warranty", "service.materials_parts", "service.duration", "service.inclusions_exclusions", "service.emergency_eligibility", "service.escalation", "service.negotiation"]);
const control = (item: AgendaSeed) => fields(item).some(field => field.startsWith("authority.") || ["emergency.fee_authority", "service.escalation", "service.negotiation"].includes(field));

/** Static eligibility only. Every use must also pass the exact-owner-text gate. */
export function websiteItemsMayShareAnswer(left: AgendaSeed, right: AgendaSeed): boolean {
  if (left.id === right.id) return false;
  if (fields(left).some(field => serviceFamilies.has(field) && has(right, field))) return true;
  if ((control(left) || globalEmergencyFee(left)) && (control(right) || globalEmergencyFee(right))) return true;
  const warrantyPair = (global: AgendaSeed, target: AgendaSeed) => globalWarranty(global) && (has(target, "service.warranty") || has(target, "policy.warranty_materials"));
  if (warrantyPair(left, right) || warrantyPair(right, left)) return true;
  const compoundPair = (global: AgendaSeed, target: AgendaSeed) => has(global, "policy.warranty_materials") && (has(target, "service.warranty") || has(target, "service.materials_parts"));
  return compoundPair(left, right) || compoundPair(right, left);
}

const universalServices = (text: string) => /\b(?:todos os(?: nossos)?|todos esses|todos estes|qualquer|cada|nenhum) servicos?\b/.test(text);
function partialOrNegatedUniversal(text: string): boolean {
  // "Todos" inside a qualified/denied scope is not universal evidence. Limit
  // negation to the quantifier/copula/coverage relation: a real restriction
  // such as "não pode negociar para todos" does not negate service scope.
  return /\b(?:quase|praticamente)\s+(?:todos|qualquer|cada|nenhum)\b|\b(?:maioria|maior parte|grande parte|boa parte)\b/.test(text) ||
    /\bnao\s+(?:sao|e|sera|serao|eram|foi|foram)\s+(?:(?:para|em|a|valido|valida|validos|validas|aplicavel|aplicaveis|necessariamente|sempre|exatamente)\s+){0,4}(?:todos|qualquer|cada)\b/.test(text) ||
    /\bnao\s+(?:para|em)\s+(?:todos|qualquer|cada)\b/.test(text) ||
    /\bnao\s+(?:abrange|abrangem|cobre|cobrem|inclui|incluem|contempla|contemplam)\s+(?:(?:necessariamente|sempre|exatamente|a|para|em)\s+){0,3}(?:todos|qualquer|cada)\b/.test(text) ||
    /\btodos\b[^.;\n]{0,100}\bmenos\b/.test(text);
}
function unsafeScope(text: string): boolean {
  return partialOrNegatedUniversal(text) || /[?"“”]/.test(text) || /\b(?:talvez|hipoteticamente|poderia|nao sei|nao tenho certeza|ainda nao decidi|exceto|salvo|com excecao|nem todos)\b/.test(text) ||
    /\bnao (?:vale|valem|se aplica|se aplicam|serve|servem)\b.{0,60}\b(?:todos|qualquer|cada)\b/.test(text) ||
    /\bnao (?:estou|estamos) (?:dizendo|confirmando|afirmando)\b|\bnao (?:confirmo|afirmo)\b/.test(text) ||
    /\b(?:o site|website) (?:diz|fala|informa|publica|promete|oferece|apresenta)\b|\bsegundo o site\b/.test(text);
}
const clauses = (text: string) => text.split(/[.;\n]|\b(?:mas|porem|contudo|enquanto)\b/).map(clause => clause.trim()).filter(Boolean);
function ownerRequired(clause: string): boolean {
  if (/\b(?:nao|dispensa) (?:precis\w*|necessit\w*|exig\w*|depend\w*|aprovar)|\bsem precisar\b/.test(clause)) return false;
  return /\b(?:depende|dependem|exige|exigem|precisa|precisam|necessita|necessitam) (?:da |de )?(?:minha aprovacao|aprovacao (?:do dono|do proprietario))\b/.test(clause) ||
    /\b(?:somente|so|apenas) (?:com|apos) (?:a )?(?:minha aprovacao|aprovacao (?:do dono|do proprietario))\b/.test(clause) ||
    /\b(?:deve|devem) ser aprovad[oa]s? por mim\b/.test(clause);
}
const namedActions: Record<string, RegExp> = {
  "authority.quote_price": /\b(?:precos?|cotacoes?)\b/,
  "authority.negotiate_floor": /\b(?:negociar|negociacao|descontos?)\b/,
  "authority.read_calendar": /\b(?:consultar|ler|acessar) (?:a )?agenda\b|\bconsulta (?:da|a) agenda\b/,
  "authority.book": /\b(?:agendar|agendamentos?|marcar atendimento)\b/,
  "authority.reschedule_cancel": /^(?=.*\b(?:remarcar|reagendar|remarcacoes?|reagendamentos?)\b)(?=.*\b(?:cancelar|cancelamentos?)\b)/,
  "authority.charge_fee": /\b(?:taxas?|cobrancas?)\b/,
  "emergency.fee_authority": /\b(?:taxas?|cobrancas?)\b/,
  "authority.emergency": /\b(?:atender|tratar|aceitar|confirmar) (?:uma? |as? )?emergencias?\b|\batendimentos? (?:de )?emergencia\b|\bemergencias? (?:dependem|exigem|precisam)\b/,
  "authority.out_of_area": /\bfora (?:da area|dessas cidades|da cobertura)\b/,
};
const denialActions: Record<string, string> = {
  "authority.quote_price": "(?:informar|passar|confirmar|fornecer) (?:os? )?precos?",
  "authority.negotiate_floor": "(?:negociar|dar descontos?|conceder descontos?)",
  "authority.read_calendar": "(?:consultar|ler|acessar) (?:a )?agenda",
  "authority.book": "(?:agendar|marcar atendimentos?)",
  "authority.charge_fee": "(?:confirmar|cobrar) (?:as? )?taxas?",
  "emergency.fee_authority": "(?:confirmar|cobrar) (?:as? )?taxas?",
  "authority.emergency": "(?:atender|tratar|aceitar|confirmar) (?:uma? |as? )?emergencias?",
  "authority.out_of_area": "(?:atender|aceitar pedidos) fora (?:da area|da cobertura|dessas cidades)",
};
function explicitOutsidePolicy(text: string): boolean {
  return /\bfora (?:da area|dessas cidades|da cobertura)\b/.test(text) &&
    (/\bnao (?:e atendido|sao atendidos|atendemos|aceitamos)\b/.test(text) || /\b(?:eu aprove|minha aprovacao|aprovacao do dono)\b/.test(text)) &&
    /\b(?:excecao|excecoes|nunca|nenhuma excecao|sem excecoes)\b/.test(text);
}
function negotiationRestricted(text: string): boolean {
  return /\bnao (?:negociamos|negociar|ha negociacao|damos descontos|concedemos descontos)\b|\bsem (?:negociacao|descontos?)\b|\bnao negociave(?:l|is)\b/.test(text) ||
    clauses(text).some(clause => namedActions["authority.negotiate_floor"].test(clause) && ownerRequired(clause));
}
function privateRestriction(field: string, text: string): boolean {
  if (field === "service.negotiation" || field === "authority.negotiate_floor") return negotiationRestricted(text);
  if (field === "service.escalation") return clauses(text).some(clause => /\b(?:servicos?|atendimentos?|execucao)\b/.test(clause) && ownerRequired(clause));
  if (field === "authority.out_of_area" && explicitOutsidePolicy(text)) return true;
  const action = namedActions[field];
  if (!action) return false;
  return clauses(text).some(clause => {
    if (!action.test(clause)) return false;
    if (ownerRequired(clause)) return true;
    if (["authority.charge_fee", "emergency.fee_authority"].includes(field) && /\bnenhuma taxa\b/.test(clause) && /\b(?:confirmad[ao]|cobrad[ao])\b/.test(clause)) return true;
    if (field === "authority.reschedule_cancel") return /\bnao (?:pode|deve) remarcar (?:ou|e) cancelar\b/.test(clause);
    const predicate = denialActions[field];
    // Do not let "não pode cobrar e PODE agendar" inherit the first negation.
    return Boolean(predicate && new RegExp(`\\b(?:nao (?:pode|podem|deve|devem)|nunca|jamais|nao autorizo) (?:\\b(?!(?:pode|podem|deve|devem)\\b)[a-z]+\\s+){0,4}${predicate}\\b`).test(clause));
  });
}
function warrantyContent(text: string): boolean {
  return /\b(?:garantias?|warranty|fabricantes?|instaladores?)\b/.test(text) && /\b(?:cobre|cobrem|cobertura|defeitos?|anos?|meses?|exclui|exclusoes)\b/.test(text);
}
function familyContent(field: string, text: string): boolean {
  if (field === "service.warranty") return warrantyContent(text);
  if (field === "service.materials_parts") return /\b(?:pecas?|materiais|material|parts|materials)\b/.test(text) && /\b(?:fornecemos|fornecidos|fornecidas|usamos|incluidos|incluidas|cliente|orcamento)\b/.test(text);
  if (field === "service.duration") return /\b(?:\d+(?:[,.]\d+)?|um|uma|duas|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|meia)\s*(?:minutos?|min|horas?)\b/.test(text);
  if (field === "service.inclusions_exclusions") return /\b(?:inclui|incluem|incluido|incluidos|exclui|excluem|excluido|excluidos)\b/.test(text);
  if (field === "service.emergency_eligibility") return clauses(text).some(clause => !/automatic|aprovacao/.test(clause) && /\bservicos?\b.*\b(?:podem?|nao podem?) (?:ser )?(?:tratados?|atendidos?|considerados?) como emergencias?\b/.test(clause));
  return privateRestriction(field, text);
}
const familyMentions: Record<string, RegExp> = {
  "service.warranty": /garantia|warrant/,
  "service.materials_parts": /\b(?:pecas?|materiais|material)\b/,
  "service.duration": /\b(?:duracao|minutos?|horas?)\b/,
  "service.inclusions_exclusions": /\b(?:inclui|incluem|incluido|incluidos|exclui|excluem|excluido|excluidos)\b/,
  "service.emergency_eligibility": /\bemergencias?\b/,
  "service.escalation": /\baprovacao\b/,
  "service.negotiation": /\b(?:negocia\w*|descontos?)\b/,
};
function scopedPolicy(field: string, text: string): boolean {
  const own = familyMentions[field];
  if (!own) return false;
  return clauses(text).filter(universalServices).some(clause => {
    if (own.test(clause)) return true;
    // An all-services duration clause cannot give a separate warranty clause
    // universal scope merely because both appeared in the same owner turn.
    if (Object.entries(familyMentions).some(([other, pattern]) => other !== field && pattern.test(clause))) return false;
    if (/\b(?:essas|estas) (?:politicas|regras|restricoes)\b/.test(clause)) return true;
    if (!/\b(?:isso|essa regra|esta regra|essa politica|esta politica)\b/.test(clause)) return false;
    const contentFamilies = [...serviceFamilies].filter(candidate => familyContent(candidate, text));
    return contentFamilies.length === 1 && contentFamilies[0] === field;
  });
}
function supportedTarget(current: AgendaSeed, target: AgendaSeed, text: string): boolean {
  const currentService = current.coverageRefs.some(ref => ref.startsWith("service:"));
  const targetService = target.coverageRefs.some(ref => ref.startsWith("service:"));
  if (targetService && (!currentService || current.subject !== target.subject) && !fields(target).every(field => scopedPolicy(field, text))) return false;
  if (currentService && !targetService && !fields(current).every(field => scopedPolicy(field, text))) return false;
  if (has(target, "policy.warranty_materials")) return warrantyContent(text) && familyContent("service.materials_parts", text);
  if (globalWarranty(target)) return warrantyContent(text) && /\b(?:fabricantes?|instaladores?)\b/.test(text);
  if (globalEmergencyFee(target)) return /\b(?:nao ha|nao existe|ha|existe|sem) taxas?\b|\btaxas?\b.{0,35}\b\d+/.test(text);
  return fields(target).every(field => {
    if (serviceFamilies.has(field)) return familyContent(field, text);
    if (field.startsWith("authority.") || field === "emergency.fee_authority") return privateRestriction(field, text);
    if (field === "area.out_of_area_policy") return explicitOutsidePolicy(text);
    if (field === "area.coverage" || (field.startsWith("discovery.owner_question.") && /limites|cidades|territorio/.test(normalized(target.questionPt)))) return /\b(?:atendemos|atende|atendimento)\b/.test(text) && /\b(?:somente|so|apenas|cidades)\b/.test(text);
    return false;
  });
}

/** Always runs before queue mutation, including the facts:[] evidence-only path.
 * Eligibility is not approval. This answered-only gate creates no policy/power. */
export function validateWebsiteAnswerApplicability(input: {
  agenda: OnboardingAgenda; currentItemId: string | null; ownerTranscript: string; proposal: AgendaProposal;
}): AgendaProposal {
  const { agenda, proposal, currentItemId, ownerTranscript } = input;
  if (proposal.kind !== "answer") return proposal;
  if (!currentItemId || proposal.itemId !== currentItemId || getAgendaAction(agenda).itemId !== currentItemId) throw new Error("website_applicability_current_item_mismatch");
  if (typeof ownerTranscript !== "string" || !ownerTranscript.trim() || ownerTranscript.length > 32768) throw new Error("website_applicability_owner_text_invalid");
  const related = proposal.relatedItemIds ?? [];
  if (!Array.isArray(related) || related.length > MAX_AGENDA_ITEMS || new Set(related).size !== related.length) throw new Error("website_applicability_targets_invalid");
  // A candidate override has no related graph by default. The authoritative
  // getAgendaAction lookup above also covers that later correction queue.
  if (!related.length) return proposal;
  const current = agenda.items.find(item => item.id === currentItemId);
  if (!current) throw new Error("website_applicability_current_graph_missing");
  const text = normalized(ownerTranscript);
  if (unsafeScope(text)) throw new Error("website_applicability_scope_unsupported");
  for (const id of related) {
    const target = agenda.items.find(item => item.id === id);
    if (!target || id === currentItemId || !current.relatedItemIds.includes(id) || ["answered", "corrected", "not_applicable"].includes(target.status)) throw new Error("website_applicability_target_not_eligible");
    if (!supportedTarget(current, target, text)) throw new Error(`website_applicability_owner_evidence_missing:${id}`);
  }
  return proposal;
}
