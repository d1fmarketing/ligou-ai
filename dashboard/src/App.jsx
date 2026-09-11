import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconCheck, IconRefresh, IconX } from "@tabler/icons-react";
import { AppShell } from "./components/AppShell.jsx";
import { ApprovalCard } from "./components/ApprovalCard.jsx";
import { Dialog } from "./components/Dialog.jsx";
import { ErrorScreen, LoadingScreen, LockedView } from "./components/screens.jsx";
import { dashboardGateway } from "./data/gateway.js";
import { supabaseGateway } from "./data/gateway.supabase.js";
import { requireSuccess } from "./data/gateway-outcome.js";
import { ApprovalsView } from "./views/ApprovalsView.jsx";
import { ChatView } from "./views/ChatView.jsx";
import { DiscoveryReviewView } from "./views/DiscoveryReviewView.jsx";
import { WebsiteSetupView } from "./views/WebsiteSetupView.jsx";
import { MemoryView } from "./views/MemoryView.jsx";
import { PowersView } from "./views/PowersView.jsx";
import { SettingsView } from "./views/SettingsView.jsx";
import { Login } from "./auth/Login.jsx";
import { VoicePanel } from "./voice/VoicePanel.jsx";
import { supabase, supabaseConfigured } from "./lib/supabase.js";
import { resolveFunctionsBase } from "./runtime-config.js";
import { runOwnerBootstrap } from "./auth/bootstrap.js";
import { defaultSessionType, onboardingCta } from "./voice/panel-copy.js";
import { signInWithGoogle } from "./auth/google.js";
import { stripProviderFields } from "./auth/session-storage.js";
import {
  preserveWebsiteSetupAfterReadFailure,
  websiteSetupOwnsScreen,
} from "./website-setup-model.js";

const ROUTES = new Set(["ligou", "memoria", "aprovacoes", "poderes", "conta"]);

function routeFromHash() {
  const route = window.location.hash.replace("#", "");
  return ROUTES.has(route) ? route : "ligou";
}

function unwrapState(result) {
  return result?.state || result;
}

function Toast({ toast, onClose }) {
  // Depender só de `toast`: um onClose recriado a cada render do AppInner
  // reiniciaria o timer em qualquer digitação e o aviso nunca sumiria.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!toast) return undefined;
    // Sucesso tem gêmeo inline (.system-message) — 3,2s bastam; aviso não tem.
    const timer = window.setTimeout(() => onCloseRef.current(), toast.kind === "warning" ? 4200 : 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;
  return (
    <div className={`toast toast--${toast.kind || "success"}`} role="status">
      {toast.kind === "warning" ? <IconAlertTriangle aria-hidden="true" /> : <IconCheck aria-hidden="true" />}
      <span>{toast.text}</span>
      <button type="button" onClick={onClose} aria-label="Fechar aviso"><IconX aria-hidden="true" /></button>
    </div>
  );
}

function cleanOAuthCallbackUrl() {
  const { search, pathname, hash } = window.location;
  if (/[?&](code|error|error_description)=/.test(search)) {
    window.history.replaceState(null, "", `${pathname}${hash && ROUTES.has(hash.slice(1)) ? hash : ""}`);
  }
}

export function App() {
  const [session, setSession] = useState(undefined); // undefined = checking
  const [boot, setBoot] = useState({ status: "idle" });
  // Provider tokens are delivered exactly once by supabase-js on sign-in; they are
  // held only in this ref until the handoff and never enter React state.
  const providerTokensRef = useRef(null);

  useEffect(() => {
    if (!supabaseConfigured) { setSession(null); return undefined; }
    // Capture the one-shot provider tokens into the ref, then store only a
    // provider-stripped session in React state: the raw tokens must never be
    // reachable through state, DevTools, or anything that serializes it.
    const capture = (s) => {
      if (s?.provider_token) {
        providerTokensRef.current = {
          providerToken: s.provider_token,
          providerRefreshToken: s.provider_refresh_token ?? null,
        };
      }
      return s ? stripProviderFields(s) : null;
    };
    supabase.auth.getSession().then(({ data }) => { setSession(capture(data.session)); });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => { setSession(capture(s)); });
    return () => sub.subscription.unsubscribe();
  }, []);

  // One bootstrap per authenticated user, guarded by a ref rather than effect
  // cleanup: the effect re-runs on every new session object (sign-in, token
  // refresh — including the rotation the bootstrap itself awaits), and a
  // cleanup-based cancellation would cancel its own in-flight run. Stale
  // completions are discarded by comparing the user id recorded at start.
  const bootRunRef = useRef({ userId: null, started: false });
  useEffect(() => {
    if (!supabaseConfigured) return;
    if (session === undefined) return;
    if (!session) {
      providerTokensRef.current = null;
      bootRunRef.current = { userId: null, started: false };
      setBoot({ status: "idle" });
      return;
    }
    const userId = session.user?.id ?? null;
    if (!userId) return;
    if (bootRunRef.current.started && bootRunRef.current.userId === userId) return;
    bootRunRef.current = { userId, started: true };
    const stillCurrent = () => bootRunRef.current.started && bootRunRef.current.userId === userId;
    (async () => {
      setBoot({ status: "running", stage: "tenant" });
      try {
        const tokens = providerTokensRef.current;
        providerTokensRef.current = null;
        const result = await runOwnerBootstrap({
          client: supabase,
          session,
          providerToken: tokens?.providerToken ?? null,
          providerRefreshToken: tokens?.providerRefreshToken ?? null,
          functionsBase: resolveFunctionsBase(import.meta.env.VITE_SUPABASE_FUNCTIONS_URL, import.meta.env.VITE_SUPABASE_URL),
          flagStorage: window.sessionStorage,
          onStage: (stage) => { if (stillCurrent()) setBoot((prev) => ({ ...prev, status: "running", stage })); },
        });
        cleanOAuthCallbackUrl();
        if (tokens?.providerToken) {
          // Rotate the library's in-memory session so no provider token survives
          // the handoff; awaited so a failure is known before the UI proceeds.
          await supabase.auth.refreshSession().catch(() => {});
        }
        if (result.action === "reauth_consent") {
          await signInWithGoogle(supabase, {
            origin: window.location.origin,
            baseUrl: import.meta.env.BASE_URL,
            withConsent: true,
          });
          return; // the page is navigating to Google
        }
        supabaseGateway.setTenant(result.tenant.tenant_id);
        if (stillCurrent()) {
          setBoot({ status: "ready", userId, tenant: result.tenant, connector: result.connector });
        }
      } catch (error) {
        cleanOAuthCallbackUrl();
        if (stillCurrent()) {
          bootRunRef.current = { userId: null, started: false }; // allow a retry after the error screen
          setBoot({ status: "error", message: error?.message || "bootstrap_failed" });
        }
      }
    })();
  }, [session]);

  if (!supabaseConfigured) return <AppInner />; // prototype mode: no env, no auth, no voice
  if (session === undefined) return <LoadingScreen>Abrindo o painel…</LoadingScreen>;
  if (!session) return <Login />;
  if (boot.status === "error") {
    return (
      <ErrorScreen title="Não foi possível preparar sua conta" detail={boot.message}>
        <button className="button button--primary" type="button" onClick={() => window.location.reload()}>Tentar novamente</button>
        <button className="button button--ghost" type="button" onClick={() => supabase.auth.signOut()}>Sair</button>
      </ErrorScreen>
    );
  }
  if (boot.status !== "ready") {
    return (
      <LoadingScreen>
        {boot.stage === "calendar" ? "Conectando sua agenda do Google…" : "Preparando sua conta…"}
      </LoadingScreen>
    );
  }
  return (
    <AppInner
      user={session.user}
      tenant={{
        id: boot.tenant.tenant_id,
        name: boot.tenant.name,
        timezone: boot.tenant.timezone,
        status: boot.tenant.status,
        operational_mode: boot.tenant.operational_mode,
      }}
      onLogout={() => supabase.auth.signOut()}
    />
  );
}

const gateway = supabaseConfigured ? supabaseGateway : dashboardGateway;

export function LigouWorkspace({ showDiscovery = false, discoveryProps = {}, chatProps = {} }) {
  return (
    <>
      {showDiscovery ? <DiscoveryReviewView {...discoveryProps} /> : null}
      <ChatView {...chatProps} />
    </>
  );
}

function AppInner({ user = null, tenant = null, onLogout = () => {} } = {}) {
  const [route, setRoute] = useState(routeFromHash);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryFilter, setMemoryFilter] = useState("all");
  const [selectedApprovalId, setSelectedApprovalId] = useState(null);
  const [discovery, setDiscovery] = useState({ phase: supabaseConfigured ? "loading" : "hidden" });
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [websiteSetup, setWebsiteSetup] = useState({
    state: supabaseConfigured ? "loading" : "onboarding_complete",
  });
  const [websiteSetupBusy, setWebsiteSetupBusy] = useState(false);
  const [websiteSetupLoadError, setWebsiteSetupLoadError] = useState(null);

  const refreshWebsiteSetup = useCallback(async () => {
    if (typeof gateway.loadWebsiteSetup !== "function") return null;
    try {
      const next = await gateway.loadWebsiteSetup();
      setWebsiteSetup(next);
      setWebsiteSetupLoadError(null);
      return next;
    } catch {
      setWebsiteSetup((current) => preserveWebsiteSetupAfterReadFailure(current));
      setWebsiteSetupLoadError("Não foi possível atualizar agora. Tentaremos novamente.");
      return null;
    }
  }, []);

  const refreshDiscovery = useCallback(async () => {
    if (typeof gateway.loadCompanyDiscovery !== "function") return null;
    const next = await gateway.loadCompanyDiscovery();
    setDiscovery(next);
    return next;
  }, []);

  const refresh = useCallback(async () => {
    const result = await gateway.loadState();
    const nextState = unwrapState(result);
    setState(nextState);
    if (result?.warning) setToast({ kind: "warning", text: result.warning });
    setLoading(false);
    void refreshDiscovery(nextState);
    void refreshWebsiteSetup();
    return nextState;
  }, [refreshDiscovery, refreshWebsiteSetup]);

  useEffect(() => {
    refresh().catch(() => {
      setLoading(false);
      setToast({ kind: "warning", text: "Não foi possível carregar os dados locais. A demonstração pode ser restaurada." });
    });
  }, [refresh]);

  // realtime: cases/rules/calls/notifications mutate -> live refresh (both tabs, no reload)
  useEffect(() => {
    if (typeof gateway.subscribe !== "function") return undefined;
    let timer = null;
    const unsubscribe = gateway.subscribe(() => {
      if (timer) return; // debounce bursts
      timer = window.setTimeout(() => { timer = null; refresh(); }, 300);
    });
    return () => { if (timer) window.clearTimeout(timer); unsubscribe?.(); };
  }, [refresh]);

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(routeFromHash());
      // Voltar/avançar do browser troca a rota por baixo de um modal aberto;
      // fecha diálogos de decisão — mas nunca o de voz (derrubaria a chamada).
      setDialog((current) => (current && current.type !== "voice" ? null : current));
    };
    window.addEventListener("hashchange", handleHashChange);
    if (!window.location.pathname.endsWith("/setup/website") &&
        (!window.location.hash || !ROUTES.has(window.location.hash.slice(1)))) {
      window.history.replaceState(null, "", "#ligou");
    }
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !tenant || websiteSetup.state === "loading") return;
    const ownsSetup = websiteSetupOwnsScreen(websiteSetup, tenant.status);
    if (ownsSetup && !window.location.pathname.endsWith("/setup/website")) {
      window.history.replaceState(null, "", "/dashboard/setup/website");
    } else if (!ownsSetup && window.location.pathname.endsWith("/setup/website")) {
      window.history.replaceState(null, "", "/dashboard/#ligou");
      setRoute("ligou");
    }
  }, [tenant, websiteSetup]);

  useEffect(() => {
    if (!["learning","onboarding_in_progress","onboarding_amendment_pending"].includes(websiteSetup.state)) return undefined;
    let reading=false;
    const timer = window.setInterval(() => {
      if(reading)return;
      reading=true;void refreshWebsiteSetup().finally(()=>{reading=false;});
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refreshWebsiteSetup, websiteSetup.state]);

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
      await refresh().catch(() => {});
      setToast({ kind: "warning", text: error?.message || "A ação não pôde ser concluída nesta demonstração." });
    }
  }, [refresh]);

  const [deciding, setDeciding] = useState(false);
  const decideSuggestion = useCallback(async (action, successMessage) => {
    if (deciding) return;
    setDeciding(true);
    try {
      await perform(action, successMessage);
    } finally {
      setDeciding(false);
    }
  }, [deciding, perform]);

  const sendMessage = async (text) => {
    setSending(true);
    try {
      await gateway.sendMessage(text);
      await refresh();
      return true;
    } catch (error) {
      setToast({ kind: "warning", text: error?.message || "Não foi possível enviar a mensagem." });
      return false;
    } finally {
      setSending(false);
    }
  };

  const openApproval = (approval) => setDialog({ type: "approve", approval });
  const openAdjustment = (approval) => setDialog({ type: "adjust", approval });
  const openRejection = (approval) => setDialog({ type: "reject", approval });
  const openMemoryEdit = (entry) => setDialog({ type: "memory-edit", entry });
  const openMemoryRevoke = (entry) => setDialog({ type: "memory-revoke", entry });

  const startDiscovery = async (url) => {
    if (discoveryBusy || typeof gateway.startCompanyDiscovery !== "function") return;
    setDiscoveryBusy(true);
    try {
      await gateway.startCompanyDiscovery(url);
      setDiscovery({ phase: "working", interviewAvailable: true });
      await refreshDiscovery(state);
    } catch (error) {
      setDiscovery({
        phase: "fallback",
        reason: error?.code || "failed",
        interviewAvailable: true,
      });
      throw error;
    } finally {
      setDiscoveryBusy(false);
    }
  };

  const confirmDiscoveryReview = async ({ review, reviewState }) => {
    if (discoveryBusy || typeof gateway.reviewCompanyDiscovery !== "function") return;
    setDiscoveryBusy(true);
    try {
      await gateway.reviewCompanyDiscovery(review, reviewState);
      await refresh();
      setToast({ kind: "success", text: "Revisão confirmada em um lote. Só suas decisões viraram perfil ou regra." });
    } catch (error) {
      setToast({ kind: "warning", text: error?.message || "A revisão não foi confirmada." });
      await refreshDiscovery(state).catch(() => {});
      throw error;
    } finally {
      setDiscoveryBusy(false);
    }
  };

  const startWebsiteSetup = async (url) => {
    if (websiteSetupBusy || typeof gateway.startWebsiteSetup !== "function") return;
    setWebsiteSetupBusy(true);
    try {
      await gateway.startWebsiteSetup(url);
      await refreshWebsiteSetup();
    } catch (error) {
      await refreshWebsiteSetup().catch(() => {});
      throw error;
    } finally {
      setWebsiteSetupBusy(false);
    }
  };

  const retryWebsiteSetup = async () => {
    if (websiteSetupBusy || !websiteSetup.job ||
        typeof gateway.retryWebsiteSetup !== "function") return;
    setWebsiteSetupBusy(true);
    try {
      await gateway.retryWebsiteSetup(websiteSetup.job.id, websiteSetup.job.version);
      await refreshWebsiteSetup();
    } catch (error) {
      await refreshWebsiteSetup().catch(() => {});
      throw error;
    } finally {
      setWebsiteSetupBusy(false);
    }
  };

  if (loading) {
    return <LoadingScreen>Preparando o painel do Ligou…</LoadingScreen>;
  }

  if (!state) {
    return (
      <ErrorScreen title="O painel não carregou">
        <button className="button button--primary" type="button" onClick={() => window.location.reload()}>
          Tentar novamente
        </button>
      </ErrorScreen>
    );
  }

  if (supabaseConfigured && tenant && websiteSetupOwnsScreen(websiteSetup, tenant.status)) {
    if (websiteSetup.state === "loading") {
      if (websiteSetupLoadError) {
        return (
          <ErrorScreen title="Não foi possível preparar o onboarding" detail={websiteSetupLoadError}>
            <button className="button button--primary" type="button" onClick={() => void refreshWebsiteSetup()}>
              Tentar novamente
            </button>
          </ErrorScreen>
        );
      }
      return <LoadingScreen>Preparando o onboarding…</LoadingScreen>;
    }
    return (
      <>
        <WebsiteSetupView
          setup={websiteSetup}
          busy={websiteSetupBusy}
          loadError={websiteSetupLoadError}
          onSubmit={startWebsiteSetup}
          onRetry={retryWebsiteSetup}
          onStartOnboarding={() => setDialog({
            type: "voice",
            sessionType: "onboarding",
            lockedOnboarding: true,
            onboardingProtocolVersion: 6,
          })}
        />
        <DashboardDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
          onSendVoice={(text) => perform(() => gateway.sendMessage(text), "Frase demonstrativa enviada ao Ligou.")}
          onApprove={() => {}}
          onAdjust={() => {}}
          onReject={() => {}}
          onUpdateMemory={() => {}}
          onRevokeMemory={() => {}}
          onReset={() => {}}
        />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
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
        prototype={!supabaseConfigured}
        onReset={() => setDialog({ type: "reset" })}
      >
        {route === "ligou" ? (
          <LigouWorkspace
            showDiscovery={false}
            discoveryProps={{
              discovery,
              busy: discoveryBusy,
              onDiscover: startDiscovery,
              onReview: confirmDiscoveryReview,
              onStartInterview: () => setDialog({ type: "voice", sessionType: "onboarding" }),
            }}
            chatProps={{
              messages: state.messages,
              callContext: state.callContext,
              pendingApproval,
              sending,
              onSend: sendMessage,
              onVoice: () => setDialog({ type: "voice", sessionType: defaultSessionType(tenant?.status) }),
              onboardingCtaLabel: onboardingCta(tenant?.status),
              onStartOnboarding: () => setDialog({ type: "voice", sessionType: "onboarding" }),
              prototype: !supabaseConfigured,
              onApprove: openApproval,
              onAdjust: openAdjustment,
              onReject: openRejection,
            }}
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
            decisionBusy={deciding}
            onApproveSuggestion={(entry) => decideSuggestion(() => requireSuccess(gateway.approveMemory(entry.id)), "Sugestão aprovada — o Ligou já passa a usar esta regra.")}
            onRejectSuggestion={(entry) => decideSuggestion(() => requireSuccess(gateway.rejectMemory(entry.id)), "Sugestão rejeitada. Nada mudou na memória ativa.")}
            onApproveAllSuggestions={(suggested) => decideSuggestion(async () => {
              let approved = 0;
              for (const entry of suggested) {
                const result = await gateway.approveMemory(entry.id);
                if (result?.warning) throw new Error(`Aprovadas ${approved} de ${suggested.length}. Falha: ${result.warning}`);
                approved += 1;
              }
            }, "Lote aprovado — regras ativas na memória. Se houver uma conversa de voz aberta, reinicie-a para valer as novas regras.")}
          />
        ) : null}
        {route === "poderes" ? (
          supabaseConfigured ? (
            <PowersView
              onToast={setToast}
              tenantId={tenant?.id}
              generation={state.testGeneration}
            />
          ) : (
            <LockedView
              title="Poderes"
              description="Você concede poderes, não aprova cada ação. O Ligou age sozinho dentro do que está concedido; fora disso, abre um caso para você."
            />
          )
        ) : null}
        {route === "conta" ? (
          supabaseConfigured && tenant ? (
            <SettingsView user={user} tenant={tenant} onToast={setToast} onLogout={onLogout} />
          ) : (
            <LockedView title="Conta" description="Sua conta Google e a conexão com a agenda." />
          )
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
        onSendVoice={(phrase) => perform(() => gateway.sendMessage(phrase), "Frase demonstrativa enviada ao Ligou.")}
        onApprove={(id, decision) => perform(
          () => requireSuccess(gateway.approveApproval(id, decision)),
          decision.mode === "rule" ? "Decisão aprovada e salva na Memória." : "Decisão aprovada somente para este caso.",
        )}
        onAdjust={(id, text) => perform(() => requireSuccess(gateway.adjustApproval(id, text)), "Proposta ajustada e mantida para sua aprovação.")}
        onReject={(id) => perform(() => requireSuccess(gateway.rejectApproval(id)), "Proposta recusada sem alterar a Memória.")}
        onUpdateMemory={(id, patch) => perform(() => requireSuccess(gateway.updateMemory(id, patch)), "Regra atualizada com uma nova versão.")}
        onRevokeMemory={(id) => perform(() => requireSuccess(gateway.revokeMemory(id)), "Regra retirada da memória ativa. Recibo local preservado.")}
        onReset={() => perform(
          async () => {
            const result = await gateway.resetPrototype();
            // Real mode: a warning means the reset did NOT happen — never show success.
            // (Prototype warnings are advisory: the in-memory reset still succeeded.)
            if (supabaseConfigured && result?.warning) throw new Error(result.warning);
            return result;
          },
          supabaseConfigured ? "Teste zerado por completo — a próxima entrevista começa do zero." : "Dados de exemplo restaurados.",
        )}
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
  // A ação primária cobre vários roundtrips; sem trava, o segundo clique (ou
  // Enter) repete a RPC já decidida e o sucesso vira toast de aviso.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setApprovalMode("case");
    setScope("service");
    setDuration("permanent");
    setAdjustment(dialog?.approval?.proposedAction || "");
    setMemoryText(dialog?.entry?.text || "");
    setBusy(false);
  }, [dialog]);

  const run = async (action, ...args) => {
    if (busy) return;
    setBusy(true);
    try {
      await action(...args);
    } finally {
      setBusy(false);
    }
  };

  if (!dialog) return null;

  if (dialog.type === "voice") {
    if (!supabaseConfigured) {
      return (
        <Dialog open title="Voz" description="Configure VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY para ativar as chamadas de voz." onClose={onClose}>
          <p>Ambiente sem Supabase configurado — a chamada real fica indisponível.</p>
        </Dialog>
      );
    }
    return (
      <VoicePanel
        onClose={onClose}
        initialSessionType={dialog.sessionType ?? "owner_browser"}
        lockedOnboarding={dialog.lockedOnboarding === true}
        onboardingProtocolVersion={dialog.onboardingProtocolVersion ?? 6}
      />
    );
  }

  if (dialog.type === "approve") {
    const approval = dialog.approval;
    return (
      <Dialog open title="Aprovar esta decisão" description={`Defina se a decisão para ${approval.clientName} vale só agora ou também vira uma regra.`} onClose={onClose}>
        <form className="dialog-form" onSubmit={(event) => {
          event.preventDefault();
          run(onApprove, approval.id, { mode: approvalMode, scope, duration });
        }}>
          {/* Eco dos fatos que a folha cobre — inclusive a proposta, que é o
              texto literalmente salvo como regra. Rótulos já existentes no produto. */}
          <div className="comparison-grid">
            {approval.request ? (
              <div><span>Solicitação</span><p>{approval.request}{approval.note ? ` · ${approval.note}` : ""}</p></div>
            ) : null}
            {approval.rule ? (
              <div><span>Regra consultada</span><p>{approval.rule}</p></div>
            ) : null}
            {approval.proposedAction ? (
              <div><span>Nova proposta</span><p>{approval.proposedAction}</p></div>
            ) : null}
          </div>
          {/* Opções + revelação num só filho do grid do formulário: um wrapper
              colapsado como linha própria ainda cobraria o gap (18 → 36px). */}
          <div className="choice-block">
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
            {/* Sempre montado; abre por transição de grid-template-rows (a folha
                não pula). `inert` tira os selects do Tab/leitor enquanto fechado. */}
            <div className="rule-options-reveal" data-open={approvalMode === "rule" ? "true" : "false"} inert={approvalMode !== "rule"}>
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
            </div>
          </div>
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button--primary" type="submit" disabled={busy}>Confirmar aprovação</button>
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
          if (adjustment.trim()) run(onAdjust, approval.id, adjustment.trim());
        }}>
          <label>Nova proposta
            <textarea value={adjustment} onChange={(event) => setAdjustment(event.target.value)} rows="5" required />
          </label>
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button--primary" type="submit" disabled={busy}>Salvar ajuste</button>
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
            <button className="button button--danger" type="button" disabled={busy} onClick={() => run(onReject, dialog.approval.id)}>Recusar proposta</button>
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
          if (memoryText.trim() && memoryText.trim() !== entry.text) run(onUpdateMemory, entry.id, { text: memoryText.trim() });
        }}>
          <div className="comparison-grid">
            <div><span>Antes · v{entry.version || 1}</span><p>{entry.text}</p></div>
            <label><span>Depois · v{(entry.version || 1) + 1}</span><textarea value={memoryText} onChange={(event) => setMemoryText(event.target.value)} rows="6" required /></label>
          </div>
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button--primary" type="submit" disabled={busy || memoryText.trim() === entry.text}>Criar nova versão</button>
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
            <button className="button button--danger" type="button" disabled={busy} onClick={() => run(onRevokeMemory, dialog.entry.id)}>Apagar da memória</button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (dialog.type === "reset") {
    const real = supabaseConfigured;
    return (
      <Dialog
        open
        title={real ? "Zerar memória de teste" : "Restaurar demonstração"}
        description={real
          ? "Conversas do painel, retomada do onboarding, regras, aprovações e poderes de teste serão zerados. Disponível apenas em modo de simulação."
          : "Todas as mudanças feitas neste navegador serão substituídas pelos dados originais de exemplo."}
        onClose={onClose}
      >
        <div className="confirmation-block">
          <p>{real
            ? "O histórico auditável fica preservado no banco, mas nenhum estado anterior participa do próximo teste. Login, Google/Calendar e custos não são apagados."
            : "Esta ação reinicia conversas, regras e aprovações do protótipo."}</p>
          <div className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>Cancelar</button>
            <button className="button button--primary" type="button" disabled={busy} onClick={() => run(onReset)}><IconRefresh aria-hidden="true" /> {real ? "Zerar teste completo" : "Restaurar"}</button>
          </div>
        </div>
      </Dialog>
    );
  }

  return null;
}
