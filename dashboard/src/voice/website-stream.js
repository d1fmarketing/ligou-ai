const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const ACTION_KEYS = ['actionId','interviewId','callId','revision','kind','text','sourceDigest'];
const KINDS = new Set(['ASK_NEXT_GAP','CLARIFY_CURRENT_GAP','CONFIRM_AND_ASK_NEXT',
  'DEFER_OFF_SCOPE_AND_CONTINUE','REQUEST_FINAL_APPROVAL','HANDLE_OWNER_CORRECTION',
  'GENERATE_FINAL_SUMMARY','SPEAK_FINAL_SIGNOFF','SPEAK_TERMINAL_ERROR','SPEAK_AMENDMENT_SIGNOFF']);
const CLOSED_INPUT = new Set(['SPEAK_TERMINAL_ERROR','SPEAK_AMENDMENT_SIGNOFF']);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const error = detail => new Error(`Fala segura do onboarding: ${detail}`);
const suffix = dispatch => dispatch.replaceAll('-', '').slice(0, 28);
const same = (left, right) => left.dispatchId === right.dispatchId && left.receiptId === right.receiptId
  && ACTION_KEYS.every(key => left.action[key] === right.action[key]);

export function validateWebsiteStream(value, { callId, interviewId }) {
  const action = value?.action;
  if (!exact(value, ['schema','action','dispatchId','receiptId']) || value.schema !== 'onboarding.stream.v1'
    || !UUID.test(value.dispatchId) || !UUID.test(value.receiptId) || !exact(action, ACTION_KEYS)
    || !HASH.test(action.actionId) || !HASH.test(action.sourceDigest)
    || !UUID.test(action.callId) || !UUID.test(action.interviewId)
    || action.callId !== callId || action.interviewId !== interviewId
    || !Number.isSafeInteger(action.revision) || action.revision < 0 || !KINDS.has(action.kind)
    || typeof action.text !== 'string' || !action.text.trim() || [...action.text].length > 4096
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.text)) throw error('autorização de streaming divergente');
  return Object.freeze({ ...value, action: Object.freeze({ ...action }) });
}

/** Observe the received audio without changing its route to the speakers. The
 * browser evidence establishes media activity, not what a physical listener heard. */
export function observeRemoteStreamMedia(audio, onSample, onUnavailable) {
  let context, source, stream, timer, closed = false;
  const stop = () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    try { source?.disconnect(); } catch { /* Observer cleanup cannot change audio custody. */ }
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    try { context?.close()?.catch?.(() => {}); } catch { /* Optional observer. */ }
  };
  try {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext || !audio.srcObject?.getAudioTracks?.().length) throw error('áudio remoto indisponível');
    // Clone the existing remote track. Repeated captureStream calls in Edge can
    // starve another observer; a source-track clone avoids that browser defect.
    stream = audio.srcObject.clone();
    context = new AudioContext();
    const analyser = context.createAnalyser(); analyser.fftSize = 512;
    source = context.createMediaStreamSource(stream); source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const inspect = () => {
      if (closed) return;
      if (context.state === 'running' && !audio.muted && audio.volume > 0 && !audio.paused) {
        analyser.getFloatTimeDomainData(samples);
        const nonzeroSamples = samples.reduce((count, sample) => count + (Math.abs(sample) > 0.0001 ? 1 : 0), 0);
        if (nonzeroSamples) onSample({ nonzeroSamples, atMs: performance.now(), unmuted: true, playbackStarted: true });
      }
      timer = setTimeout(inspect, 16);
    };
    Promise.resolve(context.resume()).then(inspect).catch(() => { onUnavailable?.('capture_context_unavailable'); stop(); });
  } catch { onUnavailable?.('capture_unavailable'); stop(); }
  return stop;
}

export function createWebsiteStreamPlayer({ callId, interviewId, readStream, prepareOutput,
  observeMedia, outputIsActive, send, setMicrophone, setOutput, onCaption, onFailure, onPhase, onProgress,
  onTiming, controlTimeoutMs = 15_000, signal, now = () => performance.now() }) {
  if (!UUID.test(callId) || !UUID.test(interviewId) || !Number.isSafeInteger(controlTimeoutMs)
    || controlTimeoutMs < 1 || controlTimeoutMs > 30_000) throw error('configuração de streaming inválida');
  const controller = new AbortController(), seen = new Set(), retiredResponses = new Set(), retiredDispatches = new Set(), callerItems = new Set();
  let phase = 'idle', active = null, pending = null, safeVad = false, listening = false, task = Promise.resolve();
  let lastRevision = -1, failed = false, vadReady = null;
  const report = value => { phase = value; onPhase?.(value); };
  const microphone = value => { listening = value && !controller.signal.aborted; setMicrophone(listening); };
  const output = value => setOutput(value && !controller.signal.aborted);
  const mark = (event, details = {}) => onTiming?.(event, { audioRole: 'interview_turn', actionKind: active?.auth?.action.kind,
    actionId: active?.auth?.action.actionId, dispatchId: active?.auth?.dispatchId, responseId: active?.responseId, ...details });
  function control(purpose, data, auth = active?.auth) {
    if (!auth || controller.signal.aborted) return false;
    const prefix = { ready: 'lsr', played: 'lsp', interrupted: 'lsi' }[purpose];
    try {
      send({ type: 'conversation.item.create', item: { id: `${prefix}-${suffix(auth.dispatchId)}`,
        type: 'message', role: 'system', status: 'completed', content: [{ type: 'input_text',
          text: `ligou.website_stream_${purpose}:${JSON.stringify(data)}` }] } });
      return true;
    } catch { fail(error('canal de controle indisponível')); return false; }
  }
  function stop() {
    if (controller.signal.aborted) return;
    output(false); microphone(false); report('stopped');
    active?.stopProbe?.(); clearTimeout(active?.drainTimer); clearTimeout(active?.clearTimer); active?.reject?.(error('sessão encerrada')); pending = null;
    controller.abort(); signal?.removeEventListener('abort', stop);
  }
  function fail(reason) {
    if (failed || controller.signal.aborted) return;
    failed = true; stop(); onFailure?.(reason);
  }
  function bounded(operation, timeout = controlTimeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false, timer;
      const finish = (reason, value) => { if (done) return; done = true; clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort); reason ? reject(reason) : resolve(value); };
      const abort = () => finish(error('sessão encerrada'));
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) { abort(); return; }
      if (timeout !== null) timer = setTimeout(() => finish(error('streaming excedeu o tempo')), timeout);
      Promise.resolve().then(operation).then(value => finish(null, value), reason => finish(reason));
    });
  }
  function releaseNext() {
    if (controller.signal.aborted || active || callerItems.size || !pending) return;
    const next = pending; pending = null; enqueue(next);
  }
  async function run(descriptor, boot, playbackReady) {
    const current = { auth: descriptor, responseId: null, done: null, bufferStart: null, bufferStop: null,
      interrupted: false, ready: false, sampleCount: 0, firstSample: null, lastSample: null, startedAt: null };
    active = current; report('loading'); output(false); microphone(false);
    try {
      if (boot && playbackReady) await bounded(() => playbackReady, null);
      const auth = boot ? descriptor : await bounded(async () => {
        const value = await readStream(descriptor.action.actionId, descriptor.dispatchId, controller.signal);
        if (value === null) return null;
        const checked = validateWebsiteStream(value, { callId, interviewId });
        if (!same(checked, descriptor)) throw error('autorização de streaming desatualizada');
        return checked;
      });
      if (!auth) { seen.add(descriptor.dispatchId); return; }
      if (auth.action.revision < lastRevision) throw error('revisão de streaming desatualizada');
      await bounded(() => prepareOutput(controller.signal));
      if (!safeVad) await bounded(() => new Promise(resolve => { vadReady = resolve; }));
      if (controller.signal.aborted) throw error('sessão encerrada');
      current.auth = auth; current.startedAt = now(); seen.add(auth.dispatchId);
      const completion = bounded(() => new Promise((resolve, reject) => {
        current.resolve = resolve; current.reject = reject;
        current.ready = true; report('waiting-response'); microphone(!CLOSED_INPUT.has(auth.action.kind));
        mark('speech_play_requested');
        control('ready', { actionId: auth.action.actionId, dispatchId: auth.dispatchId });
      }), 180_000);
      await completion;
      if (!current.interrupted) lastRevision = auth.action.revision;
    } catch (reason) {
      if (!current.interrupted && !controller.signal.aborted) fail(reason);
      if (!current.interrupted) throw reason;
    } finally {
      current.stopProbe?.(); clearTimeout(current.drainTimer); clearTimeout(current.clearTimer);
      if (active === current) active = null;
      if (!controller.signal.aborted) {
        report(callerItems.size ? 'owner-speaking' : 'idle'); microphone(safeVad && !CLOSED_INPUT.has(current.auth.action.kind));
        releaseNext();
      }
    }
  }
  function enqueue(value, boot = false, playbackReady) {
    if (controller.signal.aborted) return task;
    let descriptor;
    try { descriptor = validateWebsiteStream(value, { callId, interviewId }); }
    catch (reason) { fail(reason); return task; }
    if (seen.has(descriptor.dispatchId) || active?.auth.dispatchId === descriptor.dispatchId) return task;
    if (active || callerItems.size) {
      if (pending && !same(pending, descriptor)) fail(error('mais de uma fala pendente'));
      else pending = descriptor;
      return task;
    }
    task = run(descriptor, boot, playbackReady); task.catch(() => {}); return task;
  }
  function matchesMetadata(metadata, auth) {
    return metadata?.ligou_transport === 'realtime_stream_v1' && metadata.ligou_call_id === callId
      && metadata.ligou_action_id === auth.action.actionId && metadata.ligou_source_digest === auth.action.sourceDigest
      && metadata.ligou_dispatch_id === auth.dispatchId;
  }
  function sample(current, value) {
    if (active !== current || current.interrupted || current.clearPending || !current.bufferStart
      || value?.unmuted !== true || value?.playbackStarted !== true
      || !Number.isSafeInteger(value.nonzeroSamples) || value.nonzeroSamples < 1
      || !Number.isFinite(value.atMs) || value.atMs < 0) return;
    current.sampleCount += value.nonzeroSamples;
    current.lastSample = value.atMs;
    if (current.firstSample === null) { current.firstSample = value.atMs; mark('speech_first_nonzero_sample', { evidence: 'remote_webrtc_media' }); }
  }
  function tryPlayed() {
    const current = active;
    if (!current || current.interrupted || current.clearPending || !current.done || !current.bufferStop) return;
    if (!current.bufferStart || (current.sampleCount > 0 && current.lastSample < current.firstSample)) {
      fail(error('reprodução do streaming não comprovada')); return;
    }
    // The provider stop describes its server buffer, not the browser's jitter
    // buffer. Keep this rendition audible until its actual received tail is quiet.
    if (!outputIsActive?.()) { fail(error('saída de áudio foi silenciada')); return; }
    const remainingMs = 2_000 - (now() - current.bufferStoppedAt);
    if (remainingMs <= 0) {
      fail(error(current.sampleCount ? 'buffer local não terminou' : 'reprodução do streaming não comprovada')); return;
    }
    // Data-channel completion can precede the first local RTP sample. The same
    // bounded drain window must cover that arrival, without claiming silent audio.
    const quietFor = current.sampleCount ? now() - Math.max(current.bufferStoppedAt, current.lastSample) : 0;
    const recheckMs = current.sampleCount ? 120 - quietFor : 25;
    if (recheckMs > 0) {
      if (!current.drainTimer) current.drainTimer = setTimeout(() => {
        current.drainTimer = null;
        if (active === current && !current.interrupted) tryPlayed();
      }, Math.max(1, Math.min(recheckMs, remainingMs)));
      return;
    }
    const observedMs = now() - current.startedAt;
    if (!Number.isFinite(observedMs) || observedMs < 0 || observedMs > 180_000) { fail(error('tempo de reprodução divergente')); return; }
    output(false); current.stopProbe?.();
    report('ack_pending'); mark('speech_ended', { evidence: 'webrtc_buffer_stop_and_local_media_drained' });
    if (!control('played', { actionId: current.auth.action.actionId, dispatchId: current.auth.dispatchId,
      responseId: current.responseId, itemId: current.done.itemId, bufferStoppedEventId: current.bufferStop,
      mediaEvidence: { schema: 'onboarding.stream.media.v1', nonzeroSamples: current.sampleCount, observedMs,
        firstSampleAtMs: current.firstSample, lastSampleAtMs: current.lastSample, unmuted: true, playbackStarted: true } })) return;
    onCaption?.({ kind: 'agent', text: current.done.transcript });
    retiredResponses.add(current.responseId); current.resolve();
  }
  function handleEvent(event) {
    if (controller.signal.aborted) return;
    if (event?.type === 'session.updated') {
      const detection = event.session?.audio?.input?.turn_detection;
      safeVad = event.session?.output_modalities?.length === 1 && event.session.output_modalities[0] === 'text'
        && (!event.session.tools || event.session.tools.length === 0) && detection?.type === 'semantic_vad'
        && detection.eagerness === 'low' && detection.create_response === false && detection.interrupt_response === false;
      if (!safeVad) fail(error('modo de voz divergente'));
      else { vadReady?.(); vadReady = null; }
      return;
    }
    if (event?.type === 'input_audio_buffer.speech_started' && listening && ID.test(event.item_id ?? '')) {
      callerItems.add(event.item_id);
      if (active?.ready && !active.interrupted) {
        active.interrupted = true; output(false); active.stopProbe?.(); clearTimeout(active.drainTimer); clearTimeout(active.clearTimer);
        retiredDispatches.add(active.auth.dispatchId);
        if (active.responseId) retiredResponses.add(active.responseId);
        mark('speech_interrupted', { evidence: 'owner_speech_started' });
        if (!control('interrupted', { actionId: active.auth.action.actionId, dispatchId: active.auth.dispatchId,
          responseId: active.responseId, providerItemId: event.item_id })) return;
        active.resolve?.(); report('owner-speaking');
      }
      return;
    }
    if (['conversation.item.input_audio_transcription.completed','conversation.item.input_audio_transcription.failed'].includes(event?.type)
      && callerItems.has(event.item_id)) {
      callerItems.delete(event.item_id);
      if (event.type === 'conversation.item.input_audio_transcription.completed' && typeof event.transcript === 'string' && event.transcript.trim())
        onCaption?.({ kind: 'caller', text: event.transcript });
      if (!active) report('processing'); microphone(safeVad); releaseNext(); return;
    }
    if (['conversation.item.created','conversation.item.done','conversation.item.retrieved'].includes(event?.type)) {
      const item = event.item;
      if (item?.type !== 'message' || item.role !== 'system' || item.status !== 'completed'
        || item.content?.length !== 1 || item.content[0]?.type !== 'input_text') return;
      const text = item.content[0].text;
      if (typeof text !== 'string') return;
      if (text.startsWith('ligou.website_stream:')) {
        try { const descriptor = validateWebsiteStream(JSON.parse(text.slice('ligou.website_stream:'.length)), { callId, interviewId });
          if (item.id === `lsn-${suffix(descriptor.dispatchId)}`) enqueue(descriptor);
        } catch { /* A notice is only a hint; the authenticated read owns authority. */ }
      } else if (text.startsWith('ligou.website_stream_retire:')) {
        try { const value = JSON.parse(text.slice('ligou.website_stream_retire:'.length)), current = active;
          if (!exact(value, ['actionId','dispatchId','responseId','generationReceiptId','reason'])
            || !current?.ready || current.interrupted || value.actionId !== current.auth.action.actionId
            || value.dispatchId !== current.auth.dispatchId || !ID.test(value.responseId ?? '')
            || (current.responseId && value.responseId !== current.responseId) || !UUID.test(value.generationReceiptId)
            || value.reason !== 'transcript_mismatch' || item.id !== `lsd-${suffix(current.auth.dispatchId)}`) return;
          current.interrupted = true; output(false); current.stopProbe?.();
          clearTimeout(current.drainTimer); clearTimeout(current.clearTimer);
          retiredDispatches.add(current.auth.dispatchId); retiredResponses.add(value.responseId);
          mark('speech_retired', { evidence: 'application_transcript_rejection' });
          current.resolve?.();
        } catch { /* Unmatched retirement cannot release an unexplained clear. */ }
      } else if (text.startsWith('ligou.website_progress:')) {
        try { const value = JSON.parse(text.slice('ligou.website_progress:'.length));
          if (exact(value, ['requestId','stage']) && UUID.test(value.requestId) && value.stage === 'retrying'
            && item.id === `lsp-${value.requestId.slice(0, 28)}`) onProgress?.({ stage: 'retrying' });
        } catch { /* Progress cannot authorize speech. */ }
      }
      return;
    }
    const responseId = event?.response?.id ?? event?.response_id;
    if (retiredResponses.has(responseId)) return;
    if (event?.response?.metadata?.ligou_transport === 'realtime_stream_v1'
      && retiredDispatches.has(event.response.metadata.ligou_dispatch_id)) {
      if (ID.test(responseId ?? '')) retiredResponses.add(responseId);
      return;
    }
    if (event?.type === 'response.created') {
      const response = event.response, streamIntent = response?.metadata?.ligou_transport === 'realtime_stream_v1';
      if (!streamIntent && !response?.output_modalities?.includes('audio')) return;
      if (!active?.ready || active.interrupted || !ID.test(responseId ?? '') || !matchesMetadata(response.metadata, active.auth)
        || (active.responseId && active.responseId !== responseId)) { fail(error('resposta de streaming não autorizada')); return; }
      if (active.responseId === responseId) return;
      active.responseId = responseId;
      // The response identity precedes its audio. Never wait for response.done
      // to open the remote output or the beginning of the sentence is lost.
      output(true);
      const rendition = active;
      active.stopProbe = observeMedia(value => sample(rendition, value), reason => {
        if (active === rendition && !rendition.interrupted) fail(error(reason));
      });
      return;
    }
    if (event?.type === 'output_audio_buffer.started') {
      if (!active || active.interrupted || active.responseId !== responseId || !ID.test(event.event_id ?? '')) {
        fail(error('buffer de áudio não autorizado')); return;
      }
      if (active.bufferStart && active.bufferStart !== event.event_id) { fail(error('buffer de áudio concorrente')); return; }
      active.bufferStart = event.event_id; report('playing'); mark('speech_playing', { evidence: 'webrtc_output_buffer_started' }); return;
    }
    if (!active || active.responseId !== responseId || active.interrupted) return;
    if (event.type === 'output_audio_buffer.cleared') {
      if (!ID.test(event.event_id ?? '')) { fail(error('limpeza do buffer inválida')); return; }
      // Provider buffer and conversation events may cross in transit. Silence
      // immediately, then allow a bounded match to the application's retirement.
      // Duplicate clears cannot extend this deadline or earn a played receipt.
      if (!active.clearPending) {
        const current = active; current.clearPending = true; output(false); current.stopProbe?.(); clearTimeout(current.drainTimer);
        current.clearTimer = setTimeout(() => {
          if (active === current && !current.interrupted) fail(error('buffer de áudio descartado'));
        }, 3_000);
      }
      return;
    }
    if (active.clearPending) return;
    if (event.type === 'output_audio_buffer.stopped') {
      if (!ID.test(event.event_id ?? '')) { fail(error('fim do buffer inválido')); return; }
      if (active.bufferStop) return;
      if (!outputIsActive?.()) { fail(error('saída de áudio foi silenciada')); return; }
      active.bufferStop = event.event_id; active.bufferStoppedAt = now();
      mark('speech_provider_buffer_stopped', { evidence: 'webrtc_output_buffer_stopped' }); tryPlayed(); return;
    }
    if (event.type === 'response.done') {
      const response = event.response, item = response.output?.[0], content = item?.content?.[0];
      if (response.status !== 'completed' || !matchesMetadata(response.metadata, active.auth)
        || response.output?.length !== 1 || item?.type !== 'message' || item.role !== 'assistant'
        || item.status !== 'completed' || !ID.test(item.id ?? '') || item.content?.length !== 1
        || !['audio','output_audio'].includes(content?.type) || typeof content.transcript !== 'string'
        || !content.transcript.trim() || [...content.transcript].length > 8192) {
        fail(error('geração de streaming incompleta')); return;
      }
      active.done = { itemId: item.id, transcript: content.transcript }; tryPlayed();
    }
  }
  output(false); microphone(false);
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  return { start: (descriptor, playbackReady) => enqueue(descriptor, true, playbackReady), handleEvent, stop, idle: () => task };
}
