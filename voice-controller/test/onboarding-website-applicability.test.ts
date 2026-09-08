import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/foghorn-website-first-voice.json";
import { buildWebsiteAgendaSeeds } from "../src/onboarding-agenda-seed.ts";
import { applyVerifiedOwnerTurn, createOnboardingAgenda, getAgendaAction, type AgendaProposal, type OnboardingAgenda } from "../src/onboarding-agenda.ts";
import { retainSupportedWebsiteAnswerTargets, validateWebsiteAnswerApplicability } from "../src/onboarding-website-applicability.ts";
import { buildWebsiteOpeningAction, createWebsiteAgendaCoordinator, parseWebsiteInterpretation, reduceWebsiteAgenda, type WebsiteAgendaCommand, type WebsiteAgendaEvent } from "../src/onboarding-agenda-coordinator.ts";
import { onboardingAgendaDigest, type StoredWebsiteInterview } from "../src/onboarding-agenda-store.ts";
import type { CoverageSnapshot } from "../src/onboarding-coverage.ts";
import type { StreamAuthorization } from "../src/onboarding-stream.ts";
import { websiteInterpretationRequest } from "../src/onboarding-website-runtime.ts";

const { tenant_id: _tenant, ...draftReadback } = fixture.draft_row;
const projection = buildWebsiteAgendaSeeds({ draftReadback, initialCoverage: fixture.initial_coverage.snapshot as CoverageSnapshot });
const binding = { interviewId: "1c7a37be-c8a0-456e-a1a1-9b937bd0ef4a", callId: projection.provenance.callId, draftId: projection.provenance.draftId, draftHash: projection.provenance.draftHash, sourceResultId: projection.provenance.sourceResultId, sourceResultHash: projection.provenance.sourceResultHash };
const WARRANTY = "2a19450a-5492-480b-84cc-9f8a1687cf49";
const originalWarranty = "Garantias vêm dos fabricantes e dos instaladores que a gente usa. Cobre defeitos de fabricação e de instalação, mas não cobre mau uso nem modificações de terceiros.";
const allWarranty = `${originalWarranty} Essa mesma garantia vale para todos os serviços.`;
const byRef = (ref: string) => projection.seeds.find(item => item.coverageRefs.includes(ref))!;
const familyIds = (field: string) => projection.seeds.filter(item => item.coverageRefs.some(ref => ref.endsWith(`:${field}`))).map(item => item.id);
function at(id: string): OnboardingAgenda {
  let agenda = createOnboardingAgenda(binding, projection.seeds);
  while (getAgendaAction(agenda).itemId !== id) {
    const itemId = getAgendaAction(agenda).itemId!;
    agenda = applyVerifiedOwnerTurn(agenda, { type: "verified_owner_turn", binding, turnId: `setup-${agenda.revision}`, text: "Revisarei depois (preparação sintética de teste).", proposal: { kind: "defer", itemId } }).agenda;
  }
  return agenda;
}
const answer = (itemId: string, relatedItemIds: string[] = []): AgendaProposal => ({ kind: "answer", itemId, relatedItemIds });
const recordedStreamingTerritory = "Hum, olha, atendi só novato, San Rafael e Petaluma, nada além dessas três. Já teve pedido de gente de outras cidades, mas não é pra atender. Se pintar alguma coisa fora, é só com aprovação explícita do dono, combinado?";
const recordedNumberedTerritory = "1, olha, atendi só novato, San Rafael e Petaluma. Nada além dessas três. Já teve pedido de gente de outras cidades, mas não é pra atender. Se pintar alguma coisa fora, é só com aprovação explícita do dono, combinado?";
const recordedNegotiationDenial = "Não autorizo negociação ou meia desconto automático em nenhum serviço, não há mínimo privado liberado para o Uligol. Qualquer exceção de preço precisa da minha aprovação explícita antes de ser apresentada ao cliente.";
function checked(agenda: OnboardingAgenda, text: string, proposal: AgendaProposal) {
  return validateWebsiteAnswerApplicability({ agenda, currentItemId: getAgendaAction(agenda).itemId!, ownerTranscript: text, proposal });
}

describe("verified owner answer applicability", () => {
  test.each(['missing_target','current_target','outside_related_graph','resolved_target'])(
    'target rejection reports only its fixed eligibility reason: %s',reason=>{
      const item=byRef('area.coverage'),agenda=structuredClone(at(item.id));
      let targetId=item.relatedItemIds[0];
      if(reason==='missing_target')targetId='missing-item';
      if(reason==='current_target')targetId=item.id;
      if(reason==='outside_related_graph')targetId=byRef('authority.out_of_area').id;
      if(reason==='resolved_target')agenda.items.find(i=>i.id===targetId)!.status='answered';
      try{checked(agenda,recordedStreamingTerritory,answer(item.id,[targetId]));throw new Error('expected rejection');}
      catch(error){expect((error as Error).message).toBe('website_applicability_target_not_eligible');
        expect((error as {eligibilityRejectReason:string}).eligibilityRejectReason).toBe(reason);
        expect(Object.keys(error as object)).toEqual(['eligibilityRejectReason']);}
    });

  test('optional target admission keeps unsupported coverage open without changing the durable validator',()=>{
    const item=byRef('area.coverage'),agenda=at(item.id),proposal=answer(item.id,[...item.relatedItemIds]);
    const ownerTranscript='Hã, atendi só Recife e Olinda. Fora dessas cidades, não é para atender.';
    const input={agenda,currentItemId:item.id,ownerTranscript,proposal};
    expect(()=>validateWebsiteAnswerApplicability(input)).toThrow('website_applicability_owner_evidence_missing');
    const narrowed=retainSupportedWebsiteAnswerTargets(input);
    expect(narrowed).toEqual(answer(item.id,[]));expect(proposal).toEqual(answer(item.id,[...item.relatedItemIds]));
    expect(validateWebsiteAnswerApplicability({...input,proposal:narrowed})).toEqual(narrowed);
    expect(retainSupportedWebsiteAnswerTargets({...input,ownerTranscript:recordedNumberedTerritory})).toEqual(proposal);
  });

  test.each(['duplicate','outside_graph','resolved','private_primary','private_target','authority_target','unsafe_scope'])(
    'optional target admission still rejects %s',kind=>{
      const item=byRef('area.coverage'),agenda=structuredClone(at(item.id)),target=agenda.items.find(i=>i.id===item.relatedItemIds[0])!;
      const proposal=answer(item.id,[...item.relatedItemIds]) as Extract<AgendaProposal,{kind:'answer'}>;
      let ownerTranscript='Hã, atendi só Recife e Olinda. Fora dessas cidades, não é para atender.';
      if(kind==='duplicate')proposal.relatedItemIds!.push(target.id);
      if(kind==='outside_graph')proposal.relatedItemIds!.push(byRef('authority.out_of_area').id);
      if(kind==='resolved')target.status='answered';
      if(kind==='private_primary')agenda.items.find(i=>i.id===item.id)!.source='owner_private_requirement';
      if(kind==='private_target')target.source='owner_private_requirement';
      if(kind==='authority_target')target.coverageRefs=['authority.out_of_area'];
      if(kind==='unsafe_scope')ownerTranscript='Talvez atendi só Recife e Olinda.';
      expect(()=>retainSupportedWebsiteAnswerTargets({agenda,currentItemId:item.id,ownerTranscript,proposal})).toThrow();
    });

  test.each([recordedStreamingTerritory,recordedNumberedTerritory])("recorded streaming ASR resolves only the two territory questions and preserves exact evidence: %s", (recordedStreamingTerritory) => {
    const item = byRef("area.coverage"), agenda = at(item.id);
    const related = "92b3f78b-12b9-4f1d-81f2-db03bc2c0732";
    expect(item.relatedItemIds).toEqual([related]);
    const proposal = checked(agenda, recordedStreamingTerritory, answer(item.id, [related]));
    const result = applyVerifiedOwnerTurn(agenda, { type: "verified_owner_turn", binding, turnId: "recorded-stream-territory", text: recordedStreamingTerritory, proposal });
    expect(result.accepted).toBe(true);
    const changed = result.agenda.items.filter(target => target.evidence.at(-1)?.turnId === "recorded-stream-territory");
    expect(changed.map(target => target.id)).toEqual([item.id, related]);
    expect(changed.every(target => target.status === "answered" && target.evidence.at(-1)?.text === recordedStreamingTerritory)).toBe(true);
    expect(result.action?.itemId).toBe("ff9fa80b-12d5-4afa-85e2-a17a937aceca");
    for (const field of ["area.out_of_area_policy", "authority.out_of_area"]) {
      expect(result.agenda.items.find(target => target.coverageRefs.includes(field))!.status).toBe("open");
      expect(() => checked(agenda, recordedStreamingTerritory, answer(item.id, [related, byRef(field).id]))).toThrow("website_applicability_target_not_eligible");
    }
  });

  test.each([recordedStreamingTerritory,recordedNumberedTerritory])("the streaming coordinator persists exact territory evidence without an interpreter retry: %s", (recordedStreamingTerritory) => {
    const item = byRef("area.coverage"), agenda = at(item.id);
    const stored: StoredWebsiteInterview = { agenda, revision: agenda.revision, storeVersion: 0, digest: onboardingAgendaDigest(agenda), receiptId: "receipt", nextAction: getAgendaAction(agenda), state: "unfinished", replayed: false };
    const id = (n: number) => `79000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const openingStream: StreamAuthorization = { schema: "onboarding.stream.v1", action: buildWebsiteOpeningAction(stored, "Foghorn Air"), dispatchId: id(1), receiptId: id(2) };
    let state = createWebsiteAgendaCoordinator(stored, { nowMs: 0, openingAction: openingStream.action, openingStream });
    let commands: WebsiteAgendaCommand[] = [];
    let nowMs = 1;
    const event = (value: Record<string, unknown>) => { const result = reduceWebsiteAgenda(state, { ...value, nowMs: nowMs++ } as WebsiteAgendaEvent); state = result.state; commands = result.commands; };
    event({ type: "stream.played", actionId: openingStream.action.actionId, dispatchId: openingStream.dispatchId, status: "played", responseId: "opening-response", itemId: "opening-item", generationReceiptId: id(3), playoutReceiptId: id(4), receiptId: id(5) });
    event({ type: "owner.transcript", providerItemId: "recorded-stream-territory", text: recordedStreamingTerritory });
    const record = commands.find(command => command.type === "record_owner_turn") as Extract<WebsiteAgendaCommand, { type: "record_owner_turn" }>;
    event({ type: "owner_turn.recorded", requestId: record.requestId, providerItemId: record.providerItemId, turnId: record.turnId, text: recordedStreamingTerritory });
    const interpret = commands.find(command => command.type === "interpret_owner_turn") as Extract<WebsiteAgendaCommand, { type: "interpret_owner_turn" }>;
    event({ type: "interpretation.created", requestId: interpret.requestId, responseId: "territory-response" });
    event({ type: "interpretation.completed", requestId: interpret.requestId, responseId: "territory-response", turnId: interpret.turnId, itemId: interpret.itemId, digest: interpret.digest, result: { proposal: answer(item.id, [...item.relatedItemIds]), facts: [] } });
    const persist = commands.find(command => command.type === "persist_agenda") as Extract<WebsiteAgendaCommand, { type: "persist_agenda" }>;
    expect(persist).toBeDefined();
    expect(persist.facts).toEqual([]);
    expect(persist.ownerTranscript).toBe(recordedStreamingTerritory);
    expect(persist.nextAction.itemId).toBe("ff9fa80b-12d5-4afa-85e2-a17a937aceca");
    expect(commands.some(command => ["interpret_owner_turn", "persist_approval", "terminate_session"].includes(command.type))).toBe(false);
    expect(state.stored.agenda).toEqual(agenda); // Progress waits for the actual commit receipt.
  });

  test.each([
    "Atendi somente Recife e Olinda. Fora dessas cidades, não é para atender.",
    "Eu atendi apenas Santos e Guarujá. Quando chegar um pedido fora, será somente com minha autorização explícita.",
    "Olha, atendi só Curitiba e Pinhais. Se surgir alguma demanda fora, é apenas com aprovação explícita do proprietário.",
    "2. Olha, atendi só Curitiba e Pinhais. Se surgir alguma demanda fora, é apenas com aprovação explícita do proprietário.",
  ])("past-tense ASR needs an explicit present or future outside-area restriction: %s", text => {
    const item = byRef("area.coverage");
    expect(checked(at(item.id), text, answer(item.id, [...item.relatedItemIds]))).toEqual(answer(item.id, [...item.relatedItemIds]));
  });

  test.each([
    "Atendi só Recife e Olinda.",
    "Atendi só Recife e Olinda. Nada além dessas duas.",
    "Ontem atendi só Recife e Olinda. Se chegar algo fora, é só com minha aprovação.",
    "1, olha, ontem atendi só Recife e Olinda. Se chegar algo fora, é só com minha aprovação.",
    "2. Não atendi só Recife e Olinda. Fora dessas cidades, não é para atender.",
    "Atendi só Recife e Olinda no ano passado. Fora dessas cidades, não é para atender.",
    "Atendi só Recife e Olinda. Fora dessas cidades, era só com minha aprovação.",
    "Não atendi só Recife e Olinda. Se chegar algo fora, é só com minha aprovação.",
    "Eu nunca atendi só Recife e Olinda. Fora dessas cidades, não é para atender.",
    "Atendi só Recife e Olinda. Talvez essa seja nossa área. Se chegar algo fora, é só com minha aprovação.",
    "Atendi só Recife e Olinda. Não tenho certeza da área atual. Se chegar algo fora, é só com minha aprovação.",
    "Atendi só Recife e Olinda. Se chegar algo fora, não é só com minha aprovação.",
    "Atendi só Recife e Olinda. Se chegar algo fora, é só com minha aprovação?",
    "O site diz: “Atendi só Recife e Olinda”. Fora dessas cidades, não é para atender.",
  ])("historical, negated, uncertain or quoted coverage cannot close a related question: %s", text => {
    const item = byRef("area.coverage"), agenda = at(item.id);
    const before = JSON.stringify(agenda);
    expect(() => checked(agenda, text, answer(item.id, [...item.relatedItemIds]))).toThrow();
    expect(JSON.stringify(agenda)).toBe(before);
  });

  test.each([
    "Quando eu estiver fora, será somente com minha autorização explícita.",
    "Se o gerente estiver fora, é só com aprovação explícita do dono.",
    "Quando chegar o gerente fora, será somente com minha autorização explícita.",
  ])("staff availability is not an outside-territory policy: %s", condition => {
    const item = byRef("area.coverage"), agenda = at(item.id);
    const before = JSON.stringify(agenda);
    expect(() => checked(agenda, `Atendi só Recife e Olinda. ${condition}`, answer(item.id, [...item.relatedItemIds])))
      .toThrow("website_applicability_owner_evidence_missing");
    expect(agenda.items.filter(target => item.relatedItemIds.includes(target.id)).every(target => target.status === "open" && target.evidence.length === 0)).toBe(true);
    expect(JSON.stringify(agenda)).toBe(before);
  });

  test('the September 6 territory answer can resolve related territory gaps despite its polite combinado tag',()=>{
    const item=byRef('area.coverage'),agenda=at(item.id);
    const text='Olha, atende só Novato, San Rafael e Petaluma. Nada além dessas três. Já teve pedido de gente de outras cidades, mas não é pra atender. Se pintar alguma coisa fora, é só com aprovação explícita do dono, combinado?';
    const proposal=checked(agenda,text,answer(item.id,[...item.relatedItemIds]));
    const result=applyVerifiedOwnerTurn(agenda,{type:'verified_owner_turn',binding,turnId:'september6-territory',text,proposal});
    expect(result.agenda.items.filter(item=>item.evidence.at(-1)?.turnId==='september6-territory')).toHaveLength(2);
    expect(result.action?.itemId).toBe('ff9fa80b-12d5-4afa-85e2-a17a937aceca');
    for(const uncertain of ['Talvez atendamos somente Novato, combinado?','Você acha que devemos atender somente essas cidades? Combinado?','O site diz: “Atendemos somente Novato”, combinado?'])
      expect(()=>checked(agenda,uncertain,answer(item.id,[...item.relatedItemIds]))).toThrow();
  });
  test("exact Foghorn obligations unchanged; explicit universal warranty answers eleven with identical evidence", () => {
    expect(projection.seeds).toHaveLength(114);
    expect(projection.coverageObligations.filter(item => item.disposition === "ask")).toHaveLength(115);
    expect(projection.sourceItems).toHaveLength(16);
    expect(projection.candidateRecap).toEqual(draftReadback.draft.candidate_facts);
    const agenda = at(WARRANTY);
    const proposal = checked(agenda, allWarranty, answer(WARRANTY, familyIds("service.warranty")));
    const result = applyVerifiedOwnerTurn(agenda, { type: "verified_owner_turn", binding, turnId: "warranty-all", text: allWarranty, proposal });
    expect(result.accepted).toBe(true);
    const changed = result.agenda.items.filter(item => item.evidence.at(-1)?.turnId === "warranty-all");
    expect(changed).toHaveLength(11);
    expect(changed.every(item => item.status === "answered" && item.evidence.at(-1)?.text === allWarranty)).toBe(true);
    expect(result.agenda.items.find(item => item.coverageRefs.includes("policy.warranty_materials"))!.status).toBe("open");
    expect(result.agenda.items.filter(item => item.coverageRefs.some(ref => ref.endsWith(":service.materials_parts"))).every(item => item.status === "open")).toBe(true);
  });

  test("actual forensic warranty without universal scope answers current only, not ten future warranties", () => {
    const agenda = at(WARRANTY);
    expect(checked(agenda, originalWarranty, answer(WARRANTY))).toEqual(answer(WARRANTY));
    expect(() => checked(agenda, originalWarranty, answer(WARRANTY, familyIds("service.warranty")))).toThrow();
  });

  test.each([
    "A garantia de um ano vale para quase todos os serviços.",
    "Não são todos os serviços que têm garantia de um ano.",
    "A garantia de um ano vale para praticamente todos os serviços.",
    "A garantia de um ano vale para a maioria dos serviços, não para todos os serviços.",
    "A garantia de um ano vale para a maior parte dos serviços, não para todos os serviços.",
    "A garantia de um ano vale para todos os serviços menos instalação de bombas de calor.",
    "A garantia de um ano não é para todos os serviços.",
    "A garantia de um ano não é válida para todos os serviços.",
    "A garantia de um ano não abrange todos os serviços.",
  ])("partial or negated universal scope cannot close related service warranties: %s", text => {
    const agenda = at(WARRANTY);
    const before = JSON.stringify(agenda);
    expect(() => checked(agenda, text, answer(WARRANTY, familyIds("service.warranty")))).toThrow();
    expect(JSON.stringify(agenda)).toBe(before);
  });

  test("fully explicit universal scope remains valid and private negation is not negated scope", () => {
    const warranty = answer(WARRANTY, familyIds("service.warranty"));
    expect(checked(at(WARRANTY), "A garantia de um ano vale para todos os serviços.", warranty)).toEqual(warranty);
    const current = byRef("authority.negotiate_floor").id;
    const restricted = answer(current, familyIds("service.negotiation"));
    expect(checked(at(current), "Não pode negociar preços para todos os serviços; a negociação depende da minha aprovação explícita.", restricted)).toEqual(restricted);
  });

  test.each([
    `${originalWarranty} Isso não vale para todos os serviços.`,
    `${originalWarranty} Essa garantia vale para todos os serviços?`,
    `O site diz: “${allWarranty}”`,
    `${allWarranty} Exceto instalação de bombas de calor.`,
    "Isso vale para todos os serviços.",
    "Talvez a garantia cubra todos os serviços.",
    `${originalWarranty} Não estou dizendo que essa garantia vale para todos os serviços.`,
    `${originalWarranty} A duração é de uma hora para todos os serviços.`,
  ])("rejects unsafe global scope atomically: %s", text => {
    const agenda = at(WARRANTY);
    expect(() => checked(agenda, text, answer(WARRANTY, familyIds("service.warranty")))).toThrow();
    expect(agenda.items.find(item => item.id === WARRANTY)!.status).toBe("open");
  });

  test("warranty does not resolve the compound customer-materials policy without actual materials content", () => {
    const agenda = at(WARRANTY);
    const target = byRef("policy.warranty_materials").id;
    expect(() => checked(agenda, allWarranty, answer(WARRANTY, [target]))).toThrow();
    expect(checked(agenda, `${allWarranty} As peças e materiais são fornecidos por nós, não usamos peças do cliente.`, answer(WARRANTY, [target]))).toEqual(answer(WARRANTY, [target]));
  });

  test("service duration scope never imports business hours or another service field", () => {
    const ids = familyIds("service.duration");
    const agenda = at(ids[0]);
    const text = "A duração é de uma hora para todos os serviços.";
    expect(checked(agenda, text, answer(ids[0], ids.slice(1)))).toEqual(answer(ids[0], ids.slice(1)));
    expect(() => checked(agenda, "Todos os serviços funcionam de segunda a sábado das oito às cinco.", answer(ids[0], ids.slice(1)))).toThrow();
    expect(() => checked(agenda, text, answer(ids[0], [byRef("schedule.business_hours").id]))).toThrow();
  });

  test("named restrictive private actions can share evidence; unstated read-calendar and negotiation cannot", () => {
    const current = byRef("authority.quote_price").id;
    const agenda = at(current);
    const text = "Não pode informar preços sem minha aprovação explícita. Não pode agendar sem minha aprovação explícita. Nenhuma taxa pode ser confirmada ou cobrada sem minha aprovação explícita.";
    const allowed = [byRef("authority.book").id, byRef("authority.charge_fee").id, byRef("emergency.fee_authority").id];
    expect(checked(agenda, text, answer(current, allowed))).toEqual(answer(current, allowed));
    for (const field of ["authority.read_calendar", "authority.negotiate_floor", "authority.out_of_area", "authority.emergency"]) {
      expect(() => checked(agenda, text, answer(current, [...allowed, byRef(field).id]))).toThrow();
    }
  });

  test.each([
    "Não pode informar preços sem minha aprovação. Não preciso aprovar agendamentos.",
    "Não pode informar preços sem minha aprovação. Não pode cobrar taxas e pode agendar.",
    "Não pode informar preços sem minha aprovação. O site diz que agendamentos exigem minha aprovação.",
  ])("opposite-direction or quoted private statements cannot masquerade as restrictions: %s", text => {
    const current = byRef("authority.quote_price").id;
    expect(() => checked(at(current), text, answer(current, [byRef("authority.book").id]))).toThrow();
  });

  test("universal restrictive negotiation is explicit, never inferred from no automatic quoting", () => {
    const current = byRef("authority.negotiate_floor").id;
    const agenda = at(current);
    const targets = familyIds("service.negotiation");
    expect(checked(agenda, "Não negociamos preços nem damos descontos. Essa regra vale para todos os serviços.", answer(current, targets))).toEqual(answer(current, targets));
    expect(() => checked(agenda, "Não pode informar preços automaticamente para todos os serviços.", answer(current, targets))).toThrow();
  });

  test.each([
    recordedNegotiationDenial,
    "Não autorizo negociação ou desconto automático em nenhum serviço.",
    "Eu não autorizo a negociação em nenhum serviço.",
    "Não autorizo negociação. Essa regra vale para todos os serviços.",
  ])("direct owner negotiation denial retains literal evidence for the ten related services: %s", text => {
    const current=byRef('authority.negotiate_floor').id,agenda=at(current),targets=familyIds('service.negotiation');
    expect(targets).toHaveLength(10);
    const proposal=checked(agenda,text,answer(current,targets));
    const transition=applyVerifiedOwnerTurn(agenda,{type:'verified_owner_turn',binding,turnId:'recorded-negotiation-denial',text,proposal});
    expect(transition.accepted).toBe(true);expect(transition.agenda.revision).toBe(agenda.revision+1);
    expect(transition.agenda.items.filter(item=>item.status==='answered')).toHaveLength(11);
    for(const id of [current,...targets])expect(transition.agenda.items.find(item=>item.id===id)?.evidence.at(-1)).toEqual({turnId:'recorded-negotiation-denial',text});
    for(const field of ['authority.book','authority.charge_fee','authority.read_calendar']){
      const id=byRef(field).id;
      expect(transition.agenda.items.find(item=>item.id===id)).toEqual(agenda.items.find(item=>item.id===id));
    }
  });

  test('the pure builder offers all ten negotiation services for the recorded universal denial',()=>{
    const current=byRef('authority.negotiate_floor').id,agenda=at(current),targets=familyIds('service.negotiation');
    const stored:StoredWebsiteInterview={agenda,revision:agenda.revision,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:'receipt',nextAction:getAgendaAction(agenda),state:'unfinished',replayed:false};
    let state=createWebsiteAgendaCoordinator(stored,{nowMs:0});state=reduceWebsiteAgenda(state,{type:'opening.played',nowMs:1}).state;
    let reduced=reduceWebsiteAgenda(state,{type:'owner.transcript',providerItemId:'negotiation-denial',text:recordedNegotiationDenial,nowMs:2});
    const record=reduced.commands.find(command=>command.type==='record_owner_turn')!;
    reduced=reduceWebsiteAgenda(reduced.state,{type:'owner_turn.recorded',requestId:record.requestId,providerItemId:record.providerItemId,turnId:record.turnId,text:record.text,nowMs:3});
    const command=reduced.commands.find(command=>command.type==='interpret_owner_turn')!,request=websiteInterpretationRequest(command);
    const context=JSON.parse(request.response.input[0].content[0].text),offered=context.eligible_related_item_ids.filter((id:string)=>targets.includes(id));
    console.info(JSON.stringify({scenario:'recorded-negotiation-builder',offeredNegotiationServices:offered.length,allOfferedRelatedItems:context.eligible_related_item_ids.length}));
    expect(offered.toSorted()).toEqual(targets.toSorted());expect(context.owner_transcript).toBe(recordedNegotiationDenial);
    expect(context.read_only_history.some((item:{id:string})=>targets.includes(item.id))).toBe(false);
    expect(command.agenda).toEqual(agenda);
  });

  test.each([
    "O dono disse: não autorizo negociação em nenhum serviço.",
    "Eu disse que não autorizo negociação em nenhum serviço.",
    "Não estou dizendo que não autorizo negociação em nenhum serviço.",
    "Não é verdade que não autorizo negociação em nenhum serviço.",
    "Talvez eu não autorize negociação em nenhum serviço.",
    "O site diz: “Não autorizo negociação em nenhum serviço.”",
    "Não autorizo negociação em nenhum serviço?",
    "Não autorizo negociação automática em nenhum serviço.",
    "Não autorizo negociação acima de dez por cento em nenhum serviço.",
    "Não autorizo negociação em nenhum serviço se o pagamento atrasar.",
    "Não autorizo negociação em nenhum serviço hoje.",
    "Não autorizo negociação em nenhum serviço, mas descontos automáticos estão permitidos.",
    "Não autorizo negociação em nenhum serviço, foi o que o dono disse.",
    "Não autorizo negociação para todos os serviços.",
    "Não autorizo negociação em nenhum serviço. Isso era antes; agora autorizo descontos.",
    "Não autorizo negociação ou permito desconto automático em nenhum serviço.",
    "Não autorizo negociação ou permitimos descontos automáticos. Essa regra vale para todos os serviços.",
    "Não autorizo negociação ou autorizamos descontos automáticos. Essa regra vale para todos os serviços.",
    "Não autorizo negociação ou concedo descontos automáticos. Essa regra vale para todos os serviços.",
    "Não autorizo negociação ou aplicamos descontos automáticos. Essa regra vale para todos os serviços.",
    "Não autorizo negociação em nenhum serviço. Descontos automáticos estão liberados.",
    "Não autorizo negociação em nenhum serviço, não há restrições para descontos automáticos.",
    "Não autorizo negociação em nenhum serviço. Não há restrições para descontos automáticos.",
  ])('qualified or reported direct denial cannot become a universal negotiation restriction: %s',text=>{
    const current=byRef('authority.negotiate_floor').id,agenda=at(current);
    expect(()=>checked(agenda,text,answer(current,familyIds('service.negotiation')))).toThrow();
    expect(agenda.items.find(item=>item.id===current)?.status).toBe('open');
  });

  test("exact cities do not silently resolve exception policy; explicit outside-area exception does", () => {
    const current = byRef("area.coverage").id;
    const territory = "92b3f78b-12b9-4f1d-81f2-db03bc2c0732";
    const agenda = at(territory);
    const outside = byRef("area.out_of_area_policy").id;
    expect(() => checked(agenda, "Atendemos somente Novato, San Rafael e Petaluma.", answer(territory, [outside]))).toThrow();
    const text = fixture.recorded_transcript.find(turn => turn.role === "caller" && turn.text.startsWith("Exatamente. É isso mesmo,"))!.text;
    expect(checked(agenda, text, answer(territory, [outside]))).toEqual(answer(territory, [outside]));
    expect(projection.seeds.find(item => item.id === territory)!.relatedItemIds).toContain(current);
  });

  test("more than sixteen eligible recipients are accepted while typed-fact and resource bounds remain", () => {
    const current = byRef("policy.warranty_materials").id;
    const targets = [...familyIds("service.warranty"), ...familyIds("service.materials_parts")];
    const text = "A garantia cobre defeitos de fabricação e instalação. Nós fornecemos todas as peças e materiais, sem usar peças do cliente. Essas políticas valem para todos os serviços.";
    expect(checked(at(current), text, answer(current, targets))).toEqual(answer(current, targets));
    expect(parseWebsiteInterpretation({ proposal: answer(current, targets), facts: [] })).not.toBe(null);
    expect(parseWebsiteInterpretation({ proposal: { kind: "correction", affectedItems: targets.map(itemId => ({ itemId, disposition: "reopen" })) }, facts: [] })).not.toBe(null);
    expect(parseWebsiteInterpretation({ proposal: answer(current, targets), facts: Array.from({ length: 17 }, () => ({})) })).toBe(null);
    expect(parseWebsiteInterpretation({ proposal: answer(current, Array.from({ length: 1025 }, (_, i) => `item-${i}`)), facts: [] })).toBe(null);
  });

  test("coordinator applies scope gate even when interpreter returns facts empty", () => {
    const agenda = at(WARRANTY);
    const stored: StoredWebsiteInterview = { agenda, revision: agenda.revision, storeVersion: 0, digest: onboardingAgendaDigest(agenda), receiptId: "receipt", nextAction: getAgendaAction(agenda), state: "unfinished", replayed: false };
    let state = createWebsiteAgendaCoordinator(stored, { nowMs: 0 });
    let commands: WebsiteAgendaCommand[] = [];
    let nowMs = 1;
    const event = (value: Record<string, unknown>) => { const result = reduceWebsiteAgenda(state, { ...value, nowMs: nowMs++ } as WebsiteAgendaEvent); state = result.state; commands = result.commands; };
    event({ type: "opening.played" });
    event({ type: "owner.transcript", providerItemId: "warranty-turn", text: originalWarranty });
    const record = commands.find(command => command.type === "record_owner_turn") as Extract<WebsiteAgendaCommand, { type: "record_owner_turn" }>;
    event({ type: "owner_turn.recorded", requestId: record.requestId, providerItemId: record.providerItemId, turnId: record.turnId, text: originalWarranty });
    const interpret = commands.find(command => command.type === "interpret_owner_turn") as Extract<WebsiteAgendaCommand, { type: "interpret_owner_turn" }>;
    event({ type: "interpretation.created", requestId: interpret.requestId, responseId: "response-1" });
    event({ type: "interpretation.completed", requestId: interpret.requestId, responseId: "response-1", turnId: interpret.turnId, itemId: interpret.itemId, digest: interpret.digest, result: { proposal: answer(WARRANTY, familyIds("service.warranty")), facts: [] } });
    expect(commands.some(command => command.type === "persist_agenda")).toBe(false);
    expect(commands.some(command => command.type === "interpret_owner_turn")).toBe(true);
    expect(state.stored.agenda).toEqual(agenda);
  });

  test("candidate-only corrections retain optional item targets at the parser boundary", () => {
    expect(parseWebsiteInterpretation({ proposal: { kind: "correction", affectedCandidates: [{ candidateId: "candidate:58288783-2423-4bea-a5b4-85cd5889a483", disposition: "reopen" }] }, facts: [] })).not.toBe(null);
    expect(parseWebsiteInterpretation({ proposal: { kind: "correction" }, facts: [] })).toBe(null);
  });
});
