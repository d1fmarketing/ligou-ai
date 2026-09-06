import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWebsiteSpeechPlayer, validateWebsiteSpeech } from '../src/voice/website-speech.js';

const callId = '11111111-1111-4111-8111-111111111111';
const hash = x => createHash('sha256').update(x).digest('hex');
function speech(label = 'primeira', kind = 'ASK_NEXT_GAP', revision = 0) {
  const text = kind === 'SPEAK_FINAL_SIGNOFF' ? 'Perfeito. Seu onboarding foi concluído e suas informações foram salvas. Até logo.' : `${label}. Qual a resposta?`;
  const bytes = Buffer.from('ID3sample-mp3');
  return { schema:'onboarding.speech.v1',actionId:hash(label),interviewId:callId,callId,revision,kind,text,
    sourceDigest:'b'.repeat(64),text_sha256:hash(text),audio_base64:bytes.toString('base64'),audio_sha256:hash(bytes),
    mime:'audio/mpeg',voice:'ash',tts_model:'tts-1-hd',cost_usd:Number(([...text].length*30/1e6).toFixed(8)) };
}
const vad = { type:'session.updated',session:{output_modalities:['text'],audio:{input:{turn_detection:{type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false}}}} };
const notice = p => ({ type:'conversation.item.created',item:{id:`lsn-${p.actionId.slice(0,28)}`,type:'message',role:'system',status:'completed',content:[{type:'input_text',text:`ligou.website_speech:${p.actionId}`}]}});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  const deadline=Date.now()+1000;
  while(!check()){assert.ok(Date.now()<deadline,'expected asynchronous state');await tick();}
}
function harness(payloads, { hold = false, ack = true, read } = {}) {
  const plays=[],sends=[],captions=[],mics=[],errors=[],reads=[];
  let finish;
  const player = createWebsiteSpeechPlayer({callId,interviewId:callId,controlTimeoutMs:50,
    readSpeech: async actionId => { reads.push(actionId); return read ? read(actionId) : payloads.find(p=>p.actionId===actionId); },
    play: async bytes => { plays.push(bytes); if(hold) await new Promise(resolve=>finish=resolve); },
    send: event => { sends.push(event); if(ack) queueMicrotask(()=>player.handleEvent({type:'conversation.item.created',item:event.item})); },
    setMicrophone: active=>mics.push(active),onCaption:event=>captions.push(event),onFailure:error=>errors.push(error),
  });
  player.handleEvent(vad);
  return {player,plays,sends,captions,mics,errors,reads,finish:()=>finish?.()};
}
test('validates exact payload and rejects binding/hash/shape before playback',async()=>{
  const p=speech();
  assert.equal((await validateWebsiteSpeech(p,{callId,interviewId:callId,actionId:p.actionId})).payload.text,p.text);
  for(const change of [{callId:'22222222-2222-4222-8222-222222222222'},{audio_sha256:'a'.repeat(64)},{kind:'GENERIC_CHAT'},{cost_usd:99},{extra:true}])
    await assert.rejects(validateWebsiteSpeech({...p,...change},{callId,interviewId:callId,actionId:p.actionId}));
});
test('one application playback, ACK only after ended, no premature ACK or provider caption',async()=>{
  const p=speech(),h=harness([p],{hold:true});
  const done=h.player.start(p);
  await until(()=>h.plays.length===1);
  h.player.handleEvent({type:'conversation.item.created',item:{id:`lgs-${p.actionId.slice(0,28)}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:p.text}]}});
  h.player.handleEvent({type:'response.output_audio_transcript.done',transcript:'Se quiser, posso escrever seu site.'});
  assert.equal(h.sends.length,0);assert.equal(h.captions.length,0);assert.equal(h.mics.at(-1),false);
  h.finish();await done;
  assert.equal(h.sends.length,1);assert.equal(h.captions.length,1);assert.equal(h.mics.at(-1),true);
  h.player.handleEvent(notice(p));await tick();assert.equal(h.plays.length,1);assert.equal(h.reads.length,1);
  h.player.stop();
});
test('summary parts do not open microphone; approval does; one signoff remains closed',async()=>{
  const ps=[speech(),speech('resumo','GENERATE_FINAL_SUMMARY',2),speech('resumo2','GENERATE_FINAL_SUMMARY',2),speech('aprovacao','REQUEST_FINAL_APPROVAL',2),speech('tchau','SPEAK_FINAL_SIGNOFF',2)];
  const h=harness(ps);await h.player.start(ps[0]);
  for(const p of ps.slice(1)){h.player.handleEvent(notice(p));await h.player.idle();assert.equal(h.mics.at(-1),p.kind==='REQUEST_FINAL_APPROVAL');}
  assert.equal(h.plays.length,5);assert.equal(h.captions.length,5);h.player.stop();
});
test('foreign/stale response cannot speak and never reenables microphone',async()=>{
  const p=speech(),h=harness([p],{read:async()=>({...p,callId:'22222222-2222-4222-8222-222222222222'})});
  await assert.rejects(h.player.start(p));assert.equal(h.plays.length,0);assert.equal(h.mics.at(-1),false);assert.equal(h.errors.length,1);
});
test('stop aborts pending read and late completion produces no audio',async()=>{
  const p=speech();let resolve;const h=harness([p],{read:()=>new Promise(r=>resolve=r)});
  const done=h.player.start(p);await tick();h.player.stop();resolve(p);await assert.rejects(done);assert.equal(h.plays.length,0);assert.equal(h.sends.length,0);
});
test('unsafe automatic responses terminate custody even after successful opening',async()=>{
  const p=speech(),h=harness([p]);await h.player.start(p);
  const changed=structuredClone(vad);changed.session.audio.input.turn_detection.create_response=true;
  h.player.handleEvent(changed);assert.equal(h.mics.at(-1),false);assert.equal(h.errors.length,1);
});
test('empty successful ASR is not an owner answer and keeps the current microphone question open',async()=>{
  const p=speech(),h=harness([p]);await h.player.start(p);
  h.player.handleEvent({type:'input_audio_buffer.speech_started',item_id:'silent'});
  h.player.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'silent',transcript:'   '});
  assert.equal(h.mics.at(-1),true);assert.equal(h.captions.length,1);assert.equal(h.errors.length,0);h.player.stop();
});
