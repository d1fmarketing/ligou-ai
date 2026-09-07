import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createOnboardingAgenda, getAgendaAction, type AgendaSeed } from "../src/onboarding-agenda.ts";
import { onboardingAgendaDigest, type StoredWebsiteInterview } from "../src/onboarding-agenda-store.ts";
import { ONBOARDING_FINAL_SIGNOFF_TEXT } from "../src/onboarding-speech.ts";
import * as coordinator from "../src/onboarding-agenda-coordinator.ts";
import fixture from "./fixtures/foghorn-website-first-voice.json";
import approvalCases from "./fixtures/website-approval-cases.json";
import { buildWebsiteAgendaSeeds } from "../src/onboarding-agenda-seed.ts";
import type { CoverageSnapshot } from "../src/onboarding-coverage.ts";
import {
  createWebsiteAgendaCoordinator, reduceWebsiteAgenda, websiteSummaryHash,
  type WebsiteAgendaEvent, type WebsiteAgendaCommand, type WebsiteAgendaState,
} from "../src/onboarding-agenda-coordinator.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const callId = "3c7a37be-c8a0-456e-a1a1-9b937bd0ef4a";
const binding = {
  interviewId: "1c7a37be-c8a0-456e-a1a1-9b937bd0ef4a", callId,
  draftId: "46603c2c-c4d9-4d79-b35c-cd5b658388ab", draftHash: "a".repeat(64),
  sourceResultId: "c023899f-4dbe-46b9-89d4-2e1065709ca7", sourceResultHash: "b".repeat(64),
};
const seeds: AgendaSeed[] = ["territory", "pricing", "schedule", "emergency", "authority", "owner_contact"].map(id => ({
  id, source: "owner_private_requirement", subject: id,
  questionPt: `Qual é a política de ${id}?`, coverageRefs: [id], relatedItemIds: [], blocking: true,
}));
function stored(inputSeeds = seeds): StoredWebsiteInterview {
  const agenda = createOnboardingAgenda(binding, inputSeeds);
  return { agenda, revision: 0, storeVersion: 0, digest: onboardingAgendaDigest(agenda),
    receiptId: "2c7a37be-c8a0-456e-a1a1-9b937bd0ef4a", nextAction: getAgendaAction(agenda), state: "unfinished", replayed: false };
}
function harness(input = stored(), fieldGuidance?: Record<string, string>) {
  let state = createWebsiteAgendaCoordinator(input, { nowMs: 0, timeoutMs: 100, fieldGuidance });
  const all: WebsiteAgendaCommand[] = [];
  let commands: WebsiteAgendaCommand[] = [];
  let clock = 1;
  function event(event: Omit<WebsiteAgendaEvent, "nowMs"> | Record<string, unknown>) {
    const result = reduceWebsiteAgenda(state, { nowMs: clock++, ...event } as WebsiteAgendaEvent);
    state = result.state; commands = result.commands; all.push(...commands);
    return commands;
  }
  const last = <T extends WebsiteAgendaCommand["type"]>(type: T) =>
    commands.find(c => c.type === type) as Extract<WebsiteAgendaCommand, { type: T }>;
  function play() {
    const action = state.speech!.action;
    const textSha256 = hash(action.text), audioSha256 = hash(`synthetic-audio:${action.actionId}`);
    event({ type: "speech.ready", actionId: action.actionId, textSha256, audioSha256 });
    event({ type: "speech.played", actionId: action.actionId, textSha256, audioSha256 });
  }
  function owner(item: string, text: string) {
    event({ type: "owner.transcript", providerItemId: item, text });
    const command = last("record_owner_turn");
    expect(command).toBeDefined();
    event({ type: "owner_turn.recorded", requestId: command.requestId, providerItemId: item, turnId: `${callId}:${item}`, text });
    return last("interpret_owner_turn");
  }
  function interpret(command: Extract<WebsiteAgendaCommand, { type: "interpret_owner_turn" }>, proposal: unknown, facts?: unknown[]) {
    const responseId = `response:${command.requestId}`;
    event({ type: "interpretation.created", requestId: command.requestId, responseId });
    event({ type: "interpretation.completed", requestId: command.requestId, responseId,
      turnId: command.turnId, itemId: command.itemId, digest: command.digest, result: { proposal, ...(facts ? { facts } : {}) } });
    return last("persist_agenda");
  }
  function persist(command: Extract<WebsiteAgendaCommand, { type: "persist_agenda" }>) {
    expect(command).toBeDefined();
    event({ type: "agenda.persisted", requestId: command.requestId, stored: {
      agenda: command.agenda, revision: command.agenda.revision, storeVersion: command.expectedStoreVersion + 1,
      digest: onboardingAgendaDigest(command.agenda), receiptId: "3c7a37be-c8a0-456e-a1a1-9b937bd0ef4a",
      nextAction: command.nextAction, state: "unfinished", replayed: false,
    } });
  }
  function summary(parts = ["Confirmado pelo dono: território e preços.", "Pendências: nenhuma. Candidatos do site continuam sujeitos à revisão."]) {
    const command = last("prepare_summary");
    expect(command).toBeDefined();
    const summaryId = `summary-${state.stored.revision}`;
    const summaryHash = websiteSummaryHash({ summaryId, revision: state.stored.revision, digest: state.stored.digest, parts });
    event({ type: "summary.ready", requestId: command.requestId, summaryId, summaryHash,
      revision: state.stored.revision, digest: state.stored.digest, parts });
    for (const _ of parts) play();
    expect(state.speech?.action.kind).toBe("REQUEST_FINAL_APPROVAL");
    play();
  }
  return { event, play, owner, interpret, persist, summary, last, all,
    get state() { return state; }, get commands() { return commands; } };
}
const answer = (itemId: string) => ({ kind: "answer", itemId });

test("opening is app-owned and each exact owner transcript is durable before silent interpretation", () => {
  const h = harness();
  expect(h.state.phase).toBe("opening");
  expect(h.all).toEqual([]);
  h.event({ type: "opening.played" });
  expect(h.state.openingAction.kind).toBe("ASK_NEXT_GAP");
  expect(h.state.phase).toBe("awaiting_owner");
  expect(h.commands).toEqual([]);
  h.event({ type: "owner.transcript", providerItemId: "owner-1", text: "Atendemos somente San Rafael." });
  const write = h.last("record_owner_turn");
  expect(h.commands.map(c => c.type)).toEqual(["record_owner_turn"]);
  h.event({ type: "owner.transcript", providerItemId: "owner-1", text: write.text });
  expect(h.commands).toEqual([]);
  h.event({ type: "owner_turn.recorded", requestId: write.requestId, providerItemId: write.providerItemId,
    turnId: write.turnId, text: write.text });
  const interpretation = h.last("interpret_owner_turn");
  expect(interpretation).toMatchObject({ outputModalities: ["text"], conversation: "none",
    toolName: "submit_website_interview_proposal", itemId: "territory", transcript: write.text, attempt: 0 });
  expect(h.all.filter(c => c.type === "record_owner_turn")).toHaveLength(1);
  const commit = h.interpret(interpretation, answer("territory"));
  expect(h.commands.some(c => c.type === "request_speech")).toBe(false);
  h.persist(commit);
  expect(h.state.speech?.action.text).toContain(seeds[1].questionPt);
  expect(h.state.stored.agenda.ownerTurns).toEqual([{ turnId: write.turnId, text: write.text }]);
});

test("production-shaped categories, off-scope, correction, resummary and strict closing proofs finish exactly once", () => {
  const h = harness();
  h.event({ type: "opening.played" });
  const copy = h.owner("copy", "Me manda um texto para colocar no site e no script do agente.");
  h.persist(h.interpret(copy, answer("territory")));
  expect(h.state.stored.agenda.items[0].status).toBe("open");
  expect(h.state.speech?.action.kind).toBe("DEFER_OFF_SCOPE_AND_CONTINUE");
  expect(h.state.speech?.action.text).toContain(seeds[0].questionPt); h.play();
  for (const seed of seeds) {
    const request = h.owner(`answer-${seed.id}`, `Minha política explícita de ${seed.id} é esta.`);
    h.persist(h.interpret(request, answer(seed.id)));
    if (h.state.speech) h.play();
  }
  expect(h.state.stored.agenda.items.every(item => item.status === "answered")).toBe(true);
  h.summary();
  const oldSummary = h.state.summary!;
  const correction = h.owner("correction", "Não, corrija o território: somente San Rafael.");
  expect(h.state.summary?.summaryHash).toBe(oldSummary.summaryHash);
  expect(h.state.phase).toBe("interpreting");
  expect(h.state.correctionRequired).toBe(true);
  expect(h.last("persist_approval")).toBeUndefined();
  h.persist(h.interpret(correction, { kind: "correction", affectedItems: [{ itemId: "territory", disposition: "corrected" }] }));
  expect(h.state.summary).toBeUndefined();
  if (h.state.speech) h.play();
  expect(h.state.stored.agenda.items[0].status).toBe("corrected");
  h.summary(["Correção confirmada: somente San Rafael. Demais informações mantidas; candidatos do site não concedem poderes."]);
  expect(h.state.summary!.summaryHash).not.toBe(oldSummary.summaryHash);
  h.owner("approval", "Está tudo correto. Confirmo.");
  const approval = h.last("persist_approval");
  expect(approval).toBeDefined();
  expect(h.commands.some(c => c.type === "interpret_owner_turn")).toBe(false);
  h.event({ type: "approval.persisted", requestId: approval.requestId, approvalReceiptId: "approved-1",
    turnId: approval.turnId, summaryId: approval.summaryId, summaryHash: approval.summaryHash,
    revision: approval.revision, digest: approval.digest, storeVersion: approval.expectedStoreVersion + 1 });
  expect(h.state.speech?.action.text).toBe(ONBOARDING_FINAL_SIGNOFF_TEXT);
  h.play();
  const termination = h.last("terminate_session");
  expect(termination).toMatchObject({ action: "TERMINATE_SESSION", outcome: "complete" });
  expect(h.state.phase).not.toBe("complete");
  h.event({ type: "owner.transcript", providerItemId: "late", text: "Mais uma coisa." });
  expect(h.commands).toEqual([]);
  h.event({ type: "provider.termination_confirmed", requestId: termination.requestId, receiptId: "provider-1" });
  expect(h.commands.some(c => c.type === "record_completion")).toBe(false);
  h.event({ type: "budget.settled", requestId: termination.requestId, receiptId: "budget-1" });
  const completion = h.last("record_completion");
  expect(h.state.phase).not.toBe("complete");
  h.event({ type: "completion.recorded", requestId: completion.requestId,
    receiptId: "dashboard-complete-1", interviewId: binding.interviewId, callId,
    approvalReceiptId: "approved-1", outcome: "complete" });
  expect(h.state.phase).toBe("complete");
  h.event({ type: "budget.settled", requestId: termination.requestId, receiptId: "budget-1" });
  expect(h.commands).toEqual([]);
  expect(h.all.filter(c => c.type === "terminate_session")).toHaveLength(1);
  expect(h.all.filter(c => c.type === "request_speech" && c.action.kind === "SPEAK_FINAL_SIGNOFF")).toHaveLength(1);
});

test("wrong response, digest, proposal and timeout cannot strand the current question or create speech authority", () => {
  const h = harness(); h.event({ type: "opening.played" });
  const first = h.owner("bounded", "Minha resposta.");
  h.event({ type: "interpretation.completed", requestId: first.requestId, responseId: "wrong",
    turnId: first.turnId, itemId: first.itemId, digest: first.digest, proposal: answer("territory") });
  expect(h.commands).toEqual([]);
  h.event({ type: "interpretation.created", requestId: first.requestId, responseId: "actual" });
  h.event({ type: "interpretation.completed", requestId: first.requestId, responseId: "actual",
    turnId: first.turnId, itemId: first.itemId, digest: "c".repeat(64), proposal: answer("territory") });
  expect(h.commands).toEqual([]);
  h.event({ type: "deadline", requestId: first.requestId, nowMs: 1000 });
  const retry = h.last("interpret_owner_turn");
  expect(retry.attempt).toBe(1);
  h.interpret(retry, { kind: "answer", itemId: "not-current", narrative: "Posso te ajudar com propaganda?" });
  expect(h.last("persist_agenda")).toBeUndefined();
  expect(h.state.error).toBe("interpretation_exhausted");
  expect(h.state.speech?.action.kind).toBe("SPEAK_TERMINAL_ERROR");
  expect(h.state.speech?.action.text).toContain("falha técnica");
  expect(h.state.speech?.action.text).not.toContain("propaganda");
  h.event({ type: "interpretation.completed", requestId: retry.requestId, responseId: `response:${retry.requestId}`,
    turnId: retry.turnId, itemId: retry.itemId, digest: retry.digest, proposal: answer("territory") });
  expect(h.commands).toEqual([]);
  expect(h.state.stored.agenda.items[0].status).toBe("open");
});

test("each advertised proposal variant permits only the fields accepted by the parser", () => {
  const h = harness(); h.event({ type: "opening.played" });
  const command = h.owner("schema", "Somente Novato.");
  const schema = command.toolSchema as any;
  const variants = schema.properties.proposal.anyOf;
  const expected = {
    answer: ["kind", "itemId", "relatedItemIds"],
    clarification: ["kind", "itemId", "questionPt"],
    defer: ["kind", "itemId"], not_applicable: ["kind", "itemId"],
    off_scope: ["kind"], correction: ["kind", "affectedItems", "affectedCandidates"],
  };
  for (const [kind, allowed] of Object.entries(expected)) {
    const variant = variants.find((entry: any) => entry.properties.kind.const === kind);
    expect(variant, `missing discriminated ${kind} variant`).toBeDefined();
    expect(variant.additionalProperties).toBe(false);
    expect(Object.keys(variant.properties).sort()).toEqual(allowed.toSorted());
    if (["answer", "defer", "not_applicable"].includes(kind)) expect(variant.properties.itemId.type).toBe("string");
    if (kind === "clarification") expect(variant.properties.itemId.type).toEqual(["string", "null"]);
  }
  for (const proposal of [
    { kind: "answer", itemId: "territory", questionPt: "Qual cidade?" },
    { kind: "defer", itemId: "territory", relatedItemIds: [] },
    { kind: "not_applicable", itemId: null },
  ]) expect(coordinator.parseWebsiteInterpretation({ proposal })).toBeNull();
});

test("two unusable outputs after an acknowledgment never defer the owner's valid territory answer", () => {
  const h = harness(); h.event({ type: "opening.played" });
  h.persist(h.interpret(h.owner("ack", "Ah, entendi."), { kind: "clarification", itemId: "territory" }));
  h.play();
  const before = structuredClone(h.state.stored);
  const text = "Hum, olha, atendi só novato, San Rafael e Petaluma, nada além dessas três. Já teve pedido de gente de outras cidades, mas não é pra atender. Se pintar alguma coisa fora, é só com aprovação explícita do dono, combinado?";
  const first = h.owner("valid-answer", text);
  h.interpret(first, { kind: "answer", itemId: "territory", questionPt: "Quais cidades?" });
  const retry = h.last("interpret_owner_turn");
  expect(retry.attempt).toBe(1);
  expect(retry.transcript).toBe(text);
  h.interpret(retry, { kind: "answer", itemId: "territory", questionPt: "Quais cidades?" });
  expect(h.state.stored).toEqual(before);
  expect(h.state.stored.agenda.items[0].clarificationCount).toBe(1);
  expect(h.state.stored.agenda.items[0].status).toBe("awaiting_clarification");
  expect(h.state.turns.at(-1)).toMatchObject({ text, recorded: true, processed: false });
  expect(h.all.filter(command => command.type === "persist_agenda")).toHaveLength(1);
  expect(h.state.error).toBe("interpretation_exhausted");
  expect(h.last("persist_approval")).toBeUndefined();
});

test("the single interpreter retry receives a bounded reason without private error suffixes", () => {
  const h = harness(); h.event({ type: "opening.played" });
  const first = h.owner("repair", "Somente Novato.");
  h.event({ type: "interpretation.failed", requestId: first.requestId,
    code: "website_facts_typed_value_invalid:private-item-123:private owner words" });
  const retry = h.last("interpret_owner_turn");
  expect(retry.instructions).toContain("website_facts_typed_value_invalid");
  expect(retry.instructions).not.toContain("private-item");
  expect(retry.instructions).not.toContain("private owner words");
  h.event({ type: "interpretation.failed", requestId: retry.requestId, code: "private-provider-error" });
  expect(h.all.filter(command => command.type === "interpret_owner_turn")).toHaveLength(2);
  expect(h.all.filter(command => command.type === "persist_agenda")).toHaveLength(0);
  expect(h.state.error).toBe("interpretation_exhausted");
});

test.each([
  { kind: { toString: null }, itemId: "territory" },
  { kind: "correction", affectedItems: [{ itemId: "territory", disposition: { toString: null } }] },
])("malformed JSON discriminants reject without throwing outside bounded recovery", proposal => {
  expect(() => coordinator.parseWebsiteInterpretation({ proposal })).not.toThrow();
  expect(coordinator.parseWebsiteInterpretation({ proposal })).toBeNull();
});

test.each(["Não confirmo.", "Está correto, mas mude os preços.", "Não tenho certeza se está correto.", "Está correto?", "Sim, mas mude os preços."])("model approval cannot replace explicit fresh assent: %s", text => {
  const h = harness(stored([])); h.event({ type: "opening.played" }); h.summary();
  const request = h.owner("not-approval", text);
  expect(h.all.some(c => c.type === "persist_approval")).toBe(false);
  if (request) h.interpret(request, { kind: "approval", approved: true });
  expect(h.all.some(c => c.type === "persist_approval")).toBe(false);
  expect(h.all.some(c => c.type === "terminate_session")).toBe(false);
});

test("approval grammar matches the shared exact TS/SQL matrix without substring assent", () => {
  for (const { text, kind } of approvalCases)
    expect(coordinator.classifyWebsiteApprovalTranscript(text)).toBe(kind as "approval" | "correction" | "ambiguous");
});

test.each(approvalCases.filter(entry => entry.kind === "approval" && "basis" in entry).map(({ text }) => text))(
  "natural present approval binds the played current recap without interpretation: %s", (text) => {
    const h = harness(stored([])); h.event({ type: "opening.played" }); h.summary();
    const summary = h.state.summary!;
    h.owner("natural-current-approval", text);
    const approval = h.last("persist_approval");
    expect(approval).toMatchObject({ transcript: text, providerItemId: "natural-current-approval",
      summaryId: summary.summaryId, summaryHash: summary.summaryHash,
      revision: h.state.stored.revision, digest: h.state.stored.digest });
    expect(h.commands.some(command => command.type === "interpret_owner_turn")).toBe(false);
    h.event({ type: "owner.transcript", providerItemId: "natural-current-approval", text });
    expect(h.all.filter(command => command.type === "persist_approval")).toHaveLength(1);
  },
);

test("natural approval captured before recap playback cannot approve a later summary", () => {
  const h = harness(stored([])); h.event({ type: "opening.played" });
  const prepare = h.last("prepare_summary");
  const text = "Eu revisei o resumo e aprovo explicitamente esta configuração, com as correções que confirmei.";
  h.owner("before-playback", text);
  const summary = { summaryId: "current-summary", revision: h.state.stored.revision,
    digest: h.state.stored.digest, parts: ["O resumo atual ainda precisa ser ouvido."] };
  h.event({ type: "summary.ready", requestId: prepare.requestId, ...summary, summaryHash: websiteSummaryHash(summary) });
  h.play();
  expect(h.state.turns.find(turn => turn.providerItemId === "before-playback")?.approvalSummaryId).toBeNull();
  expect(h.all.some(command => command.type === "persist_approval")).toBe(false);
});

test("natural approval with a stale summary correlation stays non-authoritative", () => {
  const h = harness(stored([])); h.event({ type: "opening.played" }); h.summary();
  const text = "Eu aprovo esta configuração.";
  h.event({ type: "owner.transcript", providerItemId: "stale-natural", text, approvalSummaryId: "older-summary" });
  const write = h.last("record_owner_turn");
  h.event({ type: "owner_turn.recorded", requestId: write.requestId, providerItemId: write.providerItemId, turnId: write.turnId, text });
  expect(h.all.some(command => command.type === "persist_approval")).toBe(false);
});

test("bare sim after the fully played approval question requests one durable approval and no interpretation", () => {
  const h = harness(stored([])); h.event({ type: "opening.played" }); h.summary();
  h.owner("plain-sim", "Sim.");
  expect(h.last("persist_approval")).toBeDefined();
  expect(h.commands.some(command => command.type === "interpret_owner_turn")).toBe(false);
  h.event({ type: "owner.transcript", providerItemId: "plain-sim", text: "Sim." });
  expect(h.commands).toEqual([]);
  expect(h.all.filter(command => command.type === "persist_approval")).toHaveLength(1);
});

test.each(['Ah, entendi.','Uhum.','Tá bom.'])("acknowledgment cannot resolve the territory question: %s",text=>{
 const h=harness();h.event({type:'opening.played'});
 const request=h.owner('acknowledgment',text);
 const commit=h.interpret(request,answer('territory'));
 h.persist(commit);
 expect(h.state.stored.agenda.items[0].status).toBe('awaiting_clarification');
 expect(h.state.stored.agenda.items[0].answerRevision).toBe(0);
 expect(h.state.speech?.action.kind).toBe('CLARIFY_CURRENT_GAP');
 expect(h.all.some(command=>command.type==='persist_approval')).toBe(false);
});

test('a failed signoff preserves the already durable configuration approval',()=>{
 const h=harness(stored([]));h.event({type:'opening.played'});h.summary();h.owner('approved','Sim. Confirmo.');
 const command=h.last('persist_approval');
 h.event({type:'approval.persisted',requestId:command.requestId,approvalReceiptId:'durable-approval',turnId:command.turnId,
  summaryId:command.summaryId,summaryHash:command.summaryHash,revision:command.revision,digest:command.digest,storeVersion:command.expectedStoreVersion+1});
 const approved=h.state.approval,action=h.state.speech.action;
 h.event({type:'speech.failed',actionId:action.actionId,code:'transport_unavailable'});
 expect(h.state.approval).toEqual(approved);
 expect(h.state.stored.state).toBe('closing');
 expect(h.state.phase).not.toBe('complete');
});

test('barge-in retires unplayed recap and binds the correction to the same durable revision',()=>{
 const h=harness(stored([seeds[0]]));h.event({type:'opening.played'});
 h.persist(h.interpret(h.owner('first','Somente Novato.'),answer('territory')));
 const prepare=h.last('prepare_summary');
 const parts=['A área confirmada é Novato.'],summaryId='interrupted-summary';
 const summaryHash=websiteSummaryHash({summaryId,revision:1,digest:h.state.stored.digest,parts});
 h.event({type:'summary.ready',requestId:prepare.requestId,summaryId,summaryHash,revision:1,digest:h.state.stored.digest,parts});
 const interrupted=h.state.speech.action;
 h.event({type:'owner.speech_started',providerItemId:'correction'});
 expect(h.last('interrupt_speech')).toMatchObject({actionId:interrupted.actionId,providerItemId:'correction'});
 expect(h.state.speech).toBeUndefined();expect(h.state.phase).toBe('awaiting_owner');
 const request=h.owner('correction','Corrija: também atendemos San Rafael.');
 expect(request.mode).toBe('correction');
 h.persist(h.interpret(request,{kind:'correction',affectedItems:[{itemId:'territory',disposition:'corrected'}]}));
 expect(h.state.stored.revision).toBe(2);expect(h.state.summary).toBeUndefined();
 h.event({type:'speech.played',actionId:interrupted.actionId,textSha256:hash(interrupted.text),audioSha256:hash('old')});
 expect(h.state.approval).toBeUndefined();expect(h.all.some(command=>command.type==='persist_approval')).toBe(false);
});

test('acknowledgment during recap resumes it instead of requesting premature approval',()=>{
 const h=harness(stored([]));h.event({type:'opening.played'});
 const prepare=h.last('prepare_summary'),parts=['Resumo completo, ainda não reproduzido.'],summaryId='summary-pause';
 const summaryHash=websiteSummaryHash({summaryId,revision:0,digest:h.state.stored.digest,parts});
 h.event({type:'summary.ready',requestId:prepare.requestId,summaryId,summaryHash,revision:0,digest:h.state.stored.digest,parts});
 const action=h.state.speech.action;
 h.event({type:'owner.speech_started',providerItemId:'ack'});
 const request=h.owner('ack','Ah, entendi.');
 expect(request).toBeDefined();
 h.interpret(request,{kind:'clarification',itemId:null});
 expect(h.last('resume_speech')).toMatchObject({actionId:action.actionId,providerItemId:'ack'});
 expect(h.all.some(command=>command.type==='request_speech' && command.action.kind==='REQUEST_FINAL_APPROVAL')).toBe(false);
 expect(h.state.approval).toBeUndefined();
});

test('summary IO completing during owner speech defers audio and lets a correction invalidate it',()=>{
 const h=harness(stored([seeds[0]]));h.event({type:'opening.played'});
 h.persist(h.interpret(h.owner('first','Somente Novato.'),answer('territory')));
 const prepare=h.last('prepare_summary'),parts=['A área é Novato.'],summaryId='summary-during-owner';
 h.event({type:'owner.speech_started',providerItemId:'correction-during-io'});
 h.event({type:'summary.ready',requestId:prepare.requestId,summaryId,revision:1,digest:h.state.stored.digest,parts,
  summaryHash:websiteSummaryHash({summaryId,revision:1,digest:h.state.stored.digest,parts})});
 expect(h.commands.some(command=>command.type==='request_speech')).toBe(false);expect(h.state.speech).toBeUndefined();
 const request=h.owner('correction-during-io','Corrija: também atendemos San Rafael.');expect(request?.mode).toBe('correction');
 h.persist(h.interpret(request,{kind:'correction',affectedItems:[{itemId:'territory',disposition:'corrected'}]}));
 expect(h.state.stored.revision).toBe(2);expect(h.state.summary).toBeUndefined();expect(h.last('prepare_summary')).toBeDefined();
});

test('a reply during approval playback persistence is admitted only after that exact question is proven played',()=>{
 const h=harness(stored([]));h.event({type:'opening.played'});
 const prepare=h.last('prepare_summary'),parts=['Resumo confirmado.'],summaryId='quick-approval';
 const summaryHash=websiteSummaryHash({summaryId,revision:0,digest:h.state.stored.digest,parts});
 h.event({type:'summary.ready',requestId:prepare.requestId,summaryId,summaryHash,revision:0,digest:h.state.stored.digest,parts});h.play();
 const question=h.state.speech.action;
 h.event({type:'owner.speech_started',providerItemId:'quick-yes',afterPlaybackActionId:question.actionId});
 expect(h.last('interrupt_speech')).toBeUndefined();expect(h.last('persist_approval')).toBeUndefined();
 h.play();h.owner('quick-yes','Sim. Confirmo.');
 const approval=h.last('persist_approval');expect(approval).toBeDefined();
 h.event({type:'approval.persisted',requestId:approval.requestId,approvalReceiptId:'durable-approval',turnId:approval.turnId,
  summaryId:approval.summaryId,summaryHash:approval.summaryHash,revision:approval.revision,digest:approval.digest,storeVersion:approval.expectedStoreVersion+1});
 const signoff=h.state.speech.action;
 h.event({type:'owner.speech_started',providerItemId:'thanks',afterPlaybackActionId:signoff.actionId});h.play();
 expect(h.last('terminate_session')).toBeUndefined();h.owner('thanks','Obrigada, tchau.');
 expect(h.last('terminate_session')?.outcome).toBe('complete');
 expect(h.all.filter(c=>c.type==='request_speech' && c.action.kind==='SPEAK_FINAL_SIGNOFF')).toHaveLength(1);
});

test('correction during closing requests a new amendment without mutating the approved snapshot',()=>{
 const h=harness(stored([seeds[0]]));h.event({type:'opening.played'});
 h.persist(h.interpret(h.owner('first','Somente Novato.'),answer('territory')));h.summary();h.owner('approved','Sim. Confirmo.');
 const command=h.last('persist_approval');
 h.event({type:'approval.persisted',requestId:command.requestId,approvalReceiptId:'durable-approval',turnId:command.turnId,
  summaryId:command.summaryId,summaryHash:command.summaryHash,revision:command.revision,digest:command.digest,storeVersion:command.expectedStoreVersion+1});
 const approved=structuredClone(h.state.stored),approval=structuredClone(h.state.approval);
 h.event({type:'owner.speech_started',providerItemId:'late-correction'});
 expect(h.last('interrupt_speech')).toBeDefined();
 const request=h.owner('late-correction','Espera, corrija: também atendemos San Rafael.');expect(request).toBeDefined();
 h.interpret(request,{kind:'correction',affectedItems:[{itemId:'territory',disposition:'corrected'}]});
 expect(h.last('request_amendment')).toMatchObject({approvalReceiptId:'durable-approval',providerItemId:'late-correction',
  proposal:{kind:'correction',affectedItems:[{itemId:'territory',disposition:'reopen'}]}});
 expect(h.state.stored).toEqual(approved);expect(h.state.approval).toEqual(approval);
 expect(h.commands.some(c=>c.type==='persist_agenda')).toBe(false);
});

test('an explicit owner pause has its own incomplete terminal reason and never grants approval',()=>{
 const h=harness();h.event({type:'opening.played'});h.owner('pause','Quero pausar a configuração por agora.');
 expect(h.state.speech?.action.kind).toBe('SPEAK_TERMINAL_ERROR');
 h.play();expect(h.last('terminate_session')).toMatchObject({outcome:'unfinished',reason:'owner_requested_pause'});
 expect(h.state.approval).toBeUndefined();
});
test.each([
 'Quero parar de atender em São Francisco e ficar só em Novato, San Rafael e Petaluma.',
 'Preciso encerrar os descontos automáticos para todos os serviços.',
 'Vamos parar de trabalhar aos domingos.',
])('stopping a business practice is an owner answer, not an interview pause: %s',text=>{
 const h=harness();h.event({type:'opening.played'});
 expect(h.owner('business-change',text)).toBeDefined();
 expect(h.state.speech).toBeUndefined();expect(h.state.error).toBeUndefined();
});

test("durable revision mismatch fails truthfully and nonempty queue cannot synthesize final authority", () => {
  const h = harness(); h.event({ type: "opening.played" });
  h.event({ type: "summary.ready", requestId: "foreign", summaryId: "fake", summaryHash: "f".repeat(64),
    revision: 0, digest: h.state.stored.digest, parts: ["Tudo pronto."] });
  expect(h.commands).toEqual([]);
  const commit = h.interpret(h.owner("write", "Resposta."), answer("territory"));
  h.event({ type: "agenda.persisted", requestId: commit.requestId, stored: { ...stored(), storeVersion: 1 } });
  expect(h.state.speech?.action.kind).toBe("SPEAK_TERMINAL_ERROR");
  expect(h.state.stored.revision).toBe(0);
  h.play();
  expect(h.last("terminate_session").outcome).toBe("unfinished");
  expect(h.all.some(c => c.type === "persist_approval")).toBe(false);
});

test("speech proof requires matching action/text/audio and a deadline never falsely completes", () => {
  const h = harness(); h.event({ type: "opening.played" });
  h.persist(h.interpret(h.owner("first", "Minha resposta."), answer("territory")));
  const action = h.state.speech!.action;
  h.event({ type: "speech.played", actionId: action.actionId, textSha256: hash(action.text), audioSha256: hash("foreign") });
  expect(h.state.phase).toBe("speaking");
  h.event({ type: "deadline", requestId: action.actionId, nowMs: 1000 });
  expect(h.state.phase).not.toBe("complete");
  expect(h.commands.some(c => c.type === "terminate_session" || c.type === "request_speech")).toBe(true);
  h.event({ type: "completion.recorded", requestId: "fake", receiptId: "fake", interviewId: binding.interviewId,
    callId, approvalReceiptId: "fake", outcome: "complete" });
  expect(h.state.phase).not.toBe("complete");
});

test("website opening adds identity and website context while retaining the bound first question", () => {
  expect(typeof coordinator.buildWebsiteOpeningAction).toBe("function");
  const saved = stored();
  const opening = coordinator.buildWebsiteOpeningAction(saved, "Foghorn Air, Inc.");
  expect(opening.text).toBe(`Oi! Aqui é o Ligou, agente de inteligência artificial da Foghorn Air, Inc.. Eu já analisei seu website. ${seeds[0].questionPt}`);
  expect(opening.actionId).not.toBe(saved.nextAction.actionId);
  const state = createWebsiteAgendaCoordinator(saved, { nowMs: 0, openingAction: opening });
  expect(state.openingAction).toEqual(opening);
  expect(reduceWebsiteAgenda(state, { type: "opening.played", nowMs: 1 }).commands).toEqual([]);
  expect(() => createWebsiteAgendaCoordinator(saved, { nowMs: 0, openingAction: { ...opening, sourceDigest: "c".repeat(64) } })).toThrow();
});

test("relevant explanation request speaks application guidance and cannot resolve a gap from model narrative", () => {
  const h = harness(stored(), { territory: "Limite de atendimento é a lista de cidades onde sua empresa aceita serviços." });
  h.event({ type: "opening.played" });
  const request = h.owner("meaning", "O que significa limite de atendimento? Pode explicar?");
  h.persist(h.interpret(request, answer("territory")));
  expect(h.state.stored.agenda.items[0].status).toBe("awaiting_clarification");
  expect(h.state.speech?.action.kind).toBe("CLARIFY_CURRENT_GAP");
  expect(h.state.speech?.action.text).toContain("Limite de atendimento é a lista de cidades");
  expect(h.state.speech?.action.text).toContain(seeds[0].questionPt);
});

test("non-assent factual corrections after recap reach interpretation, while a recap explanation does not become a correction", () => {
  for(const text of ["Na verdade, no sábado abrimos às nove.","O correto é atender apenas Novato e San Rafael.",
    "Sim. Nosso número correto é 415 555 0199.","Atendemos somente Novato.","Sábado, nove às cinco.","Telefone agora: 415 555 0199.",
    "Não entendi por que consta sábado às oito. Corrija: abrimos às nove.","Pode explicar? O telefone correto é 415 555 0199."]){
    const h=harness(stored([seeds[0]!]));h.event({type:"opening.played"});
    h.persist(h.interpret(h.owner("first","Atendemos Novato e San Rafael."),answer("territory")));h.summary();
    const interpretation=h.owner("change",text);
    expect(interpretation?.mode).toBe("correction");expect(h.last("persist_approval")).toBeUndefined();
  }
  const h=harness(stored([seeds[0]!]));h.event({type:"opening.played"});
  h.persist(h.interpret(h.owner("first","Atendemos Novato."),answer("territory")));h.summary();
  const meaning=h.owner("meaning","Não entendi o resumo.");
  expect(meaning?.mode).toBe("correction");
  h.interpret(meaning,{kind:"clarification",itemId:null});
  expect(h.state.speech?.action.kind).toBe("REQUEST_FINAL_APPROVAL");
  expect(h.state.correctionRequired).toBe(false);
  expect(h.state.speech?.action.text).toContain("O resumo reúne o que você confirmou");
});

test("review interpretation can request clarification without changing evidence or losing the played summary",()=>{
  const h=harness(stored([seeds[0]!]));h.event({type:"opening.played"});
  h.persist(h.interpret(h.owner("first","Atendemos Novato."),answer("territory")));h.summary();
  const summary=h.state.summary!,revision=h.state.stored.revision;
  const interpretation=h.owner("unclear","Sobre esse ponto da revisão, qual é o significado?");
  expect(interpretation?.mode).toBe("correction");
  h.interpret(interpretation,{kind:"clarification",itemId:null});
  expect(h.state.stored.revision).toBe(revision);expect(h.state.summary?.summaryId).toBe(summary.summaryId);
  expect(h.state.speech?.action.kind).toBe("REQUEST_FINAL_APPROVAL");
  expect(h.last("persist_agenda")).toBeUndefined();expect(h.last("persist_approval")).toBeUndefined();
});

test("default application guidance explains a real field and repeats only its stored question",()=>{
  const seed={...seeds[0]!,coverageRefs:["area.coverage"]};
  const h=harness(stored([seed]));h.event({type:"opening.played"});
  h.persist(h.interpret(h.owner("meaning","O que significa área atendida?"),answer(seed.id)));
  expect(h.state.speech?.action.text).toContain("Área atendida é a lista exata de cidades");
  expect(h.state.speech?.action.text.endsWith(seed.questionPt)).toBe(true);
});

test("typed business facts are retained without model owner_words and bind the captured item and exact transcript", () => {
  const h = harness(); h.event({ type: "opening.played" });
  const text = "Atendemos somente San Rafael, sem exceção automática.";
  const request = h.owner("facts", text);
  const facts = [{ topic: "area", field: "area.coverage", disposition: "answered", rule_text: "Atende somente San Rafael.", structured: { value: ["San Rafael"] } }];
  const commit = h.interpret(request, answer("territory"), facts);
  expect(commit.facts).toEqual(facts);
  expect(commit.currentItemId).toBe("territory");
  expect(commit.ownerTranscript).toBe(text);
  expect(commit.facts[0]).not.toHaveProperty("owner_words");
});

test("an explicitly unknown owner answer is clarified even when the interpreter labels it answered",()=>{
  const h=harness();h.event({type:"opening.played"});
  const pending=h.owner("unknown","Não sei.");
  h.persist(h.interpret(pending,answer("territory")));
  expect(h.state.stored.agenda.items[0].status).toBe("awaiting_clarification");
  expect(h.state.speech?.action.kind).toBe("CLARIFY_CURRENT_GAP");
});

test("the exact Foghorn 114-item queue cannot prepare summary until each durable turn has advanced its question", () => {
  const { tenant_id: _, ...draftReadback } = fixture.draft_row;
  const projection = buildWebsiteAgendaSeeds({ draftReadback, initialCoverage: fixture.initial_coverage.snapshot as CoverageSnapshot });
  expect(projection.seeds).toHaveLength(114);
  const h = harness(stored([...projection.seeds])); h.event({ type: "opening.played" });
  for (const [index, seed] of projection.seeds.entries()) {
    expect(h.state.phase).toBe("awaiting_owner");
    const request = h.owner(`foghorn-${index}`, `Resposta explícita do dono sobre ${seed.subject}: preciso revisar esse ponto pessoalmente antes de autorizar.`);
    expect(request.itemId).toBe(seed.id);
    h.persist(h.interpret(request, { kind: "defer", itemId: seed.id }));
    if (index < 113) {
      expect(h.commands.some(command => command.type === "prepare_summary")).toBe(false);
      expect(h.state.speech?.action.text).toContain(projection.seeds[index + 1]!.questionPt);
      h.play();
    }
  }
  expect(h.last("prepare_summary")).toBeDefined();
  expect(h.state.stored.agenda.items.every(item => item.status === "deferred_owner_review")).toBe(true);
  expect(h.state.stored.agenda.ownerTurns).toHaveLength(114);
  expect(h.all.some(command => command.type === "persist_approval" || command.type === "terminate_session")).toBe(false);
});
