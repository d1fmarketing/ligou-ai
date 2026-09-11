// Isolated PG16 tests using the real discovery tables and result/review functions.
// No provider call or remote database; not a substitute for the complete migration gate.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=new URL('../../',import.meta.url),bin='/opt/homebrew/opt/postgresql@16/bin';
const temp=await mkdtemp(path.join(os.tmpdir(),'ligou-managed-analysis-pg-'));
const env={PATH:'/usr/bin:/bin',LC_ALL:'C',PGHOST:temp,PGPORT:'55443',PGDATABASE:'postgres',PGUSER:'managed_test'};
const run=(name,args,input)=>{const r=spawnSync(`${bin}/${name}`,args,{env,input,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout.trim();};
const sql=text=>run('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-f','-'],text);
const file=name=>readFile(new URL(`supabase/migrations/${name}`,root),'utf8');
const q=s=>`'${String(s).replaceAll("'","''")}'`,jq=o=>`${q(JSON.stringify(o))}::jsonb`;
function table(src,name){const start=src.indexOf(`create table public.${name} (`);assert(start>=0,name);return src.slice(start,src.indexOf('\n);',start)+4);}
function fn(src,name){const start=src.indexOf(`create or replace function public.${name}(`);assert(start>=0,name);return src.slice(start,src.indexOf('\n$$;',start)+4);}
const id=n=>`9e000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tenant=id(1),other=id(2),originalJob=id(3),originalAttempt=id(4),originalResult=id(5),owner=id(6);
const source={url:'https://example.com/',retrieved_at:'2026-09-10T00:00:00.000Z',http_status:200,mime_type:'text/html',byte_length:16,content_hash:'b'.repeat(64),excerpt:'Example Plumbing',crawl_order:0,crawl_depth:0};
const result={schema_version:'company_discovery.result.v2',source_snapshots:[source],candidate_facts:[{claim_class:'descriptive',claim_type:'business_name',normalized_value:'Example Plumbing',evidence_refs:[0],confidence:'high',contradiction_status:'none',contradictions:[],missing_fields:[],ambiguous_fields:[],uncertainty:[],claim_schema_version:'company_discovery.claim.v2'}],missing_questions:['Quais condições precisam ser confirmadas?'],contradictions:[],uncertainty:[]};
let started=false;
try {
  run('initdb',['-D',`${temp}/data`,'-A','trust','-U','managed_test','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',`${temp}/data`,'-l',`${temp}/postgres.log`,'-o',`-k ${temp} -h '' -p 55443`,'-w','start']);started=true;
  sql(`create role anon; create role authenticated; create role service_role; create schema auth; create schema extensions;
    create extension pgcrypto with schema extensions; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table tenants(id uuid primary key,owner_user_id uuid,status text default 'onboarding',test_memory_generation bigint default 0,created_at timestamptz default now()); create table discovery_decisions(id uuid primary key);
    create table receipts(id uuid,tenant_id uuid,call_id uuid,kind text,outcome text);
    create table calls(id uuid,tenant_id uuid,session_type text,status text,test_memory_generation bigint);
    create function public.block_mutation() returns trigger language plpgsql as $$ begin raise exception 'append_only'; end $$;`);
  const base=await file('20260901100625_openclaw_company_discovery_stage0.sql');
  for(const name of ['worker_jobs','worker_runtime_slots','worker_attempts','worker_results','discovery_source_snapshots','discovery_claims','company_discovery_review_nonces'])sql(table(base,name));
  for(const name of ['company_discovery_controls','company_discovery_allowlist'])sql(table(base,name));
  sql(`alter table worker_jobs add column processing_stage text default 'queued';`);
  sql(fn(base,'company_discovery_json_has_forbidden_keys'));
  const v2=await file('20260902044327_company_discovery_directmodel_stage0b.sql');
  sql(v2.slice(0,v2.indexOf('create trigger company_discovery_onboarding_drafts_append_only')));
  for(const name of ['company_discovery_v2_price_valid','company_discovery_v2_value_valid','commit_company_discovery_result_v2','review_company_discovery_claims_v2'])sql(fn(v2,name));
  const website=await file('20260902234828_company_discovery_website_first_onboarding.sql');
  sql(website.slice(0,website.indexOf('create or replace function public.select_company_discovery_result('))+'\ncommit;');
  sql(fn(website,'select_company_discovery_result'));
  // Production wraps the original setup selector in later voice migrations.
  sql(fn(website,'company_discovery_setup_status').replace('public.company_discovery_setup_status()', 'public.company_discovery_setup_status_before_amendment()'));
  sql(`create function public.company_discovery_setup_status() returns jsonb language sql security definer set search_path='' as $$ select public.company_discovery_setup_status_before_amendment(); $$;`);
  sql(fn(website,'start_company_discovery_setup'));
  sql(await file('20260911051921_managed_onboarding_analysis.sql'));
  const inputHash=sql(`select encode(extensions.digest(convert_to(${jq(result)}::text,'utf8'),'sha256'),'hex');`);
  sql(`insert into auth.users values(${q(owner)}); insert into tenants(id,owner_user_id) values(${q(tenant)},${q(owner)}),(${q(other)},null);
    insert into company_discovery_allowlist(tenant_id,active,note) values(${q(tenant)},true,'local-only fixture');
    insert into worker_jobs(id,tenant_id,normalized_origin,origin_host,idempotency_key,request_hash,status,deadline_at)
      values(${q(originalJob)},${q(tenant)},'https://example.com/','example.com','original',${q(inputHash)},'awaiting_review',now()+interval '1 day');
    insert into worker_attempts(id,tenant_id,job_id,attempt_number,adapter_id,fence_generation,claim_token_hash,claimed_by,lease_until,status)
      values(${q(originalAttempt)},${q(tenant)},${q(originalJob)},1,'direct_model',1,extensions.digest('old','sha256'),'original',now()+interval '1 day','selected');
    insert into worker_results(id,tenant_id,job_id,attempt_id,fence_generation,result_schema,candidate_result,result_hash)
      values(${q(originalResult)},${q(tenant)},${q(originalJob)},${q(originalAttempt)},1,'company_discovery.result.v2',${jq(result)},${q(inputHash)});
    update worker_jobs set current_attempt_id=${q(originalAttempt)},selected_attempt_id=${q(originalAttempt)},fence_generation=2 where id=${q(originalJob)};
    select select_company_discovery_result(${q(originalJob)},${q(originalAttempt)},1);`);
  const original=sql(`select to_jsonb(j)||jsonb_build_object('result',r.candidate_result) from worker_jobs j join worker_results r on r.job_id=j.id where j.id=${q(originalJob)};`);
  const setup=()=>JSON.parse(sql(`set role authenticated; set request.jwt.claim.sub=${q(owner)}; select company_discovery_setup_status();`));
  assert.equal(setup().ready_proof.result_id,originalResult);
  const call=(action,job,payload={},t=tenant)=>JSON.parse(sql(`set role service_role; select public.company_discovery_managed_job(${q(action)},${q(job)},${q(t)},${jq(payload)});`));
  const payload={input_version:inputHash,idempotency_key:'copy-one',deadline_at:new Date(Date.now()+3600000).toISOString(),retention_delete_at:null};
  const job=call('prepare',originalResult,payload);
  assert.equal(setup().state,'ready_for_onboarding');assert.equal(setup().ready_proof.result_id,originalResult);
  assert.equal(job.state,'prepared');assert.equal(call('prepare',originalResult,payload).job_id,job.job_id);
  assert.throws(()=>call('prepare',originalResult,payload,other),/source_version_invalid/);
  assert.throws(()=>call('read',job.job_id,{},other),/job_not_found/);
  assert.throws(()=>sql(`set role authenticated; select public.company_discovery_managed_job('read',${q(job.job_id)},${q(tenant)},'{}');`),/permission denied/);
  assert.equal(call('claim',job.job_id).claimed,true);assert.equal(call('claim',job.job_id).claimed,false);
  assert.equal(sql(`select status from worker_jobs where id=${q(job.job_id)};`),'running');
  assert.throws(()=>sql(`update worker_jobs set status='queued' where id=${q(job.job_id)};`),/requires_session_reconciliation/);
  call('bind',job.job_id,{session_id:'sess-managed-one'});
  const observation={session_id:'sess-managed-one',turn_id:'turn-one',state:'completed',provider_status:'completed',usage:{input_tokens:10,output_tokens:5,total_tokens:15},output_item_id:'msg-one',output_sha256:'c'.repeat(64)};
  const completed=call('observe',job.job_id,{observation,result});assert.equal(completed.state,'completed');assert(completed.result_id);
  assert.equal(call('observe',job.job_id,{observation,result}).result_id,completed.result_id);
  assert.equal(sql(`select count(*) from worker_results where job_id=${q(job.job_id)};`),'1');
  assert.equal(setup().ready_proof.result_id,originalResult);
  assert.equal(sql(`select adapter_id||'/'||provider||'/'||model from discovery_claims where job_id=${q(job.job_id)};`),'openai_agents/openai/gpt-5.6-terra');
  assert.equal(sql(`select provider_metadata->>'cost_state' from worker_attempts where id=${q(job.attempt_id)};`),'unreconciled');
  assert.equal(sql(`select provider_metadata->'usage'->>'total_tokens' from worker_attempts where id=${q(job.attempt_id)};`),'15');
  // The real existing consumer can read this result into a NEW candidate draft.
  const selected=JSON.parse(sql(`select select_company_discovery_result(${q(job.job_id)},${q(job.attempt_id)},2);`));assert(selected.result_id);
  const draft=JSON.parse(sql(`select draft from company_discovery_onboarding_drafts where source_result_id=${q(completed.result_id)};`));
  assert.equal(setup().ready_proof.result_id,completed.result_id);
  assert.equal(draft.candidate_facts[0].provider,'openai');assert.equal(draft.authority.rules_approved,false);
  assert.equal(sql(`select to_jsonb(j)||jsonb_build_object('result',r.candidate_result) from worker_jobs j join worker_results r on r.job_id=j.id where j.id=${q(originalJob)};`),original);
  const cancelled=call('prepare',originalResult,{...payload,idempotency_key:'copy-cancel'});
  call('claim',cancelled.job_id);call('bind',cancelled.job_id,{session_id:'sess-cancel'});call('cancel',cancelled.job_id);
  const cancelledObservation={...observation,session_id:'sess-cancel',state:'cancelled'};
  call('observe',cancelled.job_id,{observation:cancelledObservation,result:null});
  assert.equal(call('observe',cancelled.job_id,{observation:{...cancelledObservation,state:'completed'},result}).state,'cancelled');
  assert.equal(sql(`select count(*) from worker_results where job_id=${q(cancelled.job_id)};`),'0');
  const forged=call('prepare',originalResult,{...payload,idempotency_key:'copy-forged'});call('claim',forged.job_id);call('bind',forged.job_id,{session_id:'sess-forged'});
  assert.throws(()=>call('observe',forged.job_id,{observation:{...observation,session_id:'sess-forged'},result:{...result,source_snapshots:[{...source,excerpt:'Unapproved new content'}]}}),/runtime_not_bound/);
  console.log('PASS: migration, actual v2 commit, true provenance, product consumer, source preservation, duplicate recovery, cumulative usage, tenant isolation, cancellation fence, source-version enforcement.');
} finally {
  if(started)run('pg_ctl',['-D',`${temp}/data`,'-m','immediate','-w','stop']);
  await rm(temp,{recursive:true,force:true});
}
