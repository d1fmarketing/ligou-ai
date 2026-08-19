// Central config. Secrets come from the environment (~/.config/ligou/*.env sourced by run scripts) — never from the repo.
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

export const config = {
  port: Number(process.env.PORT ?? 8790),
  supabaseUrl: need("SUPABASE_URL"),
  supabaseSecretKey: need("SUPABASE_SECRET_KEY"),
  supabasePublishableKey: need("SUPABASE_PUBLISHABLE_KEY"),
  openaiKey: process.env.OPENAI_API_KEY ?? "", // empty => live sessions disabled, tools/tests still run
  model: process.env.LIGOU_MODEL ?? "gpt-realtime-2.1",
  fallbackModel: process.env.LIGOU_FALLBACK_MODEL ?? "gpt-realtime-2.1-mini",
  sessionMaxMinutes: Number(process.env.SESSION_MAX_MINUTES ?? 15),
  estCostPerSessionUsd: Number(process.env.EST_COST_PER_SESSION ?? 1.0),
  hermesUrl: process.env.HERMES_URL ?? "http://127.0.0.1:8642",
  hermesKey: process.env.HERMES_API_KEY ?? "",
  defaultTenantSlug: process.env.LIGOU_TENANT ?? "rocha-plumbing",
};

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
