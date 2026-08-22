// Onboarding batch approval: the interview records suggested rules; the owner
// approves or rejects them in Memória through the server's decide_rule RPC.
import { test } from "node:test";
import assert from "node:assert/strict";

import { decideMemoryVia } from "../src/data/memory-decisions.js";
import { onboardingCta, statusLineFor, defaultSessionType } from "../src/voice/panel-copy.js";

function clientRecording(responses = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (responses[name]?.error) return { data: null, error: responses[name].error };
      return { data: responses[name]?.data ?? "new-rule-id", error: null };
    },
  };
}

test("approving a suggested rule calls decide_rule with aprovado and returns the new version id", async () => {
  const client = clientRecording({ decide_rule: { data: "rule-v2" } });
  const result = await decideMemoryVia(client, "rule-v1", "aprovado");
  assert.deepEqual(client.calls, [{ name: "decide_rule", args: { p_rule: "rule-v1", p_decision: "aprovado" } }]);
  assert.equal(result, "rule-v2");
});

test("rejecting a suggested rule calls decide_rule with rejeitado", async () => {
  const client = clientRecording();
  await decideMemoryVia(client, "rule-x", "rejeitado");
  assert.deepEqual(client.calls[0], { name: "decide_rule", args: { p_rule: "rule-x", p_decision: "rejeitado" } });
});

test("any other decision is refused before reaching the server", async () => {
  const client = clientRecording();
  await assert.rejects(() => decideMemoryVia(client, "rule-x", "revogado"), /decision_invalid/);
  assert.equal(client.calls.length, 0);
});

test("a server error surfaces as a thrown error with the server message", async () => {
  const client = clientRecording({ decide_rule: { error: { message: "rule_not_suggestable" } } });
  await assert.rejects(() => decideMemoryVia(client, "rule-x", "aprovado"), /rule_not_suggestable/);
});

test("the voice panel speaks Portuguese for the onboarding interview and EN/ES for role-play", () => {
  assert.match(statusLineFor("onboarding"), /portugu/i);
  assert.match(statusLineFor("owner_browser"), /ingl|espanhol/i);
  assert.match(statusLineFor(undefined), /ingl|espanhol/i);
});

test("a tenant still in onboarding defaults the voice dialog to the interview", () => {
  assert.equal(defaultSessionType("onboarding"), "onboarding");
  assert.equal(defaultSessionType("active"), "owner_browser");
  assert.equal(defaultSessionType(undefined), "owner_browser");
});

test("the chat empty state offers the interview CTA only while the tenant is onboarding", () => {
  assert.match(onboardingCta("onboarding") ?? "", /entrevista/i);
  assert.equal(onboardingCta("active"), null);
  assert.equal(onboardingCta(undefined), null);
});
