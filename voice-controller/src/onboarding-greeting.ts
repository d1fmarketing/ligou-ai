import { createHash } from "node:crypto";

export type OnboardingOpeningMode =
  | "provider_model_v1"
  | "application_tts_v1";

interface OnboardingOpeningPayloadBase {
  item_id: string;
  text: string;
  text_sha256: string;
  audio_base64: string;
  audio_sha256: string;
  mime: "audio/mpeg";
  voice: "ash";
  cost_usd: number;
}

export interface OnboardingOpeningNextAction {
  type: "ask";
  field: string;
  subject?: string;
  question_pt: string;
}

export interface OnboardingOpeningResumeContext {
  coverage_receipt_id: string;
  revision: 1;
  snapshot_digest: string;
  next_action: OnboardingOpeningNextAction;
}

export interface OnboardingOpeningPayloadV1
  extends OnboardingOpeningPayloadBase {
  version: 1;
  tts_model: "tts-1";
}

export interface OnboardingOpeningPayloadV2
  extends OnboardingOpeningPayloadBase {
  version: 2;
  tts_model: "tts-1-hd";
  resume_context: OnboardingOpeningResumeContext | null;
}

export type OnboardingOpeningPayload =
  | OnboardingOpeningPayloadV1
  | OnboardingOpeningPayloadV2;

export interface OnboardingOpeningFailure extends Error {
  usageResolved: boolean;
  costUsd: number | null;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const TTS_MODEL = "tts-1-hd" as const;
const LEGACY_TTS_MODEL = "tts-1" as const;
const TTS_VOICE = "ash" as const;
const TTS_MIME = "audio/mpeg" as const;
const TTS_COST_PER_MILLION_CHARACTERS_USD = 30;
const LEGACY_TTS_COST_PER_MILLION_CHARACTERS_USD = 15;
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

function exactObjectKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]));
  return value;
}

export function openingResumeContextIsInternallyValid(
  value: unknown,
): value is OnboardingOpeningResumeContext {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const context = value as Record<string, unknown>;
  if (!exactObjectKeys(context, [
    "coverage_receipt_id",
    "revision",
    "snapshot_digest",
    "next_action",
  ]) ||
    typeof context.coverage_receipt_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      context.coverage_receipt_id,
    ) ||
    context.revision !== 1 ||
    typeof context.snapshot_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(context.snapshot_digest) ||
    !context.next_action || typeof context.next_action !== "object" ||
    Array.isArray(context.next_action)) return false;
  const action = context.next_action as Record<string, unknown>;
  const actionKeys = ["type", "field", "question_pt"];
  if (action.subject !== undefined) actionKeys.push("subject");
  return exactObjectKeys(action, actionKeys) &&
    action.type === "ask" &&
    typeof action.field === "string" && Boolean(action.field.trim()) &&
    typeof action.question_pt === "string" &&
    Boolean(action.question_pt.trim()) &&
    (action.subject === undefined ||
      (typeof action.subject === "string" && Boolean(action.subject.trim())));
}

export function onboardingOpeningText(
  tenantName: string,
  resumeContext: OnboardingOpeningResumeContext | null = null,
): string {
  if (typeof tenantName !== "string" || !tenantName.trim())
    throw new Error("onboarding_opening_tenant_name_required");
  const identity =
    `Oi! Aqui é o Ligou, agente de inteligência artificial da ${tenantName}.`;
  if (resumeContext === null)
    return `${identity} Quais serviços sua empresa oferece?`;
  if (!openingResumeContextIsInternallyValid(resumeContext))
    throw new Error("onboarding_opening_resume_context_invalid");
  return `${identity} Vamos continuar de onde paramos. ${resumeContext.next_action.question_pt}`;
}

export function onboardingTtsCostUsd(text: string): number {
  const characters = [...text].length;
  return Number((
    characters * TTS_COST_PER_MILLION_CHARACTERS_USD / 1_000_000
  ).toFixed(8));
}

function legacyOnboardingTtsCostUsd(text: string): number {
  const characters = [...text].length;
  return Number((
    characters * LEGACY_TTS_COST_PER_MILLION_CHARACTERS_USD / 1_000_000
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
    resumeContext?: OnboardingOpeningResumeContext | null;
  },
  dependencies: {
    openaiKey: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<OnboardingOpeningPayloadV2> {
  const resumeContext = args.resumeContext ?? null;
  const text = onboardingOpeningText(args.tenantName, resumeContext);
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
      version: 2,
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
      resume_context: resumeContext === null
        ? null
        : structuredClone(resumeContext),
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
  expectedResumeContext?: OnboardingOpeningResumeContext | null,
): payload is OnboardingOpeningPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return false;
  const value = payload as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const baseKeys = [
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
  ];
  const version = value.version;
  const expectedKeys = version === 2
    ? [...baseKeys, "resume_context"].sort()
    : baseKeys.sort();
  const currentV2 = version === 2;
  const legacyV1 = version === 1;
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    (!currentV2 && !legacyV1) || value.text !== expectedText ||
    value.mime !== TTS_MIME || value.voice !== TTS_VOICE ||
    (currentV2 ? value.tts_model !== TTS_MODEL :
      value.tts_model !== LEGACY_TTS_MODEL) ||
    (legacyV1 && expectedResumeContext !== undefined &&
      expectedResumeContext !== null) ||
    (currentV2 && !(
      (value.resume_context === null && expectedResumeContext === null) ||
      (
        openingResumeContextIsInternallyValid(value.resume_context) &&
        openingResumeContextIsInternallyValid(expectedResumeContext) &&
        JSON.stringify(canonicalValue(value.resume_context)) ===
          JSON.stringify(canonicalValue(expectedResumeContext))
      )
    )) ||
    typeof value.item_id !== "string" ||
    !/^lgo-[0-9a-f]{28}$/.test(value.item_id) ||
    typeof value.text_sha256 !== "string" ||
    value.text_sha256 !== sha256(expectedText) ||
    typeof value.audio_base64 !== "string" ||
    typeof value.audio_sha256 !== "string" ||
    typeof value.cost_usd !== "number" ||
    value.cost_usd !== (currentV2
      ? onboardingTtsCostUsd(expectedText)
      : legacyOnboardingTtsCostUsd(expectedText))) return false;
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
