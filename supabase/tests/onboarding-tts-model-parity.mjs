// Model/rate validation against real PostgreSQL with minimal prerequisite tables.
// Temporary Unix-socket-only cluster; no provider, production, or inherited DB connection.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { speechPayloadIsInternallyValid } from '../../voice-controller/src/onboarding-speech.ts';
import { isApplicationOpeningPayload } from '../functions/browser-session/core.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await mkdtemp(path.join(tmpdir(), 'ligou-tts-model-parity-'));
const binary = process.env.LIGOU_PG_BIN ?? '/opt/homebrew/opt/postgresql@16/bin';
const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', PGHOST: directory, PGPORT: '55456', PGDATABASE: 'postgres', PGUSER: 'tts_model_test' };
const run = (name, args, input) => {
  const r = spawnSync(path.join(binary, name), args, { env, input, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw new Error(r.stderr || r.error?.message || 'local_postgres_failed');
  return r.stdout.trim();
};
const sql = text => run('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], text);
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const jq = value => `${q(JSON.stringify(value))}::jsonb`;
const hash = value => createHash('sha256').update(value).digest('hex');
const call = randomUUID(), owner = randomUUID(), request = randomUUID(), tenant = randomUUID();
const scope = [owner, call, request].map(q).join(',');
const audio = Buffer.from([73, 68, 51, 4]);
let started = false, comparisons = 0;
try {
  run('initdb', ['-D', directory + '/data', '-A', 'trust', '-U', env.PGUSER, '--no-locale', '--encoding=UTF8']);
  run('pg_ctl', ['-D', directory + '/data', '-l', directory + '/postgres.log', '-o', `-k ${directory} -h '' -p ${env.PGPORT}`, '-w', 'start']); started = true;
  sql(`create role anon; create role authenticated; create role service_role;
    create schema extensions; create extension pgcrypto with schema extensions;
    create table public.browser_session_requests(id uuid primary key, session_type text, status text, call_id uuid,
      answer_sdp text, opening_mode_requested text, opening_mode_applied text, opening_payload jsonb,
      onboarding_protocol_version integer, constraint browser_session_requests_onboarding_protocol_check check(true));
    create table public.website_interviews(interview_id uuid primary key,tenant_id uuid,digest text,state text);
    create table public.website_interview_speech(call_id uuid,action_id text,tenant_id uuid,interview_id uuid,digest text,
      action jsonb,speech_slot text,status text,payload jsonb,ready_receipt_id uuid,played_receipt_id uuid,failure_receipt_id uuid,
      primary key(call_id,action_id));
    create table public.receipts(id uuid primary key,tenant_id uuid,call_id uuid,kind text,outcome text,external_id text,payload_hash text,readback jsonb,detail jsonb);
    insert into public.website_interviews values(${q(call)},${q(tenant)},${q('b'.repeat(64))},'unfinished');
    create function public.website_interview_current(p_owner uuid,p_call uuid,p_request uuid) returns public.website_interviews
      language plpgsql as $$ declare r public.website_interviews; begin
        if p_owner<>${q(owner)}::uuid or p_request<>${q(request)}::uuid then raise exception 'fixture_scope_mismatch'; end if;
        select * into strict r from public.website_interviews where interview_id=p_call; return r; end $$;`);
  const priorOpening = await readFile(path.join(root, 'supabase/migrations/20260903190000_company_discovery_onboarding_processing_handoff.sql'), 'utf8');
  const priorCheck = priorOpening.match(/alter table public\.browser_session_requests\s+add constraint browser_session_requests_opening_state_check[\s\S]*?not valid;/i);
  assert.ok(priorCheck); sql(priorCheck[0]);
  const evidence = await readFile(path.join(root, 'supabase/migrations/20260904021654_website_interview_evidence.sql'), 'utf8');
  sql(evidence.match(/create function public\.website_interview_speech_readback\([\s\S]*?\$\$;/)[0]);
  sql(evidence.match(/create function public\.complete_website_interview_speech\([\s\S]*?\$\$;/)[0]);
  sql(await readFile(path.join(root, 'supabase/migrations/20260904022004_website_interview_browser_protocol3.sql'), 'utf8'));
  if (!process.argv.includes('--red')) sql(await readFile(path.join(root, 'supabase/migrations/20260907080117_onboarding_tts_model_rates.sql'), 'utf8'));
  const openingInsert = (payload, protocol) => `insert into public.browser_session_requests values(${q(randomUUID())},'onboarding','ready',${q(call)},'answer-sdp','application_tts_v1','application_tts_v1',${jq(payload)},${protocol});`;
  for (const text of ['Quais cidades sua empresa atende?', 'Área de São Luís 🏠 e Olinda?']) {
    for (const [model, rate] of [['tts-1', 15], ['tts-1-hd', 30]]) {
      const action = {actionId: hash(model + text), interviewId: call, callId: call, revision: 0, kind: 'ASK_NEXT_GAP', text, sourceDigest: 'b'.repeat(64)};
      const payload = {schema: 'onboarding.speech.v1', ...action, text_sha256: hash(text), audio_base64: audio.toString('base64'), audio_sha256: hash(audio), mime: 'audio/mpeg', voice: 'ash', tts_model: model, cost_usd: Number(([...text].length * rate / 1e6).toFixed(8))};
      const envelope = {version: 3, item_id: 'lgs-' + action.actionId.slice(0, 28), speech: payload};
      assert.equal(speechPayloadIsInternallyValid(payload, action), true);
      assert.equal(isApplicationOpeningPayload(envelope), true);
      assert.equal(sql(`select public.website_browser_opening_v3_valid(${jq(envelope)},${q(call)});`), 't'); comparisons++;
      sql(openingInsert(envelope, 3));
      const v2 = {version: 2, item_id: 'lgo-' + action.actionId.slice(0, 28), text, text_sha256: hash(text), audio_base64: payload.audio_base64, audio_sha256: payload.audio_sha256, mime: 'audio/mpeg', voice: 'ash', tts_model: model, cost_usd: payload.cost_usd, resume_context: null};
      sql(openingInsert(v2, 2)); comparisons++;
      sql(`insert into public.website_interview_speech(call_id,action_id,tenant_id,interview_id,digest,action,speech_slot,status) values(${q(call)},${q(action.actionId)},${q(tenant)},${q(call)},${q(action.sourceDigest)},${jq(action)},${q(action.actionId)},'preparing');`);
      const complete = p => `select public.complete_website_interview_speech(${scope},${q(action.actionId)},${jq(p)});`;
      for (const changed of [{cost_usd: Number(([...text].length * (rate === 15 ? 30 : 15) / 1e6).toFixed(8))}, {tts_model: 'gpt-4o-mini-tts'}, {tts_model: null}, {cost_usd: null}]) {
        const forged = {...payload, ...changed};
        assert.equal(speechPayloadIsInternallyValid(forged, action), false);
        assert.equal(sql(`select public.website_browser_opening_v3_valid(${jq({...envelope, speech: forged})},${q(call)});`), 'f');
        assert.throws(() => sql(complete(forged)), /interview_speech_(payload|cost)_invalid/);
        assert.throws(() => sql(openingInsert({...v2, ...changed}, 2)), /check constraint/); comparisons++;
      }
      assert.equal(JSON.parse(sql(complete(payload))).status, 'ready');
      assert.deepEqual(JSON.parse(sql(complete(payload))).payload, payload);
      const other = model === 'tts-1' ? 'tts-1-hd' : 'tts-1';
      assert.throws(() => sql(complete({...payload, tts_model: other, cost_usd: Number(([...text].length * (rate === 15 ? 30 : 15) / 1e6).toFixed(8))})), /interview_speech_payload_conflict/); comparisons++;
    }
  }
  console.log(JSON.stringify({status: 'PASS', postgres: sql('show server_version;'), modelRateComparisons: comparisons, originalReceiptImmutable: true, providerCalls: 0, productionMutations: 0}));
} finally {
  if (started) run('pg_ctl', ['-D', directory + '/data', '-m', 'fast', '-w', 'stop']);
  await rm(directory, {recursive: true, force: true});
}
