#!/usr/bin/env node
// Isolated PG16 foundation test, not the full PG17 migration gate. No inherited
// database URL/credentials and no network listener; all state is disposable.
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { websiteQuestionGuidance } from "../../voice-controller/src/onboarding-website-guidance.ts";
const root = fileURLToPath(new URL("../../", import.meta.url));
const bin = "/opt/homebrew/opt/postgresql@16/bin";
const temp = await mkdtemp(path.join(os.tmpdir(), "ligou-interruption-pg-"));
const env = { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: temp, PGHOST: temp, PGPORT: "55441", PGDATABASE: "postgres", PGUSER: "interview_test", PGCONNECT_TIMEOUT: "5" };
const run = (name, args, input) => {
  const r = spawnSync(`${bin}/${name}`, args, { env, input, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${name}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const sql = text => run("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"], `set request.jwt.claim.role='service_role';\n${text}`);
const json = text => JSON.parse(sql(`select ${text};`));
const fail = (text, reason) => assert.throws(() => sql(text), new RegExp(reason));
const quote = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const id = n => `90000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const owner=id(1), tenant=id(2), prior=id(3), call=id(4), request=id(5), draft=id(6), result=id(7), job=id(8), attempt=id(9), prep=id(10), other=id(11);
const h="a".repeat(64), rh="b".repeat(64);
const scope=`'${owner}','${call}','${request}'`;
const prepare=(key=prep,who=owner,generation=2,hash=h)=>`public.prepare_fresh_website_interview('${key}','${who}','${tenant}',${generation},'${prior}','${draft}','${hash}','${result}','${rh}')`;
const binding={interviewId:call,callId:call,draftId:draft,draftHash:h,sourceResultId:result,sourceResultHash:rh};
const seed=(name,related=[])=>({id:name,source:"ambiguity",subject:name,questionPt:`Pergunta ${name}?`,coverageRefs:[name],relatedItemIds:related,blocking:true,status:"open",answerRevision:0,clarificationCount:0,lastQuestionPt:`Pergunta ${name}?`,evidence:[]});
const candidateId=`candidate:${id(91)}`;
const candidateContext=[{id:`candidate:${id(92)}`,subject:'public_email',questionPt:'Qual é o email correto?',coverageRefs:[`discovery.candidate.${id(92).replaceAll('-','')}`]},{id:candidateId,subject:'public_phone',questionPt:'Qual é o telefone correto em vez do publicado?',coverageRefs:[`discovery.candidate.${id(91).replaceAll('-','')}`]}];
const initial={version:1,binding,revision:0,items:[seed("area",["exception"]),seed("exception"),seed("schedule")],ownerTurns:[],candidateContext,candidateOverrides:[]};
let started=false;
try {
  run("initdb",["-D",`${temp}/data`,"-A","trust","-U","interview_test","--no-locale","--encoding=UTF8"]);
  run("pg_ctl",["-D",`${temp}/data`,"-l",`${temp}/postgres.log`,"-o",`-k ${temp} -h '' -p 55441`,"-w","start"]); started=true;
  sql(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
    create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table auth.users(id uuid primary key);
    create table public.tenants(id uuid primary key,owner_user_id uuid,status text,operational_mode text,test_memory_generation bigint,name text default 'Foghorn Air');
    grant usage on schema auth to authenticated; grant select on public.tenants to authenticated;
    create table public.calls(id uuid primary key,tenant_id uuid,channel text,session_type text,status text,test_memory_generation bigint,started_at timestamptz default clock_timestamp(),ended_at timestamptz,provider_termination_state text,transcript jsonb default '[]');
    create table public.browser_session_requests(id uuid primary key,tenant_id uuid,call_id uuid,user_id uuid,session_type text,test_memory_generation bigint,onboarding_protocol_version int,opening_mode_requested text,status text);
    create table public.budget_reservations(id uuid primary key,tenant_id uuid,call_id uuid,status text);
    create table public.worker_jobs(id uuid primary key,tenant_id uuid,selected_attempt_id uuid,status text);
    create table public.worker_results(id uuid primary key,tenant_id uuid,job_id uuid,attempt_id uuid,result_hash text,validation_state text,result_schema text);
    create table public.company_discovery_onboarding_drafts(id uuid primary key,tenant_id uuid,source_job_id uuid,source_result_id uuid,created_by uuid,draft_hash text,draft jsonb,version bigint);
    create table public.receipts(id uuid primary key,tenant_id uuid,call_id uuid,kind text check(kind in ('booking','onboarding_coverage')),outcome text,external_id text,payload_hash text,readback jsonb,detail jsonb);
    create table public.rules(id uuid); create table public.powers(id uuid);
    create function public.block_mutation() returns trigger language plpgsql as $$ begin raise exception 'append_only'; end $$;
  `);
  const existing=await readFile(path.join(root,"supabase/migrations/20260826161435_onboarding_v2_reconciliation.sql"),"utf8");
  sql(existing.slice(existing.indexOf("create or replace function public.onboarding_canonical_json_v1("),existing.indexOf("create or replace function public.onboarding_cell_semantic_hash_v1(")));
  sql(await readFile(path.join(root,"supabase/migrations/20260904015214_website_interview_agenda_foundation.sql"),"utf8"));
  sql(await readFile(path.join(root,"supabase/migrations/20260904021654_website_interview_evidence.sql"),"utf8"));
  sql("alter table calls add column provider_termination_reason text;");
  sql("alter table calls add column openai_call_id text, add column provider_usage_state text, add column cost_estimate_usd numeric; alter table browser_session_requests add column answer_sdp text, add column opening_payload jsonb;");
  sql("create function public.company_discovery_setup_status() returns jsonb language sql security definer as $$ select '{\"state\":\"ready_for_onboarding\"}'::jsonb $$;");
  if (!process.argv.includes("--red")) sql(await readFile(path.join(root,"supabase/migrations/20260907033624_website_interview_interruptions_and_amendments.sql"),"utf8"));
  sql(`insert into auth.users values('${owner}'),('${other}');
    insert into tenants values('${tenant}','${owner}','onboarding','simulation_only',2);
    insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation,ended_at,provider_termination_state,transcript) values('${prior}','${tenant}','browser','onboarding','ended',2,now(),'confirmed','[{"role":"caller","text":"Legacy answer remains"}]');
    insert into browser_session_requests values('${id(12)}','${tenant}','${prior}','${owner}','onboarding',2,2,'application_tts_v1','ready');
    insert into budget_reservations values('${id(13)}','${tenant}','${prior}','settled');
    insert into worker_jobs values('${job}','${tenant}','${attempt}','awaiting_review');
    insert into worker_results values('${result}','${tenant}','${job}','${attempt}','${rh}','validated','company_discovery.result.v2');
    insert into company_discovery_onboarding_drafts values('${draft}','${tenant}','${job}','${result}','${owner}','${h}','{"schema_version":"company_discovery.onboarding_draft.v2","source_result_hash":"${rh}","candidate_facts":[{"claim_id":"${id(92)}","claim_type":"public_email"},{"claim_id":"${id(91)}","claim_type":"public_phone"}]}',1);`);
  fail(`select ${prepare(prep,other)};`,"interview_owner_or_generation_changed");
  fail(`select ${prepare(prep,owner,3)};`,"interview_owner_or_generation_changed");
  fail(`select ${prepare(prep,owner,2,"c".repeat(64))};`,"interview_selected_draft_changed");
  sql(`update budget_reservations set status='active';`);
  fail(`select ${prepare()};`,"interview_prior_not_settled");
  sql(`update budget_reservations set status='settled'; update calls set provider_termination_state='active' where id='${prior}';`);
  fail(`select ${prepare()};`,"interview_prior_not_settled");
  sql(`update calls set provider_termination_state='confirmed' where id='${prior}';`);
  assert.equal(json(prepare()).replayed,false); assert.equal(json(prepare()).replayed,true);
  sql(`insert into calls(id,tenant_id,channel,session_type,status,test_memory_generation) values('${call}','${tenant}','browser','onboarding','active',2);
    insert into browser_session_requests values('${request}','${tenant}','${call}','${owner}','onboarding',2,2,'application_tts_v1','processing');`);
  fail(`select ${prepare(id(20))};`,"interview_competing_active_call");
  const resolved=json(`public.resolve_prepared_website_source(${scope})`); assert.equal(resolved.draft_readback.draft_id,draft);
  fail(`begin; update tenants set test_memory_generation=3; select public.resolve_prepared_website_source(${scope});`,"interview_call_not_owner_bound");
  fail(`begin; insert into company_discovery_onboarding_drafts select '${id(80)}',tenant_id,source_job_id,source_result_id,created_by,draft_hash,draft,2 from company_discovery_onboarding_drafts; select public.resolve_prepared_website_source(${scope});`,"interview_selected_draft_changed");
  const initialize=`select public.initialize_website_interview(${scope},'${prep}',${quote(initial)});`;
  const numericQuestion=structuredClone(initial);numericQuestion.candidateContext[0].questionPt=42;
  fail(`select public.initialize_website_interview(${scope},'${prep}',${quote(numericQuestion)});`,'interview_candidate_metadata_invalid');
  const wrongSource=structuredClone(initial);wrongSource.candidateContext[0].id=`candidate:${id(99)}`;wrongSource.candidateContext[0].coverageRefs=[`discovery.candidate.${id(99).replaceAll('-','')}`];
  fail(`select public.initialize_website_interview(${scope},'${prep}',${quote(wrongSource)});`,'interview_candidate_source_mismatch');
  const parallelSql=text=>new Promise((resolve,reject)=>{
    const p=spawn(`${bin}/psql`,["-X","-qAt","-v","ON_ERROR_STOP=1","-f","-"],{env,stdio:["pipe","pipe","pipe"]});let out="",err="";
    p.stdout.on("data",b=>out+=b);p.stderr.on("data",b=>err+=b);p.on("error",reject);p.on("close",code=>code===0?resolve(JSON.parse(out.trim())):reject(new Error(err)));p.stdin.end(`set request.jwt.claim.role='service_role';${text}`);
  });
  const concurrent=await Promise.all([parallelSql(initialize),parallelSql(initialize)]);
  assert.equal(concurrent.filter(x=>x.replayed).length,1);
  assert.equal(sql("select count(*) from website_interviews;"),"1");
  if (process.argv.includes("--red")) {
    sql(`select public.interrupt_website_interview_speech(${scope},'${"a".repeat(64)}','owner-interruption');`);
    throw new Error("RED probe unexpectedly passed");
  }
  let stored=json(`public.read_website_interview(${scope})`);
  const {runWebsiteInterruptionAndAmendmentCases}=await import('./website-interview-interruption-cases.mjs');
  await runWebsiteInterruptionAndAmendmentCases({sql,json,fail,quote,id,owner,other,tenant,call,request,stored,parallelSql});
  console.log(JSON.stringify({status:"passed",database:"isolated PostgreSQL 16",scope:"interruption/amendment migration with minimal prerequisite schema; NOT full migration gate"}));
} finally {
  if(started)run("pg_ctl",["-D",`${temp}/data`,"-m","fast","-w","stop"]);
  await rm(temp,{recursive:true,force:true});
}
