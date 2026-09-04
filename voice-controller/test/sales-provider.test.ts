import { expect, test } from 'bun:test';
import { createSalesCall, salesSessionConfig, parseSalesUsage } from '../src/sales/provider.ts';

test('multipart uses authoritative sales audio configuration and only explicit rejection permits fallback', async () => {
  const models: string[] = [];
  const result = await createSalesCall('v=0\r\no=offer', 'req', async (_url, init) => {
    expect(init?.body).toBeInstanceOf(FormData);
    const body = init!.body as FormData;
    expect(body.get('sdp')).toContain('v=0');
    const config = JSON.parse(String(body.get('session')));
    models.push(config.model);
    expect(config.audio.output.voice).toBe('ash');
    expect(config.tools.map((t: any) => t.name)).toEqual(['save_lead_fact', 'confirm_contact', 'record_followup_consent', 'end_sales_call']);
    return models.length === 1 ? new Response('', { status: 404 }) : new Response('answer', { status: 201, headers: { Location: '/v1/realtime/calls/rtc_ok' } });
  });
  expect(models).toEqual(['gpt-realtime-2.1', 'gpt-realtime-2.1-mini']);
  expect(result).toEqual({ outcome: 'accepted', callId: 'rtc_ok', answer: 'answer', model: 'gpt-realtime-2.1-mini' });
});
for (const failure of ['transport', '500', 'empty_sdp', 'missing_id', 'rejected_with_id']) {
  test(`never retries ambiguous creation: ${failure}`, async () => {
    let count = 0;
    const result = await createSalesCall('offer', 'req', async () => {
      count++;
      if (failure === 'transport') throw new Error('lost');
      return new Response(failure === 'empty_sdp' ? '' : 'answer', { status: failure === '500' ? 500 : failure === 'rejected_with_id' ? 400 : 201, headers: failure === 'missing_id' || failure === '500' ? {} : { Location: '/v1/realtime/calls/rtc_id' } });
    });
    expect(count).toBe(1);
    expect(result.outcome).toBe('unknown');
  });
}
test('all explicit nonacceptance is safe without pretending provider usage exists', async () => {
  expect((await createSalesCall('offer', 'req', async () => new Response('', {status: 403}))).outcome).toBe('rejected');
});
test('native VAD replies, server transcript evidence and commercial instructions', () => {
  const c = salesSessionConfig('gpt-realtime-2.1');
  expect(c.audio.input.turn_detection.create_response).toBe(true);
  expect(c.audio.input.transcription.model).toBe('gpt-4o-mini-transcribe');
  expect(c.instructions).toContain('299');
  expect(c.instructions).toContain('400');
  expect(c.instructions).toContain('0,35');
});
test('usage requires complete consistent provider evidence and preserves cached modalities', () => {
  expect(parseSalesUsage({ input_tokens: 5 })).toBeNull();
  const valid = { input_tokens: 30, output_tokens: 4, total_tokens: 34, input_token_details: { text_tokens: 10, audio_tokens: 20, cached_tokens: 6, cached_tokens_details: { text_tokens: 2, audio_tokens: 4 } }, output_token_details: { text_tokens: 1, audio_tokens: 3 } };
  expect(parseSalesUsage(valid)).toEqual({ textIn: 10, audioIn: 20, textInCached: 2, audioInCached: 4, textOut: 1, audioOut: 3 });
  expect(parseSalesUsage({ ...valid, total_tokens: 33 })).toBeNull();
});
