#!/usr/bin/env node
// Disposable PG16 constraint/crypto test; no network socket or inherited DB env.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const bin = "/opt/homebrew/opt/postgresql@16/bin";
const temp = await mkdtemp(path.join(os.tmpdir(), "ligou-browser-protocol3-pg-"));
const env = { PATH: "/usr/bin:/bin", LC_ALL: "C", PGHOST: temp, PGPORT: "55441", PGUSER: "speech_test", PGDATABASE: "postgres", PGCONNECT_TIMEOUT: "5" };
const run = (name, args, input) => { const r = spawnSync(`${bin}/${name}`, args, { env, input, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim(); };
const sql = input => run("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"], input);
const quote = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const hash = value => createHash("sha256").update(value).digest("hex");
let started = false;
try {
  run("initdb", ["-D", path.join(temp,"data"), "-A", "trust", "-U", "speech_test", "--no-locale", "--encoding=UTF8"]);
  run("pg_ctl", ["-D", path.join(temp,"data"), "-l", path.join(temp,"log"), "-o", `-k ${temp} -p 55441 -h ''`, "-w", "start"]); started = true;
  sql(`create role anon; create role authenticated; create role service_role;
    create schema extensions; create extension pgcrypto with schema extensions;
    create table public.browser_session_requests(id int primary key,status text,session_type text,opening_mode_requested text,opening_mode_applied text,opening_payload jsonb,call_id uuid,answer_sdp text,onboarding_protocol_version int);`);
  const oldOpening = await readFile(path.join(root,"supabase/migrations/20260903190000_company_discovery_onboarding_processing_handoff.sql"),"utf8");
  const oldProtocol = await readFile(path.join(root,"supabase/migrations/20260828185525_onboarding_resume_checkpoint.sql"),"utf8");
  const openingStart = oldOpening.indexOf("alter table public.browser_session_requests\n  drop constraint if exists browser_session_requests_opening_state_check;");
  assert(openingStart > 0);
  const openingEnd = oldOpening.indexOf("validate constraint browser_session_requests_opening_state_check;", openingStart) + "validate constraint browser_session_requests_opening_state_check;".length;
  assert(openingEnd > openingStart);
  sql(oldOpening.slice(openingStart, openingEnd));
  const protocolStart = oldProtocol.indexOf("alter table public.browser_session_requests\n  drop constraint if exists browser_session_requests_onboarding_protocol_check;");
  const protocolEnd = oldProtocol.indexOf("create or replace function public.enforce_browser_session_protocol_identity_v2()");
  assert(protocolStart > 0 && protocolEnd > protocolStart);
  sql(oldProtocol.slice(protocolStart, protocolEnd));
  const call = "33333333-3333-4333-8333-333333333333";
  const text = "Quais cidades atende?";
  const audio = Buffer.from([73,68,51,4,0]);
  const speech = { schema: "onboarding.speech.v1", actionId:"a".repeat(64), interviewId:call,callId:call,revision:0,kind:"ASK_NEXT_GAP",text,sourceDigest:"b".repeat(64),text_sha256:hash(text),audio_base64:audio.toString("base64"),audio_sha256:hash(audio),mime:"audio/mpeg",voice:"ash",tts_model:"tts-1-hd",cost_usd:0.00063 };
  const payload = {version:3,item_id:`lgs-${speech.actionId.slice(0,28)}`,speech};
  const ready = (p,protocol=3) => `insert into browser_session_requests values(1,'ready','onboarding','application_tts_v1','application_tts_v1',${quote(p)},'${call}','answer',${protocol});`;
  if (process.argv.includes("--red")) { sql(ready(payload)); throw new Error("RED unexpectedly passed"); }
  sql(await readFile(path.join(root,"supabase/migrations/20260904022004_website_interview_browser_protocol3.sql"),"utf8"));
  sql(ready(payload));
  sql("update browser_session_requests set status='cancel_requested'; delete from browser_session_requests;");
  sql(ready({...payload,speech:{...speech,interviewId:"55555555-5555-4555-8555-555555555555"}}));
  sql("delete from browser_session_requests;");
  for (const changed of [{text_sha256:"c".repeat(64)},{audio_sha256:"c".repeat(64)},{cost_usd:0},{callId:"44444444-4444-4444-8444-444444444444"},{revision:-1},{kind:"generic_chat"},{text:"x".repeat(4097)},{schema:null},{audio_base64:"bm90bXAz",audio_sha256:hash("notmp3")}]) {
    assert.throws(()=>sql(ready({...payload,speech:{...speech,...changed}})),/check constraint/);
  }
  for (const changed of [{item_id:null},{item_id:"lgo-"+"a".repeat(28)},{extra:true},{version:2}])
    assert.throws(()=>sql(ready({...payload,...changed})),/check constraint/);
  sql(`insert into browser_session_requests values(2,'processing','onboarding','application_tts_v1',null,null,'${call}',null,3);
    update browser_session_requests set status='cancel_requested' where id=2;
    update browser_session_requests set status='expired' where id=2;
    delete from browser_session_requests;`);
  const legacyText="Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Quais serviços sua empresa oferece?";
  const legacy={version:2,item_id:"lgo-a89f1f9391ab7a82b4f27f198407",text:legacyText,text_sha256:hash(legacyText),audio_base64:audio.toString("base64"),audio_sha256:hash(audio),mime:"audio/mpeg",voice:"ash",tts_model:"tts-1-hd",cost_usd:0.00321,resume_context:null};
  sql(ready(legacy,2)); sql("delete from browser_session_requests;");
  assert.throws(()=>sql(ready(legacy,3)),/check constraint/);
  assert.throws(()=>sql(ready(payload,2)),/check constraint/);
  assert.equal(sql("select count(*) from pg_constraint where conrelid='browser_session_requests'::regclass and contype='c' and not convalidated;"),"0");
  console.log("PASS protocol3 crypto/constraints, processing cancellation, no downgrade, legacy v2, validated constraints");
} finally {
  if (started) run("pg_ctl", ["-D", path.join(temp,"data"), "-m", "immediate", "-w", "stop"]);
  await rm(temp, {recursive:true,force:true});
}
