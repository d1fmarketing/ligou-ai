import { createHash } from "node:crypto";
import { onboardingAgendaDigest, type StoredWebsiteInterview } from "./onboarding-agenda-store.ts";
import type { WebsiteAgendaSeedProjection } from "./onboarding-agenda-seed.ts";
import { getAgendaItems, MAX_AGENDA_ITEMS, parseOnboardingAgenda, projectAgendaSummary, type AgendaCandidateContext, type AgendaItem, type OwnerTurnEvidence } from "./onboarding-agenda.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PART_CODEPOINTS = 1400;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export function buildWebsiteCandidateContext(projection: WebsiteAgendaSeedProjection): readonly AgendaCandidateContext[] {
  const { seedsHash, ...body } = projection;
  if (projection.version !== 1 || seedsHash !== digest(body) || Buffer.byteLength(JSON.stringify(projection)) > MAX_SOURCE_BYTES ||
    !Array.isArray(projection.candidateRecap) || projection.candidateRecap.length > MAX_AGENDA_ITEMS)
    throw new Error("website_candidate_context_source_invalid");
  const seen = new Set<string>();
  return Object.freeze(projection.candidateRecap.map(claim => {
    if (typeof claim.claim_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(claim.claim_id) ||
      seen.has(claim.claim_id) || typeof claim.claim_type !== "string" || !claim.claim_type.trim() || !Object.hasOwn(claim, "value"))
      throw new Error("website_candidate_context_claim_invalid");
    seen.add(claim.claim_id);
    const questionPt = `O website informa ${claimLabels[claim.claim_type]?.toLowerCase() ?? claim.claim_type}: ${valueText(claim.value)}. Qual é a informação correta?`;
    if (questionPt.length > 8192) throw new Error("website_candidate_context_question_too_large");
    return Object.freeze({ id: `candidate:${claim.claim_id}`, subject: claim.claim_type, questionPt,
      coverageRefs: Object.freeze([`discovery.candidate.${claim.claim_id.replaceAll("-", "")}`]) });
  }));
}
function validate({ stored, projection }: { stored: StoredWebsiteInterview; projection: WebsiteAgendaSeedProjection }): void {
  if (Buffer.byteLength(JSON.stringify(stored.agenda)) > MAX_SOURCE_BYTES || Buffer.byteLength(JSON.stringify(projection)) > MAX_SOURCE_BYTES)
    throw new Error("website_summary_source_size_exceeded");
  const parsed = parseOnboardingAgenda(stored.agenda, stored.agenda.binding);
  if (stored.revision !== parsed.revision || stored.digest !== onboardingAgendaDigest(parsed) ||
    !Number.isSafeInteger(stored.storeVersion) || stored.storeVersion < 0 || !stored.receiptId?.trim() || stored.state !== "reviewing")
    throw new Error("website_summary_store_receipt_invalid");
  if (!projectAgendaSummary(parsed).readyForSummary) throw new Error("website_summary_queue_not_exhausted");
  const { seedsHash, ...body } = projection;
  if (projection.version !== 1 || seedsHash !== digest(body)) throw new Error("website_summary_source_projection_changed");
  const binding = parsed.binding;
  for (const key of ["callId", "draftId", "draftHash", "sourceResultId", "sourceResultHash"] as const)
    if (projection.provenance[key] !== binding[key]) throw new Error(`website_summary_provenance_mismatch:${key}`);
  if (parsed.items.length !== projection.seeds.length || parsed.items.some((item, index) => {
    const { id, source, subject, questionPt, coverageRefs, relatedItemIds, blocking } = item;
    return digest({ id, source, subject, questionPt, coverageRefs, relatedItemIds, blocking }) !== digest(projection.seeds[index]);
  })) throw new Error("website_summary_seed_obligations_changed");
  if (digest(parsed.candidateContext) !== digest(buildWebsiteCandidateContext(projection)))
    throw new Error("website_summary_candidate_catalog_changed");
  if (Object.values(projection.provenance.authority).some(value => value !== false)) throw new Error("website_summary_source_claimed_authority");
}

const fieldLabels: Record<string, string> = {
  conditions: "condições", condition: "condição", service_type: "tipo de serviço", service_names: "serviços",
  public_price: "preço público", public_fee: "taxa pública", duration_minutes: "duração em minutos",
  notice_minutes: "antecedência em minutos", restriction_type: "restrição", rule: "regra publicada",
  after_hours: "fora do horário", closed_days: "dias fechados", emergency_24_7: "emergência 24 horas",
  holiday_policy: "feriados", ordinary_24_7: "atendimento comum 24 horas", ordinary_intervals: "horários comuns",
  timezone: "fuso horário", opens: "abre", closes: "fecha", days: "dias", guidance: "orientação",
  excluded_areas: "áreas excluídas", included_areas: "áreas incluídas", country_code: "país", kind: "tipo",
  name: "nome", region_state: "estado", radius: "raio", currency: "moeda", amount: "valor", qualifier: "qualificação",
};
const literalLabels: Record<string, string> = {
  mon: "segunda-feira", tue: "terça-feira", wed: "quarta-feira", thu: "quinta-feira", fri: "sexta-feira", sat: "sábado", sun: "domingo",
  emergency_only: "somente emergências", fee_applies: "taxa aplicável", conditional: "condicionado", starting_at: "a partir de", fixed: "fixo",
};
const claimLabels: Record<string, string> = {
  booking_restriction: "Restrição de agendamento", business_hours: "Horário de atendimento", business_description: "Descrição da empresa",
  service: "Serviço e condições publicadas", emergency: "Emergência", business_name: "Nome da empresa", public_phone: "Telefone público",
  service_territory: "Área de atendimento", public_email: "E-mail público", public_address: "Endereço público",
};
function valueText(value: unknown): string {
  if (value === null) return "não informado";
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("website_summary_nonfinite_candidate");
    return String(value);
  }
  if (typeof value === "string") {
    if (/<\/?[a-z][^>]*>/i.test(value)) throw new Error("website_summary_raw_html_not_allowed");
    return literalLabels[value] ?? value;
  }
  if (Array.isArray(value)) return value.length ? value.map(valueText).join("; ") : "nenhum informado";
  if (!value || typeof value !== "object") throw new Error("website_summary_invalid_candidate_value");
  const fields = Object.entries(value);
  if (fields.some(([key]) => /^(?:raw_html|html|raw_body|body_html|raw_website_body)$/.test(key))) throw new Error("website_summary_raw_html_not_allowed");
  const price = value as Record<string, unknown>;
  if (typeof price.currency === "string" && typeof price.amount === "string") {
    const qualifier = typeof price.qualifier === "string" ? `${valueText(price.qualifier)} ` : "";
    const remaining = fields.filter(([key]) => !["currency", "amount", "qualifier"].includes(key));
    return `${qualifier}${price.currency} ${price.amount}${remaining.length ? `; ${remaining.map(([key, nested]) => `${fieldLabels[key] ?? key}: ${valueText(nested)}`).join("; ")}` : ""}`;
  }
  return fields.map(([key, nested]) => `${fieldLabels[key] ?? key}: ${valueText(nested)}`).join("; ");
}

interface EvidenceGroup { evidence: OwnerTurnEvidence; items: AgendaItem[] }
function groups(items: readonly AgendaItem[], historical = false): EvidenceGroup[] {
  const result = new Map<string, EvidenceGroup>();
  for (const item of items) {
    const evidence = historical ? item.evidence.slice(0, -1) : item.evidence.slice(-1);
    for (const turn of evidence) {
      const group = result.get(turn.turnId) ?? { evidence: turn, items: [] };
      if (!group.items.some(existing => existing.id === item.id)) group.items.push(item);
      result.set(turn.turnId, group);
    }
  }
  return [...result.values()];
}
function questionList(items: AgendaItem[]): string {
  return items.map(item => `- ${item.questionPt}`).join("\n");
}
/** Keep every codepoint, including separators: joining returned parts with an
 * empty string reconstructs the exact complete summary. Prefer line/word breaks
 * but never truncate a long answer, financial condition or final evidence tail. */
function splitLosslessly(text: string): string[] {
  const codepoints = [...text];
  const parts: string[] = [];
  let start = 0;
  while (start < codepoints.length) {
    let end = Math.min(start + MAX_PART_CODEPOINTS, codepoints.length);
    if (end < codepoints.length) {
      const lowerBound = start + Math.floor(MAX_PART_CODEPOINTS / 2);
      let preferred = end;
      while (preferred > lowerBound && !/\s/.test(codepoints[preferred - 1]!)) preferred--;
      if (preferred > lowerBound) end = preferred;
    }
    parts.push(codepoints.slice(start, end).join("")); start = end;
  }
  return parts;
}

/** Pure persisted-evidence projection; never model memory or policy approval. */
export function generateWebsiteSummaryParts(input: {
  stored: StoredWebsiteInterview;
  projection: WebsiteAgendaSeedProjection;
}): string[] {
  validate(input);
  const { stored, projection } = input;
  const agenda = stored.agenda;
  const paragraphs: string[] = [
    "Resumo para sua revisão. Vou separar as informações candidatas do website, as decisões que você informou, suas correções e o que ainda depende de revisão. Este resumo não autoriza ativação, regras ou poderes.",
    "Informações candidatas do website. São registros da fonte original, não novas decisões do dono; uma correção efetiva do dono prevalece para a pergunta corrigida. A presença aqui não significa aprovação operacional.",
  ];
  projection.candidateRecap.forEach((claim, index) => {
    if (typeof claim.claim_type !== "string" || !Object.hasOwn(claim, "value")) throw new Error("website_summary_invalid_candidate_claim");
    const override = agenda.candidateOverrides.find(item => item.id === `candidate:${claim.claim_id}`);
    const historicalLabel = !override ? "" : override.status === "deferred_owner_review"
      ? "Informação original contestada; valor atual pendente de revisão. Este valor é apenas histórico, não uma decisão atual. "
      : override.status === "not_applicable"
        ? "Informação original declarada não aplicável pelo dono; preservada apenas como histórico. "
        : "Informação original substituída por correção do dono; preservada apenas como histórico. ";
    let text = `Candidata do website ${index + 1} de ${projection.candidateRecap.length}: ${historicalLabel}${claimLabels[claim.claim_type] ?? claim.claim_type}. ${valueText(claim.value)}.`;
    if (Array.isArray(claim.uncertainty) && claim.uncertainty.length) text += ` Incertezas da fonte: ${valueText(claim.uncertainty)}.`;
    if (claim.contradiction_status && claim.contradiction_status !== "none") text += ` Situação de contradição na fonte: ${valueText(claim.contradiction_status)}.`;
    if (Array.isArray(claim.contradictions) && claim.contradictions.length) text += ` Contradições registradas: ${valueText(claim.contradictions)}.`;
    paragraphs.push(text);
  });
  const allItems = getAgendaItems(agenda);
  const resolved = allItems.filter(item => ["answered", "corrected", "not_applicable"].includes(item.status));
  const effective = groups(resolved);
  const quoted = new Set<string>();
  const sections = [
    { title: "Correções efetivas do dono", match: (group: EvidenceGroup) => group.items.some(item => item.status === "corrected") },
    { title: "Informações privadas confirmadas pelo dono", match: (group: EvidenceGroup) => group.items.some(item => item.source === "owner_private_requirement" && item.status === "answered") },
    { title: "Informações confirmadas pelo dono", match: (group: EvidenceGroup) => group.items.some(item => item.status === "answered") },
    { title: "Não aplicável, segundo o dono", match: (group: EvidenceGroup) => group.items.some(item => item.status === "not_applicable") },
  ];
  for (const section of sections) {
    const selected = effective.filter(group => !quoted.has(group.evidence.turnId) && section.match(group));
    if (!selected.length) continue;
    paragraphs.push(`${section.title}. As palavras abaixo são evidência do que foi informado; a materialização de regras ainda exige validação e aprovação próprias.`);
    for (const group of selected) {
      paragraphs.push(`Perguntas abrangidas por este mesmo depoimento:\n${questionList(group.items)}\nResposta literal do dono: “${group.evidence.text}”`);
      quoted.add(group.evidence.turnId);
    }
  }
  const corrected = allItems.filter(item => item.status === "corrected" && item.answerRevision > 1);
  // Earlier evidence is explicitly historical, never silently promoted to a
  // previous approved fact: the agenda does not store each earlier proposal kind.
  const historical = groups(corrected, true);
  if (historical.length) {
    paragraphs.push("Histórico substituído: não é uma decisão atual. Estes depoimentos anteriores foram superados para as perguntas indicadas; não devem ser executados como a correção atual.");
    for (const group of historical) {
      paragraphs.push(`Perguntas com registro anterior substituído:\n${questionList(group.items)}\n${quoted.has(group.evidence.turnId)
        ? "Depoimento já citado para outras perguntas; foi substituído somente para as perguntas acima."
        : `Registro literal anterior, apenas histórico: “${group.evidence.text}”`}`);
      quoted.add(group.evidence.turnId);
    }
  }
  const deferred = allItems.filter(item => item.status === "deferred_owner_review");
  if (deferred.length) {
    paragraphs.push(`Pendências para revisão do dono. Estas ${deferred.length} informações permanecem desconhecidas ou sem autorização. Tentativas de esclarecimento, pedidos fora do escopo e adiamentos não são respostas confirmadas.`);
    paragraphs.push(questionList(deferred));
  }
  const blockers = projectAgendaSummary(agenda).activationBlockingUnknowns.length;
  paragraphs.push(blockers
    ? `A entrevista pode ser revisada e encerrada, mas ainda existem ${blockers} pendências que bloqueiam a ativação das ações correspondentes. Encerrar a entrevista não concede essas permissões nem transforma candidatos do website em regras aprovadas.`
    : "A fila de perguntas foi revisada. Ainda será necessária sua confirmação explícita deste resumo; nenhuma permissão operacional é concedida apenas por esta leitura.");
  return splitLosslessly(paragraphs.join("\n\n"));
}
