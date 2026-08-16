import { STORAGE_KEY, createInitialState } from "./fixtures.js";
import {
  adjustApprovalTransition,
  approveApprovalTransition,
  cloneState,
  isDashboardState,
  rejectApprovalTransition,
  revokeMemoryTransition,
  sendMessageTransition,
  updateMemoryTransition,
} from "./model.js";

export { STORAGE_KEY, createInitialState };

const CORRUPT_STORAGE_WARNING =
  "Os dados locais eram inválidos e o protótipo foi restaurado.";
const STORAGE_UNAVAILABLE_WARNING =
  "O armazenamento local não está disponível. As mudanças durarão somente nesta aba.";

function normalizeSearch(value) {
  return String(value || "")
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function createVolatileStorage() {
  const values = new Map();
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
  };
}

export function createDashboardGateway(storage = globalThis.localStorage) {
  const fallbackStorage = createVolatileStorage();
  const adapter = storage || fallbackStorage;
  let volatileState = createInitialState();
  let forceVolatile = !storage;
  let queue = Promise.resolve();

  function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function persist(state) {
    volatileState = cloneState(state);
    try {
      adapter.setItem(STORAGE_KEY, JSON.stringify(state));
      return null;
    } catch {
      forceVolatile = true;
      return STORAGE_UNAVAILABLE_WARNING;
    }
  }

  function restoreFixture(warning) {
    const state = createInitialState();
    const persistenceWarning = persist(state);
    return {
      state,
      warning: persistenceWarning || warning,
    };
  }

  function readState() {
    if (forceVolatile) {
      return {
        state: cloneState(volatileState),
        warning: storage ? STORAGE_UNAVAILABLE_WARNING : null,
      };
    }

    let raw;
    try {
      raw = adapter.getItem(STORAGE_KEY);
    } catch {
      forceVolatile = true;
      return {
        state: cloneState(volatileState),
        warning: STORAGE_UNAVAILABLE_WARNING,
      };
    }

    if (raw === null) return restoreFixture(null);

    try {
      const parsed = JSON.parse(raw);
      if (!isDashboardState(parsed)) {
        return restoreFixture(CORRUPT_STORAGE_WARNING);
      }
      volatileState = cloneState(parsed);
      return { state: parsed, warning: null };
    } catch {
      return restoreFixture(CORRUPT_STORAGE_WARNING);
    }
  }

  function commitTransition(transition) {
    const persistenceWarning = persist(transition.state);
    return {
      ...transition,
      state: cloneState(transition.state),
      warning: persistenceWarning,
    };
  }

  function mutate(transitionFactory) {
    return enqueue(() => {
      const loaded = readState();
      const transition = transitionFactory(loaded.state);
      const committed = commitTransition(transition);
      return {
        ...committed,
        warning: committed.warning || loaded.warning,
      };
    });
  }

  return {
    loadState() {
      return enqueue(() => {
        const loaded = readState();
        return {
          state: cloneState(loaded.state),
          warning: loaded.warning,
        };
      });
    },

    sendMessage(text) {
      return mutate((state) => sendMessageTransition(state, text));
    },

    resetPrototype() {
      return enqueue(() => {
        forceVolatile = !storage;
        const state = createInitialState();
        const warning = persist(state);
        return { state: cloneState(state), warning };
      });
    },

    listMemory(filters = {}) {
      return enqueue(() => {
        const loaded = readState();
        const search = normalizeSearch(filters.search || filters.query);
        const entries = loaded.state.memory
          .filter((entry) => {
            if (
              filters.status &&
              filters.status !== "todos" &&
              entry.status !== filters.status
            ) {
              return false;
            }
            if (
              filters.category &&
              filters.category !== "todas" &&
              entry.category !== filters.category
            ) {
              return false;
            }
            if (
              filters.scope &&
              filters.scope !== "todos" &&
              entry.scope !== filters.scope
            ) {
              return false;
            }
            if (!search) return true;
            return normalizeSearch(
              `${entry.text} ${entry.category} ${entry.origin} ${entry.scope}`,
            ).includes(search);
          })
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        return {
          state: cloneState(loaded.state),
          entries: cloneState(entries),
          warning: loaded.warning,
        };
      });
    },

    updateMemory(memoryId, patch) {
      return mutate((state) => updateMemoryTransition(state, memoryId, patch));
    },

    revokeMemory(memoryId, reason) {
      return mutate((state) => revokeMemoryTransition(state, memoryId, reason));
    },

    listApprovals(filters = {}) {
      return enqueue(() => {
        const loaded = readState();
        const search = normalizeSearch(filters.search || filters.query);
        const statusOrder = { pendente: 0, aprovada: 1, recusada: 2 };
        const approvals = loaded.state.approvals
          .filter((approval) => {
            if (
              filters.status &&
              filters.status !== "todas" &&
              approval.status !== filters.status
            ) {
              return false;
            }
            if (!search) return true;
            return normalizeSearch(
              `${approval.clientName} ${approval.request} ${approval.rule} ${approval.location}`,
            ).includes(search);
          })
          .sort((left, right) => {
            const statusDifference =
              statusOrder[left.status] - statusOrder[right.status];
            return statusDifference || right.updatedAt.localeCompare(left.updatedAt);
          });
        return {
          state: cloneState(loaded.state),
          approvals: cloneState(approvals),
          warning: loaded.warning,
        };
      });
    },

    approveApproval(approvalId, options) {
      return mutate((state) =>
        approveApprovalTransition(state, approvalId, options),
      );
    },

    adjustApproval(approvalId, proposal) {
      return mutate((state) =>
        adjustApprovalTransition(state, approvalId, proposal),
      );
    },

    rejectApproval(approvalId, reason) {
      return mutate((state) =>
        rejectApprovalTransition(state, approvalId, reason),
      );
    },
  };
}

export const dashboardGateway = createDashboardGateway();
