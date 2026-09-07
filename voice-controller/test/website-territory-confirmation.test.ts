import { expect, test } from "bun:test";
import { createOnboardingAgenda, applyVerifiedOwnerTurn, getAgendaAction, type OnboardingAgenda } from "../src/onboarding-agenda.ts";
import { createOnboardingAgendaStore, onboardingAgendaDigest } from "../src/onboarding-agenda-store.ts";
import { createWebsiteAgendaCoordinator, reduceWebsiteAgenda } from "../src/onboarding-agenda-coordinator.ts";
import cases from "./fixtures/website-territory-confirmation-cases.json";

const callId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const binding = { callId, interviewId: callId, draftId: requestId, draftHash: "a".repeat(64), sourceResultId: requestId, sourceResultHash: "b".repeat(64) };
const nextQuestion = "Qual é o fuso horário oficial usado para os horários publicados?";
const initial = () => createOnboardingAgenda(binding, [
  { id: "area", source: "missing_website_information", subject: "area.coverage", questionPt: "Quais cidades atende?", coverageRefs: ["area.coverage"], relatedItemIds: [], blocking: true },
  { id: "next", source: "missing_website_information", subject: "schedule", questionPt: nextQuestion, coverageRefs: ["schedule.business_hours"], relatedItemIds: [], blocking: true },
  { id: "last", source: "owner_private_requirement", subject: "authority", questionPt: "Quem pode confirmar um agendamento?", coverageRefs: ["authority.book"], relatedItemIds: [], blocking: true },
]);
const answered = (agenda: OnboardingAgenda, itemId: string, text: string, turnId = `${callId}:${itemId}`) => applyVerifiedOwnerTurn(agenda,
  { type: "verified_owner_turn", binding, turnId, text, proposal: { kind: "answer", itemId } });
const stored = (agenda: OnboardingAgenda, nextAction = getAgendaAction(agenda)) => ({ agenda, nextAction, revision: agenda.revision,
  digest: onboardingAgendaDigest(agenda), storeVersion: agenda.revision, receiptId: requestId, state: "unfinished" as const, replayed: false });

test.each(cases)("source-bound territory confirmation: $name", ({ text, excerpt }) => {
  const result = answered(initial(), "area", text);
  const expected = excerpt ? `Registrado. Você informou: “${excerpt}”. ` : "Obrigado, registrei sua resposta. ";
  expect(result.action?.spokenPt).toBe(expected + nextQuestion);
  expect(result.action?.itemId).toBe("next");
  expect(result.action?.questionPt).toBe(nextQuestion);
  expect(result.agenda.items[0].evidence.at(-1)?.text).toBe(text);
});

test("a later unrelated answer cannot replay an old territory confirmation", () => {
  const territory = answered(initial(), "area", cases[0].text);
  const later = answered(territory.agenda, "next", "O fuso é o horário do Pacífico.");
  expect(later.action?.spokenPt).toBe("Obrigado, registrei sua resposta. Quem pode confirmar um agendamento?");
});

test("store readback accepts only the exact committed extract and authoritative next question", async () => {
  const result = answered(initial(), "area", cases[0].text);
  const row = stored(result.agenda, result.action!);
  const store = createOnboardingAgendaStore({ rpc: async () => ({ data: row, error: null }) });
  const scope = { ownerId: requestId, callId, requestId };
  expect((await store.readWebsiteInterview(scope)).nextAction.spokenPt).toBe(`Registrado. Você informou: “${cases[0].excerpt}”. ${nextQuestion}`);
  const tampered = createOnboardingAgendaStore({ rpc: async () => ({ data: { ...row,
    nextAction: { ...row.nextAction, spokenPt: row.nextAction.spokenPt.replace("aprovação explícita", "aprovação automática") } }, error: null }) });
  await expect(tampered.readWebsiteInterview(scope)).rejects.toThrow("Interview action proof mismatch");
  const legacyText = "Obrigado, registrei sua resposta. " + nextQuestion;
  const legacy = createOnboardingAgendaStore({ rpc: async () => ({ data: { ...row,
    nextAction: { ...row.nextAction, spokenPt: legacyText } }, error: null }) });
  expect((await legacy.readWebsiteInterview(scope)).nextAction.spokenPt).toBe(legacyText);
});

test("a failed commit cannot emit the prospective territory confirmation", () => {
  let state = createWebsiteAgendaCoordinator(stored(initial()), { nowMs: 0, timeoutMs: 100 });
  const event = (value: Record<string, unknown>) => { const result = reduceWebsiteAgenda(state, { nowMs: 1, ...value } as any); state = result.state; return result.commands; };
  event({ type: "opening.played" });
  const write = event({ type: "owner.transcript", providerItemId: "answer", text: cases[0].text })[0] as any;
  const interpret = event({ type: "owner_turn.recorded", requestId: write.requestId, providerItemId: "answer", turnId: `${callId}:answer`, text: cases[0].text })[0] as any;
  event({ type: "interpretation.created", requestId: interpret.requestId, responseId: "response" });
  const commands = event({ type: "interpretation.completed", requestId: interpret.requestId, responseId: "response", turnId: interpret.turnId,
    itemId: interpret.itemId, digest: interpret.digest, result: { proposal: { kind: "answer", itemId: "area" }, facts: [] } });
  expect(commands.map(command => command.type)).toEqual(["persist_agenda"]);
  const failed = event({ type: "effect.failed", requestId: (commands[0] as any).requestId, code: "42501" });
  expect(failed.filter(command => command.type === "request_speech").every(command => !(command as any).action.text.includes("Novato"))).toBe(true);
  expect(state.stored.agenda.items[0].status).toBe("open");
  expect(state.stored.agenda.ownerTurns).toEqual([]);
});

test('a committed owner contact condition advances instead of becoming an invalid agent offer',()=>{
 const text='Atendemos só Recife e Olinda. Fora dessas cidades, é só me chamar para obter minha aprovação explícita.';
 let state=createWebsiteAgendaCoordinator(stored(initial()),{nowMs:0});
 const event=(value:Record<string,unknown>)=>{const r=reduceWebsiteAgenda(state,{nowMs:1,...value} as any);state=r.state;return r.commands;};
 event({type:'opening.played'});
 const write=event({type:'owner.transcript',providerItemId:'contact-condition',text})[0] as any;
 const interpret=event({type:'owner_turn.recorded',requestId:write.requestId,providerItemId:write.providerItemId,turnId:write.turnId,text})[0] as any;
 event({type:'interpretation.created',requestId:interpret.requestId,responseId:'response'});
 const commit=event({type:'interpretation.completed',requestId:interpret.requestId,responseId:'response',turnId:interpret.turnId,itemId:interpret.itemId,digest:interpret.digest,
  result:{proposal:{kind:'answer',itemId:'area'},facts:[]}})[0] as any;
 expect(commit.type).toBe('persist_agenda');
 const after=event({type:'agenda.persisted',requestId:commit.requestId,stored:stored(commit.agenda,commit.nextAction)});
 expect(state.stored.revision).toBe(1);expect(state.phase).toBe('speaking');
 expect(after.map(c=>c.type)).toEqual(['request_speech']);
 expect(state.speech?.action.text).toContain('é só me chamar para obter minha aprovação explícita');
 expect(state.speech?.action.text.endsWith(nextQuestion)).toBe(true);expect(state.termination).toBeUndefined();
});

test("legacy acknowledgment compatibility never admits null text for another action kind", async () => {
  const row = stored(initial());
  const store = createOnboardingAgendaStore({ rpc: async () => ({ data: { ...row,
    nextAction: { ...row.nextAction, spokenPt: null } }, error: null }) });
  await expect(store.readWebsiteInterview({ ownerId: requestId, callId, requestId })).rejects.toThrow("Interview action proof mismatch");
});
