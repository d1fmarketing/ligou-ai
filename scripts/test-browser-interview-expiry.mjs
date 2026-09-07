import {fileURLToPath} from 'node:url';
import path from 'node:path';
import{spawnSync}from'node:child_process';import{mkdtemp,readFile,rm}from'node:fs/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),bin=process.env.LIGOU_PG_BIN||'/opt/homebrew/opt/postgresql@16/bin',dir=await mkdtemp('/private/tmp/resume-expiry-pg-');const env={PATH:'/usr/bin:/bin',LC_ALL:'C',PGHOST:dir,PGPORT:'55448',PGDATABASE:'postgres',PGUSER:'postgres'};const run=(n,a,input)=>{const r=spawnSync(bin+'/'+n,a,{env,input,encoding:'utf8'});if(r.status)throw Error(r.stderr||r.stdout);return r.stdout.trim()};const sql=s=>run('psql',['-XqAt','-v','ON_ERROR_STOP=1','-f','-'],s);let up=false;
try{run('initdb',['-D',dir+'/data','-A','trust','-U','postgres','--no-locale','--encoding=UTF8']);run('pg_ctl',['-D',dir+'/data','-l',dir+'/log','-o',`-k ${dir} -h '' -p 55448`,'-w','start']);up=true;
sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
create table tenants(id uuid primary key,owner_user_id uuid,test_memory_generation bigint);
create table calls(id uuid primary key,tenant_id uuid,channel text,session_type text,model text,status text,started_at timestamptz,ended_at timestamptz,openai_call_id text,test_memory_generation bigint,provider_termination_state text,provider_termination_mode text,provider_termination_attempt_id uuid,provider_termination_attempted_at timestamptz);
create table budget_reservations(id uuid primary key,call_id uuid,tenant_id uuid,status text);
create table browser_session_requests(call_id uuid,tenant_id uuid,user_id uuid,test_memory_generation bigint,status text,answer_sdp text);
create table website_interviews(current_call_id uuid,agenda jsonb);
insert into tenants values('99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000002',2);
insert into calls values('99000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000001','browser','onboarding','gpt-realtime-2.1','ended',now()-interval '121 minutes',now()-interval '120 minutes','rtc_fixture',2,'external_evidence_required','hangup','99000000-0000-4000-8000-000000000004',now()-interval '120 minutes');
insert into budget_reservations values(gen_random_uuid(),'99000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000001','settled');
insert into browser_session_requests values('99000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000002',2,'ready','v=0');insert into website_interviews values('99000000-0000-4000-8000-000000000003','{"ownerTurns":[],"progress":"preserved"}');set request.jwt.claim.role='service_role';`);
if(!process.argv.includes('--red'))sql(await readFile(root+'/supabase/migrations/20260907022111_browser_interview_expiry_receipts.sql','utf8'));
console.log(sql(await readFile(root+'/supabase/tests/browser-interview-expiry.sql','utf8')));
}finally{if(up)run('pg_ctl',['-D',dir+'/data','-m','fast','-w','stop']);await rm(dir,{recursive:true,force:true});}
