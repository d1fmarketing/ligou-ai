const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const BINDING_KEYS = ['callId', 'interviewId', 'revision', 'sourceDigest'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedText = (value, limit) => typeof value === 'string' && value.length <= limit * 2 && Boolean(value.trim()) && [...value].length <= limit
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const error = detail => new Error(`Voz do onboarding indisponível: ${detail}`);
const notify = (callback, ...args) => { try { callback?.(...args); } catch { /* Observers do not control media or authority. */ } };
const suffix = id => id.replaceAll('-', '').slice(0, 28);
const checkpointMetadata = metadata => ['review', 'signoff'].includes(metadata?.native_checkpoint) && UUID.test(metadata.native_request_id ?? '')
  ? { checkpoint: metadata.native_checkpoint, requestId: metadata.native_request_id } : null;

export function validateWebsiteNative(value, { callId, interviewId }) {
  if (!exact(value, BINDING_KEYS) || !UUID.test(value.callId) || !UUID.test(value.interviewId)
    || value.callId !== callId || value.interviewId !== interviewId || !HASH.test(value.sourceDigest)
    || !Number.isSafeInteger(value.revision) || value.revision < 0) throw error('identidade da entrevista divergente');
  return Object.freeze({ ...value });
}

/** All speech stays native and duplex. Only issued review/signoff responses
 * report client playout; the server independently owns their meaning and approval. */
export function createWebsiteNativePlayer({ callId, interviewId, prepareOutput, observeMedia, outputIsActive,
  send, setMicrophone, setOutput, onCaption, onFailure, onPhase, onTiming, signal, controlTimeoutMs = 15_000 }) {
  if (!UUID.test(callId) || !UUID.test(interviewId) || !Number.isSafeInteger(controlTimeoutMs)
    || controlTimeoutMs < 1 || controlTimeoutMs > 30_000) throw error('configuração inválida');
  const controller = new AbortController(), contexts = new Set(), responses = new Map(), requests = new Set(), captions = new Set();
  let binding, openingBinding, current, started = false, mediaReady = false, configured = false, active = false, firstAudio = false, ownerSpeaking = false;
  let stopProbe, configTimer, resolveStart, rejectStart;
  const startResult = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; }); startResult.catch(() => {});
  const stopped = () => controller.signal.aborted;
  const report = phase => notify(onPhase, phase);
  const mark = (event, details = {}) => notify(onTiming, event, { transport: 'realtime_native_v1', mode: 'conversation', callId, interviewId,
    revision: binding?.revision, sourceDigest: binding?.sourceDigest, ...details });
  const responseDetails = response => ({ responseId: response.id, ...(response.checkpoint ? { checkpoint: response.checkpoint, nativeRequestId: response.requestId } : {}),
    revision: response.revision, sourceDigest: response.sourceDigest });
  function caption(kind, text, key) {
    if (!boundedText(text, 8192) || captions.has(key)) return;
    captions.add(key); notify(onCaption, { kind, text });
  }
  function retire(response, reason) {
    if (!response?.checkpoint || response.retired || response.played) return;
    response.retired = true; clearTimeout(response.timer);
    mark('native_checkpoint_unconfirmed', { ...responseDetails(response), reason });
  }
  function stop() {
    if (stopped()) return;
    controller.abort(); clearTimeout(configTimer); active = false; stopProbe?.();
    for (const response of responses.values()) clearTimeout(response.timer);
    setOutput(false); setMicrophone(false); report('stopped'); rejectStart(error('sessão encerrada'));
    signal?.removeEventListener('abort', stop);
  }
  function fail(reason) { if (!stopped()) { stop(); notify(onFailure, reason); } }
  function bounded(operation) {
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = (reason, value) => { if (settled) return; settled = true; clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort); reason ? reject(reason) : resolve(value); };
      const abort = () => finish(error('sessão encerrada'));
      controller.signal.addEventListener('abort', abort, { once: true });
      if (stopped()) { abort(); return; }
      timer = setTimeout(() => finish(error('áudio ou controle indisponível')), controlTimeoutMs);
      Promise.resolve().then(operation).then(value => finish(null, value), reason => finish(reason));
    });
  }
  function tryPlayed(response) {
    if (stopped() || response !== current || !response.checkpoint || response.retired || response.played || response.bufferStoppedAt === null) return;
    if (!outputIsActive?.()) { retire(response, 'output_inactive'); return; }
    const now = performance.now(), remaining = 2000 - (now - response.bufferStoppedAt);
    if (remaining <= 0) { retire(response, response.itemId ? 'media_unproven' : 'generation_unproven'); return; }
    const quietFor = response.samples ? now - Math.max(response.bufferStoppedAt, response.lastSample) : 0;
    if (!response.itemId || !response.samples || quietFor < 120) {
      if (!response.timer) response.timer = setTimeout(() => { response.timer = null; tryPlayed(response); },
        Math.max(1, Math.min(remaining, response.itemId && response.samples ? 120 - quietFor : 25)));
      return;
    }
    const observedMs = now - response.createdAt;
    if (!Number.isFinite(observedMs) || observedMs < 0 || observedMs > 180_000 || response.lastSample < response.firstSample) {
      retire(response, 'media_timing_invalid'); return;
    }
    const body = { callId, interviewId, responseId: response.id, itemId: response.itemId, checkpoint: response.checkpoint,
      mediaEvidence: { schema: 'onboarding.stream.media.v1', nonzeroSamples: response.samples, observedMs,
        firstSampleAtMs: response.firstSample, lastSampleAtMs: response.lastSample, unmuted: true, playbackStarted: true } };
    clearTimeout(response.timer); response.timer = null;
    try { send({ type: 'conversation.item.create', item: { id: `lnp-${suffix(response.requestId)}`, type: 'message', role: 'system', status: 'completed',
      content: [{ type: 'input_text', text: `ligou.website_native_played:${JSON.stringify(body)}` }] } }); }
    catch { retire(response, 'control_unavailable'); return; }
    response.played = true;
    mark('native_checkpoint_played', { ...responseDetails(response), evidence: 'client_playout_report_sent' });
    if (response.checkpoint === 'review') report(ownerSpeaking ? 'owner-speaking' : 'idle');
  }
  function activate() {
    if (stopped() || !started || !mediaReady || !configured || active) return;
    clearTimeout(configTimer); active = true; report('waiting-response'); setOutput(true); setMicrophone(true);
    const closeObserver = observeMedia(value => {
      const response = current, now = performance.now();
      if (stopped() || !active || !response?.bufferStarted || response.interrupted || response.retired || !outputIsActive?.()
        || value?.unmuted !== true || value.playbackStarted !== true || !Number.isSafeInteger(value.nonzeroSamples) || value.nonzeroSamples < 1
        || !Number.isFinite(value.atMs) || value.atMs < response.createdAt || value.atMs > now || (response.lastSample !== null && value.atMs < response.lastSample)) return;
      if (!Number.isSafeInteger(response.samples + value.nonzeroSamples)) { retire(response, 'media_count_invalid'); return; }
      response.samples += value.nonzeroSamples; response.lastSample = value.atMs;
      if (response.firstSample === null) {
        response.firstSample = value.atMs;
        mark('speech_first_nonzero_sample', { ...responseDetails(response), audioRole: firstAudio ? 'interview_turn' : 'opening', evidence: 'remote_webrtc_media' });
        if (!firstAudio) { firstAudio = true; resolveStart(); }
      }
      tryPlayed(response);
    }, reason => { if (active) fail(error(reason)); });
    if (stopped()) { closeObserver?.(); return; }
    stopProbe = closeObserver;
    try { send({ type: 'conversation.item.create', item: { id: `lnr-${suffix(callId)}`, type: 'message', role: 'system', status: 'completed',
      content: [{ type: 'input_text', text: `ligou.website_native_ready:${JSON.stringify({ callId, interviewId })}` }] } }); }
    catch { fail(error('canal de controle indisponível')); return; }
    mark('native_ready');
  }
  function handleContext(event) {
    const item = event.item, text = item?.content?.[0]?.text;
    if (item?.type !== 'message' || item.role !== 'system' || item.status !== 'completed' || item.content?.length !== 1
      || item.content[0].type !== 'input_text' || typeof text !== 'string' || text.length > 32_768
      || !text.startsWith('ligou.website_native:') || !/^lnc-[0-9a-f]{28}$/.test(item.id ?? '') || contexts.has(item.id)) return;
    try {
      const value = JSON.parse(text.slice('ligou.website_native:'.length));
      if (!exact(value, [...BINDING_KEYS, 'mode', 'currentQuestion']) || value.mode !== 'conversation') return;
      const next = validateWebsiteNative(Object.fromEntries(BINDING_KEYS.map(key => [key, value[key]])), { callId, interviewId });
      if (next.revision < binding.revision || (next.revision === binding.revision && next.sourceDigest !== binding.sourceDigest)
        || (value.currentQuestion !== null && (!exact(value.currentQuestion, ['itemId', 'questionPt'])
          || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.currentQuestion.itemId ?? '') || !boundedText(value.currentQuestion.questionPt, 4096)))) return;
      if (next.revision !== binding.revision || next.sourceDigest !== binding.sourceDigest) retire(current, 'snapshot_changed');
      binding = next; contexts.add(item.id); mark('native_context', { currentQuestionItemId: value.currentQuestion?.itemId ?? null });
    } catch { /* Context notices cannot replace owner/call identity or authorize writes. */ }
  }
  function handleEvent(event) {
    if (stopped() || !started) return;
    if (event?.type === 'session.updated') {
      const session = event.session, detection = session?.audio?.input?.turn_detection;
      if (session?.output_modalities?.length !== 1 || session.output_modalities[0] !== 'audio' || detection?.type !== 'semantic_vad'
        || detection.eagerness !== 'medium' || detection.create_response !== true || detection.interrupt_response !== true) { fail(error('modo de voz divergente')); return; }
      configured = true; activate(); return;
    }
    if (['conversation.item.created', 'conversation.item.done', 'conversation.item.retrieved'].includes(event?.type)) { handleContext(event); return; }
    if (event?.type === 'conversation.item.input_audio_transcription.completed' && ID.test(event.item_id ?? ''))
      caption('caller', event.transcript, `caller:${event.item_id}`);
    if (!active) return;
    if (event?.type === 'input_audio_buffer.speech_started') {
      ownerSpeaking = true; if (current) current.interrupted = true; retire(current, 'owner_interrupted'); report('owner-speaking'); return;
    }
    if (event?.type === 'input_audio_buffer.speech_stopped') { ownerSpeaking = false; report('processing'); return; }
    const responseId = event?.response?.id ?? event?.response_id;
    if (!ID.test(responseId ?? '')) return;
    if (event.type === 'response.created') {
      if (responses.has(responseId)) return;
      if (event.response.metadata?.ligou_call_id && event.response.metadata.ligou_call_id !== callId) { fail(error('resposta de outra chamada')); return; }
      retire(current, 'response_replaced');
      const checkpoint = checkpointMetadata(event.response.metadata);
      const uniqueCheckpoint = checkpoint && !requests.has(checkpoint.requestId) ? checkpoint : null;
      if (checkpoint) requests.add(checkpoint.requestId);
      current = { id: responseId, ...uniqueCheckpoint, revision: binding.revision, sourceDigest: binding.sourceDigest, createdAt: performance.now(),
        bufferStarted: false, bufferStoppedAt: null, samples: 0, firstSample: null, lastSample: null, itemId: null, interrupted: false, retired: false, played: false, timer: null };
      responses.set(responseId, current); mark('native_response_created', responseDetails(current)); return;
    }
    const response = responses.get(responseId);
    if (!response || response.retired) return;
    if (event.type === 'response.output_audio_transcript.done') caption('agent', event.transcript, `agent:${responseId}:${event.item_id}`);
    if (event.type === 'response.done') {
      const done = event.response, item = done.output?.[0], audio = item?.content?.[0], metadata = checkpointMetadata(done.metadata);
      if (response.checkpoint && !response.played) {
        if (done.status !== 'completed' || metadata?.checkpoint !== response.checkpoint || metadata.requestId !== response.requestId
          || done.output?.length !== 1 || item?.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed'
          || !ID.test(item.id ?? '') || item.content?.length !== 1 || !['audio', 'output_audio'].includes(audio?.type)) retire(response, 'generation_unproven');
        else { response.itemId = item.id; tryPlayed(response); }
      }
      if (done.status === 'completed' && Array.isArray(done.output) && done.output.length <= 16) for (const output of done.output) {
        if (output?.type !== 'message' || output.role !== 'assistant' || output.status !== 'completed' || !ID.test(output.id ?? '')
          || !Array.isArray(output.content) || output.content.length > 4) continue;
        for (const part of output.content) if (['audio', 'output_audio'].includes(part?.type)) caption('agent', part.transcript, `agent:${responseId}:${output.id}`);
      }
    }
    if (response !== current || !ID.test(event.event_id ?? '')) return;
    if (event.type === 'output_audio_buffer.started' && !response.bufferStarted) {
      response.bufferStarted = true; report('playing'); mark('speech_playing', { ...responseDetails(response), evidence: 'webrtc_output_buffer_started' });
    } else if (event.type === 'output_audio_buffer.stopped' && response.bufferStoppedAt === null) {
      response.bufferStoppedAt = performance.now(); mark('speech_provider_buffer_stopped', { ...responseDetails(response), evidence: 'webrtc_output_buffer_stopped' });
      if (response.checkpoint) tryPlayed(response);
      else report(firstAudio ? (ownerSpeaking ? 'owner-speaking' : 'idle') : 'waiting-response');
    } else if (event.type === 'output_audio_buffer.cleared') {
      response.interrupted = true; retire(response, 'buffer_cleared');
      mark('speech_interrupted', { ...responseDetails(response), evidence: 'webrtc_output_buffer_cleared' }); report(ownerSpeaking ? 'owner-speaking' : 'processing');
    }
  }
  function start(value, playbackReady) {
    try {
      const checked = validateWebsiteNative(value, { callId, interviewId });
      if (started) { if (BINDING_KEYS.some(key => checked[key] !== openingBinding[key])) throw error('abertura da entrevista divergente'); return startResult; }
      binding = openingBinding = checked; started = true;
    } catch (reason) { fail(reason); return startResult; }
    void (async () => {
      await bounded(() => playbackReady); await bounded(() => prepareOutput(controller.signal));
      if (stopped()) return;
      mediaReady = true;
      if (!configured) configTimer = setTimeout(() => fail(error('modo de voz não confirmado')), controlTimeoutMs);
      activate();
    })().catch(reason => { if (!stopped()) fail(reason); });
    return startResult;
  }
  report('loading'); setOutput(false); setMicrophone(false);
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  return { start, handleEvent, stop };
}
