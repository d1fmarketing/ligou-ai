import { createHash } from "node:crypto";
import {
  onboardingTtsCostUsd,
  isOnboardingTtsModel,
  synthesizeExactOnboardingText,
  type ExactOnboardingAudio,
  type OnboardingOpeningFailure,
  type OnboardingTtsDependencies,
} from "./onboarding-greeting.ts";

export const ONBOARDING_SPEECH_SCHEMA = "onboarding.speech.v1" as const;
export const ONBOARDING_FINAL_SIGNOFF_TEXT =
  "Perfeito. Seu onboarding foi concluído e suas informações foram salvas. Até logo.";
export const ONBOARDING_AMENDMENT_SIGNOFF_TEXT =
  "Registrei seu pedido de correção. A versão aprovada continua guardada. Para revisar a alteração, inicie uma nova conversa pelo painel. Obrigado e até logo.";

const SPEECH_KINDS = [
  "ASK_NEXT_GAP", "CLARIFY_CURRENT_GAP", "CONFIRM_AND_ASK_NEXT",
  "DEFER_OFF_SCOPE_AND_CONTINUE", "GENERATE_FINAL_SUMMARY",
  "REQUEST_FINAL_APPROVAL", "HANDLE_OWNER_CORRECTION", "SPEAK_FINAL_SIGNOFF",
  "SPEAK_TERMINAL_ERROR", "SPEAK_AMENDMENT_SIGNOFF",
] as const;
export type OnboardingSpeechKind = typeof SPEECH_KINDS[number];
export interface OnboardingSpeechAction {
  readonly actionId: string;
  readonly interviewId: string;
  readonly callId: string;
  readonly revision: number;
  readonly kind: OnboardingSpeechKind;
  readonly text: string;
  readonly sourceDigest: string;
}
export interface OnboardingSpeechPayload extends OnboardingSpeechAction, Omit<ExactOnboardingAudio, "text"> {
  readonly schema: typeof ONBOARDING_SPEECH_SCHEMA;
}
export type OnboardingSpeechFailure = OnboardingOpeningFailure;

const ACTION_KEYS = ["actionId", "interviewId", "callId", "revision", "kind", "text", "sourceDigest"] as const;
const PAYLOAD_KEYS = [...ACTION_KEYS, "schema", "text_sha256", "audio_base64", "audio_sha256", "mime", "voice", "tts_model", "cost_usd"];
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AUDIO_BYTES = 1_500_000;
const MAX_AUDIO_BASE64 = 2_000_000;
const MAX_TEXT_CHARACTERS = 4096;

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function failure(message: string, usageResolved = true, costUsd: number | null = 0): OnboardingSpeechFailure {
  return Object.assign(new Error(message), { usageResolved, costUsd });
}

/** Defense in depth, not scope authority: only the caller's persisted action
 * establishes what may be spoken. No model-proposed text belongs here. */
function offersOpenEndedHelp(text: string, kind: string): boolean {
  // Only this application-produced attribution is exempt. Its complete text
  // must still equal persisted next_action.spokenPt in the SQL speech claim.
  const agentWords = kind === 'CONFIRM_AND_ASK_NEXT'
    ? text.replace(/^Registrado\. Você informou: “[^“”"<>\x00-\x1f\x7f]{1,480}”\. /u, 'Registrado. ')
    : text;
  const normalized = agentWords.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ");
  return /\bposso (?:te )?ajudar\b|\btem mais alguma coisa\b|\bo que mais voce gostaria\b|\be so me chamar\b/.test(normalized);
}

export function speechActionIsInternallyValid(value: unknown): value is OnboardingSpeechAction {
  if (!exactObject(value, ACTION_KEYS)) return false;
  return typeof value.actionId === "string" && SHA256.test(value.actionId) &&
    typeof value.interviewId === "string" && UUID.test(value.interviewId) &&
    typeof value.callId === "string" && UUID.test(value.callId) &&
    typeof value.sourceDigest === "string" && SHA256.test(value.sourceDigest) &&
    typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    typeof value.kind === "string" && (SPEECH_KINDS as readonly string[]).includes(value.kind) &&
    typeof value.text === "string" && Boolean(value.text.trim()) &&
    [...value.text].length <= MAX_TEXT_CHARACTERS &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text) &&
    // Recap text is separately bound to a persisted summary by the SQL claim;
    // its literal owner quotations must not be reclassified as agent offers.
    (value.kind === "GENERATE_FINAL_SUMMARY" || !offersOpenEndedHelp(value.text,value.kind)) &&
    (value.kind !== "SPEAK_FINAL_SIGNOFF" || value.text === ONBOARDING_FINAL_SIGNOFF_TEXT);
}

// A format sanity check, not a claim that audio acoustically equals its text.
function hasMp3Header(audio: Uint8Array): boolean {
  return audio.length >= 4 && ((audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) ||
    (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0 && (audio[1]! & 0x06) !== 0 &&
      (audio[2]! & 0xf0) !== 0xf0 && (audio[2]! & 0x0c) !== 0x0c));
}

export async function synthesizeOnboardingSpeech(
  action: OnboardingSpeechAction,
  dependencies: OnboardingTtsDependencies,
): Promise<OnboardingSpeechPayload> {
  if (!speechActionIsInternallyValid(action)) throw failure("onboarding_speech_action_invalid");
  if (dependencies.signal?.aborted) throw failure("onboarding_speech_aborted");
  if (dependencies.timeoutMs !== undefined && (!Number.isSafeInteger(dependencies.timeoutMs) ||
    dependencies.timeoutMs < 1 || dependencies.timeoutMs > 15_000))
    throw failure("onboarding_tts_timeout_invalid");
  // Snapshot before awaiting so a changed caller object cannot rebind audio.
  const persistedAction = Object.freeze({ ...action });
  const audio = await synthesizeExactOnboardingText(persistedAction.text, dependencies);
  const payload = { schema: ONBOARDING_SPEECH_SCHEMA, ...persistedAction, ...audio };
  if (!speechPayloadIsInternallyValid(payload, persistedAction))
    throw failure("onboarding_tts_invalid_response", true, audio.cost_usd);
  return payload;
}

export function speechPayloadIsInternallyValid(
  payload: unknown,
  expectedAction: OnboardingSpeechAction,
): payload is OnboardingSpeechPayload {
  if (!speechActionIsInternallyValid(expectedAction) || !exactObject(payload, PAYLOAD_KEYS)) return false;
  if (ACTION_KEYS.some(key => payload[key] !== expectedAction[key]) ||
    payload.schema !== ONBOARDING_SPEECH_SCHEMA || payload.mime !== "audio/mpeg" ||
    payload.voice !== "ash" || !isOnboardingTtsModel(payload.tts_model) ||
    payload.text_sha256 !== hash(expectedAction.text) ||
    typeof payload.audio_sha256 !== "string" || !SHA256.test(payload.audio_sha256) ||
    typeof payload.audio_base64 !== "string" || payload.audio_base64.length > MAX_AUDIO_BASE64 ||
    payload.cost_usd !== onboardingTtsCostUsd(expectedAction.text, payload.tts_model)) return false;
  const audio = Buffer.from(payload.audio_base64, "base64");
  return audio.byteLength > 0 && audio.byteLength <= MAX_AUDIO_BYTES &&
    audio.toString("base64") === payload.audio_base64 &&
    hash(audio) === payload.audio_sha256 && hasMp3Header(audio);
}
