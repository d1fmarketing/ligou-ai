import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_KEY,
  createDashboardGateway,
  createInitialState,
} from "../src/data/gateway.js";
import {
  isDashboardState,
  sendMessageTransition,
} from "../src/data/model.js";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    dump(key) {
      return values.get(key);
    },
  };
}

test("loads deterministic fixtures and persists them with the versioned key", async () => {
  const storage = createStorage();
  const gateway = createDashboardGateway(storage);

  const result = await gateway.loadState();

  assert.equal(result.warning, null);
  assert.equal(result.state.fixtureDate, "2026-08-15");
  assert.equal(result.state.business.name, "Costa Home Services");
  assert.equal(result.state.business.owner, "Rafael");
  assert.equal(result.state.pendingApprovalCount, 2);
  assert.equal(isDashboardState(result.state), true);
  assert.equal(JSON.parse(storage.dump(STORAGE_KEY)).schemaVersion, 1);
});

test("pure message transition leaves its input untouched and uses an honest fallback", () => {
  const initial = createInitialState();
  const result = sendMessageTransition(initial, "Tem alguma integração agora?");

  assert.equal(initial.messages.length, 3);
  assert.equal(result.state.messages.length, 5);
  assert.equal(result.userMessage.role, "owner");
  assert.equal(result.agentMessage.role, "agent");
  assert.match(result.agentMessage.text, /protótipo de frontend/i);
  assert.match(result.agentMessage.text, /não acesso telefonia/i);
});

test("chat responses persist across a fresh gateway reload", async () => {
  const storage = createStorage();
  const firstGateway = createDashboardGateway(storage);
  const sent = await firstGateway.sendMessage("Quantas aprovações estão pendentes?");

  assert.match(sent.agentMessage.text, /2 decisões pendentes/i);
  assert.equal(sent.state.messages.at(-1).id, sent.agentMessage.id);

  const reloaded = await createDashboardGateway(storage).loadState();
  assert.equal(reloaded.state.messages.length, 5);
  assert.equal(reloaded.state.messages.at(-1).text, sent.agentMessage.text);
});

test("case-only approval resolves one item without creating a memory rule", async () => {
  const storage = createStorage();
  const gateway = createDashboardGateway(storage);
  const initial = await gateway.loadState();
  const initialMemoryCount = initial.state.memory.length;

  const result = await gateway.approveApproval("approval-john-urgent", {
    mode: "case",
  });

  assert.equal(result.approval.status, "aprovada");
  assert.equal(result.approval.resolution.mode, "case");
  assert.equal(result.memoryEntry, null);
  assert.equal(result.state.memory.length, initialMemoryCount);
  assert.equal(result.state.pendingApprovalCount, 1);
  assert.match(result.systemMessage.text, /somente para este caso/i);

  const reloaded = await createDashboardGateway(storage).loadState();
  assert.equal(reloaded.state.pendingApprovalCount, 1);
  assert.equal(
    reloaded.state.approvals.find((item) => item.id === "approval-john-urgent")
      .status,
    "aprovada",
  );
});

test("save-as-rule approval requires and records scope and duration", async () => {
  const storage = createStorage();
  const gateway = createDashboardGateway(storage);
  const initial = await gateway.loadState();

  await assert.rejects(
    gateway.approveApproval("approval-john-urgent", { mode: "rule" }),
    /escolha o escopo/i,
  );

  const result = await gateway.approveApproval("approval-john-urgent", {
    mode: "rule",
    scope: "location",
    duration: "temporary",
    ruleText: "Em San Rafael, encaixes urgentes podem ser oferecidos até as 17h.",
    effectiveUntil: "2026-08-31",
  });

  assert.equal(result.approval.status, "aprovada");
  assert.equal(result.approval.resolution.mode, "rule");
  assert.equal(result.approval.resolution.scope, "localização");
  assert.equal(result.approval.resolution.duration, "temporária");
  assert.equal(result.memoryEntry.status, "temporária");
  assert.equal(result.memoryEntry.scope, "localização");
  assert.equal(result.memoryEntry.effectiveUntil, "2026-08-31");
  assert.equal(result.state.memory.length, initial.state.memory.length + 1);

  const memory = await createDashboardGateway(storage).listMemory({
    status: "temporária",
    search: "San Rafael",
  });
  assert.equal(memory.entries.length, 1);
  assert.equal(memory.entries[0].id, result.memoryEntry.id);
});

test("adjusting a proposal preserves its pending status", async () => {
  const storage = createStorage();
  const gateway = createDashboardGateway(storage);

  const result = await gateway.adjustApproval(
    "approval-john-urgent",
    "Oferecer a primeira janela disponível amanhã de manhã.",
  );

  assert.equal(result.approval.status, "pendente");
  assert.equal(
    result.approval.proposedAction,
    "Oferecer a primeira janela disponível amanhã de manhã.",
  );
  assert.equal(result.adjustment.before, "Abrir um encaixe para atendimento ainda hoje.");
  assert.equal(result.state.pendingApprovalCount, 2);
  assert.match(result.systemMessage.text, /continua pendente/i);

  const approvals = await createDashboardGateway(storage).listApprovals({
    status: "pendente",
    search: "John",
  });
  assert.equal(approvals.approvals.length, 1);
  assert.equal(approvals.approvals[0].proposedAction, result.adjustment.after);
});

test("rejecting archives a proposal without changing memory", async () => {
  const storage = createStorage();
  const gateway = createDashboardGateway(storage);
  const initial = await gateway.loadState();

  const result = await gateway.rejectApproval(
    "approval-john-urgent",
    "Hoje não há equipe disponível.",
  );

  assert.equal(result.approval.status, "recusada");
  assert.equal(result.approval.resolution.reason, "Hoje não há equipe disponível.");
  assert.equal(result.state.memory.length, initial.state.memory.length);
  assert.equal(result.state.pendingApprovalCount, 1);
  assert.match(result.systemMessage.text, /sem alterar a Memória/i);
});

test("memory edits preserve before/after and increment the version", async () => {
  const storage = createStorage();
  const gateway = createDashboardGateway(storage);
  const initial = await gateway.loadState();
  const before = initial.state.memory.find(
    (entry) => entry.id === "memory-same-day-approval",
  );

  const result = await gateway.updateMemory("memory-same-day-approval", {
    text: "Encaixe no mesmo dia exige aprovação de Rafael antes da confirmação.",
    scope: "serviço",
  });

  assert.equal(result.entry.version, before.version + 1);
  assert.equal(result.comparison.before.text, before.text);
  assert.equal(result.comparison.after.text, result.entry.text);
  assert.equal(result.comparison.before.scope, "geral");
  assert.equal(result.comparison.after.scope, "serviço");

  const reloaded = await createDashboardGateway(storage).loadState();
  const persisted = reloaded.state.memory.find(
    (entry) => entry.id === "memory-same-day-approval",
  );
  assert.equal(persisted.version, before.version + 1);
  assert.equal(persisted.history.at(-1).after.text, result.entry.text);
});

test("revocation removes a rule from active use and preserves a local receipt", async () => {
  const storage = createStorage();
  const gateway = createDashboardGateway(storage);

  const result = await gateway.revokeMemory(
    "memory-language-preference",
    "Rafael decidiu substituir esta orientação.",
  );

  assert.equal(result.entry.status, "revogada");
  assert.equal(result.entry.revocationReceipt.id, result.receipt.id);
  assert.equal(result.receipt.revokedBy, "Rafael");
  assert.equal(result.receipt.reason, "Rafael decidiu substituir esta orientação.");
  assert.ok(
    result.state.revocationReceipts.some((receipt) => receipt.id === result.receipt.id),
  );

  const active = await createDashboardGateway(storage).listMemory({ status: "ativa" });
  assert.equal(
    active.entries.some((entry) => entry.id === "memory-language-preference"),
    false,
  );
  const revoked = await createDashboardGateway(storage).listMemory({
    status: "revogada",
  });
  assert.equal(
    revoked.entries.some((entry) => entry.id === "memory-language-preference"),
    true,
  );
});

test("reset restores the exact fixture after local mutations", async () => {
  const storage = createStorage();
  const gateway = createDashboardGateway(storage);
  await gateway.sendMessage("Como funciona?");
  await gateway.rejectApproval("approval-john-urgent", "Sem equipe.");

  const reset = await gateway.resetPrototype();

  assert.deepEqual(reset.state, createInitialState());
  const reloaded = await createDashboardGateway(storage).loadState();
  assert.deepEqual(reloaded.state, createInitialState());
});

test("corrupt storage recovers fixtures and exposes a one-time warning", async () => {
  const storage = createStorage({ [STORAGE_KEY]: "{not-valid-json" });
  const gateway = createDashboardGateway(storage);

  const recovered = await gateway.loadState();

  assert.match(recovered.warning, /dados locais eram inválidos/i);
  assert.deepEqual(recovered.state, createInitialState());
  assert.equal(isDashboardState(JSON.parse(storage.dump(STORAGE_KEY))), true);

  const secondLoad = await gateway.loadState();
  assert.equal(secondLoad.warning, null);
});
