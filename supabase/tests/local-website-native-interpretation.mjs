import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingAgendaStore} from '../../voice-controller/src/onboarding-agenda-store.ts';
import {createInterviewEvidenceStore} from '../../voice-controller/src/onboarding-interview-evidence-store.ts';
import {applyVerifiedOwnerTurn,getAgendaAction} from '../../voice-controller/src/onboarding-agenda.ts';
const q=x=>`'${String(x).replaceAll("'","''")}'`,jq=x=>`${q(JSON.stringify(x))}::jsonb`;

// Actual store/RPC/reducer integration; provider/owner understanding and media
// are synthetic. Source records and all prior calls remain unchanged.
export async function runWebsiteNativeInterpretationProbe({runSql,rpc,owner,other,tenant,priorCall,source,initialAgenda}){
 const call=randomUUID(),request=randomUUID(),preparation=randomUUID(),scope={ownerId:owner,callId:call,requestId:request};
 const client={rpc:async(name,args)=>({data:await rpc(name,args),error:null})},store=createOnboardingAgendaStore(client);let created=false,reserved=false,proof;
 try{
  await store.prepareFreshWebsiteInterview({preparationId:preparation,ownerId:owner,expectedTenantId:tenant,expectedGeneration:2,priorCallId:priorCall,
   draftId:source.draftId,draftHash:source.draftHash,sourceResultId:source.sourceResultId,sourceResultHash:source.sourceResultHash});
  await runSql(`begin;insert into calls(id,tenant_id,channel,session_type,status,model,openai_call_id,provider_termination_state,provider_termination_mode,provider_usage_state,cost_estimate_usd)
   values(${q(call)},${q(tenant)},'browser','onboarding','active','gpt-realtime-2.1',${q('rtc_native_interpretation_'+call)},'active','hangup','unknown',0);
   insert into browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version)
   values(${q(request)},${q(tenant)},${q(owner)},'onboarding','native-interpretation-offer','processing',${q(call)},'realtime_native_v1',5);commit;`);created=true;
  await rpc('reserve_call_budget',{p_tenant:tenant,p_call:call,p_est_cost:7.5,p_reserved_minutes:55});reserved=true;
  const agenda=structuredClone(initialAgenda);agenda.binding={...agenda.binding,callId:call,interviewId:call};assert.equal(agenda.items.length,114);assert.equal(agenda.candidateContext.length,21);
  await store.initializeWebsiteInterview({...scope,preparationId:preparation,agenda});
  proof=await runNativeInterpretationCases({runSql,rpc,owner,other,tenant,call,request});return proof;
 }finally{
  if(created)await runSql(`update calls set status='ended',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='agent_ended_session',provider_usage_state='resolved',cost_estimate_usd=0.025 where id=${q(call)};`);
  if(reserved)await rpc('settle_call_budget',{p_tenant:tenant,p_call:call,p_actual_cost:0.025,p_minutes:1,p_outcome:'ended',p_detail:{fixture:'native-interpretation-probe'}});
  if(proof){const terminal=await createInterviewEvidenceStore(client).recordCompletion({...scope,outcome:'complete',approvalReceiptId:proof.approvalReceiptId});
   assert.equal(terminal.outcome,'complete');proof.terminalReceiptId=terminal.receiptId;proof.completed=true;}
 }
}

export async function runNativeInterpretationCases({runSql,rpc,owner,other,tenant,call,request}){
 const scope={ownerId:owner,callId:call,requestId:request},calls=[];let loseCommit=true;
 const store=createOnboardingAgendaStore({rpc:async(name,args)=>{
  calls.push(name);const data=await rpc(name,args);
  if(name==='commit_website_interview_native_turn'&&loseCommit){loseCommit=false;return{data:null,error:{message:'synthetic result lost after actual COMMIT',code:'08006'}};}
  return{data,error:null};
 }}),evidence=createInterviewEvidenceStore({rpc:async(name,args)=>({data:await rpc(name,args),error:null})});
 let stored=await store.readWebsiteInterview(scope);const initial=stored,tests=[];
 await runSql(`update calls set openai_call_id=${q('rtc_native_'+call)},provider_termination_state='active',provider_usage_state='unknown' where id=${q(call)};
  update browser_session_requests set status='ready',answer_sdp='native-answer',opening_mode_applied='realtime_native_v1',opening_payload=${jq({version:5,native:{callId:call,interviewId:stored.agenda.binding.interviewId,revision:stored.revision,sourceDigest:stored.digest}})} where id=${q(request)};`);
 const first=stored.agenda.items.find(i=>i.id===getAgendaAction(stored.agenda).itemId),related=first.relatedItemIds.filter(id=>stored.agenda.items.some(i=>i.id===id&&i.status==='open'&&i.coverageRefs.every(ref=>['area.coverage','area.out_of_area_policy'].includes(ref))));
 const interpretation='Atendimento somente em Novato, San Rafael e Petaluma. Qualquer endereço fora dessas cidades exige aprovação explícita do dono.';
 const proposal={kind:'answer',itemId:first.id,...(related.length?{relatedItemIds:related}:{})};
 const facts=[{topic:'area',field:first.coverageRefs[0],disposition:'answered',rule_text:interpretation,structured:{value:['Novato','San Rafael','Petaluma']}}];
 const makeInput=(base,item,text,proposed,typed=[])=>{
  const transition=applyVerifiedOwnerTurn(base.agenda,{type:'verified_owner_turn',binding:base.agenda.binding,turnId:`${call}:${item}`,text,provenance:'model_interpretation',proposal:proposed});
  assert.equal(transition.accepted,true,transition.rejection);
  return{...scope,expectedRevision:base.revision,expectedStoreVersion:base.storeVersion,expectedDigest:base.digest,providerItemId:item,interpretation:text,proposal:proposed,agenda:transition.agenda,facts:typed};
 };
 const input=makeInput(stored,'native-area',interpretation,proposal,facts);
 const clarification=makeInput(stored,'native-clarification','O dono pede esclarecimento sobre o escopo da pergunta.',{kind:'clarification',itemId:first.id,questionPt:'Pode explicar melhor quais informações preciso dar?'});
 await runSql(`begin;set local request.jwt.claim.role='service_role';select public.commit_website_interview_native_turn(${q(owner)},${q(call)},${q(request)},${clarification.expectedRevision},${clarification.expectedStoreVersion},${q(clarification.expectedDigest)},${q(clarification.providerItemId)},${q(clarification.interpretation)},${jq(clarification.proposal)},${jq(clarification.agenda)},'[]');rollback;`);
 assert.equal((await store.readWebsiteInterview(scope)).agenda.items[0].questionPt,first.questionPt);
 tests.push('clarification-paraphrase-does-not-change-the-immutable-stored-question');
 // Deliberately no recordOwnerTranscript call before this actual SQL commit.
 await assert.rejects(()=>store.commitNativeOwnerTurn(input),/synthetic result lost/);
 stored=await store.readWebsiteInterview(scope);assert.equal(stored.revision,initial.revision+1);assert.equal(stored.agenda.items.length,initial.agenda.items.length);
 for(const id of [first.id,...related])assert.equal(stored.agenda.items.find(i=>i.id===id).status,'answered');
 assert.deepEqual(stored.agenda.ownerTurns.at(-1),{turnId:`${call}:native-area`,text:interpretation,provenance:'model_interpretation'});
 const row=async item=>JSON.parse(await runSql(`select jsonb_build_object('ownerText',owner_text,'interpretationText',interpretation_text) from website_interview_owner_turns where call_id=${q(call)} and provider_item_id=${q(item)};`));
 assert.deepEqual(await row('native-area'),{ownerText:null,interpretationText:interpretation});
 const batch=JSON.parse(await runSql(`select jsonb_build_object('ownerText',owner_text,'interpretationText',interpretation_text,'facts',facts) from website_interview_fact_batches where call_id=${q(call)} and provider_item_id='native-area';`));
 assert.deepEqual(batch,{ownerText:null,interpretationText:interpretation,facts});assert.equal(calls.includes('record_website_interview_owner_turn'),false);
 tests.push('native-content-and-typed-facts-commit-before-asr-with-explicit-provenance');
 const replay=await store.replayNativeOwnerTurn({...scope,providerItemId:input.providerItemId,proposal,interpretation,facts});
 assert.equal(replay.replayed,true);assert.equal(replay.operationReceiptId,stored.receiptId);assert.equal(replay.operationRevision,stored.revision);
 assert.deepEqual((await store.commitNativeOwnerTurn(input)).agenda,stored.agenda);
 await assert.rejects(()=>store.replayNativeOwnerTurn({...scope,providerItemId:input.providerItemId,proposal,interpretation:interpretation+' Outra regra.',facts}),/replay_conflict/);
 await assert.rejects(()=>store.replayNativeOwnerTurn({...scope,providerItemId:input.providerItemId,proposal:{...proposal,relatedItemIds:[]},interpretation,facts}),/replay_conflict/);
 tests.push('lost-result-new-tool-call-replay-preserves-original-operation-receipt');
 const beforeInvalid=stored;
 await assert.rejects(()=>rpc('commit_website_interview_native_turn',{p_owner:owner,p_call:call,p_request:request,p_revision:stored.revision,p_store_version:stored.storeVersion,p_digest:stored.digest,p_item:'native-empty',p_interpretation:'',p_proposal:proposal,p_agenda:stored.agenda,p_facts:[]}),/content_invalid/);
 await assert.rejects(()=>store.commitNativeOwnerTurn({...input,ownerId:other}),/owner_bound/);
 await assert.rejects(()=>store.commitNativeOwnerTurn({...input,requestId:other}),/owner_bound/);
 assert.deepEqual((await store.readWebsiteInterview(scope)).agenda,beforeInvalid.agenda);
 assert.equal(await runSql(`select count(*) from website_interview_owner_turns where call_id=${q(call)} and provider_item_id='native-empty';`),'0');
 tests.push('empty-content-and-wrong-owner-request-have-no-effect');
 // Another owner input advances the current question before the first ASR.
 const next=getAgendaAction(stored.agenda).itemId;assert.ok(next);
 const second=makeInput(stored,'native-open-answer','O atendimento usa o fuso local informado pelo dono, sujeito à revisão final.',{kind:'answer',itemId:next});
 stored=await store.commitNativeOwnerTurn(second);const beforeASR=stored;
 const late='Hum, olha, atendi só novato, San Rafael e Petaluma. Se pintar algo fora, só com aprovação explícita do dono.';
 await store.recordOwnerTranscript({...scope,providerItemId:'native-open-answer',text:'Usa o fuso local, combinado?'});
 await store.recordOwnerTranscript({...scope,providerItemId:'native-area',text:late});
 assert.equal((await store.recordOwnerTranscript({...scope,providerItemId:'native-area',text:late})).replayed,true);
 await assert.rejects(()=>store.recordOwnerTranscript({...scope,providerItemId:'native-area',text:'Conflicting final ASR'}),/transcript_conflict/);
 assert.deepEqual(await row('native-area'),{ownerText:late,interpretationText:interpretation});
 const afterASR=await store.readWebsiteInterview(scope);
 const {operationReceiptId:ignoredOperationReceipt,operationRevision:ignoredOperationRevision,...beforeASRSnapshot}=beforeASR;
 assert.deepEqual(afterASR,beforeASRSnapshot);
 const replayAfter=await store.replayNativeOwnerTurn({...scope,providerItemId:input.providerItemId,proposal,interpretation,facts});
 assert.equal(replayAfter.operationReceiptId,replay.operationReceiptId);assert.equal(replayAfter.operationRevision,1);assert.equal(replayAfter.revision,2);
 tests.push('late-duplicate-out-of-order-asr-appends-only-without-business-revision');
 const correction=makeInput(stored,'native-correction','A exceção continua dependendo de aprovação explícita e não é autorização automática.',{kind:'correction',affectedItems:[{itemId:first.id,disposition:'corrected'}]});
 stored=await store.commitNativeOwnerTurn(correction);assert.equal(stored.revision,3);assert.equal(stored.agenda.items.find(i=>i.id===first.id).status,'corrected');
 assert.equal((await row('native-correction')).ownerText,null);tests.push('new-owner-turn-correction-has-new-revision-and-absent-asr');
 // ASR-first remains literal in owner_text, while the separate model content is
 // stored once and used with an explicit interpretation label for native edits.
 const current=getAgendaAction(stored.agenda).itemId;
 if(current){await store.recordOwnerTranscript({...scope,providerItemId:'native-asr-first',text:'Pode deixar esse ponto para eu revisar depois.'});
  stored=await store.commitNativeOwnerTurn(makeInput(stored,'native-asr-first','Ponto adiado explicitamente para revisão do dono.',{kind:'defer',itemId:current}));
  assert.deepEqual(await row('native-asr-first'),{ownerText:'Pode deixar esse ponto para eu revisar depois.',interpretationText:'Ponto adiado explicitamente para revisão do dono.'});tests.push('asr-first-and-interpretation-remain-distinct');}
 // Exercise the original complete queue without shortening the faithful fixture.
 let n=0;while(getAgendaAction(stored.agenda).itemId){const itemId=getAgendaAction(stored.agenda).itemId;
  stored=await store.commitNativeOwnerTurn(makeInput(stored,`native-defer-${++n}`,'Este ponto fica explicitamente pendente para revisão do dono.',{kind:'defer',itemId}));}
 assert.equal(stored.state,'reviewing');assert.equal(await runSql(`select count(*) from website_interview_speech where call_id=${q(call)};`),'0');
 tests.push('entire-original-queue-preserved-with-no-ordinary-speech-receipts');
 const checkpointInput={...scope,checkpointId:randomUUID(),kind:'review',expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest,expectedReceiptId:stored.receiptId,
  responseId:'native-review-response',itemId:'native-review-item',transcript:'Atendemos as três cidades informadas; qualquer exceção depende do dono. Os outros pontos continuam explicitamente pendentes. Você confirma esse resumo?',
  bufferStoppedEventId:'native-review-buffer',mediaEvidence:{schema:'onboarding.stream.media.v1',nonzeroSamples:100,observedMs:600,firstSampleAtMs:100,lastSampleAtMs:700,unmuted:true,playbackStarted:true}};
 const summary=await evidence.recordNativeCheckpoint(checkpointInput);stored=await store.readWebsiteInterview(scope);
 const approveArgs={...scope,summaryId:summary.summaryId,summaryHash:summary.summaryHash,providerItemId:'native-approval',expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest};
 // Fixture-only insertion represents a model interpretation without final ASR;
 // the approval RPC must never mistake it for explicit transcript evidence.
 await runSql(`insert into website_interview_owner_turns(call_id,provider_item_id,tenant_id,owner_text,interpretation_text) values(${q(call)},'native-approval',${q(tenant)},null,'O modelo acredita que o dono aprovou.');`);
 await assert.rejects(()=>evidence.approveSummary(approveArgs),/not_strict_affirmation/);
 await store.recordOwnerTranscript({...scope,providerItemId:'native-mixed',text:'Sim, mas altere a área.'});
 await assert.rejects(()=>evidence.approveSummary({...approveArgs,providerItemId:'native-mixed'}),/not_strict_affirmation/);
 await store.recordOwnerTranscript({...scope,providerItemId:'native-approval',text:'Eu aprovo esta configuração.'});
 const approval=await evidence.approveSummary(approveArgs);stored=await store.readWebsiteInterview(scope);
 assert.equal(stored.state,'closing');tests.push('actual-native-recap-approval-still-requires-fresh-literal-asr');
 // Keep amendment in a rollback transaction so the same isolated call can also
 // exercise its successful actual-signoff/completion branch below.
 await runSql(`begin;set local request.jwt.claim.role='service_role';do $amend$ declare r jsonb;before_snapshot jsonb;child_call uuid:=gen_random_uuid();child_request uuid:=gen_random_uuid();begin
  select finalized_draft into before_snapshot from website_interview_approvals where call_id=${q(call)};
  r:=public.request_website_interview_native_amendment(${q(owner)},${q(call)},${q(request)},${q(approval.approvalReceiptId)},'native-closing-correction',${jq({kind:'correction',affectedItems:[{itemId:first.id,disposition:'reopen'}]})},'Corrigir a área antes de finalizar.');
  if r->>'provenance'<>'model_interpretation' or (select owner_text from website_interview_owner_turns where call_id=${q(call)} and provider_item_id='native-closing-correction') is not null then raise exception 'native_amendment_fake_asr';end if;
  if (select finalized_draft from website_interview_approvals where call_id=${q(call)}) is distinct from before_snapshot then raise exception 'native_amendment_changed_approval';end if;
  update calls set status='ended',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='native_amendment_probe',provider_usage_state='resolved',cost_estimate_usd=0.025 where id=${q(call)};
  update budget_reservations set status='settled',outcome='ended',final_cost_usd=0.025,final_minutes=1,settled_at=clock_timestamp() where call_id=${q(call)};
  insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation,started_at,provider_usage_state)
   values(child_call,${q(tenant)},'browser','onboarding','active',2,clock_timestamp(),'not_applicable');
  insert into browser_session_requests(id,tenant_id,user_id,session_type,test_memory_generation,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version)
   values(child_request,${q(tenant)},${q(owner)},'onboarding',2,'native-amendment-resume','processing',child_call,'realtime_native_v1',5);
  r:=public.attach_website_interview(${q(owner)},child_call,child_request,${q(stored.agenda.binding.interviewId)},${q(call)});
  if r->'agenda'->'ownerTurns'->-1 is distinct from ${jq({turnId:call+':native-closing-correction',text:'Corrigir a área antes de finalizar.',provenance:'model_interpretation'})} then raise exception 'native_amendment_resume_lost_provenance';end if;
 end $amend$;rollback;`);
 tests.push('closing-amendment-before-asr-preserves-approved-snapshot');
 await evidence.recordNativeCheckpoint({...checkpointInput,checkpointId:randomUUID(),kind:'signoff',expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest,expectedReceiptId:stored.receiptId,
  approvalReceiptId:approval.approvalReceiptId,responseId:'native-signoff-response',itemId:'native-signoff-item',transcript:'Obrigado. Sua configuração foi salva e os pontos pendentes continuam para sua revisão. Até logo.',bufferStoppedEventId:'native-signoff-buffer'});
 await assert.rejects(()=>evidence.recordCompletion({...scope,outcome:'complete',approvalReceiptId:approval.approvalReceiptId}),/terminal_proof_pending/);
 assert.equal(await runSql(`select count(*) from rules where tenant_id=${q(tenant)};`),'0');assert.equal(await runSql(`select count(*) from powers where tenant_id=${q(tenant)};`),'0');
 tests.push('native-signoff-retains-audited-terminal-and-no-operational-authority');
 return{tests:tests.length,scenarios:tests,agendaItems:stored.agenda.items.length,candidateFacts:stored.agenda.candidateContext.length,providerCalls:0,callId:call,approvalReceiptId:approval.approvalReceiptId,
  firstOperationReceiptId:replay.operationReceiptId,firstOperationRevision:1,finalRevision:stored.revision,provenance:'model_interpretation',actualASRAttachedWithoutBusinessRevision:true};
}
