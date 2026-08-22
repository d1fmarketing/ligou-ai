#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOCAL_PROJECT_ID = "ligou-v0-1-rc1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PRODUCTION_WORDS = /(prod|production|live|staging)/i;

function connectionFromEnvironment(env = process.env) {
  const connection = {
    host: env.PGHOST ?? "",
    port: env.PGPORT ?? "",
    database: env.PGDATABASE ?? "",
    user: env.PGUSER ?? "",
    password: env.PGPASSWORD ?? "",
    projectId: env.LIGOU_LOCAL_PROJECT_ID ?? "",
    psqlBin: env.LIGOU_PSQL_BIN ?? "psql",
  };
  if (!LOOPBACK_HOSTS.has(connection.host)) throw new Error("local concurrency gate requires a loopback database host");
  if (connection.projectId !== LOCAL_PROJECT_ID || PRODUCTION_WORDS.test(connection.projectId)) {
    throw new Error("local concurrency gate requires the disposable RC1 project");
  }
  if (!/^\d{2,5}$/.test(connection.port) || !connection.database || PRODUCTION_WORDS.test(connection.database)) {
    throw new Error("local concurrency gate rejected the database identity");
  }
  if (!connection.user || !connection.password) throw new Error("local concurrency gate database credentials are missing");
  if (connection.psqlBin !== "psql"
      && (!path.isAbsolute(connection.psqlBin) || path.basename(connection.psqlBin) !== "psql")) {
    throw new Error("local concurrency gate rejected the psql executable");
  }
  return connection;
}

function redact(value, password) {
  return String(value).split(password).join("[redacted]").replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-db-url]");
}

function startSql(connection, isolatedHome, sql) {
  const child = spawn(connection.psqlBin, [
    "-X",
    "--set=ON_ERROR_STOP=1",
    "--no-align",
    "--tuples-only",
    "--quiet",
    "--file=-",
  ], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: isolatedHome,
      LANG: "C",
      PGAPPNAME: "ligou_rc1_local_gate",
      PGCONNECT_TIMEOUT: "5",
      PGHOST: connection.host,
      PGPORT: connection.port,
      PGDATABASE: connection.database,
      PGUSER: connection.user,
      PGPASSWORD: connection.password,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    for (const waiter of waiters.splice(0)) {
      if (stdout.includes(waiter.marker)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const startedAt = Date.now();
  child.stdin.end(sql);

  return {
    waitFor(marker, timeoutMs = 5_000) {
      if (stdout.includes(marker)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `SQL marker timeout: ${marker}; stdout=${redact(stdout, connection.password)}; stderr=${redact(stderr, connection.password)}`,
        )), timeoutMs);
        waiters.push({ marker, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    },
    done: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({
        code,
        stdout: stdout.trim(),
        stderr: redact(stderr.trim(), connection.password),
        durationMs: Date.now() - startedAt,
      }));
    }),
  };
}

async function runSql(connection, isolatedHome, sql) {
  return startSql(connection, isolatedHome, sql).done;
}

function requireSuccess(result, label) {
  assert.equal(result.code, 0, `${label} failed: ${result.stderr || "psql exited non-zero"}`);
  return result.stdout;
}

function scalar(result, label) {
  return requireSuccess(result, label).split("\n").filter(Boolean).at(-1) ?? "";
}

function serviceTransaction(statement) {
  return `begin;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
do $$ begin
  if current_user <> 'service_role' then raise exception 'service_role_impersonation_failed'; end if;
end $$;
${statement}
commit;
`;
}

const slot = {
  tenant: "20000000-0000-4000-8000-000000000001",
  power: "20000000-0000-4000-8000-000000000010",
  rule: "20000000-0000-4000-8000-000000000020",
  group: "20000000-0000-4000-8000-000000000021",
  call1: "20000000-0000-4000-8000-000000000031",
  call2: "20000000-0000-4000-8000-000000000032",
  booking1: "20000000-0000-4000-8000-000000000041",
  booking2: "20000000-0000-4000-8000-000000000042",
  intent1: "20000000-0000-4000-8000-000000000051",
  intent2: "20000000-0000-4000-8000-000000000052",
  claim1: "20000000-0000-4000-8000-000000000061",
  claim2: "20000000-0000-4000-8000-000000000062",
};

async function parallelBudgetReservationCap(connection, home) {
  const tenant = "10000000-0000-4000-8000-000000000001";
  const call1 = "10000000-0000-4000-8000-000000000011";
  const call2 = "10000000-0000-4000-8000-000000000012";
  requireSuccess(await runSql(connection, home, `
    insert into public.tenants (id, slug, name, status, daily_budget_usd)
    values ('${tenant}', 'synthetic-budget-cap', 'Synthetic Budget Cap', 'active', 10);
    insert into public.calls (id, tenant_id, channel, session_type, status)
    values ('${call1}', '${tenant}', 'eval', 'customer', 'active'),
           ('${call2}', '${tenant}', 'eval', 'customer', 'active');
  `), "budget fixture");

  const first = startSql(connection, home, serviceTransaction(`
    select public.reserve_call_budget('${tenant}', '${call1}', 6);
    select 'LOCK_HELD';
    select pg_sleep(0.75);
  `));
  await first.waitFor("LOCK_HELD");
  const secondStartedAt = Date.now();
  const secondPromise = runSql(connection, home, serviceTransaction(`
    select public.reserve_call_budget('${tenant}', '${call2}', 6);
  `));
  const [firstResult, secondResult] = await Promise.all([first.done, secondPromise]);
  requireSuccess(firstResult, "first budget reservation");
  assert.notEqual(secondResult.code, 0, "the waiter must fail once the serialized reservation reaches the cap");
  assert.match(secondResult.stderr, /budget_exceeded/);
  assert.ok(Date.now() - secondStartedAt >= 500, "the competing reservation must wait on the tenant lock");
  assert.equal(scalar(await runSql(connection, home, `
    select count(*)::text || ':' || coalesce(sum(reserved_cost_usd), 0)::text
    from public.budget_reservations where tenant_id = '${tenant}'
  `), "budget invariant"), "1:6");
}

async function setupSlotAuthority(connection, home) {
  requireSuccess(await runSql(connection, home, `
    insert into public.tenants (id, slug, name, status, daily_budget_usd)
    values ('${slot.tenant}', 'synthetic-slot-exclusion', 'Synthetic Slot Exclusion', 'active', 50);
    insert into public.rules (id, tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured)
    values ('${slot.rule}', '${slot.tenant}', '${slot.group}', 1, 'onboarding', 'servico', 'aprovado', 'preco',
      'Synthetic plumbing price', '{"service_type":"plumbing","price_min":100}'::jsonb);
    insert into public.powers (id, tenant_id, subject, capability, resource, conditions, monetary_limit)
    values ('${slot.power}', '${slot.tenant}', 'voice_agent', 'create_booking', 'plumbing', '{}', 500);
    insert into public.calls (id, tenant_id, channel, session_type, status)
    values ('${slot.call1}', '${slot.tenant}', 'eval', 'customer', 'active'),
           ('${slot.call2}', '${slot.tenant}', 'eval', 'customer', 'active');
    insert into public.bookings (
      id, tenant_id, call_id, client_name, contact, service_type, price_agreed,
      slot_start, slot_end, status, idempotency_key
    ) values
      ('${slot.booking1}', '${slot.tenant}', '${slot.call1}', 'Alpha', '5550100', 'plumbing', 120,
       '2030-09-01T17:00:00Z', '2030-09-01T18:00:00Z', 'proposed', 'synthetic-booking-one'),
      ('${slot.booking2}', '${slot.tenant}', '${slot.call2}', 'Beta', '5550101', 'plumbing', 120,
       '2030-09-01T17:30:00Z', '2030-09-01T18:30:00Z', 'proposed', 'synthetic-booking-two');
    insert into public.action_intents (
      id, tenant_id, call_id, booking_id, kind, payload, policy_snapshot, idempotency_key,
      status, execution_mode, lease_until, claim_token, claim_version, claimed_by
    )
    select valueset.intent_id, b.tenant_id, b.call_id, b.id, 'calendar_book',
      jsonb_build_object(
        'summary', b.service_type || ' — ' || coalesce(b.client_name, 'customer') || ' ($' || b.price_agreed::text || ')',
        'description', 'Booked by Ligou. Contact: ' || coalesce(b.contact, '?') || '. Call ' || b.call_id::text || '.',
        'start_iso', b.slot_start, 'end_iso', coalesce(b.slot_end, b.slot_start)
      ),
      jsonb_build_object('power_id', '${slot.power}', 'rule_id', '${slot.rule}',
        'auth_epoch', t.auth_epoch, 'policy_epoch', t.policy_epoch, 'price_confirmed', b.price_agreed),
      valueset.intent_key, 'running', 'write', now() + interval '10 minutes', valueset.claim_token, 1, 'synthetic-worker'
    from (values
      ('${slot.booking1}'::uuid, '${slot.intent1}'::uuid, '${slot.claim1}'::uuid, 'synthetic-intent-one'),
      ('${slot.booking2}'::uuid, '${slot.intent2}'::uuid, '${slot.claim2}'::uuid, 'synthetic-intent-two')
    ) valueset(booking_id, intent_id, claim_token, intent_key)
    join public.bookings b on b.id = valueset.booking_id
    join public.tenants t on t.id = b.tenant_id;
    update public.bookings b
    set intent_id = ai.id
    from public.action_intents ai
    where ai.booking_id = b.id and ai.id in ('${slot.intent1}', '${slot.intent2}');
  `), "slot authority fixture");
}

async function parallelSlotExclusion(connection, home) {
  await setupSlotAuthority(connection, home);
  const [left, right] = await Promise.all([
    runSql(connection, home, serviceTransaction(`select coalesce(public.prepare_booking_provider_write('${slot.intent1}', '${slot.claim1}')::text, 'NULL');`)),
    runSql(connection, home, serviceTransaction(`select coalesce(public.prepare_booking_provider_write('${slot.intent2}', '${slot.claim2}')::text, 'NULL');`)),
  ]);
  requireSuccess(left, "first slot preparation");
  requireSuccess(right, "second slot preparation");
  assert.deepEqual([left.stdout.includes('"ready": true'), right.stdout.includes('"ready": true')].sort(), [false, true]);
  assert.equal(scalar(await runSql(connection, home, `
    select (select count(*) from public.booking_slot_leases where tenant_id = '${slot.tenant}')::text || ':' ||
           (select count(*) from public.action_intents where id in ('${slot.intent1}','${slot.intent2}') and status = 'failed')::text || ':' ||
           (select count(*) from public.bookings where id in ('${slot.booking1}','${slot.booking2}') and status = 'failed')::text
  `), "slot exclusion invariant"), "1:1:1");
}

async function staleAndCurrentWorkerFence(connection, home) {
  const call = "20000000-0000-4000-8000-000000000033";
  const booking = "20000000-0000-4000-8000-000000000043";
  const intent = "20000000-0000-4000-8000-000000000053";
  const stale = "20000000-0000-4000-8000-000000000063";
  requireSuccess(await runSql(connection, home, `
    insert into public.calls (id, tenant_id, channel, session_type, status)
    values ('${call}', '${slot.tenant}', 'eval', 'customer', 'active');
    insert into public.bookings (
      id, tenant_id, call_id, client_name, contact, service_type, price_agreed,
      slot_start, slot_end, status, idempotency_key
    ) values ('${booking}', '${slot.tenant}', '${call}', 'Fence', '5550102', 'plumbing', 120,
      '2030-09-02T17:00:00Z', '2030-09-02T18:00:00Z', 'proposed', 'synthetic-booking-fence');
    insert into public.action_intents (
      id, tenant_id, call_id, booking_id, kind, payload, policy_snapshot, idempotency_key,
      status, execution_mode, lease_until, claim_token, claim_version, claimed_by, attempts
    )
    select '${intent}', b.tenant_id, b.call_id, b.id, 'calendar_book',
      jsonb_build_object(
        'summary', b.service_type || ' — ' || coalesce(b.client_name, 'customer') || ' ($' || b.price_agreed::text || ')',
        'description', 'Booked by Ligou. Contact: ' || coalesce(b.contact, '?') || '. Call ' || b.call_id::text || '.',
        'start_iso', b.slot_start, 'end_iso', coalesce(b.slot_end, b.slot_start)
      ),
      jsonb_build_object('power_id', '${slot.power}', 'rule_id', '${slot.rule}',
        'auth_epoch', t.auth_epoch, 'policy_epoch', t.policy_epoch, 'price_confirmed', b.price_agreed),
      'synthetic-intent-fence', 'running', 'write', now() - interval '1 second', '${stale}', 1, 'stale-worker', 1
    from public.bookings b join public.tenants t on t.id = b.tenant_id where b.id = '${booking}';
  `), "worker fence fixture");

  const current = scalar(await runSql(connection, home, serviceTransaction(`
    select claim_token::text from public.claim_intent('current-worker') where id = '${intent}';
  `)), "worker reclaim");
  assert.match(current, /^[a-f0-9-]{36}$/);
  assert.notEqual(current, stale);
  const [staleResult, currentResult] = await Promise.all([
    runSql(connection, home, serviceTransaction(`select public.transition_claimed_intent('${intent}', '${stale}', 'defer', 'synthetic stale fence', 3600);`)),
    runSql(connection, home, serviceTransaction(`select public.transition_claimed_intent('${intent}', '${current}', 'defer', 'synthetic current fence', 3600);`)),
  ]);
  assert.deepEqual([scalar(staleResult, "stale worker transition"), scalar(currentResult, "current worker transition")].sort(), ["f", "t"]);
  assert.equal(scalar(await runSql(connection, home, `
    select status || ':' || (lease_until is null)::text || ':' || (claim_token = '${current}'::uuid)::text
    from public.action_intents where id = '${intent}';
  `), "worker fence invariant"), "queued:true:true");
  requireSuccess(await runSql(connection, home, `update public.action_intents set status = 'failed' where id = '${intent}';`), "worker fence cleanup");
}

function acceptedDeliverySql(intentId, attemptKey, outcome = "accepted", claimToken = null) {
  const claimSql = claimToken ? `'${claimToken}'::uuid` : "null::uuid";
  if (outcome !== "accepted") {
    return serviceTransaction(`select public.record_booking_delivery(
      '${intentId}', ${claimSql}, '${attemptKey}', 'unknown', null, null, null,
      '{"error":"synthetic reconciliation"}'::jsonb, null
    )::text;`);
  }
  return serviceTransaction(`
    with provider_input as (
      select public.get_booking_provider_input('${intentId}') as input
    ), expected as (
      select
        jsonb_build_object(
          'provider', 'fake_calendar', 'account_id', 'synthetic-account', 'calendar_id', 'synthetic-calendar',
          'summary', input->>'summary', 'description', input->>'description',
          'start', (input->>'startIso')::timestamptz, 'end', (input->>'endIso')::timestamptz, 'status', 'confirmed',
          'payload_hash', 'synthetic-payload-hash',
          'private', jsonb_build_object(
            'ligouKey', input->>'idempotencyKey', 'ligouProvider', 'fake_calendar', 'ligouTenantId', input->>'tenantId',
            'ligouBookingId', input->>'bookingId', 'ligouCalendarId', 'synthetic-calendar',
            'ligouAccountId', 'synthetic-account', 'ligouPayloadHash', 'synthetic-payload-hash'
          )
        ) as expected
      from provider_input
    )
    select public.record_booking_delivery(
      '${intentId}', ${claimSql}, '${attemptKey}', 'accepted', 'synthetic-event-id',
      jsonb_build_object(
        'id', 'synthetic-event-id', 'summary', expected->>'summary', 'description', expected->>'description',
        'start', jsonb_build_object('dateTime', expected->>'start'),
        'end', jsonb_build_object('dateTime', expected->>'end'),
        'status', 'confirmed',
        'extendedProperties', jsonb_build_object('private', expected->'private')
      ),
      'synthetic-payload-hash', '{"request":"synthetic"}'::jsonb, expected
    )::text
    from expected;
  `);
}

async function duplicateDeliveryAndReconciliation(connection, home) {
  const winner = scalar(await runSql(connection, home, `
    select intent_id::text from public.booking_slot_leases where tenant_id = '${slot.tenant}'
  `), "slot winner lookup");
  assert.match(winner, /^[a-f0-9-]{36}$/);
  const claim = scalar(await runSql(connection, home, `
    select claim_token::text from public.action_intents where id = '${winner}'
  `), "slot winner claim lookup");
  assert.match(claim, /^[a-f0-9-]{36}$/);
  const fabricated = await runSql(connection, home, acceptedDeliverySql(
    winner, "synthetic-prepare-only-fabrication", "accepted", claim,
  ));
  assert.notEqual(fabricated.code, 0);
  assert.match(fabricated.stderr, /provider_write_fence_required/);
  assert.equal(scalar(await runSql(connection, home, `
    select count(*)::text from public.receipts where intent_id = '${winner}'
  `), "prepare-only fabrication invariant"), "0");

  const begun = JSON.parse(scalar(await runSql(connection, home, serviceTransaction(`
    select public.begin_provider_write('${winner}', '${claim}')::text;
  `)), "provider-write fence transition"));
  assert.equal(begun.authorized, true);
  const [first, second] = await Promise.all([
    runSql(connection, home, acceptedDeliverySql(winner, "synthetic-delivery-attempt", "accepted", claim)),
    runSql(connection, home, acceptedDeliverySql(winner, "synthetic-delivery-attempt", "accepted", claim)),
  ]);
  const results = [JSON.parse(scalar(first, "first delivery")), JSON.parse(scalar(second, "duplicate delivery"))];
  assert.deepEqual(results.map((item) => item.reused).sort(), [false, true]);
  const [lateOne, lateTwo] = await Promise.all([
    runSql(connection, home, acceptedDeliverySql(winner, "synthetic-reconcile-attempt", "unknown", claim)),
    runSql(connection, home, acceptedDeliverySql(winner, "synthetic-reconcile-attempt", "unknown", claim)),
  ]);
  assert.equal(JSON.parse(scalar(lateOne, "first reconciliation")).authoritative, true);
  assert.equal(JSON.parse(scalar(lateTwo, "duplicate reconciliation")).authoritative, true);
  assert.equal(scalar(await runSql(connection, home, `
    select
      (select count(*) from public.receipts where intent_id = '${winner}')::text || ':' ||
      (select count(*) from public.booking_accepted_receipts where intent_id = '${winner}')::text || ':' ||
      (select count(*) from public.notifications n join public.action_intents ai on ai.tenant_id = n.tenant_id where ai.id = '${winner}' and n.kind = 'booking_confirmed')::text || ':' ||
      (select status from public.bookings where intent_id = '${winner}')
  `), "delivery invariant"), "2:1:1:confirmed");
}

async function oauthDoubleConsume(connection, home) {
  const tenant = "30000000-0000-4000-8000-000000000001";
  const user = "30000000-0000-4000-8000-000000000002";
  requireSuccess(await runSql(connection, home, `
    insert into auth.users (id) values ('${user}');
    insert into public.tenants (id, slug, name, owner_user_id, status)
    values ('${tenant}', 'synthetic-oauth-consume', 'Synthetic OAuth Consume', '${user}', 'active');
    insert into public.oauth_states (state, tenant_id, user_id, nonce_hash, redirect_uri, expires_at)
    values ('synthetic-oauth-state', '${tenant}', '${user}', 'synthetic-nonce-hash',
      'https://synthetic.invalid/oauth/callback', now() + interval '5 minutes');
  `), "OAuth fixture");
  const consume = serviceTransaction(`select tenant_id::text from public.consume_oauth_state(
    'synthetic-oauth-state', 'synthetic-nonce-hash', '${tenant}', '${user}',
    'https://synthetic.invalid/oauth/callback'
  );`);
  const results = await Promise.all([runSql(connection, home, consume), runSql(connection, home, consume)]);
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.equal(results.filter((result) => result.code !== 0 && /oauth_state_invalid/.test(result.stderr)).length, 1);
  assert.equal(scalar(await runSql(connection, home, `
    select (consumed_at is not null)::text from public.oauth_states where state = 'synthetic-oauth-state'
  `), "OAuth consume invariant"), "true");
}

async function concurrentEpochInvalidation(connection, home) {
  const ids = {
    tenant: "40000000-0000-4000-8000-000000000001",
    power: "40000000-0000-4000-8000-000000000010",
    rule1: "40000000-0000-4000-8000-000000000020",
    rule2: "40000000-0000-4000-8000-000000000022",
    group: "40000000-0000-4000-8000-000000000021",
    call: "40000000-0000-4000-8000-000000000030",
    booking: "40000000-0000-4000-8000-000000000040",
    intent: "40000000-0000-4000-8000-000000000050",
  };
  requireSuccess(await runSql(connection, home, `
    insert into public.tenants (id, slug, name, status) values ('${ids.tenant}', 'synthetic-epoch', 'Synthetic Epoch', 'active');
    insert into public.rules (id, tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured)
    values ('${ids.rule1}', '${ids.tenant}', '${ids.group}', 1, 'onboarding', 'servico', 'aprovado', 'preco',
      'Synthetic epoch price', '{"service_type":"plumbing","price_min":100}');
    insert into public.powers (id, tenant_id, subject, capability, resource, monetary_limit)
    values ('${ids.power}', '${ids.tenant}', 'voice_agent', 'create_booking', 'plumbing', 500);
    insert into public.calls (id, tenant_id, channel, session_type, status)
    values ('${ids.call}', '${ids.tenant}', 'eval', 'customer', 'active');
    insert into public.bookings (id, tenant_id, call_id, client_name, contact, service_type, price_agreed, slot_start, slot_end, status, idempotency_key)
    values ('${ids.booking}', '${ids.tenant}', '${ids.call}', 'Epoch', '5550200', 'plumbing', 120,
      '2030-10-01T17:00:00Z', '2030-10-01T18:00:00Z', 'proposed', 'synthetic-epoch-booking');
    insert into public.action_intents (id, tenant_id, call_id, booking_id, kind, payload, policy_snapshot, idempotency_key, status)
    select '${ids.intent}', b.tenant_id, b.call_id, b.id, 'calendar_book',
      jsonb_build_object(
        'summary', b.service_type || ' — ' || coalesce(b.client_name, 'customer') || ' ($' || b.price_agreed::text || ')',
        'description', 'Booked by Ligou. Contact: ' || coalesce(b.contact, '?') || '. Call ' || b.call_id::text || '.',
        'start_iso', b.slot_start, 'end_iso', b.slot_end
      ),
      jsonb_build_object('power_id', '${ids.power}', 'rule_id', '${ids.rule1}',
        'auth_epoch', t.auth_epoch, 'policy_epoch', t.policy_epoch, 'price_confirmed', b.price_agreed),
      'synthetic-epoch-intent', 'queued'
    from public.bookings b join public.tenants t on t.id = b.tenant_id where b.id = '${ids.booking}';
  `), "epoch fixture");
  const before = scalar(await runSql(connection, home, `select auth_epoch::text || ':' || policy_epoch::text from public.tenants where id = '${ids.tenant}'`), "epoch baseline");
  const [beforeAuth, beforePolicy] = before.split(":").map(Number);
  const [powerChange, policyChange] = await Promise.all([
    runSql(connection, home, `update public.powers set revoked_at = now() where id = '${ids.power}';`),
    runSql(connection, home, `insert into public.rules (id, tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured)
      values ('${ids.rule2}', '${ids.tenant}', '${ids.group}', 2, 'edicao_manual', 'servico', 'aprovado', 'preco',
        'Synthetic epoch price v2', '{"service_type":"plumbing","price_min":110}');`),
  ]);
  requireSuccess(powerChange, "power epoch mutation");
  requireSuccess(policyChange, "policy epoch mutation");
  assert.equal(scalar(await runSql(connection, home, `select auth_epoch::text || ':' || policy_epoch::text from public.tenants where id = '${ids.tenant}'`), "epoch increments"), `${beforeAuth + 1}:${beforePolicy + 1}`);
  requireSuccess(await runSql(connection, home, serviceTransaction(`select count(*) from public.claim_intent('epoch-worker');`)), "epoch invalidation claim");
  assert.equal(scalar(await runSql(connection, home, `select status || ':' || last_error from public.action_intents where id = '${ids.intent}'`), "epoch invalidation invariant"), "failed:authority_stale_before_claim");
}

async function onboardingEpochSemantics(connection, home) {
  const tenant = "41000000-0000-4000-8000-000000000001";
  const group = "41000000-0000-4000-8000-000000000010";
  requireSuccess(await runSql(connection, home, `
    insert into public.tenants (id, slug, name, status)
    values ('${tenant}', 'synthetic-onboarding-epoch', 'Synthetic Onboarding Epoch', 'provisioning');
    insert into public.rules (tenant_id, rule_group_id, version, origem, escopo, status, category, text)
    values
      ('${tenant}', '${group}', 1, 'onboarding', 'servico', 'sugerido', 'preco', 'answer one'),
      ('${tenant}', '41000000-0000-4000-8000-000000000011', 1, 'onboarding', 'localizacao', 'sugerido', 'area', 'answer two'),
      ('${tenant}', '41000000-0000-4000-8000-000000000012', 1, 'onboarding', 'servico', 'sugerido', 'preco', 'answer three'),
      ('${tenant}', '41000000-0000-4000-8000-000000000013', 1, 'onboarding', 'geral', 'sugerido', 'agenda', 'answer four'),
      ('${tenant}', '41000000-0000-4000-8000-000000000014', 1, 'onboarding', 'geral', 'sugerido', 'emergencia', 'answer five');
  `), "onboarding suggested answers");
  assert.equal(scalar(await runSql(connection, home, `
    select policy_epoch::text || ':' || (select count(*) from public.effective_rules where tenant_id = '${tenant}')::text
    from public.tenants where id = '${tenant}'
  `), "suggested answers preserve capability epoch"), "1:0");

  requireSuccess(await runSql(connection, home, `
    insert into public.rules (tenant_id, rule_group_id, version, origem, escopo, status, category, text)
    values ('${tenant}', '${group}', 2, 'onboarding', 'servico', 'aprovado', 'preco', 'approved answer one');
  `), "onboarding approval");
  assert.equal(scalar(await runSql(connection, home, `
    select policy_epoch::text || ':' || (select count(*) from public.effective_rules where tenant_id = '${tenant}')::text
    from public.tenants where id = '${tenant}'
  `), "approved answer invalidates capability"), "2:1");

  requireSuccess(await runSql(connection, home, `
    insert into public.rules (tenant_id, rule_group_id, version, origem, escopo, status, category, text)
    values ('${tenant}', '${group}', 3, 'edicao_manual', 'servico', 'revogado', 'preco', 'revoked answer one');
  `), "onboarding revocation");
  assert.equal(scalar(await runSql(connection, home, `
    select policy_epoch::text || ':' || (select count(*) from public.effective_rules where tenant_id = '${tenant}')::text
    from public.tenants where id = '${tenant}'
  `), "revoked answer invalidates capability"), "3:0");
}

async function expiredTransientRetention(connection, home) {
  const ids = {
    tenant: "42000000-0000-4000-8000-000000000001",
    call: "42000000-0000-4000-8000-000000000002",
    rule: "42000000-0000-4000-8000-000000000003",
    group: "42000000-0000-4000-8000-000000000004",
    power: "42000000-0000-4000-8000-000000000005",
    expiredQuote: "42000000-0000-4000-8000-000000000006",
    futureQuote: "42000000-0000-4000-8000-000000000007",
  };
  requireSuccess(await runSql(connection, home, `
    insert into public.tenants (id, slug, name, status)
    values ('${ids.tenant}', 'synthetic-retention', 'Synthetic Retention', 'active');
    insert into public.calls (id, tenant_id, channel, session_type, status)
    values ('${ids.call}', '${ids.tenant}', 'eval', 'customer', 'ended');
    insert into public.rules (id, tenant_id, rule_group_id, version, origem, escopo, status, category, text, structured)
    values ('${ids.rule}', '${ids.tenant}', '${ids.group}', 1, 'edicao_manual', 'servico', 'aprovado', 'preco',
      'Synthetic retention price', '{"service_type":"plumbing","price_min":100}'::jsonb);
    insert into public.powers (id, tenant_id, subject, capability, resource, monetary_limit)
    values ('${ids.power}', '${ids.tenant}', 'voice_agent', 'create_booking', 'plumbing', 200);
    insert into public.booking_quotes (id, token_hash, tenant_id, call_id, service_type, public_quote, rule_id, policy_epoch, expires_at)
    select '${ids.expiredQuote}', 'retention-expired-quote', '${ids.tenant}', '${ids.call}', 'plumbing', 120, '${ids.rule}', t.policy_epoch, now() - interval '2 hours'
    from public.tenants t where t.id = '${ids.tenant}';
    insert into public.booking_quotes (id, token_hash, tenant_id, call_id, service_type, public_quote, rule_id, policy_epoch, expires_at)
    select '${ids.futureQuote}', 'retention-future-quote', '${ids.tenant}', '${ids.call}', 'plumbing', 120, '${ids.rule}', t.policy_epoch, now() + interval '2 hours'
    from public.tenants t where t.id = '${ids.tenant}';
    insert into public.slot_offers (
      token_hash, tenant_id, call_id, quote_id, service_type, slot_start, slot_end, local_display,
      public_quote, geography, power_id, rule_id, policy_epoch, expires_at
    )
    select 'retention-expired-offer', '${ids.tenant}', '${ids.call}', '${ids.expiredQuote}', 'plumbing',
      now() + interval '1 day', now() + interval '1 day 1 hour', 'Tomorrow', 120, 'Irvine',
      '${ids.power}', '${ids.rule}', t.policy_epoch, now() - interval '2 hours'
    from public.tenants t where t.id = '${ids.tenant}';
    insert into public.slot_offers (
      token_hash, tenant_id, call_id, quote_id, service_type, slot_start, slot_end, local_display,
      public_quote, geography, power_id, rule_id, policy_epoch, expires_at
    )
    select 'retention-future-offer', '${ids.tenant}', '${ids.call}', '${ids.futureQuote}', 'plumbing',
      now() + interval '2 days', now() + interval '2 days 1 hour', 'Later', 120, 'Irvine',
      '${ids.power}', '${ids.rule}', t.policy_epoch, now() + interval '2 hours'
    from public.tenants t where t.id = '${ids.tenant}';
    insert into public.oauth_states (state, tenant_id, user_id, nonce_hash, redirect_uri, expires_at)
    values
      ('retention-expired-oauth', '${ids.tenant}', '42000000-0000-4000-8000-000000000020', 'expired-nonce', 'https://unit.invalid/callback', now() - interval '2 hours'),
      ('retention-future-oauth', '${ids.tenant}', '42000000-0000-4000-8000-000000000021', 'future-nonce', 'https://unit.invalid/callback', now() + interval '2 hours');
  `), "retention fixture");

  const result = JSON.parse(scalar(await runSql(connection, home, serviceTransaction(`
    select public.purge_ephemeral_call_data(now() - interval '30 days', now())::text;
  `)), "retention RPC"));
  assert.deepEqual({
    oauth: result.oauth_states_deleted,
    offers: result.slot_offers_deleted,
    quotes: result.booking_quotes_deleted,
  }, { oauth: 1, offers: 1, quotes: 1 });
  assert.equal(scalar(await runSql(connection, home, `
    select
      (select count(*) from public.oauth_states where state like 'retention-%')::text || ':' ||
      (select count(*) from public.slot_offers where token_hash like 'retention-%')::text || ':' ||
      (select count(*) from public.booking_quotes where token_hash like 'retention-%')::text
  `), "retention preserved future rows"), "1:1:1");
}

async function bookingDeliveryRollback(connection, home) {
  const tenant = "50000000-0000-4000-8000-000000000001";
  const call = "50000000-0000-4000-8000-000000000030";
  const booking = "50000000-0000-4000-8000-000000000040";
  const intent = "50000000-0000-4000-8000-000000000050";
  requireSuccess(await runSql(connection, home, `
    insert into public.tenants (id, slug, name, status) values ('${tenant}', 'synthetic-rollback', 'Synthetic Rollback', 'active');
    insert into public.calls (id, tenant_id, channel, session_type, status) values ('${call}', '${tenant}', 'eval', 'customer', 'active');
    insert into public.bookings (id, tenant_id, call_id, client_name, contact, service_type, price_agreed, slot_start, slot_end, status, idempotency_key)
    values ('${booking}', '${tenant}', '${call}', 'Rollback', '5550300', 'plumbing', 120,
      '2030-11-01T17:00:00Z', '2030-11-01T18:00:00Z', 'proposed', 'synthetic-rollback-booking');
    insert into public.action_intents (id, tenant_id, call_id, booking_id, kind, payload, policy_snapshot, idempotency_key, status, execution_mode, lease_until)
    select '${intent}', b.tenant_id, b.call_id, b.id, 'calendar_book',
      jsonb_build_object(
        'summary', b.service_type || ' — ' || coalesce(b.client_name, 'customer') || ' ($' || b.price_agreed::text || ')',
        'description', 'Booked by Ligou. Contact: ' || coalesce(b.contact, '?') || '. Call ' || b.call_id::text || '.',
        'start_iso', b.slot_start, 'end_iso', b.slot_end
      ), '{}', 'synthetic-rollback-intent', 'running', 'reconcile', now() + interval '10 minutes'
    from public.bookings b where b.id = '${booking}';
  `), "rollback fixture");
  const failed = await runSql(connection, home, acceptedDeliverySql(intent, "synthetic-rollback-attempt"));
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /provider_write_fence_required/);
  assert.equal(scalar(await runSql(connection, home, `
    select
      (select count(*) from public.receipts where intent_id = '${intent}')::text || ':' ||
      (select count(*) from public.booking_accepted_receipts where intent_id = '${intent}')::text || ':' ||
      (select count(*) from public.notifications where tenant_id = '${tenant}' and kind = 'booking_confirmed')::text || ':' ||
      (select status from public.bookings where id = '${booking}') || ':' ||
      (select status from public.action_intents where id = '${intent}')
  `), "booking delivery rollback invariant"), "0:0:0:proposed:running");
}

async function handoffIntentDoubleConsume(connection, home) {
  const uid = "61000000-0000-4000-8000-000000000001";
  const tenant = "61000000-0000-4000-8000-000000000002";
  const intent = "61000000-0000-4000-8000-000000000003";
  const nonceHash = "b".repeat(64);
  requireSuccess(await runSql(connection, home, `
    insert into auth.users (id, email) values ('${uid}', 'handoff-race@example.invalid');
    insert into public.tenants (id, slug, name, owner_user_id, status, bootstrap_origin)
    values ('${tenant}', 'handoff-race', 'Handoff Race', '${uid}', 'onboarding', 'v0_2_google');
    insert into public.connector_handoff_intents (id, tenant_id, user_id, kind, nonce_hash, expires_at)
    values ('${intent}', '${tenant}', '${uid}', 'login', '${nonceHash}', now() + interval '10 minutes');
  `), "handoff double-consume fixture");
  const consumeSql = serviceTransaction(`
select pg_sleep(0.2);
select 'CONSUMED:' || kind from public.consume_connector_handoff('${intent}', '${nonceHash}', '${tenant}', '${uid}');
`);
  const first = startSql(connection, home, consumeSql);
  const second = startSql(connection, home, consumeSql);
  const [resultA, resultB] = await Promise.all([first.done, second.done]);
  const outcomes = [resultA, resultB].map((result) => (
    result.code === 0 && result.stdout.includes("CONSUMED:login") ? "consumed" : "rejected"
  ));
  assert.deepEqual(outcomes.sort(), ["consumed", "rejected"],
    `exactly one concurrent consumer may win: ${resultA.stderr} | ${resultB.stderr}`);
  const loser = resultA.code === 0 ? resultB : resultA;
  assert.match(loser.stderr, /handoff_intent_invalid/);
  assert.equal(scalar(await runSql(connection, home, `
    select (consumed_at is not null)::text from public.connector_handoff_intents where id = '${intent}';
  `), "handoff intent consumed exactly once"), "true");
}

async function concurrentOwnerBootstrap(connection, home) {
  const uid = "60000000-0000-4000-8000-000000000001";
  requireSuccess(await runSql(connection, home, `
    insert into auth.users (id, email, raw_user_meta_data)
    values ('${uid}', 'boot-race@example.invalid', '{"name":"Race Owner"}');
  `), "bootstrap race fixture");
  const authenticatedBootstrapSql = `
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '${uid}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select pg_sleep(0.3);
select 'TENANT:' || (public.ensure_owner_tenant() ->> 'tenant_id');
commit;
`;
  const first = startSql(connection, home, authenticatedBootstrapSql);
  const second = startSql(connection, home, authenticatedBootstrapSql);
  const [resultA, resultB] = await Promise.all([first.done, second.done]);
  const tenantOf = (result, label) => {
    const line = requireSuccess(result, label).split("\n").find((row) => row.startsWith("TENANT:"));
    assert.ok(line, `${label} produced no tenant`);
    return line.slice("TENANT:".length);
  };
  const tenantA = tenantOf(resultA, "concurrent bootstrap session A");
  const tenantB = tenantOf(resultB, "concurrent bootstrap session B");
  assert.equal(tenantA, tenantB, "concurrent bootstrap must converge on one tenant");
  assert.equal(scalar(await runSql(connection, home, `
    select
      (select count(*) from public.tenants where owner_user_id = '${uid}' and bootstrap_origin = 'v0_2_google')::text || ':' ||
      (select count(*) from public.tenant_provisioning_receipts where owner_user_id = '${uid}')::text || ':' ||
      (select count(*) from public.connector_accounts c
         join public.tenants t on t.id = c.tenant_id
         where t.owner_user_id = '${uid}' and c.status = 'reconnect_required')::text || ':' ||
      (select status from public.tenants where id = '${tenantA}') || ':' ||
      (select operational_mode from public.tenants where id = '${tenantA}')
  `), "bootstrap race invariant"), "1:1:1:onboarding:simulation_only");
}

export async function runConcurrencySuite(env = process.env) {
  const connection = connectionFromEnvironment(env);
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "ligou-rc1-psql-home-"));
  const tests = [
    ["parallel budget reservation cap", parallelBudgetReservationCap],
    ["parallel slot exclusion", parallelSlotExclusion],
    ["stale/current worker fence", staleAndCurrentWorkerFence],
    ["duplicate delivery/reconciliation", duplicateDeliveryAndReconciliation],
    ["OAuth double-consume", oauthDoubleConsume],
    ["concurrent policy/power epoch invalidation", concurrentEpochInvalidation],
    ["onboarding effective policy epochs", onboardingEpochSemantics],
    ["expired transient retention", expiredTransientRetention],
    ["concurrent owner bootstrap single tenant", concurrentOwnerBootstrap],
    ["handoff intent double-consume", handoffIntentDoubleConsume],
    ["booking-delivery transaction rollback", bookingDeliveryRollback],
  ];
  try {
    for (const [, test] of tests) await test(connection, isolatedHome);
    return { suite: "local-db-concurrency", tests: tests.length, passed: tests.length };
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(await runConcurrencySuite()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "local concurrency suite failed");
    process.exitCode = 1;
  }
}
