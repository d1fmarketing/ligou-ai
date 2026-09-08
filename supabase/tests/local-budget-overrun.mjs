#!/usr/bin/env node
// Disposable PG16 focused regression, not a replacement for the full PG17 gate.
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=new URL('../../',import.meta.url),bin='/opt/homebrew/opt/postgresql@16/bin';
const temp=await mkdtemp(path.join(os.tmpdir(),'ligou-budget-overrun-pg-'));
const env={PATH:'/usr/bin:/bin',LC_ALL:'C',PGHOST:temp,PGPORT:'55445',PGDATABASE:'postgres',PGUSER:'budget_test',PGCONNECT_TIMEOUT:'5'};
const run=(name,args,input)=>{const result=spawnSync(`${bin}/${name}`,args,{env,input,encoding:'utf8'});if(result.status!==0)throw Error(`${name}: ${result.stderr||result.stdout}`);return result.stdout.trim();};
const sql=text=>run('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-f','-'],text);
const migration=name=>readFile(new URL(`supabase/migrations/${name}`,root),'utf8');
let started=false;
try{
 run('initdb',['-D',`${temp}/data`,'-A','trust','-U','budget_test','--no-locale','--encoding=UTF8']);
 run('pg_ctl',['-D',`${temp}/data`,'-l',`${temp}/postgres.log`,'-o',`-k ${temp} -h '' -p 55445`,'-w','start']);started=true;
 sql(`create role anon;create role authenticated;create role service_role;create schema auth;
  create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
  create table public.tenants(id uuid primary key,slug text,name text,daily_budget_usd numeric,timezone text,session_max_minutes int default 15);
  create table public.calls(id uuid primary key,tenant_id uuid,session_type text,status text,model text,ended_at timestamptz,duration_seconds int,cost_estimate_usd numeric,
   provider_termination_state text,provider_termination_attempt_id uuid,provider_usage_state text,usage_tokens jsonb);
  create table public.budget_reservations(id uuid primary key default gen_random_uuid(),tenant_id uuid,call_id uuid unique,budget_day date,reserved_cost_usd numeric,reserved_minutes numeric,
   status text default 'active',outcome text,final_cost_usd numeric,final_minutes numeric,settled_at timestamptz,reconcile_attempts int default 0);
  create table public.usage_ledger(id uuid primary key default gen_random_uuid(),tenant_id uuid,call_id uuid,kind text,cost_usd numeric,minutes numeric,detail jsonb,budget_reservation_id uuid);
  create unique index budget_event_once on public.usage_ledger(budget_reservation_id,kind) where budget_reservation_id is not null;`);
 const reserve=await migration('20260828185525_onboarding_resume_checkpoint.sql');
 const grant='grant execute on function public.reserve_call_budget(uuid,uuid,numeric)\n  to service_role;';
 sql(reserve.slice(reserve.indexOf('create or replace function public.reserve_call_budget('),reserve.indexOf(grant)+grant.length));
 const settlement=await migration('20260822063000_exhausted_attempt_unblocks_settlement.sql');
 sql(settlement.slice(settlement.indexOf('create or replace function public.settle_unresolved_call_budget('),settlement.indexOf('create or replace function public.claim_budget_reconciliation(')));
 if(!process.argv.includes('--red'))sql(await migration('20260908185023_observed_budget_overrun_settlement.sql'));
 sql('begin;'+await readFile(new URL('supabase/tests/database/budget-observed-overrun-cases.inc',root),'utf8')+'rollback;');
 console.log(JSON.stringify({status:'passed',database:'isolated PostgreSQL16; actual settlement/reservation functions; fullPG17 gate remains separate',rejectedCases:10,
  exactObservedFloor:8.2209408,originalReservation:7.5,dailyBudget:15,providerUsageState:'unknown',duplicateLedgerEvents:0,futureAdmissionBlocked:true,legacyEstimatePreserved:true,providerCalls:0}));
}finally{
 if(started)run('pg_ctl',['-D',`${temp}/data`,'-m','immediate','-w','stop']);
 await rm(temp,{recursive:true,force:true});
}
