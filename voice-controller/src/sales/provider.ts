import { config, type UsageTotals } from '../config.ts';
import { salesInstructions, salesTools } from './prompt.ts';

export const SALES_MODELS = ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini'] as const;
export function salesSessionConfig(model: string) {
  if (!(SALES_MODELS as readonly string[]).includes(model)) throw new Error('sales_model_forbidden');
  return { type: 'realtime', model, instructions: salesInstructions, tools: salesTools, tool_choice: 'auto', output_modalities: ['audio'], max_output_tokens: 1024,
    audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'pt' }, turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: true } }, output: { voice: 'ash' } } };
}
export type CreateOutcome = { outcome: 'accepted'; callId: string; answer: string; model: string } | { outcome: 'unknown' | 'rejected'; callId: string | null; error: string; model: string };
export async function createSalesCall(sdp: string, requestId: string, fetchImpl: typeof fetch = fetch, hooks?: { beforeAttempt(model: string): Promise<void>; rejected(): Promise<void> }): Promise<CreateOutcome> {
  for (const model of SALES_MODELS) {
    // Write intent outside catch: a failed DB intent must never be classified as a provider attempt.
    await hooks?.beforeAttempt(model);
    let callId: string | null = null;
    try {
      const form = new FormData(); form.set('sdp', sdp); form.set('session', JSON.stringify(salesSessionConfig(model)));
      const response = await fetchImpl('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: { Authorization: `Bearer ${config.openaiKey}`, 'X-Client-Request-Id': `${requestId}-${model}` }, body: form, signal: AbortSignal.timeout(config.realtimeCreateTimeoutMs) });
      const location = response.headers.get('Location');
      if (location) {
        const url = new URL(location, 'https://api.openai.com');
        const match = url.pathname.match(/^\/v1\/realtime\/calls\/([a-zA-Z0-9_-]+)$/);
        if (url.origin === 'https://api.openai.com' && match) callId = match[1];
      }
      if (!response.ok) {
        // Same explicit-nonacceptance boundary as the existing controller. Never retry 5xx/timeout/accepted ID.
        if (response.status >= 400 && response.status < 500 && !location) { await hooks?.rejected(); continue; }
        return { outcome: 'unknown', callId, model, error: 'provider_create_unknown' };
      }
      if (!callId) return { outcome: 'unknown', callId, model, error: 'provider_id_missing' };
      const answer = await response.text();
      if (!answer.trim()) return { outcome: 'unknown', callId, model, error: 'provider_sdp_missing' };
      return { outcome: 'accepted', callId, answer, model };
    } catch { return { outcome: 'unknown', callId, model, error: 'provider_create_unknown' }; }
  }
  return { outcome: 'rejected', callId: null, model: SALES_MODELS[1], error: 'realtime_unavailable' };
}

// Deliberately mirrors the controller's strict modality/cached-token evidence parser;
// importing sideband.ts would also load unrelated onboarding/customer dependencies.
export function parseSalesUsage(value: any): UsageTotals | null {
  if (!value || typeof value !== 'object') return null;
  const i = value.input_token_details, o = value.output_token_details, c = i?.cached_tokens_details;
  if (!i || !o || !c) return null;
  const values = [value.input_tokens,value.output_tokens,value.total_tokens,i.text_tokens,i.audio_tokens,i.cached_tokens,c.text_tokens,c.audio_tokens,o.text_tokens,o.audio_tokens];
  if (values.some(v => !Number.isSafeInteger(v) || v < 0)) return null;
  if (value.input_tokens !== i.text_tokens+i.audio_tokens || value.output_tokens !== o.text_tokens+o.audio_tokens || value.total_tokens !== value.input_tokens+value.output_tokens || i.cached_tokens !== c.text_tokens+c.audio_tokens || c.text_tokens > i.text_tokens || c.audio_tokens > i.audio_tokens) return null;
  return { textIn:i.text_tokens,audioIn:i.audio_tokens,textInCached:c.text_tokens,audioInCached:c.audio_tokens,textOut:o.text_tokens,audioOut:o.audio_tokens };
}
