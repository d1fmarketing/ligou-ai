#!/usr/bin/env node
// Isolated PG16 stream/protocol/RPC regression, not the complete PG17 migration gate.
// No inherited database credentials and no network listener.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runWebsiteStreamCases} from './website-interview-stream-cases.mjs';
import {runWebsiteStreamSummaryCases} from './website-interview-stream-summary-cases.mjs';
const root=new URL('../../',import.meta.url);
const bin='/opt/homebrew/opt/postgresql@16/bin';
const temp=await mkdtemp(path.join(os.tmpdir(),'ligou-stream-pg-'));
const env={PATH:'/usr/bin:/bin',LC_ALL:'C',PGHOST:temp,PGPORT:'55441',PGDATABASE:'postgres',PGUSER:'interview_test',PGCONNECT_TIMEOUT:'5'};
const run=(name,args,input)=>{
  const result=spawnSync(`${bin}/${name}`,args,{env,input,encoding:'utf8'});
  if(result.status!==0)throw new Error(`${name}: ${result.stderr||result.stdout}`);
  return result.stdout.trim();
};
const sql=text=>run('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-f','-'],`set request.jwt.claim.role='service_role'; ${text}`);
const file=name=>readFile(new URL(`supabase/migrations/${name}`,root),'utf8');
const id=n=>`9b000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner=id(1),other=id(2),tenant=id(3),call=id(4),request=id(5),draft=id(6),result=id(7),job=id(8),attempt=id(9),prep=id(10);
const h='a'.repeat(64),rh='b'.repeat(64);
const initial={version:1,binding:{interviewId:call,callId:call,draftId:draft,draftHash:h,sourceResultId:result,sourceResultHash:rh},revision:0,
  items:['area','exception','schedule'].map(name=>({id:name,source:'ambiguity',subject:name,questionPt:`Pergunta ${name}?`,coverageRefs:[name],relatedItemIds:[],blocking:true,status:'open',answerRevision:0,clarificationCount:0,lastQuestionPt:`Pergunta ${name}?`,evidence:[]})),
  ownerTurns:[],candidateContext:[],candidateOverrides:[]};
let started=false;
try {
  run('initdb',['-D',`${temp}/data`,'-A','trust','-U','interview_test','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',`${temp}/data`,'-l',`${temp}/postgres.log`,'-o',`-k ${temp} -h '' -p 55441`,'-w','start']);started=true;
  sql(`create role anon;create role authenticated;create role service_role;
    create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
    create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    create table auth.users(id uuid primary key);
    create table public.tenants(id uuid primary key,owner_user_id uuid,status text,operational_mode text,test_memory_generation bigint,name text default 'Isolated fixture',slug text);
    grant usage on schema auth to authenticated;grant select on public.tenants to authenticated;
    create table public.calls(id uuid primary key,tenant_id uuid,channel text,session_type text,status text,test_memory_generation bigint,
      started_at timestamptz default now(),ended_at timestamptz,duration_seconds int,model text,transcript jsonb default '[]',
      provider_termination_state text default 'not_required',provider_termination_mode text,provider_termination_reason text,
      openai_call_id text,provider_usage_state text default 'not_applicable',cost_estimate_usd numeric,
      provider_termination_attempt_id uuid,provider_termination_request_id text,provider_termination_attempted_at timestamptz,provider_terminated_at timestamptz,
      constraint calls_provider_termination_attempt_check check (
        (provider_termination_attempt_id is null and provider_termination_request_id is null and provider_termination_attempted_at is null)
        or (provider_termination_attempt_id is not null and provider_termination_request_id=provider_termination_attempt_id::text and provider_termination_attempted_at is not null)));
    create table public.browser_session_requests(id uuid primary key,tenant_id uuid,call_id uuid unique,user_id uuid,session_type text,
      test_memory_generation bigint,onboarding_protocol_version int,opening_mode_requested text,status text,
      offer_sdp text,error text,answer_sdp text,opening_mode_applied text,opening_payload jsonb);
    create table public.budget_reservations(id uuid primary key default gen_random_uuid(),tenant_id uuid,call_id uuid unique,status text,
      budget_day date,reserved_cost_usd numeric,reserved_minutes numeric,outcome text,final_cost_usd numeric,final_minutes numeric,settled_at timestamptz);
    create table public.worker_jobs(id uuid primary key,tenant_id uuid,selected_attempt_id uuid,status text);
    create table public.worker_results(id uuid primary key,tenant_id uuid,job_id uuid,attempt_id uuid,result_hash text,validation_state text,result_schema text);
    create table public.company_discovery_onboarding_drafts(id uuid primary key,tenant_id uuid,source_job_id uuid,source_result_id uuid,created_by uuid,draft_hash text,draft jsonb,version bigint);
    create table public.receipts(id uuid primary key,tenant_id uuid,call_id uuid,kind text check(kind in ('booking','onboarding_coverage')),outcome text,external_id text,payload_hash text,readback jsonb,detail jsonb);
    create table public.rules(id uuid,tenant_id uuid);create table public.powers(id uuid,tenant_id uuid);
    create function public.block_mutation() returns trigger language plpgsql as $$ begin raise exception 'append_only'; end $$;
  `);
  sql(await file('20260827231053_onboarding_application_greeting.sql'));
  const oldOpening=await file('20260903190000_company_discovery_onboarding_processing_handoff.sql');
  const openingStart=oldOpening.indexOf('alter table public.browser_session_requests\n  drop constraint if exists browser_session_requests_opening_state_check;');
  const openingEnd=oldOpening.indexOf('validate constraint browser_session_requests_opening_state_check;',openingStart)+'validate constraint browser_session_requests_opening_state_check;'.length;
  assert(openingStart>0&&openingEnd>openingStart);sql(oldOpening.slice(openingStart,openingEnd));
  const priorProtocol=await file('20260828185525_onboarding_resume_checkpoint.sql');
  const protocolStart=priorProtocol.indexOf('alter table public.browser_session_requests\n  drop constraint if exists browser_session_requests_onboarding_protocol_check;');
  const protocolEnd=priorProtocol.indexOf('create or replace function public.get_onboarding_resume_status(p_call uuid)',protocolStart);
  assert(protocolStart>0&&protocolEnd>protocolStart);sql(priorProtocol.slice(protocolStart,protocolEnd));
  sql(await file('20260904022004_website_interview_browser_protocol3.sql'));
  const canonical=await file('20260826161435_onboarding_v2_reconciliation.sql');
  sql(canonical.slice(canonical.indexOf('create or replace function public.onboarding_canonical_json_v1('),canonical.indexOf('create or replace function public.onboarding_cell_semantic_hash_v1(')));
  sql(await file('20260904015214_website_interview_agenda_foundation.sql'));
  sql(await file('20260904021654_website_interview_evidence.sql'));
  sql(await file('20260907022111_browser_interview_expiry_receipts.sql'));
  sql(`create function public.company_discovery_setup_status() returns jsonb language sql security definer as $$ select '{"state":"ready_for_onboarding","voice_protocol_version":3}'::jsonb $$;`);
  sql(await file('20260907033624_website_interview_interruptions_and_amendments.sql'));
  sql(await file('20260907042511_website_interview_natural_current_approval.sql'));
  sql(await file('20260907094105_website_interview_no_provider_resume.sql'));
  sql(await file('20260907080117_onboarding_tts_model_rates.sql'));
  if(!process.argv.includes('--red')){
    sql(await file('20260907165213_website_interview_stream_protocol4.sql'));
    sql(await file('20260907170013_website_interview_stream_evidence.sql'));
  }
  sql(`insert into auth.users values('${owner}'),('${other}');
    insert into tenants(id,owner_user_id,status,operational_mode,test_memory_generation) values('${tenant}','${owner}','onboarding','simulation_only',2);
    insert into worker_jobs values('${job}','${tenant}','${attempt}','awaiting_review');
    insert into worker_results values('${result}','${tenant}','${job}','${attempt}','${rh}','validated','company_discovery.result.v2');
    insert into company_discovery_onboarding_drafts values('${draft}','${tenant}','${job}','${result}','${owner}','${h}','{"schema_version":"company_discovery.onboarding_draft.v2","source_result_hash":"${rh}","candidate_facts":[]}',1);
    select public.prepare_initial_website_interview('${prep}','${owner}','${tenant}',2,'${draft}','${h}','${result}','${rh}');
    insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation) values('${call}','${tenant}','browser','onboarding','active',2);
    insert into browser_session_requests(id,tenant_id,call_id,user_id,session_type,test_memory_generation,onboarding_protocol_version,opening_mode_requested,status,offer_sdp)
      values('${request}','${tenant}','${call}','${owner}','onboarding',2,4,'realtime_stream_v1','processing','isolated-offer');
    insert into budget_reservations(tenant_id,call_id,status,budget_day,reserved_cost_usd,reserved_minutes) values('${tenant}','${call}','active',current_date,1,55);
    select public.initialize_website_interview('${owner}','${call}','${request}','${prep}','${JSON.stringify(initial)}'::jsonb);`);
  assert.equal(sql('select count(*) from website_interviews;'),'1');
  const probe=await runWebsiteStreamCases({runSql:async text=>sql(text),owner,other,tenant,call,request});
  const summaryProbe=await runWebsiteStreamSummaryCases({runSql:async text=>sql(text),owner,tenant,call,request});
  // These final fixtures are committed only inside this disposable instance so
  // two independent psql connections can race the actual row locks/CAS.
  sql(`do $concurrent$ declare i public.website_interviews;spoken text;act jsonb;a jsonb;begin
    i:=public.website_interview_current('${owner}','${call}','${request}');
    select 'Oi! Aqui é o Ligou, agente de inteligência artificial da '||name||'. Eu já analisei seu website. '||(i.next_action->>'spokenPt') into spoken from tenants where id='${tenant}';
    act:=jsonb_build_object('actionId',encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(i.next_action->>'actionId','opening',spoken)),'sha256'),'hex'),
      'interviewId',i.interview_id,'callId','${call}','revision',i.agenda->'revision','kind','ASK_NEXT_GAP','text',spoken,'sourceDigest',i.digest);
    a:=public.claim_website_interview_stream('${owner}','${call}','${request}',act);
    update browser_session_requests set status='ready',answer_sdp='concurrency-answer',opening_mode_applied='realtime_stream_v1',opening_payload=jsonb_build_object('version',4,'stream',a) where id='${request}';
    update calls set openai_call_id='rtc_stream_concurrency',provider_termination_state='active',provider_usage_state='unknown' where id='${call}';
  end $concurrent$;`);
  const descriptor=JSON.parse(sql(`select public.website_interview_stream_descriptor('${call}',(select action_id from website_interview_speech where call_id='${call}'));`));
  const literal=value=>`'${String(value).replaceAll("'","''")}'`;
  const args=`'${owner}','${call}','${request}',${literal(descriptor.action.actionId)},${literal(descriptor.dispatchId)}`;
  const parallel=text=>new Promise((resolve,reject)=>{
    const child=spawn(`${bin}/psql`,['-X','-qAt','-v','ON_ERROR_STOP=1','-f','-'],{env,stdio:['pipe','pipe','pipe']});
    let out='',error='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);
    child.on('close',code=>resolve({ok:code===0,out:out.trim(),error}));child.stdin.end(`set request.jwt.claim.role='service_role';${text}`);
  });
  const starts=await Promise.all([parallel(`select public.authorize_website_interview_stream(${args});`),parallel(`select public.authorize_website_interview_stream(${args});`)]);
  assert.equal(starts.filter(result=>result.ok).length,1);assert.match(starts.find(result=>!result.ok).error,/dispatch_already_started/);
  const media={schema:'onboarding.stream.media.v1',nonzeroSamples:20,observedMs:200,firstSampleAtMs:10,lastSampleAtMs:210,unmuted:true,playbackStarted:true};
  const joined=await Promise.all([
    parallel(`select public.record_website_interview_stream_response(${args},'parallel-response','parallel-item',${literal(descriptor.action.text)},'completed');`),
    parallel(`select public.record_website_interview_stream_playout(${args},'parallel-response','parallel-item','parallel-buffer',${literal(JSON.stringify(media))}::jsonb);`),
  ]);
  assert.ok(joined.every(result=>result.ok),JSON.stringify(joined));
  assert.equal(joined.map(result=>JSON.parse(result.out)).filter(result=>result.status==='played').length,1);
  assert.equal(sql(`select count(distinct id) from receipts where call_id='${call}' and external_id like 'website-stream-%';`),'4');
  sql(`update calls set status='ended',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='isolated_concurrency_cleanup',provider_usage_state='resolved',cost_estimate_usd=0 where id='${call}';
    update budget_reservations set status='settled',outcome='ended',final_cost_usd=0,final_minutes=0,settled_at=clock_timestamp() where call_id='${call}';
    select public.record_website_interview_completion('${owner}','${call}','${request}','unfinished',null);`);
  console.log(JSON.stringify({status:'passed',database:'isolated PostgreSQL 16; actual stream/protocol/RPC migrations with minimal prerequisite schema; NOT full migration gate',...probe,summaryProbe,
    concurrency:{connections:2,oneDispatchWinner:true,oneJoinedPlayback:true,fixtureCallEnded:true,fixtureBudgetSettled:true}}));
} finally {
  if(started)run('pg_ctl',['-D',`${temp}/data`,'-m','fast','-w','stop']);
  await rm(temp,{recursive:true,force:true});
}
