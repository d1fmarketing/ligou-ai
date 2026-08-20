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
