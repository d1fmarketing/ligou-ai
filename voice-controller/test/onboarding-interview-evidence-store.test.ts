import { expect, test } from "bun:test";
import {createInterviewEvidenceStore} from '../src/onboarding-interview-evidence-store.ts';
const streamScope={ownerId:'22222222-2222-4222-8222-222222222222',callId:'11111111-1111-4111-8111-111111111111',requestId:'33333333-3333-4333-8333-333333333333'};
const stream={schema:'onboarding.stream.v1' as const,action:{actionId:'a'.repeat(64),interviewId:streamScope.callId,callId:streamScope.callId,revision:0,kind:'ASK_NEXT_GAP' as const,text:'Quais cidades atende?',sourceDigest:'b'.repeat(64)},dispatchId:'44444444-4444-4444-8444-444444444444',receiptId:'55555555-5555-4555-8555-555555555555'};
test('stream claim and one-time authorization pass exact owner/action/dispatch scope without media fields',async()=>{
 const requests:any[]=[];const store=createInterviewEvidenceStore({rpc:async(name,args)=>{requests.push({name,args});return{data:stream,error:null};}});
 expect(await store.claimStream({...streamScope,action:stream.action})).toEqual(stream);
 expect(await store.authorizeStream({...streamScope,stream})).toEqual(stream);
 expect(requests[0].args).toEqual({p_owner:streamScope.ownerId,p_call:streamScope.callId,p_request:streamScope.requestId,p_action:stream.action,p_summary:null,p_part:null,p_clarification_turn:null});
 expect(requests[1].args).toEqual({p_owner:streamScope.ownerId,p_call:streamScope.callId,p_request:streamScope.requestId,p_action:stream.action.actionId,p_dispatch:stream.dispatchId});
 const bad=createInterviewEvidenceStore({rpc:async()=>({data:{...stream,dispatchId:streamScope.callId},error:null})});
 await expect(bad.authorizeStream({...streamScope,stream})).rejects.toThrow('stream_authorization_changed');
});
test('joined stream proof requires separate generation, playout and final receipts with exact response identity',async()=>{
 const input={...streamScope,stream,responseId:'response',itemId:'item',transcript:stream.action.text,status:'completed' as const};
 const proof={actionId:stream.action.actionId,dispatchId:stream.dispatchId,responseId:input.responseId,itemId:input.itemId,status:'played',
  generationReceiptId:'66666666-6666-4666-8666-666666666666',playoutReceiptId:'77777777-7777-4777-8777-777777777777',receiptId:'88888888-8888-4888-8888-888888888888'};
 for(const patch of [{},{itemId:'foreign'},{dispatchId:streamScope.callId},{generationReceiptId:undefined},{playoutReceiptId:proof.generationReceiptId},{receiptId:proof.playoutReceiptId}]){
  const store=createInterviewEvidenceStore({rpc:async()=>({data:{...proof,...patch},error:null})});
  if(Object.keys(patch).length)await expect(store.recordStreamResponse(input)).rejects.toThrow();
  else expect(await store.recordStreamResponse(input)).toEqual(proof);
 }
});
test('invalid stream media evidence is rejected before the playout RPC',async()=>{
 let rpcs=0;const store=createInterviewEvidenceStore({rpc:async()=>{rpcs++;return{data:null,error:null};}});
 await expect(store.recordStreamPlayout({...streamScope,stream,responseId:'response',itemId:'item',bufferStoppedEventId:'event',mediaEvidence:{schema:'onboarding.stream.media.v1',nonzeroSamples:0,observedMs:1,firstSampleAtMs:0,lastSampleAtMs:1,unmuted:true,playbackStarted:true}})).rejects.toThrow('stream_media_evidence_invalid');
 expect(rpcs).toBe(0);
});
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
