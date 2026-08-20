import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

function migrationSql(suffix: string): string {
  const names = readdirSync(migrationsDir).filter((name) => name.endsWith(`_${suffix}.sql`));
  expect(names).toHaveLength(1);
  return readFileSync(path.join(migrationsDir, names[0]!), "utf8").replace(/\s+/g, " ").trim();
}

describe("OAuth connector hardening migration contract", () => {
  test("state consumption is atomic, short-lived, fully bound, and service-role-only", () => {
    const sql = migrationSql("connector_oauth_hardening");
    expect(sql).toContain("function public.consume_oauth_state(text,text,uuid,uuid,text)");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("for update");
    expect(sql).toContain("expires_at <= clock_timestamp()");
    expect(sql).toContain("nonce_hash is distinct from p_nonce_hash");
    expect(sql).toContain("tenant_id is distinct from p_tenant");
    expect(sql).toContain("user_id is distinct from p_user");
    expect(sql).toContain("redirect_uri is distinct from p_redirect");
    expect(sql).toContain("revoke all on function public.consume_oauth_state(text,text,uuid,uuid,text) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.consume_oauth_state(text,text,uuid,uuid,text) to service_role");
  });

  test("owner status RPC exposes metadata only and cannot be invoked anonymously", () => {
    const sql = migrationSql("connector_oauth_hardening");
    expect(sql).toContain("function public.get_connector_status()");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("t.owner_user_id");
    expect(sql).not.toContain("returns table (refresh_token");
    expect(sql).toContain("drop view if exists public.connector_status");
    expect(sql).toContain("revoke all on function public.get_connector_status() from public, anon");
    expect(sql).toContain("grant execute on function public.get_connector_status() to authenticated");
  });

  test("encrypted token columns quarantine legacy plaintext without rewriting it", () => {
    const sql = migrationSql("connector_oauth_hardening");
    expect(sql).toContain("refresh_token_ciphertext");
    expect(sql).toContain("refresh_token_iv");
    expect(sql).toContain("token_key_version");
    expect(sql).toContain("token_account_ref");
    expect(sql).toContain("status = 'reconnect_required'");
    expect(sql).not.toContain("set refresh_token =");
  });
});

describe("privacy retention migration contract", () => {
  test("service-role retention removes raw transcripts and transient transport rows only", () => {
    const sql = migrationSql("privacy_retention");
    expect(sql).toContain("function public.purge_ephemeral_call_data(timestamptz,timestamptz)");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("set transcript = '[]'::jsonb");
    expect(sql).toContain("delete from public.browser_session_requests");
    expect(sql).toContain("delete from public.phone_events");
    expect(sql).not.toContain("delete from public.receipts");
    expect(sql).not.toContain("delete from public.rules");
    expect(sql).not.toContain("delete from public.audit_log");
    expect(sql).toContain("revoke all on function public.purge_ephemeral_call_data(timestamptz,timestamptz) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.purge_ephemeral_call_data(timestamptz,timestamptz) to service_role");
  });
});

describe("tenant owner provisioning migration contract", () => {
  test("only the service role can invoke the atomic owner binding RPC", () => {
    const sql = migrationSql("tenant_owner_provisioning");

    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("auth.role() <> 'service_role'");
    expect(sql).toContain("for update");
    expect(sql).toContain("revoke all on function public.provision_tenant_owner(uuid,uuid) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.provision_tenant_owner(uuid,uuid) to service_role");
  });
});

describe("effective authority migration contract", () => {
  test("projects only the deterministic latest approved version per tenant rule group", () => {
    const sql = migrationSql("effective_authority_epochs");

    expect(sql).toContain("with (security_invoker = true)");
    expect(sql).toContain("partition by r.tenant_id, r.rule_group_id order by r.version desc, r.created_at desc, r.id desc");
    expect(sql).toContain("where ranked.version_rank = 1 and ranked.status = 'aprovado'");
  });

  test("rule and power changes bump separate epochs and normalize seeded hours", () => {
    const sql = migrationSql("effective_authority_epochs");

    expect(sql).toContain("set policy_epoch = t.policy_epoch + 1");
    expect(sql).toContain("set auth_epoch = t.auth_epoch + 1");
    expect(sql).toContain("after insert on public.rules");
    expect(sql).toContain("after insert or update or delete on public.powers");
    expect(sql).toContain("jsonb_build_object('days', jsonb_build_array('mon','tue','wed','thu','fri','sat'), 'start', '08:00', 'end', '18:00')");
  });
});

describe("budget reservation settlement migration contract", () => {
  test("serializes cap reservations on the tenant row and uses the tenant-local day", () => {
    const sql = migrationSql("budget_reservation_settlement");

    expect(sql).toContain("from public.tenants t where t.id = p_tenant for update");
    expect(sql).toContain("(v_now at time zone v_timezone)::date");
    expect(sql).toContain("case when br.status = 'active' then br.reserved_cost_usd else br.final_cost_usd end");
    expect(sql).toContain("unique (call_id)");
  });

  test("settles one reservation into one release and one usage charge idempotently", () => {
    const sql = migrationSql("budget_reservation_settlement");

    expect(sql).toContain("if v_reservation.status = 'settled' then return v_reservation.id");
    expect(sql).toContain("values (p_tenant, p_call, 'adjustment', -v_reservation.reserved_cost_usd");
    expect(sql).toContain("values (p_tenant, p_call, 'usage', p_minutes, p_actual_cost");
    expect(sql).toContain("create unique index usage_ledger_budget_event_unique");
    expect(sql).toContain("p_outcome not in ('ended','startup_error','killed_deadline','killed_budget','error')");
  });

  test("backfills legacy holds so migration does not reset or double-count the current day", () => {
    const sql = migrationSql("budget_reservation_settlement");

    expect(sql).toContain("with legacy_budget as");
    expect(sql).toContain("from public.usage_ledger l join public.calls c");
    expect(sql).toContain("sum(l.cost_usd) filter (where l.kind = 'reservation')");
    expect(sql).toContain("jsonb_build_object('at','legacy_reservation_release')");
    expect(sql.indexOf("with legacy_budget as")).toBeLessThan(sql.indexOf("create unique index usage_ledger_budget_event_unique"));
  });

  test("budget RPCs are service-role-only", () => {
    const sql = migrationSql("budget_reservation_settlement");

    for (const signature of [
      "public.reserve_call_budget(uuid,uuid,numeric)",
      "public.settle_call_budget(uuid,uuid,numeric,numeric,text,jsonb)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("side-effect authority revalidation migration contract", () => {
  test("atomically checks expected epochs plus referenced power/rule before enqueue", () => {
    const sql = migrationSql("authority_side_effect_revalidation");
    expect(sql).toContain("function public.authorize_booking_intent");
    expect(sql).toContain("v_tenant.auth_epoch <> p_expected_auth_epoch or v_tenant.policy_epoch <> p_expected_policy_epoch");
    expect(sql).toContain("from public.powers p");
    expect(sql).toContain("from public.effective_rules er");
    expect(sql).toContain("for update");
  });

  test("claim and immediate execution validation fail stale referenced authority", () => {
    const sql = migrationSql("authority_side_effect_revalidation");
    expect(sql).toContain("authority_stale_before_claim");
    expect(sql).toContain("function public.validate_booking_intent_authority");
    expect(sql).toContain("authority_stale_before_provider");
    expect(sql).toContain("p.revoked_at is null");
  });

  test("replacement RPCs remain service-role-only", () => {
    const sql = migrationSql("authority_side_effect_revalidation");
    for (const signature of [
      "public.authorize_booking_intent(uuid,uuid,uuid,uuid,uuid,numeric,integer,integer,jsonb,text)",
      "public.validate_booking_intent_authority(uuid)",
      "public.claim_intent(text)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("durable provider settlement corrective migration contract", () => {
  test("persists provider termination and leases active terminal reservations for retry", () => {
    const sql = migrationSql("durable_provider_settlement");
    expect(sql).toContain("provider_termination_state");
    expect(sql).toContain("reconcile_lease_until");
    expect(sql).toContain("function public.claim_budget_reconciliation");
    expect(sql).toContain("for update of br skip locked");
  });

  test("error and killed call states win over legacy usage when correcting outcomes", () => {
    const sql = migrationSql("durable_provider_settlement");
    expect(sql).toContain("when c.status = 'error' then 'error'");
    expect(sql).toContain("when c.status = 'killed_deadline' then 'killed_deadline'");
    expect(sql).toContain("when c.status = 'killed_budget' then 'killed_budget'");
  });

  test("replacement reserve function reads the clock only after locking the tenant", () => {
    const sql = migrationSql("durable_provider_settlement");
    const lockAt = sql.indexOf("from public.tenants t where t.id = p_tenant for update");
    const clockAt = sql.indexOf("v_now := clock_timestamp()");
    expect(lockAt).toBeGreaterThan(-1);
    expect(clockAt).toBeGreaterThan(lockAt);
  });

  test("corrective service RPCs remain service-role-only", () => {
    const sql = migrationSql("durable_provider_settlement");
    for (const signature of ["public.claim_budget_reconciliation(text)", "public.reserve_call_budget(uuid,uuid,numeric)"]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("ambiguous provider usage resolution migration contract", () => {
  test("tracks usage separately from confirmed provider termination", () => {
    const sql = migrationSql("ambiguous_provider_usage_resolution");
    expect(sql).toContain("provider_usage_state");
    expect(sql).toContain("'provider_usage_state', v_call.provider_usage_state");
    expect(sql).toContain("'provider_terminated_at', v_call.provider_terminated_at");
  });

  test("replacement reconciliation claim remains service-role-only", () => {
    const sql = migrationSql("ambiguous_provider_usage_resolution");
    expect(sql).toContain("revoke all on function public.claim_budget_reconciliation(text) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.claim_budget_reconciliation(text) to service_role");
  });
});

describe("usage settlement authority corrective migration contract", () => {
  test("backfills ambiguous no-ID calls to unknown and makes unknown the default", () => {
    const sql = migrationSql("usage_settlement_authority");
    expect(sql).toContain("alter column provider_usage_state set default 'unknown'");
    expect(sql).toContain("provider_usage_evidence jsonb");
    expect(sql).toContain("c.openai_call_id is null and c.provider_termination_reason = 'openai_key_missing'");
    expect(sql).toContain("then 'not_applicable' else 'unknown'");
    expect(sql).not.toContain("when c.openai_call_id is null then 'not_applicable'");
  });

  test("settlement locks durable state and rejects every state except resolved or not applicable", () => {
    const sql = migrationSql("usage_settlement_authority");
    const reservationLockAt = sql.indexOf("from public.budget_reservations br");
    const callLockAt = sql.indexOf("from public.calls c");
    const reservationForUpdateAt = sql.indexOf("for update", reservationLockAt);
    const callForUpdateAt = sql.indexOf("for update", callLockAt);
    const usageGateAt = sql.indexOf("coalesce(v_call.provider_usage_state, 'unknown') not in ('resolved','not_applicable')");
    const settledReturnAt = sql.indexOf("if v_reservation.status = 'settled' then return v_reservation.id");
    expect(reservationLockAt).toBeGreaterThan(-1);
    expect(callLockAt).toBeGreaterThan(reservationLockAt);
    expect(reservationForUpdateAt).toBeGreaterThan(reservationLockAt);
    expect(reservationForUpdateAt).toBeLessThan(callLockAt);
    expect(callForUpdateAt).toBeGreaterThan(callLockAt);
    expect(usageGateAt).toBeGreaterThan(callForUpdateAt);
    expect(settledReturnAt).toBeGreaterThan(usageGateAt);
    expect(sql).toContain("provider_usage_unresolved");
  });

  test("the replacement settlement RPC remains service-role-only", () => {
    const sql = migrationSql("usage_settlement_authority");
    const signature = "public.settle_call_budget(uuid,uuid,numeric,numeric,text,jsonb)";
    expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
    expect(sql).toContain(`grant execute on function ${signature} to service_role`);
  });
});

describe("opaque booking offers migration contract", () => {
  test("stores only hashes and atomically consumes an exact scoped current offer", () => {
    const sql = migrationSql("booking_offers");
    expect(sql).toContain("create table public.booking_quotes");
    expect(sql).toContain("create table public.slot_offers");
    expect(sql).toContain("token_hash text not null unique");
    expect(sql).not.toContain("slot_token text");
    expect(sql).toContain("function public.consume_slot_offer");
    expect(sql).toContain("for update");
    expect(sql).toContain("v_offer.tenant_id <> p_tenant or v_offer.call_id <> p_call");
    expect(sql).toContain("v_offer.expires_at <= now()");
    expect(sql).toContain("v_offer.consumed_at is not null");
    expect(sql).toContain("v_tenant.policy_epoch <> v_offer.policy_epoch");
  });

  test("offer consumption is service-role-only", () => {
    const sql = migrationSql("booking_offers");
    const signature = "public.consume_slot_offer(uuid,uuid,text,integer,integer,text,text)";
    expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
    expect(sql).toContain(`grant execute on function ${signature} to service_role`);
  });
});

describe("booking commit lease and reconciliation migration contract", () => {
  test("uses a tenant time-range exclusion and current-authority preparation before provider write", () => {
    const sql = migrationSql("booking_commit_leases");
    expect(sql).toContain("create table public.booking_slot_leases");
    expect(sql).toContain("exclude using gist");
    expect(sql).toContain("tenant_id with =");
    expect(sql).toContain("slot_range with &&");
    expect(sql).toContain("function public.prepare_booking_provider_write");
    expect(sql).toContain("public.validate_booking_intent_authority(p_intent)");
    expect(sql).toContain("exclusion_violation");
  });

  test("unknown claims are marked reconciliation-only and never promoted back to write", () => {
    const sql = migrationSql("booking_commit_leases");
    expect(sql).toContain("execution_mode");
    expect(sql).toContain("when candidate.prior_status = 'unknown' then 'reconcile'");
    expect(sql).toContain("status in ('authorized','queued','unknown')");
  });

  test("repeated exact commitment is constrained to one receipt per intent", () => {
    const sql = migrationSql("booking_commit_leases");
    expect(sql).toContain("create unique index receipts_one_booking_per_intent");
    expect(sql).toContain("on public.receipts (intent_id) where kind = 'booking'");
  });

  test("lease RPCs are service-role-only", () => {
    const sql = migrationSql("booking_commit_leases");
    for (const signature of [
      "public.prepare_booking_provider_write(uuid)",
      "public.release_booking_slot_lease(uuid)",
      "public.commit_booking_slot_lease(uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("private pricing policy guard migration contract", () => {
  test("a slot offer cannot be issued without a private server policy", () => {
    const sql = migrationSql("private_pricing_policy_guard");
    expect(sql).toContain("function public.enforce_slot_offer_private_policy");
    expect(sql).toContain("er.structured ? 'price_min'");
    expect(sql).toContain("new.public_quote >= (er.structured->>'price_min')::numeric");
    expect(sql).toContain("before insert on public.slot_offers");
  });
});

describe("booking delivery authority corrective migration contract", () => {
  test("replaces the flawed receipt index with append-safe attempts and explicit legacy conflict capture", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("drop index if exists public.receipts_one_booking_per_intent");
    expect(sql).toContain("attempt_key text");
    expect(sql).toContain("create unique index receipts_booking_attempt_unique");
    expect(sql).toContain("create table public.booking_receipt_conflicts");
    expect(sql).toContain("array_agg(r.id order by r.created_at, r.id)");
    expect(sql).toContain("create table public.booking_accepted_receipts");
  });

  test("claims carry a unique fence and every reclaimed running intent becomes reconciliation-only", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("claim_token uuid");
    expect(sql).toContain("claim_version bigint");
    expect(sql).toContain("provider_write_started_at timestamptz");
    expect(sql).toContain("candidate.prior_status in ('unknown','running')");
    expect(sql).toContain("claim_token = gen_random_uuid()");
    expect(sql).toContain("ai.status in ('authorized','queued')");
    expect(sql).toContain("ai.provider_write_started_at is null");
  });

  test("only a current fenced begin transition can authorize one provider write", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("function public.begin_provider_write");
    expect(sql).toContain("v_intent.claim_token <> p_claim_token");
    expect(sql).toContain("v_intent.lease_until <= now()");
    expect(sql).toContain("v_intent.provider_write_started_at is not null");
    expect(sql).toContain("provider_write_started_at = now()");
    expect(sql).toContain("execution_mode = 'reconcile'");
    expect(sql).toContain("v_lease.state is distinct from 'held'");
    expect(sql).toContain("v_lease.slot_end is distinct from coalesce(v_booking.slot_end, v_booking.slot_start)");
  });

  test("all pre-write defer/fail/release transitions require the current claim token", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("function public.transition_claimed_intent");
    expect(sql).toContain("v_intent.claim_token is null or p_claim_token is null");
    expect(sql).toContain("v_intent.claim_token is distinct from p_claim_token");
    expect(sql).toContain("v_intent.provider_write_started_at is not null");
    expect(sql).toContain("delete from public.booking_slot_leases l");
    expect(sql).toContain("revoke execute on function public.release_booking_slot_lease(uuid) from service_role");
    expect(sql).toContain("revoke execute on function public.prepare_booking_provider_write(uuid) from service_role");
    expect(sql).toContain("revoke execute on function public.validate_booking_intent_authority(uuid) from service_role");
    const transitionAt = sql.indexOf("function public.transition_claimed_intent");
    const transitionEnd = sql.indexOf("revoke all on function public.transition_claimed_intent", transitionAt);
    const transitionSql = sql.slice(transitionAt, transitionEnd);
    expect(transitionSql.indexOf("update public.action_intents ai set")).toBeLessThan(transitionSql.indexOf("delete from public.booking_slot_leases l"));
  });

  test("provider input and lease are exactly reconstructed from locked booking state", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("function public.booking_provider_input");
    expect(sql).toContain("v_intent.payload <> v_provider_input");
    expect(sql).toContain("v_lease.slot_start is distinct from v_booking.slot_start");
    expect(sql).toContain("v_lease.slot_end is distinct from coalesce(v_booking.slot_end, v_booking.slot_start)");
    expect(sql).toContain("function public.enforce_booking_intent_payload");
  });

  test("accepted receipt, lease, intent, and booking settle atomically with exact proof", () => {
    const sql = migrationSql("booking_delivery_authority");
    expect(sql).toContain("function public.record_booking_delivery");
    expect(sql).toContain("accepted_receipt_conflict");
    expect(sql).toContain("p_readback->'extendedProperties'->'private'->>'ligouPayloadHash') is distinct from p_payload_hash");
    expect(sql).toContain("insert into public.booking_accepted_receipts");
    expect(sql).toContain("set state = 'committed'");
    expect(sql).toContain("set status = 'succeeded'");
    expect(sql).toContain("status = 'confirmed'");
    expect(sql).toContain("v_existing_map.intent_id is not null and p_outcome <> 'accepted'");
  });

  test("corrective authority RPCs remain service-role-only", () => {
    const sql = migrationSql("booking_delivery_authority");
    for (const signature of [
      "public.prepare_booking_provider_write(uuid,uuid)",
      "public.begin_provider_write(uuid,uuid)",
      "public.get_booking_provider_input(uuid)",
      "public.record_booking_delivery(uuid,text,text,text,jsonb,text,jsonb,jsonb)",
      "public.get_booking_confirmation(uuid,uuid,uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});

describe("unapplied Task 4 receipt migration boundary contract", () => {
  test("quarantines all legacy accepted history before defining confirmation authority", () => {
    const sql = migrationSql("booking_delivery_authority");
    const quarantineAt = sql.indexOf("legacy_accepted_receipt_unverifiable");
    const confirmationAt = sql.indexOf("function public.get_booking_confirmation");
    const recordAt = sql.indexOf("function public.record_booking_delivery");
    expect(quarantineAt).toBeGreaterThan(-1);
    expect(confirmationAt).toBeGreaterThan(quarantineAt);
    expect(sql.slice(0, recordAt)).not.toContain("insert into public.booking_accepted_receipts");
    expect(sql).not.toContain("booking_id uuid not null unique");
    expect(sql).toContain("not exists (select 1 from public.booking_receipt_conflicts c");
    expect(sql).toContain("receipt_history_quarantined");
    expect(sql).not.toContain("delete from public.receipts");
  });
});
