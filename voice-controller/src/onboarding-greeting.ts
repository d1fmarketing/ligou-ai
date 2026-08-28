import { createHash } from "node:crypto";

export type OnboardingOpeningMode =
  | "provider_model_v1"
  | "application_tts_v1";

export interface OnboardingOpeningPayload {
  version: 1;
  item_id: string;
  text: string;
  text_sha256: string;
  audio_base64: string;
  audio_sha256: string;
  mime: "audio/mpeg";
  voice: "ash";
  tts_model: "tts-1";
  cost_usd: number;
}

export interface OnboardingOpeningFailure extends Error {
  usageResolved: boolean;
  costUsd: number | null;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const TTS_MODEL = "tts-1" as const;
const TTS_VOICE = "ash" as const;
const TTS_MIME = "audio/mpeg" as const;
const TTS_COST_PER_MILLION_CHARACTERS_USD = 15;
const DEFAULT_TTS_TIMEOUT_MS = 8_000;
const MAX_TTS_TIMEOUT_MS = 15_000;
// The DB/Edge contract bounds base64 at 2,000,000 characters. A decoded body
// must fit below its exact 3/4 expansion ceiling before we ever construct it.
const MAX_OPENING_AUDIO_BYTES = 1_500_000;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function openingFailure(
  message: string,
  usageResolved: boolean,
  costUsd: number | null,
): OnboardingOpeningFailure {
  return Object.assign(new Error(message), { usageResolved, costUsd });
}

export function isOnboardingOpeningMode(
  value: unknown,
): value is OnboardingOpeningMode {
  return value === "provider_model_v1" || value === "application_tts_v1";
}

export function onboardingOpeningText(tenantName: string): string {
  if (typeof tenantName !== "string" || !tenantName.trim())
    throw new Error("onboarding_opening_tenant_name_required");
  return `Oi! Aqui é o Ligou, agente de inteligência artificial da ${tenantName}. Quais serviços sua empresa oferece?`;
}

export function onboardingTtsCostUsd(text: string): number {
  const characters = [...text].length;
  return Number((
    characters * TTS_COST_PER_MILLION_CHARACTERS_USD / 1_000_000
  ).toFixed(8));
}

export function onboardingOpeningItemId(args: {
  browserRequestId: string;
  callId: string;
  textSha256: string;
  audioSha256: string;
}): string {
  if (!args.browserRequestId.trim() || !args.callId.trim())
    throw new Error("onboarding_opening_identity_required");
  const digest = sha256(JSON.stringify({
    request_id: args.browserRequestId,
    call_id: args.callId,
    text_sha256: args.textSha256,
    audio_sha256: args.audioSha256,
  }));
  return `lgo-${digest.slice(0, 28)}`;
}

async function readBoundedAudio(response: Response): Promise<Uint8Array> {
  const declaredRaw = response.headers.get("content-length");
  let declared: number | null = null;
  if (declaredRaw !== null) {
    if (!/^[0-9]+$/.test(declaredRaw))
      throw new Error("content_length_invalid");
    declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared < 1 ||
      declared > MAX_OPENING_AUDIO_BYTES)
      throw new Error("content_length_out_of_bounds");
  }
  if (!response.body) throw new Error("body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_OPENING_AUDIO_BYTES)
        throw new Error("body_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1 || (declared !== null && declared !== total))
    throw new Error("body_size_invalid");
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}

export async function synthesizeOnboardingOpening(
  args: {
    tenantName: string;
    browserRequestId: string;
    callId: string;
  },
  dependencies: {
    openaiKey: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<OnboardingOpeningPayload> {
  const text = onboardingOpeningText(args.tenantName);
  const costUsd = onboardingTtsCostUsd(text);
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
    timeoutMs > MAX_TTS_TIMEOUT_MS)
    throw new Error("onboarding_tts_timeout_invalid");
  if (!dependencies.openaiKey)
    throw openingFailure("onboarding_tts_rejected", true, 0);

  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (dependencies.signal?.aborted) controller.abort();
  else dependencies.signal?.addEventListener("abort", abortFromParent, {
    once: true,
  });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let successAccepted = false;
  try {
    const response = await (dependencies.fetchImpl ?? fetch)(
      "https://api.openai.com/v1/audio/speech",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${dependencies.openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: TTS_MODEL,
          voice: TTS_VOICE,
          input: text,
          response_format: "mp3",
        }),
        signal: controller.signal,
      },
    );
    if (response.status !== 200) {
      if (response.status >= 400 && response.status < 500)
        throw openingFailure("onboarding_tts_rejected", true, 0);
      throw openingFailure("onboarding_tts_outcome_unknown", false, null);
    }
    successAccepted = true;
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (contentType !== TTS_MIME)
      throw openingFailure("onboarding_tts_invalid_response", true, costUsd);

    const audio = await readBoundedAudio(response);
    const textSha256 = sha256(text);
    const audioSha256 = sha256(audio);
    return {
      version: 1,
      item_id: onboardingOpeningItemId({
        browserRequestId: args.browserRequestId,
        callId: args.callId,
        textSha256,
        audioSha256,
      }),
      text,
      text_sha256: textSha256,
      audio_base64: Buffer.from(audio).toString("base64"),
      audio_sha256: audioSha256,
      mime: TTS_MIME,
      voice: TTS_VOICE,
      tts_model: TTS_MODEL,
      cost_usd: costUsd,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      typeof (error as Partial<OnboardingOpeningFailure>).usageResolved ===
        "boolean"
    ) throw error;
    if (successAccepted)
      throw openingFailure("onboarding_tts_invalid_response", true, costUsd);
    throw openingFailure("onboarding_tts_outcome_unknown", false, null);
  } finally {
    clearTimeout(timeout);
    dependencies.signal?.removeEventListener("abort", abortFromParent);
  }
}

export function openingPayloadIsInternallyValid(
  payload: unknown,
  expectedText: string,
): payload is OnboardingOpeningPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return false;
  const value = payload as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "audio_base64",
    "audio_sha256",
    "cost_usd",
    "item_id",
    "mime",
    "text",
    "text_sha256",
    "tts_model",
    "version",
    "voice",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    value.version !== 1 || value.text !== expectedText ||
    value.mime !== TTS_MIME || value.voice !== TTS_VOICE ||
    value.tts_model !== TTS_MODEL ||
    typeof value.item_id !== "string" ||
    !/^lgo-[0-9a-f]{28}$/.test(value.item_id) ||
    typeof value.text_sha256 !== "string" ||
    value.text_sha256 !== sha256(expectedText) ||
    typeof value.audio_base64 !== "string" ||
    typeof value.audio_sha256 !== "string" ||
    typeof value.cost_usd !== "number" ||
    value.cost_usd !== onboardingTtsCostUsd(expectedText)) return false;
  let audio: Buffer;
  try {
    audio = Buffer.from(value.audio_base64, "base64");
  } catch {
    return false;
  }
  return audio.byteLength > 0 && audio.byteLength <= MAX_OPENING_AUDIO_BYTES &&
    audio.toString("base64") === value.audio_base64 &&
    sha256(audio) === value.audio_sha256;
}
