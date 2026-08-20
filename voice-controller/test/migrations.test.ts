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
