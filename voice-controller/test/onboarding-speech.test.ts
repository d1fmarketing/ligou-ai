import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as speech from "../src/onboarding-speech";
import { synthesizeOnboardingOpening } from "../src/onboarding-greeting";

const audio = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const action = {
  actionId: "1".repeat(64), interviewId: "11111111-1111-4111-8111-111111111111", callId: "22222222-2222-4222-8222-222222222222", revision: 0,
  kind: "ASK_NEXT_GAP" as const, text: "Quais cidades sua empresa atende?", sourceDigest: "a".repeat(64),
};
const response = () => new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": String(audio.length) } });
const deps = { openaiKey: "synthetic-only", timeoutMs: 30, fetchImpl: async () => response() };

describe("application-owned onboarding speech", () => {
  test('an attributed territory quotation is distinct from an agent offer; its next question stays guarded',async()=>{
    const text='Registrado. Você informou: “Atendemos só Recife e Olinda. Fora dessas cidades, é só me chamar para obter minha aprovação explícita”. Qual o horário de sábado?';
    const confirmation={...action,kind:'CONFIRM_AND_ASK_NEXT' as const,text};
    expect(speech.speechActionIsInternallyValid(confirmation)).toBe(true);
    expect((await speech.synthesizeOnboardingSpeech(confirmation,deps)).text).toBe(text);
    for(const changed of [
      {...confirmation,kind:'ASK_NEXT_GAP'},
      {...confirmation,text:text+' Posso te ajudar com o website?'},
      {...confirmation,text:text.replace('Você informou:','Você disse:')},
      {...confirmation,text:text.replace('”. Qual',' Qual')},
      {...confirmation,text:'É só me chamar. Qual o horário de sábado?'},
    ])expect(speech.speechActionIsInternallyValid(changed)).toBe(false);
  });
  test('source-bound recap can quote owner policy without treating that quote as an agent offer',async()=>{
    const summary={...action,kind:'GENERATE_FINAL_SUMMARY' as const,text:'Resposta literal do dono: “Se o cliente pedir desconto, é só me chamar para eu decidir.”'};
    const payload=await speech.synthesizeOnboardingSpeech(summary,deps);
    expect(speech.speechPayloadIsInternallyValid(payload,summary)).toBe(true);
    expect(speech.speechActionIsInternallyValid({...summary,kind:'ASK_NEXT_GAP'})).toBe(false);
  });
  test("sends exact persisted action text to the single bounded TTS endpoint and binds payload", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const payload = await speech.synthesizeOnboardingSpeech(action, { ...deps, fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init! }); return response();
    } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(requests[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ model: "tts-1-hd", voice: "ash", input: action.text, response_format: "mp3" });
    expect(payload).toEqual({ ...action, schema: "onboarding.speech.v1", text_sha256: hash(action.text),
      audio_base64: "SUQzBAAAAAAAAP/7kGQ=", audio_sha256: "b15db04aea85ebd3f59185796229df945e67f42931c7e9da411e97b83c856ce8",
      mime: "audio/mpeg", voice: "ash", tts_model: "tts-1-hd", cost_usd: 0.00099 });
    expect(speech.speechPayloadIsInternallyValid(payload, action)).toBe(true);
  });

  test("rejects unknown scope, malformed bindings, and overlong text before any request", async () => {
    let calls = 0;
    const invalid = [null, [], { ...action, kind: "generic_chat" }, { ...action, kind: "TERMINATE_SESSION" },
      { ...action, actionId: "" }, { ...action, callId: 1 }, { ...action, interviewId: "a\nb" },
      { ...action, actionId: "a".repeat(513) }, { ...action, sourceDigest: "g".repeat(64) },
      { ...action, revision: -1 }, { ...action, revision: 0.5 }, { ...action, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...action, text: "" }, { ...action, text: " " }, { ...action, text: "a".repeat(4097) },
      { ...action, tools: [] }, { ...action, text: "A\u0000B" }];
    for (const value of invalid) {
      await expect(speech.synthesizeOnboardingSpeech(value as any, { ...deps, fetchImpl: async () => { calls++; return response(); } })).rejects.toMatchObject({ usageResolved: true, costUsd: 0 });
    }
    expect(calls).toBe(0);
  });

  test("rejects generic follow-up offers but permits a scoped deferral and next question", async () => {
    let calls = 0;
    for (const text of ["Se quiser, posso te ajudar a criar um texto para seu site ou um script.", "Posso te ajudar com seu site?",
      "Tem mais alguma coisa?", "O que mais você gostaria de fazer?", "É só me chamar.", "É SÓ ME CHAMAR!"]) {
      await expect(speech.synthesizeOnboardingSpeech({ ...action, text }, { ...deps, fetchImpl: async () => { calls++; return response(); } })).rejects.toMatchObject({ usageResolved: true, costUsd: 0 });
    }
    expect(calls).toBe(0);
    const scoped = { ...action, kind: "DEFER_OFF_SCOPE_AND_CONTINUE" as const, text: "Vamos deixar esse assunto para depois do onboarding. Quais cidades sua empresa atende?" };
    expect((await speech.synthesizeOnboardingSpeech(scoped, deps)).text).toBe(scoped.text);
  });

  test("requires the exact final signoff with no question or offer", async () => {
    const signoff = { ...action, kind: "SPEAK_FINAL_SIGNOFF" as const, text: "Perfeito. Seu onboarding foi concluído e suas informações foram salvas. Até logo." };
    expect((await speech.synthesizeOnboardingSpeech(signoff, deps)).text).toBe(signoff.text);
    for (const text of [signoff.text + " Tudo certo?", signoff.text + " Posso ajudar?", "Até logo."]) {
      await expect(speech.synthesizeOnboardingSpeech({ ...signoff, text }, deps)).rejects.toMatchObject({ usageResolved: true, costUsd: 0 });
    }
  });

  test("rejects payload tampering and changed expected application bindings", async () => {
    const payload = await speech.synthesizeOnboardingSpeech(action, deps);
    for (const changed of [{ schema: "onboarding.speech.v2" }, { actionId: "action-2" }, { interviewId: "other" },
      { callId: "other" }, { revision: 1 }, { sourceDigest: "b".repeat(64) }, { kind: "CLARIFY_CURRENT_GAP" },
      { text: action.text + "?" }, { text_sha256: "b".repeat(64) }, { audio_sha256: "b".repeat(64) },
      { audio_base64: payload.audio_base64 + "=" }, { audio_base64: "" }, { audio_base64: "bm90LW1wMw==", audio_sha256: hash("not-mp3") },
      { mime: "audio/wav" }, { voice: "alloy" }, { tts_model: "tts-1" }, { cost_usd: 0 }, { cost_usd: NaN }, { extra: true }]) {
      expect(speech.speechPayloadIsInternallyValid({ ...payload, ...changed }, action)).toBe(false);
    }
    for (const changed of [{ actionId: "2".repeat(64) }, { interviewId: "33333333-3333-4333-8333-333333333333" }, { callId: "33333333-3333-4333-8333-333333333333" }, { revision: 1 },
      { sourceDigest: "b".repeat(64) }, { kind: "CLARIFY_CURRENT_GAP" }, { text: "Outra pergunta?" }]) {
      expect(speech.speechPayloadIsInternallyValid(payload, { ...action, ...changed } as any)).toBe(false);
    }
  });

  test("preserves definitive, accepted-invalid, and unknown usage outcomes without retry", async () => {
    const cases = [
      { fetchImpl: async () => new Response("no", { status: 400 }), want: { message: "onboarding_tts_rejected", usageResolved: true, costUsd: 0 } },
      { fetchImpl: async () => new Response("no", { status: 503 }), want: { message: "onboarding_tts_outcome_unknown", usageResolved: false, costUsd: null } },
      { fetchImpl: async () => { throw new Error("network"); }, want: { message: "onboarding_tts_outcome_unknown", usageResolved: false, costUsd: null } },
      { fetchImpl: async () => new Response("not-mp3", { headers: { "content-type": "audio/mpeg" } }), want: { message: "onboarding_tts_invalid_response", usageResolved: true, costUsd: 0.00099 } },
      { fetchImpl: async () => new Response(audio, { headers: { "content-type": "text/plain" } }), want: { message: "onboarding_tts_invalid_response", usageResolved: true, costUsd: 0.00099 } },
      { fetchImpl: async () => new Response(new Uint8Array(1_500_001), { headers: { "content-type": "audio/mpeg" } }), want: { message: "onboarding_tts_invalid_response", usageResolved: true, costUsd: 0.00099 } },
      { fetchImpl: async () => new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": "1500001" } }), want: { message: "onboarding_tts_invalid_response", usageResolved: true, costUsd: 0.00099 } },
    ];
    for (const entry of cases) {
      let calls = 0;
      await expect(speech.synthesizeOnboardingSpeech(action, { ...deps, fetchImpl: async () => { calls++; return entry.fetchImpl(); } })).rejects.toMatchObject(entry.want);
      expect(calls).toBe(1);
    }
  });

  test("pre-aborted requests and missing explicit keys make no provider request", async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    const fetchImpl = async () => { calls++; return response(); };
    await expect(speech.synthesizeOnboardingSpeech(action, { ...deps, fetchImpl, signal: controller.signal })).rejects.toMatchObject({ usageResolved: true, costUsd: 0 });
    await expect(speech.synthesizeOnboardingSpeech(action, { ...deps, fetchImpl, openaiKey: "" })).rejects.toMatchObject({ usageResolved: true, costUsd: 0 });
    expect(calls).toBe(0);
  });

  test("deadline and parent abort are bounded and preserve unknown usage before success", async () => {
    let calls = 0;
    const fetchImpl = async (_url: unknown, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    await expect(speech.synthesizeOnboardingSpeech(action, { ...deps, timeoutMs: 5, fetchImpl })).rejects.toMatchObject({ usageResolved: false, costUsd: null });
    const controller = new AbortController();
    const pending = speech.synthesizeOnboardingSpeech(action, { ...deps, fetchImpl, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ usageResolved: false, costUsd: null });
    expect(calls).toBe(2);
  });

  test("invalid timeout bounds reject before fetch with resolved zero cost", async () => {
    let calls = 0;
    for (const timeoutMs of [0, -1, 15_001, 0.5, NaN]) {
      await expect(speech.synthesizeOnboardingSpeech(action, { ...deps, timeoutMs, fetchImpl: async () => { calls++; return response(); } }))
        .rejects.toMatchObject({ message: "onboarding_tts_timeout_invalid", usageResolved: true, costUsd: 0 });
    }
    expect(calls).toBe(0);
  });

  test("legacy opening identity failure after accepted audio retains known incurred cost", async () => {
    await expect(synthesizeOnboardingOpening({ tenantName: "D1F Marketing", browserRequestId: "", callId: "call-legacy" }, deps))
      .rejects.toMatchObject({ message: "onboarding_tts_invalid_response", usageResolved: true, costUsd: 0.00321 });
  });

  test("accepted response body deadline retains known cost", async () => {
    await expect(speech.synthesizeOnboardingSpeech(action, { ...deps, timeoutMs: 5, fetchImpl: async (_url, init) =>
      new Response(new ReadableStream({ start(controller) {
        init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")));
      } }), { headers: { "content-type": "audio/mpeg" } }) }))
      .rejects.toMatchObject({ usageResolved: true, costUsd: 0.00099 });
  });

  test("4096 codepoints remain exact and Unicode cost remains codepoint based", async () => {
    const text = "😀".repeat(4096);
    const payload = await speech.synthesizeOnboardingSpeech({ ...action, text }, { ...deps, fetchImpl: async (_url, init) => {
      expect(JSON.parse(String(init!.body)).input).toBe(text); return response();
    } });
    expect(payload.cost_usd).toBe(0.12288);
    expect(payload.text).toBe(text);
  });

  test("mutable caller action cannot rebind audio after request", async () => {
    const mutable = { ...action };
    const payload = await speech.synthesizeOnboardingSpeech(mutable, { ...deps, fetchImpl: async () => {
      mutable.actionId = "b".repeat(64); mutable.text = "Texto diferente?"; return response();
    } });
    expect(payload.text).toBe(action.text);
    expect(payload.actionId).toBe(action.actionId);
    expect(speech.speechPayloadIsInternallyValid(payload, mutable)).toBe(false);
  });

  test("every finite speaking kind produces bound audio while termination is rejected", async () => {
    for (const kind of ["ASK_NEXT_GAP", "CLARIFY_CURRENT_GAP", "CONFIRM_AND_ASK_NEXT", "DEFER_OFF_SCOPE_AND_CONTINUE",
      "GENERATE_FINAL_SUMMARY", "REQUEST_FINAL_APPROVAL", "HANDLE_OWNER_CORRECTION", "SPEAK_TERMINAL_ERROR"] as const) {
      const expected = { ...action, kind };
      expect(speech.speechPayloadIsInternallyValid(await speech.synthesizeOnboardingSpeech(expected, deps), expected)).toBe(true);
    }
    expect(speech.speechActionIsInternallyValid({ ...action, kind: "TERMINATE_SESSION" })).toBe(false);
  });
});
