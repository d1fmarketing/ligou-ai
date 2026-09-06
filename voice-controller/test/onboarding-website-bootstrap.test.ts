import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/foghorn-website-first-voice.json";
import { prepareWebsiteInterview } from "../src/onboarding-website-bootstrap.ts";
import { getAgendaAction } from "../src/onboarding-agenda.ts";
import { onboardingAgendaDigest } from "../src/onboarding-agenda-store.ts";

const callId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const tenantId = fixture.draft_row.tenant_id;
const { tenant_id: ignored, ...draft } = fixture.draft_row;
const source = { prepared: true, preparationId: "44444444-4444-4444-8444-444444444444",
  draftId: draft.draft_id, draftHash: draft.draft_hash,
  sourceResultId: draft.draft.source_result_id, sourceResultHash: draft.draft.source_result_hash,
  draft_readback: draft };
function fake(prepared = true) {
  const calls: string[] = [];
  return { calls, rpc: async (name: string, args: any) => {
    calls.push(name);
    if (name === "resolve_prepared_website_source") return { data: prepared ? source : { prepared: false }, error: null };
    if (name === "initialize_website_interview") {
      const agenda = args.p_agenda;
      return { data: { agenda, revision: 0, storeVersion: 0, digest: onboardingAgendaDigest(agenda),
        receiptId: "55555555-5555-4555-8555-555555555555", nextAction: getAgendaAction(agenda), state: "unfinished" }, error: null };
    }
    throw new Error(`unexpected effect: ${name}`);
  } };
}
describe("fresh website voice bootstrap", () => {
  test("original selected draft seeds a fresh scoped agenda without failed-call answers or new Discovery", async () => {
    const client = fake();
    const result = await prepareWebsiteInterview({ ownerId, tenantId, callId, requestId }, client);
    expect(result).not.toBeNull();
    expect(result!.stored.agenda.binding.callId).toBe(callId);
    expect(result!.stored.agenda.binding.interviewId).toBe(callId);
    expect(result!.stored.agenda.binding.draftId).toBe(draft.draft_id);
    expect(result!.stored.agenda.ownerTurns).toEqual([]);
    expect(result!.projection.sourceItems).toHaveLength(16);
    expect(result!.projection.candidateRecap).toHaveLength(21);
    expect(result!.stored.agenda.items).toHaveLength(114);
    expect(result!.stored.nextAction.questionPt).toContain("Quais cidades exatas");
    expect(client.calls).toEqual(["resolve_prepared_website_source", "initialize_website_interview"]);
  });
  test("no preparation does not reset or silently initialize legacy context", async () => {
    const client = fake(false);
    expect(await prepareWebsiteInterview({ ownerId, tenantId, callId, requestId }, client)).toBeNull();
    expect(client.calls).toEqual(["resolve_prepared_website_source"]);
  });
  test("selected source identity drift refuses initialization", async () => {
    const client = fake();
    const rpc = client.rpc;
    client.rpc = async (name, args) => name === "resolve_prepared_website_source"
      ? { data: { ...source, draftHash: "a".repeat(64) }, error: null } : rpc(name, args);
    await expect(prepareWebsiteInterview({ ownerId, tenantId, callId, requestId }, client)).rejects.toThrow("source binding");
    expect(client.calls).toEqual([]);
  });
  test("server-resolved resumable lineage attaches rather than creating another interview", async () => {
    const original = await prepareWebsiteInterview({ ownerId, tenantId, callId, requestId }, fake());
    const priorCallId="66666666-6666-4666-8666-666666666666";
    const agenda={...original!.stored.agenda,binding:{...original!.stored.agenda.binding,interviewId:priorCallId}};
    const calls:string[]=[];
    const client={rpc:async(name:string)=>{
      calls.push(name);
      return {error:null,data:name==="resolve_prepared_website_source"
        ?{...source,resume:{interviewId:priorCallId,priorCallId}}
        :{...original!.stored,agenda,storeVersion:1,digest:onboardingAgendaDigest(agenda),nextAction:getAgendaAction(agenda)}};
    }};
    const result=await prepareWebsiteInterview({ownerId,tenantId,callId,requestId},client);
    expect(calls).toEqual(["resolve_prepared_website_source","attach_website_interview"]);
    expect(result!.stored.agenda.binding.interviewId).toBe(priorCallId);
  });
});
