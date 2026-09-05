const ACTIVE_KEY = 'ligou.sales.active.v1';
const VISITOR_KEY = 'ligou.sales.visitor.v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const terminal = new Set(['ended', 'error', 'quarantined']);
// These explicit admission errors are returned before the server creates a call.
// They are safe to release only when no earlier start attempt was ambiguous.
const rejectedAdmission = new Set(['sales_disabled','disabled','global_busy','concurrency_limit','visitor_limit','network_limit','daily_limit','daily_budget','runtime_unavailable','network_unavailable','origin_not_allowed','capability_required','invalid_request','request_too_large']);
const messages = {
  not_configured: 'A conversa ainda não está disponível nesta prévia. Tente novamente em breve.',
  microphone_denied: 'Permita o microfone nas configurações do navegador e tente novamente.',
  microphone_missing: 'Não encontramos um microfone. Conecte um e tente novamente.',
  microphone_busy: 'O microfone está sendo usado por outro aplicativo. Libere-o e tente novamente.',
  microphone_timeout: 'A permissão do microfone não foi concluída. Libere o microfone no navegador e tente novamente.',
  microphone_switch_failed: 'Não foi possível usar esse microfone. A entrada anterior continua selecionada.',
  unsupported_browser: 'Este navegador não oferece chamada por voz. Abra a página em um navegador atualizado.',
  daily_budget: 'O limite de conversas de hoje foi atingido. Você pode voltar amanhã.',
  global_busy: 'O Ligou está em outra conversa. Tente novamente em alguns instantes.',
  sales_disabled: 'A conversa está temporariamente indisponível. Tente novamente em breve.',
  daily_limit: 'O limite de conversas de hoje foi atingido. Você pode voltar amanhã.',
  visitor_limit: 'Você já fez as conversas disponíveis para hoje. Volte amanhã para continuar.',
  network_limit: 'O limite de conversas desta rede foi atingido hoje. Tente novamente amanhã.',
  concurrency_limit: 'O Ligou está em outra conversa. Tente novamente em alguns instantes.',
  runtime_unavailable: 'O Ligou está temporariamente indisponível. Tente novamente em alguns instantes.',
  network_unavailable: 'A conversa está temporariamente indisponível. Tente novamente em alguns instantes.',
  disabled: 'A conversa está temporariamente indisponível. Tente novamente em breve.',
  connection_failed: 'A conexão de voz foi interrompida. Você pode iniciar uma nova conversa.',
  connection_timeout: 'A conexão demorou mais do que o esperado. Tente novamente.',
  invalid_response: 'Não foi possível conectar a chamada. Tente novamente.',
  network_error: 'Não foi possível conectar. Confira sua internet e tente novamente.',
  ending_unconfirmed: 'Seu microfone foi desligado. A confirmação do encerramento ainda está pendente.',
  audio_blocked: 'O navegador bloqueou o áudio. Toque em “Ouvir áudio” para continuar.',
};

function errorWithCode(code) {
  const error = new Error(messages[code] || 'Não foi possível completar a conversa. Tente novamente.');
  error.code = code; return error;
}

function endpointUrl(value, base) {
  try {
    if (!value || typeof value !== 'string') throw new Error();
    const url = new URL(value, base);
    if (url.username || url.password || url.hash || url.search) throw new Error();
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
    return url.toString();
  } catch { throw errorWithCode('not_configured'); }
}

function randomToken(crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let token = '', bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 6) { bits -= 6; token += alphabet[(value >>> bits) & 63]; }
  }
  if (bits) token += alphabet[(value << (6 - bits)) & 63];
  return token;
}

/** Owns one browser conversation. The environment is injectable at external
 * boundaries so tests exercise real lifecycle code without microphone/provider. */
export function createSalesVoiceSession(options = {}, environment = globalThis) {
  const env = environment;
  let state = 'idle', peer = null, channel = null, stream = null, audio = null;
  let sessionId = null, token = null, endpoint = '', startPromise = null, endPromise = null;
  let cancelled = false, clock = null, statusClock = null, reconnectClock = null;
  let startedAt = 0, maxSeconds = 300, polling = false, failConnection = null;
  let disconnectHandler = null, connectionAcknowledged = false, rtcConnected = false;
  let cancelCapture = null, unresolvedPrevious = false, switchingMicrophone = false;
  let audioContext = null, meterClock = null, meterSource = null, isMuted = false;
  let providerTerminationState = null;
  const partials = new Map();
  const emit = (next, detail) => { state = next; if (detail?.providerTerminationState) providerTerminationState = detail.providerTerminationState; options.onState?.(next, detail); };
  const report = (error) => options.onError?.({code:error.code || 'network_error',message:error.message || messages.network_error});
  const delay = ms => new Promise(resolve => env.setTimeout(resolve, ms));
  const active = () => !cancelled && !['ended','error','ending','ending_unconfirmed'].includes(state);
  function stored(key, storage = env.sessionStorage) { try { return storage?.getItem(key); } catch { return null; } }
  function store(key, value, storage = env.sessionStorage) { try { storage?.setItem(key,value); } catch {} }
  function forget(id = sessionId, capability = token) {
    try { const current = JSON.parse(stored(ACTIVE_KEY)); if (current?.id === id && current?.token === capability) env.sessionStorage?.removeItem(ACTIVE_KEY); } catch {}
  }
  const terminationResolved = result => (['ended','error'].includes(result.status) && ['confirmed','not_started'].includes(result.provider_termination_state)) || (result.status === 'ended' && result.provider_termination_state === 'expired');
  const terminationResult = (providerState = providerTerminationState || 'not_started') => ({resolved:true,confirmed:providerState !== 'expired',providerTerminationState:providerState});

  async function api(body, capability = token, keepalive = false, maxWaitMs = options.requestTimeoutMs || 12000) {
    const controller = new AbortController();
    const timeout = env.setTimeout(() => controller.abort(), Math.max(1,Math.min(maxWaitMs,options.requestTimeoutMs || 12000)));
    try {
      const response = await env.fetch(endpoint, {
        method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${capability}`},
        body:JSON.stringify(body),signal:controller.signal,cache:'no-store',...(keepalive?{keepalive:true}:{}),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = errorWithCode(typeof data?.error === 'string' ? data.error : 'network_error');
        error.explicitRejection = rejectedAdmission.has(error.code);
        throw error;
      }
      if (!data || typeof data.status !== 'string' || data.session_id !== (body.session_id || body.request_id)) throw errorWithCode('invalid_response');
      return data;
    } catch (error) {
      if (error.code) throw error;
      throw errorWithCode(error.name === 'AbortError' ? 'connection_timeout' : 'network_error');
    } finally { env.clearTimeout(timeout); }
  }

  async function requestTermination(id, capability, keepalive = false) {
    try {
      const until = env.Date.now() + (options.terminationTimeoutMs || 12000);
      let result = await api({action:'end',session_id:id},capability,keepalive,until - env.Date.now());
      while (!terminal.has(result.status) && env.Date.now() < until) {
        await delay(Math.min(options.pollIntervalMs || 500,Math.max(1,until - env.Date.now())));
        if (env.Date.now() >= until) break;
        result = await api({action:'status',session_id:id},capability,keepalive,until - env.Date.now());
      }
      if (!terminationResolved(result)) throw errorWithCode('ending_unconfirmed');
      return result;
    } catch { throw errorWithCode('ending_unconfirmed'); }
  }

  function watchPageExit() {
    disconnectHandler = () => { void end(true); };
    env.addEventListener?.('pagehide',disconnectHandler,{once:true});
  }

  function silenceLocal() {
    cancelCapture?.(); cancelCapture = null;
    stopMeter();
    if (clock) env.clearInterval(clock); clock = null;
    if (statusClock) env.clearInterval(statusClock); statusClock = null;
    if (reconnectClock) env.clearTimeout(reconnectClock); reconnectClock = null;
    stream?.getTracks().forEach(track => {track.enabled = false; track.stop();});
    if (audio) audio.pause();
  }

  function releaseLocal() {
    silenceLocal();
    if (disconnectHandler) env.removeEventListener?.('pagehide',disconnectHandler);
    disconnectHandler = null;
    if (channel) { channel.onmessage = null; try { channel.close(); } catch {} }
    if (peer) { peer.onconnectionstatechange = null; peer.ontrack = null; try { peer.close(); } catch {} }
    if (audio) { audio.pause(); audio.srcObject = null; }
    failConnection?.(); failConnection = null;
    partials.clear();
  }

  // A permissions prompt can remain unanswered indefinitely. Timeout/cancel the
  // local wait, then stop any stream the browser may grant after that point.
  function captureMicrophone(deviceId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) { value?.getTracks().forEach(track => track.stop()); return; }
        settled = true; env.clearTimeout(timer); cancelCapture = null;
        if (error) reject(error); else resolve(value);
      };
      const timer = env.setTimeout(() => finish(errorWithCode('microphone_timeout')), options.microphoneTimeoutMs || 45000);
      cancelCapture = () => finish(errorWithCode('microphone_timeout'));
      Promise.resolve().then(() => env.navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,...(deviceId ? {deviceId:{exact:deviceId}} : {})},video:false})).then(value => finish(null,value), error => finish(error));
    });
  }

  function stopMeter() {
    if (meterClock) env.clearInterval(meterClock); meterClock = null;
    try {meterSource?.disconnect();} catch {}
    meterSource = null;
    try {void audioContext?.close()?.catch(() => {});} catch {}
    audioContext = null; options.onInputLevel?.(0);
  }

  function startMeter() {
    stopMeter();
    const Context = env.AudioContext || env.webkitAudioContext;
    if (!Context || !stream) return;
    try {
      audioContext = new Context(); void audioContext.resume()?.catch(() => {});
      const analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
      meterSource = audioContext.createMediaStreamSource(stream); meterSource.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      meterClock = env.setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum,value) => sum + ((value - 128) / 128) ** 2,0) / samples.length);
        options.onInputLevel?.(isMuted ? 0 : Math.min(1,rms * 5));
      },150);
    } catch {stopMeter();}
  }

  async function reportMicrophones() {
    if (!env.navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await env.navigator.mediaDevices.enumerateDevices();
      if (cancelled) return;
      options.onMicrophones?.({devices:devices.filter(device => device.kind === 'audioinput' && device.deviceId).map((device,index) => ({id:device.deviceId,label:device.label || `Microfone ${index + 1}`})),selected:stream?.getAudioTracks()[0]?.getSettings?.().deviceId || ''});
    } catch { /* Voice still works when device enumeration is unavailable. */ }
  }

  async function selectMicrophone(deviceId) {
    if (!active() || !peer || switchingMicrophone || typeof deviceId !== 'string' || !deviceId) return;
    switchingMicrophone = true;
    let replacement;
    try {
      replacement = await captureMicrophone(deviceId);
      if (cancelled) return;
      const sender = peer.getSenders().find(item => item.track?.kind === 'audio');
      const track = replacement.getAudioTracks()[0];
      if (!sender || !track) throw new Error();
      track.enabled = !isMuted;
      await sender.replaceTrack(track);
      if (cancelled) return;
      stream?.getTracks().forEach(oldTrack => oldTrack.stop()); stream = replacement; replacement = null;
      startMeter(); await reportMicrophones();
    } catch {if (!cancelled) {report(errorWithCode('microphone_switch_failed')); await reportMicrophones();}}
    finally {replacement?.getTracks().forEach(track => track.stop()); switchingMicrophone = false;}
  }

  function receive(event) {
    if (!active()) return;
    let data; try { data = JSON.parse(event.data); } catch { return; }
    if (!data || typeof data !== 'object') return;
    const rawId = data.item_id || data.response_id;
    const id = typeof rawId === 'string' ? rawId : null;
    if (['conversation.item.created','conversation.item.added'].includes(data.type) && data.item?.role === 'system') {
      for (const part of Array.isArray(data.item.content) ? data.item.content : []) {
        if (!part) continue;
        if (part.type !== 'input_text' || typeof part.text !== 'string' || !part.text.startsWith('LIGOU_SALES_DIAGNOSTIC:')) continue;
        try {const diagnostic = JSON.parse(part.text.slice('LIGOU_SALES_DIAGNOSTIC:'.length)); if (['transcription_timeout','no_speech_detected'].includes(diagnostic.code)) options.onDiagnostic?.({code:diagnostic.code});} catch {}
      }
    }
    if (data.type === 'conversation.item.input_audio_transcription.completed' && typeof data.transcript === 'string' && data.transcript.trim() && id) {
      options.onDiagnostic?.({code:null});
      options.onCaption?.({id,role:'caller',text:data.transcript,final:true});
    }
    if (['response.output_audio_transcript.delta','response.audio_transcript.delta'].includes(data.type) && typeof data.delta === 'string' && id) {
      const text = ((partials.get(id) || '') + data.delta).slice(-8000);
      if (!partials.has(id) && partials.size >= 100) partials.delete(partials.keys().next().value);
      partials.set(id,text); options.onCaption?.({id,role:'agent',text,final:false});
    }
    if (['response.output_audio_transcript.done','response.audio_transcript.done'].includes(data.type) && typeof data.transcript === 'string' && id) {
      partials.delete(id); options.onCaption?.({id,role:'agent',text:data.transcript,final:true});
    }
    if (connectionAcknowledged && rtcConnected) {
      if (data.type === 'output_audio_buffer.started') emit('speaking');
      if (['output_audio_buffer.stopped','output_audio_buffer.cleared','input_audio_buffer.speech_started'].includes(data.type)) emit('listening');
    }
  }

  async function end(keepalive = false) {
    if (state === 'ended') return terminationResult();
    if (endPromise) return endPromise;
    cancelled = true; emit('ending'); silenceLocal();
    endPromise = (async () => {
      if (unresolvedPrevious) { report(errorWithCode('ending_unconfirmed')); emit('ending_unconfirmed'); return {confirmed:false}; }
      if (!sessionId || !endpoint) { emit('ended'); return terminationResult('not_started'); }
      try {
        const result = await requestTermination(sessionId,token,keepalive);
        forget(); emit('ended',{providerTerminationState:result.provider_termination_state});
        return terminationResult(result.provider_termination_state);
      } catch {
        report(errorWithCode('ending_unconfirmed')); emit('ending_unconfirmed',{providerTerminationState:'unknown'});
        // Keep the capability for a later explicit retry/reconciliation.
        return {confirmed:false};
      }
    })();
    try { return await endPromise; }
    finally { releaseLocal(); if (state === 'ending_unconfirmed') endPromise = null; }
  }

  async function pollActive() {
    if (polling || !active()) return;
    polling = true;
    try {
      const result = await api({action:'status',session_id:sessionId});
      if (cancelled) return;
      if (terminal.has(result.status)) {
        cancelled = true; releaseLocal();
        const confirmed = terminationResolved(result);
        if (confirmed) forget(); else report(errorWithCode('ending_unconfirmed'));
        if (result.status === 'error') report(errorWithCode(result.error || 'connection_failed'));
        emit(confirmed ? 'ended' : 'ending_unconfirmed',{providerTerminationState:result.provider_termination_state});
      } else if (result.status === 'ending') await end();
    } catch { /* A transient status fetch cannot create a second call. */ }
    finally { polling = false; }
  }

  async function runStart() {
    try {
      endpoint = endpointUrl(options.endpoint, env.location?.href);
      if (!env.navigator?.mediaDevices?.getUserMedia || !env.RTCPeerConnection || !env.crypto?.getRandomValues) throw errorWithCode('unsupported_browser');
      let previous; try { previous = JSON.parse(stored(ACTIVE_KEY)); } catch {}
      if (previous && UUID.test(previous.id) && TOKEN.test(previous.token)) {
        if (previous.endpoint !== endpoint) { unresolvedPrevious = true; throw errorWithCode('ending_unconfirmed'); }
        sessionId = previous.id; token = previous.token;
        emit('connecting');
        await requestTermination(previous.id,previous.token);
        forget(previous.id,previous.token);
        sessionId = null; token = null;
      }
      if (cancelled) return;
      emit('requesting_microphone');
      try { stream = await captureMicrophone(); }
      catch (e) {
        if (e.code) throw e;
        throw errorWithCode(e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'microphone_denied' : e.name === 'NotFoundError' ? 'microphone_missing' : 'microphone_busy');
      }
      if (cancelled) {stream?.getTracks().forEach(track => track.stop());return;}
      startMeter(); void reportMicrophones();
      emit('connecting');
      peer = new env.RTCPeerConnection();
      audio = new env.Audio(); audio.autoplay = true; audio.playsInline = true;
      peer.ontrack = event => {
        if (!active()) return;
        audio.srcObject = event.streams[0];
        Promise.resolve(audio.play()).catch(() => report(errorWithCode('audio_blocked')));
      };
      stream.getTracks().forEach(track => peer.addTrack(track,stream));
      channel = peer.createDataChannel('oai-events'); channel.onmessage = receive;
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (cancelled) return;
      sessionId = env.crypto.randomUUID(); token = randomToken(env.crypto);
      let visitorId = stored(VISITOR_KEY,env.localStorage);
      if (!UUID.test(visitorId || '')) { visitorId = env.crypto.randomUUID(); store(VISITOR_KEY,visitorId,env.localStorage); }
      store(ACTIVE_KEY,JSON.stringify({id:sessionId,token,endpoint}));
      watchPageExit();
      const payload = {action:'start',request_id:sessionId,visitor_id:visitorId,sdp:peer.localDescription.sdp};
      let result;
      try { result = await api(payload); }
      catch (e) {
        if (e.explicitRejection) {forget();sessionId = null;token = null;throw e;}
        if (!cancelled && ['network_error','connection_timeout'].includes(e.code)) result = await api(payload);
        else throw e;
      }
      if (cancelled) return;
      const deadline = env.Date.now() + 25000;
      while (['pending','starting'].includes(result.status)) {
        if (cancelled) return;
        if (env.Date.now() >= deadline) throw errorWithCode('connection_timeout');
        await delay(options.pollIntervalMs || 400);
        if (cancelled) return;
        result = await api({action:'status',session_id:sessionId});
      }
      if (cancelled) return;
      if (result.status !== 'ready' || typeof result.sdp !== 'string' || !result.sdp.startsWith('v=')) throw errorWithCode(result.error || 'invalid_response');
      maxSeconds = Number.isFinite(result.max_minutes) ? Math.min(result.max_minutes * 60,300) : 300;
      let connectionTimer;
      const connected = new Promise((resolve,reject) => {
        failConnection = () => { env.clearTimeout(connectionTimer); resolve(); };
        connectionTimer = env.setTimeout(() => reject(errorWithCode('connection_timeout')),12000);
        peer.onconnectionstatechange = () => {
          if (!active()) return;
          if (peer.connectionState === 'connected') {
            rtcConnected = true;
            env.clearTimeout(connectionTimer); failConnection = null;
            if (reconnectClock) env.clearTimeout(reconnectClock); reconnectClock = null;
            if (connectionAcknowledged) emit('listening');
            resolve();
          } else if (peer.connectionState === 'disconnected') {
            emit('reconnecting');
            if (!reconnectClock) reconnectClock = env.setTimeout(() => {report(errorWithCode('connection_failed'));void end();},7000);
          } else if (['failed','closed'].includes(peer.connectionState)) {
            env.clearTimeout(connectionTimer);
            reject(errorWithCode('connection_failed'));
            if (rtcConnected) { report(errorWithCode('connection_failed')); void end(); }
          }
        };
      });
      try { await peer.setRemoteDescription({type:'answer',sdp:result.sdp}); await connected; }
      finally { env.clearTimeout(connectionTimer); }
      if (cancelled) return;
      const acknowledgement = await api({action:'connected',session_id:sessionId});
      if (cancelled) return;
      if (acknowledgement.status !== 'ready') throw errorWithCode(acknowledgement.error || 'invalid_response');
      connectionAcknowledged = true; emit('listening');
      startedAt = env.Date.now();
      clock = env.setInterval(() => {
        const elapsed = Math.max(0,Math.floor((env.Date.now()-startedAt)/1000)); options.onElapsed?.(elapsed);
        if (elapsed >= maxSeconds) void end();
      },1000);
      statusClock = env.setInterval(() => {void pollActive();},3000);

    } catch (error) {
      if (cancelled) return;
      silenceLocal();
      let unconfirmed = error.code === 'ending_unconfirmed';
      if (sessionId && endpoint && !unconfirmed) {
        try { await requestTermination(sessionId,token); forget(); } catch { unconfirmed = true; report(errorWithCode('ending_unconfirmed')); }
      }
      releaseLocal();
      emit(unconfirmed ? 'ending_unconfirmed' : 'error'); report(error); throw error;
    }
  }

  function start() {
    if (startPromise) return startPromise;
    startPromise = runStart(); return startPromise;
  }
  return {
    start,end,getState:()=>state,
    selectMicrophone,
    setMuted(muted) { isMuted = !!muted; stream?.getAudioTracks().forEach(track => { track.enabled = !isMuted; }); },
    async resumeAudio() { if (audio) await audio.play(); },
  };
}
