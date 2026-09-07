// Focused, disposable PostgreSQL proof of the shared approval grammar.
// --red deliberately uses the prior SQL helper and must reject the new cases.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyWebsiteApprovalTranscript } from '../../voice-controller/src/onboarding-agenda-coordinator.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await mkdtemp(path.join(tmpdir(), 'ligou-approval-grammar-'));
const binary = process.env.LIGOU_PG_BIN ?? '/opt/homebrew/opt/postgresql@16/bin';
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', PGHOST: directory,
  PGPORT: '55453', PGDATABASE: 'postgres', PGUSER: 'postgres', PGCONNECT_TIMEOUT: '5' };
const run = (command, args, input) => {
  const result = spawnSync(path.join(binary, command), args, { env, input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'local_postgres_command_failed');
  return result.stdout.trim();
};
const sql = text => run('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], text);
const quote = text => `'${text.replaceAll("'", "''")}'`;
let started = false;
try {
  run('initdb', ['-D', path.join(directory, 'data'), '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8']);
  run('pg_ctl', ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'), '-o', `-k ${directory} -h '' -p 55453`, '-w', 'start']);
  started = true;
  const previous = await readFile(path.join(root, 'supabase/migrations/20260904021654_website_interview_evidence.sql'), 'utf8');
  const oldHelper = previous.match(/create function public\.website_interview_positive_approval\(p_text text\) returns boolean[\s\S]*?\$\$;/)?.[0];
  assert.ok(oldHelper, 'previous grammar is retained for reproducible RED');
  sql(oldHelper);
  sql("create role anon; create role authenticated; create role service_role; revoke all on function public.website_interview_positive_approval(text) from public; grant execute on function public.website_interview_positive_approval(text) to service_role;");
  const beforeAcl = sql("select proacl::text from pg_proc where oid='public.website_interview_positive_approval(text)'::regprocedure;");
  if (!process.argv.includes('--red')) sql(await readFile(path.join(root, 'supabase/migrations/20260907042511_website_interview_natural_current_approval.sql'), 'utf8'));
  assert.equal(sql("select proacl::text from pg_proc where oid='public.website_interview_positive_approval(text)'::regprocedure;"), beforeAcl);
  const cases = JSON.parse(await readFile(path.join(root, 'voice-controller/test/fixtures/website-approval-cases.json'), 'utf8'));
  for (const entry of cases) {
    const positive = sql(`select public.website_interview_positive_approval(${quote(entry.text)});`) === 't';
    assert.equal(positive, entry.kind === 'approval', `SQL classification: ${entry.text}`);
    assert.equal(classifyWebsiteApprovalTranscript(entry.text), entry.kind, `TS classification: ${entry.text}`);
  }
  assert.equal(sql('select public.website_interview_positive_approval(null);'), 'f');
  assert.equal(sql("select provolatile='i' and not prosecdef from pg_proc where oid='public.website_interview_positive_approval(text)'::regprocedure;"), 't');
  console.log(JSON.stringify({ status: 'PASS', cases: cases.length, positive: cases.filter(entry => entry.kind === 'approval').length,
    negative: cases.filter(entry => entry.kind !== 'approval').length, sqlTsParity: true, database: 'disposable Unix-socket PostgreSQL', remoteActions: 0 }, null, 2));
} finally {
  if (started) run('pg_ctl', ['-D', path.join(directory, 'data'), '-m', 'fast', '-w', 'stop']);
  await rm(directory, { recursive: true, force: true });
}
