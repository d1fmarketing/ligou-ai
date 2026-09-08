import { expect, test } from "bun:test";
import { createOnboardingAgenda, getAgendaAction, applyVerifiedOwnerTurn } from "../src/onboarding-agenda.ts";
import { createOnboardingAgendaStore, onboardingAgendaDigest } from "../src/onboarding-agenda-store.ts";
import { createClient } from "@supabase/supabase-js";

const binding = { interviewId: "11111111-1111-4111-8111-111111111111", callId: "11111111-1111-4111-8111-111111111111", draftId: "22222222-2222-4222-8222-222222222222", draftHash: "a".repeat(64), sourceResultId: "33333333-3333-4333-8333-333333333333", sourceResultHash: "b".repeat(64) };
const agenda = createOnboardingAgenda(binding, [{ id: "gap", subject: "territory", questionPt: "Onde atende?", source: "ambiguity", coverageRefs: ["area"], relatedItemIds: [], blocking: true }]);
const scope = { ownerId: "44444444-4444-4444-8444-444444444444", callId: binding.callId, requestId: "55555555-5555-4555-8555-555555555555" };
test("reads exact queue and stable action proof from canonical store result", async () => {
  const { createOnboardingAgendaStore, onboardingAgendaDigest } = await import("../src/onboarding-agenda-store.ts");
  const store = createOnboardingAgendaStore({ rpc: async () => ({ data: { agenda, revision: 0, storeVersion: 0, digest: onboardingAgendaDigest(agenda), receiptId: scope.requestId, nextAction: getAgendaAction(agenda), state: "unfinished", replayed: false }, error: null }) });
  const read = await store.readWebsiteInterview(scope);
  expect(read.nextAction.itemId).toBe("gap");
  expect(read.nextAction.spokenPt).toBe("Onde atende?");
  expect(read.revision).toBe(0);
  expect(Object.isFrozen(read.agenda)).toBe(true);
});
test("readback rejects corrupt agenda instead of projecting complete", async () => {
  const { createOnboardingAgendaStore } = await import("../src/onboarding-agenda-store.ts");
  const store = createOnboardingAgendaStore({ rpc: async () => ({ data: { agenda: { ...agenda, revision: 1 }, digest: "a".repeat(64), receiptId: scope.requestId, nextAction: getAgendaAction(agenda) }, error: null }) });
  await expect(store.readWebsiteInterview(scope)).rejects.toThrow();
});
test("readback rejects switched call and wrong digest", async () => {
  const { createOnboardingAgendaStore } = await import("../src/onboarding-agenda-store.ts");
  const store = createOnboardingAgendaStore({ rpc: async () => ({ data: { agenda, digest: "0".repeat(64), receiptId: scope.requestId, nextAction: getAgendaAction(agenda) }, error: null }) });
  await expect(store.readWebsiteInterview({ ...scope, callId: scope.requestId })).rejects.toThrow();
  await expect(store.readWebsiteInterview(scope)).rejects.toThrow();
});
test("trusted transcript rejects blank/oversized evidence before RPC", async () => {
  const { createOnboardingAgendaStore } = await import("../src/onboarding-agenda-store.ts");
  const store = createOnboardingAgendaStore({ rpc: async () => { throw new Error("must not reach RPC"); } });
  await expect(store.recordOwnerTranscript({ ...scope, providerItemId: "turn1", text: " " })).rejects.toThrow("transcript");
  await expect(store.recordOwnerTranscript({ ...scope, providerItemId: "turn1", text: "x".repeat(32769) })).rejects.toThrow("transcript");
});

test('actual Supabase gateway response retains HTTP status for bounded recovery',async()=>{
 const {createOnboardingAgendaStore}=await import('../src/onboarding-agenda-store.ts');
 const client=createClient('https://fixture.supabase.co','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},
  global:{fetch:async()=>new Response('Service Unavailable',{status:503,headers:{'Content-Type':'text/plain'}})}});
 await expect(createOnboardingAgendaStore(client).readWebsiteInterview(scope)).rejects.toMatchObject({status:503});
});

const interpretation='Atendimento restrito às cidades informadas; fora delas exige aprovação explícita do dono.';
const proposal={kind:'answer' as const,itemId:'gap'};
const nativeTransition=()=>applyVerifiedOwnerTurn(agenda,{type:'verified_owner_turn',binding,turnId:`${scope.callId}:native-owner-item`,text:interpretation,provenance:'model_interpretation',proposal});
const nativeReadback=()=>{const t=nativeTransition();return {agenda:t.agenda,revision:1,storeVersion:1,digest:onboardingAgendaDigest(t.agenda),receiptId:scope.requestId,nextAction:t.action,state:'reviewing',replayed:false,operationReceiptId:scope.requestId,operationRevision:1};};
const nativeInput=()=>({...scope,expectedRevision:0,expectedStoreVersion:0,expectedDigest:onboardingAgendaDigest(agenda),providerItemId:'native-owner-item',proposal,interpretation,agenda:nativeTransition().agenda,facts:[]});
test('native content commits with interpreted provenance and no fabricated transcript RPC',async()=>{
 const calls:any[]=[];const store=createOnboardingAgendaStore({rpc:async(name,args)=>{calls.push({name,args});return{data:nativeReadback(),error:null};}});
 const got=await store.commitNativeOwnerTurn(nativeInput());
 expect(got.agenda.ownerTurns[0]).toEqual({turnId:`${scope.callId}:native-owner-item`,text:interpretation,provenance:'model_interpretation'});
 expect(got.operationReceiptId).toBe(scope.requestId);
 expect(calls).toEqual([{name:'commit_website_interview_native_turn',args:{p_owner:scope.ownerId,p_call:scope.callId,p_request:scope.requestId,
  p_revision:0,p_store_version:0,p_digest:onboardingAgendaDigest(agenda),p_item:'native-owner-item',p_interpretation:interpretation,p_proposal:proposal,
  p_agenda:nativeInput().agenda,p_facts:[]}}]);
});
test('native lost-result replay returns original operation proof alongside current state',async()=>{
 const calls:any[]=[];const proof={...nativeReadback(),storeVersion:3,receiptId:scope.ownerId,replayed:true};
 const store=createOnboardingAgendaStore({rpc:async(name,args)=>{calls.push({name,args});return{data:proof,error:null};}});
 const got=await store.replayNativeOwnerTurn({...scope,providerItemId:'native-owner-item',proposal,interpretation,facts:[]});
 expect(got?.operationReceiptId).toBe(scope.requestId);expect(got?.receiptId).toBe(scope.ownerId);expect(got?.operationRevision).toBe(1);
 expect(calls).toEqual([{name:'replay_website_interview_native_turn',args:{p_owner:scope.ownerId,p_call:scope.callId,p_request:scope.requestId,p_item:'native-owner-item',p_proposal:proposal,p_interpretation:interpretation,p_facts:[]}}]);
});
test('native replay distinguishes a genuine miss from denied, cancelled or malformed read',async()=>{
 const input={...scope,providerItemId:'native-owner-item',proposal,interpretation};
 expect(await createOnboardingAgendaStore({rpc:async()=>({data:null,error:null})}).replayNativeOwnerTurn(input)).toBeNull();
 await expect(createOnboardingAgendaStore({rpc:async()=>({data:null,error:{message:'denied',code:'42501'},status:403})}).replayNativeOwnerTurn(input)).rejects.toMatchObject({code:'42501',status:403});
 for(const patch of [{operationReceiptId:'bad'},{operationRevision:0},{operationRevision:2},{agenda:{...nativeReadback().agenda,ownerTurns:[{turnId:`${scope.callId}:native-owner-item`,text:'altered',provenance:'model_interpretation'}]}}])
  await expect(createOnboardingAgendaStore({rpc:async()=>({data:{...nativeReadback(),...patch},error:null})}).replayNativeOwnerTurn(input)).rejects.toThrow();
 const abort=new AbortController();abort.abort();let calls=0;
 await expect(createOnboardingAgendaStore({rpc:async()=>{calls++;return{data:null,error:null};}}).replayNativeOwnerTurn({...input,signal:abort.signal})).rejects.toThrow();expect(calls).toBe(0);
});
test('empty interpretations and literal-labelled native evidence fail before a write',async()=>{
 let calls=0;const store=createOnboardingAgendaStore({rpc:async()=>{calls++;return{data:nativeReadback(),error:null};}});
 for(const text of ['','  ','x'.repeat(32769)])await expect(store.commitNativeOwnerTurn({...nativeInput(),interpretation:text})).rejects.toThrow();
 const t=applyVerifiedOwnerTurn(agenda,{type:'verified_owner_turn',binding,turnId:`${scope.callId}:native-owner-item`,text:interpretation,proposal});
 await expect(store.commitNativeOwnerTurn({...nativeInput(),agenda:t.agenda})).rejects.toThrow();expect(calls).toBe(0);
});

const recordedText='No domingo, só emergência. De segunda a sábado, das oito às dezoito.';
function recoveryFixture(){
 const initial=createOnboardingAgenda(binding,[
  {id:'hours',subject:'business_hours',questionPt:'Qual é a regra correta para domingo?',source:'contradiction',coverageRefs:['business_hours'],relatedItemIds:[],blocking:true},
  {id:'price',subject:'pricing',questionPt:'Qual é o preço?',source:'missing_website_information',coverageRefs:['pricing'],relatedItemIds:[],blocking:true}]);
 const prior=applyVerifiedOwnerTurn(initial,{type:'verified_owner_turn',binding,turnId:`${scope.callId}:wrong-confirmation`,text:'Deixa eu confirmar.',proposal:{kind:'answer',itemId:'hours'}}).agenda;
 const correction=applyVerifiedOwnerTurn(prior,{type:'verified_owner_turn',binding,turnId:`${scope.callId}:recorded-hours`,text:recordedText,
  proposal:{kind:'correction',affectedItems:[{itemId:'hours',disposition:'corrected'}]}});
 const input={...scope,providerItemId:'recorded-hours',expectedRevision:1,expectedStoreVersion:1,expectedDigest:onboardingAgendaDigest(prior),agenda:correction.agenda};
 return{prior,input,proof:{agenda:correction.agenda,revision:2,storeVersion:2,digest:onboardingAgendaDigest(correction.agenda),receiptId:scope.requestId,
  nextAction:correction.action,state:'unfinished',replayed:false,operationReceiptId:scope.requestId,operationRevision:2}};
}
test('recorded recovery sends only exact revision and agenda inputs, never a new transcript or facts',async()=>{
 const {input,proof}=recoveryFixture(),calls:any[]=[];
 const store=createOnboardingAgendaStore({rpc:async(name,args)=>{calls.push({name,args});return{data:proof,error:null};}});
 const got=await store.recoverRecordedOwnerTurn(input);
 expect(got.agenda.ownerTurns.at(-1)).toEqual({turnId:`${scope.callId}:recorded-hours`,text:recordedText});
 expect(got.operationReceiptId).toBe(scope.requestId);expect(got.operationRevision).toBe(2);
 expect(calls).toEqual([{name:'recover_website_interview_recorded_turn',args:{p_owner:scope.ownerId,p_call:scope.callId,p_request:scope.requestId,
  p_revision:1,p_store_version:1,p_digest:input.expectedDigest,p_item:'recorded-hours',p_agenda:input.agenda}}]);
});
test('recorded recovery rejects local item, revision and interpreted-provenance substitutions before RPC',async()=>{
 const {input,prior}=recoveryFixture();let calls=0;const store=createOnboardingAgendaStore({rpc:async()=>{calls++;throw new Error('must not reach RPC');}});
 const interpreted=applyVerifiedOwnerTurn(prior,{type:'verified_owner_turn',binding,turnId:`${scope.callId}:recorded-hours`,text:recordedText,provenance:'model_interpretation',
  proposal:{kind:'correction',affectedItems:[{itemId:'hours',disposition:'corrected'}]}}).agenda;
 for(const changed of [{providerItemId:'another-item'},{expectedRevision:0},{expectedStoreVersion:-1},{expectedDigest:'bad'},{agenda:interpreted}])
  await expect(store.recoverRecordedOwnerTurn({...input,...changed})).rejects.toThrow('Recorded recovery');
 expect(calls).toBe(0);
});
test('recorded recovery requires its durable operation receipt on replay and preserves cancellation and denial',async()=>{
 const {input,proof}=recoveryFixture();
 const replay={...proof,replayed:true,receiptId:scope.ownerId,storeVersion:3};
 const got=await createOnboardingAgendaStore({rpc:async()=>({data:replay,error:null})}).recoverRecordedOwnerTurn(input);
 expect(got.replayed).toBe(true);expect(got.operationReceiptId).toBe(scope.requestId);expect(got.receiptId).toBe(scope.ownerId);
 for(const changed of [{operationReceiptId:null},{operationReceiptId:'bad'},{operationRevision:1},{operationRevision:3}])
  await expect(createOnboardingAgendaStore({rpc:async()=>({data:{...proof,...changed},error:null})}).recoverRecordedOwnerTurn(input)).rejects.toThrow('Recorded recovery');
 await expect(createOnboardingAgendaStore({rpc:async()=>({data:null,error:{message:'denied',code:'42501'},status:403})}).recoverRecordedOwnerTurn(input)).rejects.toMatchObject({code:'42501',status:403});
 const abort=new AbortController();abort.abort();let calls=0;
 await expect(createOnboardingAgendaStore({rpc:async()=>{calls++;return{data:proof,error:null};}}).recoverRecordedOwnerTurn({...input,signal:abort.signal})).rejects.toThrow();
 expect(calls).toBe(0);
});
