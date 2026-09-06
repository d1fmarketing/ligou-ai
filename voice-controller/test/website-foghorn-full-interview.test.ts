import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fixture from './fixtures/foghorn-website-first-voice.json';
import { createWebsiteInterviewRuntime } from '../src/onboarding-website-runtime.ts';
import { buildWebsiteOpeningAction, classifyWebsiteApprovalTranscript, websiteSummaryHash } from '../src/onboarding-agenda-coordinator.ts';
import { createOnboardingAgenda, getAgendaAction, projectAgendaSummary } from '../src/onboarding-agenda.ts';
import { onboardingAgendaDigest, type StoredWebsiteInterview } from '../src/onboarding-agenda-store.ts';
import { buildCompanyDiscoveryPrefill } from '../src/company-discovery-prefill.ts';
import { buildWebsiteAgendaSeeds } from '../src/onboarding-agenda-seed.ts';
import { speechPayloadIsInternallyValid } from '../src/onboarding-speech.ts';
import { validateWebsiteSpeech } from '../../dashboard/src/voice/website-speech.js';
import { buildWebsiteCandidateContext } from '../src/onboarding-website-summary.ts';

const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const callId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222';
const receiptId='33333333-3333-4333-8333-333333333333',approvalId='44444444-4444-4444-8444-444444444444';
test('exact Foghorn full software path: finite queue, offscope, summary, correction, approval, one played signoff and durable close',async()=>{
 const canonicalDraft=JSON.stringify(fixture.draft_row);
 const {tenant_id:tenantId,...draftReadback}=fixture.draft_row;
 const prefill=buildCompanyDiscoveryPrefill({tenant_id:tenantId,call_id:callId,draft_readback:draftReadback,localities:[]});
 const projection=buildWebsiteAgendaSeeds({draftReadback,initialCoverage:prefill.coverage.snapshot as any});
 const agenda=createOnboardingAgenda({interviewId:callId,callId,draftId:draftReadback.draft_id,draftHash:draftReadback.draft_hash,
  sourceResultId:draftReadback.draft.source_result_id,sourceResultHash:draftReadback.draft.source_result_hash},projection.seeds,buildWebsiteCandidateContext(projection));
 let stored:StoredWebsiteInterview={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId,nextAction:getAgendaAction(agenda),state:'unfinished',replayed:false};
 const scope={ownerId:requestId,callId,requestId};
 const bytes=Buffer.from('ID3synthetic-software-proof-not-human-audio');
 const payload=(action:any)=>({...action,schema:'onboarding.speech.v1',text_sha256:hash(action.text),audio_base64:bytes.toString('base64'),
  audio_sha256:hash(bytes),mime:'audio/mpeg',voice:'ash',tts_model:'tts-1-hd',cost_usd:Number(([...action.text].length*30/1e6).toFixed(8))});
 const openingAction=buildWebsiteOpeningAction(stored,'D1F Marketing'),openingPayload=payload(openingAction);
 const speech=new Map<string,any>([[openingAction.actionId,{action:openingAction,payload:openingPayload,played:false}]]);
 const owners=new Map<string,string>(),summaries:any[]=[],spoken:string[]=[],phases:string[]=[],requests:any[]=[],commits:any[]=[];
 let approval:any=null,hangups=0,providerConfirmed=false,budgetSettled=false,terminal:any=null;
 const runtime=createWebsiteInterviewRuntime({prepared:{scope,stored,projection},openingAction,openingPayload:openingPayload as any},{
  agendaStore:{
   recordOwnerTranscript:async(x:any)=>{expect(owners.has(x.providerItemId)).toBe(false);owners.set(x.providerItemId,x.text);return{...x,turnId:`${callId}:${x.providerItemId}`,replayed:false};},
   commitOwnerTurn:async(x:any)=>{
    expect(x.expectedDigest).toBe(stored.digest);expect(x.expectedStoreVersion).toBe(stored.storeVersion);expect(approval).toBeNull();
    commits.push(x);stored={agenda:x.agenda,revision:x.agenda.revision,storeVersion:stored.storeVersion+1,
      digest:onboardingAgendaDigest(x.agenda),receiptId,nextAction:Object.fromEntries(Object.entries(x.nextAction).reverse()) as any,
      state:projectAgendaSummary(x.agenda).readyForSummary?'reviewing':'unfinished',replayed:false};return structuredClone(stored);
   },readWebsiteInterview:async()=>structuredClone(stored),
  } as any,
  evidenceStore:{
   claimSpeech:async({action,summaryId,clarificationTurnId}:any)=>{expect(speech.has(action.actionId)).toBe(false);expect([...speech.values()].filter(x=>!x.played)).toHaveLength(0);
    if(clarificationTurnId)expect([...speech.values()].some(x=>x.summaryId===summaryId && x.action.kind==='REQUEST_FINAL_APPROVAL' && x.played)).toBe(true);
    speech.set(action.actionId,{action,summaryId,payload:null,played:false});return{claimed:true,status:'preparing',action};},
   completeSpeech:async({actionId,payload:p}:any)=>{expect(speechPayloadIsInternallyValid(p,speech.get(actionId).action)).toBe(true);speech.get(actionId).payload=p;return{status:'ready',payload:p};},
   recordSpeechPlayed:async(x:any)=>{const s=speech.get(x.actionId);expect(s.played).toBe(false);expect(x.assistantText).toBe(s.payload.text);s.played=true;spoken.push(s.payload.text);return{receiptId};},
   prepareSummary:async(x:any)=>{expect(stored.state).toBe('reviewing');expect(x.expectedDigest).toBe(stored.digest);
    const proof={summaryId:x.summaryId,revision:stored.revision,digest:stored.digest,parts:x.parts};
    const result={...proof,summaryHash:websiteSummaryHash(proof),receiptId};summaries.push(result);return result;},
   approveSummary:async(x:any)=>{expect(classifyWebsiteApprovalTranscript(owners.get(x.providerItemId)!)).toBe('approval');expect(approval).toBeNull();
    expect([...speech.values()].at(-1).action.kind).toBe('REQUEST_FINAL_APPROVAL');expect([...speech.values()].at(-1).played).toBe(true);
    stored={...stored,state:'closing',storeVersion:stored.storeVersion+1};
    approval={approvalReceiptId:approvalId,turnId:`${callId}:${x.providerItemId}`,summaryId:x.summaryId,summaryHash:x.summaryHash,
      revision:stored.revision,digest:stored.digest,storeVersion:stored.storeVersion};return approval;},
   recordCompletion:async()=>{expect(hangups).toBe(1);expect(providerConfirmed).toBe(true);expect(budgetSettled).toBe(true);
    expect([...speech.values()].filter(x=>x.action.kind==='SPEAK_FINAL_SIGNOFF'&&x.played)).toHaveLength(1);
    terminal={receiptId,interviewId:callId,callId,outcome:'complete',approvalReceiptId:approvalId,providerConfirmed,budgetSettled,
      callStatus:'ended',budgetReservationId:requestId};return terminal;},
   failSpeech:async()=>{throw new Error('unexpected speech failure');},
  } as any,
  synthesize:async action=>payload(action) as any,send:event=>{if(event.type==='response.create')requests.push(event);},
  enqueue:async f=>f(),onTranscript:()=>{},onCost:()=>{},onUsage:()=>{},onUsageUnknown:()=>{},
  onTerminate:command=>{expect(command.outcome).toBe('complete');hangups++;},onState:state=>phases.push(state.phase),
 });
 await runtime.attach();
 let turn=0,redirected=false,corrections=0,clarified=false;
 const saturday='832bbe1e-1361-44da-860b-749a0b419b60';
 async function owner(text:string,proposal:any){
  const item_id=`owner_${++turn}`;
  await runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id});
  await runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id,transcript:text});
  if(runtime.state.pending?.kind!=='interpret')return;
  const request=requests.at(-1);expect(request.response.output_modalities).toEqual(['text']);expect(request.response.conversation).toBe('none');
  const response={id:`response_${turn}`,metadata:request.response.metadata,status:'completed',output:[{type:'function_call',status:'completed',
    name:'submit_website_interview_proposal',call_id:`proposal_${turn}`,arguments:JSON.stringify({proposal:proposal??{kind:'clarification',itemId:null},facts:[]})}]};
  await runtime.handleEvent({type:'response.created',response});await runtime.handleEvent({type:'response.done',response});
  await runtime.handleEvent({type:'response.done',response});
 }
 for(let step=0;step<1000 && runtime.state.phase!=='complete';step++){
  const state=runtime.state;
  if(state.phase==='opening'||state.phase==='speaking'){
   const action=state.phase==='opening'?openingAction:state.speech!.action,s=speech.get(action.actionId);
   await validateWebsiteSpeech(s.payload,{callId,interviewId:callId,actionId:action.actionId});
   const item={id:`lgs-${action.actionId.slice(0,28)}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:action.text}]};
   await runtime.handleEvent({type:'conversation.item.done',item});await runtime.handleEvent({type:'conversation.item.created',item});
  }else if(state.phase==='awaiting_owner'){
   const current=getAgendaAction(state.stored.agenda).itemId!;
   if(!redirected && current==='92b3f78b-12b9-4f1d-81f2-db03bc2c0732'){
    redirected=true;await owner('Ótimo, quero sim. Me manda um texto curto e direto que eu possa colocar no site e usar no script do agente.',{kind:'answer',itemId:current});
   }else{
    const item=state.stored.agenda.items.find(x=>x.id===current)!;
    const answers:Record<string,string>={
      '2a19450a-5492-480b-84cc-9f8a1687cf49':'Garantia de um ano da nossa mão de obra. Peças seguem a garantia do fabricante; mau uso e falta de manutenção ficam excluídos.',
      '3be3bb5c-25e8-460a-83dc-32c5796f023d':'Não cobramos taxa automática. Fora do horário somente com minha aprovação explícita; gás ou monóxido significa sair e ligar 911 ou para a companhia de gás.',
      '765e3066-368e-4f92-8af0-7adb701d9016':'Domingo somente emergência aprovada pelo dono. Reparo comum no mesmo dia é de segunda a sábado.',
      [saturday]:'Segunda a sexta das 7 às 19, sábado das 8 às 17, domingo fechado para atendimento comum.',
      '92b3f78b-12b9-4f1d-81f2-db03bc2c0732':'Somente Novato, San Rafael e Petaluma. Fora dessas três cidades exige minha exceção explícita.',
    };
    let text=answers[current];
    if(item.coverageRefs.includes('area.coverage'))text='A gente atende Novato, San Rafael e Petaluma. Somente essas três cidades.';
    if(item.source==='owner_private_requirement')text='O Ligou não pode decidir automaticamente: precisa da minha aprovação para este ponto.';
    await owner(text??'Este ponto ainda não está definido. Prefiro deixar para revisão posterior.',{kind:text?'answer':'defer',itemId:current});
   }
  }else if(state.phase==='awaiting_approval'){
   if(!clarified){clarified=true;await owner('Não entendi o resumo.',null);}
   else if(corrections===0){corrections++;await owner('Na verdade, no sábado abrimos das nove da manhã às cinco da tarde.',{kind:'correction',affectedItems:[{itemId:saturday,disposition:'corrected'}]});}
   else if(corrections===1){corrections++;const phone=state.stored.agenda.candidateContext.find(c=>c.subject==='public_phone')!;
     expect(phone).toBeDefined();await owner('Nosso telefone correto é 415 555 0199.',{kind:'correction',affectedCandidates:[{candidateId:phone.id,disposition:'corrected'}]});}
   else await owner('Sim. Está tudo correto. Confirmo.',null);
  }else if(state.phase==='terminating'){
   providerConfirmed=true;budgetSettled=true;await runtime.finalized({providerReceiptId:receiptId,budgetReceiptId:requestId});
  }else throw new Error(`Unexpected stable phase ${state.phase}:${state.error}`);
 }
 expect(runtime.state.phase).toBe('complete');expect(hangups).toBe(1);expect(summaries).toHaveLength(3);
 expect(runtime.state.stored.agenda.items).toHaveLength(114);expect(projectAgendaSummary(runtime.state.stored.agenda).unresolved).toHaveLength(0);
 expect(projection.sourceItems).toHaveLength(16);expect(projection.candidateRecap).toHaveLength(21);
 expect(spoken.some(text=>text.startsWith('Podemos tratar disso depois;'))).toBe(true);
 expect(spoken.join('\n')).not.toMatch(/Se quiser, posso|Tem mais alguma coisa|É só me chamar/);
 expect(summaries[2].parts.join('')).toContain('das nove da manhã às cinco da tarde');
 expect(summaries[2].parts.join('')).toContain('415 555 0199');expect(runtime.state.stored.agenda.candidateOverrides).toHaveLength(1);
 expect(terminal?.outcome).toBe('complete');
 expect(JSON.stringify(fixture.draft_row)).toBe(canonicalDraft);expect(commits.length).toBeGreaterThan(100);
 runtime.stop();
},15000);
