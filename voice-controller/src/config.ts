// Central config. Secrets come from the environment (~/.config/ligou/*.env sourced by run scripts) — never from the repo.
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

export function parseSessionCostCeilingUsd(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1.5;
  if (!/^(?:0[.]\d{1,4}|[1-4](?:[.]\d{1,4})?|5(?:[.]0{1,4})?)$/.test(raw)) {
    throw new Error("session_cost_ceiling_invalid");
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.01 || value > 5) throw new Error("session_cost_ceiling_invalid");
  return value;
}

export function parseRealtimeCreateTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 6_000;
  if (!/^[0-9]+$/.test(raw)) throw new Error("realtime_create_timeout_invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 10_000)
    throw new Error("realtime_create_timeout_invalid");
  return value;
}

export function parseSidebandOpenTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 5_000;
  if (!/^[0-9]+$/.test(raw)) throw new Error("sideband_open_timeout_invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 250 || value > 6_000)
    throw new Error("sideband_open_timeout_invalid");
  return value;
}

// Live finalization: finish delegated work, send session.close, wait for
// session.closed (live-conversations "Usage and graceful close"). Default 30 s:
// delegated farewell (Astra low ~4.8 s measured) + spoken farewell + provider
// finalization; the previous literal 8 s was observed insufficient while a
// delegated response was still in flight. Upper bound keeps Stop bounded.
export function parseLiveCloseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 30_000;
  if (!/^[0-9]+$/.test(raw)) throw new Error("live_close_timeout_invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 5_000 || value > 60_000)
    throw new Error("live_close_timeout_invalid");
  return value;
}

// Speech drain before session.close after an owner-requested stop: the
// provider has no output-audio-done event for WebRTC (live-conversations
// "Keep transcript timing separate from audio playback"), so the runtime waits
// until session.output_transcript.delta has been quiet for this long (default
// 2.5 s: covers playback latency; 0 disables) before sending session.close.
// The human test of 2026-09-12 (call d2732329) heard the last words cut when
// session.close followed the farewell response.completed in the same millisecond.
export function parseLiveCloseDrainMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 2_500;
  if (!/^[0-9]+$/.test(raw)) throw new Error("live_close_drain_invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 10_000) throw new Error("live_close_drain_invalid");
  return value;
}

export const ONBOARDING_BUDGET_SOFT_LIMIT_USD = 6.5;
export const ONBOARDING_BUDGET_RESERVATION_USD = 7.5;

export interface SessionBudgetEnvelope {
  softLimitUsd: number;
  hardLimitUsd: number;
  reservationUsd: number;
}

export const config = {
  port: Number(process.env.PORT ?? 8790),
  supabaseUrl: need("SUPABASE_URL"),
  supabaseSecretKey: need("SUPABASE_SECRET_KEY"),
  supabasePublishableKey: need("SUPABASE_PUBLISHABLE_KEY"),
  // Realtime voice/TTS only. Text reasoning and summaries use Codex subscription OAuth.
  openaiKey: process.env.OPENAI_API_KEY ?? "", // empty => live voice sessions disabled
  model: process.env.LIGOU_MODEL ?? "gpt-realtime-2.1",
  fallbackModel: process.env.LIGOU_FALLBACK_MODEL ?? "gpt-realtime-2.1-mini",
  sessionMaxMinutes: Number(process.env.SESSION_MAX_MINUTES ?? 15),
  sessionCostCeilingUsd: parseSessionCostCeilingUsd(process.env.SESSION_COST_CEILING_USD),
  realtimeCreateTimeoutMs: parseRealtimeCreateTimeoutMs(
    process.env.REALTIME_CREATE_TIMEOUT_MS,
  ),
  sidebandOpenTimeoutMs: parseSidebandOpenTimeoutMs(
    process.env.SIDEBAND_OPEN_TIMEOUT_MS,
  ),
  liveCloseTimeoutMs: parseLiveCloseTimeoutMs(process.env.LIVE_CLOSE_TIMEOUT_MS),
  liveCloseDrainQuietMs: parseLiveCloseDrainMs(process.env.LIVE_CLOSE_DRAIN_QUIET_MS),
  hermesKey: process.env.HERMES_API_KEY ?? "",
  defaultTenantSlug: process.env.LIGOU_TENANT ?? "rocha-plumbing",
  // Male brand voice: RJ listened to cedar/ash/echo/verse/ballad on a real Ligou script and picked ASH.
  voice: process.env.LIGOU_VOICE ?? "ash",
};

export function sessionBudgetEnvelope(
  sessionType: "customer" | "owner_browser" | "onboarding",
): SessionBudgetEnvelope {
  if (sessionType === "onboarding")
    return {
      softLimitUsd: ONBOARDING_BUDGET_SOFT_LIMIT_USD,
      hardLimitUsd: ONBOARDING_BUDGET_RESERVATION_USD,
      reservationUsd: ONBOARDING_BUDGET_RESERVATION_USD,
    };
  return {
    softLimitUsd: config.sessionCostCeilingUsd,
    hardLimitUsd: config.sessionCostCeilingUsd,
    reservationUsd: config.sessionCostCeilingUsd,
  };
}

// $ per 1M tokens — official pricing 2026-08 (developers.openai.com/api/docs/pricing)
export const PRICING: Record<string, { audioIn: number; audioInCached: number; audioOut: number; textIn: number; textInCached: number; textOut: number }> = {
  "gpt-realtime": { audioIn: 32, audioInCached: 0.4, audioOut: 64, textIn: 4, textInCached: 0.4, textOut: 16 },
  "gpt-realtime-2.1": { audioIn: 32, audioInCached: 0.4, audioOut: 64, textIn: 4, textInCached: 0.4, textOut: 24 },
  "gpt-realtime-2.1-mini": { audioIn: 10, audioInCached: 0.3, audioOut: 20, textIn: 0.6, textInCached: 0.06, textOut: 2.4 },
};

export function sessionCostUsd(model: string, usage: UsageTotals): number {
  const p = PRICING[model] ?? PRICING["gpt-realtime-2.1-mini"];
  return (
    (usage.audioIn - usage.audioInCached) * p.audioIn / 1e6 +
    usage.audioInCached * p.audioInCached / 1e6 +
    usage.audioOut * p.audioOut / 1e6 +
    (usage.textIn - usage.textInCached) * p.textIn / 1e6 +
    usage.textInCached * p.textInCached / 1e6 +
    usage.textOut * p.textOut / 1e6
  );
}

export interface UsageTotals {
  audioIn: number; audioInCached: number; audioOut: number;
  textIn: number; textInCached: number; textOut: number;
}
export const emptyUsage = (): UsageTotals => ({ audioIn: 0, audioInCached: 0, audioOut: 0, textIn: 0, textInCached: 0, textOut: 0 });
