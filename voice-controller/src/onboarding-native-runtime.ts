import {createHash,randomUUID} from 'node:crypto';
import {applyVerifiedOwnerTurn,getAgendaAction,getAgendaItems,type OnboardingAgenda} from './onboarding-agenda.ts';
import {onboardingAgendaDigest,type StoredWebsiteInterview,type InterviewScope} from './onboarding-agenda-store.ts';
import type {PreparedWebsiteInterview} from './onboarding-website-bootstrap.ts';
import {classifyWebsiteApprovalTranscript} from './onboarding-agenda-coordinator.ts';
import type {WebsiteInterviewRuntimeDependencies} from './onboarding-website-runtime.ts';
import {validateWebsiteTypedFacts} from './onboarding-website-facts.ts';
import {coverageKey,type CoverageField} from './onboarding-coverage.ts';
import {streamMediaEvidenceIsValid,type StreamMediaEvidence} from './onboarding-stream.ts';
import type {NativeCheckpointProof} from './onboarding-interview-evidence-store.ts';
import {buildNativeOnboardingContext,buildNativeOnboardingSession,parseNativeOnboardingProposal,type NativeOnboardingProposal,
  NATIVE_ONBOARDING_PROPOSAL_TOOL,NATIVE_ONBOARDING_APPROVAL_TOOL} from './onboarding-native-session.ts';

export interface NativeWebsiteRuntimeConfig {native:true;prepared:PreparedWebsiteInterview;businessName:string}
export type NativeWebsiteRuntimeDependencies=Omit<WebsiteInterviewRuntimeDependencies,'onState'|'synthesize'|'onCost'> & {
  onState(state:{phase:string}):void;
  budgetStatus?():{costUsd:number;softLimitUsd:number;hardLimitUsd:number};
};
type CheckpointKind='review'|'signoff';
type Turn={snapshot:StoredWebsiteInterview;order:number;committed?:boolean;reviewCheckpointId?:string;transcript?:string;recorded?:boolean;
  recording?:Promise<void>;transcriptConflict?:boolean;responded?:boolean;processed?:boolean};
type ResponseContext={ownerItemId?:string;snapshot:StoredWebsiteInterview;cancelled?:boolean;done?:boolean;checkpoint?:Checkpoint;budgetPause?:boolean};
type ToolCall={id:string;name:string;arguments:string;responseId:string;context:ResponseContext;timer?:ReturnType<typeof setTimeout>};
type Checkpoint={id:string;kind:CheckpointKind;snapshot:StoredWebsiteInterview;approvalReceiptId?:string;responseId?:string;itemId?:string;
  transcript?:string;transcriptDone?:{itemId:string;text:string};generationDone?:boolean;bufferStoppedEventId?:string;
  media?:{itemId:string;evidence:StreamMediaEvidence};playedOrder?:number;retired?:boolean;faulted?:boolean;clearedResponseId?:string;recording?:boolean;proof?:NativeCheckpointProof;
  timer?:ReturnType<typeof setTimeout>;playoutTimer?:ReturnType<typeof setTimeout>};
type Approval={receiptId:string;ownerItemId:string;ownerOrder:number;summaryId:string;summaryHash:string;digest:string};
const ID=/^[A-Za-z0-9_-]{1,160}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authFailure=(e:any)=>[401,403].includes(e?.status)||['42501','PGRST301','PGRST302','PGRST303'].includes(e?.code);
const transient=(e:any)=>!authFailure(e)&&(e instanceof TypeError||e?.name==='TimeoutError'||[0,408,429,500,502,503,504].includes(e?.status));
const object=(value:unknown):value is Record<string,any>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,any>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

function nativeContent(parsed:NativeOnboardingProposal,agenda:OnboardingAgenda){
  let proposal=parsed.proposal;
  const interpreted=parsed.interpretation??[...new Set((parsed.facts??[]).map(fact=>fact.rule_text))].join('\n');
  const resolved=proposal.kind==='answer'?[proposal.itemId,...proposal.relatedItemIds??[]]:proposal.kind==='not_applicable'?[proposal.itemId]
    :proposal.kind==='correction'?[...proposal.affectedItems?.filter(x=>x.disposition==='corrected').map(x=>x.itemId)??[],
      ...proposal.affectedCandidates?.filter(x=>x.disposition==='corrected').map(x=>x.candidateId)??[]]:[];
  if(!interpreted.trim()&&resolved.length)throw Error('proposal_content_missing');
  // Pending dispositions carry the actual model proposal, never a fabricated
  // quotation. Resolving a target always requires interpreted business content.
  const interpretation=interpreted||JSON.stringify(proposal);
  if(interpretation.length>32768)throw Error('proposal_content_invalid');
  const validated=validateWebsiteTypedFacts({agenda,currentItemId:getAgendaAction(agenda).itemId??null,
    ownerTranscript:interpretation,proposal,facts:parsed.facts??[]});
  const omittedRelatedItemIds:string[]=[];
  if(parsed.interpretation===undefined&&resolved.length){
    const refs=new Set(validated.map(fact=>coverageKey(fact.field as CoverageField,fact.subject)));
    const items=getAgendaItems(agenda);
    const covered=(id:string)=>items.find(item=>item.id===id)?.coverageRefs.some(ref=>refs.has(ref));
    if(proposal.kind==='answer'){
      if(!covered(proposal.itemId))throw Error('proposal_content_missing');
      const related=proposal.relatedItemIds?.filter(id=>{if(covered(id))return true;omittedRelatedItemIds.push(id);return false;});
      proposal={...proposal,...(related?{relatedItemIds:related}:{})};
    }else if(resolved.some(id=>!covered(id)))throw Error('proposal_content_missing');
  }
  // The legacy typed validator supplies owner_words for literal-ASR callers.
  // Native interpretation must never be persisted under that literal label.
  const facts=validated.map(({owner_words:_,...fact})=>fact);
  return{proposal,interpretation,facts,omittedRelatedItemIds};
}

export function nativeWebsiteBinding(input:NativeWebsiteRuntimeConfig){
  const {scope,stored}=input.prepared;
  if(!input.native||![scope.ownerId,scope.callId,scope.requestId,stored.agenda.binding.interviewId].every(id=>UUID.test(id))
    ||scope.callId!==stored.agenda.binding.callId||stored.digest!==onboardingAgendaDigest(stored.agenda)
    ||stored.revision!==stored.agenda.revision||!input.businessName?.trim())throw Error('native_website_scope_invalid');
  return{callId:scope.callId,interviewId:stored.agenda.binding.interviewId,revision:stored.revision,sourceDigest:stored.digest};
}

/** Native audio owns every spoken word. Durable state owns every effect. */
export function createNativeWebsiteInterviewRuntime(input:NativeWebsiteRuntimeConfig,deps:NativeWebsiteRuntimeDependencies){
  nativeWebsiteBinding(input);
  const scope=input.prepared.scope,abort=new AbortController(),now=deps.now??(()=>performance.now()),startedAt=now();
  let stored=input.prepared.stored,phase='opening',stopped=false,browserReady=false,opened=false,order=0;
  let latestOwner:string|undefined,activeOwner:string|undefined,responsePending=false,pendingRequestId:string|undefined,activeAudio:string|undefined,nativeInstructions='';
  let currentReview:Checkpoint|undefined,currentSignoff:Checkpoint|undefined,approval:Approval|undefined,amendmentReceiptId:string|undefined;
  let termination:Extract<Parameters<typeof deps.onTerminate>[0],{type:'terminate_session'}>|undefined;
  let finalization:Promise<void>|undefined;
  let budgetPause:{responseId?:string;generationDone?:boolean;bufferStopped?:boolean;interrupted?:boolean;timer?:ReturnType<typeof setTimeout>}|undefined;
  const turns=new Map<string,Turn>(),responses=new Map<string,ResponseContext>(),issued=new Map<string,ResponseContext>(),checkpoints=new Map<string,Checkpoint>();
  const activeResponses=new Set<string>(),usageResponses=new Set<string>(),handledResponses=new Set<string>(),completedTools=new Set<string>(),controlEvents=new Set<string>();
  const pendingTools=new Map<string,ToolCall>();
  const checkpointRetries=new Set<string>(),checkpointFaults:Checkpoint[]=[];
  let continuation:{ownerItemId?:string;instructions?:string;checkpoint?:CheckpointKind;opening?:boolean}|undefined;
  const diagnostic=(stage:string,detail:Record<string,any>={})=>{try{deps.onDiagnostic?.({callId:scope.callId,requestId:scope.requestId,stage,elapsedMs:now()-startedAt,...detail});}catch{}};
  function publish(next:string){phase=next;deps.onState({phase});}
  function currentSnapshot(value:StoredWebsiteInterview){
    if(JSON.stringify(value.agenda.binding)!==JSON.stringify(input.prepared.stored.agenda.binding)
      ||value.digest!==onboardingAgendaDigest(value.agenda)||value.revision!==value.agenda.revision)throw Error('native_snapshot_readback_mismatch');
    buildNativeOnboardingContext(value,input.businessName);return value;
  }
  function contextNotice(){
    const action=getAgendaAction(stored.agenda);
    const context={callId:scope.callId,interviewId:stored.agenda.binding.interviewId,revision:stored.revision,sourceDigest:stored.digest,
      mode:'conversation',currentQuestion:action.itemId?{itemId:action.itemId,questionPt:action.questionPt}:null};
    deps.send({type:'conversation.item.create',item:{id:`lnc-${randomUUID().replaceAll('-','').slice(0,28)}`,type:'message',role:'system',status:'completed',
      content:[{type:'input_text',text:`ligou.website_native:${JSON.stringify(context)}`}]}});
  }
  function configure(){
    if(stopped||termination)return;contextNotice();
    const session=buildNativeOnboardingSession({stored,businessName:input.businessName,model:deps.model??''});
    nativeInstructions=session.instructions;deps.send({type:'session.update',session});
    diagnostic('native.session_requested',{revision:stored.revision,promptSha256:createHash('sha256').update(nativeInstructions).digest('hex')});
  }
  function toolContext(){
    // The current session already carries this catalog and evidence. Repeating
    // them in every function result grows the conversation on every turn.
    const {correction_catalog,interview_evidence,review,...progress}=buildNativeOnboardingContext(stored,input.businessName);
    return progress;
  }
  function softBudgetReached(){const budget=deps.budgetStatus?.();return Boolean(budget&&budget.costUsd>=budget.softLimitUsd);}
  function retire(checkpoint:Checkpoint,clear=true){
    checkpoint.retired=true;clearTimeout(checkpoint.timer);clearTimeout(checkpoint.playoutTimer);
    if(currentReview===checkpoint)currentReview=undefined;if(currentSignoff===checkpoint)currentSignoff=undefined;
    if(clear&&checkpoint.responseId&&checkpoint.clearedResponseId!==checkpoint.responseId){
      checkpoint.clearedResponseId=checkpoint.responseId;
      if(!responses.get(checkpoint.responseId)?.done){
        const id=`native-cancel-${checkpoint.id}`;controlEvents.add(id);
        deps.send({type:'response.cancel',event_id:id,response_id:checkpoint.responseId});
      }
      deps.send({type:'output_audio_buffer.clear',event_id:`native-clear-${checkpoint.id}`});
    }
  }
  function invalidateCheckpoints(){for(const checkpoint of checkpoints.values())retire(checkpoint);}
  function checkpointFault(checkpoint:Checkpoint){
    retire(checkpoint);if(!checkpoint.faulted){checkpoint.faulted=true;checkpointFaults.push(checkpoint);}
  }
  function retryCheckpoint(checkpoint:Checkpoint){
    retire(checkpoint);if(stopped||termination||checkpoint.snapshot.digest!==stored.digest)return;
    const key=JSON.stringify([checkpoint.kind,checkpoint.snapshot.digest,checkpoint.approvalReceiptId]);
    if(checkpointRetries.has(key)){finish('native_checkpoint_unconfirmed');return;}
    checkpointRetries.add(key);requestCheckpoint(checkpoint.kind);
  }
  function requestConversation(ownerItemId?:string,instructions?:string,checkpoint?:CheckpointKind,opening=false){
    if(stopped||termination)return;continuation={ownerItemId,instructions,checkpoint,opening};flushContinuation();
  }
  function requestCheckpoint(kind:CheckpointKind){
    if(kind==='signoff'&&!approval)return;
    const previous=kind==='review'?currentReview:currentSignoff;
    if(previous&&!previous.retired)return;
    if(continuation?.checkpoint===kind)return;
    requestConversation(undefined,kind==='review'
      ?'Apresente agora em voz um resumo curto das decisões efetivas, condições e pendências do contexto, agrupando políticas iguais. Peça a confirmação do dono ao final. Use suas próprias palavras; não releia o histórico.'
      :amendmentReceiptId?'A solicitação de alteração foi registrada para revisão posterior; a aprovação anterior permanece preservada. Explique isso brevemente e encerre a conversa com uma despedida natural.'
        :'A aprovação do resumo foi confirmada pelo servidor. Despeça-se brevemente de forma natural para encerrar a conversa.',kind);
  }
  function flushContinuation(){
    if(!continuation||!browserReady||responsePending||activeResponses.size||pendingTools.size||activeOwner||stopped||termination||budgetPause)return;
    let next=continuation;continuation=undefined;
    const pause=!approval&&softBudgetReached();
    if(pause){
      for(const checkpoint of checkpoints.values())retire(checkpoint,false);
      next={instructions:'O limite preventivo desta ligação foi atingido. Explique brevemente, com suas próprias palavras, que a ligação será interrompida e que o progresso efetivamente salvo poderá ser retomado pelo painel. Não anuncie conclusão ou aprovação, não faça outra pergunta e não narre detalhes técnicos.'};
      budgetPause={timer:setTimeout(()=>{void deps.enqueue(async()=>{if(!stopped&&!termination)finish('budget_notice_unconfirmed');});},15000)};
      publish('budget_pause_speaking');diagnostic('native.budget_pause',deps.budgetStatus?.());
    }
    const requestId=randomUUID(),context:ResponseContext={ownerItemId:next.ownerItemId,snapshot:stored,...(pause?{budgetPause:true}:{})};
    if(next.checkpoint){
      const checkpoint:Checkpoint={id:requestId,kind:next.checkpoint,snapshot:stored,...(next.checkpoint==='signoff'?{approvalReceiptId:approval?.receiptId}:{})};
      checkpoint.timer=setTimeout(()=>{void deps.enqueue(async()=>{if(!checkpoint.retired&&!checkpoint.proof&&!stopped&&!termination)finish('native_checkpoint_timeout');});},180_000);
      context.checkpoint=checkpoint;checkpoints.set(requestId,checkpoint);
      if(next.checkpoint==='review')currentReview=checkpoint;else currentSignoff=checkpoint;
      publish(next.checkpoint==='review'?'reading_summary':'signoff');
    }
    issued.set(requestId,context);responsePending=true;pendingRequestId=requestId;
    deps.send({type:'response.create',event_id:requestId,response:{output_modalities:['audio'],
      metadata:{native_request_id:requestId,...(next.checkpoint?{native_checkpoint:next.checkpoint}:{}),...(pause?{native_budget_pause:'true'}:{})},
      ...(next.checkpoint||pause||next.opening?{tools:[],tool_choice:'none'}:{}),
      ...(pause?{max_output_tokens:512}:{}),
      ...(next.instructions?{instructions:`${nativeInstructions}\n\n${next.instructions}`}:{})}});
  }
  function finish(reason:string,outcome:'complete'|'unfinished'='unfinished'){
    if(stopped||termination)return;
    clearTimeout(budgetPause?.timer);
    termination={type:'terminate_session',action:'TERMINATE_SESSION',requestId:randomUUID(),outcome,reason,
      ...(approval?{approvalReceiptId:approval.receiptId}:{})};
    continuation=undefined;publish('terminating');diagnostic('native.terminated',{code:reason});deps.onTerminate(termination);
  }
  async function io<T>(operation:(s:InterviewScope)=>Promise<T>):Promise<T>{
    if(stopped||termination)throw Error('native_website_stopped');
    const controller=new AbortController();let rejectAbort:(reason:unknown)=>void=()=>{};
    const cancel=()=>{controller.abort(abort.signal.reason);rejectAbort(abort.signal.reason??Error('native_website_stopped'));};
    abort.signal.addEventListener('abort',cancel,{once:true});let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<T>((_,reject)=>{rejectAbort=reject;timer=setTimeout(()=>{const error=Object.assign(Error('native_operation_timeout'),{name:'TimeoutError'});controller.abort(error);reject(error);},8000);});
    try{return await Promise.race([operation({...scope,signal:controller.signal}),deadline]);}
    finally{clearTimeout(timer);abort.signal.removeEventListener('abort',cancel);}
  }
  async function retry<T>(operation:(s:InterviewScope)=>Promise<T>):Promise<T>{
    try{return await io(operation);}catch(error){if(!transient(error)||stopped||termination)throw error;diagnostic('native.effect_retry');return io(operation);}
  }
  function toolOutput(tool:ToolCall,value:Record<string,unknown>,continueVoice=true){
    if(stopped||termination||completedTools.has(tool.id))return;
    completedTools.add(tool.id);pendingTools.delete(tool.id);clearTimeout(tool.timer);
    const turn=tool.context.ownerItemId?turns.get(tool.context.ownerItemId):undefined;if(turn)turn.processed=true;
    deps.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:tool.id,output:JSON.stringify(value)}});
    if(continueVoice)requestConversation(tool.context.ownerItemId);
  }
  function rejected(tool:ToolCall,code:string){
    diagnostic('native.tool_rejected',{code});
    let proposal:any;try{proposal=JSON.parse(tool.arguments)?.proposal;}catch{}
    const ids=new Set([proposal?.itemId,...(Array.isArray(proposal?.affectedItems)?proposal.affectedItems.map((x:any)=>x?.itemId):[]),
      ...(Array.isArray(proposal?.affectedCandidates)?proposal.affectedCandidates.map((x:any)=>x?.candidateId):[])]);
    const targetItems=getAgendaItems(stored.agenda).filter(item=>ids.has(item.id)).map(item=>({id:item.id,status:item.status,
      latestEvidence:item.evidence.at(-1)??null}));
    const correction=proposal?.kind!=='correction'&&targetItems.some(item=>!['open','awaiting_clarification','deferred_owner_review'].includes(item.status));
    toolOutput(tool,{saved:false,operationApplied:false,code,sourceItemId:tool.context.ownerItemId??null,targetItems,
      recovery:correction?'correct_existing_item':'retry_same_response',context:toolContext(),
      instruction:'Esta tentativa não alterou os dados. As evidências salvas nos alvos continuam válidas. Recupere o conteúdo já recebido sem pedir sua repetição: para complementar ou corrigir um item já respondido, use correction com o ID desse mesmo item. Não transfira a resposta à próxima pergunta. Se faltar uma decisão real, mantenha a pendência e esclareça somente esse ponto. Explique ao dono apenas o efeito e o próximo passo útil, sem narrar ajustes internos.'});
  }
  async function saveProposal(tool:ToolCall,value:unknown){
    const ownerId=tool.context.ownerItemId,turn=ownerId?turns.get(ownerId):undefined;
    if(!ownerId||!turn?.committed){rejected(tool,'owner_input_unavailable');return;}
    const turnId=`${scope.callId}:${ownerId}`,prior=stored.agenda.ownerTurns.some(entry=>entry.turnId===turnId);
    const correction=object(value)&&object(value.proposal)&&value.proposal.kind==='correction';
    const source=correction&&!prior?stored:turn.snapshot;
    const parsed=parseNativeOnboardingProposal(value,source);
    if(!parsed){rejected(tool,turn.snapshot.digest!==stored.digest&&!correction?'draft_version_changed':'proposal_not_admitted');return;}
    let content:ReturnType<typeof nativeContent>;
    try{content=nativeContent(parsed,source.agenda);}catch(error){
      const reason=error instanceof Error?error.message.split(':')[0]:'';
      const safeReason=/^website_facts_[a-z_]+$/.test(reason)||['proposal_content_missing','proposal_content_invalid'].includes(reason)?reason:'native_content_validation_unknown';
      diagnostic('native.content_rejected',{code:safeReason,factCount:parsed.facts?.length??0});
      rejected(tool,error instanceof Error&&error.message==='proposal_content_missing'?'proposal_content_missing':'proposal_content_invalid');return;
    }
    const {proposal,interpretation,facts,omittedRelatedItemIds}=content;
    const replay=(s:InterviewScope)=>deps.agendaStore.replayNativeOwnerTurn({...s,providerItemId:ownerId,proposal,interpretation,facts});
    const saved=(result:StoredWebsiteInterview&{operationReceiptId:string;operationRevision:number},replayed=false)=>{
      stored=currentSnapshot(result);
      if(!UUID.test(result.operationReceiptId)||!Number.isSafeInteger(result.operationRevision)||result.operationRevision<1||result.operationRevision>stored.revision)
        throw Error('native_operation_receipt_mismatch');
      configure();publish('awaiting_owner');
      toolOutput(tool,{saved:true,replayed,savedReceiptId:result.operationReceiptId,savedRevision:result.operationRevision,
        revision:stored.revision,digest:stored.digest,interpretation,provenance:'model_interpretation',omittedRelatedItemIds,
        context:toolContext()},stored.state!=='reviewing');
      if(stored.state==='reviewing')requestCheckpoint('review');
    };
    if(prior){
      const receipt=await io(replay);if(stopped||termination)return;
      if(!receipt){rejected(tool,'native_operation_unconfirmed');return;}saved(receipt,true);return;
    }
    // A response retry cannot refresh the question the owner actually heard.
    if(proposal.kind!=='correction'&&(tool.context.snapshot.digest!==stored.digest||turn.snapshot.digest!==stored.digest)){
      rejected(tool,'draft_version_changed');return;
    }
    const before=stored;
    if(before.state==='closing'){
      if(!approval||proposal.kind!=='correction'||turn.order<=approval.ownerOrder){rejected(tool,'amendment_not_admitted');return;}
      const amendment={kind:'correction' as const,
        ...(proposal.affectedItems?{affectedItems:proposal.affectedItems.map(target=>({...target,disposition:'reopen' as const}))}:{}),
        ...(proposal.affectedCandidates?{affectedCandidates:proposal.affectedCandidates.map(target=>({...target,disposition:'reopen' as const}))}:{})};
      invalidateCheckpoints();
      const receipt=await retry(s=>deps.evidenceStore.requestNativeAmendment({...s,approvalReceiptId:approval!.receiptId,providerItemId:ownerId,proposal:amendment,interpretation}));
      if(stopped||termination)return;
      if(receipt.callId!==scope.callId||receipt.approvalReceiptId!==approval.receiptId||receipt.providerItemId!==ownerId
        ||receipt.state!=='pending_amendment'||!UUID.test(receipt.receiptId))throw Error('native_amendment_receipt_mismatch');
      amendmentReceiptId=receipt.receiptId;toolOutput(tool,{saved:true,amendmentRequested:true,approvalPreserved:true},false);requestCheckpoint('signoff');return;
    }
    const transition=applyVerifiedOwnerTurn(before.agenda,{type:'verified_owner_turn',binding:before.agenda.binding,
      turnId,text:interpretation,provenance:'model_interpretation',proposal});
    if(!transition.accepted||!transition.action||transition.replayed){rejected(tool,'proposal_not_admitted');return;}
    invalidateCheckpoints();const expected=onboardingAgendaDigest(transition.agenda);publish('persisting_agenda');
    const commit=(s:InterviewScope)=>deps.agendaStore.commitNativeOwnerTurn({...s,expectedRevision:before.revision,expectedStoreVersion:before.storeVersion,
      expectedDigest:before.digest,providerItemId:ownerId,proposal,agenda:transition.agenda,facts,interpretation});
    let result:Awaited<ReturnType<typeof commit>>;
    try{result=await io(commit);}catch(error){
      if(!transient(error))throw error;diagnostic('native.write_reconciling');
      const receipt=await io(replay);if(stopped||termination)return;
      if(receipt){saved(receipt,true);return;}
      const current=currentSnapshot(await io(s=>deps.agendaStore.readWebsiteInterview(s)));
      if(current.digest===before.digest&&current.storeVersion===before.storeVersion)result=await io(commit);
      else{stored=current;rejected(tool,'draft_version_changed');return;}
    }
    if(stopped||termination)return;
    if(result.digest!==expected)throw Error('native_commit_readback_mismatch');
    diagnostic('native.answer_saved');saved(result,result.replayed);
  }
  async function approve(tool:ToolCall,value:unknown){
    const ownerId=tool.context.ownerItemId,turn=ownerId?turns.get(ownerId):undefined,review=currentReview,summary=review?.proof;
    if(!object(value)||!exact(value,[])||!ownerId||!turn?.recorded||!turn.transcript||turn.transcriptConflict||stored.state!=='reviewing'
      ||!review||review.retired||!summary?.summaryId||!summary.summaryHash||review.snapshot.digest!==stored.digest
      ||tool.context.snapshot.digest!==stored.digest||turn.snapshot.digest!==stored.digest||turn.reviewCheckpointId!==review.id
      ||!review.playedOrder||turn.order<=review.playedOrder||latestOwner!==ownerId||activeOwner
      ||[...turns.values()].some(other=>other.order>turn.order&&!other.processed)
      ||classifyWebsiteApprovalTranscript(turn.transcript)!=='approval'){
      rejected(tool,'approval_not_admitted');return;
    }
    const before=stored;publish('persisting_approval');
    const args={summaryId:summary.summaryId,summaryHash:summary.summaryHash,providerItemId:ownerId,expectedRevision:before.revision,
      expectedStoreVersion:before.storeVersion,expectedDigest:before.digest};
    const receipt=await retry(s=>deps.evidenceStore.approveSummary({...s,...args}));
    if(stopped||termination)return;
    if(!UUID.test(receipt?.approvalReceiptId??'')||receipt.turnId!==`${scope.callId}:${ownerId}`||receipt.summaryId!==args.summaryId
      ||receipt.summaryHash!==args.summaryHash||receipt.revision!==before.revision||receipt.digest!==before.digest||receipt.storeVersion!==before.storeVersion+1)
      throw Error('native_approval_receipt_mismatch');
    approval={receiptId:receipt.approvalReceiptId,ownerItemId:ownerId,ownerOrder:turn.order,summaryId:args.summaryId,summaryHash:args.summaryHash,digest:before.digest};
    stored={...before,state:'closing',storeVersion:receipt.storeVersion,receiptId:receipt.approvalReceiptId};
    configure();toolOutput(tool,{saved:true,approved:true,approvalReceiptId:approval.receiptId},false);requestCheckpoint('signoff');
  }
  async function executeTool(tool:ToolCall){
    if(stopped||termination||completedTools.has(tool.id)||tool.context.cancelled)return;
    let value:unknown;
    try{if(typeof tool.arguments!=='string'||tool.arguments.length>65536)throw Error();value=JSON.parse(tool.arguments);}catch{rejected(tool,'invalid_tool_arguments');return;}
    try{
      if(tool.name===NATIVE_ONBOARDING_APPROVAL_TOOL)await approve(tool,value);
      else if(tool.name===NATIVE_ONBOARDING_PROPOSAL_TOOL)await saveProposal(tool,value);
      else rejected(tool,'unknown_tool');
    }catch(error){
      if(stopped||termination)return;if(authFailure(error)){finish('website_authorization_lost');return;}
      rejected(tool,'operation_unconfirmed');publish('awaiting_owner');
    }
  }
  async function drainTools(){
    for(const tool of [...pendingTools.values()]){
      if(stopped||termination)break;
      const owner=tool.context.ownerItemId;
      if(tool.name===NATIVE_ONBOARDING_APPROVAL_TOOL&&owner&&!turns.get(owner)?.recorded)continue;
      pendingTools.delete(tool.id);clearTimeout(tool.timer);await executeTool(tool);
    }
  }
  function annexTranscript(itemId:string,text:string){
    const turn=turns.get(itemId);if(!turn)return;
    if(turn.transcript!==undefined&&turn.transcript!==text){
      turn.transcriptConflict=true;diagnostic('native.conflicting_owner_transcript');return;
    }
    if(turn.recorded||turn.recording)return;
    if(turn.transcript===undefined){turn.transcript=text;deps.onTranscript({role:'caller',text,at:new Date().toISOString()});}
    // Evidence persistence must not occupy the serialized business-tool queue.
    // Only an approval tool waits for this actual transcript's durable receipt.
    turn.recording=retry(s=>deps.agendaStore.recordOwnerTranscript({...s,providerItemId:itemId,text})).then(()=>deps.enqueue(async()=>{
      if(stopped||termination)return;
      turn.recorded=true;diagnostic('owner.transcript_final');await drainTools();
      resumeCheckpointAfterTurn();flushContinuation();maybeFinish();
    })).catch(error=>{
      if(stopped||termination)return;
      if(authFailure(error))void deps.enqueue(async()=>finish('website_authorization_lost')).catch(()=>{});
      else diagnostic('native.owner_evidence_unavailable');
    }).finally(()=>{turn.recording=undefined;});
  }
  function checkpointMatches(checkpoint:Checkpoint,metadata:any){
    return object(metadata)&&metadata.native_request_id===checkpoint.id&&metadata.native_checkpoint===checkpoint.kind;
  }
  function join(checkpoint:Checkpoint){
    if(checkpoint.retired||checkpoint.playedOrder||!checkpoint.generationDone||!checkpoint.bufferStoppedEventId||!checkpoint.media
      ||checkpoint.media.itemId!==checkpoint.itemId||!checkpoint.transcript)return;
    checkpoint.playedOrder=++order;clearTimeout(checkpoint.playoutTimer);
  }
  function boundPlayout(checkpoint:Checkpoint){
    if(checkpoint.playoutTimer||checkpoint.playedOrder||checkpoint.retired)return;
    // The browser drains for at most 2s; allow 3s more for its data-channel report.
    checkpoint.playoutTimer=setTimeout(()=>{void deps.enqueue(async()=>{
      if(stopped||termination||checkpoint.retired||checkpoint.playedOrder)return;
      diagnostic('native.checkpoint_playout_unconfirmed');retryCheckpoint(checkpoint);
    }).catch(()=>{});},5000);
  }
  function observeMessage(event:any){
    if(!['conversation.item.created','conversation.item.done'].includes(event.type)||event.item?.role!=='system')return;
    const text=event.item.content?.find((part:any)=>part.type==='input_text'&&typeof part.text==='string'&&part.text.startsWith('ligou.website_native_played:'))?.text;
    if(!text||text.length>8192)return;
    try{
      const body=JSON.parse(text.slice('ligou.website_native_played:'.length));
      if(!object(body)||!exact(body,['callId','interviewId','responseId','itemId','checkpoint','mediaEvidence'])
        ||body.callId!==scope.callId||body.interviewId!==stored.agenda.binding.interviewId||!ID.test(body.itemId??'')
        ||!streamMediaEvidenceIsValid(body.mediaEvidence))return;
      const checkpoint=responses.get(body.responseId)?.checkpoint;
      if(!checkpoint||checkpoint.retired||checkpoint.kind!==body.checkpoint
        ||event.item.id!==`lnp-${checkpoint.id.replaceAll('-','').slice(0,28)}`||checkpoint.snapshot.digest!==stored.digest)return;
      if(checkpoint.media&&JSON.stringify(checkpoint.media)!==JSON.stringify({itemId:body.itemId,evidence:body.mediaEvidence})){retire(checkpoint);return;}
      checkpoint.media={itemId:body.itemId,evidence:body.mediaEvidence};join(checkpoint);
    }catch{}
  }
  function observeEvent(event:any){
    if(stopped||termination)return;const id=event.item_id;
    if(['input_audio_buffer.speech_started','input_audio_buffer.committed'].includes(event.type)&&ID.test(id??'')){
      if(!turns.has(id)){
        const review=currentReview;
        turns.set(id,{snapshot:stored,order:++order,...(review&&!review.retired&&review.playedOrder&&review.snapshot.digest===stored.digest?{reviewCheckpointId:review.id}:{})});
        for(const checkpoint of checkpoints.values())if(!checkpoint.playedOrder)retire(checkpoint);
      }
      if(event.type==='input_audio_buffer.speech_started'){
        activeOwner=id;for(const checkpoint of checkpoints.values())if(!checkpoint.playedOrder)retire(checkpoint);
      }else{turns.get(id)!.committed=true;latestOwner=id;if(activeOwner===id)activeOwner=undefined;}
    }
    if(event.type==='input_audio_buffer.speech_stopped'&&activeOwner===id)activeOwner=undefined;
    if(event.type==='response.created'&&ID.test(event.response?.id??'')){
      const response=event.response;
      for(const value of checkpoints.values())if(value.responseId&&value.responseId!==response.id&&!value.playedOrder)retire(value);
      if(!responses.has(response.id)&&!usageResponses.has(response.id)){
        const requestId=response.metadata?.native_request_id,requested=typeof requestId==='string'?issued.get(requestId):undefined;
        const context=requested??{ownerItemId:latestOwner,snapshot:(latestOwner?turns.get(latestOwner)?.snapshot:undefined)??stored};
        responses.set(response.id,context);
        if(requested){issued.delete(requestId);if(pendingRequestId===requestId){pendingRequestId=undefined;responsePending=false;}if(requested.checkpoint){
          const checkpoint=requested.checkpoint;checkpoint.responseId=response.id;
          if(checkpoint.retired||checkpoint.snapshot.digest!==stored.digest||checkpoint.snapshot.storeVersion!==stored.storeVersion){context.cancelled=true;retire(checkpoint);}
          else if(!checkpointMatches(checkpoint,response.metadata)){context.cancelled=true;checkpointFault(checkpoint);}
        }}
        if(requested?.budgetPause&&budgetPause)budgetPause.responseId=response.id;
      }
      const context=responses.get(response.id);if(context&&!context.done)activeResponses.add(response.id);
    }
    const responseId=event.response_id??event.response?.id,context=responses.get(responseId),checkpoint=context?.checkpoint;
    if(event.type==='response.output_audio_transcript.done'&&checkpoint&&!checkpoint.retired&&ID.test(event.item_id??'')&&typeof event.transcript==='string'){
      const value={itemId:event.item_id,text:event.transcript};
      if(checkpoint.transcriptDone&&JSON.stringify(checkpoint.transcriptDone)!==JSON.stringify(value))checkpointFault(checkpoint);
      else checkpoint.transcriptDone=value;
    }
    if(event.type==='response.done'){
      activeResponses.delete(event.response?.id);
      if(context){context.done=true;if(event.response?.status!=='completed')context.cancelled=true;}
      if(context?.budgetPause&&budgetPause){budgetPause.generationDone=event.response?.status==='completed';budgetPause.interrupted=!budgetPause.generationDone;}
      if(checkpoint&&!checkpoint.retired){
        if(context?.cancelled||!checkpointMatches(checkpoint,event.response?.metadata)){checkpointFault(checkpoint);}
        else{
          const output=event.response?.output,items=Array.isArray(output)?output.filter((item:any)=>item?.type==='message'&&item.role==='assistant'):[];
          const item=items[0],parts=item?.content,audio=Array.isArray(parts)&&parts.length===1&&['audio','output_audio'].includes(parts[0]?.type)?parts[0]:undefined;
          const transcript=audio?.transcript??(checkpoint.transcriptDone&&checkpoint.transcriptDone.itemId===item?.id?checkpoint.transcriptDone.text:undefined);
          if(items.length!==1||item.status!=='completed'||!ID.test(item.id??'')||!audio||output.some((entry:any)=>entry?.type==='function_call')
            ||typeof transcript!=='string'||!transcript.trim()||[...transcript].length>8192
            ||(checkpoint.transcriptDone&&(checkpoint.transcriptDone.itemId!==item.id||checkpoint.transcriptDone.text!==transcript)))checkpointFault(checkpoint);
          else{checkpoint.itemId=item.id;checkpoint.transcript=transcript;checkpoint.generationDone=true;join(checkpoint);}
        }
      }
    }
    if(event.type==='output_audio_buffer.started')activeAudio=event.response_id;
    if(event.type==='output_audio_buffer.stopped'){
      if(!event.response_id||event.response_id===activeAudio)activeAudio=undefined;
      if(context?.budgetPause&&budgetPause&&ID.test(event.event_id??''))budgetPause.bufferStopped=true;
      if(checkpoint&&!checkpoint.retired&&ID.test(event.event_id??'')){
        if(checkpoint.bufferStoppedEventId&&checkpoint.bufferStoppedEventId!==event.event_id)retire(checkpoint);
        else{checkpoint.bufferStoppedEventId=event.event_id;join(checkpoint);boundPlayout(checkpoint);}
      }
    }
    if(event.type==='output_audio_buffer.cleared'){
      if(!event.response_id||event.response_id===activeAudio)activeAudio=undefined;
      if(context?.budgetPause&&budgetPause)budgetPause.interrupted=true;
      if(checkpoint&&!checkpoint.playedOrder)retire(checkpoint,false);
      else if(!event.response_id)for(const value of checkpoints.values())if(!value.playedOrder)retire(value,false);
    }
    if(event.type==='conversation.item.truncated')for(const value of checkpoints.values())if(value.itemId===id||value.transcriptDone?.itemId===id)retire(value,false);
    observeMessage(event);
  }
  async function drainCheckpoints(){
    for(const checkpoint of checkpoints.values()){
      if(stopped||termination)return;
      if(checkpoint.retired||!checkpoint.playedOrder||checkpoint.proof||checkpoint.recording)continue;
      if(checkpoint.snapshot.digest!==stored.digest){retire(checkpoint);continue;}
      checkpoint.recording=true;
      const args={checkpointId:checkpoint.id,kind:checkpoint.kind,expectedRevision:checkpoint.snapshot.revision,
        expectedStoreVersion:checkpoint.snapshot.storeVersion,expectedDigest:checkpoint.snapshot.digest,expectedReceiptId:checkpoint.snapshot.receiptId,
        responseId:checkpoint.responseId!,itemId:checkpoint.itemId!,transcript:checkpoint.transcript!,bufferStoppedEventId:checkpoint.bufferStoppedEventId!,
        mediaEvidence:checkpoint.media!.evidence,...(checkpoint.approvalReceiptId?{approvalReceiptId:checkpoint.approvalReceiptId}:{})};
      try{
        const proof=await retry(s=>deps.evidenceStore.recordNativeCheckpoint({...s,...args}));
        if(stopped||termination||checkpoint.retired)return;
        if(!proof||proof.checkpointId!==checkpoint.id||proof.kind!==checkpoint.kind||proof.callId!==scope.callId
          ||proof.interviewId!==stored.agenda.binding.interviewId||proof.revision!==checkpoint.snapshot.revision||proof.digest!==checkpoint.snapshot.digest
          ||proof.responseId!==checkpoint.responseId||proof.itemId!==checkpoint.itemId||!UUID.test(proof.receiptId)
          ||proof.schema!=='onboarding.native.checkpoint.v1'||proof.transcript!==checkpoint.transcript||proof.bufferStoppedEventId!==checkpoint.bufferStoppedEventId
          ||!streamMediaEvidenceIsValid(proof.mediaEvidence)||Object.keys(args.mediaEvidence).some(key=>proof.mediaEvidence[key as keyof StreamMediaEvidence]!==args.mediaEvidence[key as keyof StreamMediaEvidence]))throw Error('native_checkpoint_receipt_mismatch');
        if(checkpoint.kind==='review'){
          const expectedHash=createHash('sha256').update(JSON.stringify([proof.summaryId,proof.revision,proof.digest,[checkpoint.transcript]])).digest('hex');
          if(!UUID.test(proof.summaryId??'')||proof.summaryHash!==expectedHash||JSON.stringify(proof.parts)!==JSON.stringify([checkpoint.transcript])
            ||proof.storeVersion!==checkpoint.snapshot.storeVersion+1)throw Error('native_review_receipt_mismatch');
        }else if(proof.approvalReceiptId!==approval?.receiptId||proof.storeVersion!==checkpoint.snapshot.storeVersion)throw Error('native_signoff_receipt_mismatch');
        if(proof.storeVersion!==stored.storeVersion){
          const refreshed=currentSnapshot(await io(s=>deps.agendaStore.readWebsiteInterview(s)));
          if(stopped||termination||checkpoint.retired)return;
          if(refreshed.digest!==proof.digest||refreshed.revision!==proof.revision||refreshed.storeVersion!==proof.storeVersion
            ||refreshed.receiptId!==proof.agendaReceiptId)throw Error('native_checkpoint_source_changed');
          stored=refreshed;
        }
        checkpoint.proof=proof;clearTimeout(checkpoint.timer);diagnostic('native.checkpoint_recorded',{code:checkpoint.kind});
        if(checkpoint.kind==='review'){configure();publish('awaiting_approval');}
      }catch(error){if(stopped||termination)return;diagnostic('native.checkpoint_failed');finish(authFailure(error)?'website_authorization_lost':'native_checkpoint_unconfirmed');}
      finally{checkpoint.recording=false;}
    }
  }
  function maybeFinish(){
    if(!approval||!currentSignoff?.proof||currentSignoff.retired||activeOwner||activeAudio||activeResponses.size||responsePending
      ||[...turns.values()].some(turn=>turn.order>approval!.ownerOrder&&!turn.processed))return;
    finish(amendmentReceiptId?'owner_amendment_requested':'website_interview_complete',amendmentReceiptId?'unfinished':'complete');
  }
  function resumeCheckpointAfterTurn(){
    const owner=latestOwner?turns.get(latestOwner):undefined;
    if(!owner?.committed||!owner.responded||!owner.processed||activeOwner||pendingTools.size||activeResponses.size||responsePending||continuation)return;
    if(stored.state==='reviewing'&&!currentReview)requestCheckpoint('review');
    else if(stored.state==='closing'&&approval&&!currentSignoff)requestCheckpoint('signoff');
  }
  async function handleEvent(event:any){
    if(event.type==='response.done'&&ID.test(event.response?.id??'')&&!usageResponses.has(event.response.id)){
      usageResponses.add(event.response.id);deps.onUsage(event.response);
    }
    if(stopped||termination)return;observeEvent(event);
    for(const checkpoint of checkpointFaults.splice(0))retryCheckpoint(checkpoint);
    if(stopped||termination)return;
    if(['conversation.item.created','conversation.item.done'].includes(event.type)&&event.item?.role==='system'){
      const prefix='ligou.website_native_ready:',text=event.item.content?.find((part:any)=>part.type==='input_text'&&part.text?.startsWith(prefix))?.text;
      if(text){try{
        const ready=JSON.parse(text.slice(prefix.length));
        if(!object(ready)||!exact(ready,['callId','interviewId'])||ready.callId!==scope.callId||ready.interviewId!==stored.agenda.binding.interviewId)return;
        browserReady=true;contextNotice();
        if(!opened){opened=true;
          if(stored.state==='reviewing')requestCheckpoint('review');
          else requestConversation(undefined,'Abra a entrevista em português, apresentando-se brevemente como Ligou, agente de inteligência artificial da empresa, e faça a pergunta atual indicada no contexto.',undefined,true);
        }
      }catch{return;}}
    }
    await drainCheckpoints();if(stopped||termination)return;
    if(event.type==='conversation.item.input_audio_transcription.completed'&&ID.test(event.item_id??'')&&typeof event.transcript==='string'&&event.transcript.trim()){
      annexTranscript(event.item_id,event.transcript);
    }
    if(event.type==='response.output_audio_transcript.done'&&typeof event.transcript==='string')deps.onTranscript({role:'agent',text:event.transcript,at:new Date().toISOString()});
    if(budgetPause){
      if(budgetPause.interrupted)finish('budget_notice_interrupted');
      else if(budgetPause.generationDone&&budgetPause.bufferStopped)finish('budget_soft_limit_reached');
      return;
    }
    if(event.type==='response.done'&&!handledResponses.has(event.response?.id)){
      handledResponses.add(event.response?.id);const context=responses.get(event.response?.id),turn=context?.ownerItemId?turns.get(context.ownerItemId):undefined;
      if(turn)turn.responded=true;
      if(event.response?.status==='completed'&&context&&!context.cancelled&&!context.checkpoint){
        for(const item of event.response.output??[]){
          if(item.type!=='function_call'||item.status!=='completed'||!ID.test(item.call_id??'')||completedTools.has(item.call_id)||pendingTools.has(item.call_id))continue;
          const tool:ToolCall={id:item.call_id,name:item.name,arguments:item.arguments,responseId:event.response.id,context};pendingTools.set(tool.id,tool);
          if(tool.name===NATIVE_ONBOARDING_APPROVAL_TOOL)tool.timer=setTimeout(()=>{void deps.enqueue(async()=>{
            if(pendingTools.has(tool.id)){pendingTools.delete(tool.id);rejected(tool,'owner_evidence_unavailable');}
          });},8000);
        }
        await drainTools();
      }
      if(turn?.committed&&![...pendingTools.values()].some(tool=>tool.context.ownerItemId===context?.ownerItemId))turn.processed=true;
    }
    if(event.type==='response.done'&&!approval&&softBudgetReached()&&!continuation)requestConversation();
    resumeCheckpointAfterTurn();flushContinuation();maybeFinish();
  }
  async function attach(){if(stopped||termination)return;configure();if(browserReady)publish('awaiting_owner');}
  function stop(){if(stopped)return;stopped=true;abort.abort();
    clearTimeout(budgetPause?.timer);
    for(const tool of pendingTools.values())clearTimeout(tool.timer);pendingTools.clear();
    for(const checkpoint of checkpoints.values()){checkpoint.retired=true;clearTimeout(checkpoint.timer);clearTimeout(checkpoint.playoutTimer);}continuation=undefined;
  }
  async function finalized(proof:{providerReceiptId:string;budgetReceiptId:string}){
    if(!UUID.test(proof?.providerReceiptId??'')||!UUID.test(proof?.budgetReceiptId??''))return;
    if(finalization)return finalization;
    const outcome=termination?.outcome==='complete'&&approval&&currentSignoff?.proof&&!amendmentReceiptId?'complete':'unfinished';
    finalization=(async()=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      let receipt:any;
      try{receipt=await Promise.race([deps.evidenceStore.recordCompletion({...scope,outcome,...(approval?{approvalReceiptId:approval.receiptId}:{})}),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('native_completion_timeout')),8000);})]);}
      finally{clearTimeout(timer);}
      if(!receipt||receipt.callId!==scope.callId||receipt.interviewId!==stored.agenda.binding.interviewId||receipt.outcome!==outcome
        ||(receipt.approvalReceiptId??undefined)!==approval?.receiptId||!UUID.test(receipt.receiptId)||receipt.providerConfirmed!==true||receipt.budgetSettled!==true)
        throw Error('native_completion_receipt_mismatch');
      if(outcome==='complete')stored={...stored,state:'complete'};publish(outcome==='complete'?'complete':'unfinished');
    })().catch(error=>{finalization=undefined;throw error;});
    return finalization;
  }
  return{native:true as const,streaming:true as const,attach,observeEvent,handleEvent,stop,finalized,
    ownsSpeechRetrieveMiss:(_event:any)=>false,
    ownsControlError:(event:any)=>event?.type==='error'&&event.error?.code==='response_cancel_not_active'&&controlEvents.has(event.error.event_id),
    get state(){return{phase,stored};}};
}
