import {
  DASHBOARD_SCHEMA_VERSION,
  FIXTURE_DATE,
} from "./fixtures.js";

const EVENT_BASE_TIME = Date.parse("2026-08-15T16:40:00.000Z");
const MEMORY_EDITABLE_FIELDS = [
  "text",
  "category",
  "status",
  "origin",
  "scope",
  "effectiveFrom",
  "effectiveUntil",
  "approvedBy",
];

export function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

export function isDashboardState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schemaVersion !== DASHBOARD_SCHEMA_VERSION) return false;
  if (!Number.isInteger(value.revision) || value.revision < 0) return false;
  if (value.fixtureDate !== FIXTURE_DATE) return false;
  if (
    !value.business ||
    typeof value.business.name !== "string" ||
    typeof value.business.owner !== "string"
  ) {
    return false;
  }
  if (!value.callContext || typeof value.callContext.id !== "string") return false;
  if (!Array.isArray(value.messages) || !Array.isArray(value.memory)) return false;
  if (!Array.isArray(value.approvals) || !Array.isArray(value.activities)) return false;
  if (!Array.isArray(value.revocationReceipts)) return false;
  if (
    !value.messages.every(
      (message) =>
        message &&
        typeof message.id === "string" &&
        ["owner", "agent", "system"].includes(message.role) &&
        typeof message.text === "string" &&
        typeof message.time === "string",
    )
  ) {
    return false;
  }
  if (
    !value.memory.every(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.text === "string" &&
        Number.isInteger(entry.version) &&
        entry.version > 0 &&
        ["sugerida", "ativa", "temporária", "revogada"].includes(entry.status),
    )
  ) {
    return false;
  }
  if (
    !value.approvals.every(
      (approval) =>
        approval &&
        typeof approval.id === "string" &&
        typeof approval.clientName === "string" &&
        ["pendente", "aprovada", "recusada"].includes(approval.status),
    )
  ) {
    return false;
  }
  return true;
}

export function timestampForRevision(revision) {
  return new Date(EVENT_BASE_TIME + Math.max(0, revision - 1) * 60_000).toISOString();
}

export function displayTimeForRevision(revision) {
  const minutesSinceStart = Math.max(0, revision - 1);
  const totalMinutes = 9 * 60 + 40 + minutesSinceStart;
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function beginMutation(state) {
  if (!isDashboardState(state)) {
    throw new Error("Estado do dashboard inválido.");
  }
  const next = cloneState(state);
  next.revision += 1;
  next.updatedAt = timestampForRevision(next.revision);
  return next;
}

function finishMutation(state) {
  state.pendingApprovalCount = state.approvals.filter(
    (approval) => approval.status === "pendente",
  ).length;
  return state;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} é obrigatório.`);
  }
  return value.trim();
}

function findApproval(state, approvalId) {
  const approval = state.approvals.find((item) => item.id === approvalId);
  if (!approval) throw new Error("Aprovação não encontrada.");
  return approval;
}

function findMemory(state, memoryId) {
  const entry = state.memory.find((item) => item.id === memoryId);
  if (!entry) throw new Error("Regra de memória não encontrada.");
  return entry;
}

function appendActivity(state, type, text, details = {}) {
  const activity = {
    id: `activity-${String(state.revision).padStart(4, "0")}-${state.activities.length + 1}`,
    type,
    text,
    timestamp: state.updatedAt,
    ...details,
  };
  state.activities.push(activity);
  return activity;
}

function appendSystemMessage(state, text, details = {}) {
  const message = {
    id: `message-system-${String(state.revision).padStart(4, "0")}-${state.messages.length + 1}`,
    role: "system",
    label: "Decisão registrada",
    text,
    time: displayTimeForRevision(state.revision),
    timestamp: state.updatedAt,
    ...details,
  };
  state.messages.push(message);
  return message;
}

function searchText(value) {
  return value
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function deterministicReply(text, state) {
  const normalized = searchText(text);
  const johnApproval = state.approvals.find(
    (approval) => approval.id === "approval-john-urgent",
  );
  const pendingCount = state.approvals.filter(
    (approval) => approval.status === "pendente",
  ).length;

  if (/john|pedido|encaixe|chamine|chaminé/.test(normalized)) {
    if (johnApproval?.status === "pendente") {
      return "O pedido do John continua aguardando sua decisão. A regra exige aprovação para um encaixe no mesmo dia; deixei o caso pronto em Aprovações.";
    }
    if (johnApproval?.status === "aprovada") {
      return "O pedido do John foi aprovado. Registrei a decisão e o próximo passo é confirmar o encaixe com ele em inglês.";
    }
    return "O pedido do John foi recusado e arquivado sem alterar a Memória.";
  }

  if (/memoria|regra|aprendeu|aprendizado/.test(normalized)) {
    const activeCount = state.memory.filter((entry) =>
      ["ativa", "temporária"].includes(entry.status),
    ).length;
    return `A Memória tem ${activeCount} regras em uso. Regras sugeridas só entram em operação depois da sua aprovação, e regras revogadas preservam um recibo local.`;
  }

  if (/aprovacao|aprovar|pendente|decisao/.test(normalized)) {
    return pendingCount === 1
      ? "Existe 1 decisão pendente. Posso mostrar o pedido, a regra consultada e a consequência antes de você decidir."
      : `Existem ${pendingCount} decisões pendentes. Em cada uma, mostro o pedido, a regra consultada e a consequência antes de você decidir.`;
  }

  if (/ingles|espanhol|portugues|idioma/.test(normalized)) {
    return "Neste exemplo eu registro ligações em inglês ou espanhol e explico a operação para você em português.";
  }

  if (/agenda|horario|amanha|hoje/.test(normalized)) {
    return "Neste protótipo, a agenda e os horários são dados simulados. Eu consigo demonstrar a decisão operacional, mas não consulto uma agenda externa real.";
  }

  if (/ajuda|pode fazer|funciona/.test(normalized)) {
    return "Posso demonstrar consultas sobre ligações, regras da Memória e Aprovações. Os dados são locais e simulados; não há telefonia, integrações ou backend conectados.";
  }

  return "Este é um protótipo de frontend. Posso responder sobre o pedido do John, Memória, regras, idiomas e Aprovações usando apenas os dados de exemplo; não acesso telefonia, agenda externa ou backend.";
}

export function sendMessageTransition(state, rawText) {
  const text = requireText(rawText, "Mensagem");
  const next = beginMutation(state);
  const time = displayTimeForRevision(next.revision);
  const userMessage = {
    id: `message-owner-${String(next.revision).padStart(4, "0")}`,
    role: "owner",
    text,
    time,
    timestamp: next.updatedAt,
  };
  next.messages.push(userMessage);

  const agentMessage = {
    id: `message-agent-${String(next.revision).padStart(4, "0")}`,
    role: "agent",
    label: "Ligou · agente operacional",
    text: deterministicReply(text, next),
    time,
    timestamp: next.updatedAt,
  };
  next.messages.push(agentMessage);
  appendActivity(next, "chat.message", "Rafael conversou com o Ligou.", {
    messageId: userMessage.id,
  });

  return { state: finishMutation(next), userMessage, agentMessage };
}

export function updateMemoryTransition(state, memoryId, rawPatch) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
    throw new Error("Alterações da memória são obrigatórias.");
  }
  const next = beginMutation(state);
  const entry = findMemory(next, memoryId);
  if (entry.status === "revogada") {
    throw new Error("Uma regra revogada não pode ser editada.");
  }

  const before = {};
  const after = {};
  for (const field of MEMORY_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rawPatch, field)) {
      if (field === "text") requireText(rawPatch[field], "Texto da regra");
      before[field] = entry[field] ?? null;
      entry[field] = rawPatch[field];
      after[field] = entry[field] ?? null;
    }
  }
  if (Object.keys(after).length === 0) {
    throw new Error("Nenhuma alteração válida foi informada.");
  }
  if (
    Object.prototype.hasOwnProperty.call(after, "status") &&
    !["sugerida", "ativa", "temporária"].includes(after.status)
  ) {
    throw new Error("Use revokeMemory() para revogar uma regra.");
  }

  entry.version += 1;
  entry.updatedAt = next.updatedAt;
  entry.history = Array.isArray(entry.history) ? entry.history : [];
  const comparison = {
    version: entry.version,
    changedAt: next.updatedAt,
    before,
    after,
  };
  entry.history.push(comparison);
  appendActivity(next, "memory.updated", `Regra “${entry.text}” atualizada.`, {
    memoryId: entry.id,
    version: entry.version,
  });

  return {
    state: finishMutation(next),
    entry: cloneState(entry),
    comparison: cloneState(comparison),
  };
}

export function revokeMemoryTransition(state, memoryId, rawReason) {
  const reason = requireText(
    rawReason || "Removida da memória pelo proprietário.",
    "Motivo",
  );
  const next = beginMutation(state);
  const entry = findMemory(next, memoryId);
  if (entry.status === "revogada") {
    throw new Error("Esta regra já foi revogada.");
  }

  const previousVersion = entry.version;
  entry.version += 1;
  entry.status = "revogada";
  entry.updatedAt = next.updatedAt;
  const receipt = {
    id: `receipt-${entry.id}-v${entry.version}`,
    memoryId: entry.id,
    previousVersion,
    revokedVersion: entry.version,
    text: entry.text,
    reason,
    revokedAt: next.updatedAt,
    revokedBy: next.business.owner,
  };
  entry.revocationReceipt = receipt;
  next.revocationReceipts.push(receipt);
  appendActivity(next, "memory.revoked", `Regra “${entry.text}” revogada.`, {
    memoryId: entry.id,
    receiptId: receipt.id,
  });

  return {
    state: finishMutation(next),
    entry: cloneState(entry),
    receipt: cloneState(receipt),
  };
}

function normalizeApprovalMode(value) {
  const normalized = searchText(String(value || ""));
  if (["case", "caso", "somente este caso", "single"].includes(normalized)) {
    return "case";
  }
  if (["rule", "regra", "salvar como regra", "memory"].includes(normalized)) {
    return "rule";
  }
  throw new Error("Escolha aprovar somente este caso ou salvar como regra.");
}

function normalizeScope(value) {
  const normalized = searchText(String(value || ""));
  const scopes = {
    client: "cliente",
    cliente: "cliente",
    service: "serviço",
    servico: "serviço",
    location: "localização",
    localizacao: "localização",
    general: "geral",
    geral: "geral",
  };
  if (!scopes[normalized]) {
    throw new Error("Escolha o escopo: cliente, serviço, localização ou geral.");
  }
  return scopes[normalized];
}

function normalizeDuration(value) {
  const normalized = searchText(String(value || ""));
  if (["temporary", "temporaria", "temporario"].includes(normalized)) {
    return "temporária";
  }
  if (["permanent", "permanente"].includes(normalized)) return "permanente";
  throw new Error("Escolha uma duração temporária ou permanente.");
}

export function approveApprovalTransition(state, approvalId, rawOptions = {}) {
  const next = beginMutation(state);
  const approval = findApproval(next, approvalId);
  if (approval.status !== "pendente") {
    throw new Error("Esta decisão não está mais pendente.");
  }

  const options =
    typeof rawOptions === "string" ? { mode: rawOptions } : rawOptions || {};
  const mode = normalizeApprovalMode(options.mode || options.decision);
  let memoryEntry = null;

  approval.status = "aprovada";
  approval.updatedAt = next.updatedAt;
  approval.resolution = {
    mode,
    approvedBy: next.business.owner,
    approvedAt: next.updatedAt,
  };

  if (mode === "rule") {
    const scope = normalizeScope(options.scope);
    const duration = normalizeDuration(options.duration);
    const text = requireText(
      options.ruleText || options.text || approval.proposedAction,
      "Texto da regra",
    );
    memoryEntry = {
      id: `memory-${approval.id}-${String(next.revision).padStart(4, "0")}`,
      title: options.title || `Decisão para ${approval.clientName}`,
      text,
      category: options.category || "Operação",
      status: duration === "temporária" ? "temporária" : "ativa",
      origin: `Aprovação de ${approval.clientName}`,
      scope,
      version: 1,
      effectiveFrom: FIXTURE_DATE,
      approvedBy: next.business.owner,
      updatedAt: next.updatedAt,
      history: [],
      ...(duration === "temporária"
        ? { effectiveUntil: options.effectiveUntil || "2026-09-15" }
        : {}),
    };
    next.memory.unshift(memoryEntry);
    approval.resolution.scope = scope;
    approval.resolution.duration = duration;
    approval.resolution.memoryId = memoryEntry.id;
  }

  if (approval.relatedCallId === next.callContext.id) {
    next.callContext.status = "aprovado";
  }
  const systemMessage = appendSystemMessage(
    next,
    mode === "rule"
      ? `Você aprovou o pedido de ${approval.clientName} e salvou a decisão como regra ${memoryEntry.scope}.`
      : `Você aprovou o pedido de ${approval.clientName} somente para este caso. A Memória não foi alterada.`,
    { relatedApprovalId: approval.id },
  );
  appendActivity(next, "approval.approved", `Pedido de ${approval.clientName} aprovado.`, {
    approvalId: approval.id,
    mode,
    memoryId: memoryEntry?.id || null,
  });

  return {
    state: finishMutation(next),
    approval: cloneState(approval),
    memoryEntry: memoryEntry ? cloneState(memoryEntry) : null,
    systemMessage: cloneState(systemMessage),
  };
}

export function adjustApprovalTransition(state, approvalId, rawProposal) {
  const proposal =
    typeof rawProposal === "string"
      ? requireText(rawProposal, "Proposta ajustada")
      : requireText(
          rawProposal?.proposedAction || rawProposal?.text,
          "Proposta ajustada",
        );
  const next = beginMutation(state);
  const approval = findApproval(next, approvalId);
  if (approval.status !== "pendente") {
    throw new Error("Somente decisões pendentes podem ser ajustadas.");
  }

  const before = approval.proposedAction;
  approval.proposedAction = proposal;
  approval.updatedAt = next.updatedAt;
  approval.adjustments = Array.isArray(approval.adjustments)
    ? approval.adjustments
    : [];
  const adjustment = {
    id: `adjustment-${approval.id}-${String(next.revision).padStart(4, "0")}`,
    before,
    after: proposal,
    adjustedAt: next.updatedAt,
    adjustedBy: next.business.owner,
  };
  approval.adjustments.push(adjustment);
  const systemMessage = appendSystemMessage(
    next,
    `Você ajustou a proposta para ${approval.clientName}. A decisão continua pendente até a aprovação.`,
    { relatedApprovalId: approval.id },
  );
  appendActivity(next, "approval.adjusted", `Proposta de ${approval.clientName} ajustada.`, {
    approvalId: approval.id,
    adjustmentId: adjustment.id,
  });

  return {
    state: finishMutation(next),
    approval: cloneState(approval),
    adjustment: cloneState(adjustment),
    systemMessage: cloneState(systemMessage),
  };
}

export function rejectApprovalTransition(state, approvalId, rawReason) {
  const reason = requireText(rawReason || "Recusada pelo proprietário.", "Motivo");
  const next = beginMutation(state);
  const approval = findApproval(next, approvalId);
  if (approval.status !== "pendente") {
    throw new Error("Esta decisão não está mais pendente.");
  }

  approval.status = "recusada";
  approval.updatedAt = next.updatedAt;
  approval.resolution = {
    mode: "rejected",
    reason,
    rejectedBy: next.business.owner,
    rejectedAt: next.updatedAt,
  };
  if (approval.relatedCallId === next.callContext.id) {
    next.callContext.status = "recusado";
  }
  const systemMessage = appendSystemMessage(
    next,
    `Você recusou o pedido de ${approval.clientName}. A proposta foi arquivada sem alterar a Memória.`,
    { relatedApprovalId: approval.id },
  );
  appendActivity(next, "approval.rejected", `Pedido de ${approval.clientName} recusado.`, {
    approvalId: approval.id,
  });

  return {
    state: finishMutation(next),
    approval: cloneState(approval),
    systemMessage: cloneState(systemMessage),
  };
}
