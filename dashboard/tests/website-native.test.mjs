import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteNativePlayer, validateWebsiteNative } from '../src/voice/website-native.js';

const callId = '11111111-1111-4111-8111-111111111111';
const interviewId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const binding = { callId, interviewId, revision: 3, sourceDigest: 'b'.repeat(64) };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await tick(); } assert.fail('expected native adapter state'); }
const nativeConfig = (id = 'session_native_1') => ({ type: 'session.updated', event_id: id, session: {
  output_modalities: ['audio'], tools: [{ type: 'function', name: 'save_owner_answer' }], tool_choice: 'auto',
  audio: { input: { turn_detection: { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true } } },
} });
const context = (revision = 4, id = 'c'.repeat(28), changes = {}) => ({ type: 'conversation.item.done', item: {
  id: `lnc-${id}`, type: 'message', role: 'system', status: 'completed', content: [{ type: 'input_text',
    text: `ligou.website_native:${JSON.stringify({ ...binding, revision, mode: 'conversation', currentQuestion: { itemId: 'area.coverage', questionPt: 'Quais cidades sua empresa atende?' }, ...changes })}` }],
} });
const metadata = (checkpoint = 'review', issued = requestId) => ({ native_checkpoint: checkpoint, native_request_id: issued });
const created = (id = 'native_response_1', checkpoint, issued = requestId) => ({ type: 'response.created', response: {
  id, status: 'in_progress', output_modalities: ['audio'], ...(checkpoint ? { metadata: metadata(checkpoint, issued) } : {}),
} });
const buffer = (type, id = 'native_response_1') => ({ type: `output_audio_buffer.${type}`, event_id: `buffer_${type}_${id}`, response_id: id });
const completed = (id = 'native_response_1', checkpoint, issued = requestId, text = 'Combinamos atender Recife e Olinda, respeitando as exceções que você informou.') => ({ type: 'response.done', response: {
  id, status: 'completed', ...(checkpoint ? { metadata: metadata(checkpoint, issued) } : {}), output: [{ id: `item_${id}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'audio', transcript: text }] }],
} });
function harness({ prepare = async () => {}, onTiming, mediaUnavailable = false } = {}) {
  const sent = [], outputs = [], mics = [], timings = [], captions = [], errors = [], probes = [], phases = [];
  const player = createWebsiteNativePlayer({ callId, interviewId, controlTimeoutMs: 500, prepareOutput: prepare,
    observeMedia: (sample, unavailable) => { const probe = { sample, unavailable, stopped: false }; probes.push(probe); if (mediaUnavailable) unavailable('capture_unavailable'); return () => { probe.stopped = true; }; },
    outputIsActive: () => outputs.at(-1) === true, send: event => sent.push(event),
    setOutput: value => outputs.push(value), setMicrophone: value => mics.push(value),
    onTiming: (event, details) => { timings.push({ event, ...details }); onTiming?.(event, details); },
    onCaption: value => captions.push(value), onFailure: value => errors.push(value), onPhase: value => phases.push(value),
  });
  const control = purpose => sent.filter(event => event.item.content[0].text.startsWith(`ligou.website_${purpose}:`));
  const sample = () => probes.at(-1)?.sample({ nonzeroSamples: 64, atMs: performance.now(), unmuted: true, playbackStarted: true });
  const start = gate => { const promise = player.start(binding, gate); promise.catch(() => {}); return promise; };
  async function boot() { const started = start(); player.handleEvent(nativeConfig()); await until(() => control('native_ready').length === 1); player.handleEvent(created()); player.handleEvent(buffer('started')); sample(); await started; }
  function checkpoint(kind = 'review', id = 'checkpoint_1', issued = requestId) { player.handleEvent(created(id, kind, issued)); player.handleEvent(buffer('started', id)); }
  return { player, sent, outputs, mics, timings, captions, errors, probes, phases, control, sample, start, boot, checkpoint };
}

test('bootstrap binding rejects foreign identity, invalid revision and speech payload additions', () => {
  assert.deepEqual(validateWebsiteNative(binding, { callId, interviewId }), binding);
  for (const changed of [{ ...binding, callId: interviewId }, { ...binding, interviewId: callId },
    { ...binding, revision: -1 }, { ...binding, revision: 1.5 }, { ...binding, sourceDigest: 'bad' },
    { ...binding, text: 'already approved' }, { ...binding, audio_base64: 'SUQz' }])
    assert.throws(() => validateWebsiteNative(changed, { callId, interviewId }));
});
test('native ready waits for channel, playable media and native config; only actual samples resolve startup', async () => {
  const channel = deferred(), media = deferred(), h = harness({ prepare: () => media.promise });
  let settled = false; const start = h.start(channel.promise).then(() => { settled = true; }); start.catch(() => {});
  try {
    h.player.handleEvent(nativeConfig()); await tick(); assert.equal(h.sent.length, 0);
    channel.resolve(); await tick(); assert.equal(h.sent.length, 0); assert.equal(h.outputs.at(-1), false);
    media.resolve(); await until(() => h.control('native_ready').length === 1);
    assert.equal(h.outputs.at(-1), true); assert.equal(h.mics.at(-1), true); assert.equal(settled, false);
    assert.equal(h.sent[0].item.id, 'lnr-1111111111114111811111111111');
    assert.deepEqual(JSON.parse(h.sent[0].item.content[0].text.slice('ligou.website_native_ready:'.length)), { callId, interviewId });
    h.player.handleEvent(created()); h.player.handleEvent(buffer('started')); await tick(); assert.equal(settled, false);
    h.sample(); await start; h.player.handleEvent(nativeConfig()); h.player.start(binding).catch(() => {});
    assert.equal(h.control('native_ready').length, 1); assert.equal(h.timings.filter(event => event.event === 'speech_first_nonzero_sample').length, 1);
  } finally { h.player.stop(); channel.resolve(); media.resolve(); await start.catch(() => {}); }
});
test('ordinary speech stays duplex through barge-in and captions have no playback authority', async () => {
  const h = harness(); try {
    await h.boot(); h.player.handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'owner_1' });
    h.player.handleEvent(buffer('cleared')); assert.equal(h.mics.at(-1), true); assert.equal(h.outputs.at(-1), true);
    const owner = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'owner_1', transcript: 'Atende Recife e Olinda.' };
    h.player.handleEvent(owner); h.player.handleEvent(owner);
    h.player.handleEvent(created('native_response_2')); h.player.handleEvent(buffer('started', 'native_response_2')); h.sample();
    const agent = { type: 'response.output_audio_transcript.done', response_id: 'native_response_2', item_id: 'agent_2', transcript: 'Entendi. Qual é o horário?' };
    h.player.handleEvent(agent); h.player.handleEvent(agent); h.player.handleEvent(buffer('stopped', 'native_response_2'));
    assert.deepEqual(h.captions, [{ kind: 'caller', text: owner.transcript }, { kind: 'agent', text: agent.transcript }]);
    assert.equal(h.sent.length, 1); assert.equal(h.errors.length, 0);
  } finally { h.player.stop(); }
});
for (const hold of ['channel', 'media', 'config']) test(`Stop during native ${hold} readiness cannot later send ready or enable media`, async () => {
  const wait = deferred(), h = harness({ prepare: () => hold === 'media' ? wait.promise : Promise.resolve() });
  const start = h.start(hold === 'channel' ? wait.promise : undefined);
  try {
    if (hold !== 'config') h.player.handleEvent(nativeConfig()); await tick(); h.player.stop(); wait.resolve();
    h.player.handleEvent(nativeConfig('late')); await assert.rejects(start); await tick();
    assert.equal(h.sent.length, 0); assert.equal(h.outputs.at(-1), false); assert.equal(h.mics.at(-1), false); assert.equal(h.errors.length, 0);
  } finally { h.player.stop(); wait.resolve(); }
});
test('autoplay failure and controlled text mode cannot authorize native readiness', async () => {
  for (const kind of ['autoplay', 'config']) {
    const h = harness({ prepare: async () => { if (kind === 'autoplay') throw new Error('autoplay'); } }), start = h.start();
    h.player.handleEvent(kind === 'config' ? { ...nativeConfig(), session: { ...nativeConfig().session, output_modalities: ['text'] } } : nativeConfig());
    await assert.rejects(start); assert.equal(h.sent.length, 0); assert.equal(h.outputs.at(-1), false); assert.equal(h.mics.at(-1), false); assert.equal(h.errors.length, 1);
  }
});
for (const checkpoint of ['review', 'signoff']) for (const completionFirst of [true, false])
test(`native ${checkpoint} joins completed generation, buffer stop and local drain (${completionFirst ? 'completion' : 'stop'} first)`, async () => {
  const h = harness(); try {
    await h.boot(); h.checkpoint(checkpoint); h.sample();
    h.player.handleEvent(completionFirst ? completed('checkpoint_1', checkpoint) : buffer('stopped', 'checkpoint_1'));
    assert.equal(h.control('native_played').length, 0); assert.equal(h.outputs.at(-1), true); assert.equal(h.mics.at(-1), true);
    h.player.handleEvent(completionFirst ? buffer('stopped', 'checkpoint_1') : completed('checkpoint_1', checkpoint));
    assert.equal(h.control('native_played').length, 0); await sleep(140); assert.equal(h.control('native_played').length, 1);
    const receipt = h.control('native_played')[0]; assert.equal(receipt.item.id, 'lnp-3333333333334333833333333333');
    const body = JSON.parse(receipt.item.content[0].text.slice('ligou.website_native_played:'.length));
    assert.deepEqual(Object.keys(body).sort(), ['callId', 'checkpoint', 'interviewId', 'itemId', 'mediaEvidence', 'responseId']);
    assert.equal(body.callId, callId); assert.equal(body.interviewId, interviewId); assert.equal(body.responseId, 'checkpoint_1');
    assert.equal(body.itemId, 'item_checkpoint_1'); assert.equal(body.checkpoint, checkpoint);
    assert.deepEqual(Object.keys(body.mediaEvidence).sort(), ['firstSampleAtMs', 'lastSampleAtMs', 'nonzeroSamples', 'observedMs', 'playbackStarted', 'schema', 'unmuted']);
    assert.equal(body.mediaEvidence.schema, 'onboarding.stream.media.v1'); assert.equal(body.mediaEvidence.nonzeroSamples, 64);
    assert.equal(body.mediaEvidence.unmuted, true); assert.equal(body.mediaEvidence.playbackStarted, true);
    assert.ok(body.mediaEvidence.observedMs >= 120 && body.mediaEvidence.observedMs <= 180_000);
    assert.equal(h.outputs.at(-1), true); assert.equal(h.mics.at(-1), true); assert.equal(h.probes.length, 1); assert.equal(h.errors.length, 0);
    h.player.handleEvent(completed('checkpoint_1', checkpoint)); h.player.handleEvent(buffer('stopped', 'checkpoint_1'));
    assert.equal(h.control('native_played').length, 1);
    const starts = h.timings.filter(event => event.event === 'speech_playing').length;
    h.player.handleEvent(buffer('started', 'checkpoint_1')); h.player.handleEvent(buffer('cleared', 'checkpoint_1'));
    assert.equal(h.timings.filter(event => event.event === 'speech_playing').length, starts);
    assert.equal(h.timings.some(event => event.event === 'native_checkpoint_unconfirmed'), false, 'later clear cannot undo completed playout');
  } finally { h.player.stop(); }
});
test('checkpoint completion may precede first RTP, and late audible samples extend the local drain', async () => {
  const h = harness(); try {
    await h.boot(); h.checkpoint(); h.player.handleEvent(completed('checkpoint_1', 'review')); h.player.handleEvent(buffer('stopped', 'checkpoint_1'));
    await sleep(30); assert.equal(h.control('native_played').length, 0); h.sample();
    await sleep(80); h.sample(); await sleep(80); assert.equal(h.control('native_played').length, 0);
    await sleep(60); assert.equal(h.control('native_played').length, 1); assert.equal(h.outputs.at(-1), true);
  } finally { h.player.stop(); }
});
test('zero-media checkpoint stays unconfirmed after bounded drain without ending native conversation', async () => {
  const h = harness(); try {
    await h.boot(); h.checkpoint(); h.player.handleEvent(completed('checkpoint_1', 'review')); h.player.handleEvent(buffer('stopped', 'checkpoint_1'));
    await sleep(2050); h.sample(); await tick(); assert.equal(h.control('native_played').length, 0);
    assert.equal(h.outputs.at(-1), true); assert.equal(h.mics.at(-1), true); assert.equal(h.errors.length, 0);
    assert.ok(h.timings.some(event => event.event === 'native_checkpoint_unconfirmed'));
  } finally { h.player.stop(); }
});
for (const retire of ['stop', 'owner', 'clear', 'new-response', 'new-revision', 'muted'])
test(`${retire} prevents late checkpoint proof without a phrase or mode-switch gate`, async () => {
  const h = harness(); try {
    await h.boot(); h.checkpoint(); h.sample(); h.player.handleEvent(completed('checkpoint_1', 'review')); h.player.handleEvent(buffer('stopped', 'checkpoint_1'));
    if (retire === 'stop') h.player.stop();
    else if (retire === 'owner') h.player.handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'correction_1' });
    else if (retire === 'clear') h.player.handleEvent(buffer('cleared', 'checkpoint_1'));
    else if (retire === 'new-response') h.player.handleEvent(created('next_native'));
    else if (retire === 'new-revision') h.player.handleEvent(context(4, 'e'.repeat(28), { sourceDigest: 'c'.repeat(64) }));
    else h.outputs.push(false);
    await sleep(145); h.player.handleEvent(completed('checkpoint_1', 'review')); h.sample(); await tick();
    assert.equal(h.control('native_played').length, 0); assert.equal(h.errors.length, 0);
    if (!['stop', 'muted'].includes(retire)) { assert.equal(h.outputs.at(-1), true); assert.equal(h.mics.at(-1), true); }
  } finally { h.player.stop(); }
});
for (const invalid of ['unissued-shape', 'different-request', 'cancelled', 'no-audio'])
test(`${invalid} generation cannot supply checkpoint played authority`, async () => {
  const h = harness(); try {
    await h.boot(); h.checkpoint('review', 'checkpoint_1', invalid === 'unissued-shape' ? 'not-a-uuid' : requestId); h.sample();
    const done = completed('checkpoint_1', 'review');
    if (invalid === 'different-request') done.response.metadata.native_request_id = '44444444-4444-4444-8444-444444444444';
    if (invalid === 'cancelled') done.response.status = 'cancelled';
    if (invalid === 'no-audio') done.response.output[0].content = [{ type: 'output_text', text: 'Not audio' }];
    h.player.handleEvent(done); h.player.handleEvent(buffer('stopped', 'checkpoint_1')); await sleep(140);
    assert.equal(h.control('native_played').length, 0); assert.equal(h.outputs.at(-1), true); assert.equal(h.errors.length, 0);
  } finally { h.player.stop(); }
});
test('a replayed checkpoint request cannot earn a second report for another response', async () => {
  const h = harness(); try {
    await h.boot(); h.checkpoint(); h.sample(); h.player.handleEvent(completed('checkpoint_1', 'review')); h.player.handleEvent(buffer('stopped', 'checkpoint_1')); await sleep(140);
    h.checkpoint('review', 'checkpoint_duplicate'); h.sample(); h.player.handleEvent(completed('checkpoint_duplicate', 'review')); h.player.handleEvent(buffer('stopped', 'checkpoint_duplicate')); await sleep(140);
    assert.equal(h.control('native_played').length, 1); assert.equal(h.errors.length, 0);
  } finally { h.player.stop(); }
});
test('context revisions update without muting or accepting same-revision digest changes', async () => {
  const h = harness({ onTiming: () => { throw new Error('observer failed'); } }); try {
    await h.boot(); const outputChanges = h.outputs.length;
    h.player.handleEvent(context(4, 'e'.repeat(28), { sourceDigest: 'c'.repeat(64) }));
    for (const changes of [{ callId: interviewId }, { revision: 4, sourceDigest: 'd'.repeat(64) }, { revision: 2 },
      { currentQuestion: { itemId: 'x', questionPt: 'x'.repeat(4097) } }, { secret: 'forbidden' }]) h.player.handleEvent(context(5, 'd'.repeat(28), changes));
    assert.equal(h.timings.filter(event => event.event === 'native_context').length, 1);
    assert.equal(h.timings.find(event => event.event === 'native_context').sourceDigest, 'c'.repeat(64));
    assert.equal(h.timings.some(event => Object.hasOwn(event, 'questionPt') || Object.hasOwn(event, 'secret')), false);
    assert.equal(h.outputs.length, outputChanges); assert.equal(h.probes.length, 1); assert.equal(h.errors.length, 0);
  } finally { h.player.stop(); }
});
test('historical selected-speech notices cannot start a native controlled-review bridge', async () => {
  const h = harness(); try {
    await h.boot(); const descriptor = { schema: 'onboarding.stream.v1', action: { ...binding, actionId: 'a'.repeat(64), kind: 'GENERATE_FINAL_SUMMARY', text: 'An exact selected phrase.' }, dispatchId: requestId, receiptId: '44444444-4444-4444-8444-444444444444' };
    h.player.handleEvent({ type: 'conversation.item.done', item: { id: 'lsn-3333333333334333833333333333', type: 'message', role: 'system', status: 'completed', content: [{ type: 'input_text', text: `ligou.website_stream:${JSON.stringify(descriptor)}` }] } });
    await tick(); assert.equal(h.outputs.at(-1), true); assert.equal(h.mics.at(-1), true); assert.equal(h.sent.length, 1); assert.equal(h.errors.length, 0);
  } finally { h.player.stop(); }
});
test('synchronous media observer failure cannot send native ready after stopping the session', async () => {
  const h = harness({ mediaUnavailable: true }), start = h.start(); h.player.handleEvent(nativeConfig());
  await assert.rejects(start); await tick(); assert.equal(h.control('native_ready').length, 0);
  assert.equal(h.outputs.at(-1), false); assert.equal(h.mics.at(-1), false); assert.equal(h.probes.every(probe => probe.stopped), true); assert.equal(h.errors.length, 1);
});
test('native response.done preserves captions if its separate transcript event was missed', async () => {
  const h = harness(); try {
    await h.boot(); h.player.handleEvent(completed()); assert.equal(h.captions.length, 1);
    h.player.handleEvent({ type: 'response.output_audio_transcript.done', response_id: 'native_response_1', item_id: 'item_native_response_1', transcript: completed().response.output[0].content[0].transcript });
    assert.equal(h.captions.length, 1); assert.equal(h.sent.length, 1);
  } finally { h.player.stop(); }
});
