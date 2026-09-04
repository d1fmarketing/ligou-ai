import { describe, expect, test } from "bun:test";
import foghorn from "./fixtures/foghorn-website-first-voice.json";
import {
  createOnboardingAgenda, applyVerifiedOwnerTurn, getAgendaAction, projectAgendaSummary, parseOnboardingAgenda,
  type AgendaBinding, type AgendaSeed, type AgendaProposal, type OnboardingAgenda,
} from "../src/onboarding-agenda.ts";

const binding: AgendaBinding = {
  interviewId: "interview-1", callId: "3c7a37be-c8a0-456e-a1a1-9b937bd0ef4a",
  draftId: "46603c2c-c4d9-4d79-b35c-cd5b658388ab",
  draftHash: "32dfe1a9341118b8e868650a1ed5c6bf70b7257728ca3637f374fda5e54ee4e0",
  sourceResultId: "c023899f-4dbe-46b9-89d4-2e1065709ca7", sourceResultHash: "b".repeat(64),
};
const territory = "discovery.owner_question.92b3f78b12b94f1d81f2db03bc2c0732";
const territoryQuestion = "Quais são os limites exatos de atendimento dentro dos cinco condados, especialmente em Marin após San Rafael e na Península após Palo Alto?";
// Exact owner text from failed-call-3c7a37be.json, turn at 00:51:10.022Z.
const territoryText = "Exatamente. É isso mesmo, só atendemos no Vato, São Rafael e Petaluma. Qualquer endereço fora dessas cidades não é atendido, a não ser que eu aprove uma exceção explicitamente";
const seed = (id: string, extra: Partial<AgendaSeed> = {}): AgendaSeed => ({
  id, source: "owner_private_requirement", subject: id, questionPt: `Qual é a política de ${id}?`,
  coverageRefs: [id], relatedItemIds: [], blocking: true, ...extra,
});
const make = () => createOnboardingAgenda(binding, [
  seed(territory, { source: "ambiguity", questionPt: territoryQuestion, relatedItemIds: ["area.out_of_area_policy"] }),
  seed("area.out_of_area_policy"), seed("owner.emergency_contact"),
]);
const apply = (agenda: OnboardingAgenda, turnId: string, text: string, proposal: AgendaProposal) =>
  applyVerifiedOwnerTurn(agenda, { type: "verified_owner_turn", binding, turnId, text, proposal });

const candidatePhone = {
  id: "candidate:950d347b-63cb-4ea9-a0ef-9dfca0a9d97f", subject: "public_phone",
  questionPt: "O telefone publicado está incorreto. Qual é o telefone correto?",
  coverageRefs: ["discovery.candidate.950d347b63cb4ea9a0ef9dfca0a9d97f"],
};
const candidatePrice = {
  id: "candidate:70df1b75-16c3-45fd-a00f-e83c678c22cc", subject: "service",
  questionPt: "Qual é o preço correto do diagnóstico e suas condições?",
  coverageRefs: ["discovery.candidate.70df1b7516c345fda00fe83c678c22cc"],
};

describe("owner correction of known website candidates", () => {
  test("candidate catalog does not add initial questions and phone correction creates one exact durable override", () => {
    const initial = createOnboardingAgenda(binding, [], [candidatePhone, candidatePrice]);
    expect(initial.items).toEqual([]);
    expect(initial.candidateOverrides).toEqual([]);
    expect(initial.candidateContext).toEqual([candidatePhone, candidatePrice]);
    expect(getAgendaAction(initial).type).toBe("GENERATE_FINAL_SUMMARY");
    const text = "Corrija o telefone do website: o telefone certo é 510-555-7777.";
    const result = apply(initial, "phone-correction", text, { kind: "correction", affectedCandidates: [{ candidateId: candidatePhone.id, disposition: "corrected" }] });
    expect(result.accepted).toBe(true);
    expect(result.agenda.items).toEqual([]);
    expect(result.agenda.revision).toBe(1);
    expect(result.agenda.candidateOverrides).toEqual([expect.objectContaining({
      ...candidatePhone, source: "contradiction", blocking: true, relatedItemIds: [], status: "corrected", answerRevision: 1,
      evidence: [{ turnId: "phone-correction", text }],
    })]);
    expect(projectAgendaSummary(result.agenda).corrected.map(item => item.id)).toEqual([candidatePhone.id]);
    const reread = parseOnboardingAgenda(JSON.parse(JSON.stringify(result.agenda)), binding);
    expect(reread).toEqual(result.agenda);
    expect(Object.isFrozen(reread.candidateContext[0].coverageRefs)).toBe(true);
    expect(Object.isFrozen(reread.candidateOverrides[0].evidence)).toBe(true);
    expect(apply(reread, "phone-correction", text, { kind: "off_scope" }).replayed).toBe(true);
    expect(apply(reread, "second-answer", "Um telefone diferente.", { kind: "answer", itemId: candidatePhone.id }).accepted).toBe(false);
  });

  test("reopened candidates use the existing clarification budget after regular gaps and can defer without invented values", () => {
    let agenda = createOnboardingAgenda(binding, [seed("original-gap")], [candidatePhone]);
    agenda = apply(agenda, "reopen-phone", "Esse telefone está errado, preciso confirmar o correto.", {
      kind: "correction", affectedCandidates: [{ candidateId: candidatePhone.id, disposition: "reopen" }],
    }).agenda;
    expect(getAgendaAction(agenda).itemId).toBe("original-gap");
    agenda = apply(agenda, "answer-gap", "Resposta original.", { kind: "answer", itemId: "original-gap" }).agenda;
    expect(projectAgendaSummary(agenda).readyForSummary).toBe(false);
    expect(getAgendaAction(agenda).itemId).toBe(candidatePhone.id);
    for (let n = 0; n < 3; n++) agenda = apply(agenda, `clarify-phone-${n}`, "Ainda não consigo confirmar.", {
      kind: "clarification", itemId: candidatePhone.id, questionPt: "Model narrative must not replace source question.",
    }).agenda;
    expect(agenda.items).toHaveLength(1);
    expect(agenda.candidateOverrides[0]).toMatchObject({ status: "deferred_owner_review", clarificationCount: 2,
      lastQuestionPt: candidatePhone.questionPt, answerRevision: 1 });
    expect(projectAgendaSummary(agenda).readyForSummary).toBe(true);
    expect(projectAgendaSummary(agenda).activationBlockingUnknowns.map(item => item.id)).toEqual([candidatePhone.id]);
    expect(parseOnboardingAgenda(JSON.parse(JSON.stringify(agenda)), binding)).toEqual(agenda);
  });

  test("public price correction may reopen then answer once and never mutate immutable candidate metadata", () => {
    let agenda = createOnboardingAgenda(binding, [], [candidatePrice]);
    const originalContext = JSON.stringify(agenda.candidateContext);
    agenda = apply(agenda, "price-reopen", "O preço do website precisa de correção.", {
      kind: "correction", affectedCandidates: [{ candidateId: candidatePrice.id, disposition: "reopen" }],
    }).agenda;
    const answer = apply(agenda, "price-answer", "São 99 dólares, creditados no reparo aprovado.", { kind: "answer", itemId: candidatePrice.id });
    expect(answer.accepted).toBe(true);
    expect(answer.agenda.candidateOverrides[0]).toMatchObject({ status: "corrected", answerRevision: 2 });
    expect(answer.agenda.candidateOverrides[0].evidence.at(-1)?.text).toBe("São 99 dólares, creditados no reparo aprovado.");
    expect(JSON.stringify(answer.agenda.candidateContext)).toBe(originalContext);
    expect(apply(answer.agenda, "price-answer-again", "São zero dólares.", { kind: "answer", itemId: candidatePrice.id }).accepted).toBe(false);
  });

  test("invalid, duplicate and cross-namespace candidate targets cannot partly update a valid target", () => {
    const agenda = createOnboardingAgenda(binding, [seed("regular")], [candidatePhone]);
    expect(() => createOnboardingAgenda(binding, [], [candidatePhone, candidatePhone])).toThrow();
    expect(() => createOnboardingAgenda(binding, [seed(candidatePhone.id)], [candidatePhone])).toThrow();
    expect(() => createOnboardingAgenda(binding, [], [{ ...candidatePhone, coverageRefs: ["authority.book"] }])).toThrow();
    expect(() => createOnboardingAgenda(binding, [], [{ ...candidatePhone, id: "candidate:unknown" }])).toThrow();
    expect(() => apply(agenda, "duplicate-target", "Correção.", { kind: "correction", affectedCandidates: [
      { candidateId: candidatePhone.id, disposition: "corrected" }, { candidateId: candidatePhone.id, disposition: "reopen" },
    ] })).toThrow();
    for (const proposal of [
      { kind: "correction", affectedItems: [{ itemId: "regular", disposition: "corrected" }], affectedCandidates: [{ candidateId: "candidate:unknown", disposition: "corrected" }] },
      { kind: "correction", affectedItems: [{ itemId: candidatePhone.id, disposition: "corrected" }] },
      { kind: "correction", affectedCandidates: [{ candidateId: "regular", disposition: "corrected" }] },
    ] as AgendaProposal[]) {
      const result = apply(agenda, "invalid-target", "Correção.", proposal);
      expect(result.accepted).toBe(false); expect(result.agenda).toBe(agenda);
    }
  });

  test.each(["question", "refs", "source", "related", "duplicate", "unknown", "missing-context", "missing-overrides"])("parser rejects candidate metadata or scope corruption: %s", mode => {
    const corrected = apply(createOnboardingAgenda(binding, [], [candidatePhone]), "phone", "Telefone corrigido.", {
      kind: "correction", affectedCandidates: [{ candidateId: candidatePhone.id, disposition: "corrected" }],
    }).agenda;
    const raw = JSON.parse(JSON.stringify(corrected));
    if (mode === "question") raw.candidateOverrides[0].questionPt = "Outra pergunta";
    if (mode === "refs") raw.candidateOverrides[0].coverageRefs = ["authority.book"];
    if (mode === "source") raw.candidateOverrides[0].source = "owner_private_requirement";
    if (mode === "related") raw.candidateOverrides[0].relatedItemIds = [candidatePhone.id];
    if (mode === "duplicate") raw.candidateOverrides.push(raw.candidateOverrides[0]);
    if (mode === "unknown") raw.candidateOverrides[0].id = candidatePrice.id;
    if (mode === "missing-context") delete raw.candidateContext;
    if (mode === "missing-overrides") delete raw.candidateOverrides;
    expect(() => parseOnboardingAgenda(raw, binding)).toThrow();
  });
});

describe("finite evidence-bound onboarding agenda", () => {
  test("sanitized forensic fixture retains actual candidate facts, sixteen source questions and initial coverage", () => {
    const draft = foghorn.draft_row.draft;
    expect(draft.candidate_facts).toHaveLength(21);
    expect(draft.missing_information).toHaveLength(6);
    expect(draft.contradictions).toHaveLength(2);
    expect(draft.owner_private_information_needed).toHaveLength(8);
    expect(draft.ambiguous_information).toHaveLength(0);
    expect(foghorn.initial_coverage.revision).toBe(1);
    expect(foghorn.recorded_transcript.some(turn => turn.role === "caller" && turn.text === territoryText)).toBe(true);
    expect(foghorn.draft_row.draft_hash).toBe(binding.draftHash);
  });
  test("wrong-target forensic territory proposal cannot advance or strand current gap", () => {
    const agenda = make();
    const result = apply(agenda, "territory-turn", territoryText, { kind: "answer", itemId: "area.out_of_area_policy" });
    expect(result.accepted).toBe(false);
    expect(result.agenda).toBe(agenda);
    expect(result.action!.itemId).toBe(territory);
    expect(result.action!.questionPt).toBe(territoryQuestion);
    expect(result.action!.type).toBe("CLARIFY_CURRENT_GAP");
  });

  test("answer binds current gap and explicitly related destinations to exact evidence", () => {
    const agenda = make();
    const result = apply(agenda, "territory-turn", territoryText, {
      kind: "answer", itemId: territory, relatedItemIds: ["area.out_of_area_policy"],
    });
    expect(result.action!.type).toBe("CONFIRM_AND_ASK_NEXT");
    expect(result.action!.itemId).toBe("owner.emergency_contact");
    expect(result.agenda.items.slice(0, 2).map(i => i.status)).toEqual(["answered", "answered"]);
    expect(result.agenda.items[0].evidence).toEqual([{ turnId: "territory-turn", text: territoryText }]);
    expect(result.agenda.items[1].evidence).toEqual(result.agenda.items[0].evidence);
    expect(agenda.items[0].status).toBe("open");
    expect(Object.isFrozen(result.agenda.items[0].evidence)).toBe(true);
  });

  test.each(["unknown", "owner.emergency_contact"])("rejects unknown or unrelated destination %s atomically", destination => {
    const agenda = make();
    const result = apply(agenda, "t1", territoryText, { kind: "answer", itemId: territory, relatedItemIds: [destination] });
    expect(result.accepted).toBe(false);
    expect(result.agenda).toBe(agenda);
  });

  test.each([
    "Ótimo, quero sim. Me manda um texto curto e direto que eu possa colocar no site e usar no script do agente.",
    "Escreva agora uma propaganda para o meu site.",
  ])("off-scope accepted offer or direct copy request redirects without resolving gap: %s", text => {
    const result = apply(make(), "copy-turn", text, { kind: "off_scope" });
    expect(result.action!.type).toBe("DEFER_OFF_SCOPE_AND_CONTINUE");
    expect(result.action!.questionPt).toBe(territoryQuestion);
    expect(result.action!.spokenPt).toContain(territoryQuestion);
    expect(result.agenda.items.every(i => i.status === "open")).toBe(true);
    expect(Object.keys(result.action!).sort()).toEqual(["actionId", "itemId", "questionPt", "spokenPt", "type"]);
  });

  test("two clarifications after initial ask then defer retaining question and evidence", () => {
    let agenda = make();
    expect(getAgendaAction(agenda).type).toBe("ASK_NEXT_GAP");
    for (let n = 1; n <= 2; n++) {
      const result = apply(agenda, `c${n}`, `Dúvida ${n}`, { kind: "clarification", itemId: territory, questionPt: `Você pode esclarecer os limites ${n}?` });
      expect(result.action!.type).toBe("CLARIFY_CURRENT_GAP");
      expect(result.action!.questionPt).toBe(territoryQuestion);
      agenda = result.agenda;
    }
    const exhausted = apply(agenda, "c3", "Ainda não sei", { kind: "clarification", itemId: territory, questionPt: "Outra pergunta que não deve ser feita?" });
    expect(exhausted.agenda.items[0].status).toBe("deferred_owner_review");
    expect(exhausted.agenda.items[0].clarificationCount).toBe(2);
    expect(exhausted.agenda.items[0].lastQuestionPt).toBe(territoryQuestion);
    expect(exhausted.agenda.items[0].evidence.at(-1)?.text).toBe("Ainda não sei");
    expect(exhausted.agenda.items[0].answerRevision).toBe(0);
    expect(exhausted.action!.itemId).toBe("area.out_of_area_policy");
  });

  test("repeated off-scope turns exhaust the same per-item clarification budget without becoming answers", () => {
    let agenda = make();
    for (let n = 1; n <= 2; n++) {
      const result = apply(agenda, `off-${n}`, `Faça outra coisa ${n}`, { kind: "off_scope" });
      expect(result.action!.type).toBe("DEFER_OFF_SCOPE_AND_CONTINUE");
      expect(result.action!.questionPt).toBe(territoryQuestion);
      expect(result.agenda.items[0].clarificationCount).toBe(n);
      agenda = result.agenda;
    }
    const result = apply(agenda, "off-3", "Escreva o texto agora", { kind: "off_scope" });
    expect(result.action!.type).toBe("DEFER_OFF_SCOPE_AND_CONTINUE");
    expect(result.action!.itemId).toBe("area.out_of_area_policy");
    expect(result.agenda.items[0].status).toBe("deferred_owner_review");
    expect(result.agenda.items[0].answerRevision).toBe(0);
    expect(result.agenda.items[0].lastQuestionPt).toBe(territoryQuestion);
    expect(result.agenda.items[0].evidence.map(e => e.text)).toEqual(["Faça outra coisa 1", "Faça outra coisa 2", "Escreva o texto agora"]);
    expect(projectAgendaSummary(result.agenda).activationBlockingUnknowns.map(i => i.id)).toContain(territory);
  });

  test("off-scope and relevant clarification share a budget instead of alternating forever", () => {
    let agenda = apply(make(), "c1", "Não entendi", { kind: "clarification", itemId: territory }).agenda;
    agenda = apply(agenda, "o2", "Faça um anúncio", { kind: "off_scope" }).agenda;
    const result = apply(agenda, "c3", "Ainda não entendi", { kind: "clarification", itemId: territory });
    expect(result.agenda.items[0].status).toBe("deferred_owner_review");
    expect(result.agenda.items[0].clarificationCount).toBe(2);
    expect(result.action!.itemId).toBe("area.out_of_area_policy");
  });

  test("same turn replay no-ops even after queue advances; changed exact text rejects", () => {
    const first = apply(make(), "t1", territoryText, { kind: "answer", itemId: territory });
    const replay = apply(first.agenda, "t1", territoryText, { kind: "off_scope" });
    expect(replay.replayed).toBe(true);
    expect(replay.agenda).toBe(first.agenda);
    expect(replay.action).toBe(null);
    expect(() => apply(first.agenda, "t1", `${territoryText} `, { kind: "off_scope" })).toThrow(/evidence/);
  });

  test("binding drift, invalid hashes, blank and oversized identities reject", () => {
    expect(() => createOnboardingAgenda({ ...binding, draftHash: "no-hash" }, [])).toThrow();
    expect(() => createOnboardingAgenda({ ...binding, callId: "" }, [])).toThrow();
    expect(() => createOnboardingAgenda({ ...binding, callId: "a".repeat(513) }, [])).toThrow();
    expect(() => applyVerifiedOwnerTurn(make(), { type: "verified_owner_turn", binding: { ...binding, sourceResultId: "other" }, turnId: "t", text: "Sim", proposal: { kind: "off_scope" } })).toThrow(/binding/);
  });

  test("duplicate ids, unknown related refs and sparse seeds fail rather than dropping input", () => {
    expect(() => createOnboardingAgenda(binding, [seed("x"), seed("x")])).toThrow();
    expect(() => createOnboardingAgenda(binding, [seed("x", { relatedItemIds: ["absent"] })])).toThrow();
    expect(() => createOnboardingAgenda(binding, new Array(2))).toThrow();
  });

  test("more than five or sixteen questions are neither truncated nor prematurely summarized", () => {
    let agenda = createOnboardingAgenda(binding, Array.from({ length: 25 }, (_, i) => seed(`gap-${i}`)));
    for (let i = 0; i < 25; i++) {
      expect(getAgendaAction(agenda).itemId).toBe(`gap-${i}`);
      const result = apply(agenda, `t${i}`, `Resposta ${i}`, { kind: "answer", itemId: `gap-${i}` });
      expect(result.action!.type).toBe(i === 24 ? "GENERATE_FINAL_SUMMARY" : "CONFIRM_AND_ASK_NEXT");
      agenda = result.agenda;
    }
    expect(projectAgendaSummary(agenda).confirmed).toHaveLength(25);
  });

  test("deferred summary is ready to review but exposes blocking unknowns, never invented answers", () => {
    let agenda = createOnboardingAgenda(binding, [seed("required"), seed("optional", { blocking: false }), seed("irrelevant")]);
    agenda = apply(agenda, "d1", "Não sei", { kind: "defer", itemId: "required" }).agenda;
    agenda = apply(agenda, "d2", "Depois", { kind: "defer", itemId: "optional" }).agenda;
    agenda = apply(agenda, "d3", "Não se aplica", { kind: "not_applicable", itemId: "irrelevant" }).agenda;
    const summary = projectAgendaSummary(agenda);
    expect(summary.readyForSummary).toBe(true);
    expect(summary.confirmed).toHaveLength(0);
    expect(summary.deferred.map(i => i.id)).toEqual(["required", "optional"]);
    expect(summary.activationBlockingUnknowns.map(i => i.id)).toEqual(["required"]);
    expect(summary.notApplicable.map(i => i.id)).toEqual(["irrelevant"]);
  });

  test("explicit correction updates history and reopens affected item, invalidating summary", () => {
    let agenda = createOnboardingAgenda(binding, [seed("a"), seed("b")]);
    agenda = apply(agenda, "t1", "Primeira resposta", { kind: "answer", itemId: "a" }).agenda;
    agenda = apply(agenda, "t2", "Segunda resposta", { kind: "answer", itemId: "b" }).agenda;
    expect(projectAgendaSummary(agenda).readyForSummary).toBe(true);
    const corrected = apply(agenda, "t3", "Corrijo a primeira e preciso rever a segunda", { kind: "correction", affectedItems: [{ itemId: "a", disposition: "corrected" }, { itemId: "b", disposition: "reopen" }] });
    expect(projectAgendaSummary(corrected.agenda).readyForSummary).toBe(false);
    expect(projectAgendaSummary(corrected.agenda).corrected.map(i => i.id)).toEqual(["a"]);
    expect(corrected.agenda.items.map(i => i.answerRevision)).toEqual([2, 2]);
    expect(corrected.agenda.items[0].evidence.map(e => e.turnId)).toEqual(["t1", "t3"]);
    expect(corrected.action!.itemId).toBe("b");
    expect(corrected.action!.type).toBe("HANDLE_OWNER_CORRECTION");
    expect(corrected.agenda.revision).toBe(3);
  });

  test("correction with unknown target rejects without partly modifying known target", () => {
    const agenda = make();
    const result = apply(agenda, "t", "Correção", { kind: "correction", affectedItems: [{ itemId: territory, disposition: "corrected" }, { itemId: "unknown", disposition: "reopen" }] });
    expect(result.accepted).toBe(false);
    expect(result.agenda).toBe(agenda);
  });

  test("action IDs remain stable on reread and vary after a verified new turn", () => {
    const agenda = make();
    expect(getAgendaAction(agenda).actionId).toBe(getAgendaAction(agenda).actionId);
    const next = apply(agenda, "t", "Depois", { kind: "off_scope" });
    expect(next.action!.actionId).not.toBe(getAgendaAction(agenda).actionId);
  });

  test("oversized finite seed contract rejects explicitly without truncation", () => {
    expect(() => createOnboardingAgenda(binding, Array.from({length: 1025}, (_, i) => seed(`i${i}`)))).toThrow(/limit/);
  });

  test("durable valid states roundtrip frozen with exact evidence and replay null", () => {
    const states = [make()];
    states.push(apply(states.at(-1)!, "c", "Qual limite?", { kind: "clarification", itemId: territory }).agenda);
    states.push(apply(states.at(-1)!, "a", territoryText, { kind: "answer", itemId: territory, relatedItemIds: ["area.out_of_area_policy"] }).agenda);
    states.push(apply(states.at(-1)!, "d", "Depois", { kind: "defer", itemId: "owner.emergency_contact" }).agenda);
    states.push(apply(states.at(-1)!, "r", "Corrijo", { kind: "correction", affectedItems: [{ itemId: territory, disposition: "reopen" }, { itemId: "area.out_of_area_policy", disposition: "corrected" }] }).agenda);
    states.push(apply(states.at(-1)!, "n", "Não se aplica", { kind: "not_applicable", itemId: territory }).agenda);
    for (const state of states) {
      const raw = JSON.parse(JSON.stringify(state));
      const parsed = parseOnboardingAgenda(raw, binding);
      expect(parsed).toEqual(state);
      expect(Object.isFrozen(parsed.items[0].evidence)).toBe(true);
      expect(Object.isFrozen(parsed.binding)).toBe(true);
      expect(getAgendaAction(parsed)).toEqual(getAgendaAction(state));
      raw.items[0].questionPt = "Injected";
      expect(parsed.items[0].questionPt).toBe(territoryQuestion);
      if (parsed.ownerTurns.length) {
        const turn = parsed.ownerTurns[0];
        expect(apply(parsed, turn.turnId, turn.text, { kind: "off_scope" }).action).toBe(null);
      }
    }
  });

  test.each([
    ["version", (a: any) => { a.version = 2; }],
    ["binding", (a: any) => { a.binding.callId = "other"; }],
    ["extra binding field", (a: any) => { a.binding.approved = true; }],
    ["unknown status would look exhausted", (a: any) => { a.items.forEach((i: any) => { i.status = "done"; }); }],
    ["answer without evidence", (a: any) => { a.items[0].status = "answered"; }],
    ["duplicate items", (a: any) => { a.items[1].id = a.items[0].id; }],
    ["duplicate coverage refs", (a: any) => { a.items[0].coverageRefs.push(a.items[0].coverageRefs[0]); }],
    ["unknown related item", (a: any) => { a.items[0].relatedItemIds = ["unknown"]; }],
    ["bad source", (a: any) => { a.items[0].source = "model"; }],
    ["negative revision", (a: any) => { a.revision = -1; }],
    ["revision not matching turns", (a: any) => { a.revision = 7; }],
    ["fractional answer counter", (a: any) => { a.items[0].answerRevision = 0.5; }],
    ["unsafe integer counter", (a: any) => { a.items[0].answerRevision = Number.MAX_SAFE_INTEGER + 1; }],
    ["clarification overflow", (a: any) => { a.items[0].clarificationCount = 3; }],
    ["unknown evidence turn", (a: any) => { a.items[0].evidence = [{ turnId: "invented", text: "Sim" }]; }],
    ["extra state authority", (a: any) => { a.approved = true; }],
    ["changed last question", (a: any) => { a.items[0].lastQuestionPt = "Write copy"; }],
    ["sparse items", (a: any) => { delete a.items[0]; }],
  ] as const)("rejects persisted corruption: %s", (_name, corrupt) => {
    const raw = JSON.parse(JSON.stringify(make()));
    corrupt(raw);
    expect(() => parseOnboardingAgenda(raw, binding)).toThrow();
  });

  test.each(["duplicate_turn", "different_evidence", "duplicate_item_evidence", "out_of_order_evidence"])("rejects persisted evidence corruption %s", mode => {
    let agenda = apply(make(), "c", "Não entendi", { kind: "clarification", itemId: territory }).agenda;
    agenda = apply(agenda, "a", territoryText, { kind: "answer", itemId: territory }).agenda;
    const raw = JSON.parse(JSON.stringify(agenda));
    if (mode === "duplicate_turn") { raw.ownerTurns.push(raw.ownerTurns[0]); raw.revision++; }
    if (mode === "different_evidence") raw.items[0].evidence[0].text = "Sim";
    if (mode === "duplicate_item_evidence") raw.items[0].evidence.push(raw.items[0].evidence[0]);
    if (mode === "out_of_order_evidence") raw.items[0].evidence.reverse();
    expect(() => parseOnboardingAgenda(raw, binding)).toThrow();
  });

  test("turn history is not arbitrarily capped at the item resource bound", () => {
    const raw = JSON.parse(JSON.stringify(createOnboardingAgenda(binding, [])));
    raw.ownerTurns = Array.from({ length: 1100 }, (_, i) => ({ turnId: `t${i}`, text: "Depois" }));
    raw.revision = 1100;
    expect(parseOnboardingAgenda(raw, binding).ownerTurns).toHaveLength(1100);
  });
});
