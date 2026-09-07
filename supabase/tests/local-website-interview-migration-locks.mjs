#!/usr/bin/env node
// Actual PostgreSQL concurrency regression. Disposable Unix-socket-only cluster;
// no inherited database credentials, network listener, or production SQL.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const bin='/opt/homebrew/opt/postgresql@16/bin';
const directory=await mkdtemp(path.join(os.tmpdir(),'ligou-migration-lock-'));
const env={PATH:'/usr/bin:/bin',LC_ALL:'C',PGHOST:directory,PGPORT:'55443',PGDATABASE:'postgres',PGUSER:'migration_lock_test',PGCONNECT_TIMEOUT:'5',PGOPTIONS:'-c statement_timeout=8000 -c deadlock_timeout=100ms'};
const run=(name,args,input)=>{
 const result=spawnSync(path.join(bin,name),args,{env,input,encoding:'utf8',timeout:15000});
 if(result.status!==0)throw new Error(`${name}: ${result.stderr||result.stdout||result.error?.message}`);
 return result.stdout.trim();
};
const sql=text=>run('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-f','-'],text);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sessions=new Set();
function connection(name){
 const child=spawn(path.join(bin,'psql'),['-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-f','-'],{env,stdio:['pipe','pipe','pipe']});
 sessions.add(child);let stdout='',stderr='',done=false;
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
 const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{done=true;sessions.delete(child);resolve({code,stdout,stderr});});});
 child.stdin.on('error',()=>{});
 const write=text=>child.stdin.write(text+'\n');
 write(`set application_name='${name}';`);
 return {write,end:()=>child.stdin.end(),completion,output:()=>stdout,done:()=>done};
}
async function until(predicate,label){
 const deadline=performance.now()+5000;
 while(!predicate()){if(performance.now()>=deadline)throw new Error(`concurrency_gate_timeout:${label}`);await delay(10);}
}
async function interleavedMigration(prefix,label){
 sql('drop table if exists public.website_interview_speech;drop table if exists public.website_interviews;create table public.website_interviews(id integer primary key);create table public.website_interview_speech(id integer primary key,interview_id integer references public.website_interviews(id));');
 const reader=connection(`lock_reader_${label}`),migration=connection(`lock_migration_${label}`);
 reader.write("begin;lock table public.website_interviews in access share mode;select 'parent_read_held';");
 await until(()=>reader.output().includes('parent_read_held'),`${label}:reader_parent`);
 migration.write(`${prefix}\nalter table public.website_interview_speech add column lock_probe integer;alter table public.website_interviews add column lock_probe integer;commit;`);
 migration.end();
 await until(()=>sql(`select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='lock_migration_${label}' and l.relation='public.website_interviews'::regclass and not l.granted);`)==='t',`${label}:migration_waiting_parent`);
 // In the old order migration already owns speech. In the candidate order it
 // has waited on the parent before taking speech, so this reader can finish.
 reader.write('select count(*) from public.website_interview_speech;commit;');reader.end();
 const results=await Promise.all([reader.completion,migration.completion]);
 return {results,deadlocks:results.filter(result=>/40P01.*deadlock detected|deadlock detected/.test(result.stderr)).length};
}
let started=false;
try{
 run('initdb',['-D',path.join(directory,'data'),'-A','trust','-U',env.PGUSER,'--no-locale','--encoding=UTF8']);
 run('pg_ctl',['-D',path.join(directory,'data'),'-l',path.join(directory,'postgres.log'),'-o',`-k ${directory} -h '' -p ${env.PGPORT}`,'-w','start']);started=true;
 const previous=await interleavedMigration('begin;','previous');
 assert.equal(previous.deadlocks,1,'the previous speech-first order must reproduce a real PostgreSQL deadlock');
 assert.deepEqual(previous.results.map(result=>result.code).sort(),[0,3]);
 const source=await readFile(new URL('../migrations/20260907033624_website_interview_interruptions_and_amendments.sql',import.meta.url),'utf8');
 const marker=source.indexOf('-- An interrupted rendition');assert.ok(marker>0);
 const preamble=source.slice(0,marker);
 const candidate=await interleavedMigration(preamble,'candidate');
 assert.equal(candidate.deadlocks,0,'candidate preamble must let parent-first reader and migration both finish');
 assert.deepEqual(candidate.results.map(result=>result.code),[0,0]);
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name in ('website_interviews','website_interview_speech') and column_name='lock_probe';"),'2');
 assert.match(preamble,/set\s+local\s+lock_timeout\s*=\s*'5s'/i,'production preamble must bound lock acquisition');
 const busyReader=connection('lock_reader_busy'),boundedMigration=connection('lock_migration_busy');
 busyReader.write("begin;lock table public.website_interviews in access share mode;select 'busy_parent_held';");
 await until(()=>busyReader.output().includes('busy_parent_held'),'busy:reader_parent');
 const began=performance.now();
 boundedMigration.write(`${preamble}\nalter table public.website_interview_speech add column timeout_probe integer;commit;`);boundedMigration.end();
 const timedOut=await boundedMigration.completion,elapsedMs=performance.now()-began;
 busyReader.write('commit;');busyReader.end();await busyReader.completion;
 assert.equal(timedOut.code,3);assert.match(timedOut.stderr,/55P03:.*lock timeout/);
 assert.ok(elapsedMs>=4500 && elapsedMs<7500,`actual five-second lock timeout observed at ${elapsedMs} ms`);
 assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='website_interview_speech' and column_name='timeout_probe';"),'0','timeout leaves later DDL unapplied');
 console.log(JSON.stringify({status:'PASS',postgres:sql('show server_version;'),previousOrder:{deadlocks:previous.deadlocks,exitCodes:previous.results.map(result=>result.code)},candidateOrder:{deadlocks:candidate.deadlocks,exitCodes:candidate.results.map(result=>result.code)},boundedWait:{sqlState:'55P03',elapsedMs,ddlApplied:false},transport:'isolated Unix socket only',productionMutations:0}));
}finally{
 for(const child of sessions){child.stdin.destroy();child.kill('SIGKILL');}
 if(started)run('pg_ctl',['-D',path.join(directory,'data'),'-m','immediate','-w','stop']);
 await rm(directory,{recursive:true,force:true});
}
