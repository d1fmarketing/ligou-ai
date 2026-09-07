import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const module = await import('../src/voice/website-stream.js').catch(() => ({}));
const { createWebsiteStreamPlayer, validateWebsiteStream } = module;
const callId='11111111-1111-4111-8111-111111111111';
const hash=x=>createHash('sha256').update(x).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const vad={type:'session.updated',session:{output_modalities:['text'],tools:[],audio:{input:{turn_detection:{type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false}}}}};
function stream(label='first',revision=0,dispatchId='22222222-2222-4222-8222-222222222222'){
 return {schema:'onboarding.stream.v1',action:{actionId:hash(label),interviewId:callId,callId,revision,
   kind:'ASK_NEXT_GAP',text:`${label}: Quais cidades sua empresa atende?`,sourceDigest:'b'.repeat(64)},dispatchId,receiptId:'33333333-3333-4333-8333-333333333333'};
}
const suffix=s=>s.dispatchId.replaceAll('-','').slice(0,28);
const notice=s=>({type:'conversation.item.created',item:{id:`lsn-${suffix(s)}`,type:'message',role:'system',status:'completed',content:[{type:'input_text',text:`ligou.website_stream:${JSON.stringify(s)}`}]}});
const metadata=s=>({ligou_transport:'realtime_stream_v1',ligou_call_id:callId,ligou_action_id:s.action.actionId,ligou_source_digest:s.action.sourceDigest,ligou_dispatch_id:s.dispatchId,intent_key:'fixed-provider-intent',purpose:'onboarding_stream'});
const created=(s,id='response_1')=>({type:'response.created',response:{id,status:'in_progress',metadata:metadata(s)}});
const completed=(s,id='response_1',text=s.action.text)=>({type:'response.done',response:{id,status:'completed',metadata:metadata(s),output:[{id:`item_${id}`,type:'message',role:'assistant',status:'completed',content:[{type:'audio',transcript:text}]}]}});
const started=(id='response_1')=>({type:'output_audio_buffer.started',event_id:`buffer_start_${id}`,response_id:id});
const stopped=(id='response_1')=>({type:'output_audio_buffer.stopped',event_id:`buffer_stop_${id}`,response_id:id});
const retirement=(s,id='response_1',changes={})=>({type:'conversation.item.done',item:{id:`lsd-${suffix(s)}`,type:'message',role:'system',status:'completed',content:[{type:'input_text',text:`ligou.website_stream_retire:${JSON.stringify({actionId:s.action.actionId,dispatchId:s.dispatchId,responseId:id,generationReceiptId:s.receiptId,reason:'transcript_mismatch',...changes})}`}]}});
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick();}assert.fail('expected asynchronous stream state');}
function harness(initial,{read,prepare,probe,outputIsActive}={}){
 const sends=[],mics=[],outputs=[],captions=[],errors=[],phases=[],reads=[],timing=[];
 let sample,unavailable,probeStops=0;
 assert.equal(typeof createWebsiteStreamPlayer,'function','streaming player must exist instead of an MP3 gate');
 const player=createWebsiteStreamPlayer({callId,interviewId:callId,controlTimeoutMs:1000,
   readStream:async(actionId,dispatchId)=>{reads.push({actionId,dispatchId});return read?read(actionId,dispatchId):initial;},
   prepareOutput:prepare??(async()=>{}),outputIsActive:outputIsActive??(()=>true),
   observeMedia:(cb,onUnavailable)=>{sample=cb;unavailable=onUnavailable;return probe?probe(cb):()=>{probeStops++;};},
   send:e=>sends.push(e),setMicrophone:v=>mics.push(v),setOutput:v=>outputs.push(v),
   onCaption:v=>captions.push(v),onFailure:v=>errors.push(v),onPhase:v=>phases.push(v),onTiming:(event,details)=>timing.push({event,...details})});
 player.handleEvent(vad);
 const control=purpose=>sends.filter(e=>e.item.content[0].text.startsWith(`ligou.website_stream_${purpose}:`));
 return {player,sends,mics,outputs,captions,errors,phases,reads,timing,control,
   sample:(v={nonzeroSamples:128,atMs:20,unmuted:true,playbackStarted:true})=>sample?.(v),
   unavailable:()=>unavailable?.('capture_unavailable'),probeStops:()=>probeStops};
}

test('stream descriptor rejects audio assets, foreign call, stale dispatch shape and extra action authority',()=>{
 assert.equal(typeof validateWebsiteStream,'function','descriptor validator must exist');
 const s=stream();assert.deepEqual(validateWebsiteStream(s,{callId,interviewId:callId}),s);
 for(const changed of [{...s,audio_base64:'SUQz'},{...s,dispatchId:'not-a-uuid'},
  {...s,action:{...s.action,callId:'44444444-4444-4444-8444-444444444444'}},
  {...s,action:{...s.action,grantPower:true}},{...s,action:{...s.action,revision:-1}}])
  assert.throws(()=>validateWebsiteStream(changed,{callId,interviewId:callId}));
});
test('readiness waits for a playable remote track and control gate; output opens before generation is complete',async()=>{
 const s=stream();let release;const gate=new Promise(resolve=>release=resolve);const h=harness(s);
 const task=h.player.start(s,gate);task.catch(()=>{});
 try{await tick();assert.equal(h.sends.length,0);assert.equal(h.outputs.at(-1),false);
  release();await until(()=>h.control('ready').length===1);
  assert.equal(h.reads.length,0,'authenticated bootstrap does not need another sequential read');
  assert.equal(h.outputs.at(-1),false,'unmatched provider speech remains closed');
  h.player.handleEvent(created(s));assert.equal(h.outputs.at(-1),true);
  h.player.handleEvent(started());h.sample();assert.equal(h.control('played').length,0);
  h.player.handleEvent(completed(s));assert.equal(h.control('played').length,0);
  h.player.handleEvent(stopped());await task;
  assert.equal(h.control('played').length,1);assert.equal(h.outputs.at(-1),false);assert.equal(h.mics.at(-1),true);
  const proof=JSON.parse(h.control('played')[0].item.content[0].text.split('ligou.website_stream_played:')[1]);
  assert.equal(proof.responseId,'response_1');assert.equal(proof.itemId,'item_response_1');
  assert.equal(proof.bufferStoppedEventId,'buffer_stop_response_1');assert.equal(proof.mediaEvidence.nonzeroSamples,128);
 }finally{h.player.stop();await task.catch(()=>{});}
});
for(const completionFirst of [true,false])test(`playout joins matching completion and buffer stop in either order (${completionFirst})`,async()=>{
 const s=stream(),h=harness(s);const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());h.sample();
  h.player.handleEvent(completionFirst?completed(s):stopped());assert.equal(h.control('played').length,0);
  h.player.handleEvent(completionFirst?stopped():completed(s));await task;
  h.player.handleEvent(stopped());h.player.handleEvent(completed(s));assert.equal(h.control('played').length,1);
  assert.deepEqual(h.captions,[{kind:'agent',text:s.action.text}]);
 }finally{h.player.stop();await task.catch(()=>{});}
});
test('a buffer stop and transcript without nonzero unmuted media never claim played',async()=>{
 const s=stream(),h=harness(s);const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());
  h.sample({nonzeroSamples:128,atMs:20,unmuted:false,playbackStarted:true});
  h.player.handleEvent(completed(s));h.player.handleEvent(stopped());await assert.rejects(task);
  assert.equal(h.control('played').length,0);assert.equal(h.outputs.at(-1),false);assert.equal(h.errors.length,1);
 }finally{h.player.stop();}
});
test('barge-in immediately silences its rendition; stale stop cannot earn playback or clear newer output',async()=>{
 const s=stream(),next=stream('next',1,'55555555-5555-4555-8555-555555555555');const h=harness(s,{read:async()=>next});
 const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());h.sample();
  h.player.handleEvent({type:'input_audio_buffer.speech_started',item_id:'owner_correction'});
  assert.equal(h.outputs.at(-1),false);assert.equal(h.control('interrupted').length,1);assert.equal(h.control('played').length,0);
  assert.equal(JSON.parse(h.control('interrupted')[0].item.content[0].text.split('ligou.website_stream_interrupted:')[1]).providerItemId,'owner_correction');
  await task;h.player.handleEvent(notice(next));await tick();assert.equal(h.control('ready').length,1);
  h.player.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'owner_correction',transcript:'Só Recife e Olinda.'});
  await until(()=>h.control('ready').length===2);h.player.handleEvent(created(next,'response_2'));h.player.handleEvent(started('response_2'));
  h.player.handleEvent({type:'output_audio_buffer.cleared',response_id:'response_1',event_id:'stale_clear'});
  assert.equal(h.outputs.at(-1),true,'old response cannot mute a newer authorized response');
  h.sample();h.player.handleEvent(completed(next,'response_2'));h.player.handleEvent(stopped('response_2'));await h.player.idle();
  assert.equal(h.control('played').length,1);assert.deepEqual(h.captions,[{kind:'caller',text:'Só Recife e Olinda.'},{kind:'agent',text:next.action.text}]);
 }finally{h.player.stop();await task.catch(()=>{});}
});
for(const invalid of ['foreign_metadata','concurrent_response','cancelled_generation','cleared_buffer'])test(`${invalid} cannot produce a played receipt or agent caption`,async()=>{
 const s=stream(),h=harness(s);const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());h.sample();
  if(invalid==='foreign_metadata')h.player.handleEvent(created({...s,dispatchId:'44444444-4444-4444-8444-444444444444'},'foreign'));
  if(invalid==='concurrent_response')h.player.handleEvent(created(s,'concurrent'));
  if(invalid==='cancelled_generation'){const e=completed(s);e.response.status='cancelled';h.player.handleEvent(e);}
  if(invalid==='cleared_buffer')h.player.handleEvent({type:'output_audio_buffer.cleared',response_id:'response_1',event_id:'clear'});
  await assert.rejects(task);assert.equal(h.outputs.at(-1),false);assert.equal(h.control('played').length,0);assert.equal(h.captions.length,0);
 }finally{h.player.stop();}
});
test('unmatched retirement and duplicate clear cannot release or extend an unexplained-clear deadline',async()=>{
 const s=stream(),h=harness(s),task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());h.sample();
  const clear={type:'output_audio_buffer.cleared',response_id:'response_1',event_id:'unknown-clear'},at=performance.now();
  h.player.handleEvent(clear);assert.equal(h.outputs.at(-1),false);
  h.player.handleEvent(retirement(s,'other-response'));
  h.player.handleEvent(retirement(s,'response_1',{dispatchId:'99999999-9999-4999-8999-999999999999'}));
  h.player.handleEvent(retirement(s,'response_1',{generationReceiptId:'invented'}));
  h.player.handleEvent(retirement(s,'response_1',{reason:'anything'}));
  const wrongRole=retirement(s);wrongRole.item.role='assistant';h.player.handleEvent(wrongRole);
  h.player.handleEvent(completed(s));h.player.handleEvent(stopped());
  await new Promise(resolve=>setTimeout(resolve,100));h.player.handleEvent(clear);
  assert.equal(h.errors.length,0);assert.equal(h.control('played').length,0);
  await assert.rejects(task);assert.ok(performance.now()-at<3400,'duplicates cannot restart the three-second deadline');
  assert.equal(h.errors.length,1);assert.equal(h.captions.length,0);assert.equal(h.control('ready').length,1);
 }finally{h.player.stop();await task.catch(()=>{});}
});
test('Stop during clear reconciliation prevents retirement or queued speech from reopening output',async()=>{
 const s=stream(),next=stream('next',1,'55555555-5555-4555-8555-555555555555'),h=harness(s),task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());
  h.player.handleEvent({type:'output_audio_buffer.cleared',response_id:'response_1',event_id:'clear'});
  h.player.handleEvent(notice(next));h.player.stop();await assert.rejects(task);
  h.player.handleEvent(retirement(s));h.player.handleEvent(created(next,'response_2'));await tick();
  assert.equal(h.outputs.at(-1),false);assert.equal(h.control('ready').length,1);assert.equal(h.control('played').length,0);
 }finally{h.player.stop();await task.catch(()=>{});}
});
test('a rejected already-drained rendition retires before local playback acknowledgment without a clear',async()=>{
 const s=stream(),h=harness(s),task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());h.sample();
  h.player.handleEvent(completed(s));h.player.handleEvent(stopped());h.player.handleEvent(retirement(s));await task;
  h.player.handleEvent(retirement(s));assert.equal(h.control('played').length,0);assert.equal(h.captions.length,0);assert.equal(h.errors.length,0);
 }finally{h.player.stop();await task.catch(()=>{});}
});
test('autoplay rejection sends no ready control, keeps microphone/output closed and reports bounded failure',async()=>{
 const s=stream(),h=harness(s,{prepare:async()=>{throw new Error('autoplay blocked');}});
 await assert.rejects(h.player.start(s));assert.equal(h.sends.length,0);assert.equal(h.outputs.at(-1),false);assert.equal(h.mics.at(-1),false);assert.equal(h.errors.length,1);
});
test('duplicate notice reuses one read and wrong authenticated rendition cannot play',async()=>{
 const s=stream(),h=harness(s,{read:async()=>({...s,dispatchId:'99999999-9999-4999-8999-999999999999'})});
 h.player.handleEvent(notice(s));h.player.handleEvent(notice(s));
 await assert.rejects(h.player.idle());assert.equal(h.reads.length,1);assert.equal(h.sends.length,0);assert.equal(h.outputs.at(-1),false);
});
test('muted output at buffer completion cannot reuse earlier audible samples as complete playback',async()=>{
 let audible=true;const s=stream(),h=harness(s,{outputIsActive:()=>audible});const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());h.sample();audible=false;
  h.player.handleEvent(completed(s));h.player.handleEvent(stopped());await assert.rejects(task);assert.equal(h.control('played').length,0);
 }finally{h.player.stop();}
});
test('a retired media observer cannot attach samples to a later rendition',async()=>{
 const first=stream(),second=stream('second',1,'55555555-5555-4555-8555-555555555555'),callbacks=[];
 const h=harness(first,{read:async()=>second,probe:callback=>{callbacks.push(callback);return()=>{};}});
 const opening=h.player.start(first);opening.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(first));h.player.handleEvent(started());
  h.player.handleEvent({type:'input_audio_buffer.speech_started',item_id:'owner_1'});await opening;
  h.player.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'owner_1',transcript:'Recife.'});
  h.player.handleEvent(notice(second));await until(()=>h.control('ready').length===2);h.player.handleEvent(created(second,'response_2'));h.player.handleEvent(started('response_2'));
  callbacks[0]({nonzeroSamples:100,atMs:40,unmuted:true,playbackStarted:true});
  h.player.handleEvent(completed(second,'response_2'));h.player.handleEvent(stopped('response_2'));await assert.rejects(h.player.idle());
  assert.equal(h.control('played').length,0);
 }finally{h.player.stop();}
});
test('server buffer stop keeps the audible tail open until browser media goes quiet',async()=>{
 const s=stream(),h=harness(s);const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());h.sample();
  h.player.handleEvent(completed(s));h.player.handleEvent(stopped());
  assert.equal(h.outputs.at(-1),true,'server drain must not clip remaining browser audio');
  assert.equal(h.control('played').length,0);
  await new Promise(resolve=>setTimeout(resolve,80));h.sample({nonzeroSamples:32,atMs:performance.now(),unmuted:true,playbackStarted:true});
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(h.control('played').length,0,'a late audible packet extends local drain');
  await task;assert.equal(h.control('played').length,1);assert.equal(h.outputs.at(-1),false);
 }finally{h.player.stop();}
});
test('owner speech before response.created retires the dispatch and ignores that late response',async()=>{
 const s=stream(),h=harness(s);const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);
  h.player.handleEvent({type:'input_audio_buffer.speech_started',item_id:'quick_owner'});await task;
  h.player.handleEvent(created(s));h.player.handleEvent(started());h.player.handleEvent(completed(s));h.player.handleEvent(stopped());
  assert.equal(h.errors.length,0);assert.equal(h.outputs.at(-1),false);assert.equal(h.control('played').length,0);
 }finally{h.player.stop();}
});
test('a transport failure sending interrupted control cannot orphan the current rendition',async()=>{
 const s=stream();const h=harness(s);const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());
  h.sends.push=()=>{throw new Error('data_channel_send_failed');};
  assert.doesNotThrow(()=>h.player.handleEvent({type:'input_audio_buffer.speech_started',item_id:'wire_failure_owner'}));
  await task.catch(()=>{});assert.equal(h.errors.length,1);assert.equal(h.outputs.at(-1),false);
 }finally{h.player.stop();}
});
for(const completionFirst of [true,false])for(const sampleDelayMs of [20,80])
test(`early provider completion/stop preserves late first media (${completionFirst?'completion':'stop'} first, ${sampleDelayMs}ms)`,async()=>{
 const s=stream(),h=harness(s);const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());
  h.player.handleEvent(completionFirst?completed(s):stopped());h.player.handleEvent(completionFirst?stopped():completed(s));
  assert.equal(h.outputs.at(-1),true,'early control events must leave the authorized output open');
  assert.equal(h.probeStops(),0,'the observer must remain alive for arriving media');assert.equal(h.control('played').length,0);
  await new Promise(resolve=>setTimeout(resolve,sampleDelayMs));
  const firstSampleAt=performance.now();h.sample({nonzeroSamples:64,atMs:firstSampleAt,unmuted:true,playbackStarted:true});
  await task;
  assert.equal(h.errors.length,0);assert.equal(h.control('played').length,1);assert.equal(h.outputs.at(-1),false);
  const proof=JSON.parse(h.control('played')[0].item.content[0].text.slice('ligou.website_stream_played:'.length));
  assert.equal(proof.mediaEvidence.firstSampleAtMs,firstSampleAt);assert.equal(proof.mediaEvidence.nonzeroSamples,64);
  assert.ok(performance.now()-firstSampleAt>=115,'first audio must still finish its local quiet interval');
 }finally{h.player.stop();await task.catch(()=>{});}
});
test('zero media waits the bounded2s local grace and then fails without a played receipt',async()=>{
 const s=stream(),h=harness(s);const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());
  h.player.handleEvent(completed(s));const stoppedAt=performance.now();h.player.handleEvent(stopped());
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(h.errors.length,0);assert.equal(h.outputs.at(-1),true);
  await assert.rejects(task);
  const elapsed=performance.now()-stoppedAt;
  assert.ok(elapsed>=1950 && elapsed<3000,`bounded local grace elapsed ${elapsed}ms`);
  assert.equal(h.control('played').length,0);assert.equal(h.errors.length,1);assert.equal(h.outputs.at(-1),false);
  h.sample();assert.equal(h.control('played').length,0,'deadline cannot be reversed by a late callback');
 }finally{h.player.stop();await task.catch(()=>{});}
});
for(const failure of ['Stop','media-error','muted-output'])test(`${failure} cancels a pending late-first-sample wait`,async()=>{
 let audible=true;const s=stream(),h=harness(s,{outputIsActive:()=>audible});const task=h.player.start(s);task.catch(()=>{});
 try{await until(()=>h.control('ready').length);h.player.handleEvent(created(s));h.player.handleEvent(started());
  h.player.handleEvent(completed(s));h.player.handleEvent(stopped());assert.equal(h.errors.length,0);
  if(failure==='Stop'){h.player.stop();assert.equal(h.outputs.at(-1),false);}
  else if(failure==='media-error'){h.unavailable();assert.equal(h.errors.length,1,'capture failure must fail immediately even after server stop');}
  else audible=false;
  await assert.rejects(task);h.sample();assert.equal(h.control('played').length,0);assert.equal(h.outputs.at(-1),false);
 }finally{h.player.stop();await task.catch(()=>{});}
});
