import { expect, test } from "bun:test";
test("ambiguous existing preparation never grants another TTS attempt", async () => {
  const { createInterviewEvidenceStore } = await import("../src/onboarding-interview-evidence-store.ts");
  const action = {actionId:'a'.repeat(64),interviewId:'11111111-1111-4111-8111-111111111111',callId:'11111111-1111-4111-8111-111111111111',revision:0,kind:'ASK_NEXT_GAP' as const,text:'Onde atende?',sourceDigest:'b'.repeat(64)};
  const store = createInterviewEvidenceStore({rpc:async()=>({data:{status:'preparing',claimed:false,action,noticeId:`lsn-${'a'.repeat(28)}`},error:null})});
  const claim = await store.claimSpeech({ownerId:'22222222-2222-4222-8222-222222222222',callId:action.callId,requestId:'33333333-3333-4333-8333-333333333333',action});
  expect(claim.claimed).toBe(false);
  expect(claim.payload).toBeUndefined();
  expect(claim.status).toBe('preparing');
});
test("rejects invalid speech before provider payload can be persisted", async () => {
  const { createInterviewEvidenceStore } = await import("../src/onboarding-interview-evidence-store.ts");
  const store = createInterviewEvidenceStore({ rpc: async () => { throw new Error("unexpected RPC"); } });
  await expect(store.completeSpeech({ ownerId: "x", callId: "x", requestId: "x", actionId: "x", payload: {} as any })).rejects.toThrow("speech");
});
