const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = ['schema','actionId','interviewId','callId','revision','kind','text','sourceDigest',
  'text_sha256','audio_base64','audio_sha256','mime','voice','tts_model','cost_usd'];
const QUESTIONS = new Set(['ASK_NEXT_GAP','CLARIFY_CURRENT_GAP','CONFIRM_AND_ASK_NEXT',
  'DEFER_OFF_SCOPE_AND_CONTINUE','REQUEST_FINAL_APPROVAL','HANDLE_OWNER_CORRECTION']);
const KINDS = new Set([...QUESTIONS,'GENERATE_FINAL_SUMMARY','SPEAK_FINAL_SIGNOFF','SPEAK_TERMINAL_ERROR','SPEAK_AMENDMENT_SIGNOFF']);
const SIGNOFF = 'Perfeito. Seu onboarding foi concluído e suas informações foram salvas. Até logo.';
const error = detail => new Error(`Fala segura do onboarding: ${detail}`);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value);
async function sha(bytes) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export async function validateWebsiteSpeech(value, { callId, interviewId, actionId }) {
  if (!exact(value,KEYS) || value.schema!=='onboarding.speech.v1'
    || !UUID.test(value.callId) || !UUID.test(value.interviewId)
    || value.callId!==callId || value.interviewId!==interviewId || value.actionId!==actionId
    || !HASH.test(value.actionId) || !HASH.test(value.sourceDigest)
    || !HASH.test(value.text_sha256) || !HASH.test(value.audio_sha256)
    || !Number.isSafeInteger(value.revision) || value.revision<0 || !KINDS.has(value.kind)
    || typeof value.text!=='string' || !value.text.trim() || [...value.text].length>4096
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)
    || value.mime!=='audio/mpeg' || value.voice!=='ash' || value.tts_model!=='tts-1-hd'
    || value.cost_usd!==Number(([...value.text].length*30/1e6).toFixed(8))
    || (value.kind==='SPEAK_FINAL_SIGNOFF' && value.text!==SIGNOFF)
    || typeof value.audio_base64!=='string' || value.audio_base64.length>2_000_000
    || value.audio_base64.length<4 || value.audio_base64.length%4!==0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.audio_base64)) throw error('contrato divergente');
  // The authenticated speech RPC binds this exact attribution to the stored
  // next action. Continue checking everything the agent says outside the quote.
  const agentWords=value.kind==='CONFIRM_AND_ASK_NEXT'
    ?value.text.replace(/^Registrado\. Você informou: “[^“”"<>\x00-\x1f\x7f]{1,480}”\. /u,'Registrado. '):value.text;
  const normalized=agentWords.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ');
  if (value.kind!=='GENERATE_FINAL_SUMMARY' && /\bposso (?:te )?ajudar\b|\btem mais alguma coisa\b|\bo que mais voce gostaria\b|\be so me chamar\b/.test(normalized))
    throw error('fala fora do escopo');
  const binary=atob(value.audio_base64);
  if (btoa(binary)!==value.audio_base64 || binary.length>1_500_000 || binary.length<4) throw error('áudio inválido');
  const audioBytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
  const mp3=(audioBytes[0]===0x49 && audioBytes[1]===0x44 && audioBytes[2]===0x33)
    || (audioBytes[0]===0xff && (audioBytes[1]&0xe0)===0xe0 && (audioBytes[1]&0x06)!==0
      && (audioBytes[2]&0xf0)!==0xf0 && (audioBytes[2]&0x0c)!==0x0c);
  const [textHash,audioHash]=await Promise.all([sha(new TextEncoder().encode(value.text)),sha(audioBytes)]);
  if (!mp3 || textHash!==value.text_sha256 || audioHash!==value.audio_sha256) throw error('hash de áudio ou texto divergente');
  return {payload:Object.freeze({...value}),audioBytes};
}

/** Application audio only. Provider messages can acknowledge an exact played
 * item, but can never supply audible text. Notice IDs are authenticated-read
 * hints; hashes alone do not prove a notice is current. */
export function createWebsiteSpeechPlayer({ callId, interviewId, readSpeech, play, send,
  setMicrophone, onCaption, onFailure, onPhase, onProgress, controlTimeoutMs=15_000, signal }) {
  if (!UUID.test(callId) || !UUID.test(interviewId) || !Number.isSafeInteger(controlTimeoutMs)
    || controlTimeoutMs<1 || controlTimeoutMs>30_000) throw error('configuração inválida');
  const controller=new AbortController(), seen=new Set(), callerItems=new Set();
  let phase='idle',active=null,pending=null,lastRevision=-1,task=Promise.resolve(),ack=null;
  let safeVad=false,vadReady=null,listening=false,failed=false,rendition=null;
  const reportPhase=value=>{try{onPhase?.(value);}catch{/* Display cannot change custody. */}};
  const microphone=enabled=>{listening=enabled && phase!=='stopped';setMicrophone(listening);};
  const live=()=>{if(controller.signal.aborted || phase==='stopped')throw error('sessão encerrada');};
  function stop() {
    if(phase==='stopped')return;
    phase='stopped';pending=null;microphone(false);controller.abort();
    signal?.removeEventListener('abort',stop);
  }
  function fail(reason) {
    if(failed || phase==='stopped')return;
    failed=true;stop();onFailure?.(reason);
  }
  function bounded(operation, timeout=controlTimeoutMs) {
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(reason,value)=>{if(done)return;done=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);reason?reject(reason):resolve(value);};
      const abort=()=>finish(error('sessão encerrada'));
      const timer=setTimeout(()=>finish(error('confirmação excedeu o tempo')),timeout);
      controller.signal.addEventListener('abort',abort,{once:true});
      if(controller.signal.aborted){abort();return;}
      Promise.resolve().then(operation).then(value=>finish(null,value),reason=>finish(reason));
    });
  }
  async function run(actionId,boot) {
    live();phase='loading';reportPhase(phase);active={actionId};microphone(false);
    const currentRendition={controller:new AbortController(),interrupted:false};rendition=currentRendition;
    try {
      const checked=await bounded(async()=>{
        const value=await readSpeech(actionId,controller.signal);
        if(value===null && !boot)return null;
        return validateWebsiteSpeech(value,{callId,interviewId,actionId});
      });
      if(!checked){live();seen.add(actionId);active=null;phase='idle';reportPhase('processing');microphone(safeVad);return;}
      live();const p=checked.payload;
      if ((boot && canonical(p)!==canonical(boot)) || p.revision<lastRevision) throw error('fala desatualizada');
      active=p;seen.add(actionId);phase='playing';reportPhase(phase);
      microphone(safeVad && !['SPEAK_TERMINAL_ERROR','SPEAK_AMENDMENT_SIGNOFF'].includes(p.kind));
      await bounded(()=>play(checked.audioBytes,AbortSignal.any([controller.signal,currentRendition.controller.signal]),p),180_000);live();
      if(currentRendition.interrupted)return;
      phase='ack_pending';reportPhase(phase);
      const acknowledged=bounded(()=>new Promise((resolve,reject)=>{ack={resolve,reject};
        send({type:'conversation.item.create',item:{id:`lgs-${actionId.slice(0,28)}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:p.text}]}});
      }));
      await acknowledged;ack=null;live();
      if(!safeVad)await bounded(()=>new Promise(resolve=>{vadReady=resolve;}));
      vadReady=null;live();lastRevision=p.revision;
      onCaption?.({kind:'agent',text:p.text});active=null;phase='idle';reportPhase(phase);
      const next=pending;pending=null;
      if(next && !seen.has(next))await run(next);
      else microphone(!['SPEAK_TERMINAL_ERROR','SPEAK_AMENDMENT_SIGNOFF'].includes(p.kind));
    }catch(reason){
      ack=null;vadReady=null;
      if(currentRendition.interrupted && !controller.signal.aborted){
        active=null;phase='idle';reportPhase('owner-speaking');microphone(safeVad);return;
      }
      fail(reason);throw reason;
    }finally{
      if(rendition===currentRendition)rendition=null;
      if(phase==='idle' && !callerItems.size && pending){const next=pending;pending=null;enqueue(next);}
    }
  }
  function enqueue(actionId,boot) {
    if(phase==='stopped' || seen.has(actionId) || active?.actionId===actionId)return task;
    if(phase!=='idle' || callerItems.size>0){
      if(pending && pending!==actionId){fail(error('mais de uma fala pendente'));return task;}
      pending=actionId;return task;
    }
    // Set loading synchronously; duplicate provider created/done cannot start a second read.
    phase='loading';active={actionId};task=run(actionId,boot);task.catch(()=>{});return task;
  }
  function handleEvent(event) {
    if(phase==='stopped')return;
    if(event?.type==='session.updated'){
      const d=event.session?.audio?.input?.turn_detection;
      safeVad=event.session?.output_modalities?.length===1 && event.session.output_modalities[0]==='text'
        && d?.type==='semantic_vad' && d.eagerness==='low' && d.create_response===false && d.interrupt_response===false;
      if(!safeVad)fail(error('modo de voz divergente'));else{
        vadReady?.();
        if(phase==='playing' && !['SPEAK_TERMINAL_ERROR','SPEAK_AMENDMENT_SIGNOFF'].includes(active?.kind))microphone(true);
      }
      return;
    }
    if(event?.type==='input_audio_buffer.speech_started' && listening && typeof event.item_id==='string'){
      callerItems.add(event.item_id);
      if(rendition && ['playing','ack_pending'].includes(phase)){
        rendition.interrupted=true;rendition.controller.abort();ack?.reject(error('fala interrompida pelo dono'));
        reportPhase('owner-speaking');
      }
    }
    if(['conversation.item.input_audio_transcription.completed','conversation.item.input_audio_transcription.failed'].includes(event?.type)
      && callerItems.has(event.item_id)){
      callerItems.delete(event.item_id);
      if(event.type==='conversation.item.input_audio_transcription.failed'){
        // Failed ASR ends this input item's wait without inventing an answer.
        // The controller owns recovery/termination; its notice must be able to play.
        reportPhase('processing');microphone(safeVad);
      }
      // Empty successful ASR has no authoritative owner turn. The controller
      // keeps this question current, so the browser must keep listening too.
      if(event.type==='conversation.item.input_audio_transcription.completed' && typeof event.transcript==='string' && event.transcript.trim()){
        reportPhase('processing');microphone(safeVad);onCaption?.({kind:'caller',text:event.transcript});
      }
      if(!callerItems.size && pending && phase==='idle'){const next=pending;pending=null;enqueue(next);}
      return;
    }
    if(!['conversation.item.created','conversation.item.done','conversation.item.retrieved'].includes(event?.type))return;
    const item=event.item;
    if(item?.type!=='message' || item.status!=='completed' || !Array.isArray(item.content) || item.content.length!==1)return;
    if(item.role==='assistant' && active && item.id===`lgs-${active.actionId.slice(0,28)}` && phase==='ack_pending'){
      if(item.content[0]?.type==='output_text' && item.content[0].text===active.text)ack?.resolve();
      else ack?.reject(error('confirmação de fala divergente'));
      return;
    }
    if(item.role!=='system' || item.content[0]?.type!=='input_text')return;
    if(item.content[0].text?.startsWith('ligou.website_progress:')) {
      try {
        const progress=JSON.parse(item.content[0].text.slice('ligou.website_progress:'.length));
        if(exact(progress,['requestId','stage']) && UUID.test(progress.requestId)
          && progress.stage==='retrying' && item.id===`lsp-${progress.requestId.slice(0,28)}`)
          onProgress?.({stage:'retrying'});
      }catch{/* Progress is display-only and cannot authorize audio or a write. */}
      return;
    }
    const match=/^ligou\.website_speech:([0-9a-f]{64})$/.exec(item.content[0].text);
    if(match && item.id===`lsn-${match[1].slice(0,28)}`)enqueue(match[1]);
  }
  signal?.addEventListener('abort',stop,{once:true});
  if(signal?.aborted)stop();else microphone(false);
  return {start:p=>enqueue(p.actionId,p),handleEvent,stop,idle:()=>task};
}
