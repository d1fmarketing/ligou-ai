import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingAgenda,applyVerifiedOwnerTurn,getAgendaAction} from '../../voice-controller/src/onboarding-agenda.ts';
import {createOnboardingAgendaStore} from '../../voice-controller/src/onboarding-agenda-store.ts';
import {createInterviewEvidenceStore} from '../../voice-controller/src/onboarding-interview-evidence-store.ts';
import {resolveWebsiteContextTimezone,projectWebsiteTimezone,timezoneContextQuestion} from '../../voice-controller/src/onboarding-timezone-context.ts';
const q=x=>`'${String(x).replaceAll("'","''")}'`,jq=x=>`${q(JSON.stringify(x))}::jsonb`;

// Pure SQL/TypeScript parity over the actual selected candidate. No stored
// source is rewritten: variants are passed only to the private resolver.
export async function runTimezoneContextParityCases({runSql,draft,itemId}) {
 const variants=[['selected-source',structuredClone(draft)]];
 for(const [name,mutate] of [
  ['no-geography',d=>d.candidate_facts=d.candidate_facts.filter(f=>!['service_territory','public_address'].includes(f.claim_type))],
  ['wrong-country',d=>d.candidate_facts.find(f=>f.claim_type==='service_territory').value.included_areas[0].country_code='CA'],
  ['other-region',d=>d.candidate_facts.find(f=>f.claim_type==='service_territory').value.included_areas[0].region_state='NV'],
  ['radius',d=>d.candidate_facts.find(f=>f.claim_type==='service_territory').value.radius={km:100}],
  ['ambiguous-geography',d=>d.candidate_facts.find(f=>f.claim_type==='service_territory').ambiguous_fields=['included_areas']],
  ['address-conflict',d=>d.candidate_facts.find(f=>f.claim_type==='public_address').value='10 Main St, Reno, NV 89501'],
  ['explicit-valid',d=>{const f=d.candidate_facts.find(f=>f.claim_type==='business_hours');f.value.timezone='America/New_York';f.missing_fields=[];f.ambiguous_fields=[];}],
  ['explicit-fixed-offset',d=>{const f=d.candidate_facts.find(f=>f.claim_type==='business_hours');f.value.timezone='-08:00';f.missing_fields=[];}],
  ['explicit-invalid',d=>{const f=d.candidate_facts.find(f=>f.claim_type==='business_hours');f.value.timezone='Not/AZone';f.missing_fields=[];}],
 ]) {const value=structuredClone(draft);mutate(value);variants.push([name,value]);}
 for(const [name,value] of variants)assert.deepEqual(JSON.parse(await runSql(`select coalesce(public.website_timezone_context_for_draft(${jq(value)},${q(itemId)}),'null'::jsonb);`)),resolveWebsiteContextTimezone(value.candidate_facts,itemId),name);
 const valid=resolveWebsiteContextTimezone(draft.candidate_facts,itemId);assert.ok(valid);
 for(const changed of [{...valid,origin:null},{...valid,origin:'owner_statement'},{...valid,timeZone:'PST'},{...valid,sourceClaimIds:[]},{...valid,evidenceRefs:['not-an-id']},{...valid,unknown:true}])
  assert.equal(await runSql(`select public.website_timezone_context_valid(${jq(changed)});`),'f');
 return ['timezone-source-resolver-parity-and-malformed-origin-rejection'];
}

export async function runTimezoneContextLifecycleCases({runSql,rpc,owner,other,tenant,call,request}) {
 const scope={ownerId:owner,callId:call,requestId:request};
 const client={rpc:async(name,args)=>({data:await rpc(name,args),error:null})},store=createOnboardingAgendaStore(client);
 let stored=await store.readWebsiteInterview(scope);const initial=stored,context=stored.agenda.contextTimezone,scenarios=[];
 assert.ok(context);assert.equal(stored.revision,0);assert.equal(stored.agenda.items.length,114);assert.equal(stored.agenda.candidateContext.length,21);
 assert.deepEqual(stored.agenda.ownerTurns,[]);assert.equal(await runSql(`select count(*) from website_interview_owner_turns where call_id=${q(call)};`),'0');
 assert.deepEqual(stored.agenda.items.find(i=>i.id===context.itemId).evidence,[]);
 assert.equal(stored.agenda.items.find(i=>i.id===context.itemId).status,'context_resolved');
 assert.equal(await runSql(`select (readback->'agenda'->'contextTimezone'=${jq(context)})::text from receipts where id=${q(initial.receiptId)};`),'true');
 await assert.rejects(()=>store.readWebsiteInterview({...scope,ownerId:other}),/not_owner_bound/);
 scenarios.push('timezone-context-is-durable-with-no-owner-turn-or-authority');
 await runSql(`update calls set openai_call_id=${q('rtc_timezone_'+call)},provider_termination_state='active',provider_usage_state='unknown' where id=${q(call)};
  update browser_session_requests set status='ready',answer_sdp='timezone-answer',opening_mode_applied='realtime_native_v1',opening_payload=${jq({version:5,native:{callId:call,interviewId:stored.agenda.binding.interviewId,revision:0,sourceDigest:stored.digest}})} where id=${q(request)};`);
 const makeInput=(base,item,text,proposal)=>{const transition=applyVerifiedOwnerTurn(base.agenda,{type:'verified_owner_turn',binding:base.agenda.binding,turnId:`${call}:${item}`,text,provenance:'model_interpretation',proposal});
  assert.equal(transition.accepted,true,transition.rejection);return{...scope,expectedRevision:base.revision,expectedStoreVersion:base.storeVersion,expectedDigest:base.digest,providerItemId:item,interpretation:text,proposal,agenda:transition.agenda,facts:[]};};
 const first=stored.agenda.items.find(i=>i.id===getAgendaAction(stored.agenda).itemId);
 const answer=makeInput(stored,'timezone-area','A área informada permanece restrita à região da empresa.',{kind:'answer',itemId:first.id});
 const changed=structuredClone(answer);changed.agenda.contextTimezone.timeZone='America/New_York';
 await assert.rejects(()=>store.commitNativeOwnerTurn(changed),/interview_context_timezone_changed/);
 assert.equal(await runSql(`select count(*) from website_interview_owner_turns where call_id=${q(call)};`),'0');
 stored=await store.commitNativeOwnerTurn(answer);
 const hours=stored.agenda.items.find(i=>i.coverageRefs.includes('schedule.business_hours'));
 assert.ok(hours);assert.equal(hours.status,'open');assert.match(hours.questionPt,/domingo/);
 assert.doesNotMatch(timezoneContextQuestion(hours.questionPt,projectWebsiteTimezone(stored.agenda)),/fuso/);
 while(stored.agenda.items.findIndex(i=>i.id===getAgendaAction(stored.agenda).itemId)<stored.agenda.items.findIndex(i=>i.id===context.itemId)){
  const item=getAgendaAction(stored.agenda).itemId;assert.ok(item);
  stored=await store.commitNativeOwnerTurn(makeInput(stored,`timezone-before-${stored.revision}`,'Este ponto fica para revisão posterior do dono.',{kind:'defer',itemId:item}));
 }
 assert.notEqual(getAgendaAction(stored.agenda).itemId,context.itemId);
 assert.equal(stored.agenda.items.find(i=>i.id===hours.id).status,'open');
 scenarios.push('only-timezone-skips-the-queue-hours-and-sunday-remain-open');
 const correction=makeInput(stored,'timezone-owner-correction','O fuso operacional correto é America/New_York.',{kind:'correction',affectedItems:[{itemId:context.itemId,disposition:'corrected'}]});
 stored=await store.commitNativeOwnerTurn(correction);assert.equal(stored.agenda.contextTimezone,undefined);
 assert.deepEqual(projectWebsiteTimezone(stored.agenda).evidence,stored.agenda.items.find(i=>i.id===context.itemId).evidence.at(-1));
 assert.equal(projectWebsiteTimezone(stored.agenda).askTimezone,false);assert.equal(projectWebsiteTimezone(stored.agenda).timeZone,null);
 const corrected=stored;await store.recordOwnerTranscript({...scope,providerItemId:correction.providerItemId,text:'Use America/New_York como fuso da empresa.'});
 stored=await store.readWebsiteInterview(scope);assert.deepEqual(stored.agenda,corrected.agenda);
 for(const key of ['revision','storeVersion','digest','receiptId'])assert.equal(stored[key],corrected[key]);
 assert.equal((await store.commitNativeOwnerTurn(correction)).replayed,true);
 assert.equal(await runSql(`select (readback->'agenda'->'contextTimezone'=${jq(context)})::text from receipts where id=${q(initial.receiptId)};`),'true');
 assert.equal(await runSql(`select count(*) from website_interview_approvals where call_id=${q(call)};`),'0');
 scenarios.push('explicit-owner-correction-replaces-inference-with-history-and-late-asr-intact');
 const childCall=randomUUID(),childRequest=randomUUID();
 // A single rollback-safe connection proves the resume transition without
 // leaving a newer call that would invalidate the next probe's causal prior.
 const resumed=JSON.parse(await runSql(`begin;set local request.jwt.claim.role='service_role';
  update calls set status='ended',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='timezone_resume_fixture' where id=${q(call)};
  update budget_reservations set status='settled',outcome='ended',final_cost_usd=0.025,final_minutes=1,settled_at=clock_timestamp() where call_id=${q(call)};
  insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation,provider_usage_state) values(${q(childCall)},${q(tenant)},'browser','onboarding','active',2,'not_applicable');
  insert into browser_session_requests(id,tenant_id,user_id,session_type,test_memory_generation,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version) values(${q(childRequest)},${q(tenant)},${q(owner)},'onboarding',2,'timezone-resume-offer','processing',${q(childCall)},'realtime_native_v1',5);
  select public.attach_website_interview(${q(owner)},${q(childCall)},${q(childRequest)},${q(stored.agenda.binding.interviewId)},${q(call)});rollback;`));
 assert.deepEqual(resumed.agenda,{...stored.agenda,binding:{...stored.agenda.binding,callId:childCall}});
 assert.equal(resumed.revision,stored.revision);assert.equal(projectWebsiteTimezone(resumed.agenda).askTimezone,false);
 assert.equal(resumed.agenda.contextTimezone,undefined);
 scenarios.push('resume-retains-owner-decision-without-reintroducing-website-inference');
 return{scenarios,callId:call,revision:stored.revision,contextItemId:context.itemId,initialReceiptId:initial.receiptId,correctionReceiptId:stored.receiptId,agendaItems:114,candidateFacts:21,providerCalls:0};
}

export async function runWebsiteTimezoneContextActualSchemaProbe({runSql,rpc,owner,other,tenant,priorCall,source,initialAgenda,projection}) {
 const call=randomUUID(),request=randomUUID(),preparation=randomUUID(),scope={ownerId:owner,callId:call,requestId:request};
 const client={rpc:async(name,args)=>({data:await rpc(name,args),error:null})},store=createOnboardingAgendaStore(client);let created=false,reserved=false,proof;
 try {
  assert.ok(projection.contextTimezone);
  const draft=JSON.parse(await runSql(`select draft from company_discovery_onboarding_drafts where id=${q(source.draftId)};`));
  const parity=await runTimezoneContextParityCases({runSql,draft,itemId:projection.contextTimezone.itemId});
  await store.prepareFreshWebsiteInterview({preparationId:preparation,ownerId:owner,expectedTenantId:tenant,expectedGeneration:2,priorCallId:priorCall,
   draftId:source.draftId,draftHash:source.draftHash,sourceResultId:source.sourceResultId,sourceResultHash:source.sourceResultHash});
  await runSql(`insert into calls(id,tenant_id,channel,session_type,status,model,provider_usage_state,cost_estimate_usd) values(${q(call)},${q(tenant)},'browser','onboarding','active','gpt-realtime-2.1','not_applicable',0);
   insert into browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version) values(${q(request)},${q(tenant)},${q(owner)},'onboarding','timezone-probe-offer','processing',${q(call)},'realtime_native_v1',5);`);created=true;
  await rpc('reserve_call_budget',{p_tenant:tenant,p_call:call,p_est_cost:7.5,p_reserved_minutes:55});reserved=true;
  const agenda=createOnboardingAgenda({...initialAgenda.binding,callId:call,interviewId:call},projection.seeds,initialAgenda.candidateContext,projection.contextTimezone);
  const wrong=structuredClone(agenda);wrong.contextTimezone.timeZone='America/New_York';
  await assert.rejects(()=>store.initializeWebsiteInterview({...scope,preparationId:preparation,agenda:wrong}),/context_timezone_source_mismatch/);
  await store.initializeWebsiteInterview({...scope,preparationId:preparation,agenda});
  proof=await runTimezoneContextLifecycleCases({runSql,rpc,owner,other,tenant,call,request});proof.scenarios.unshift(...parity,'timezone-initialization-requires-exact-selected-source');return proof;
 } finally {
  if(created)await runSql(`update calls set status='ended',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='timezone_fixture_end',provider_usage_state='resolved',cost_estimate_usd=0.025 where id=${q(call)};`);
  if(reserved)await rpc('settle_call_budget',{p_tenant:tenant,p_call:call,p_actual_cost:0.025,p_minutes:1,p_outcome:'ended',p_detail:{fixture:'timezone-context-probe'}});
  if(proof){const receipt=await createInterviewEvidenceStore(client).recordCompletion({...scope,outcome:'unfinished'});assert.equal(receipt.outcome,'unfinished');proof.terminalReceiptId=receipt.receiptId;}
 }
}
