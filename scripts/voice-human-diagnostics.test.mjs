import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {buildHumanDiagnosticsSource,redactHumanDiagnostics,projectHumanDiagnosticEvent,projectHumanAudioStats} from './voice-human-diagnostics.mjs';

function database(fail=()=>false){
 const rows=new Map();let initialized=false;
 const db={createObjectStore:()=>({createIndex(){}}),close(){},transaction(){
  const tx={},operations=[];
  const getAll=(range,kind)=>{const request={};operations.push({type:'read',request,range,kind});return request;};
  const store={put(value){operations.push({type:'write',value:structuredClone(value)});return {};},getAll:range=>getAll(range),index:()=>({getAll:kind=>getAll(null,kind)})};
  tx.objectStore=()=>store;
  setTimeout(()=>{
   if(operations.some(op=>op.type==='write'&&fail(op.value))){tx.onerror?.();return;}
   for(const op of operations){
    if(op.type==='write')rows.set(JSON.stringify([op.value.runId,op.value.seq]),op.value);
    else{op.request.result=[...rows.values()].filter(row=>op.kind?row.kind===op.kind:!op.range||row.runId===op.range.low[0]&&row.seq>=op.range.low[1]&&row.seq<=op.range.high[1]).map(row=>structuredClone(row));op.request.onsuccess?.();}
   }tx.oncomplete?.();
  },0);return tx;
 }};
 return{rows,open(){const request={};setTimeout(()=>{request.result=db;if(!initialized){initialized=true;request.onupgradeneeded?.();}request.onsuccess?.();},0);return request;}};
}
function browser({db=database(),storage=new Map(),origin='https://test.example',pathname='/dashboard/setup/website',armed=true,lockGum=false}={}){
 class Track extends EventTarget{
  constructor(id,kind='audio'){super();this.id=id;this.kind=kind;this.enabled=true;this.muted=false;this.readyState='live';this.stopCalls=0;}
  clone(){const clone=new Track(this.id+'-clone',this.kind);clone.enabled=this.enabled;this.lastClone=clone;return clone;}
  stop(){this.stopCalls++;this.readyState='ended';} // stop intentionally emits no ended event.
  getSettings(){return {echoCancellation:true,noiseSuppression:true,autoGainControl:true,sampleRate:48000,deviceId:'private-device',groupId:'private-group'};}
 }
 class Stream{constructor(tracks){this.tracks=tracks;}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}getTracks(){return this.tracks;}}
 const recorders=[];
 class Recorder{
  static isTypeSupported(){return true;}
  constructor(stream,options={}){this.stream=stream;this.mimeType=options.mimeType||'audio/webm';this.state='inactive';recorders.push(this);}
  start(timeslice){this.state='recording';this.timeslice=timeslice;this.chunk('header');}
  chunk(value){this.ondataavailable?.({data:new Blob([value],{type:this.mimeType})});}
  stop(){this.state='inactive';queueMicrotask(()=>{this.chunk('tail');this.onstop?.();});}
 }
 class Channel extends EventTarget{constructor(){super();this.sent=[];this.readyState='open';}send(value){this.sent.push(value);}message(value){this.dispatchEvent(Object.assign(new Event('message'),{data:JSON.stringify(value)}));}}
 class Peer extends EventTarget{constructor(){super();this.connectionState='connected';this.iceConnectionState='connected';this.signalingState='stable';}createDataChannel(){return new Channel();}getStats(){return Promise.resolve(new Map([['audio',{id:'audio',type:'inbound-rtp',kind:'audio',packetsLost:2,jitter:0.03,concealedSamples:12,jitterBufferDelay:0.1,jitterBufferEmittedCount:42,address:'not-exported'}]]));}}
 class Audio extends EventTarget{constructor(){super();this.muted=false;this.volume=1;this.paused=false;this.ended=false;this.readyState=4;this.promise=Promise.resolve();}play(){return this.promise;}}
 const track=new Track('microphone'),stream=new Stream([track]),gumPromise=Promise.resolve(stream),calls=[];
 let currentGumPromise=gumPromise;
 const mediaDevices={getUserMedia(...args){calls.push({receiver:this,args});return currentGumPromise;}};
 if(lockGum)Object.defineProperty(mediaDevices,'getUserMedia',{value:mediaDevices.getUserMedia,writable:false});
 const target=new EventTarget(),documentTarget=new EventTarget(),intervals=[];
 const globals={location:{origin,pathname},crypto:webcrypto,Blob,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,MediaStream:Stream,MediaRecorder:Recorder,RTCPeerConnection:Peer,HTMLMediaElement:Audio,
  navigator:{mediaDevices},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},indexedDB:db,
  IDBKeyRange:{bound:(low,high)=>({low,high})},performance:{now:()=>performance.now()},
  setTimeout,clearTimeout,setInterval(fn,ms){const value={fn,ms,active:true};intervals.push(value);return value;},clearInterval:value=>{if(value)value.active=false;},
  btoa:value=>Buffer.from(value,'binary').toString('base64'),document:{body:null,addEventListener:documentTarget.addEventListener.bind(documentTarget)},
  addEventListener:target.addEventListener.bind(target),dispatchEvent:target.dispatchEvent.bind(target)};
 globals.window=globals;
 const context=vm.createContext(globals),source=buildHumanDiagnosticsSource({origin:'https://test.example',pathname:'/dashboard/setup/website',armed});
 vm.runInContext(source,context);
 const emit=(name,detail)=>target.dispatchEvent(Object.assign(new Event(name),{detail}));
 return{context,api:context.__ligouHumanDiagnostics,emit,track,stream,gumPromise,calls,recorders,intervals,Track,Audio,NativePeer:Peer,db,storage,source,setMicrophone(track){currentGumPromise=Promise.resolve(new Stream([track]));}};
}
async function start(h,{attemptId='11111111-1111-4111-8111-111111111111'}={}){await h.api.ready;h.emit('ligou:voice-timing',{event:'start',attemptId});await h.context.navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true},video:false});await Promise.resolve();
 const peer=new h.context.RTCPeerConnection(),output=new h.Track('remote');peer.dispatchEvent(Object.assign(new Event('track'),{track:output}));return{peer,output};}
async function archive(h){const descriptor=await h.api.exportLatest(),pieces=[];for(let i=0;i<descriptor.parts;i++){const part=await h.api.exportChunk(descriptor.runId,i);assert(Buffer.byteLength(JSON.stringify(part))<=256*1024);pieces.push(Buffer.from(part.data,'base64'));}
 const bytes=Buffer.concat(pieces);assert.equal(bytes.length,descriptor.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),descriptor.sha256);return{descriptor,data:JSON.parse(bytes)};}

test('business tool content survives while credentials, prompts and auth envelopes are redacted',async()=>{
 const secret='sk-'+'fixture-private-canary-123456789';
 const projected=await projectHumanDiagnosticEvent({type:'response.done',response:{id:'response_1',status:'cancelled',status_details:{type:'cancelled',reason:'turn_detected'},
  output:[{type:'function_call',name:'submit_website_interview_proposal',call_id:'tool_1',arguments:JSON.stringify({proposal:{kind:'answer'},interpretation:'Somente cidades definidas; exceções exigem aprovação.',headers:{Authorization:'Bearer '+secret},password:secret})}]}},'provider');
 const text=JSON.stringify(projected);assert(!text.includes(secret));assert(text.includes('exceções exigem aprovação'));assert.equal(projected.response.status_details.reason,'turn_detected');
 const config=await projectHumanDiagnosticEvent({type:'session.updated',session:{model:'gpt-realtime-2.1-mini',instructions:'private prompt '+secret,client_secret:{value:secret},
  audio:{input:{turn_detection:{type:'semantic_vad',create_response:true}},output:{voice:'ash'}}}},'provider');
 assert.equal(config.configuration.promptSha256,createHash('sha256').update('private prompt '+secret).digest('hex'));assert(!JSON.stringify(config).includes(secret));
 assert.equal(projectHumanDiagnosticEvent({type:'response.output_audio.delta',delta:secret},'provider'),null);
 assert.equal(redactHumanDiagnostics({refresh_token:secret}).value.refresh_token,'[redacted]');
});
test('stats select audio quality counters without IP/certificate data',()=>{
 const rows=projectHumanAudioStats(new Map([['a',{type:'inbound-rtp',kind:'audio',jitter:0.1,packetsLost:2,concealedSamples:3,jitterBufferDelay:4,remoteAddress:'private'}],['b',{type:'candidate-pair',address:'private'}]]));
 assert.equal(rows.length,1);assert.equal(rows[0].concealedSamples,3);assert(!JSON.stringify(rows).includes('private'));
});
test('fragmented arguments and transcripts retain event identity without leaking secret fragments',async()=>{
 const chunks=['{"myApiKey":"','private-canary-without-prefix','"}'];
 for(const type of ['response.function_call_arguments.delta','response.output_audio_transcript.delta'])for(let index=0;index<chunks.length;index++){
  const projected=await projectHumanDiagnosticEvent({type,event_id:'delta_'+index,call_id:'tool_1',delta:chunks[index]},'provider');
  assert.equal(projected.event_id,'delta_'+index);assert.equal(projected.deltaChars,chunks[index].length);assert.equal(Object.hasOwn(projected,'delta'),false);
 }
 const done=await projectHumanDiagnosticEvent({type:'response.function_call_arguments.done',call_id:'tool_1',arguments:JSON.stringify({myApiKey:'private-canary-without-prefix',interpretation:'Apenas território aprovado.'})},'provider');
 assert.equal(done.arguments.myApiKey,'[redacted]');assert.equal(done.arguments.interpretation,'Apenas território aprovado.');
});
test('installation is scoped and once-only; gUM promise, stream and constraints pass through unchanged',async()=>{
 const outside=browser({origin:'https://other.example'});assert.equal(outside.api,undefined);
 const h=browser();await h.api.ready;const api=h.api;vm.runInContext(h.source,h.context);assert.equal(h.context.__ligouHumanDiagnostics,api);
 const constraints={audio:{echoCancellation:true},video:false};const returned=h.context.navigator.mediaDevices.getUserMedia(constraints);
 assert.equal(returned,h.gumPromise);assert.equal(await returned,h.stream);assert.equal(h.calls[0].args[0],constraints);assert.equal(h.recorders.length,0);
 await h.api.disable();
});
test('real tracks are recorded continuously; source stop closes only its clone even without ended event',async()=>{
 const h=browser(),{peer,output}=await start(h);const channel=peer.createDataChannel('oai-events');
 assert.equal(h.recorders.length,2);assert.equal(h.recorders[0].timeslice,500);
 channel.message({type:'response.created',response:{id:'r1',metadata:{native_request_id:'11111111-1111-4111-8111-111111111111'}}});
 channel.message({type:'input_audio_buffer.speech_started',item_id:'owner1'});channel.message({type:'response.created',response:{id:'r2'}});
 assert(h.recorders.every(r=>r.state==='recording'),'response/VAD events must not split continuous audio');
 h.recorders.find(r=>r.stream.getAudioTracks()[0].id==='microphone-clone').chunk('middle');h.track.stop();assert.equal(h.track.stopCalls,1);assert.equal(h.track.lastClone.readyState,'ended');assert.equal(output.readyState,'live');
 h.emit('ligou:voice-timing',{event:'session_ended',attemptId:'11111111-1111-4111-8111-111111111111',callId:'22222222-2222-4222-8222-222222222222'});await h.api.disable();
 assert.equal(output.readyState,'live');assert.equal(output.lastClone.readyState,'ended');
 const {descriptor,data}=await archive(h);assert.equal(descriptor.complete,true);
 assert.deepEqual(data.records.map(r=>r.seq),Array.from({length:data.records.length},(_,i)=>i+1));
 for(const direction of ['input','output']){
  const chunks=data.records.filter(r=>r.kind==='audio.chunk'&&r.data.direction===direction),end=data.records.find(r=>r.kind==='audio.end'&&r.data.direction===direction);
  assert.deepEqual(chunks.map(r=>r.data.chunkIndex),Array.from({length:chunks.length},(_,i)=>i));assert.equal(end.data.finalChunkIndex,chunks.length-1);
  assert.equal(Buffer.concat(chunks.map(r=>Buffer.from(r.data.base64,'base64'))).toString(),direction==='input'?'headermiddletail':'headertail');
 }assert(h.intervals.every(i=>!i.active));
});
test('client sends, provider results and stats are captured without changing channel behavior',async()=>{
 const h=browser(),{peer}=await start(h),channel=peer.createDataChannel('events'),request=JSON.stringify({type:'response.cancel',event_id:'cancel1',response_id:'response1'});
 channel.send(request);assert.equal(channel.sent[0],request);
 channel.message({type:'conversation.item.created',item:{type:'function_call_output',call_id:'tool1',output:JSON.stringify({saved:false,code:'proposal_not_admitted',recovery:'retry_same_response',context:{current_item:{id:'known'}}})}});
 await h.intervals[0].fn();await new Promise(resolve=>setTimeout(resolve,5));await h.api.disable();
 const {data}=await archive(h);assert(data.records.some(r=>r.data.type==='response.cancel'&&r.data.direction==='client'));
 const result=data.records.find(r=>r.data.item?.output);assert.equal(result.data.item.output.code,'proposal_not_admitted');assert.equal(result.data.item.output.context.current_item.id,'known');
 assert(data.records.some(r=>r.kind==='audio.stats'&&r.data.rows[0].jitterBufferEmittedCount===42));
 assert.equal(data.records.find(r=>r.kind==='microphone.requested').data.audio.echoCancellation,true);
 assert.equal(data.records.find(r=>r.kind==='audio.start'&&r.data.direction==='input').data.original.settings.noiseSuppression,true);
 assert(!JSON.stringify(data).includes('private-device'));assert(!JSON.stringify(data).includes('private-group'));
});
test('storage failures do not alter voice and exported sequence gaps are explicit',async()=>{
 let failed=false;const db=database(row=>{if(row.kind==='wire'&&!failed){failed=true;return true;}return false;});
 const h=browser({db}),{peer}=await start(h),channel=peer.createDataChannel('events');channel.message({type:'response.created',response:{id:'gap_response'}});
 await h.api.disable();assert.equal(h.track.readyState,'live');const {descriptor,data}=await archive(h);
 assert.equal(descriptor.complete,false);assert.equal(h.api.status().storageError,true);assert(data.manifest.gaps.length>0);
 assert(data.manifest.errors.some(e=>e.code==='record_persistence_failed'));
});
test('failed final commit and pagehide cannot become a complete capture after reinstall',async()=>{
 const db=database(row=>row.kind==='capture.end'),storage=new Map(),h=browser({db,storage});await start(h);await h.api.disable();
 const restarted=browser({db,storage:new Map()});await restarted.api.ready;const {descriptor,data}=await archive(restarted);assert.equal(descriptor.complete,false);assert.equal(data.manifest.interruptedDocument,true);
 await restarted.api.disable();
 const leaving=browser();const {output}=await start(leaving);leaving.emit('pagehide');assert.equal(leaving.track.lastClone.readyState,'ended');assert.equal(output.lastClone.readyState,'ended');await leaving.api.disable();
 assert.equal((await archive(leaving)).descriptor.complete,false);
});
test('mandatory hook failure is visible as not ready and cannot block the original microphone API',async()=>{
 const h=browser({lockGum:true});assert.equal((await h.api.ready).ready,false);assert.equal(h.api.status().hooks.getUserMedia,false);
 assert.equal(await h.context.navigator.mediaDevices.getUserMedia({audio:true}),h.stream);await h.api.disable();
});
test('redaction handles lowercase bearer, sensitive key variants, SDP errors and manifest fields',async()=>{
 const secret='sk-'+'extra-canary-123456789';
 assert.equal(redactHumanDiagnostics({myApiKey:secret}).value.myApiKey,'[redacted]');
 assert(!JSON.stringify(redactHumanDiagnostics({text:'bearer '+secret})).includes(secret));
 const event=await projectHumanDiagnosticEvent({type:'error',error:{code:'invalid_sdp',param:'sdp',message:'v=0\r\na=ice-pwd:'+secret}},'provider');
 assert.equal(event.error.message,undefined);assert(!JSON.stringify(event).includes(secret));
 const h=browser();await start(h);h.emit('ligou:voice-timing',{event:'bootstrap_response',attemptId:'11111111-1111-4111-8111-111111111111',callId:'bearer '+secret});await h.api.disable();
 assert(!JSON.stringify((await archive(h)).data).includes(secret));
});
test('a promptly rejected projection promise is handled before queued writes and reported separately',async()=>{
 const h=browser(),{peer}=await start(h),channel=peer.createDataChannel('events');
 h.context.crypto={randomUUID:webcrypto.randomUUID.bind(webcrypto),subtle:{digest:()=>Promise.reject(Error('synthetic hash failure'))}};
 channel.send(JSON.stringify({type:'session.update',session:{instructions:'request prompt'}}));
 await new Promise(resolve=>setTimeout(resolve,10));h.context.crypto=webcrypto;await h.api.disable();
 const {data}=await archive(h);assert(data.records.some(r=>r.kind==='diagnostic.error'&&r.data.code==='record_projection_failed'));
 assert.equal(data.manifest.complete,false);assert.equal(h.api.status().storageError,false);assert.equal(h.track.readyState,'live');
});
test('a newly opened tab recovers completed same-origin capture while another pathname remains excluded',async()=>{
 const db=database(),original=browser({db});await start(original);await original.api.disable();const first=await archive(original);
 const reopened=browser({db,storage:new Map()});await reopened.api.ready;const recovered=await archive(reopened);
 assert.equal(recovered.descriptor.complete,true);assert.equal(recovered.data.manifest.tabId,first.data.manifest.tabId);
 assert.deepEqual(recovered.data.records,first.data.records);
 const meta=db.rows.get(JSON.stringify([first.descriptor.runId,0]));meta.data.pathname='/another-page';
 assert.deepEqual(await reopened.api.list(),[]);await assert.rejects(()=>reopened.api.exportCapture(first.descriptor.runId),/capture_outside_scope/);
 await reopened.api.disable();
});
test('late channels and timing from capture A cannot enter, relabel or finish capture B',async()=>{
 const h=browser(),attemptA='11111111-1111-4111-8111-111111111111',attemptB='33333333-3333-4333-8333-333333333333';
 const callA='22222222-2222-4222-8222-222222222222',callB='44444444-4444-4444-8444-444444444444';
 const first=await start(h),oldChannel=first.peer.createDataChannel('events');
 h.emit('ligou:voice-timing',{event:'bootstrap_response',attemptId:attemptA,callId:callA});await h.api.disable();
 h.api.arm();h.setMicrophone(new h.Track('microphone-B'));const second=await start(h,{attemptId:attemptB}),currentId=h.api.status().runId;
 try{
  h.emit('ligou:voice-timing',{event:'bootstrap_response',attemptId:attemptA,callId:callA});
  h.emit('ligou:voice-timing',{event:'bootstrap_response',attemptId:attemptB,callId:callB});
  oldChannel.message({type:'response.created',response:{id:'old-provider-response'}});
  oldChannel.send(JSON.stringify({type:'response.cancel',event_id:'old-client-cancel'}));oldChannel.dispatchEvent(new Event('close'));
  first.peer.createDataChannel('late-created').message({type:'response.created',response:{id:'late-old-peer-response'}});
  second.peer.createDataChannel('current').message({type:'response.created',response:{id:'current-response'}});
  h.emit('ligou:voice-timing',{event:'session_ended',attemptId:attemptA,callId:callA});
  h.emit('ligou:voice-timing',{event:'session_ended',attemptId:attemptB,callId:callA});
  h.emit('ligou:voice-timing',{event:'session_ended',callId:callB});
  assert.equal(h.api.status().state,'recording');assert.equal(h.api.status().runId,currentId);
  h.emit('ligou:voice-timing',{event:'session_ended',attemptId:attemptB,callId:callB});
 }finally{await h.api.disable();}
 const {descriptor,data}=await archive(h);assert.equal(descriptor.complete,true);assert.equal(data.manifest.callId,callB);assert.equal(data.manifest.attemptId,attemptB);
 const text=JSON.stringify(data);assert(text.includes('current-response'));for(const absent of [callA,'old-provider-response','old-client-cancel','late-old-peer-response'])assert(!text.includes(absent));
 assert.equal(data.records.filter(r=>r.kind==='channel.state').length,0);assert.equal((await h.api.list()).length,2);
});
test('malformed function arguments and outputs retain only parse metadata and hash',async()=>{
 const malformed='{"apiKey":"opaque-canary-no-prefix"',expectedSha=createHash('sha256').update(malformed).digest('hex');
 const projections=[
  await projectHumanDiagnosticEvent({type:'response.function_call_arguments.done',call_id:'tool',arguments:malformed},'provider'),
  await projectHumanDiagnosticEvent({type:'conversation.item.created',item:{type:'function_call_output',call_id:'tool',output:malformed}},'provider'),
  await projectHumanDiagnosticEvent({type:'response.done',response:{id:'response',output:[{type:'function_call',call_id:'tool',arguments:malformed}]}},'provider'),
 ];
 for(const metadata of [projections[0].arguments,projections[1].item.output,projections[2].response.output[0].arguments]){
  assert.deepEqual({...metadata},{unparsed:true,chars:malformed.length,sha256:expectedSha});
 }
 assert(!JSON.stringify(projections).includes('opaque-canary-no-prefix'));
});

test('Live data-channel events keep timeline intervals and identity while transcript text becomes a count',async()=>{
 const secret='sk-live-canary-123456789',text='Oi, aqui é o Ligou '+secret;
 const delta=await projectHumanDiagnosticEvent({type:'session.output_transcript.delta',event_id:'out_1',delta:text,start_ms:1200,end_ms:2400},'provider');
 assert.equal(delta.deltaChars,text.length);assert.equal(delta.start_ms,1200);assert.equal(delta.end_ms,2400);assert.equal(Object.hasOwn(delta,'delta'),false);
 const started=await projectHumanDiagnosticEvent({type:'session.started',event_id:'evt_1',session:{id:'live_abc',model:'gpt-live-1',expires_at:1800000000,instructions:'private '+secret}},'provider');
 assert.equal(started.configuration.model,'gpt-live-1');assert.equal(started.configuration.id,'live_abc');assert.equal(started.configuration.expires_at,1800000000);assert(!JSON.stringify(started).includes(secret));
 const closed=await projectHumanDiagnosticEvent({type:'session.closed',event_id:'evt_9',reason:'close_requested',usage:{seconds:42},session:{id:'live_abc'}},'provider');
 assert.equal(closed.reason,'close_requested');assert.equal(closed.usage.seconds,42);
 assert.equal((await projectHumanDiagnosticEvent({type:'session.close',event_id:'c1'},'client')).type,'session.close');
 assert.notEqual(await projectHumanDiagnosticEvent({type:'info',event_id:'i1'},'provider'),null);
 assert.notEqual(await projectHumanDiagnosticEvent({type:'session.usage.updated',usage:{seconds:7}},'provider'),null);
 assert.equal(projectHumanDiagnosticEvent({type:'session.input_audio.delta',delta:secret},'provider'),null);
});
