import { describe, expect, test } from 'bun:test';
import { createLiveUsageLedger, managedTextRates, managedTextUsageCost } from '../src/onboarding-live-usage';
const usage = (input = 1000, output = 200, cached = 400, writes = 200) => ({ input_tokens: input, output_tokens: output, total_tokens: input + output,
  input_tokens_details: { cached_tokens: cached, cache_write_tokens: writes }, output_tokens_details: { reasoning_tokens: 100 } });
const response = (responseId = 'resp-one') => ({ responseId, model: 'gpt-5.6-terra', status: 'completed', usage: usage() });
const ledger = () => createLiveUsageLedger({ created: true, backendModel: 'gpt-5.6-terra' });

describe('Live voice and managed backend usage', () => {
  test('initialization minimum applies only to an actually created session', () => {
    const pending = createLiveUsageLedger({ created: false, backendModel: 'gpt-5.6-terra' });
    expect(pending.snapshot().voiceCostUsd).toBe(0); pending.markCreated();
    expect(pending.snapshot().voiceCostUsd).toBe(0.0125); expect(pending.snapshot().usageResolved).toBe(false);
  });
  test('cumulative duration replaces updates and does not add startup again', () => {
    const f = ledger(); for (const seconds of [12, 12, 19, 13, 90]) f.observeVoice(seconds);
    f.observeVoice(90, true); expect(f.snapshot()).toMatchObject({ voiceSeconds: 90, billableVoiceSeconds: 90, voiceCostUsd: 0.075, usageResolved: true });
  });
  test('fractional seconds are priced without rounding to a minute', () => {
    const f = ledger(); f.observeVoice(61.5, true); expect(f.snapshot().voiceCostUsd).toBe(0.05125);
  });
  test('stale or missing final duration cannot prove final usage', () => {
    const f = ledger(); f.observeVoice(19); f.observeVoice(12, true);
    expect(f.snapshot()).toMatchObject({ voiceSeconds: 19, voiceUsageResolved: false, usageResolved: false });
    f.observeVoice(undefined, true); expect(f.snapshot().voiceUsageResolved).toBe(false);
  });
  test('later duration beyond a previously reported final invalidates final certainty', () => {
    const f = ledger(); f.observeVoice(20, true); f.observeVoice(25);
    expect(f.snapshot().voiceUsageResolved).toBe(false); f.observeVoice(25, true); expect(f.snapshot().voiceUsageResolved).toBe(true);
  });
  test('cache reads and writes are removed from ordinary input and reasoning is not added twice', () => {
    expect(managedTextUsageCost('gpt-5.6-terra', usage())).toMatchObject({ costUsd: 0.00378, reason: 'priced', usage: { ordinaryInputTokens: 400, outputTokens: 200 } });
  });
  test('long-context rate applies to the full request strictly above 272K input tokens', () => {
    expect(managedTextRates('gpt-5.6-terra', 272000)).toMatchObject({ context: 'short', inputUsdPerMillion: 2, outputUsdPerMillion: 12 });
    expect(managedTextRates('gpt-5.6-terra', 272001)).toMatchObject({ context: 'long', inputUsdPerMillion: 4, outputUsdPerMillion: 18 });
    expect(managedTextUsageCost('gpt-5.6-terra', usage(272001, 10, 0, 0)).costUsd).toBe(1.088184);
  });
  test('counts distinct terminal Responses exactly once even when replayed', () => {
    const f = ledger(); f.observeVoice(90, true); f.observeResponse(response()); f.observeResponse(response()); f.observeResponse(response('resp-two'));
    expect(f.snapshot()).toMatchObject({ backendCostUsd: 0.00756, totalObservedCostUsd: 0.08256, usageResolved: true });
    expect(f.snapshot().responses).toHaveLength(2);
  });
  test('response creation without terminal usage remains unknown until recovered', () => {
    const f = ledger(); f.observeVoice(90, true); f.observeResponse({ ...response(), status: 'in_progress', usage: undefined });
    expect(f.snapshot()).toMatchObject({ backendCostUsd: null, backendObservedCostUsd: 0, usageResolved: false, unknownResponseIds: ['resp-one'] });
    f.observeResponse({ ...response(), usage: undefined }); expect(f.snapshot().usageResolved).toBe(false);
    f.observeResponse(response()); expect(f.snapshot().usageResolved).toBe(true);
  });
  test('late created or missing-usage duplicate cannot erase known terminal usage', () => {
    const f = ledger(); f.observeVoice(90, true); f.observeResponse(response());
    f.observeResponse({ ...response(), status: 'in_progress', usage: undefined }); f.observeResponse({ ...response(), usage: undefined });
    expect(f.snapshot()).toMatchObject({ backendCostUsd: 0.00378, usageResolved: true });
  });
  test('different terminal snapshots for one response stay one charge and explicitly unresolved', () => {
    const f = ledger(); f.observeVoice(90, true); f.observeResponse(response()); f.observeResponse({ ...response(), usage: usage(1000, 300) });
    expect(f.snapshot().responses).toHaveLength(1); expect(f.snapshot()).toMatchObject({ backendCostUsd: null, usageResolved: false });
  });
  test('missing actual model or unsupported rates never borrow the configured model price', () => {
    const f = ledger(); f.observeVoice(20, true); f.observeResponse({ ...response(), model: null });
    f.observeResponse({ ...response('resp-other'), model: 'unknown-model' });
    expect(f.snapshot()).toMatchObject({ backendCostUsd: null, backendObservedCostUsd: 0, usageResolved: false });
  });
  test('missing cache-write breakdown stays unknown for Agents aggregate usage too', () => {
    const value = { ...usage(), input_tokens_details: { cached_tokens: 400 } };
    expect(managedTextUsageCost('gpt-5.6-terra', value)).toMatchObject({ costUsd: null, reason: 'cache_breakdown_missing' });
  });
  test('unsupported processing tier is unpriced, not silently treated as standard', () => {
    expect(managedTextUsageCost('gpt-5.6-terra', usage(), 'priority')).toMatchObject({ costUsd: null, reason: 'rates_unknown' });
  });
  test('malformed or overlapping token counts are rejected without throwing into voice', () => {
    for (const value of [null, {}, usage(-1), usage(100, 5, 99, 2), { ...usage(), total_tokens: 9999 }, usage(0.5)]) {
      expect(managedTextUsageCost('gpt-5.6-terra', value).costUsd).toBeNull();
    }
    const f = ledger(); for (const value of [-1, Infinity, NaN, '24']) f.observeVoice(value);
    expect(f.snapshot()).toMatchObject({ voiceSeconds: 0, usageResolved: false, invalidObservations: 4 });
  });
  test('failed/incomplete/cancelled terminal work still carries observed cost', () => {
    const f = ledger(); f.observeVoice(20, true);
    for (const status of ['failed', 'incomplete', 'cancelled']) f.observeResponse({ ...response(status), status });
    expect(f.snapshot()).toMatchObject({ backendCostUsd: 0.01134, usageResolved: true, invoiced: false });
  });
});
