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
