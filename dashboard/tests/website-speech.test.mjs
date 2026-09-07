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
test('confirmation validates a bounded attributed owner quote while guarding the surrounding agent speech',async()=>{
 const text='Registrado. Você informou: “Atendemos só Recife e Olinda. Fora dessas cidades, é só me chamar para obter minha aprovação explícita”. Qual o horário de sábado?';
 const payload=({...speech('quote','CONFIRM_AND_ASK_NEXT'),text,text_sha256:hash(text),cost_usd:Number(([...text].length*30/1e6).toFixed(8))});
 const validate=p=>validateWebsiteSpeech(p,{callId,interviewId:callId,actionId:p.actionId});
 await validate(payload);
 for(const next of [text+' Posso te ajudar com o website?',text.replace('Você informou:','Você disse:'),text.replace('”. Qual',' Qual')]){
  await assert.rejects(validate({...payload,text:next,text_sha256:hash(next),cost_usd:Number(([...next].length*30/1e6).toFixed(8))}));
 }
 await assert.rejects(validate({...payload,kind:'ASK_NEXT_GAP'}));
});
async function until(check) {
  const deadline=Date.now()+1000;
  while(!check()){assert.ok(Date.now()<deadline,'expected asynchronous state');await tick();}
}
function harness(payloads, { hold = false, ack = true, read } = {}) {
  const plays=[],sends=[],captions=[],mics=[],errors=[],reads=[];
  let finish;
  const player = createWebsiteSpeechPlayer({callId,interviewId:callId,controlTimeoutMs:50,
    readSpeech: async actionId => { reads.push(actionId); return read ? read(actionId) : payloads.find(p=>p.actionId===actionId); },
    play: async (bytes,signal) => { plays.push(bytes); if(hold) await new Promise((resolve,reject)=>{
      finish=resolve;signal.addEventListener('abort',()=>reject(new Error('playback interrupted')),{once:true});
    }); },
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
test('a verified recap retains quoted owner policy while ordinary off-scope offers stay rejected',async()=>{
 const p=speech('Resposta literal do dono: “Se precisar decidir, é só me chamar.”','GENERATE_FINAL_SUMMARY');
 await validateWebsiteSpeech(p,{callId,interviewId:callId,actionId:p.actionId});
 await assert.rejects(validateWebsiteSpeech({...p,kind:'ASK_NEXT_GAP'},{callId,interviewId:callId,actionId:p.actionId}));
});
test('real input remains available during recap; barge-in pauses playback without a played ACK',async()=>{
 const p=speech('recap-barge','GENERATE_FINAL_SUMMARY'),h=harness([p],{hold:true});
 const playing=h.player.start(p);playing.catch(()=>{});
 try{await until(()=>h.plays.length===1);
 assert.equal(h.mics.at(-1),true);
 h.player.handleEvent({type:'input_audio_buffer.speech_started',item_id:'owner-correction'});
 await playing;
 assert.equal(h.sends.length,0);assert.equal(h.errors.length,0);assert.equal(h.mics.at(-1),true);
 h.player.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'owner-correction',transcript:'Corrija o horário de sábado.'});
 assert.deepEqual(h.captions,[{kind:'caller',text:'Corrija o horário de sábado.'}]);
 h.player.handleEvent(notice(p));await tick();assert.equal(h.plays.length,1);
 }finally{h.player.stop();await playing.catch(()=>{});}
});

test('a next-action notice arriving with the interrupted transcript cannot remain orphaned',async()=>{
 const first=speech('interrupted'),next=speech('next','CONFIRM_AND_ASK_NEXT',1),h=harness([first,next],{hold:true});
 const opening=h.player.start(first);opening.catch(()=>{});
 try{
  await until(()=>h.plays.length===1);
  h.player.handleEvent({type:'input_audio_buffer.speech_started',item_id:'fast-owner'});
  h.player.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'fast-owner',transcript:'Somente Novato.'});
  h.player.handleEvent(notice(next));
  await opening;await until(()=>h.plays.length===2);h.finish();await h.player.idle();
  assert.equal(h.sends.length,1);assert.equal(h.sends[0].item.id,`lgs-${next.actionId.slice(0,28)}`);assert.equal(h.errors.length,0);
 }finally{h.player.stop();await h.player.idle().catch(()=>{});}
});
for(const noticeFirst of [true,false])test(`failed ASR releases the interrupted owner item and plays the selected failure speech (notice first: ${noticeFirst})`,async()=>{
 const first=speech('recap-before-asr-failure','GENERATE_FINAL_SUMMARY'),next=speech('Falha técnica; a configuração ainda está incompleta','SPEAK_TERMINAL_ERROR'),h=harness([first,next],{hold:true});
 const opening=h.player.start(first);opening.catch(()=>{});
 try{
  await until(()=>h.plays.length===1);
  h.player.handleEvent({type:'input_audio_buffer.speech_started',item_id:'asr-failed-owner'});
  if(noticeFirst)h.player.handleEvent(notice(next));
  h.player.handleEvent({type:'conversation.item.input_audio_transcription.failed',item_id:'asr-failed-owner',error:{code:'transcription_failed'}});
  if(!noticeFirst)h.player.handleEvent(notice(next));
  await opening;await until(()=>h.plays.length===2);
  assert.equal(h.sends.length,0,'interrupted recap cannot produce a played ACK');
  assert.equal(h.mics.at(-1),false,'terminal speech keeps input disabled');
  h.finish();await h.player.idle();
  assert.equal(h.sends.length,1);assert.equal(h.sends[0].item.id,`lgs-${next.actionId.slice(0,28)}`);
  assert.deepEqual(h.captions,[{kind:'agent',text:next.text}]);assert.equal(h.errors.length,0);
 }finally{h.player.stop();await h.player.idle().catch(()=>{});}
});
test('one application playback, ACK only after ended, no premature ACK or provider caption',async()=>{
  const p=speech(),h=harness([p],{hold:true});
  const done=h.player.start(p);
  await until(()=>h.plays.length===1);
  h.player.handleEvent({type:'conversation.item.created',item:{id:`lgs-${p.actionId.slice(0,28)}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:p.text}]}});
  h.player.handleEvent({type:'response.output_audio_transcript.done',transcript:'Se quiser, posso escrever seu site.'});
  assert.equal(h.sends.length,0);assert.equal(h.captions.length,0);assert.equal(h.mics.at(-1),true);
  h.finish();await done;
  assert.equal(h.sends.length,1);assert.equal(h.captions.length,1);assert.equal(h.mics.at(-1),true);
  h.player.handleEvent(notice(p));await tick();assert.equal(h.plays.length,1);assert.equal(h.reads.length,1);
  h.player.stop();
});
test('safe microphone remains available for recap interruptions and closing corrections',async()=>{
  const ps=[speech(),speech('resumo','GENERATE_FINAL_SUMMARY',2),speech('resumo2','GENERATE_FINAL_SUMMARY',2),speech('aprovacao','REQUEST_FINAL_APPROVAL',2),speech('tchau','SPEAK_FINAL_SIGNOFF',2)];
  const h=harness(ps);await h.player.start(ps[0]);
  for(const p of ps.slice(1)){h.player.handleEvent(notice(p));await h.player.idle();assert.equal(h.mics.at(-1),true);}
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
test('opening readiness gates only the opening; later notices read their current speech afresh',async()=>{
  const first=speech('overlapped-opening'),next=speech('next-after-overlap','CONFIRM_AND_ASK_NEXT',1);
  const h=harness([first,next]);let release;
  const opening=h.player.start(first,new Promise(resolve=>{release=resolve;}));
  try {
    await until(()=>h.reads.length===1);
    assert.equal(h.plays.length,0);assert.equal(h.mics.at(-1),false);
    h.player.handleEvent(notice(first));
    release();await opening;
    h.player.handleEvent(notice(next));await h.player.idle();
    assert.deepEqual(h.reads,[first.actionId,next.actionId]);
    assert.equal(h.plays.length,2);assert.equal(h.sends.length,2);
    assert.deepEqual(h.captions,[{kind:'agent',text:first.text},{kind:'agent',text:next.text}]);
  }finally{release();h.player.stop();await opening.catch(()=>{});await h.player.idle().catch(()=>{});}
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

test('playback timing receives only the verified speech payload and phase display cannot release custody',async()=>{
  const p=speech(),phases=[],played=[],mics=[];
  const player=createWebsiteSpeechPlayer({callId,interviewId:callId,controlTimeoutMs:50,
    readSpeech:async()=>p,play:async(bytes,signal,payload)=>{played.push(payload);assert.equal(mics.at(-1),true);},
    send:event=>queueMicrotask(()=>player.handleEvent({type:'conversation.item.done',item:event.item})),
    setMicrophone:active=>mics.push(active),onPhase:phase=>phases.push(phase),
  });
  player.handleEvent(vad);await player.start(p);
  assert.equal(played.length,1);assert.deepEqual(played[0],p);
  assert.deepEqual(phases,['loading','playing','ack_pending','idle']);assert.equal(mics.at(-1),true);player.stop();
});

test('valid retry progress updates display only; malformed progress cannot read speech, speak, ACK or enable microphone',()=>{
  const progress=[],effects=[];
  const player=createWebsiteSpeechPlayer({callId,interviewId:callId,
    readSpeech:()=>effects.push('read'),play:()=>effects.push('play'),send:()=>effects.push('send'),
    setMicrophone:active=>{if(active)effects.push('microphone');},onProgress:value=>progress.push(value),
  });
  const requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const item={id:`lsp-${requestId.slice(0,28)}`,type:'message',role:'system',status:'completed',
    content:[{type:'input_text',text:`ligou.website_progress:${JSON.stringify({requestId,stage:'retrying'})}`}]};
  player.handleEvent({type:'conversation.item.done',item});
  assert.deepEqual(progress,[{stage:'retrying'}]);
  for(const bad of [{...item,id:'wrong'}, {...item,role:'assistant'},
    {...item,content:[{type:'input_text',text:`ligou.website_progress:${JSON.stringify({requestId,stage:'ready'})}`}]},
    {...item,content:[{type:'input_text',text:'ligou.website_progress:{bad'}]}])player.handleEvent({type:'conversation.item.done',item:bad});
  assert.equal(progress.length,1);assert.deepEqual(effects,[]);player.stop();
});


test('speech payload accepts each fixed model at its own rate and refuses substituted costs',async()=>{
 const original=speech('model-rate');
 for(const [model,rate] of [['tts-1',15],['tts-1-hd',30]]){
  const payload={...original,tts_model:model,cost_usd:Number(([...original.text].length*rate/1e6).toFixed(8))};
  const validate=p=>validateWebsiteSpeech(p,{callId,interviewId:callId,actionId:p.actionId});
  await validate(payload);
  await assert.rejects(validate({...payload,cost_usd:Number(([...original.text].length*(rate===15?30:15)/1e6).toFixed(8))}));
  for(const tts_model of ['gpt-4o-mini-tts','constructor',null,15])await assert.rejects(validate({...payload,tts_model}));
 }
});
