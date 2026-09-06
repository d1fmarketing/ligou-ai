import { expect, test } from "bun:test";
import * as server from "../src/server.ts";
import { createOnboardingAgenda, getAgendaAction } from "../src/onboarding-agenda.ts";
import { onboardingAgendaDigest } from "../src/onboarding-agenda-store.ts";
import { synthesizeOnboardingSpeech } from "../src/onboarding-speech.ts";
import { sessionBudgetEnvelope } from "../src/config.ts";

test("full finite website interview has a bounded provider-safe window without raising the existing budget",()=>{
  expect(server.onboardingSessionMaxMinutes(3)).toBe(55);
  expect(server.onboardingSessionMaxMinutes(2)).toBe(30);
  expect(sessionBudgetEnvelope("onboarding").reservationUsd).toBe(7.5);
  expect(sessionBudgetEnvelope("onboarding").hardLimitUsd).toBe(7.5);
});

const callId = "33333333-3333-4333-8333-333333333333";
const agenda = createOnboardingAgenda({ interviewId: callId, callId, draftId: "draft", draftHash: "a".repeat(64), sourceResultId: "source", sourceResultHash: "b".repeat(64) }, [
  { id: "territory", source: "owner_private_requirement", subject: "territory", questionPt: "Quais cidades atende?", coverageRefs: [], relatedItemIds: [], blocking: true },
]);
const prepared: any = { scope: { callId, ownerId: "owner", requestId: "request" }, projection: {}, stored: {
  agenda, revision: 0, storeVersion: 0, digest: onboardingAgendaDigest(agenda), receiptId: "receipt", nextAction: getAgendaAction(agenda), state: "unfinished", replayed: false,
} };
const synth = (action: any) => synthesizeOnboardingSpeech(action, { openaiKey: "synthetic", fetchImpl: async () => new Response(new Uint8Array([73,68,51,4,0]), { headers: { "content-type": "audio/mpeg" } }) });

test("protocol3 reserves one durable speech attempt before exact TTS and completes before returning", async () => {
  const order: string[] = [];
  const result = await server.synthesizeClaimedWebsiteOpening(prepared, "Foghorn Air", {
    evidence: {
      claimSpeech: async ({ action }: any) => { order.push("claim"); return { claimed: true, status: "preparing", action }; },
      completeSpeech: async ({ payload }: any) => { order.push("complete"); return { status: "ready", payload }; },
      failSpeech: async () => { throw new Error("unexpected fail"); },
    } as any,
    synthesize: async (action: any) => { order.push("tts"); return synth(action); },
  });
  expect(order).toEqual(["claim", "tts", "complete"]);
  expect(result.openingPayload.text).toStartWith("Oi! Aqui é o Ligou, agente de inteligência artificial da Foghorn Air. Eu já analisei seu website.");
  expect(result.openingPayload.callId).toBe(callId);
});

test("unowned or ambiguous persisted speech never starts a second TTS attempt", async () => {
  let calls = 0;
  for (const status of ["preparing", "failed", "played", "superseded"]) {
    await expect(server.synthesizeClaimedWebsiteOpening(prepared, "Foghorn Air", {
      evidence: { claimSpeech: async () => ({ claimed: false, status }) } as any,
      synthesize: async (action: any) => { calls++; return synth(action); },
    })).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("accepted TTS followed by ambiguous completion retains incurred cost", async () => {
  let cost = 0;
  await expect(server.synthesizeClaimedWebsiteOpening(prepared, "Foghorn Air", {
    evidence: { claimSpeech: async () => ({ claimed: true, status: "preparing" }), completeSpeech: async () => { throw new Error("ambiguous-write"); } } as any,
    synthesize: async (action: any) => { const payload = await synth(action); cost = payload.cost_usd; return payload; },
  })).rejects.toMatchObject({ usageResolved: true });
  expect(cost).toBeGreaterThan(0);
});

test("protocol3 Realtime session has no tools and no automatic response", () => {
  const config = server.buildRealtimeSessionConfig({ model: "gpt-realtime-2.1", instructions: "test", tools: [{ name: "unsafe" }], voice: "ash", openingMode: "application_tts_v1", onboardingProtocolVersion: 3 } as any);
  expect(config.tools).toEqual([]);
  expect(config.tool_choice).toBe("none");
  expect(config.output_modalities).toEqual(["text"]);
  expect(config.audio.input.turn_detection).toMatchObject({ create_response: false, interrupt_response: false });
});

test("protocol3 missing prepared source fails truthfully without initializing generic resume", async () => {
  const names: string[] = [];
  await expect(server.prepareRequiredWebsiteInterview({ ownerId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222", callId, requestId: "44444444-4444-4444-8444-444444444444" }, {
    rpc: async (name: string) => { names.push(name); return { data: { prepared: false }, error: null }; },
  })).rejects.toThrow("website_interview_prepared_source_required");
  expect(names).toEqual(["resolve_prepared_website_source"]);
});
