import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
export async function runSalesPersistenceSuite(env) {
  if (
    (env.PGPORT === "54322" &&
      env.LIGOU_LOCAL_PROJECT_ID !== "ligou-v0-1-rc1") ||
    (env.PGPORT === "55439" && env.LIGOU_SALES_DISPOSABLE_TEST !== "yes")
  ) throw Error("sales suite requires explicit disposable project identity");
  if (
    env.PGHOST !== "127.0.0.1" || !["54322", "55439"].includes(env.PGPORT) ||
    env.PGDATABASE !== "postgres" || env.PGUSER !== "postgres"
  ) throw Error("sales suite requires disposable loopback PostgreSQL");
  const sql = (statement) =>
    new Promise((resolve, reject) => {
      const p = spawn(
        env.LIGOU_PSQL_BIN ?? "/opt/homebrew/opt/postgresql@16/bin/psql",
        ["-XqAt", "-v", "ON_ERROR_STOP=1", "-f", "-"],
        {
          env: { ...env, PGCONNECT_TIMEOUT: "5" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let out = "", err = "";
      p.stdout.on("data", (d) => out += d);
      p.stderr.on("data", (d) => err += d);
      p.on("error", reject);
      p.on("close", (c) => c ? reject(Error(err)) : resolve(out.trim()));
      p.stdin.end(statement);
    });
  const rpc = async (name, args) =>
    JSON.parse(
      (await sql(
        `begin;set local role service_role;select public.${name}(${
          Object.entries(args).map(([k, v]) =>
            `${k}=>${
              v === null
                ? "null"
                : typeof v === "object"
                ? q(JSON.stringify(v)) + "::jsonb"
                : typeof v === "boolean"
                ? String(v)
                : q(v)
            }`
          ).join(",")
        });commit;`,
      )) || "null",
    );
  const admit = (id = randomUUID(), visitor = "b", network = "c") =>
    rpc("sales_admit", {
      p_request_id: id,
      p_token_hash: "a".repeat(64),
      p_visitor_hash: visitor.repeat(64),
      p_network_hash: network.repeat(64),
      p_offer_sdp: "v=0\r\n",
    });
  const pub = (id, end = false, token = "a") =>
    rpc("sales_public_session", {
      p_session_id: id,
      p_token_hash: token.repeat(64),
      p_end: end,
    });
  const claim = () => rpc("sales_claim", { p_worker_id: "sales-test" });
  const apply = (s, op, p = {}) =>
    rpc("sales_worker_apply", {
      p_session_id: s.session_id,
      p_claim_token: s.claim_token,
      p_operation: op,
      p_payload: p,
    });
  const tests = [];
  await sql(
    "truncate public.sales_usage_events,public.sales_transcript_items,public.sales_leads,public.sales_sessions,public.sales_cancellations;update public.sales_configuration set enabled=false,owner_user_id=null,heartbeat_at=null,network_daily_limit=10,visitor_daily_limit=3,daily_budget_usd=15;",
  );
  await assert.rejects(admit, /sales_disabled/);
  await sql(
    "insert into auth.users(id) values('99000000-0000-4000-8000-000000000001') on conflict do nothing;update public.sales_configuration set enabled=true,owner_user_id='99000000-0000-4000-8000-000000000001'",
  );
  await assert.rejects(admit, /runtime_unavailable/);
  await rpc("sales_heartbeat", { p_worker_id: "sales-test" });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => admit()),
  );
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  tests.push("eight simultaneous admissions allocate one global slot");
  let active = results.find((x) => x.status === "fulfilled").value;
  assert.deepEqual(await admit(active.session_id), active);
  await assert.rejects(
    () => pub(active.session_id, false, "d"),
    /session_not_found/,
  );
  assert.equal((await pub(active.session_id, true)).status, "ended");
  const canceled = randomUUID();
  assert.equal((await pub(canceled, true)).status, "ended");
  assert.equal((await admit(canceled)).status, "ended");
  tests.push("replay token isolation and cancellation before admission");
  await admit();
  active = await claim();
  await apply(active, "create_intent", { model: "realtime2.1" });
  await sql(
    `update public.sales_sessions set lease_expires_at=now()-interval '1 second' where session_id=${
      q(active.session_id)
    }`,
  );
  assert.equal(await claim(), null);
  assert.equal((await pub(active.session_id)).status, "quarantined");
  await assert.rejects(
    () => apply(active, "fail", { error: "late" }),
    /stale_claim/,
  );
  await assert.rejects(admit, /global_busy/);
  tests.push(
    "ambiguous create quarantines with budget and stale fence rejected",
  );
  await sql(
    "truncate public.sales_usage_events,public.sales_transcript_items,public.sales_leads,public.sales_sessions,public.sales_cancellations",
  );
  await admit();
  const firstClaim = await claim();
  await sql(
    `update public.sales_sessions set lease_expires_at=now()-interval '1 second' where session_id=${
      q(firstClaim.session_id)
    }`,
  );
  active = await claim();
  assert.notEqual(active.claim_token, firstClaim.claim_token);
  await assert.rejects(
    () => apply(firstClaim, "create_intent", { model: "realtime2.1" }),
    /stale_claim/,
  );
  await apply(active, "create_intent", { model: "realtime2.1" });
  await apply(active, "provider_ready", {
    provider_call_id: "recovery-fixture",
    answer_sdp: "answer",
    model: "realtime2.1",
  });
  assert.equal(
    await sql(
      `select offer_sdp from public.sales_sessions where session_id=${
        q(active.session_id)
      }`,
    ),
    "",
  );
  await sql(
    `update public.sales_sessions set lease_expires_at=now()-interval '1 second' where session_id=${
      q(active.session_id)
    }`,
  );
  active = await claim();
  assert.equal(active.status, "ending");
  assert.equal(active.stop_requested, true);
  await assert.rejects(
    () => apply(active, "create_intent", { model: "realtime2.1" }),
    /create_not_allowed/,
  );
  await apply(active, "termination", { state: "confirmed" });
  await apply(active, "usage", { observed_cost_usd: 0, final: true });
  tests.push(
    "safe pre-create lease retry, known-provider recovery drains, transient SDP scrubbed",
  );
  await sql(
    "truncate public.sales_usage_events,public.sales_transcript_items,public.sales_leads,public.sales_sessions,public.sales_cancellations",
  );
  await admit();
  active = await claim();
  await apply(active, "create_intent", { model: "realtime2.1" });
  await apply(active, "provider_ready", {
    provider_call_id: "provider-fixture",
    answer_sdp: "answer",
    model: "realtime2.1",
  });
  assert.equal((await pub(active.session_id)).sdp, undefined);
  await apply(active, "activate");
  assert.equal((await pub(active.session_id)).sdp, "answer");
  const tx = (id, role, text, context = "real") =>
    apply(active, "transcript", { provider_item_id: id, role, text, context });
  await tx("u1", "user", "Meu nome é RJ, email rj@example.test");
  await tx("a1", "assistant", "Confirma rj@example.test?");
  await tx("u2", "user", "Sim");
  await tx("a2", "assistant", "Posso te enviar um email de retorno?");
  await tx("u3", "user", "Sim, pode");
  await tx("rp", "user", "Sou Roberto", "roleplay");
  await assert.rejects(
    () =>
      apply(active, "lead_patch", {
        fields: { name: { value: "Roberto", evidence_item_ids: ["rp"] } },
      }),
    /invalid_evidence/,
  );
  await apply(active, "lead_patch", {
    fields: {
      name: { value: "RJ", evidence_item_ids: ["u1"] },
      email: { value: "rj@example.test", evidence_item_ids: ["u1"] },
    },
  });
  await assert.rejects(
    () =>
      apply(active, "lead_patch", {
        followup_consent: {
          granted: true,
          channel: "email",
          request_item_id: "a2",
          response_item_id: "u3",
        },
      }),
    /contact_not_confirmed/,
  );
  await apply(active, "lead_patch", {
    contact_confirmation: {
      channel: "email",
      value: "rj@example.test",
      readback_item_id: "a1",
      confirmation_item_id: "u2",
    },
  });
  await apply(active, "lead_patch", {
    followup_consent: {
      granted: true,
      channel: "email",
      request_item_id: "a2",
      response_item_id: "u3",
    },
  });
  let lead = JSON.parse(
    await sql("select to_jsonb(l) from public.sales_leads l"),
  );
  assert.equal(lead.contact_confirmed, true);
  assert.equal(lead.followup_consent, true);
  await tx("u4", "user", "Agora rj2@example.test");
  await apply(active, "lead_patch", {
    fields: { email: { value: "rj2@example.test", evidence_item_ids: ["u4"] } },
  });
  lead = JSON.parse(await sql("select to_jsonb(l) from public.sales_leads l"));
  assert.equal(lead.contact_confirmed, false);
  assert.equal(lead.followup_consent, false);
  await tx("u4", "user", "Agora rj2@example.test");
  await assert.rejects(
    () => tx("u4", "user", "changed"),
    /transcript_conflict/,
  );
  tests.push(
    "incremental append-only evidence, roleplay rejection, separate consent and contact invalidation",
  );
  await apply(active, "usage", { observed_cost_usd: 1.5 });
  assert.equal((await pub(active.session_id)).status, "ending");
  await apply(active, "termination", { state: "confirmed" });
  await apply(active, "termination", { state: "requested" });
  assert.equal((await pub(active.session_id)).status, "ended");
  await assert.rejects(
    () => apply(active, "usage", { observed_cost_usd: 1 }),
    /usage_regression/,
  );
  await apply(active, "usage", { observed_cost_usd: 1.5, final: true });
  tests.push("observed ceiling stops and final usage cannot regress");
  await sql(
    "truncate public.sales_usage_events,public.sales_transcript_items,public.sales_leads,public.sales_sessions,public.sales_cancellations",
  );
  for (let i = 0; i < 3; i++) {
    const s = await admit();
    await pub(s.session_id, true);
  }
  await assert.rejects(admit, /visitor_limit/);
  await sql("update public.sales_configuration set network_daily_limit=3");
  await assert.rejects(() => admit(randomUUID(), "d"), /network_limit/);
  tests.push("visitor three and network daily quotas");
  await sql(
    "truncate public.sales_usage_events,public.sales_transcript_items,public.sales_leads,public.sales_sessions,public.sales_cancellations;update public.sales_configuration set network_daily_limit=10,daily_budget_usd=1.5",
  );
  await admit();
  active = await claim();
  await apply(active, "create_intent", { model: "realtime2.1" });
  await apply(active, "provider_ready", {
    provider_call_id: "fixture2",
    answer_sdp: "answer",
    model: "realtime2.1",
  });
  await apply(active, "termination", { state: "confirmed" });
  await sql(
    "update public.sales_sessions set created_at=now()-interval '2 days'",
  );
  await assert.rejects(admit, /daily_budget/);
  tests.push("unsettled terminated hold survives midnight");
  const owner = randomUUID(), other = randomUUID();
  await sql(
    `insert into auth.users(id) values(${q(owner)}),(${
      q(other)
    });update public.sales_configuration set owner_user_id=${q(owner)};`,
  );
  const ownerSql = (id, statement) =>
    sql(
      `begin;set local role authenticated;set local request.jwt.claim.sub=${
        q(id)
      };${statement};commit;`,
    );
  assert.equal(
    await ownerSql(owner, "select count(*) from public.sales_leads"),
    "1",
  );
  assert.equal(
    await ownerSql(other, "select count(*) from public.sales_leads"),
    "0",
  );
  await assert.rejects(
    () => ownerSql(owner, "select offer_sdp from public.sales_sessions"),
    /permission denied/,
  );
  await assert.rejects(
    () => ownerSql(owner, "select public.sales_claim('attack')"),
    /permission denied/,
  );
  await assert.rejects(
    () => sql("set role anon;select * from public.sales_leads"),
    /permission denied/,
  );
  tests.push("owner-only RLS with private SDP and service-only RPCs");
  await sql(
    `truncate public.sales_usage_events,public.sales_transcript_items,public.sales_leads,public.sales_sessions,public.sales_cancellations;update public.sales_configuration set enabled=false,owner_user_id=null,heartbeat_at=null,daily_budget_usd=15;delete from auth.users where id in (${
      q(owner)
    },${q(other)});`,
  );
  return { tests, passed: tests.length };
}
if (
  import.meta.main || process.argv[1]?.endsWith("local-sales-persistence.mjs")
) {
  console.log(
    JSON.stringify(await runSalesPersistenceSuite(process.env), null, 2),
  );
}
