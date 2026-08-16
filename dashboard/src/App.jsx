import { useCallback, useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconCheck, IconRefresh, IconSparkles, IconX } from "@tabler/icons-react";
import { AppShell } from "./components/AppShell.jsx";
import { ApprovalCard } from "./components/ApprovalCard.jsx";
import { Dialog } from "./components/Dialog.jsx";
import { dashboardGateway } from "./data/gateway.js";
import { ApprovalsView } from "./views/ApprovalsView.jsx";
import { ChatView } from "./views/ChatView.jsx";
import { MemoryView } from "./views/MemoryView.jsx";

const ROUTES = new Set(["ligou", "memoria", "aprovacoes"]);
const VOICE_PHRASES = [
  "O que aconteceu com o pedido do John Miller?",
  "Quais decisões estão esperando por mim?",
  "Mostre as regras para encaixes no mesmo dia.",
  "O que você resolveu sozinho hoje?",
];

function routeFromHash() {
  const route = window.location.hash.replace("#", "");
  return ROUTES.has(route) ? route : "ligou";
}

function unwrapState(result) {
  return result?.state || result;
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(onClose, 4200);
    return () => window.clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;
  return (
    <div className={`toast toast--${toast.kind || "success"}`} role="status">
      {toast.kind === "warning" ? <IconAlertTriangle aria-hidden="true" /> : <IconCheck aria-hidden="true" />}
      <span>{toast.text}</span>
      <button type="button" onClick={onClose} aria-label="Fechar aviso"><IconX aria-hidden="true" /></button>
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryFilter, setMemoryFilter] = useState("all");
  const [selectedApprovalId, setSelectedApprovalId] = useState(null);

  const refresh = useCallback(async () => {
    const result = await dashboardGateway.loadState();
    const nextState = unwrapState(result);
    setState(nextState);
    if (result?.warning) setToast({ kind: "warning", text: result.warning });
    setLoading(false);
    return nextState;
  }, []);

  useEffect(() => {
    refresh().catch(() => {
      setLoading(false);
      setToast({ kind: "warning", text: "Não foi possível carregar os dados locais. A demonstração pode ser restaurada." });
    });
  }, [refresh]);

  useEffect(() => {
    const handleHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", handleHashChange);
    if (!window.location.hash || !ROUTES.has(window.location.hash.slice(1))) {
      window.history.replaceState(null, "", "#ligou");
    }
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const approvals = state?.approvals || [];
  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => approval.status === "pendente"),
    [approvals],
  );
  const pendingApproval = pendingApprovals[0] || null;

  useEffect(() => {
    if (!selectedApprovalId && approvals.length) setSelectedApprovalId(approvals[0].id);
  }, [approvals, selectedApprovalId]);

  const perform = useCallback(async (action, successMessage) => {
    try {
      await action();
      await refresh();
      setDialog(null);
      if (successMessage) setToast({ kind: "success", text: successMessage });
    } catch (error) {
      setToast({ kind: "warning", text: error?.message || "A ação não pôde ser concluída nesta demonstração." });
    }
  }, [refresh]);

  const sendMessage = async (text) => {
    setSending(true);
    try {
      await dashboardGateway.sendMessage(text);
      await refresh();
    } catch (error) {
      setToast({ kind: "warning", text: error?.message || "Não foi possível enviar a mensagem." });
    } finally {
      setSending(false);
    }
  };

  const openApproval = (approval) => setDialog({ type: "approve", approval });
  const openAdjustment = (approval) => setDialog({ type: "adjust", approval });
  const openRejection = (approval) => setDialog({ type: "reject", approval });
  const openMemoryEdit = (entry) => setDialog({ type: "memory-edit", entry });
  const openMemoryRevoke = (entry) => setDialog({ type: "memory-revoke", entry });

  if (loading) {
    return (
      <main className="loading-screen">
        <img src="/assets/ligou-avatar-v1.png" alt="" />
        <p>Preparando o painel do Ligou…</p>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="error-screen">
        <IconAlertTriangle aria-hidden="true" />
        <h1>O painel não carregou</h1>
        <button className="button button--primary" type="button" onClick={() => window.location.reload()}>
          Tentar novamente
        </button>
      </main>
    );
  }

  const inspector = route === "ligou" ? (
    <div className="inspector-content">
      <span className="inspector-kicker">Agora</span>
      <h2>{pendingApproval ? "Sua decisão é necessária" : "Operação dentro das regras"}</h2>
      <p>{pendingApproval ? "O Ligou reuniu o contexto e não improvisou diante da exceção." : "Não há exceções aguardando aprovação neste momento."}</p>
      <ApprovalCard
        approval={pendingApproval}
        compact
        onApprove={openApproval}
        onAdjust={openAdjustment}
        onReject={openRejection}
      />
    </div>
  ) : null;

  return (
    <>
      <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
      <AppShell
        route={route}
        pendingCount={pendingApprovals.length}
        business={state.business}
        inspector={inspector}
        onReset={() => setDialog({ type: "reset" })}
      >
        {route === "ligou" ? (
          <ChatView
            messages={state.messages}
            callContext={state.callContext}
            pendingApproval={pendingApproval}
            sending={sending}
            onSend={sendMessage}
            onVoice={() => setDialog({ type: "voice" })}
            onApprove={openApproval}
            onAdjust={openAdjustment}
            onReject={openRejection}
          />
        ) : null}
        {route === "memoria" ? (
          <MemoryView
            entries={state.memory || []}
            query={memoryQuery}
            setQuery={setMemoryQuery}
            filter={memoryFilter}
            setFilter={setMemoryFilter}
            onEdit={openMemoryEdit}
            onRevoke={openMemoryRevoke}
          />
        ) : null}
        {route === "aprovacoes" ? (
          <ApprovalsView
            approvals={approvals}
            selectedId={selectedApprovalId}
            onSelect={setSelectedApprovalId}
            onApprove={openApproval}
            onAdjust={openAdjustment}
            onReject={openRejection}
          />
        ) : null}
      </AppShell>

      <DashboardDialog
        dialog={dialog}
        onClose={() => setDialog(null)}
        onSendVoice={(phrase) => perform(() => dashboardGateway.sendMessage(phrase), "Frase demonstrativa enviada ao Ligou.")}
        onApprove={(id, decision) => perform(
          () => dashboardGateway.approveApproval(id, decision),
          decision.mode === "rule" ? "Decisão aprovada e salva na Memória." : "Decisão aprovada somente para este caso.",
        )}
        onAdjust={(id, text) => perform(() => dashboardGateway.adjustApproval(id, text), "Proposta ajustada e mantida para sua aprovação.")}
        onReject={(id) => perform(() => dashboardGateway.rejectApproval(id), "Proposta recusada sem alterar a Memória.")}
        onUpdateMemory={(id, patch) => perform(() => dashboardGateway.updateMemory(id, patch), "Regra atualizada com uma nova versão.")}
        onRevokeMemory={(id) => perform(() => dashboardGateway.revokeMemory(id), "Regra retirada da memória ativa. Recibo local preservado.")}
        onReset={() => perform(() => dashboardGateway.resetPrototype(), "Dados de exemplo restaurados.")}
      />

      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}

function DashboardDialog({
  dialog,
  onClose,
  onSendVoice,
  onApprove,
  onAdjust,
  onReject,
  onUpdateMemory,
  onRevokeMemory,
  onReset,
}) {
  const [approvalMode, setApprovalMode] = useState("case");
  const [scope, setScope] = useState("service");
  const [duration, setDuration] = useState("permanent");
  const [adjustment, setAdjustment] = useState("");
  const [memoryText, setMemoryText] = useState("");

  useEffect(() => {
    setApprovalMode("case");
    setScope("service");
    setDuration("permanent");
    setAdjustment(dialog?.approval?.proposedAction || "");
    setMemoryText(dialog?.entry?.text || "");
  }, [dialog]);

  if (!dialog) return null;

  if (dialog.type === "voice") {
    return (
      <Dialog open title="Voz · demonstração" description="Nenhum microfone será acessado. Escolha uma frase para simular uma conversa por voz." onClose={onClose}>
        <div className="voice-phrases">
          {VOICE_PHRASES.map((phrase) => (
            <button type="button" key={phrase} onClick={() => onSendVoice(phrase)}>
              <IconSparkles aria-hidden="true" />
              <span>{phrase}</span>
            </button>
          ))}
        </div>
      </Dialog>
    );
  }

  if (dialog.type === "approve") {
    const approval = dialog.approval;
    return (
      <Dialog open title="Aprovar esta decisão" description={`Defina se a decisão para ${approval.clientName} vale só agora ou também vira uma regra.`} onClose={onClose}>
        <form className="dialog-form" onSubmit={(event) => {
          event.preventDefault();
          onApprove(approval.id, { mode: approvalMode, scope, duration });
        }}>
          <fieldset className="choice-grid">
            <legend>Como aplicar?</legend>
            <label className={approvalMode === "case" ? "is-selected" : ""}>
              <input type="radio" name="approval-mode" value="case" checked={approvalMode === "case"} onChange={() => setApprovalMode("case")} />
              <span><strong>Somente este caso</strong><small>Autoriza o pedido de John sem alterar a memória.</small></span>
            </label>
            <label className={approvalMode === "rule" ? "is-selected" : ""}>
              <input type="radio" name="approval-mode" value="rule" checked={approvalMode === "rule"} onChange={() => setApprovalMode("rule")} />
              <span><strong>Salvar como regra</strong><small>Cria uma nova orientação operacional aprovada.</small></span>
            </label>
          </fieldset>
          {approvalMode === "rule" ? (
            <div className="rule-options">
              <label>Escopo
                <select value={scope} onChange={(event) => setScope(event.target.value)}>
                  <option value="client">Este cliente</option>
                  <option value="service">Este serviço</option>
                  <option value="location">Esta localização</option>
                  <option value="general">Regra geral</option>
                </select>
              </label>
              <label>Duração
                <select value={duration} onChange={(event) => setDuration(event.target.value)}>
                  <option value="permanent">Permanente</option>
                  <option value="temporary">Temporária</option>
                </select>
              </label>
            </div>
          ) : null}
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button--primary" type="submit">Confirmar aprovação</button>
          </div>
        </form>
      </Dialog>
    );
  }

  if (dialog.type === "adjust") {
    const approval = dialog.approval;
    return (
      <Dialog open title="Ajustar proposta" description="O pedido continuará pendente até você aprovar a versão ajustada." onClose={onClose}>
        <form className="dialog-form" onSubmit={(event) => {
          event.preventDefault();
          if (adjustment.trim()) onAdjust(approval.id, adjustment.trim());
        }}>
          <label>Nova proposta
            <textarea value={adjustment} onChange={(event) => setAdjustment(event.target.value)} rows="5" required />
          </label>
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button--primary" type="submit">Salvar ajuste</button>
          </div>
        </form>
      </Dialog>
    );
  }

  if (dialog.type === "reject") {
    return (
      <Dialog open title="Recusar proposta" description="A proposta será arquivada. Nenhuma regra da Memória será alterada." onClose={onClose}>
        <div className="confirmation-block">
          <p>Recusar o pedido de <strong>{dialog.approval.clientName}</strong>?</p>
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Voltar</button>
            <button className="button button--danger" type="button" onClick={() => onReject(dialog.approval.id)}>Recusar proposta</button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (dialog.type === "memory-edit") {
    const entry = dialog.entry;
    return (
      <Dialog open title="Editar regra" description={`A versão ${entry.version || 1} continuará no histórico local.`} onClose={onClose} size="large">
        <form className="dialog-form" onSubmit={(event) => {
          event.preventDefault();
          if (memoryText.trim() && memoryText.trim() !== entry.text) onUpdateMemory(entry.id, { text: memoryText.trim() });
        }}>
          <div className="comparison-grid">
            <div><span>Antes · v{entry.version || 1}</span><p>{entry.text}</p></div>
            <label><span>Depois · v{(entry.version || 1) + 1}</span><textarea value={memoryText} onChange={(event) => setMemoryText(event.target.value)} rows="6" required /></label>
          </div>
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button--primary" type="submit" disabled={memoryText.trim() === entry.text}>Criar nova versão</button>
          </div>
        </form>
      </Dialog>
    );
  }

  if (dialog.type === "memory-revoke") {
    return (
      <Dialog open title="Apagar da memória ativa" description="A regra deixará de orientar o Ligou. Um recibo de revogação ficará salvo apenas neste navegador." onClose={onClose}>
        <div className="confirmation-block">
          <blockquote>{dialog.entry.text}</blockquote>
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button--danger" type="button" onClick={() => onRevokeMemory(dialog.entry.id)}>Apagar da memória</button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (dialog.type === "reset") {
    return (
      <Dialog open title="Restaurar demonstração" description="Todas as mudanças feitas neste navegador serão substituídas pelos dados originais de exemplo." onClose={onClose}>
        <div className="confirmation-block">
          <p>Esta ação reinicia conversas, regras e aprovações do protótipo.</p>
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button--primary" type="button" onClick={onReset}><IconRefresh aria-hidden="true" /> Restaurar</button>
          </div>
        </div>
      </Dialog>
    );
  }

  return null;
}
