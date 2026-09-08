import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingAgendaStore} from '../../voice-controller/src/onboarding-agenda-store.ts';
import {applyVerifiedOwnerTurn,getAgendaAction} from '../../voice-controller/src/onboarding-agenda.ts';
const q=x=>`'${String(x).replaceAll("'","''")}'`,jq=x=>`${q(JSON.stringify(x))}::jsonb`;
const recordedSunday='Sim. Confirma contradição. No domingo é somente emergência, não tem reparo comum no mesmo dia. Reparo comum é de segunda a sábado.';

// The original Sunday ASR is reproduced on a new disposable call. Its source
// question comes from the faithful agenda; no production call or row is edited.
export async function runWebsiteRecordedRecoveryProbe({runSql,rpc,owner,other,tenant,priorCall,source,initialAgenda}){
 const call=randomUUID(),request=randomUUID(),preparation=randomUUID(),scope={ownerId:owner,callId:call,requestId:request};
 const store=createOnboardingAgendaStore({rpc:async(name,args)=>({data:await rpc(name,args),error:null})});
 const tests=[];let created=false,reserved=false,settled=false;
 try{
  await store.prepareFreshWebsiteInterview({preparationId:preparation,ownerId:owner,expectedTenantId:tenant,expectedGeneration:2,priorCallId:priorCall,
   draftId:source.draftId,draftHash:source.draftHash,sourceResultId:source.sourceResultId,sourceResultHash:source.sourceResultHash});
  await runSql(`begin;insert into calls(id,tenant_id,channel,session_type,status,model,started_at,openai_call_id,provider_termination_state,provider_termination_mode,provider_usage_state,cost_estimate_usd)
   values(${q(call)},${q(tenant)},'browser','onboarding','active','gpt-realtime-2.1',clock_timestamp(),${q('rtc_recorded_recovery_'+call)},'active','hangup','unknown',0);
   insert into browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version)
   values(${q(request)},${q(tenant)},${q(owner)},'onboarding','recorded-recovery-offer','processing',${q(call)},'realtime_native_v1',5);commit;`);created=true;
  assert.equal(await runSql(`select (select started_at from calls where id=${q(call)})>(select started_at from calls where id=${q(priorCall)});`),'t');
  await rpc('reserve_call_budget',{p_tenant:tenant,p_call:call,p_est_cost:7.5,p_reserved_minutes:55});reserved=true;
  const initial=structuredClone(initialAgenda);initial.binding={...initial.binding,callId:call,interviewId:call};
  assert.equal(initial.items.length,114);assert.equal(initial.candidateContext.length,21);
  let stored=await store.initializeWebsiteInterview({...scope,preparationId:preparation,agenda:initial});
  await runSql(`update browser_session_requests set status='ready',answer_sdp='recorded-recovery-answer',opening_mode_applied='realtime_native_v1',
   opening_payload=${jq({version:5,native:{callId:call,interviewId:call,revision:stored.revision,sourceDigest:stored.digest}})} where id=${q(request)};`);
  const sunday=initial.items.find(item=>item.source==='contradiction'&&item.questionPt.includes('domingo'));
  const price=initial.items.find(item=>item.coverageRefs.some(ref=>ref.endsWith(':service.price_target')));
  assert.ok(sunday);assert.ok(price);assert.deepEqual(sunday.relatedItemIds,[]);
  const commitNative=async(item,text,proposal,facts=[])=>{
   const next=applyVerifiedOwnerTurn(stored.agenda,{type:'verified_owner_turn',binding:stored.agenda.binding,turnId:`${call}:${item}`,text,provenance:'model_interpretation',proposal});
   assert.equal(next.accepted,true,next.rejection);
   stored=await store.commitNativeOwnerTurn({...scope,providerItemId:item,interpretation:text,proposal,facts,agenda:next.agenda,
    expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest});
  };
  const priceText='Neste cenário sintético, o preço público é USD 125 e qualquer desconto depende do dono.';
  const priceFacts=[{topic:'service',field:price.coverageRefs[0],disposition:'answered',rule_text:priceText,structured:{amount:125,currency:'USD'}}];
  await commitNative('saved-price',priceText,{kind:'correction',affectedItems:[{itemId:price.id,disposition:'corrected'}]},priceFacts);
  let count=0;
  while(getAgendaAction(stored.agenda).itemId!==sunday.id){
   const itemId=getAgendaAction(stored.agenda).itemId;assert.ok(itemId);assert.ok(++count<114);
   await commitNative(`before-sunday-${count}`,'Este ponto ainda precisa da confirmação do dono.',{kind:'defer',itemId});
  }
  await commitNative('wrong-confirmation','O dono confirma que existe a contradição; a regra correta de domingo ainda não foi definida.',{kind:'answer',itemId:sunday.id});
  await store.recordOwnerTranscript({...scope,providerItemId:'wrong-confirmation',text:'Deixa eu confirmar.'});
  const providerItemId='item_ELudQQ56SS0WxFI7kXMlW';
  await store.recordOwnerTranscript({...scope,providerItemId,text:recordedSunday});
  const before=await store.readWebsiteInterview(scope),targetBefore=before.agenda.items.find(item=>item.id===sunday.id);
  assert.equal(targetBefore.status,'answered');assert.equal(targetBefore.answerRevision,1);
  const proposal={kind:'correction',affectedItems:[{itemId:sunday.id,disposition:'corrected'}]};
  const next=applyVerifiedOwnerTurn(before.agenda,{type:'verified_owner_turn',binding:before.agenda.binding,turnId:`${call}:${providerItemId}`,text:recordedSunday,proposal});
  assert.equal(next.accepted,true,next.rejection);
  const input={...scope,providerItemId,expectedRevision:before.revision,expectedStoreVersion:before.storeVersion,expectedDigest:before.digest,agenda:next.agenda};
  const args={p_owner:owner,p_call:call,p_request:request,p_revision:before.revision,p_store_version:before.storeVersion,p_digest:before.digest,p_item:providerItemId,p_agenda:next.agenda};
  const statement=(changes={})=>{const a={...args,...changes};return `select public.recover_website_interview_recorded_turn(${q(a.p_owner)},${q(a.p_call)},${q(a.p_request)},${a.p_revision},${a.p_store_version},${q(a.p_digest)},${q(a.p_item)},${jq(a.p_agenda)});`;};
  await assert.rejects(()=>store.recoverRecordedOwnerTurn(input),/recovery_not_settled/);
  // Match the human incident: killed_budget, confirmed teardown, unknown usage
  // and an observed USD 8.2209408 floor above its USD 7.50 reservation.
  await runSql(`update calls set status='killed_budget',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='recorded_recovery_fixture',provider_usage_state='unknown',cost_estimate_usd=8.2209408 where id=${q(call)};`);
  await assert.rejects(()=>store.recoverRecordedOwnerTurn(input),/recovery_not_settled/);
  await runSql(`update budget_reservations set reconcile_attempts=20 where call_id=${q(call)};`);
  await rpc('settle_unresolved_call_budget',{p_tenant:tenant,p_call:call,p_estimated_cost:8.2209408,p_minutes:8,p_outcome:'killed_budget',p_detail:{fixture:'recorded-recovery-probe'}});settled=true;
  assert.equal(await runSql(`select c.status='killed_budget' and c.provider_usage_state='unknown' and b.status='settled' and b.final_cost_usd=8.2209408
   from calls c join budget_reservations b on b.call_id=c.id where c.id=${q(call)};`),'t');
  tests.push('actual-killed-budget-unknown-usage-recovery-requires-confirmed-provider-and-settled-observed-floor');
  await assert.rejects(()=>store.commitOwnerTurn({...input,proposal,facts:[]}),/call_not_owner_bound/);
  await assert.rejects(()=>store.commitNativeOwnerTurn({...input,proposal,interpretation:recordedSunday,agenda:applyVerifiedOwnerTurn(before.agenda,
   {type:'verified_owner_turn',binding:before.agenda.binding,turnId:`${call}:${providerItemId}`,text:recordedSunday,provenance:'model_interpretation',proposal}).agenda}),/call_not_owner_bound/);
  tests.push('normal-literal-and-native-commits-remain-active-only');
  for(const changes of [{p_owner:other},{p_request:other},{p_call:priorCall}])await assert.rejects(()=>rpc('recover_website_interview_recorded_turn',{...args,...changes}),/owner_bound|not_current/);
  await assert.rejects(()=>rpc('recover_website_interview_recorded_turn',{...args,p_item:'absent-owner-audio'}),/recovery_turn_missing/);
  await assert.rejects(()=>rpc('recover_website_interview_recorded_turn',{...args,p_item:'saved-price'}),/recovery_turn_missing/);
  tests.push('owner-request-call-and-existing-literal-asr-binding');
  const rejectMutation=async(sql,reason)=>assert.rejects(()=>runSql(`begin;${sql}set local role service_role;set local request.jwt.claim.role='service_role';${statement()}rollback;`),reason);
  await rejectMutation(`update tenants set test_memory_generation=test_memory_generation+1 where id=${q(tenant)};`,/call_not_owner_bound/);
  await rejectMutation(`update tenants set owner_user_id=${q(other)} where id=${q(tenant)};`,/call_not_owner_bound/);
  await rejectMutation(`update tenants set operational_mode='live' where id=${q(tenant)};`,/call_not_owner_bound/);
  await rejectMutation(`update calls set provider_termination_state='active' where id=${q(call)};`,/recovery_not_settled/);
  await rejectMutation(`update website_interviews set state='closing' where interview_id=${q(call)};`,/recovery_already_approved/);
  await rejectMutation(`update website_interviews set state='complete' where interview_id=${q(call)};`,/recovery_already_approved/);
  await rejectMutation(`update website_interviews set state='reviewing' where interview_id=${q(call)};`,/recovery_not_unfinished/);
  await rejectMutation(`update website_interviews set current_call_id=${q(priorCall)} where interview_id=${q(call)};`,/not_current/);
  await rejectMutation(`insert into company_discovery_onboarding_drafts(id,tenant_id,version,source_job_id,source_result_id,decision_ids,draft,draft_hash,created_by)
   select gen_random_uuid(),tenant_id,version+1,source_job_id,source_result_id,decision_ids,draft,draft_hash,created_by from company_discovery_onboarding_drafts where id=${q(source.draftId)};`,/recovery_source_changed/);
  tests.push('stale-owner-generation-source-current-call-and-final-state-reject-without-progress');
  await rejectMutation(`insert into calls(id,tenant_id,channel,session_type,status,started_at) values(gen_random_uuid(),${q(tenant)},'browser','onboarding','active',clock_timestamp());`,/recovery_competing_attempt/);
  await rejectMutation(`insert into calls(id,tenant_id,channel,session_type,status,started_at,ended_at,provider_termination_state,provider_usage_state)
   values(gen_random_uuid(),${q(tenant)},'browser','onboarding','ended',clock_timestamp(),clock_timestamp(),'not_required','not_applicable');`,/recovery_competing_attempt/);
  await rejectMutation(`insert into website_interview_preparations(id,tenant_id,owner_id,generation,prior_call_id,draft_id,draft_hash,result_id,result_hash)
   select gen_random_uuid(),tenant_id,owner_id,generation,${q(call)},draft_id,draft_hash,result_id,result_hash from website_interview_preparations where id=${q(preparation)};`,/recovery_competing_attempt/);
  await rejectMutation(`insert into browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,opening_mode_requested,onboarding_protocol_version)
   values(gen_random_uuid(),${q(tenant)},${q(owner)},'onboarding','pending-recovery-race','pending','realtime_native_v1',5);`,/recovery_competing_attempt/);
  tests.push('active-later-call-preparation-and-unbound-request-fences');
  for(const changes of [{p_revision:before.revision-1},{p_store_version:before.storeVersion+1},{p_digest:'f'.repeat(64)}])
   await assert.rejects(()=>rpc('recover_website_interview_recorded_turn',{...args,...changes}),/revision_changed/);
  const corrupted=structuredClone(next.agenda);corrupted.items.find(item=>item.id===sunday.id).questionPt='Changed immutable source question';
  await assert.rejects(()=>rpc('recover_website_interview_recorded_turn',{...args,p_agenda:corrupted}),/immutable_seed_changed/);
  await assert.rejects(()=>rpc('recover_website_interview_recorded_turn',{...args,p_agenda:{...next.agenda,unexpected:true}}),/interview_.*invalid/);
  const fabricated=structuredClone(next.agenda);fabricated.ownerTurns.at(-1).text='Invented owner words';
  await assert.rejects(()=>rpc('recover_website_interview_recorded_turn',{...args,p_agenda:fabricated}),/interview_/);
  const reopened=applyVerifiedOwnerTurn(before.agenda,{type:'verified_owner_turn',binding:before.agenda.binding,turnId:`${call}:${providerItemId}`,text:recordedSunday,
   proposal:{kind:'correction',affectedItems:[{itemId:sunday.id,disposition:'reopen'}]}}).agenda;
  await assert.rejects(()=>rpc('recover_website_interview_recorded_turn',{...args,p_agenda:reopened}),/recovery_correction_required/);
  assert.deepEqual(await store.readWebsiteInterview(scope),before);
  assert.equal(await runSql(`select count(*) from receipts where call_id=${q(call)} and external_id=${q(`website-interview:${call}:turn:${providerItemId}`)};`),'0');
  tests.push('schema-source-question-asr-counter-and-reopen-errors-roll-back-the-whole-write');
  const signature='public.recover_website_interview_recorded_turn(uuid,uuid,uuid,bigint,bigint,text,text,jsonb)';
  assert.equal(await runSql(`select has_function_privilege('service_role',${q(signature)},'execute') and not has_function_privilege('authenticated',${q(signature)},'execute') and not has_function_privilege('anon',${q(signature)},'execute');`),'t');
  for(const signature of ['public.website_interview_recorded_recovery_scope(uuid,uuid,uuid,text)',
   'public.commit_website_interview_turn_provenance_core(uuid,uuid,uuid,bigint,bigint,text,text,jsonb,text,jsonb)',
   'public.commit_website_interview_turn_provenance_core(uuid,uuid,uuid,bigint,bigint,text,text,jsonb,text,jsonb,boolean)'])
   assert.equal(await runSql(`select not has_function_privilege('service_role',${q(signature)},'execute') and not has_function_privilege('authenticated',${q(signature)},'execute') and not has_function_privilege('anon',${q(signature)},'execute');`),'t');
  await assert.rejects(()=>runSql(`begin;set local role authenticated;set local request.jwt.claim.role='service_role';${statement()}rollback;`),/permission denied/);
  tests.push('service-only-rpc-private-core-and-no-client-claim-escalation');
  const preserved=async()=>JSON.parse(await runSql(`select jsonb_build_object(
   'turns',(select jsonb_agg(to_jsonb(t) order by provider_item_id) from website_interview_owner_turns t where call_id=${q(call)}),
   'batches',(select jsonb_agg(to_jsonb(f) order by provider_item_id) from website_interview_fact_batches f where call_id=${q(call)}),
   'receipts',(select jsonb_agg(to_jsonb(r) order by id) from receipts r where call_id=${q(call)}),
   'call',(select to_jsonb(c) from calls c where id=${q(call)}),'budget',(select to_jsonb(b) from budget_reservations b where call_id=${q(call)}),
   'source',(select to_jsonb(d) from company_discovery_onboarding_drafts d where id=${q(source.draftId)}));`));
  const oldRows=await preserved();
  const concurrent=await Promise.all([store.recoverRecordedOwnerTurn(input),store.recoverRecordedOwnerTurn(input)]);
  assert.equal(concurrent.filter(result=>result.replayed).length,1);assert.equal(concurrent[0].operationReceiptId,concurrent[1].operationReceiptId);
  const recovered=await store.readWebsiteInterview(scope),operation=concurrent[0],newRows=await preserved();
  assert.equal(recovered.revision,before.revision+1);assert.equal(recovered.storeVersion,before.storeVersion+1);assert.equal(recovered.receiptId,operation.operationReceiptId);
  assert.equal(operation.operationRevision,recovered.revision);assert.equal(recovered.nextAction.itemId,before.nextAction.itemId);
  assert.deepEqual(recovered.agenda.ownerTurns.slice(0,-1),before.agenda.ownerTurns);
  assert.deepEqual(recovered.agenda.ownerTurns.at(-1),{turnId:`${call}:${providerItemId}`,text:recordedSunday});
  for(const item of before.agenda.items){const after=recovered.agenda.items.find(row=>row.id===item.id);
   if(item.id!==sunday.id)assert.deepEqual(after,item);else{assert.equal(after.status,'corrected');assert.equal(after.answerRevision,2);assert.deepEqual(after.evidence.slice(0,-1),item.evidence);}}
  assert.deepEqual(recovered.agenda.candidateContext,before.agenda.candidateContext);assert.deepEqual(recovered.agenda.candidateOverrides,before.agenda.candidateOverrides);
  for(const key of ['turns','call','budget','source'])assert.deepEqual(newRows[key],oldRows[key]);
  for(const row of oldRows.batches)assert.deepEqual(newRows.batches.find(after=>after.provider_item_id===row.provider_item_id),row);
  for(const row of oldRows.receipts)assert.deepEqual(newRows.receipts.find(after=>after.id===row.id),row);
  assert.equal(newRows.batches.length,oldRows.batches.length+1);assert.equal(newRows.receipts.length,oldRows.receipts.length+1);
  const batch=newRows.batches.find(row=>row.provider_item_id===providerItemId);
  assert.equal(batch.owner_text,recordedSunday);assert.equal(batch.interpretation_text,null);assert.deepEqual(batch.facts,[]);
  assert.deepEqual(batch.coverage_refs,sunday.coverageRefs);assert.equal(batch.agenda_receipt_id,operation.operationReceiptId);
  const receipt=newRows.receipts.find(row=>row.id===operation.operationReceiptId);assert.equal(receipt.detail.recordedRecovery,true);assert.equal(receipt.detail.nativeOperation,undefined);
  assert.equal(newRows.turns.find(row=>row.provider_item_id===providerItemId).interpretation_text,null);
  tests.push('concurrent-recovery-appends-once-with-original-asr-and-preserves-price-history-call-budget-and-source');
  assert.equal((await store.recoverRecordedOwnerTurn(input)).operationReceiptId,operation.operationReceiptId);
  await assert.rejects(()=>rpc('recover_website_interview_recorded_turn',{...args,p_store_version:before.storeVersion+1}),/turn_replay_conflict/);
  assert.deepEqual(await preserved(),newRows);
  assert.equal(await runSql(`select count(*) from website_interview_approvals where interview_id=${q(call)};`),'0');
  assert.equal(await runSql(`select count(*) from rules where tenant_id=${q(tenant)};`),'0');
  assert.equal(await runSql(`select count(*) from powers where tenant_id=${q(tenant)};`),'0');
  assert.equal(await runSql(`select operational_mode from tenants where id=${q(tenant)};`),'simulation_only');
  tests.push('exact-retry-and-conflict-preserve-no-approval-or-operational-authority');
  return{tests:tests.length,scenarios:tests,callId:call,providerCalls:0,agendaItems:114,candidateFacts:21,
   targetItemId:sunday.id,preservedPriceItemId:price.id,sourceProviderItemId:providerItemId,operationReceiptId:operation.operationReceiptId,
   beforeRevision:before.revision,afterRevision:recovered.revision,recordedAsrUnchanged:true,interpretationStillNull:true,completed:false};
 }finally{
  if(created&&!settled)await runSql(`update calls set status='killed_budget',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='recorded_recovery_fixture_cleanup',provider_usage_state='unknown',cost_estimate_usd=8.2209408 where id=${q(call)};`);
  if(reserved&&!settled){await runSql(`update budget_reservations set reconcile_attempts=20 where call_id=${q(call)};`);
   await rpc('settle_unresolved_call_budget',{p_tenant:tenant,p_call:call,p_estimated_cost:8.2209408,p_minutes:8,p_outcome:'killed_budget',p_detail:{fixture:'recorded-recovery-probe-cleanup'}});}
 }
}
