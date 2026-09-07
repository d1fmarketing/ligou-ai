import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {applyVerifiedOwnerTurn} from '../../voice-controller/src/onboarding-agenda.ts';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export async function runWebsiteInterruptionAndAmendmentCases({sql,json,fail,quote,id,owner,other,tenant,call,request,stored,parallelSql}) {
  const regressionFailures=[];
  const checkRegression=(name,work)=>{try{work();}catch(error){regressionFailures.push({name,error:error.message});}};
  let scope=`'${owner}','${call}','${request}'`;
  const esc=text=>`'${text.replaceAll("'","''")}'`;
  const act=(kind,text,key)=>({actionId:hash([key,kind,text,stored.digest]),interviewId:stored.agenda.binding.interviewId,callId:call,revision:stored.revision,kind,text,sourceDigest:stored.digest});
  const payload=a=>({schema:'onboarding.speech.v1',...a,text_sha256:hash(a.text),audio_base64:'SUQzBA==',audio_sha256:hash(Buffer.from('SUQzBA==','base64').toString('binary')),mime:'audio/mpeg',voice:'ash',tts_model:'tts-1-hd',cost_usd:Number(([...a.text].length*30/1000000).toFixed(8))});
  const claim=(a,s=null,p=null)=>json(`public.claim_website_interview_speech(${scope},${quote(a)},${s?esc(s):'null'},${p??'null'},null)`);
  const ready=a=>json(`public.complete_website_interview_speech(${scope},${esc(a.actionId)},${quote(payload(a))})`);
  const ackSql=a=>`select public.record_website_interview_speech_played(${scope},${esc(a.actionId)},'lgs-${a.actionId.slice(0,28)}',${esc(a.text)},${esc(payload(a).text_sha256)},${esc(payload(a).audio_sha256)});`;
  const played=a=>JSON.parse(sql(ackSql(a)));
  const turn=(item,text)=>json(`public.record_website_interview_owner_turn(${scope},${esc(item)},${esc(text)})`);
  const interrupt=(a,item)=>json(`public.interrupt_website_interview_speech(${scope},${esc(a.actionId)},${esc(item)})`);
  const resume=(a,item)=>json(`public.resume_website_interview_speech(${scope},${esc(a.actionId)},${esc(item)})`);
  const commit=(itemId,key,kind='answer')=>{
    const t=turn(key,`Resposta autorizada para ${itemId}.`),proposal={kind,itemId};
    const result=applyVerifiedOwnerTurn(stored.agenda,{type:'verified_owner_turn',binding:stored.agenda.binding,turnId:t.turnId,text:t.text,proposal});
    assert.equal(result.accepted,true);
    stored=json(`public.commit_website_interview_turn(${scope},${stored.revision},${stored.storeVersion},${esc(stored.digest)},${esc(key)},${quote(result.agenda)},${esc(kind)},'[]'::jsonb)`);
    return stored;
  };
  for(const name of ['interrupt_website_interview_speech','resume_website_interview_speech','record_website_interview_empty_input']) {
    assert.equal(sql(`select has_function_privilege('service_role','public.${name}(uuid,uuid,uuid,text,text)','EXECUTE');`),'t');
    assert.equal(sql(`select has_function_privilege('authenticated','public.${name}(uuid,uuid,uuid,text,text)','EXECUTE');`),'f');
  }
  let a=act(stored.nextAction.type,stored.nextAction.spokenPt,'first');claim(a);ready(a);
  fail(`select public.interrupt_website_interview_speech('${other}','${call}','${request}','${a.actionId}','foreign');`,'interview_call_not_owner_bound');
  const first=interrupt(a,'barge-1');assert.equal(first.status,'superseded');
  assert.equal(interrupt(a,'barge-1').replayed,true);
  fail(`select public.interrupt_website_interview_speech(${scope},'${a.actionId}','different');`,'interview_interruption_conflict');
  fail(ackSql(a),'interview_speech_not_ready');
  fail(`select public.resume_website_interview_speech(${scope},'${a.actionId}','barge-1');`,'interview_interruption_owner_turn_pending');
  turn('barge-1','Ah, entendi.');
  fail(`select public.record_website_interview_empty_input(${scope},'${a.actionId}','barge-1');`,'interview_empty_input_conflicts_with_owner_turn');
  let resumed=resume(a,'barge-1');assert.equal(resumed.status,'ready');assert.equal(resumed.claimed,false);assert.equal(resumed.payload.audio_base64,payload(a).audio_base64);
  assert.notEqual(resumed.action.actionId,a.actionId);assert.equal(resumed.action.text,a.text);assert.equal(resumed.rendition,1);
  assert.equal(resume(a,'barge-1').action.actionId,resumed.action.actionId);
  fail(ackSql(a),'interview_speech_not_ready');
  a=resumed.action;interrupt(a,'barge-2');
  const empty=(action,item)=>json(`public.record_website_interview_empty_input(${scope},${esc(action.actionId)},${esc(item)})`);
  fail(`select public.record_website_interview_empty_input(${scope},'${a.actionId}','wrong-item');`,'interview_empty_input_not_current');
  fail(`select public.record_website_interview_empty_input(${scope},'${'f'.repeat(64)}','barge-2');`,'interview_empty_input_not_current');
  fail(`select public.record_website_interview_empty_input('${owner}','${call}','${id(898)}','${a.actionId}','barge-2');`,'interview_call_not_owner_bound');
  fail(`select public.record_website_interview_empty_input('${owner}','${id(899)}','${request}','${a.actionId}','barge-2');`,'interview_call_not_owner_bound');
  const emptyProof=empty(a,'barge-2');assert.equal(emptyProof.actionId,a.actionId);assert.equal(emptyProof.providerItemId,'barge-2');assert.equal(empty(a,'barge-2').replayed,true);
  assert.equal(sql(`select count(*) from website_interview_owner_turns where call_id='${call}' and provider_item_id='barge-2';`),'0');
  assert.equal(json(`public.read_website_interview(${scope})`).revision,stored.revision);
  assert.equal(sql('select count(*) from website_interview_approvals;'),'0');
  resumed=resume(a,'barge-2');assert.equal(resumed.rendition,2);fail(ackSql(a),'interview_speech_not_ready');
  a=resumed.action;interrupt(a,'barge-3');empty(a,'barge-3');
  fail(`select public.resume_website_interview_speech(${scope},'${a.actionId}','barge-3');`,'interview_speech_resume_exhausted');
  assert.equal(sql(`select count(*) from website_interview_speech where call_id='${call}' and status='played';`),'0');
  fail('update website_interview_speech_interruptions set provider_item_id=provider_item_id;','append_only');
  commit('area','answer-area');
  a=act(stored.nextAction.type,stored.nextAction.spokenPt,'preparing');claim(a);interrupt(a,'preparing-barge');turn('preparing-barge','Pode continuar.');
  resumed=resume(a,'preparing-barge');assert.equal(resumed.status,'preparing');assert.equal(resumed.claimed,true);assert.equal(resume(a,'preparing-barge').claimed,false);
  fail(`select public.complete_website_interview_speech(${scope},'${a.actionId}',${quote(payload(a))});`,'interview_speech_claim_not_preparing');
  ready(resumed.action);played(resumed.action);
  fail(`select public.interrupt_website_interview_speech(${scope},'${resumed.action.actionId}','too-late');`,'interview_speech_not_interruptible');
  commit('exception','answer-exception');commit('schedule','answer-schedule');
  assert.equal(stored.state,'reviewing');
  const approveFlow=async(key,interruptSummary=false)=>{
    const summary=id(key),parts=['As informações persistidas foram revisadas.'];
    const proof=json(`public.prepare_website_interview_summary(${scope},'${summary}',${stored.revision},${stored.storeVersion},'${stored.digest}','${stored.receiptId}',${quote(parts)})`);
    if(interruptSummary){
      const {runWebsiteInterruptionActualSchemaProbe}=await import('./website-interview-interruption-actual-schema.mjs');
      const probe=await runWebsiteInterruptionActualSchemaProbe({runSql:async statement=>sql(statement),owner,call,request,summaryId:summary,parts,revision:stored.revision,digest:stored.digest,interviewId:stored.agenda.binding.interviewId});
      assert.equal(probe.rolledBack,true);
    }
    let part=act('GENERATE_FINAL_SUMMARY',parts[0],`summary-${key}`);claim(part,summary,0);ready(part);
    if(interruptSummary){interrupt(part,'summary-barge');turn('summary-barge','Ah, entendi.');const r=resume(part,'summary-barge');fail(ackSql(part),'interview_speech_not_ready');part=r.action;}
    played(part);
    const ask=act('REQUEST_FINAL_APPROVAL','Está tudo correto no resumo e você confirma essas informações? Se precisar, diga o que devo corrigir.',`approval-${key}`);
    claim(ask,summary,parts.length);ready(ask);played(ask);turn(`approve-${key}`,'Sim, aprovo.');
    return json(`public.approve_website_interview_summary(${scope},'${summary}','${proof.summaryHash}','approve-${key}',${stored.revision},${stored.storeVersion},'${stored.digest}')`);
  };
  const approval=await approveFlow(300,true),originalAgenda=json(`(select agenda from website_interviews where interview_id='${call}')`),originalApproval=json(`(select finalized_draft from website_interview_approvals where interview_id='${call}')`);
  turn('late-correction','Preciso corrigir a área de atendimento e o telefone publicado.');
  const proposal={kind:'correction',affectedItems:[{itemId:'area',disposition:'reopen'}],affectedCandidates:[{candidateId:stored.agenda.candidateContext[1].id,disposition:'reopen'}]};
  const amendment=(p=proposal,item='late-correction')=>`public.request_website_interview_amendment(${scope},'${approval.approvalReceiptId}',${esc(item)},${quote(p)})`;
  fail(`select ${amendment({...proposal,affectedItems:[{itemId:'foreign',disposition:'reopen'}]})};`,'interview_amendment_target_not_current');
  fail(`select ${amendment({...proposal,activate:true})};`,'interview_amendment_proposal_invalid');
  fail(`select ${amendment(proposal,'approve-300')};`,'interview_amendment_owner_turn_missing');
  const amendmentProof=json(amendment());assert.equal(amendmentProof.state,'pending_amendment');assert.equal(json(amendment()).replayed,true);
  const pendingStatus=JSON.parse(sql(`set role authenticated;set request.jwt.claim.sub='${owner}';select public.get_website_interview_status('${call}');`));
  assert.equal(pendingStatus.amendmentPending,true);assert.equal(pendingStatus.approvalReceiptId,approval.approvalReceiptId);
  const pendingSetup=JSON.parse(sql(`set role authenticated;set request.jwt.claim.sub='${owner}';select public.company_discovery_setup_status();`));
  assert.equal(pendingSetup.state,'onboarding_amendment_pending');assert.equal(pendingSetup.amendment_can_resume,false);assert.equal(pendingSetup.voice_approval_receipt_id,approval.approvalReceiptId);
  const amendmentSignoff=act('SPEAK_AMENDMENT_SIGNOFF','Registrei seu pedido de correção. A versão aprovada continua guardada. Para revisar a alteração, inicie uma nova conversa pelo painel. Obrigado e até logo.','amendment-signoff');
  claim(amendmentSignoff);ready(amendmentSignoff);played(amendmentSignoff);
  fail(`select public.record_website_interview_completion(${scope},'complete','${approval.approvalReceiptId}');`,'interview_amendment_pending');
  assert.deepEqual(json(`(select agenda from website_interviews where interview_id='${call}')`),originalAgenda);
  assert.deepEqual(json(`(select finalized_draft from website_interview_approvals where interview_id='${call}')`),originalApproval);
  fail(`update website_interviews set agenda=jsonb_set(agenda,'{revision}','99') where interview_id='${call}';`,'interview_already_approved');
  const parentCall=call,parentRequest=request;
  sql(`update calls set status='ended',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='fixture_only' where id='${call}';insert into budget_reservations values('${id(350)}','${tenant}','${call}','settled');`);
  json(`public.record_website_interview_completion(${scope},'unfinished','${approval.approvalReceiptId}')`);
  assert.equal(JSON.parse(sql(`set role authenticated;set request.jwt.claim.sub='${owner}';select public.company_discovery_setup_status();`)).amendment_can_resume,true);
  const readCapabilities=mutation=>JSON.parse(sql(`begin;${mutation}set local role authenticated;set local request.jwt.claim.sub='${owner}';select jsonb_build_object('voice',public.get_website_interview_status('${call}'),'setup',public.company_discovery_setup_status());rollback;`));
  checkRegression('fresh settled amendment advertises only its amendment path',()=>{
    const value=readCapabilities('');assert.equal(value.voice.resumeEligible,false);assert.equal(value.voice.amendmentCanResume,true);assert.equal(value.setup.amendment_can_resume,true);
  });
  const pendingPrep=`insert into website_interview_preparations select (jsonb_populate_record(null::website_interview_preparations,to_jsonb(p)||jsonb_build_object('id','${id(370)}','consumed_call_id',null,'consumed_at',null,'created_at',clock_timestamp()))).* from website_interview_preparations p where consumed_call_id='${call}';`;
  const staleDraft=`insert into company_discovery_onboarding_drafts select (jsonb_populate_record(null::company_discovery_onboarding_drafts,to_jsonb(d)||jsonb_build_object('id','${id(371)}','version',version+1))).* from company_discovery_onboarding_drafts d where tenant_id='${tenant}';`;
  const competingCall=`insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation) values('${id(372)}','${tenant}','browser','onboarding','active',2);`;
  for(const [name,mutation] of [['newer selected draft',staleDraft],['unconsumed preparation',pendingPrep],['competing active call',competingCall]])checkRegression(`resume flags reject ${name}`,()=>{
    const value=readCapabilities(mutation);assert.equal(value.voice.resumeEligible,false);assert.equal(value.voice.amendmentCanResume,false);assert.equal(value.setup.amendment_can_resume,false);
  });
  const newerPrep=id(380),newerCall=id(381),newerRequest=id(382),newerBinding={...originalAgenda.binding,interviewId:newerCall,callId:newerCall};
  const newerAgenda={...originalAgenda,binding:newerBinding,revision:0,ownerTurns:[],candidateOverrides:[],items:originalAgenda.items.map(x=>({...x,status:'open',answerRevision:0,clarificationCount:0,evidence:[]}))};
  const newerLineage=`do $lineage$ begin
    perform public.prepare_fresh_website_interview('${newerPrep}','${owner}','${tenant}',2,'${call}','${newerBinding.draftId}','${newerBinding.draftHash}','${newerBinding.sourceResultId}','${newerBinding.sourceResultHash}');
    insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation) values('${newerCall}','${tenant}','browser','onboarding','active',2);
    insert into browser_session_requests values('${newerRequest}','${tenant}','${newerCall}','${owner}','onboarding',2,3,'application_tts_v1','processing');
    perform public.initialize_website_interview('${owner}','${newerCall}','${newerRequest}','${newerPrep}',${quote(newerAgenda)});
    update calls set status='error',ended_at=clock_timestamp(),provider_termination_state='not_required',provider_usage_state='not_applicable' where id='${newerCall}';
  end $lineage$;`;
  checkRegression('older interview cannot advertise resume after a newer initialized lineage',()=>{const value=readCapabilities(newerLineage);assert.equal(value.voice.resumeEligible,false);assert.equal(value.voice.amendmentCanResume,false);assert.equal(value.setup.amendment_pending,false);});
  assert.equal(sql("select has_function_privilege('authenticated','public.website_interview_resume_eligible(uuid,uuid,boolean)','EXECUTE');"),'f');
  assert.equal(sql("select has_function_privilege('service_role','public.website_interview_resume_eligible(uuid,uuid,boolean)','EXECUTE');"),'f');
  call=id(400);request=id(401);scope=`'${owner}','${call}','${request}'`;
  sql(`insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation) values('${call}','${tenant}','browser','onboarding','active',2);insert into browser_session_requests values('${request}','${tenant}','${call}','${owner}','onboarding',2,3,'application_tts_v1','processing');`);
  const source=json(`public.resolve_prepared_website_source(${scope})`);assert.equal(source.resume.interviewId,parentCall);
  stored=json(`public.attach_website_interview(${scope},'${parentCall}','${parentCall}')`);
  assert.equal(stored.agenda.binding.interviewId,call);assert.equal(stored.nextAction.itemId,'area');
  assert.deepEqual(stored.agenda.items.map(x=>x.status),['open','answered','answered']);
  assert.equal(stored.agenda.candidateOverrides.length,1);assert.equal(stored.agenda.candidateOverrides[0].status,'open');
  assert.equal(stored.agenda.items[0].evidence.at(-1).text,'Preciso corrigir a área de atendimento e o telefone publicado.');
  assert.equal(json(`public.attach_website_interview(${scope},'${parentCall}','${parentCall}')`).replayed,true);
  assert.deepEqual(json(`(select finalized_draft from website_interview_approvals where interview_id='${parentCall}')`),originalApproval);
  assert.equal(sql(`select count(*) from website_interview_approvals where interview_id='${call}';`),'0');
  const storeModule=await import('../../voice-controller/src/onboarding-agenda-store.ts');
  const proofStore=storeModule.createOnboardingAgendaStore({rpc:async()=>({data:stored,error:null})});
  assert.equal((await proofStore.readWebsiteInterview({ownerId:owner,callId:call,requestId:request})).nextAction.itemId,'area');
  const settledChild=`update calls set status='error',ended_at=clock_timestamp(),provider_termination_state='confirmed' where id='${call}';insert into budget_reservations values('${id(450)}','${tenant}','${call}','settled');`;
  checkRegression('fresh settled unfinished child can resume',()=>{const value=readCapabilities(settledChild);assert.equal(value.voice.resumeEligible,true);assert.equal(value.voice.amendmentCanResume,false);});
  checkRegression('stale source blocks ordinary unfinished resume',()=>{const value=readCapabilities(settledChild+staleDraft);assert.equal(value.voice.resumeEligible,false);});
  checkRegression('pending preparation blocks ordinary unfinished resume',()=>{const value=readCapabilities(settledChild+pendingPrep);assert.equal(value.voice.resumeEligible,false);});
  commit('area','amended-area');commit(stored.agenda.candidateOverrides[0].id,'amended-phone');
  const childApproval=await approveFlow(500),childFinal=json(`(select finalized_draft from website_interview_approvals where interview_id='${call}')`);
  assert.equal(childFinal.amendsApprovalReceiptId,approval.approvalReceiptId);
  for(const receipt of originalApproval.factBatchReceiptIds)assert.ok(childFinal.factBatchReceiptIds.includes(receipt));
  assert.equal(sql('select count(*) from rules;'),'0');assert.equal(sql('select count(*) from powers;'),'0');
  // A genuinely empty tenant gets a preparation without a fake call or budget.
  const initialTenant=id(600),initialDraft=id(601),initialJob=id(602),initialResult=id(603),initialAttempt=id(604),initialPrep=id(605);
  sql(`insert into tenants select (jsonb_populate_record(null::tenants,to_jsonb(t)||jsonb_build_object('id','${initialTenant}','owner_user_id','${other}','slug','first-attempt-fixture'))).* from tenants t where id='${tenant}';
    insert into worker_jobs select (jsonb_populate_record(null::worker_jobs,to_jsonb(j)||jsonb_build_object('id','${initialJob}','tenant_id','${initialTenant}','selected_attempt_id','${initialAttempt}'))).* from worker_jobs j limit 1;
    insert into worker_results select (jsonb_populate_record(null::worker_results,to_jsonb(r)||jsonb_build_object('id','${initialResult}','tenant_id','${initialTenant}','job_id','${initialJob}','attempt_id','${initialAttempt}'))).* from worker_results r limit 1;
    insert into company_discovery_onboarding_drafts select (jsonb_populate_record(null::company_discovery_onboarding_drafts,to_jsonb(d)||jsonb_build_object('id','${initialDraft}','tenant_id','${initialTenant}','source_job_id','${initialJob}','source_result_id','${initialResult}','created_by','${other}'))).* from company_discovery_onboarding_drafts d limit 1;`);
  const prepareInitial=`public.prepare_initial_website_interview('${initialPrep}','${other}','${initialTenant}',2,'${initialDraft}','${'a'.repeat(64)}','${initialResult}','${'b'.repeat(64)}')`;
  assert.equal(json(prepareInitial).consumedCallId,null);assert.equal(json(prepareInitial).replayed,true);
  assert.equal(sql(`select count(*) from calls where tenant_id='${initialTenant}';`),'0');
  assert.equal(sql(`select prior_call_id is null from website_interview_preparations where id='${initialPrep}';`),'t');
  const initialCall=id(610),initialRequest=id(611),initialScope=`'${other}','${initialCall}','${initialRequest}'`;
  sql(`insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation) values('${initialCall}','${initialTenant}','browser','onboarding','active',2);insert into browser_session_requests values('${initialRequest}','${initialTenant}','${initialCall}','${other}','onboarding',2,3,'application_tts_v1','processing');`);
  fail(`select ${prepareInitial};`,'interview_initial_history_exists');
  const fresh={...originalAgenda,binding:{...originalAgenda.binding,interviewId:initialCall,callId:initialCall,draftId:initialDraft,sourceResultId:initialResult},revision:0,ownerTurns:[],candidateOverrides:[],items:originalAgenda.items.map(x=>({...x,status:'open',answerRevision:0,clarificationCount:0,evidence:[]}))};
  const retryCall=id(612),retryRequest=id(613),retryScope=`'${other}','${retryCall}','${retryRequest}'`;
  const retryAgenda={...fresh,binding:{...fresh.binding,interviewId:retryCall,callId:retryCall}};
  const safeFailure=status=>`update calls set status='${status}',ended_at=clock_timestamp(),provider_termination_state='not_required',provider_usage_state='not_applicable',openai_call_id=null,cost_estimate_usd=0 where id='${initialCall}';update browser_session_requests set status='error' where id='${initialRequest}';`;
  const nextCall=`insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation,provider_termination_state,provider_usage_state) values('${retryCall}','${initialTenant}','browser','onboarding','active',2,'not_required','not_applicable');insert into browser_session_requests values('${retryRequest}','${initialTenant}','${retryCall}','${other}','onboarding',2,3,'application_tts_v1','processing');`;
  for(const status of ['error','killed_budget'])checkRegression(`same initial preparation survives no-provider ${status}`,()=>{
    const result=JSON.parse(sql(`begin;${safeFailure(status)}${nextCall}select public.initialize_website_interview(${retryScope},'${initialPrep}',${quote(retryAgenda)});rollback;`));
    assert.equal(result.agenda.binding.callId,retryCall);
  });
  checkRegression('same initial preparation survives a settled no-provider reservation',()=>{
    const result=JSON.parse(sql(`begin;${safeFailure('error')}insert into budget_reservations values('${id(614)}','${initialTenant}','${initialCall}','settled');${nextCall}select public.initialize_website_interview(${retryScope},'${initialPrep}',${quote(retryAgenda)});rollback;`));assert.equal(result.agenda.binding.callId,retryCall);
  });
  checkRegression('same initial preparation preserves multiple safe failed attempts',()=>{
    const thirdCall=id(615),thirdRequest=id(616),thirdAgenda={...retryAgenda,binding:{...retryAgenda.binding,interviewId:thirdCall,callId:thirdCall}};
    const result=JSON.parse(sql(`begin;${safeFailure('error')}${nextCall}
      update calls set status='killed_budget',ended_at=clock_timestamp(),provider_termination_state='not_required',provider_usage_state='not_applicable',cost_estimate_usd=0 where id='${retryCall}';update browser_session_requests set status='error' where id='${retryRequest}';
      insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation) values('${thirdCall}','${initialTenant}','browser','onboarding','active',2);insert into browser_session_requests values('${thirdRequest}','${initialTenant}','${thirdCall}','${other}','onboarding',2,3,'application_tts_v1','processing');
      select public.initialize_website_interview('${other}','${thirdCall}','${thirdRequest}','${initialPrep}',${quote(thirdAgenda)});rollback;`));assert.equal(result.agenda.binding.callId,thirdCall);
  });
  checkRegression('same initial preparation can be read again after a safe failed attempt',()=>{
    const result=JSON.parse(sql(`begin;${safeFailure('killed_budget')}select ${prepareInitial};rollback;`));assert.equal(result.replayed,true);assert.equal(result.preparationId,initialPrep);
  });
  for(const [name,unsafe] of [
    ['unknown provider',`update calls set provider_termination_state='unknown' where id='${initialCall}';`],
    ['accepted provider identity',`update calls set openai_call_id='rtc-unproven' where id='${initialCall}';`],
    ['unknown usage',`update calls set provider_usage_state='unknown' where id='${initialCall}';`],
    ['missing usage proof',`update calls set provider_usage_state=null where id='${initialCall}';`],
    ['resolved usage without a cost proof',`update calls set provider_usage_state='resolved',cost_estimate_usd=null where id='${initialCall}';`],
    ['missing no-provider proof',`update calls set provider_termination_state=null where id='${initialCall}';`],
    ['unsettled reservation',`insert into budget_reservations values('${id(614)}','${initialTenant}','${initialCall}','active');`],
    ['owner transcript',`update calls set transcript='[{"role":"caller","text":"saved owner answer"}]' where id='${initialCall}';`],
    ['ready answer SDP',`update browser_session_requests set answer_sdp='accepted-sdp' where id='${initialRequest}';`],
    ['owner progress receipt',`insert into receipts(id,tenant_id,call_id,kind,outcome,external_id) values('${id(617)}','${initialTenant}','${initialCall}','website_interview','accepted','partial-owner-progress');`],
    ['foreign owner request',`update browser_session_requests set user_id='${owner}' where id='${initialRequest}';`],
  ])checkRegression(`initial retry refuses ${name}`,()=>fail(`begin;${safeFailure('error')}${unsafe}${nextCall}select public.initialize_website_interview(${retryScope},'${initialPrep}',${quote(retryAgenda)});`,'interview_prior_not_settled'));
  assert.equal(json(`public.initialize_website_interview(${initialScope},'${initialPrep}',${quote(fresh)})`).agenda.binding.callId,initialCall);
  assert.deepEqual(regressionFailures,[],'confirmed initial-retry and truthful-resume regressions');
  console.log(JSON.stringify({status:'passed',suite:'speech interruption, bounded rendition, immutable approval amendment and genuine first preparation',authorityWrites:0,providerCalls:0}));
}
