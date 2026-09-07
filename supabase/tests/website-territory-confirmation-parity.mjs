import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOnboardingAgenda, applyVerifiedOwnerTurn } from '../../voice-controller/src/onboarding-agenda.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await mkdtemp(path.join(tmpdir(), 'ligou-territory-confirmation-'));
const binary = process.env.LIGOU_PG_BIN ?? '/opt/homebrew/opt/postgresql@16/bin';
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', PGHOST: directory, PGPORT: '55454', PGDATABASE: 'postgres', PGUSER: 'postgres' };
const run = (command, args, input) => {
  const result = spawnSync(path.join(binary, command), args, { env, input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'local_postgres_failed');
  return result.stdout.trim();
};
const sql = text => run('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], text);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
let started = false;
try {
  run('initdb', ['-D', directory + '/data', '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8']);
  run('pg_ctl', ['-D', directory + '/data', '-l', directory + '/postgres.log', '-o', `-k ${directory} -h '' -p 55454`, '-w', 'start']); started = true;
  sql('create role anon; create role authenticated; create role service_role; create schema extensions; create extension pgcrypto with schema extensions;');
  const canonical = await readFile(path.join(root, 'supabase/migrations/20260826161435_onboarding_v2_reconciliation.sql'), 'utf8');
  sql(canonical.match(/create or replace function public\.onboarding_canonical_json_v1\([\s\S]*?\$\$;/)[0]);
  const previous = await readFile(path.join(root, 'supabase/migrations/20260904015214_website_interview_agenda_foundation.sql'), 'utf8');
  sql(previous.match(/create function public\.website_interview_action\([\s\S]*?\$\$;/)[0]);
  sql('revoke all on function public.website_interview_action(jsonb,text) from public,anon,authenticated,service_role;');
  const acl = sql("select proacl::text from pg_proc where oid='public.website_interview_action(jsonb,text)'::regprocedure;");
  if (!process.argv.includes('--red')) {
    sql(await readFile(path.join(root, 'supabase/migrations/20260907062057_website_interview_territory_confirmation.sql'), 'utf8'));
    assert.equal(sql("select proacl::text from pg_proc where oid='public.website_interview_action(jsonb,text)'::regprocedure;"), acl);
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(sql(`select has_function_privilege('${role}','public.website_territory_confirmation(jsonb)','EXECUTE');`), 'f');
    assert.equal(sql("select provolatile from pg_proc where oid='public.website_territory_confirmation(jsonb)'::regprocedure;"), 's');
  }
  const binding = { callId: 'call-1', interviewId: 'interview-1', draftId: 'draft-1', draftHash: 'a'.repeat(64), sourceResultId: 'result-1', sourceResultHash: 'b'.repeat(64) };
  const initial = () => createOnboardingAgenda(binding, ['area', 'next', 'last'].map(id => ({ id, source: 'missing_website_information', subject: id,
    questionPt: id === 'next' ? 'Qual é o fuso horário?' : `Qual a política de ${id}?`, coverageRefs: [id === 'area' ? 'area.coverage' : id], relatedItemIds: [], blocking: true })));
  const cases = JSON.parse(await readFile(path.join(root, 'voice-controller/test/fixtures/website-territory-confirmation-cases.json'), 'utf8'));
  let comparisons = 0;
  const compare = (agenda, itemId, text) => {
    const transition = applyVerifiedOwnerTurn(agenda, { type: 'verified_owner_turn', binding, turnId: `turn-${agenda.revision}`, text, proposal: { kind: 'answer', itemId } });
    const actual = JSON.parse(sql(`select public.website_interview_action(${quote(JSON.stringify(transition.agenda))}::jsonb,'answer');`));
    assert.deepEqual(actual, transition.action, text); comparisons++;
    return transition.agenda;
  };
  for (const entry of cases) {
    const agenda = compare(initial(), 'area', entry.text);
    compare(agenda, 'next', 'Este novo turno não fala sobre território.');
  }
  console.log(JSON.stringify({ status: 'PASS', actionComparisons: comparisons, sqlTsParity: true, privateHelper: true, existingActionAclPreserved: true, remoteActions: 0 }, null, 2));
} finally {
  if (started) run('pg_ctl', ['-D', directory + '/data', '-m', 'fast', '-w', 'stop']);
  await rm(directory, { recursive: true, force: true });
}
