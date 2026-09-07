import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createOnboardingAgenda,applyVerifiedOwnerTurn,getAgendaAction} from '../../voice-controller/src/onboarding-agenda.ts';
import {buildWebsiteAgendaSeeds} from '../../voice-controller/src/onboarding-agenda-seed.ts';
import {createOnboardingAgendaStore} from '../../voice-controller/src/onboarding-agenda-store.ts';
import {createInterviewEvidenceStore} from '../../voice-controller/src/onboarding-interview-evidence-store.ts';
import {buildWebsiteOpeningAction,WEBSITE_APPROVAL_QUESTION} from '../../voice-controller/src/onboarding-agenda-coordinator.ts';
import {createWebsiteInterviewRuntime} from '../../voice-controller/src/onboarding-website-runtime.ts';
import {generateWebsiteSummaryParts,buildWebsiteCandidateContext} from '../../voice-controller/src/onboarding-website-summary.ts';
import {ONBOARDING_FINAL_SIGNOFF_TEXT} from '../../voice-controller/src/onboarding-speech.ts';
import {runWebsiteInterruptionActualSchemaProbe} from './website-interview-interruption-actual-schema.mjs';

const q=value=>`'${String(value).replaceAll("'","''")}'`;
const jq=value=>`${q(JSON.stringify(value))}::jsonb`;
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const localId=n=>`97000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function collectSqlText(stream) {
  let text='';
  stream.setEncoding('utf8');
  stream.on('data',chunk=>text+=chunk);
  return ()=>text;
}
function checkedEnvironment(env) {
  if(env.LIGOU_LOCAL_PROJECT_ID!=='ligou-v0-1-rc1' || env.PGHOST!=='127.0.0.1' || env.PGPORT!=='54322' || env.PGDATABASE!=='postgres' || env.PGUSER!=='postgres' || !env.PGPASSWORD)
    throw new Error('website actual-schema suite requires exact disposable RC1 database');
  const exe=env.LIGOU_PSQL_BIN??'psql';
  if(exe!=='psql'&&(!path.isAbsolute(exe)||path.basename(exe)!=='psql'))throw new Error('website suite rejected psql binary');
  return {exe,...env};
}
export async function runWebsiteInterviewActualSchemaSuite(input) {
  const env=checkedEnvironment(input),home=await mkdtemp(path.join(os.tmpdir(),'ligou-website-actual-'));
  const tests=[];
  const runSql=text=>new Promise((resolve,reject)=>{
    const child=spawn(env.exe,['-X','-qAt','-v','ON_ERROR_STOP=1','-f','-'],{env:{PATH:env.PATH??'/usr/bin:/bin',HOME:home,LANG:'C',PGHOST:env.PGHOST,PGPORT:env.PGPORT,PGDATABASE:env.PGDATABASE,PGUSER:env.PGUSER,PGPASSWORD:env.PGPASSWORD,PGCONNECT_TIMEOUT:'5',PGOPTIONS:'-c statement_timeout=15000 -c lock_timeout=10000'},stdio:['pipe','pipe','pipe']});
    const out=collectSqlText(child.stdout),error=collectSqlText(child.stderr);child.on('error',reject);
    child.on('close',code=>code===0?resolve(out().trim()):reject(new Error(error().replaceAll(env.PGPASSWORD,'[redacted]'))));child.stdin.end(text);
  });
  const service=statement=>runSql(`begin; set local role service_role; set local request.jwt.claim.role='service_role'; ${statement} commit;`);
  const authenticated=(owner,statement)=>runSql(`begin; set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub=${q(owner)}; ${statement} commit;`);
  const rpc=async(name,args)=>{
    if(!/^[a-z_]+$/.test(name))throw new Error('invalid fixture RPC');
    const entries=Object.entries(args).map(([key,value])=>{
      if(!/^p_[a-z_]+$/.test(key)||value===undefined)throw new Error('invalid fixture RPC argument');
      const literal=value===null?'null':typeof value==='object'?jq(value):typeof value==='number'?String(value):q(value);
      return `${key} => ${literal}`;
    });
    return JSON.parse(await service(`select public.${name}(${entries.join(',')});`));
  };
  const client={rpc:async(name,args)=>{try{return {data:await rpc(name,args),error:null};}catch(e){return {data:null,error:{message:e.message}};}}};
  try {
    const versions=await runSql("select string_agg(version,',' order by version) from supabase_migrations.schema_migrations;");
    for(const version of ['20260904015214','20260904021654','20260904022004','20260904023207'])assert.ok(versions.includes(version),`actual schema includes ${version}`);
    const guidanceCases=JSON.parse(await readFile(new URL('./fixtures/website-guidance-parity.json',import.meta.url),'utf8'));
    for(const c of guidanceCases.questions)assert.equal(JSON.parse(await runSql(`select to_jsonb(public.website_question_guidance(${jq(c.item)}));`)),c.expected);
    for(const c of guidanceCases.approval)assert.equal(JSON.parse(await runSql(`select to_jsonb(public.website_approval_clarification(${q(c.ownerText)}));`)),c.expected);
    const approvalCases=JSON.parse(await readFile(new URL('../../voice-controller/test/fixtures/website-approval-cases.json',import.meta.url),'utf8'));
    for(const c of approvalCases)assert.equal(JSON.parse(await runSql(`select to_jsonb(public.website_interview_positive_approval(${q(c.text)}));`)),c.kind==='approval');
    tests.push('actual-guidance-and-approval-108-case-parity');
    const fixture=JSON.parse(await readFile(new URL('../../voice-controller/test/fixtures/foghorn-website-first-voice.json',import.meta.url),'utf8'));
    const owner=localId(1),other=localId(2),tenant=localId(3),prior=localId(4),call=localId(5),request=localId(6),preparation=localId(7);
    const d=fixture.draft_row,draft=d.draft,scope={ownerId:owner,callId:call,requestId:request};
    const beforeDraft=JSON.stringify(draft);
    assert.equal(draft.candidate_facts.length,21);assert.equal(fixture.original_questions.missing_information.length+fixture.original_questions.ambiguous_information.length+fixture.original_questions.contradictions.length+fixture.original_questions.owner_private_information_needed.length,16);
    await runSql(`
      insert into auth.users(id,email) values(${q(owner)},'website-actual-owner@example.invalid'),(${q(other)},'website-actual-other@example.invalid');
      insert into public.tenants(id,slug,name,owner_user_id,status,operational_mode,test_memory_generation,daily_budget_usd)
        values(${q(tenant)},'website-actual-foghorn','Foghorn Air, Inc.',${q(owner)},'onboarding','simulation_only',2,100);
      insert into public.company_discovery_allowlist(tenant_id,active,note) values(${q(tenant)},true,'local production-shaped fixture only');
      insert into public.calls(id,tenant_id,channel,session_type,status,ended_at,provider_termination_state,provider_termination_reason,provider_usage_state,transcript)
        values(${q(prior)},${q(tenant)},'browser','onboarding','ended',clock_timestamp(),'confirmed','fixture_prior_owned_end','resolved',${jq(fixture.recorded_transcript)});
      insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version)
        values(${q(localId(8))},${q(tenant)},${q(owner)},'onboarding','fixture-prior-offer','error',${q(prior)},'application_tts_v1',2);
      insert into public.budget_reservations(tenant_id,call_id,budget_day,reserved_cost_usd,reserved_minutes,status,outcome,final_cost_usd,final_minutes,settled_at)
        values(${q(tenant)},${q(prior)},current_date,1,30,'settled','ended',0,1,clock_timestamp());
      insert into public.worker_jobs(id,tenant_id,normalized_origin,origin_host,idempotency_key,request_hash,deadline_at,status,processing_stage)
        values(${q(draft.source_job_id)},${q(tenant)},'https://foghorn.example.invalid','foghorn.example.invalid','local-foghorn-original-draft',${q(sha('local-foghorn-fixture'))},now()+interval '1 hour','awaiting_review','ready_for_onboarding');
      insert into public.worker_attempts(id,tenant_id,job_id,attempt_number,adapter_id,fence_generation,status,claim_token_hash,claimed_by,lease_until)
        values(${q(draft.source_attempt_id)},${q(tenant)},${q(draft.source_job_id)},1,'direct_model',1,'selected',decode(${q('a'.repeat(64))},'hex'),'local-fixture-only',now()+interval '1 hour');
      -- The forensic bundle has the exact canonical draft, not the raw model
      -- result body. This marker is deliberate: no body-hash proof is claimed.
      insert into public.worker_results(id,tenant_id,job_id,attempt_id,fence_generation,result_schema,candidate_result,result_hash)
        values(${q(draft.source_result_id)},${q(tenant)},${q(draft.source_job_id)},${q(draft.source_attempt_id)},1,'company_discovery.result.v2','{"fixture":"raw_result_body_not_in_forensic_bundle"}',${q(draft.source_result_hash)});
      update public.worker_jobs set current_attempt_id=${q(draft.source_attempt_id)},selected_attempt_id=${q(draft.source_attempt_id)} where id=${q(draft.source_job_id)};
      update public.worker_attempts set result_id=${q(draft.source_result_id)} where id=${q(draft.source_attempt_id)};
      insert into public.company_discovery_onboarding_drafts(id,tenant_id,version,source_job_id,source_result_id,decision_ids,draft,draft_hash,created_by)
        values(${q(d.draft_id)},${q(tenant)},${d.draft_version},${q(draft.source_job_id)},${q(draft.source_result_id)},'{}',${jq(draft)},${q(d.draft_hash)},${q(owner)});
    `);
    const discoveryBefore=await runSql(`select jsonb_build_object('job',(select to_jsonb(j) from public.worker_jobs j where id=${q(draft.source_job_id)}),'result',(select to_jsonb(r) from public.worker_results r where id=${q(draft.source_result_id)}),'draft',(select to_jsonb(d) from public.company_discovery_onboarding_drafts d where id=${q(d.draft_id)}));`);
    const store=createOnboardingAgendaStore(client),evidence=createInterviewEvidenceStore(client);
    const setup=async()=>JSON.parse(await authenticated(owner,'select public.company_discovery_setup_status();'));
    assert.equal((await setup()).state,'ready_for_onboarding');assert.equal((await setup()).voice_protocol_version,2);
    const prepInput={preparationId:preparation,ownerId:owner,expectedTenantId:tenant,expectedGeneration:2,priorCallId:prior,draftId:d.draft_id,draftHash:d.draft_hash,sourceResultId:draft.source_result_id,sourceResultHash:draft.source_result_hash};
    await assert.rejects(()=>store.prepareFreshWebsiteInterview({...prepInput,ownerId:other}),/owner_or_generation/);
    await assert.rejects(()=>store.prepareFreshWebsiteInterview({...prepInput,expectedGeneration:3}),/owner_or_generation/);
    await assert.rejects(()=>store.prepareFreshWebsiteInterview({...prepInput,draftHash:'f'.repeat(64)}),/draft_changed/);
    await store.prepareFreshWebsiteInterview(prepInput);
    assert.equal((await setup()).voice_protocol_version,3);
    await runSql(`insert into public.calls(id,tenant_id,channel,session_type,status,provider_usage_state) values(${q(call)},${q(tenant)},'browser','onboarding','active','resolved');
      insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version)
        values(${q(request)},${q(tenant)},${q(owner)},'onboarding','fixture-current-offer','processing',${q(call)},'application_tts_v1',3);`);
    await service(`select public.reserve_call_budget(${q(tenant)},${q(call)},2,55);`);
    const source=await store.resolvePreparedWebsiteSource(scope);assert.deepEqual(source.draft_readback.draft,JSON.parse(beforeDraft));assert.equal(source.draftHash,d.draft_hash);
    const coverage={...fixture.initial_coverage.snapshot,tenantId:tenant,callId:call};
    const projection=buildWebsiteAgendaSeeds({draftReadback:source.draft_readback,initialCoverage:coverage});
    assert.equal(projection.seeds.length,114);assert.equal(projection.coverageObligations.length,136);assert.equal(projection.candidateRecap.length,21);
    const candidateContext=buildWebsiteCandidateContext(projection);assert.equal(candidateContext.length,21);
    const initial=createOnboardingAgenda({interviewId:call,callId:call,draftId:d.draft_id,draftHash:d.draft_hash,sourceResultId:draft.source_result_id,sourceResultHash:draft.source_result_hash},projection.seeds,candidateContext);
    const starts=await Promise.all([store.initializeWebsiteInterview({...scope,preparationId:preparation,agenda:initial}),store.initializeWebsiteInterview({...scope,preparationId:preparation,agenda:initial})]);
    assert.equal(starts.filter(r=>r.replayed).length,1);let stored=starts.find(r=>!r.replayed);
    await assert.rejects(()=>store.readWebsiteInterview({...scope,ownerId:other}),/not_owner_bound/);
    tests.push('actual-source-and-capability-initialize');

    const opening=buildWebsiteOpeningAction(stored,'Foghorn Air, Inc.');
    const audioPayload=action=>({schema:'onboarding.speech.v1',...action,text_sha256:sha(action.text),audio_base64:'SUQzBA==',audio_sha256:createHash('sha256').update(Buffer.from('SUQzBA==','base64')).digest('hex'),mime:'audio/mpeg',voice:'ash',tts_model:'tts-1-hd',cost_usd:Number(([...action.text].length*30/1e6).toFixed(8))});
    const played=async(action,association={})=>{
      const claim=await evidence.claimSpeech({...scope,action,...association});assert.equal(claim.claimed,true);
      assert.equal((await evidence.claimSpeech({...scope,action,...association})).claimed,false);
      const payload=audioPayload(action);await evidence.completeSpeech({...scope,actionId:action.actionId,payload});
      const fetched=JSON.parse(await authenticated(owner,`select public.read_website_interview_speech(${q(call)},${q(action.actionId)});`));assert.deepEqual(fetched,payload);
      await evidence.recordSpeechPlayed({...scope,actionId:action.actionId,assistantItemId:`lgs-${action.actionId.slice(0,28)}`,assistantText:action.text,textSha256:payload.text_sha256,audioSha256:payload.audio_sha256});
      assert.equal(await authenticated(owner,`select public.read_website_interview_speech(${q(call)},${q(action.actionId)});`),'');
      return payload;
    };
    const openingPayload=await played(opening);
    const envelope={version:3,item_id:`lgs-${opening.actionId.slice(0,28)}`,speech:openingPayload};
    await runSql(`update public.browser_session_requests set status='ready',answer_sdp='fixture-answer',opening_mode_applied='application_tts_v1',opening_payload=${jq(envelope)},handled_at=clock_timestamp() where id=${q(request)};`);
    await assert.rejects(()=>authenticated(other,`select public.read_website_interview_speech(${q(call)},${q(opening.actionId)});`),/not_owner_bound/);
    tests.push('actual-browser-v3-owned-opening-and-played-proof');

    // Real runtime -> real store -> actual SQL. Removing an internal requestId
    // here used to hide the production authorization collision (September 6).
    // Only provider events/audio are simulated in this integration lane.
    const events=[],diagnostics=[];
    const runtime=createWebsiteInterviewRuntime({prepared:{scope,stored,projection},openingAction:opening,openingPayload},{
      agendaStore:store,evidenceStore:evidence,synthesize:async action=>audioPayload(action),
      send:event=>events.push(event),enqueue:async task=>task(),onTranscript:()=>{},onCost:()=>{},onUsage:()=>{},onUsageUnknown:()=>{},
      onTerminate:()=>{},onState:()=>{},onDiagnostic:event=>diagnostics.push(event),
    });
    const acknowledge=action=>runtime.handleEvent({type:'conversation.item.created',item:{id:`lgs-${action.actionId.slice(0,28)}`,
      type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:action.text}]}});
    try{
      await runtime.attach();await acknowledge(opening);
      const text='Olha, atende só Novato, San Rafael e Petaluma. Nada além dessas três. Já teve pedido de gente de outras cidades, mas não é pra atender. Se pintar alguma coisa fora, é só com aprovação explícita do dono, combinado?';
      await runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'actual-territory'});
      await runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'actual-territory',transcript:text});
      const interpretation=events.find(event=>event.type==='response.create');assert.ok(interpretation);
      await runtime.handleEvent({type:'response.done',response:{id:'local-fixture-response',status:'completed',metadata:interpretation.response.metadata,
        output:[{type:'function_call',name:'submit_website_interview_proposal',call_id:'local-proposal',status:'completed',arguments:JSON.stringify({proposal:{kind:'answer',itemId:stored.nextAction.itemId},facts:[]})}]}});
      assert.equal(runtime.state.stored.revision,1,JSON.stringify(diagnostics));
      assert.equal(runtime.state.speech?.action.kind,'CONFIRM_AND_ASK_NEXT');
      assert.equal(runtime.state.stored.agenda.items[0].evidence[0].text,text);
      assert.equal(runtime.state.approval,undefined);
      stored=runtime.state.stored;await acknowledge(runtime.state.speech.action);
      assert.equal(await runSql(`select count(*) from public.website_interview_fact_batches where call_id=${q(call)};`),'1');
    }finally{runtime.stop();}
    tests.push('real-runtime-store-sql-september-6-territory-progression');

    // All remaining obligations stay present. Synthetic owner review deferrals
    // exercise a long queue without inventing operational answers or powers.
    let count=1;
    while(getAgendaAction(stored.agenda).itemId) {
      const itemId=getAgendaAction(stored.agenda).itemId,providerItemId=`actual-gap-${count}`;
      const t=await store.recordOwnerTranscript({...scope,providerItemId,text:`Deixe este ponto explicitamente para minha revisão: ${itemId}.`});
      const proposal={kind:'defer',itemId};
      const transition=applyVerifiedOwnerTurn(stored.agenda,{type:'verified_owner_turn',binding:stored.agenda.binding,turnId:t.turnId,text:t.text,proposal});
      assert.equal(transition.accepted,true);
      stored=await store.commitOwnerTurn({...scope,expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest,providerItemId,proposal,agenda:transition.agenda,facts:[]});count++;
    }
    assert.equal(count,114);assert.equal(stored.state,'reviewing');assert.equal(stored.revision,114);
    assert.equal(stored.agenda.items.length,114);assert.equal(stored.agenda.ownerTurns.length,114);
    tests.push('full-foghorn-114-item-no-truncation-queue');
    const candidate=candidateContext.find(c=>c.subject==='public_phone');assert.ok(candidate);
    const candidateTurn=await store.recordOwnerTranscript({...scope,providerItemId:'actual-candidate-phone',text:'O telefone correto para clientes é +1 415 555 0100.'});
    const candidateProposal={kind:'correction',affectedCandidates:[{candidateId:candidate.id,disposition:'corrected'}]};
    const candidateTransition=applyVerifiedOwnerTurn(stored.agenda,{type:'verified_owner_turn',binding:stored.agenda.binding,turnId:candidateTurn.turnId,text:candidateTurn.text,proposal:candidateProposal});
    assert.equal(candidateTransition.accepted,true);
    stored=await store.commitOwnerTurn({...scope,expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest,providerItemId:'actual-candidate-phone',proposal:candidateProposal,agenda:candidateTransition.agenda,facts:[]});
    assert.equal(stored.agenda.items.length,114);assert.equal(stored.agenda.candidateOverrides.length,1);assert.equal(stored.state,'reviewing');
    tests.push('actual-canonical-candidate-correction-without-source-mutation');
    const parts=generateWebsiteSummaryParts({stored,projection}),summaryId=localId(20);
    assert.ok(parts.join('').includes(candidateTurn.text));
    const summary=await evidence.prepareSummary({...scope,summaryId,expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest,expectedReceiptId:stored.receiptId,parts});
    const interruption=await runWebsiteInterruptionActualSchemaProbe({runSql,owner,call,request,summaryId,parts,revision:stored.revision,digest:stored.digest});
    tests.push(...interruption.scenarios);
    const makeAction=(kind,text,key)=>({actionId:sha([stored.agenda.binding,stored.revision,kind,key,text]),interviewId:call,callId:call,revision:stored.revision,kind,text,sourceDigest:stored.digest});
    assert.notEqual((await setup()).state,'onboarding_complete');
    for(let index=0;index<parts.length;index++)await played(makeAction('GENERATE_FINAL_SUMMARY',parts[index],[summary.summaryHash,index]),{summaryId,partIndex:index});
    await played(makeAction('REQUEST_FINAL_APPROVAL',WEBSITE_APPROVAL_QUESTION,summary.summaryHash),{summaryId,partIndex:parts.length});
    await store.recordOwnerTranscript({...scope,providerItemId:'actual-mixed',text:'Sim, mas altere a área.'});
    await assert.rejects(()=>evidence.approveSummary({...scope,summaryId,summaryHash:summary.summaryHash,providerItemId:'actual-mixed',expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest}),/not_strict_affirmation/);
    await store.recordOwnerTranscript({...scope,providerItemId:'actual-approval',text:'Sim. Está tudo correto e confirmo.'});
    const approval=await evidence.approveSummary({...scope,summaryId,summaryHash:summary.summaryHash,providerItemId:'actual-approval',expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest});
    assert.notEqual((await setup()).state,'onboarding_complete');
    await played(makeAction('SPEAK_FINAL_SIGNOFF',ONBOARDING_FINAL_SIGNOFF_TEXT,approval.approvalReceiptId),{summaryId});
    await assert.rejects(()=>evidence.recordCompletion({...scope,outcome:'complete',approvalReceiptId:approval.approvalReceiptId}),/terminal_proof_pending/);
    await runSql(`update public.calls set status='ended',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='agent_ended_session',provider_usage_state='resolved' where id=${q(call)};`);
    assert.notEqual((await setup()).state,'onboarding_complete');
    await service(`select public.settle_call_budget(${q(tenant)},${q(call)},0.25,5,'ended','{"fixture":"synthetic_owned_finish"}');`);
    const candidates=await rpc('list_website_interview_terminal_candidates',{p_limit:8});assert.ok(candidates.some(c=>c.callId===call&&c.canComplete===true));
    const completed=await evidence.recordCompletion({...scope,outcome:'complete',approvalReceiptId:approval.approvalReceiptId});assert.equal(completed.outcome,'complete');
    assert.equal((await setup()).state,'onboarding_complete');
    assert.equal(JSON.parse(await authenticated(owner,`select public.get_website_interview_status(${q(call)});`)).completed,true);
    tests.push('real-summary-approval-budget-terminal-setup-refresh');
    assert.equal(await runSql(`select count(*) from public.rules where tenant_id=${q(tenant)};`),'0');
    assert.equal(await runSql(`select count(*) from public.powers where tenant_id=${q(tenant)};`),'0');
    assert.equal(await runSql(`select test_memory_generation from public.tenants where id=${q(tenant)};`),'2');
    assert.deepEqual(JSON.parse(await runSql(`select transcript from public.calls where id=${q(prior)};`)),fixture.recorded_transcript);
    const discoveryAfter=await runSql(`select jsonb_build_object('job',(select to_jsonb(j) from public.worker_jobs j where id=${q(draft.source_job_id)}),'result',(select to_jsonb(r) from public.worker_results r where id=${q(draft.source_result_id)}),'draft',(select to_jsonb(d) from public.company_discovery_onboarding_drafts d where id=${q(d.draft_id)}));`);
    assert.deepEqual(JSON.parse(discoveryAfter),JSON.parse(discoveryBefore));tests.push('no-authority-no-discovery-mutation-legacy-preserved');
    return {tests:tests.length,scenarios:tests,agendaItems:114,candidateFacts:21,originalQuestions:16,coverageRefs:136,guidanceParityCases:58,approvalGrammarCases:50,summaryParts:parts.length,sourceResultBody:'explicit synthetic marker; original raw result unavailable',providerCalls:0};
  } finally {await rm(home,{recursive:true,force:true});}
}
