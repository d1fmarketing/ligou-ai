import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as harness from '../../scripts/voice-onboarding-audio-acceptance.mjs';

test('native launch entry rejects before examining configuration or starting a process',async()=>{
 assert.equal(typeof harness.openRealBrowser,'function','native entry must expose its explicit disabled contract');
 await assert.rejects(harness.openRealBrowser(null,null),/native_browser_execution_disabled_use_codex_in_app/);
});
test('in-app observer source is scoped, repeat-safe JavaScript without carrying authentication',()=>{
 assert.equal(typeof harness.buildBrowserHarnessSource,'function');
 const source=harness.buildBrowserHarnessSource({origin:'https://client-nine-taupe-24.vercel.app',isolatedTestOnly:true,recordTestAudio:true});
 assert.doesNotThrow(()=>new Function(source));
 assert.throws(()=>harness.buildBrowserHarnessSource({origin:'https://example.com/path',isolatedTestOnly:true,recordTestAudio:true}),/origin/);
 assert.throws(()=>harness.buildBrowserHarnessSource({origin:'https://example.com',recordTestAudio:true}),/isolated/);
 const prior={existing:true};let reads=0;
 const samePage={location:{origin:'https://client-nine-taupe-24.vercel.app'},__voiceAcceptance:prior};
 const install=new Function('location','window',source);
 assert.doesNotThrow(()=>install(samePage.location,samePage));assert.equal(samePage.__voiceAcceptance,prior);
 const wrongPage={get fetch(){reads++;throw new Error('wrong origin touched');}};
 assert.doesNotThrow(()=>install({origin:'https://unrelated.example'},wrongPage));assert.equal(reads,0);
});
test('data-channel session readback records only bounded allowlisted configuration',()=>{
 const origin='https://client-nine-taupe-24.vercel.app';
 class Peer extends EventTarget {createDataChannel(){return new EventTarget();}}
 class Media {play(){throw new Error('media must remain untouched');}}
 const window={RTCPeerConnection:Peer,fetch(){throw new Error('network must remain untouched');},addEventListener(){}};
 const document={createElement(){throw new Error('DOM must remain untouched');},addEventListener(){},querySelector(){return null;}};
 new Function('location','window','navigator','document','HTMLMediaElement','HTMLAudioElement','performance',
  harness.buildBrowserHarnessSource({origin,isolatedTestOnly:true,recordTestAudio:true}))(
    {origin},window,{mediaDevices:{}},document,Media,Media,{now:()=>100});
 const channel=new window.RTCPeerConnection().createDataChannel('test-only');
 const observe=session=>{
  channel.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'session.updated',session,
    transcript:'secret must not become a transcript',client_secret:'event secret',sdp:'event SDP'})}));
  return window.__voiceAcceptance.drain().events.filter(event=>event.event==='provider_event');
 };
 const session={model:'gpt-realtime-2.1',reasoning:{effort:'medium',private:'secret'},client_secret:{value:'session secret'},sdp:'session SDP',instructions:'private prompt',
  audio:{input:{transcription:{model:'gpt-live-transcribe',languages:['pt','en-US'],prompt:'private ASR prompt'},
    turn_detection:{type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false,private:'secret'}}}};
 assert.deepEqual(observe(session),[{event:'provider_event',browserMs:100,elapsedMs:null,type:'session.updated',sessionConfig:{
  model:'gpt-realtime-2.1',reasoningEffort:'medium',transcriptionModel:'gpt-live-transcribe',languages:['pt','en-US'],
  vadType:'semantic_vad',vadEagerness:'low',createResponse:false,interruptResponse:false}}]);
 const unknown={model:'secret-unrecognized-model',reasoning:{effort:'secret'},audio:{input:{transcription:{model:'secret',languages:['pt','not a language secret']},
  turn_detection:{type:'secret',eagerness:'secret',create_response:'false',interrupt_response:1}}}};
 const empty={model:null,reasoningEffort:null,transcriptionModel:null,languages:null,vadType:null,vadEagerness:null,createResponse:null,interruptResponse:null};
 assert.deepEqual(observe(unknown)[0].sessionConfig,empty);
 assert.deepEqual(observe({})[0].sessionConfig,empty,'missing provider defaults must stay unknown');
 const excessive=structuredClone(session);excessive.audio.input.transcription.languages=Array(9).fill('pt');
 assert.equal(observe(excessive)[0].sessionConfig.languages,null,'an over-bound list is not truncated into apparent provider truth');
});

test('browser speech-read diagnostics retain bounded failure codes without arbitrary error data',()=>{
 const origin='https://client-nine-taupe-24.vercel.app',listeners=new Map();
 class Peer extends EventTarget {createDataChannel(){return new EventTarget();}}
 class Media {play(){throw new Error('media must remain untouched');}}
 const window={RTCPeerConnection:Peer,fetch(){throw new Error('network must remain untouched');},addEventListener(name,fn){listeners.set(name,fn);}};
 const document={createElement(){throw new Error('DOM must remain untouched');},addEventListener(){},querySelector(){return null;}};
 new Function('location','window','navigator','document','HTMLMediaElement','HTMLAudioElement','performance',
  harness.buildBrowserHarnessSource({origin,isolatedTestOnly:true,recordTestAudio:true}))({origin},window,{mediaDevices:{}},document,Media,Media,{now:()=>100});
 const observe=detail=>{listeners.get('ligou:voice-timing')({detail});return window.__voiceAcceptance.drain().events.find(e=>e.event==='application_timing');};
 assert.deepEqual(observe({event:'speech_read_failed',attempt:1,status:0,code:'network',message:'private error',authorization:'secret'}),
  {event:'application_timing',browserMs:100,elapsedMs:null,timingEvent:'speech_read_failed',attempt:1,status:0,code:'network'});
 const invalid=observe({event:'speech_read_retry',attempt:99,status:'401 private',code:'private-secret-value',message:'secret'});
 for(const key of ['attempt','status','code','message','authorization'])assert.equal(Object.hasOwn(invalid,key),false);
 const unrelated=observe({event:'ready',attempt:1,status:200,code:'network'});
 for(const key of ['attempt','status','code'])assert.equal(Object.hasOwn(unrelated,key),false);
});
test('local file manifest retains all114 questions and verifies selected owner WAV metadata',async()=>{
 assert.equal(typeof harness.buildOwnerFileManifest,'function');
 const plan={schema:'ligou.browser_audio_answer_plan.v1',provenance:{itemCount:114,candidateCount:21},
  items:Array.from({length:114},(_,index)=>({itemId:'item-'+index,questionPt:'Question '+index})),candidateRecap:[],unhandledItems:[],specials:{},
  clips:[{id:'owner-1',filename:'caller/owner-1.wav',audio:{sha256:'a'.repeat(64),durationMs:1500}},
    {id:'owner-2',filename:'caller/owner-2.wav',audio:{sha256:'b'.repeat(64),durationMs:2500}}]};
 const manifest=harness.buildOwnerFileManifest(plan,'/Users/d1f/Desktop/Ligou.AI/output/voice-onboarding-20260906/audio-acceptance');
 assert.equal(manifest.schema,'ligou.in_app_owner_audio.v1');assert.equal(manifest.provenance.itemCount,114);
 assert.equal(manifest.clips.length,2);assert.equal(manifest.items.length,114);
 assert.ok(manifest.clips.every(clip=>clip.absolutePath.startsWith('/Users/d1f/Desktop/Ligou.AI/output/')&&/^[a-f0-9]{64}$/.test(clip.audio.sha256)));
 const bad=structuredClone(plan);bad.clips[0].filename='../outside.wav';assert.throws(()=>harness.buildOwnerFileManifest(bad,'/tmp/voice'),/file/);
});

test('local owner file verification rejects changed bytes, names and non-WAV files before audio injection',async()=>{
 const bytes=new Uint8Array(48);bytes.set(new TextEncoder().encode('RIFF'));bytes.set(new TextEncoder().encode('WAVE'),8);
 const audio={sha256:createHash('sha256').update(bytes).digest('hex'),durationMs:100};
 const clip={id:'owner-1',basename:'owner-1.wav',audio};const file=new File([bytes],'owner-1.wav',{type:'audio/wav'});
 assert.deepEqual(await harness.validateOwnerAudioFile(file,clip),bytes);
 await assert.rejects(harness.validateOwnerAudioFile(file,{...clip,basename:'different.wav'}),/file_invalid/);
 const changed=bytes.slice();changed[44]=1;
 await assert.rejects(harness.validateOwnerAudioFile(new File([changed],'owner-1.wav'),clip),/hash_mismatch/);
 await assert.rejects(harness.validateOwnerAudioFile(new File([new Uint8Array(48)],'owner-1.wav'),clip),/not_wav/);
});

const capturedOpening=()=>({
 recording:{bytes:500,sha256:'a'.repeat(64),nonzeroObserved:true,outputIndex:1,actionId:'action-1',dispatchId:'dispatch-1',responseId:'response-1',
  captureEvidence:'actual_remote_stream_with_observed_output_gate',startedBrowserMs:122331.8,stoppedBrowserMs:143066.3,expectedText:'Oi! Aqui é o Ligou.'},
 events:[{event:'start_clicked',browserMs:115640.1},{event:'output_first_nonzero_sample',browserMs:123197.4,
  outputIndex:1,actionId:'action-1',dispatchId:'dispatch-1',responseId:'response-1',evidence:'remote_webrtc_media'}],
 waveform:{signalFirstMs:872.75,signalLastMs:20340.5,durationMs:20700,sampleRate:16000,signalThreshold:0.001,sha256:'b'.repeat(64)},
 words:[{word:'Oi,',start:0,end:1.06,probability:0.81},{word:'aqui',start:1.88,end:2.08,probability:0.98},
  ...['Quais','cidades','exatas','sua'].map((word,index)=>({word,start:17.78+index*0.2,end:17.98+index*0.2,probability:0.99}))],
});

test('legacy ASR-zero alignment cannot report words before matching captured media',()=>{
 const {recording,events}=capturedOpening();
 recording.alignment={available:true,sourceRecordingSha256:recording.sha256,firstIntelligibleBrowserMs:recording.startedBrowserMs,
  actionableQuestion:{browserMs:recording.startedBrowserMs+17780}};
 const metrics=harness.summarizeAttempt({recordings:[recording],events});
 assert.equal(metrics.startToFirstNonzeroCapturedSampleMs,7557.299999999988);
 assert.equal(metrics.startToFirstIntelligibleAudioMs,null,'uncalibrated Whisper offsets must not become browser latency');
 assert.equal(metrics.startToFirstActionableQuestionMs,null,'legacy recording-start arithmetic is not calibrated evidence');
});

test('cached pilot word zero is bounded by waveform onset and the same response sample observation',()=>{
 const {recording,events,waveform,words}=capturedOpening();
 const aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
 assert.equal(aligned.firstAsrTokenOffsetMs,0);
 assert.equal(aligned.firstVerifiedPhrase.offsetMs,0,'raw ASR evidence stays visible');
 assert.equal(aligned.browserClock.available,true);
 assert.equal(aligned.browserClock.observedFirstNonzeroBrowserMs,123197.4);
 assert.equal(aligned.firstIntelligibleBrowserMs,123204.55);
 assert.equal(aligned.actionableQuestion.browserMs,140111.8);
 assert.ok(aligned.firstIntelligibleBrowserMs>=events[1].browserMs);
 recording.alignment={...aligned,available:true,sourceRecordingSha256:recording.sha256};
 const metrics=harness.summarizeAttempt({recordings:[recording],events});
 assert.equal(metrics.startToFirstIntelligibleAudioMs,7564.449999999997);
 assert.equal(metrics.physicalSpeakerVerified,false);
 assert.equal(metrics.audioTimingEvidence,'conservative_captured_media_alignment');
});

test('a delayed recording clock shifts subsequent words conservatively without discarding leading silence twice',()=>{
 const {recording,events,waveform,words}=capturedOpening();
 events[1].browserMs=124000;
 const aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
 assert.equal(aligned.firstIntelligibleBrowserMs,124000);
 assert.equal(aligned.actionableQuestion.browserMs,124000+(17780-waveform.signalFirstMs));
 assert.ok(aligned.browserClock.originAdjustmentMs>0);
});

test('missing, wrong-response, wrong-dispatch, provider-only and out-of-recording samples cannot align words',()=>{
 for(const mutate of [
  events=>events.pop(),
  events=>{events[1].responseId='other-response';},
  events=>{events[1].dispatchId='other-dispatch';},
  events=>{events[1].outputIndex=2;},
  events=>{events[1].evidence='provider_output_buffer_started';},
  events=>{events[1].browserMs=144000;},
 ]){
  const {recording,events,waveform,words}=capturedOpening();mutate(events);
  const aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
  assert.equal(aligned.browserClock.available,false);
  assert.equal(aligned.firstIntelligibleBrowserMs,null);
  assert.equal(aligned.actionableQuestion,null);
 }
});

test('an ASR word entirely before the waveform or a word beyond capture end stays unmeasured',()=>{
 const {recording,events,waveform,words}=capturedOpening();
 words[0].end=0.5;
 let aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
 assert.equal(aligned.firstIntelligibleBrowserMs,null);
 assert.ok(aligned.actionableQuestion.browserMs>events[1].browserMs);
 recording.stoppedBrowserMs=124500;
 aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
 assert.equal(aligned.actionableQuestion,null);
});

test('summary rechecks sample identity and rejects a changed early aligned timestamp',()=>{
 const {recording,events,waveform,words}=capturedOpening();
 recording.alignment={available:true,sourceRecordingSha256:recording.sha256,
  ...harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?')};
 recording.alignment.firstIntelligibleBrowserMs=recording.startedBrowserMs;
 assert.equal(harness.summarizeAttempt({recordings:[recording],events}).startToFirstIntelligibleAudioMs,null);
 events[1].responseId='other-response';
 const metrics=harness.summarizeAttempt({recordings:[recording],events});
 assert.equal(metrics.startToFirstIntelligibleAudioMs,null);
 assert.equal(metrics.startToFirstActionableQuestionMs,null);
 assert.equal(metrics.audioTimingEvidence,null);
});

const NATIVE_CALL='11111111-1111-4111-8111-111111111111',NATIVE_INTERVIEW='22222222-2222-4222-8222-222222222222';
async function nativeObserverSimulation(){
 const origin='https://client-nine-taupe-24.vercel.app',listeners=new Map(),frames=new Map();let frame=0,amplitude=.2;
 const track=()=>({readyState:'live',stop(){this.readyState='ended';}});
 const stream=()=>({getTracks:()=>[track()],getAudioTracks:()=>[track()],clone:()=>stream()});
 class Media extends EventTarget {muted=false;paused=false;volume=1;srcObject=stream();play(){return Promise.resolve();}}
 class Peer extends EventTarget {connectionState='new';createDataChannel(){return new EventTarget();}close(){this.connectionState='closed';}}
 class Context {state='running';resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
  createAnalyser(){return{fftSize:512,getFloatTimeDomainData(a){a.fill(amplitude);}};}
  createMediaStreamSource(){return{connect(node){return node;},disconnect(){}};}
  createGain(){return{gain:{value:1},connect(node){return node;},disconnect(){}};}
  createMediaStreamDestination(){return{stream:stream()};}}
 class Recorder {static isTypeSupported(){return true;}state='inactive';start(){this.state='recording';}stop(){if(this.state==='inactive')return;this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array([1,2,3,4])])});void this.onstop?.();}}
 const window={RTCPeerConnection:Peer,fetch:async()=>Response.json({call_id:NATIVE_CALL,model:'gpt-realtime-2.1',max_minutes:55,
  onboarding_protocol_version:5,opening_mode_applied:'realtime_native_v1',opening_payload:{version:5,native:{callId:NATIVE_CALL,interviewId:NATIVE_INTERVIEW,revision:0,sourceDigest:'b'.repeat(64)}}}),addEventListener(name,fn){listeners.set(name,fn);}};
 const document={createElement(){return new Media();},addEventListener(){},querySelector(){return null;}};
 const raf=fn=>{const id=++frame;frames.set(id,setTimeout(()=>{frames.delete(id);fn();},8));return id;};
 new Function('location','window','navigator','document','HTMLMediaElement','HTMLAudioElement','AudioContext','MediaRecorder','requestAnimationFrame','cancelAnimationFrame',
  harness.buildBrowserHarnessSource({origin,isolatedTestOnly:true,recordTestAudio:true}))(
    {origin,href:origin+'/dashboard/setup/website'},window,{mediaDevices:{}},document,Media,Media,Context,Recorder,raf,id=>{clearTimeout(frames.get(id));frames.delete(id);});
 const audio=document.createElement('audio'),channel=new window.RTCPeerConnection().createDataChannel('test');
 await window.fetch(origin+'/browser-session');await new Promise(r=>setTimeout(r,5));
 const emit=event=>channel.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(event)}));
 const created=(responseId)=>emit({type:'response.created',response:{id:responseId,status:'in_progress',output_modalities:['audio']}});
 const finished=(responseId,text='Oi, aqui é o Ligou. Quais cidades você atende?')=>{
  emit({type:'response.done',response:{id:responseId,status:'completed',output:[{id:'item_'+responseId,type:'message',role:'assistant',status:'completed',content:[{type:'audio',transcript:text}]}]}});
  emit({type:'output_audio_buffer.stopped',response_id:responseId,event_id:'stop_'+responseId});
 };
 return{window,audio,emit,created,finished,listeners,setAmplitude:v=>{amplitude=v;},cleanup:async()=>{await window.__voiceAcceptance.cleanup();for(const timer of frames.values())clearTimeout(timer);}};
}

test('native observer captures direct audio without selected speech and closes on actual local drain',async()=>{
 const h=await nativeObserverSimulation();try{
  h.created('native_1');h.emit({type:'output_audio_buffer.started',response_id:'native_1',event_id:'start_native_1'});
  await new Promise(r=>setTimeout(r,20));h.setAmplitude(0);h.finished('native_1');
  await new Promise(r=>setTimeout(r,165));const result=h.window.__voiceAcceptance.drain({includeRecordingBytes:true});
  assert.equal(result.recordings.length,1);const recording=result.recordings[0];
  assert.equal(recording.responseId,'native_1');assert.equal(recording.callId,NATIVE_CALL);assert.equal(recording.interviewId,NATIVE_INTERVIEW);
  assert.equal(recording.captureEvidence,'actual_native_remote_stream');assert.equal(recording.nonzeroObserved,true);
  assert.equal(recording.stopReason,'native_browser_drained');assert.equal(recording.providerTranscript,'Oi, aqui é o Ligou. Quais cidades você atende?');
  assert.equal(Object.hasOwn(recording,'expectedText'),false);assert.equal(Object.hasOwn(recording,'actionId'),false);
  assert.equal(recording.sha256,createHash('sha256').update(Buffer.from(recording.base64,'base64')).digest('hex'));
  assert.equal(result.events.some(e=>e.event==='selected_speech'),false);assert.equal(h.audio.muted,false);
 }finally{await h.cleanup();}
});

test('native observer preserves barge-in and cleared audio as partial recordings',async()=>{
 const h=await nativeObserverSimulation();try{
  h.created('partial_1');await new Promise(r=>setTimeout(r,15));h.emit({type:'input_audio_buffer.speech_started',item_id:'owner_1'});
  await new Promise(r=>setTimeout(r,15));h.created('partial_2');await new Promise(r=>setTimeout(r,15));
  h.emit({type:'output_audio_buffer.cleared',response_id:'partial_2',event_id:'clear_2'});await new Promise(r=>setTimeout(r,15));
  const result=h.window.__voiceAcceptance.drain();assert.deepEqual(result.recordings.map(r=>r.stopReason),['owner_barge_in','output_audio_buffer.cleared']);
  assert.equal(result.recordings.every(r=>r.partial===true),true);assert.equal(h.audio.muted,false);
 }finally{await h.cleanup();}
});

test('native context and saved tool receipt are bounded without copying interpretation, arguments or secrets',async()=>{
 const h=await nativeObserverSimulation();try{
  const notice={callId:NATIVE_CALL,interviewId:NATIVE_INTERVIEW,revision:1,sourceDigest:'c'.repeat(64),mode:'conversation',currentQuestion:{itemId:'schedule.timezone',questionPt:'Qual é o fuso horário?'}};
  const contextEvent={type:'conversation.item.done',item:{id:'lnc-'+'a'.repeat(28),type:'message',role:'system',status:'completed',content:[{type:'input_text',text:'ligou.website_native:'+JSON.stringify(notice)}]}};
  h.emit(contextEvent);h.emit(contextEvent);
  h.emit({...contextEvent,item:{...contextEvent.item,id:'lnc-'+'d'.repeat(28),content:[{type:'input_text',text:'ligou.website_native:'+JSON.stringify({...notice,callId:NATIVE_INTERVIEW})}]}});
  const output={saved:true,replayed:false,savedRevision:1,revision:1,savedReceiptId:'33333333-3333-4333-8333-333333333333',digest:'c'.repeat(64),
   interpretation:'private interpretation',context:{instructions:'secret'},authorization:'secret',args:{key:'secret'},provenance:'model_interpretation'};
  const toolEvent={type:'conversation.item.done',item:{type:'function_call_output',id:'tool_item',call_id:'tool_1',output:JSON.stringify(output)}};
  h.emit(toolEvent);h.emit(toolEvent);
  h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'owner_1',transcript:'late ASR'});
  const result=h.window.__voiceAcceptance.drain(),contexts=result.events.filter(e=>e.event==='native_context'),tools=result.events.filter(e=>e.event==='native_tool_output');
  assert.equal(contexts.length,1);assert.deepEqual(contexts[0].currentQuestion,notice.currentQuestion);assert.equal(result.nativeContext.revision,1);
  assert.equal(tools.length,1);assert.equal(tools[0].saved,true);assert.equal(tools[0].savedRevision,1);assert.equal(tools[0].savedReceiptId,output.savedReceiptId);
  assert.equal(JSON.stringify(tools).includes('private interpretation'),false);assert.equal(JSON.stringify(tools).includes('secret'),false);
  assert.ok(result.events.indexOf(tools[0])<result.events.findIndex(e=>e.type==='conversation.item.input_audio_transcription.completed'));
 }finally{await h.cleanup();}
});

test('native alignment uses actual provider transcript and response identity without an expected phrase',()=>{
 const {recording,events,waveform,words}=capturedOpening();
 Object.assign(recording,{captureEvidence:'actual_native_remote_stream',callId:NATIVE_CALL,interviewId:NATIVE_INTERVIEW,revision:0,sourceDigest:'b'.repeat(64),providerTranscript:'Oi, aqui é o Ligou.',providerStatus:'completed',stopReason:'native_browser_drained',partial:false});
 delete recording.actionId;delete recording.dispatchId;delete recording.expectedText;
 Object.assign(events[1],{callId:NATIVE_CALL,interviewId:NATIVE_INTERVIEW});delete events[1].actionId;delete events[1].dispatchId;
 const aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
 assert.equal(aligned.browserClock.available,true);assert.equal(aligned.firstIntelligibleBrowserMs,123204.55);
 assert.equal(aligned.firstVerifiedPhrase.evidence,'local_asr_matches_provider_transcript');
 recording.alignment={...aligned,available:true,sourceRecordingSha256:recording.sha256};
 assert.equal(harness.summarizeAttempt({recordings:[recording],events}).startToFirstIntelligibleAudioMs,7564.449999999997);
 recording.providerStatus=null;
 assert.equal(harness.summarizeAttempt({recordings:[recording],events}).startToFirstIntelligibleAudioMs,null,'local drain alone cannot prove a completed response');
 recording.providerStatus='completed';
 recording.partial=true;recording.stopReason='owner_barge_in';
 assert.equal(harness.summarizeAttempt({recordings:[recording],events}).startToFirstIntelligibleAudioMs,null,'a rejected partial cannot count as a completed useful response');
});

test('native capture waits through a late audible tail but closes an unproven stream within its capture-only bound',async()=>{
 const h=await nativeObserverSimulation();try{
  h.created('tail_1');await new Promise(r=>setTimeout(r,20));h.finished('tail_1');
  await new Promise(r=>setTimeout(r,150));assert.equal(h.window.__voiceAcceptance.drain().recordings.length,0,'ongoing local samples extend capture');
  h.setAmplitude(0);await new Promise(r=>setTimeout(r,150));assert.equal(h.window.__voiceAcceptance.drain().recordings[0].stopReason,'native_browser_drained');
  h.created('silent_1');h.finished('silent_1');await new Promise(r=>setTimeout(r,2050));
  const silent=h.window.__voiceAcceptance.drain().recordings[0];assert.equal(silent.stopReason,'native_drain_timeout');assert.equal(silent.partial,true);
  assert.equal(silent.nonzeroObserved,false);assert.equal(h.audio.muted,false,'capture timeout never changes application audio');
 }finally{await h.cleanup();}
});

test('muting a native tail cannot turn earlier nonzero samples into a complete capture',async()=>{
 const h=await nativeObserverSimulation();try{
  h.created('muted_tail');await new Promise(r=>setTimeout(r,20));h.audio.muted=true;h.finished('muted_tail');
  await new Promise(r=>setTimeout(r,160));const recording=h.window.__voiceAcceptance.drain().recordings[0];
  assert.equal(recording.stopReason,'native_output_inactive');assert.equal(recording.partial,true);
 }finally{await h.cleanup();}
});
