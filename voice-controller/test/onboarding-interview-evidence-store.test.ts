import { expect, test } from "bun:test";
test("empty input receipt binds the exact interrupted action and item without owner words", async () => {
  const {createInterviewEvidenceStore}=await import('../src/onboarding-interview-evidence-store.ts');
  const input={ownerId:'22222222-2222-4222-8222-222222222222',callId:'11111111-1111-4111-8111-111111111111',requestId:'33333333-3333-4333-8333-333333333333',actionId:'a'.repeat(64),providerItemId:'empty-owner-input'};
  const proof={receiptId:'44444444-4444-4444-8444-444444444444',callId:input.callId,actionId:input.actionId,providerItemId:input.providerItemId,replayed:false};
  let invocation;
  const store=createInterviewEvidenceStore({rpc:async(name,args)=>{invocation={name,args};return {data:proof,error:null};}});
  expect(await (store as any).recordEmptyInput(input)).toEqual(proof);
  expect(invocation).toEqual({name:'record_website_interview_empty_input',args:{p_owner:input.ownerId,p_call:input.callId,p_request:input.requestId,p_action:input.actionId,p_item:input.providerItemId}});
  proof.providerItemId='foreign';await expect((store as any).recordEmptyInput(input)).rejects.toThrow('empty input proof');
});
test("interruption binds the owner provider item and validates the durable superseded proof", async () => {
  const { createInterviewEvidenceStore } = await import("../src/onboarding-interview-evidence-store.ts");
  const input={ownerId:'22222222-2222-4222-8222-222222222222',callId:'11111111-1111-4111-8111-111111111111',requestId:'33333333-3333-4333-8333-333333333333',actionId:'a'.repeat(64),providerItemId:'owner-barge-in'};
  let invocation: unknown;
  const proof={callId:input.callId,actionId:input.actionId,providerItemId:input.providerItemId,status:'superseded',receiptId:'44444444-4444-4444-8444-444444444444',replayed:false};
  const store=createInterviewEvidenceStore({rpc:async(name,args)=>{invocation={name,args};return {data:proof,error:null};}});
  expect(await (store as any).interruptSpeech(input)).toEqual(proof);
  expect(invocation).toEqual({name:'interrupt_website_interview_speech',args:{p_owner:input.ownerId,p_call:input.callId,p_request:input.requestId,p_action:input.actionId,p_item:input.providerItemId}});
  const wrong=createInterviewEvidenceStore({rpc:async()=>({data:{...proof,providerItemId:'another-turn'},error:null})});
  await expect((wrong as any).interruptSpeech(input)).rejects.toThrow('interruption proof');
});
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
test("resumed preparation preserves single synthesis ownership and rejects another owner item", async () => {
  const {createInterviewEvidenceStore}=await import('../src/onboarding-interview-evidence-store.ts');
  const input={ownerId:'22222222-2222-4222-8222-222222222222',callId:'11111111-1111-4111-8111-111111111111',requestId:'33333333-3333-4333-8333-333333333333',actionId:'a'.repeat(64),providerItemId:'owner-barge-in'};
  const proof={status:'preparing',claimed:true,action:{actionId:'c'.repeat(64),interviewId:input.callId,callId:input.callId,revision:0,kind:'ASK_NEXT_GAP',text:'Onde atende?',sourceDigest:'b'.repeat(64)},noticeId:'lsn-'+ 'c'.repeat(28),resumedFromActionId:input.actionId,providerItemId:input.providerItemId,rendition:1,interruptionReceiptId:'44444444-4444-4444-8444-444444444444'};
  const store=createInterviewEvidenceStore({rpc:async()=>({data:proof,error:null})});
  expect((await store.resumeSpeech(input)).claimed).toBe(true);
  proof.claimed=false;expect((await store.resumeSpeech(input)).claimed).toBe(false);
  proof.providerItemId='foreign';await expect(store.resumeSpeech(input)).rejects.toThrow('resumed speech proof');
});
test("amendment receipt must correlate the exact approval, owner item and requested targets", async () => {
  const {createInterviewEvidenceStore}=await import('../src/onboarding-interview-evidence-store.ts');
  const input={ownerId:'22222222-2222-4222-8222-222222222222',callId:'11111111-1111-4111-8111-111111111111',requestId:'33333333-3333-4333-8333-333333333333',approvalReceiptId:'44444444-4444-4444-8444-444444444444',providerItemId:'late-correction',proposal:{kind:'correction' as const,affectedItems:[{itemId:'territory',disposition:'reopen' as const}]}};
  const proof={...input,receiptId:'55555555-5555-4555-8555-555555555555',interviewId:input.callId,state:'pending_amendment'};
  const store=createInterviewEvidenceStore({rpc:async()=>({data:proof,error:null})});
  expect((await store.requestAmendment(input)).receiptId).toBe(proof.receiptId);
  proof.approvalReceiptId='foreign';await expect(store.requestAmendment(input)).rejects.toThrow('amendment proof');
});
