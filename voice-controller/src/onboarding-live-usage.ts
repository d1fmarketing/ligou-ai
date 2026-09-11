/** Public Standard API price card, checked 2026-09-11 UTC.
 * https://developers.openai.com/api/docs/pricing
 * https://developers.openai.com/api/docs/models/gpt-5.6-terra
 * https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance
 * https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live
 * Rate-based estimates from reported usage; never provider invoice amounts.
 * This module has no configuration, credentials, transport or budget enforcement.
 */
export const LIVE_VOICE_USD_PER_MINUTE = 0.05;
export const LIVE_WEBRTC_INITIALIZATION_SECONDS = 15;
export const MANAGED_PRICE_SOURCE = 'https://developers.openai.com/api/docs/pricing';

export type ManagedTextRates = Readonly<{
  model: string; context: 'short' | 'long'; serviceTier: 'default';
  inputUsdPerMillion: number; cachedInputUsdPerMillion: number;
  cacheWriteUsdPerMillion: number; outputUsdPerMillion: number;
}>;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const money = (value: number) => Math.round(value * 1e8) / 1e8;

/** inputTokens is the input of ONE model request, not an aggregate Agents turn. */
export function managedTextRates(model: string | null | undefined, inputTokens: number, serviceTier = 'default'): ManagedTextRates | null {
  if (model !== 'gpt-5.6-terra' || !integer(inputTokens) || serviceTier !== 'default') return null;
  const long = inputTokens > 272_000;
  return Object.freeze({ model, context: long ? 'long' : 'short', serviceTier: 'default',
    inputUsdPerMillion: long ? 4 : 2, cachedInputUsdPerMillion: long ? 0.4 : 0.2,
    cacheWriteUsdPerMillion: long ? 5 : 2.5, outputUsdPerMillion: long ? 18 : 12 });
}

export type ManagedTextUsage = Readonly<{
  inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number;
  ordinaryInputTokens: number; outputTokens: number; totalTokens: number;
}>;
export type ManagedTextCost = Readonly<{
  costUsd: number | null; usage: ManagedTextUsage | null; rates: ManagedTextRates | null;
  reason: 'priced' | 'usage_missing' | 'usage_invalid' | 'cache_breakdown_missing' | 'rates_unknown';
  basis: 'reported_tokens_at_public_rates';
}>;

/** Also usable by Agents when per-model-request usage is available. Aggregate
 * session/turn usage must not be treated as one request for long-context pricing.
 * Omitted cached/write fields remain unknown, never silently priced as zero.
 */
export function managedTextUsageCost(model: string | null | undefined, usage: unknown, serviceTier = 'default'): ManagedTextCost {
  const result = (reason: ManagedTextCost['reason'], normalized: ManagedTextUsage | null = null, rates: ManagedTextRates | null = null, costUsd: number | null = null): ManagedTextCost =>
    Object.freeze({ costUsd, usage: normalized, rates, reason, basis: 'reported_tokens_at_public_rates' });
  if (!object(usage)) return result('usage_missing');
  const input = usage.input_tokens, output = usage.output_tokens, total = usage.total_tokens;
  if (!integer(input) || !integer(output) || !integer(total) || input + output !== total) return result('usage_invalid');
  const details = usage.input_tokens_details;
  if (!object(details) || details.cached_tokens === undefined || details.cache_write_tokens === undefined) return result('cache_breakdown_missing');
  const cached = details.cached_tokens, writes = details.cache_write_tokens;
  if (!integer(cached) || !integer(writes) || cached + writes > input) return result('usage_invalid');
  const normalized = Object.freeze({ inputTokens: input, cachedInputTokens: cached, cacheWriteTokens: writes,
    ordinaryInputTokens: input - cached - writes, outputTokens: output, totalTokens: total });
  const rates = managedTextRates(model, input, serviceTier);
  if (!rates) return result('rates_unknown', normalized);
  const cost = ((input - cached - writes) * rates.inputUsdPerMillion + cached * rates.cachedInputUsdPerMillion
    + writes * rates.cacheWriteUsdPerMillion + output * rates.outputUsdPerMillion) / 1_000_000;
  return result('priced', normalized, rates, money(cost));
}

export type LiveResponseUsageObservation = {
  responseId: string; model: string | null; status: string; usage?: unknown;
  serviceTier?: string;
};
type ResponseEntry = {
  responseId: string; model: string | null; status: string; terminal: boolean;
  cost: ManagedTextCost; conflict: boolean;
};
const terminal = (status: string) => ['completed', 'failed', 'incomplete', 'cancelled'].includes(status);

export function createLiveUsageLedger(options: { created: boolean; backendModel: string; serviceTier?: string }) {
  let created = options.created, seconds = 0, finalSeconds: number | null = null, invalidObservations = 0;
  const responses = new Map<string, ResponseEntry>();
  return {
    markCreated() { created = true; },
    observeVoice(value: unknown, final = false) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        invalidObservations++;
        if (final) finalSeconds = null;
        return;
      }
      if (final) finalSeconds = value >= seconds ? value : null;
      else if (finalSeconds !== null && value > finalSeconds) finalSeconds = null;
      seconds = Math.max(seconds, value);
    },
    /** Register response.created as in_progress with usage:null as well as terminal
     * events; otherwise a missing terminal usage event would be invisible. */
    observeResponse(value: LiveResponseUsageObservation) {
      if (typeof value.responseId !== 'string' || !value.responseId.trim() || value.responseId.length > 200) {
        invalidObservations++; return;
      }
      const prior = responses.get(value.responseId);
      const isTerminal = terminal(value.status);
      const cost = managedTextUsageCost(value.model, value.usage, value.serviceTier ?? options.serviceTier ?? 'default');
      if (prior?.terminal && !isTerminal) return; // Late response.created cannot erase its final usage.
      let conflict = prior?.conflict ?? false;
      if (prior?.terminal && isTerminal) {
        if (prior.model !== null && value.model !== null && prior.model !== value.model) conflict = true;
        if (prior.status !== value.status) conflict = true;
        if (prior.cost.costUsd !== null && cost.costUsd !== null && JSON.stringify(prior.cost) !== JSON.stringify(cost)) conflict = true;
        // A duplicate missing usage body is not evidence that valid usage vanished.
        if (prior.cost.costUsd !== null && cost.costUsd === null) {
          responses.set(value.responseId, { ...prior, conflict }); return;
        }
      }
      responses.set(value.responseId, { responseId: value.responseId, model: value.model, status: value.status, terminal: isTerminal, cost, conflict });
    },
    snapshot() {
      const billableVoiceSeconds = Math.max(seconds, created ? LIVE_WEBRTC_INITIALIZATION_SECONDS : 0);
      const voiceCostUsd = money(billableVoiceSeconds * LIVE_VOICE_USD_PER_MINUTE / 60);
      const entries = [...responses.values()];
      // Unknown entries contribute no invented charge; the priced subtotal remains observable.
      const backendObservedCostUsd = money(entries.reduce((sum, entry) => sum + (entry.terminal ? entry.cost.costUsd ?? 0 : 0), 0));
      const unknownResponseIds = entries.filter(entry => !entry.terminal || entry.cost.costUsd === null || entry.conflict).map(entry => entry.responseId);
      const backendUsageResolved = unknownResponseIds.length === 0;
      const voiceUsageResolved = finalSeconds !== null && finalSeconds === seconds;
      return Object.freeze({
        basis: 'reported_usage_at_public_rates' as const, invoiced: false as const,
        requestedBackendModel: options.backendModel, created, voiceSeconds: seconds, billableVoiceSeconds,
        voiceCostUsd, backendObservedCostUsd, backendCostUsd: backendUsageResolved ? backendObservedCostUsd : null,
        totalObservedCostUsd: money(voiceCostUsd + backendObservedCostUsd),
        usageResolved: voiceUsageResolved && backendUsageResolved && invalidObservations === 0,
        voiceUsageResolved, backendUsageResolved, unknownResponseIds: Object.freeze(unknownResponseIds), invalidObservations,
        responses: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))),
      });
    },
  };
}
