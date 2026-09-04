import type { AgendaCandidateContext, AgendaSeed } from "./onboarding-agenda.ts";

// All spoken guidance is finite application text; source/question/owner strings
// select a definition but are never interpolated into it.
const FIELD_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  "area.coverage": "Área atendida é a lista exata de cidades; exceções fora dessa lista são uma decisão separada.",
  "area.out_of_area_policy": "A política fora da área define se um pedido deve ser recusado ou encaminhado para uma exceção aprovada pelo dono.",
  "area.travel_fee": "Taxa de deslocamento é uma cobrança pelo trajeto, separada do preço do serviço e da permissão para atender fora da área.",
  "service.catalog_closure": "Já usamos os serviços identificados no website; esta confirmação verifica se a lista está completa e correta.",
  "service.name_synonyms": "São os nomes e apelidos que os clientes usam para identificar esse mesmo serviço.",
  "service.price_mode": "Modo de preço indica se o valor é fixo, a partir de, estimado ou depende de análise do dono, preservando suas condições.",
  "service.price_target": "Preço público é o valor informado ao cliente com suas condições; ele não é o mínimo privado de negociação.",
  "service.negotiation": "O mínimo de negociação é privado e só se aplica quando você permite negociar, sem alterar automaticamente o preço público.",
  "service.duration": "Duração é o tempo gasto em um atendimento desse serviço, não o horário de abertura da empresa.",
  "service.inclusions_exclusions": "Inclusões e exclusões separam o que faz parte do serviço do que fica fora dele ou exige outro orçamento.",
  "service.materials_parts": "Aqui distinguimos quais materiais e peças estão incluídos, quem os fornece e como tratar peças trazidas pelo cliente.",
  "service.warranty": "Garantia deste serviço reúne quem a oferece, o que cobre, suas condições e o que fica excluído.",
  "service.emergency_eligibility": "Essa informação indica se o serviço pode ser tratado como emergência, não se o Ligou pode confirmá-lo sozinho.",
  "service.escalation": "Encaminhar ao dono significa aguardar sua decisão antes de confirmar a ação que depende de aprovação.",
  "schedule.business_hours": "Horário comercial define dias, horas e fuso do atendimento normal; duração de serviço e emergências fora desse horário são separados.",
  "schedule.same_day_lead_time": "Essa regra separa atendimento no mesmo dia da antecedência mínima necessária, sem prometer disponibilidade.",
  "schedule.capacity_buffer": "Capacidade e intervalo definem quantos atendimentos cabem na agenda e a margem necessária entre eles.",
  "schedule.reschedule_cancel": "Essa política define como tratar remarcação, cancelamento e ausência, sem presumir autorização para cobrar uma taxa.",
  "schedule.holidays": "Feriados podem ter uma regra diferente dos dias normais; registramos funcionamento e eventuais restrições.",
  "emergency.types": "Tipos de emergência são as situações que sua empresa considera urgentes, separadas da autorização para aceitar o atendimento.",
  "emergency.safety_escalation": "Aqui registramos as instruções de segurança e para quem encaminhar situações de risco, sem inventar orientações.",
  "emergency.after_hours": "Atendimento fora do horário é separado do expediente normal e precisa de regras próprias de disponibilidade e aprovação.",
  "emergency.fee_authority": "Uma taxa publicada não dá permissão para confirmá-la ou cobrá-la; aqui registramos quem decide e quais aprovações são necessárias.",
  "policy.payment_estimate": "Essa política distingue formas de pagamento, depósitos e condições de orçamento da autorização para cobrar.",
  "policy.warranty_materials": "Garantia e peças do cliente são assuntos diferentes: registramos a cobertura e como tratar materiais fornecidos pelo cliente.",
  "policy.access_cancellation": "Essa política trata de acesso impossível, visita e cancelamento, mantendo qualquer cobrança sujeita à autorização definida.",
  "policy.complaints_returns": "Aqui registramos como encaminhar reclamações, retornos ou retrabalho, sem prometer reembolso ou nova visita automaticamente.",
  "business.customer_types": "Tipos de clientes distinguem atendimento residencial, comercial ou ambos.",
  "business.excluded_work": "Trabalhos excluídos são serviços que a empresa não realiza e que o Ligou não deve prometer.",
  "business.languages_tone": "Esta informação define a apresentação, o tom e os idiomas usados no atendimento.",
  "authority.quote_price": "Informar um preço é comunicá-lo ao cliente; negociar descontos, cobrar e agendar são permissões separadas.",
  "authority.negotiate_floor": "O mínimo de negociação é privado e só se aplica quando você permite negociar, sem alterar automaticamente o preço público.",
  "authority.read_calendar": "Consultar a agenda permite apenas ver disponibilidade; não significa autorizar agendamentos ou alterações.",
  "authority.book": "A pergunta distingue consultar horários de confirmar um compromisso com o cliente, que exige uma permissão própria.",
  "authority.reschedule_cancel": "Remarcar e cancelar alteram um compromisso existente e precisam de autorização própria, separada da consulta da agenda.",
  "authority.charge_fee": "Uma taxa publicada não dá permissão para confirmá-la ou cobrá-la; aqui registramos quem decide e quais aprovações são necessárias.",
  "authority.emergency": "Autonomia em emergências define o que depende da sua aprovação; urgência não concede permissão automaticamente.",
  "authority.out_of_area": "Essa autorização trata de exceções fora das cidades atendidas e não amplia automaticamente a área de atendimento."
});
const SOURCE_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  "candidate": "Essa informação veio do website e está sendo corrigida; registraremos sua versão para revisão, sem tratar o texto do site como sua confirmação.",
  "timezone": "Fuso horário é a referência de hora local usada para interpretar a agenda e os horários de atendimento.",
  "warranty": "Precisamos separar quem oferece a garantia, o que ela cobre, suas condições e o que fica excluído.",
  "public_fee": "Taxa extra é uma cobrança além do valor normal; sua existência e a autorização para confirmá-la ou cobrá-la são informações separadas.",
  "cancellation": "Essa política reúne cancelamento, reagendamento, depósito e ausência, sem presumir autorização para aplicar uma cobrança.",
  "contradiction_hours": "O website apresenta versões diferentes sobre o funcionamento; registraremos a regra correta informada por você.",
  "contradiction": "Há versões diferentes dessa informação no website; sua resposta deve esclarecer qual delas vale ou qual é a correção.",
  "generic": "Esta pergunta registra uma informação necessária para o atendimento; sua resposta será guardada para revisão, sem criar autorização automática."
});
const SOURCE_RULES: readonly (readonly [RegExp, string])[] = [["fuso horario|timezone","timezone"],["garant|warrant","warranty"],["cidades|territorio|limites.*atendimento","area.coverage"],["taxa|fee","public_fee"],["cancel|reagend|remarc|deposit|comparecimento","cancellation"],["feriad|holiday","schedule.holidays"],["horario|sabado|domingo|mon.sat|saturday","contradiction_hours"],["contrad|conflit|diverg","contradiction"],["preco|price","service.price_target"]].map(([pattern, key]) => [new RegExp(pattern), key] as const);
const APPROVAL_PREFIX = Object.freeze({
  "off_scope": "Podemos tratar desse pedido depois; agora precisamos revisar e concluir seu onboarding.",
  "explanation": "O resumo reúne o que você confirmou e separa o que ficou pendente; diga qual informação precisa corrigir ou confirme se está correto.",
  "meaning": "Aqui, confirmar é dizer que o resumo está correto; se algo estiver errado, indique a informação que precisa mudar."
});
const OFF_SCOPE = new RegExp("escreva|redija|propaganda|texto.*(site|script|anuncio)|(manda|mande|crie|cria).*texto|(crie|cria|monte|faca).*(anuncio|campanha|postagem|post para|logo)");
const EXPLANATION = new RegExp("o que significa|pode explicar|poderia explicar|explique|me explica|nao entendi|o que voce quer dizer|como funciona (a |essa |esta )?(aprovacao|confirmacao)|que resumo");

// Mirrored exactly by SQL proposal website_guidance_normalize, including NFD
// combining-mark removal and ASCII whitespace folding without unaccent.
function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[\t\n\v\f\r]/g, " ").replace(/ +/g, " ").replace(/^ +| +$/g, "");
}

/** Definition only: caller appends the unchanged stored question/action. */
export function websiteQuestionGuidance(item: AgendaSeed | AgendaCandidateContext): string {
  if (item.id.startsWith("candidate:") || item.coverageRefs.some(ref => ref.startsWith("discovery.candidate."))) return SOURCE_GUIDANCE.candidate!;
  const fields = item.coverageRefs.map(ref => ref.slice(ref.lastIndexOf(":") + 1));
  const typed = fields.find(field => Object.hasOwn(FIELD_GUIDANCE, field));
  if (typed) return FIELD_GUIDANCE[typed]!;
  if (fields.some(field => field.startsWith("discovery.owner_question."))) {
    const question = normalize(item.questionPt);
    const rule = SOURCE_RULES.find(([pattern]) => pattern.test(question));
    if (rule) return FIELD_GUIDANCE[rule[1]] ?? SOURCE_GUIDANCE[rule[1]]!;
  }
  return SOURCE_GUIDANCE.generic!;
}

/** Prefix only for a bounded approval retry; never classifies assent or
 * correction, changes the fixed approval question, or grants authority. */
export function websiteApprovalClarification(ownerText: string): string {
  const text = normalize(ownerText);
  if (OFF_SCOPE.test(text)) return APPROVAL_PREFIX.off_scope;
  if (EXPLANATION.test(text)) return APPROVAL_PREFIX.explanation;
  return APPROVAL_PREFIX.meaning;
}
