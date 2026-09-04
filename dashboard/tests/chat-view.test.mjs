import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

async function renderChat(props) {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  try {
    const { ChatView } = await vite.ssrLoadModule("/src/views/ChatView.jsx");
    return renderToStaticMarkup(React.createElement(ChatView, props));
  } finally {
    await vite.close();
  }
}

test("a completely reset chat never fabricates an old call context", async () => {
  const html = await renderChat({
    messages: [],
    callContext: null,
    pendingApproval: null,
    onboardingCtaLabel: "Começar a entrevista de onboarding (voz)",
    onStartOnboarding() {},
  });

  assert.match(html, /Começar a entrevista de onboarding/);
  assert.doesNotMatch(html, /Contexto da ligação/);
  assert.doesNotMatch(html, /Encaixe no mesmo dia exige sua aprovação/);
  assert.doesNotMatch(html, />inglês</);
});

test("a real call context remains visible with its authoritative values", async () => {
  const html = await renderChat({
    messages: [],
    callContext: {
      language: "português",
      rule: "Atendimento emergencial exige aprovação.",
      status: "aguardando",
    },
    pendingApproval: null,
  });

  assert.match(html, /Contexto da ligação/);
  assert.match(html, /português/);
  assert.match(html, /Atendimento emergencial exige aprovação/);
  assert.match(html, /sua decisão/);
});

test("multiple ordinary call records remain chronological without fabricated context", async () => {
  const html = await renderChat({
    messages: [
      { id: "call-1", role: "agent", text: "Primeira chamada real.", time: "08:00" },
      { id: "call-2", role: "agent", text: "Segunda chamada real.", time: "09:00" },
      { id: "call-3", role: "agent", text: "Terceira chamada real.", time: "10:00" },
    ],
    callContext: null,
    pendingApproval: null,
  });

  for (const text of [
    "Primeira chamada real.",
    "Segunda chamada real.",
    "Terceira chamada real.",
  ]) assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(html, /Contexto da ligação/);
  assert.doesNotMatch(html, /Encaixe no mesmo dia exige sua aprovação/);
  assert.doesNotMatch(html, />inglês</);
});

test("an incomplete real call context never falls back to demo language or rule", async () => {
  const html = await renderChat({
    messages: [],
    callContext: { language: "", rule: null, status: "aguardando" },
    pendingApproval: {
      id: "approval-real",
      clientName: "Cliente real",
      location: "Irvine, CA",
      date: "2026-09-01",
      request: "Atendimento real aguardando decisão.",
      rule: "Regra real da aprovação.",
      status: "pendente",
    },
    onApprove() {},
    onAdjust() {},
    onReject() {},
  });

  assert.match(html, /Atendimento real aguardando decisão/);
  assert.match(html, /sua decisão/);
  assert.doesNotMatch(html, />inglês</);
  assert.doesNotMatch(html, /Encaixe no mesmo dia exige sua aprovação/);
});

// F02 — o card do timeline pertence ao caso narrado; outro caso pendente não
// herda a história do John nem ganha kicker/etiqueta/localização inventados.
const johnStory = [
  { id: "m-owner", role: "owner", text: "O que aconteceu com o pedido do John Miller?", time: "09:32" },
  { id: "m-summary", role: "agent", label: "Ligou · agente operacional", text: "John ligou pedindo encaixe hoje.", time: "09:33", relatedApprovalId: "approval-john" },
  { id: "m-question", role: "agent", text: "Quer aprovar este encaixe?", time: "09:33", relatedApprovalId: "approval-john" },
];

const mariaPending = {
  id: "approval-maria",
  clientName: "Maria Alvarez",
  request: "Transferência para falar com a equipe.",
  rule: "Transferências fora de emergência dependem da equipe.",
  proposedAction: "Retornar em espanhol em até 30 minutos.",
  status: "pendente",
  location: "Novato, CA",
  date: "2026-08-15",
};

test("the timeline card is bound to the narrated case, not to whichever case is pending", async () => {
  const html = await renderChat({
    messages: [
      ...johnStory,
      { id: "m-system", role: "system", text: "Você aprovou o pedido de John Miller somente para este caso. A Memória não foi alterada.", time: "09:40", relatedApprovalId: "approval-john" },
    ],
    callContext: { language: "inglês", rule: "Encaixe no mesmo dia exige sua aprovação.", status: "aprovado" },
    pendingApproval: mariaPending,
    onApprove() {},
    onAdjust() {},
    onReject() {},
  });

  // Row 4 shows John's resolution where his card was; Maria is not narrated here.
  assert.match(html, /mobile-approval[^>]*>[^]*?system-message[^]*?Você aprovou o pedido de John Miller/);
  assert.doesNotMatch(html, /class="approval-card/);
  assert.doesNotMatch(html, /Maria Alvarez/);
  assert.doesNotMatch(html, /Pedido urgente/);
  // Never claim "nothing pending" while Maria is pending.
  assert.doesNotMatch(html, /Nenhuma decisão pendente/);
  // The resolution renders once (inside the timeline), not again as a recent message.
  assert.equal(html.match(/Você aprovou o pedido de John Miller/g).length, 1);
  // Status icon follows the text: registrada = done, not pending orange.
  assert.match(html, /causal-icon--done/);
  assert.doesNotMatch(html, /causal-icon--pending/);
  // Desktop handoff still points at the next pending case (inspector carries Maria).
  assert.match(html, /<button[^>]*desktop-timeline-handoff[^>]*>[^]*?Exceção pronta/);
  assert.doesNotMatch(html, /timeline-approval-node is-resolved/);
});

test("the narrated case still pending renders its card with the jump anchor on the status cell", async () => {
  const html = await renderChat({
    messages: johnStory,
    callContext: { language: "inglês", rule: "Encaixe no mesmo dia exige sua aprovação.", status: "aguardando" },
    pendingApproval: { id: "approval-john", clientName: "John Miller", urgencyLabel: "Pedido urgente · mesmo dia", isNewClient: true, location: "San Rafael, CA", date: "2026-08-15", request: "Antes das 17h", status: "pendente" },
    onApprove() {},
    onAdjust() {},
    onReject() {},
  });

  assert.match(html, /id="approval-card"/);
  assert.match(html, /causal-jump" href="#approval-card"/);
  assert.match(html, /causal-icon--pending/);
  assert.match(html, /Pedido urgente · mesmo dia/);
  assert.match(html, /Novo cliente/);
  assert.match(html, /San Rafael, CA/);
  assert.match(html, /data-approval-id="approval-john"/);
});

test("a case without urgency, new-client or location data renders none of them", async () => {
  const html = await renderChat({
    messages: [],
    callContext: { language: "", rule: null, status: "aguardando" },
    pendingApproval: { id: "approval-real", clientName: "Cliente real", date: "2026-09-01", request: "Atendimento real.", rule: "Regra real.", status: "pendente" },
    onApprove() {},
    onAdjust() {},
    onReject() {},
  });

  assert.match(html, /Cliente real/);
  assert.doesNotMatch(html, /Pedido urgente/);
  assert.doesNotMatch(html, /approval-kicker/);
  assert.doesNotMatch(html, /Novo cliente/);
  assert.doesNotMatch(html, /San Rafael/);
  assert.doesNotMatch(html, /John Miller/);
});

test("with every case decided the timeline closes: empty state, resolved node and status handoff", async () => {
  const html = await renderChat({
    messages: [
      ...johnStory,
      { id: "m-system", role: "system", text: "Você aprovou o pedido de John Miller somente para este caso. A Memória não foi alterada.", time: "09:40", relatedApprovalId: "approval-john" },
    ],
    callContext: { language: "inglês", rule: "Encaixe no mesmo dia exige sua aprovação.", status: "aprovado" },
    pendingApproval: null,
  });

  assert.match(html, /timeline-approval-node is-resolved/);
  assert.match(html, /desktop-timeline-handoff is-resolved/);
  assert.match(html, /Você aprovou o pedido de John Miller/);
  assert.doesNotMatch(html, /Nenhuma decisão pendente/); // the resolution message takes the slot
});
