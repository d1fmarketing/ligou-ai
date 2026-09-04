import { expect, test } from "bun:test";
import fixture from "./fixtures/foghorn-website-first-voice.json";
import { buildWebsiteAgendaSeeds, type WebsiteAgendaSeedProjection } from "../src/onboarding-agenda-seed.ts";
import { applyVerifiedOwnerTurn, createOnboardingAgenda, getAgendaAction, type OnboardingAgenda, type AgendaProposal } from "../src/onboarding-agenda.ts";
import { onboardingAgendaDigest, type StoredWebsiteInterview } from "../src/onboarding-agenda-store.ts";
import type { CoverageSnapshot } from "../src/onboarding-coverage.ts";
import { buildWebsiteCandidateContext, generateWebsiteSummaryParts } from "../src/onboarding-website-summary.ts";

const { tenant_id: _, ...draftReadback } = fixture.draft_row;
const projection = buildWebsiteAgendaSeeds({ draftReadback, initialCoverage: fixture.initial_coverage.snapshot as CoverageSnapshot });
const binding = { interviewId: "1c7a37be-c8a0-456e-a1a1-9b937bd0ef4a", callId: projection.provenance.callId,
  draftId: projection.provenance.draftId, draftHash: projection.provenance.draftHash,
  sourceResultId: projection.provenance.sourceResultId, sourceResultHash: projection.provenance.sourceResultHash };
const fresh = () => createOnboardingAgenda(binding, projection.seeds, buildWebsiteCandidateContext(projection));
function apply(agenda: OnboardingAgenda, text: string, proposal: AgendaProposal) {
  return applyVerifiedOwnerTurn(agenda, { type: "verified_owner_turn", binding, turnId: `turn-${agenda.revision}`, text, proposal }).agenda;
}
function stored(agenda: OnboardingAgenda): StoredWebsiteInterview {
  return { agenda, revision: agenda.revision, storeVersion: agenda.revision, digest: onboardingAgendaDigest(agenda),
    receiptId: "2c7a37be-c8a0-456e-a1a1-9b937bd0ef4a", nextAction: getAgendaAction(agenda), state: getAgendaAction(agenda).itemId ? "unfinished" : "reviewing", replayed: false };
}
function finish(agenda = fresh()) {
  let count = 0;
  while (getAgendaAction(agenda).itemId) {
    const itemId = getAgendaAction(agenda).itemId!;
    const item = agenda.items.find(item => item.id === itemId)!;
    const kind = count % 11 === 0 ? "not_applicable" : count % 7 === 0 ? "defer" : "answer";
    const text = kind === "defer" ? "Preciso revisar esse ponto pessoalmente antes de qualquer autorização." :
      kind === "not_applicable" ? `Esse requisito não se aplica ao serviço ${item.subject}.` :
      `Resposta explícita ${count}: a política de ${item.subject} depende de minha aprovação caso a caso, sem autorização automática.`;
    agenda = apply(agenda, text, { kind, itemId }); count++;
  }
  return agenda;
}
function generate(agenda: OnboardingAgenda, source: WebsiteAgendaSeedProjection = projection) {
  return generateWebsiteSummaryParts({ stored: stored(agenda), projection: source });
}

test("exact Foghorn summary retains all 21 website candidates, conditional prices, 114 dispositions and private boundaries", () => {
  const agenda = finish();
  const parts = generate(agenda);
  expect(parts.length).toBeGreaterThan(0);
  const text = parts.join("");
  expect(text.match(/Candidata do website \d+ de 21:/g)).toHaveLength(21);
  for (const phrase of ["Credited to the repair.", "Per month per system.", "After rebates.", "Most repairs are publicly listed at $180–$650.",
    "89.00", "24.00", "11900.00", "1450.00", "180.00", "0.00", "USD", "Foghorn Air, Inc.", "San Mateo", "07:00", "19:00"])
    expect(text).toContain(phrase);
  for (const item of agenda.items) expect(text).toContain(item.questionPt);
  expect(text).toContain("Informações privadas confirmadas pelo dono");
  expect(text).toContain("Pendências para revisão do dono");
  expect(text).toContain("Não aplicável, segundo o dono");
  expect(text).toContain("não autoriza ativação, regras ou poderes");
  expect(text).not.toContain("Seu onboarding foi concluído");
  expect(parts.every(part => [...part].length <= 1400)).toBe(true);
});

test("one shared owner answer is quoted once with every related question and latest correction replaces historical authority", () => {
  let agenda = fresh();
  const first = agenda.items[0]!;
  const related = first.relatedItemIds.slice(0, 1);
  expect(related).toHaveLength(1);
  const shared = "Limite compartilhado: atendemos San Rafael e Petaluma, com exceções somente por minha aprovação.";
  agenda = apply(agenda, shared, { kind: "answer", itemId: first.id, relatedItemIds: related });
  agenda = finish(agenda);
  const before = generate(agenda).join("");
  expect(before.split(shared)).toHaveLength(2);
  const correction = "Correção definitiva: apenas San Rafael; Petaluma não é atendida sem minha aprovação explícita.";
  agenda = apply(agenda, correction, { kind: "correction", affectedItems: [first.id, ...related].map(itemId => ({ itemId, disposition: "corrected" })) });
  const after = generate(agenda).join("");
  expect(after.split(correction)).toHaveLength(2);
  expect(after.split(shared)).toHaveLength(2);
  expect(after).toContain("Correções efetivas do dono");
  expect(after).toContain("Histórico substituído: não é uma decisão atual");
  expect(after.indexOf(correction)).toBeLessThan(after.indexOf(shared));
  expect(after).toContain(first.questionPt);
  expect(after).toContain(agenda.items.find(item => item.id === related[0])!.questionPt);
});

test("off-scope requests and exhausted clarification evidence are not read as business decisions", () => {
  let agenda = fresh();
  const first = agenda.items[0]!;
  const offscope = "Me manda um texto curto para meu site; posso te ajudar com outra coisa?";
  for (let i = 0; i < 3; i++) agenda = apply(agenda, offscope, { kind: "off_scope" });
  const second = getAgendaAction(agenda).itemId!;
  for (let i = 0; i < 3; i++) agenda = apply(agenda, "Não entendi; o que significa essa pergunta?", { kind: "clarification", itemId: second });
  agenda = finish(agenda);
  const text = generate(agenda).join("");
  expect(text).not.toContain(offscope);
  expect(text).not.toContain("Não entendi; o que significa essa pergunta?");
  expect(text).toContain(first.questionPt);
  expect(text).toContain(agenda.items.find(item => item.id === second)!.questionPt);
  expect(text).toContain("permanecem desconhecidas ou sem autorização");
});

test("long Unicode owner evidence is split losslessly with no 4096-codepoint overflow or missing tail", () => {
  let agenda = fresh();
  const text = `Valor literal com unicode: ${"🧑🏽‍🔧 política explícita; ".repeat(600)} FIM EXATO DA EVIDÊNCIA.`;
  agenda = apply(agenda, text, { kind: "answer", itemId: agenda.items[0]!.id });
  agenda = finish(agenda);
  const parts = generate(agenda);
  expect(parts.join("")).toContain(text);
  expect(parts.every(part => [...part].length <= 1400 && part.trim().length > 0)).toBe(true);
  expect(parts.every(part => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part))).toBe(true);
});

test("summary refuses open queue, tampered receipt, changed provenance and altered seed obligations", () => {
  const initial = fresh();
  expect(() => generate(initial)).toThrow();
  const agenda = finish(initial);
  expect(() => generateWebsiteSummaryParts({ stored: { ...stored(agenda), digest: "a".repeat(64) }, projection })).toThrow();
  expect(() => generate(agenda, { ...projection, provenance: { ...projection.provenance, sourceResultHash: "b".repeat(64) } })).toThrow();
  expect(() => generate(agenda, { ...projection, seeds: projection.seeds.slice(1) })).toThrow();
});

test("literal business policy is not discarded by a summary-layer guess about off-scope keywords", () => {
  let agenda = fresh();
  const text = "Atendemos agências de propaganda como clientes comerciais. A palavra texto nos orçamentos não muda o preço nem autoriza desconto.";
  agenda = apply(agenda, text, { kind: "answer", itemId: agenda.items[0]!.id });
  agenda = finish(agenda);
  expect(generate(agenda).join("")).toContain(text);
});

test("trusted candidate context covers all 21 original facts without adding any of them to the 114 initial questions", () => {
  const context = buildWebsiteCandidateContext(projection);
  expect(context).toHaveLength(21);
  for (const [index, candidate] of projection.candidateRecap.entries()) {
    expect(context[index]).toMatchObject({ id: `candidate:${candidate.claim_id}`, subject: candidate.claim_type,
      coverageRefs: [`discovery.candidate.${String(candidate.claim_id).replaceAll("-", "")}`] });
    expect(context[index]!.questionPt.length).toBeLessThanOrEqual(8192);
  }
  const agenda = fresh();
  expect(agenda.items).toHaveLength(114);
  expect(agenda.candidateOverrides).toEqual([]);
  expect(getAgendaAction(agenda).itemId).toBe(projection.seeds[0]!.id);
});

test("known phone and public price corrections appear as current owner values while original 21 candidates remain historical", () => {
  const before = finish();
  const originalSource = JSON.stringify(projection.candidateRecap);
  const phone = "candidate:950d347b-63cb-4ea9-a0ef-9dfca0a9d97f";
  const price = "candidate:70df1b75-16c3-45fd-a00f-e83c678c22cc";
  const correctedPhone = "O telefone correto é 510-555-7777; o número do website está errado.";
  let agenda = apply(before, correctedPhone, { kind: "correction", affectedCandidates: [{ candidateId: phone, disposition: "corrected" }] });
  const correctedPrice = "Corrijo o diagnóstico para USD 99.00, creditados no reparo aprovado, não USD 89.00.";
  agenda = apply(agenda, correctedPrice, { kind: "correction", affectedCandidates: [{ candidateId: price, disposition: "corrected" }] });
  expect(agenda.items).toEqual(before.items);
  expect(agenda.candidateOverrides).toHaveLength(2);
  const text = generate(agenda).join("");
  expect(text).toContain(correctedPhone);
  expect(text).toContain(correctedPrice);
  expect(text).toContain("Informação original substituída por correção do dono");
  expect(text).toContain("(510) 555-0142");
  expect(text).toContain("Credited to the repair.");
  expect(text.match(/Candidata do website \d+ de 21:/g)).toHaveLength(21);
  expect(JSON.stringify(projection.candidateRecap)).toBe(originalSource);
  expect(stored(agenda).digest).not.toBe(stored(before).digest);
});

test("unresolved then deferred known-candidate correction invalidates summary and remains an activation-blocking unknown", () => {
  const name = "candidate:58288783-2423-4bea-a5b4-85cd5889a483";
  let agenda = apply(finish(), "O nome do website não está correto; preciso conferir o nome legal.", {
    kind: "correction", affectedCandidates: [{ candidateId: name, disposition: "reopen" }],
  });
  expect(getAgendaAction(agenda).itemId).toBe(name);
  expect(() => generate(agenda)).toThrow();
  for (let n = 0; n < 3; n++) agenda = apply(agenda, "Ainda não sei o nome legal correto.", { kind: "clarification", itemId: name });
  expect(getAgendaAction(agenda).type).toBe("GENERATE_FINAL_SUMMARY");
  const text = generate(agenda).join("");
  expect(text).toContain("Informação original contestada; valor atual pendente de revisão");
  expect(text).toContain(agenda.candidateContext.find(item => item.id === name)!.questionPt);
  expect(text).not.toContain("Resposta literal do dono: “Ainda não sei o nome legal correto.");
  expect(text).toContain("bloqueiam a ativação");
});

test("candidate catalog metadata must still match the trusted source projection after persisted roundtrip", () => {
  const agenda = finish();
  const raw = JSON.parse(JSON.stringify(agenda));
  raw.candidateContext[0].questionPt = "Pergunta nova não proveniente da fonte selecionada.";
  expect(() => generate(raw)).toThrow();
  raw.candidateContext = [];
  expect(() => generate(raw)).toThrow();
});
