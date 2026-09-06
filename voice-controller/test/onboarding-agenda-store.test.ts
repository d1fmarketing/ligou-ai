import { expect, test } from "bun:test";
import { createOnboardingAgenda, getAgendaAction } from "../src/onboarding-agenda.ts";

const binding = { interviewId: "11111111-1111-4111-8111-111111111111", callId: "11111111-1111-4111-8111-111111111111", draftId: "22222222-2222-4222-8222-222222222222", draftHash: "a".repeat(64), sourceResultId: "33333333-3333-4333-8333-333333333333", sourceResultHash: "b".repeat(64) };
const agenda = createOnboardingAgenda(binding, [{ id: "gap", subject: "territory", questionPt: "Onde atende?", source: "ambiguity", coverageRefs: ["area"], relatedItemIds: [], blocking: true }]);
const scope = { ownerId: "44444444-4444-4444-8444-444444444444", callId: binding.callId, requestId: "55555555-5555-4555-8555-555555555555" };
test("reads exact queue and stable action proof from canonical store result", async () => {
  const { createOnboardingAgendaStore, onboardingAgendaDigest } = await import("../src/onboarding-agenda-store.ts");
  const store = createOnboardingAgendaStore({ rpc: async () => ({ data: { agenda, revision: 0, storeVersion: 0, digest: onboardingAgendaDigest(agenda), receiptId: scope.requestId, nextAction: getAgendaAction(agenda), state: "unfinished", replayed: false }, error: null }) });
  const read = await store.readWebsiteInterview(scope);
  expect(read.nextAction.itemId).toBe("gap");
  expect(read.nextAction.spokenPt).toBe("Onde atende?");
  expect(read.revision).toBe(0);
  expect(Object.isFrozen(read.agenda)).toBe(true);
});
test("readback rejects corrupt agenda instead of projecting complete", async () => {
  const { createOnboardingAgendaStore } = await import("../src/onboarding-agenda-store.ts");
  const store = createOnboardingAgendaStore({ rpc: async () => ({ data: { agenda: { ...agenda, revision: 1 }, digest: "a".repeat(64), receiptId: scope.requestId, nextAction: getAgendaAction(agenda) }, error: null }) });
  await expect(store.readWebsiteInterview(scope)).rejects.toThrow();
});
test("readback rejects switched call and wrong digest", async () => {
  const { createOnboardingAgendaStore } = await import("../src/onboarding-agenda-store.ts");
  const store = createOnboardingAgendaStore({ rpc: async () => ({ data: { agenda, digest: "0".repeat(64), receiptId: scope.requestId, nextAction: getAgendaAction(agenda) }, error: null }) });
  await expect(store.readWebsiteInterview({ ...scope, callId: scope.requestId })).rejects.toThrow();
  await expect(store.readWebsiteInterview(scope)).rejects.toThrow();
});
test("trusted transcript rejects blank/oversized evidence before RPC", async () => {
  const { createOnboardingAgendaStore } = await import("../src/onboarding-agenda-store.ts");
  const store = createOnboardingAgendaStore({ rpc: async () => { throw new Error("must not reach RPC"); } });
  await expect(store.recordOwnerTranscript({ ...scope, providerItemId: "turn1", text: " " })).rejects.toThrow("transcript");
  await expect(store.recordOwnerTranscript({ ...scope, providerItemId: "turn1", text: "x".repeat(32769) })).rejects.toThrow("transcript");
});
