export const ACTIVE_STATES = new Set(['requesting_microphone', 'connecting', 'listening', 'speaking', 'reconnecting', 'ending', 'ending_unconfirmed']);

/** One bridge owns the conversation for every landing-page CTA. UI visibility
 * is independent from the microphone and server admission lifecycle. */
export function createVoiceBridge({loadClient, endpoint, emit}) {
  let session = null, busy = false, version = 0, ending = null, state = 'idle';
  const update = patch => {if (patch.state) state = patch.state; emit(patch);};
  return {
    async start() {
      update({expanded:true});
      if (busy || ending) return;
      busy = true;
      const current = ++version;
      update({state:'connecting',error:null,muted:false,elapsed:0,captions:[],audioBlocked:false,providerTerminationState:null,diagnostic:{code:null}});
      try {
        const {createSalesVoiceSession} = await loadClient();
        if (current !== version) return;
        session = createSalesVoiceSession({endpoint,
          onState(next, detail) {
            if (current !== version) return;
            busy = ACTIVE_STATES.has(next);
            update({state:next,...(detail?.providerTerminationState ? {providerTerminationState:detail.providerTerminationState} : {}),...(next === 'ended' ? {error:null} : {})});
          },
          onCaption(caption) {if (current === version) update({caption});},
          onElapsed(elapsed) {if (current === version) update({elapsed});},
          onInputLevel(inputLevel) {if (current === version) update({inputLevel});},
          onMicrophones(microphones) {if (current === version) update({microphones});},
          onDiagnostic(diagnostic) {if (current === version) update({diagnostic});},
          onError(error) {
            if (current !== version) return;
            update({error:error.message || 'Não foi possível conectar. Tente novamente.',...(error.code === 'audio_blocked' ? {audioBlocked:true} : {})});
          },
        });
        await session.start();
      } catch (error) {
        if (current !== version) return;
        // The client can reject startup while still holding an admission whose
        // termination is unknown. A new CTA cannot bypass that state.
        const pending = session?.getState() === 'ending_unconfirmed';
        busy = pending;
        update({state:pending ? 'ending_unconfirmed' : 'error',error:error.message || 'Não foi possível iniciar a conversa.'});
      }
    },
    async end() {
      if (ending) return ending;
      if (!session) {++version; busy = false; update({state:'ended',muted:false}); return;}
      busy = true; update({state:'ending',muted:true});
      const currentSession = session;
      ending = (async () => {
        try {
          const result = await currentSession.end();
          const resolved = result?.resolved === true || result?.confirmed === true || currentSession.getState() === 'ended';
          busy = !resolved;
          update({state:resolved ? 'ended' : 'ending_unconfirmed',muted:false,...(result?.providerTerminationState ? {providerTerminationState:result.providerTerminationState} : {}),...(resolved ? {error:null} : {})});
        } catch (error) {
          busy = true;
          update({state:'ending_unconfirmed',error:error.message || 'Seu microfone está desligado. Ainda aguardamos a confirmação do encerramento.'});
        } finally {ending = null;}
      })();
      return ending;
    },
    async resumeAudio() {
      if (!session) return;
      try {await session.resumeAudio(); update({audioBlocked:false,error:null});}
      catch {update({audioBlocked:true,error:'Toque em Ouvir áudio para tentar novamente.'});}
    },
    setMuted(value) {
      if (!session || !['listening','speaking','reconnecting'].includes(state)) return;
      session.setMuted(!!value); update({muted:!!value});
    },
    async selectMicrophone(deviceId) {if (session && ['listening','speaking','reconnecting'].includes(state)) await session.selectMicrophone(deviceId);},
  };
}
