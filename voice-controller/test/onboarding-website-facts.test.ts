import { expect, test } from "bun:test";
import { createOnboardingAgenda, type AgendaProposal } from "../src/onboarding-agenda.ts";
import { validateWebsiteInterpretationFacts } from "../src/onboarding-website-facts.ts";
import * as websiteFacts from "../src/onboarding-website-facts.ts";

const binding = { interviewId: "interview-1", callId: "call-1", draftId: "draft-1", draftHash: "a".repeat(64), sourceResultId: "result-1", sourceResultHash: "b".repeat(64) };
const agenda = createOnboardingAgenda(binding, [
  { id: "current", source: "missing_website_information", subject: "area", questionPt: "Qual a política fora da área?", coverageRefs: ["area.out_of_area_policy"], relatedItemIds: ["related", "private"], blocking: true },
  { id: "related", source: "missing_website_information", subject: "area", questionPt: "Existe taxa de deslocamento?", coverageRefs: ["area.travel_fee"], relatedItemIds: [], blocking: true },
  { id: "private", source: "owner_private_requirement", subject: "authority", questionPt: "Qual a autoridade para agendar?", coverageRefs: ["authority.book"], relatedItemIds: [], blocking: true },
  { id: "hours", source: "missing_website_information", subject: "hours", questionPt: "Qual o horário?", coverageRefs: ["schedule.business_hours"], relatedItemIds: [], blocking: true },
]);
const raw = { topic: "area", field: "area.out_of_area_policy", disposition: "answered", rule_text: "Fora da área somente com aprovação do dono.", structured: { value: "Somente com aprovação explícita do dono." } };
const text = "Fora da área, só atenda se eu aprovar explicitamente. Não cobre taxa automática.";
const check = (facts: unknown, proposal: AgendaProposal = { kind: "answer", itemId: "current" }, currentItemId: string | null = "current", ownerTranscript = text) => {
  const currentAgenda=currentItemId && currentItemId!=="current"
    ?createOnboardingAgenda(binding,[...agenda.items].sort((a,b)=>a.id===currentItemId?-1:b.id===currentItemId?1:0))
    :agenda;
  return validateWebsiteInterpretationFacts({ facts, proposal, currentItemId, agenda:currentAgenda, ownerTranscript });
};

test("stages exact scoped business values with stored owner_words replacing any model-authored wording", () => {
  const result = check([{ ...raw, owner_words: "Texto inventado pelo modelo." }]);
  expect(result).toEqual([{ ...raw, owner_words: text }]);
  expect(result[0]).not.toHaveProperty("rules_approved");
  expect(result[0]).not.toHaveProperty("powers_granted");
  expect(raw).not.toHaveProperty("owner_words");
});
test("related facts require an explicit related proposal and cannot smuggle a private authority decision", () => {
  const travel = { ...raw, field: "area.travel_fee" };
  expect(() => check([raw, travel])).toThrow();
  expect(() => check([raw, travel], { kind: "answer", itemId: "current", relatedItemIds: ["related"] })).toThrow();
  expect(() => check([{ ...raw, topic: "outro", field: "authority.book" }], { kind: "answer", itemId: "current", relatedItemIds: ["private"] })).toThrow();
});
test("unknown fields, wrong subjects, duplicate refs, extra authority keys and malformed typed values throw atomically", () => {
  for (const invalid of [
    { ...raw, field: "unknown.field" }, { ...raw, subject: "unrelated-service" },
    { ...raw, powers_granted: true }, { ...raw, structured: { value: { fields: { "authority.book": "yes" } } } },
    { ...raw, structured: { value: 123 } },
  ]) expect(() => check([raw, invalid])).toThrow();
  expect(() => check([raw, raw])).toThrow();
  expect(() => check(Array.from({ length: 17 }, () => raw))).toThrow();
});
test("correction facts bind only explicit corrected targets and never a reopened or unrelated target", () => {
  const proposal: AgendaProposal = { kind: "correction", affectedItems: [{ itemId: "related", disposition: "corrected" }] };
  const fact = { ...raw, field: "area.travel_fee" };
  expect(check([fact], proposal, null)).toHaveLength(1);
  expect(() => check([raw], proposal, null)).toThrow();
  expect(() => check([fact], { kind: "correction", affectedItems: [{ itemId: "related", disposition: "reopen" }] }, null)).toThrow();
});
test("clarification and off-scope proposals cannot stage facts; empty facts preserve arbitrary full owner evidence", () => {
  expect(() => check([raw], { kind: "off_scope" })).toThrow();
  expect(() => check([raw], { kind: "clarification", itemId: "current" })).toThrow();
  expect(check([], { kind: "answer", itemId: "current" }, "current", "Evidência longa literal. ".repeat(1000))).toEqual([]);
  expect(() => check([raw], { kind: "answer", itemId: "current" }, "current", "Evidência longa literal. ".repeat(1000))).toThrow();
});
test("existing hours parser is preserved: invalid weekly shape is not silently accepted or rewritten", () => {
  expect(() => check([{ ...raw, topic: "agenda", field: "schedule.business_hours", structured: { value: "segunda a sexta das sete às sete" } }], { kind: "answer", itemId: "hours" }, "hours")).toThrow();
  const hours = { ...raw, topic: "agenda", field: "schedule.business_hours", structured: { value: { days: ["mon", "tue", "wed", "thu", "fri"], hours: { opens: "07:00", closes: "19:00" } } } };
  expect(check([hours], { kind: "answer", itemId: "hours" }, "hours")[0]?.structured).toEqual(hours.structured);
});

test("an explicitly undecided private answer cannot be staged as a decided authority rule", () => {
  const fact = { ...raw, topic: "outro", field: "authority.book", structured: { value: "Pode agendar sem consultar o dono." } };
  expect(() => check([fact], { kind: "answer", itemId: "private" }, "private", "Não sei. Preciso revisar essa autorização.")).toThrow();
  expect(check([], { kind: "answer", itemId: "private" }, "private", "Não sei. Preciso revisar essa autorização.")).toEqual([]);
  expect(check([{ ...fact, structured: { value: "Só pode agendar depois de minha aprovação explícita." } }],
    { kind: "answer", itemId: "private" }, "private", "Só pode agendar depois de minha aprovação explícita.")).toHaveLength(1);
});

test('native typed validation accepts structurally scoped empty facts without the legacy language applicability gate',()=>{
  const input={agenda,currentItemId:'current',ownerTranscript:'The nearby service visits have no travel charge.',
    proposal:{kind:'answer',itemId:'current',relatedItemIds:['related']} as AgendaProposal,facts:[]};
  expect(()=>validateWebsiteInterpretationFacts(input)).toThrow();
  expect(websiteFacts.validateWebsiteTypedFacts(input)).toEqual([]);
});
test('native typed validation preserves shape, reference, owner evidence and explicit-unknown protections',()=>{
  const validate=websiteFacts.validateWebsiteTypedFacts;
  const input={agenda,currentItemId:'current',ownerTranscript:text,proposal:{kind:'answer',itemId:'current'} as AgendaProposal,facts:[raw]};
  expect(validate(input)[0].owner_words).toBe(text);
  for(const facts of [[{...raw,powers_granted:true}],[{...raw,field:'area.travel_fee'}],[raw,raw],
    [{...raw,structured:{value:123}}]])expect(()=>validate({...input,facts})).toThrow();
  expect(()=>validate({...input,ownerTranscript:'',facts:[]})).toThrow();
  const privateInput={...input,currentItemId:'private',ownerTranscript:'Não sei. Preciso revisar essa autorização.',
    proposal:{kind:'answer',itemId:'private'} as AgendaProposal,
    facts:[{...raw,topic:'outro',field:'authority.book',structured:{value:'Pode agendar sem consultar o dono.'}}]};
  expect(()=>validate(privateInput)).toThrow();
});
