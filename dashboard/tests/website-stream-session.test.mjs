import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const vite=await createServer({root:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),appType:'custom',logLevel:'silent',server:{middlewareMode:true,hmr:false,ws:false}});
const {startVoiceSession,resolveOnboardingOutcome,readWebsiteInterviewStream}=await vite.ssrLoadModule('/src/voice/session.js');
after(()=>vite.close());
const callId='11111111-1111-4111-8111-111111111111';
const descriptor={schema:'onboarding.stream.v1',action:{callId,interviewId:callId,actionId:'a'.repeat(64),sourceDigest:'b'.repeat(64),revision:0,kind:'ASK_NEXT_GAP',text:'Oi! Aqui é o Ligou, agente de inteligência artificial da Empresa. Eu já analisei seu website. Quais cidades sua empresa atende?'},dispatchId:'22222222-2222-4222-8222-222222222222',receiptId:'33333333-3333-4333-8333-333333333333'};
const response={call_id:callId,sdp:'answer',max_minutes:55,business_name:'Empresa',onboarding_protocol_version:4,opening_mode_applied:'realtime_stream_v1',opening_payload:{version:4,stream:descriptor}};
const vad={type:'session.updated',session:{output_modalities:['text'],tools:[],audio:{input:{turn_detection:{type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false}}}}};
const nativeVad={type:'session.updated',event_id:'native_session_config',session:{output_modalities:['audio'],tools:[{type:'function',name:'save_owner_answer'}],audio:{input:{turn_detection:{type:'semantic_vad',eagerness:'medium',create_response:true,interrupt_response:true}}}}};
const nativeResponse={...response,onboarding_protocol_version:5,opening_mode_applied:'realtime_native_v1',
 opening_payload:{version:5,native:{callId,interviewId:callId,revision:0,sourceDigest:'b'.repeat(64)}}};
const metadata={ligou_transport:'realtime_stream_v1',ligou_call_id:callId,ligou_action_id:descriptor.action.actionId,ligou_source_digest:descriptor.action.sourceDigest,ligou_dispatch_id:descriptor.dispatchId};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail('expected stream browser state');}
function browser({payload=response,blockAudio=false,holdChannel=false,autoStart=true}={}){
 const keys=['navigator','document','RTCPeerConnection','AudioContext','fetch'];
 const original=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const state={requests:[],audios:[],mic:{enabled:true,stopped:false,stop(){this.stopped=true;}},peers:[],sent:[],permission:0,amplitude:.2};
 const define=(key,value)=>Object.defineProperty(globalThis,key,{value,configurable:true});
 const stream=()=>({getTracks:()=>[{stop(){}}],getAudioTracks:()=>[{}],clone:()=>stream()});
 class Audio extends EventTarget {muted=true;volume=1;paused=true;srcObject=null;playCalls=0;
  play(){this.playCalls++;if(blockAudio)return Promise.reject(new Error('autoplay'));this.paused=false;this.dispatchEvent(new Event('playing'));this.onplaying?.();return Promise.resolve();}pause(){this.paused=true;}}
 class Peer {connectionState='new';closeCalls=0;
  constructor(){state.peers.push(this);}addTrack(){}createOffer(){state.beforeOffer={events:typeof state.channel.onmessage==='function',close:typeof state.channel.onclose==='function',microphoneEnabled:state.mic.enabled};return Promise.resolve({type:'offer',sdp:'offer'});}setLocalDescription(){return Promise.resolve();}
  createDataChannel(){const channel=new EventTarget();channel.readyState=holdChannel?'connecting':'open';channel.sent=state.sent;
   channel.emit=e=>channel.onmessage?.({data:JSON.stringify(e)});channel.open=()=>{channel.readyState='open';channel.dispatchEvent(new Event('open'));channel.onopen?.();};
   channel.close=()=>{channel.readyState='closed';channel.onclose?.();};
   channel.send=body=>state.sent.push(JSON.parse(body));state.channel=channel;return channel;}
  setRemoteDescription(){this.ontrack?.({streams:[stream()]});if(autoStart)state.channel.emit(payload.onboarding_protocol_version===6?{type:'session.started',session:{id:payload.opening_payload.live.sessionId,model:'gpt-live-1',delegation:{type:'responses'}}}:payload.onboarding_protocol_version===5?nativeVad:vad);return Promise.resolve();}
  close(){this.closeCalls++;this.connectionState='closed';}}
 define('navigator',{mediaDevices:{getUserMedia:async()=>{state.permission++;return{getTracks:()=>[state.mic]};}}});
 define('document',{createElement:()=>{const audio=new Audio();state.audios.push(audio);return audio;}});
 define('RTCPeerConnection',Peer);
 define('AudioContext',class{state='running';resume(){return Promise.resolve();}close(){return Promise.resolve();}createMediaStreamSource(){return{connect(){},disconnect(){}};}createAnalyser(){return{fftSize:512,getFloatTimeDomainData(array){array.fill(state.amplitude);}};}});
 define('fetch',async(_url,options)=>{state.requests.push(JSON.parse(options.body));return{ok:true,json:async()=>payload};});
 state.restore=()=>{state.channel?.close();for(const[key,value]of original){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}};
 state.begin=()=>{state.channel.emit({type:'response.created',response:{id:'response_1',status:'in_progress',metadata}});state.channel.emit({type:'output_audio_buffer.started',event_id:'buffer_start',response_id:'response_1'});};
 state.finish=()=>{state.amplitude=0;state.channel.emit({type:'response.done',response:{id:'response_1',status:'completed',metadata,output:[{id:'item_1',type:'message',role:'assistant',status:'completed',content:[{type:'audio',transcript:descriptor.action.text}]}]}});state.channel.emit({type:'output_audio_buffer.stopped',event_id:'buffer_stop',response_id:'response_1'});};
 return state;
}
for(const protocol of[2,3,4])test(`new onboarding rejects legacy protocol ${protocol} before microphone or provider work`,async()=>{
 const b=browser();try{await assert.rejects(startVoiceSession({sessionType:'onboarding',onboardingProtocolVersion:protocol,accessToken:'test'}),e=>e.code==='client_upgrade_required');assert.equal(b.permission,0);assert.equal(b.requests.length,0);}finally{b.restore();}
});
test('native autoplay failure never sends ready and closes output',async()=>{
 const b=browser({payload:nativeResponse,blockAudio:true});try{await assert.rejects(startVoiceSession({sessionType:'onboarding',onboardingProtocolVersion:5,accessToken:'test',stopTimeoutMs:10}));assert.equal(b.sent.some(e=>e.item.content[0].text.startsWith('ligou.website_native_ready:')),false);assert.equal(b.audios[0].muted,true);assert.equal(b.mic.stopped,true);}finally{b.restore();}
});
test('historical exported stream read still reconciles one transient read without changing the new native startup path',async()=>{
 let reads=0;const result=await readWebsiteInterviewStream({callId,actionId:descriptor.action.actionId,dispatchId:descriptor.dispatchId,
  client:{rpc(){reads++;return Promise.resolve(reads===1?{status:0,error:{message:'TypeError: Failed to fetch'}}:{status:200,data:descriptor,error:null});}}});
 assert.equal(reads,2);assert.deepEqual(result,descriptor);
});

for(const failure of [{status:401,error:{code:'PGRST301'}},{status:403,error:{code:'42501'}},
 {status:500,error:{code:'42501'}},{status:400,error:{code:'22023'}},{error:new TypeError('Cannot read properties of undefined')}])
test(`stream read does not retry authority or non-network failure ${failure.status??'programming error'}/${failure.error.code??''}`,async()=>{
 let reads=0,retries=0;const events=[];
 await assert.rejects(readWebsiteInterviewStream({client:{rpc(){reads++;return Promise.resolve(failure);}},callId,actionId:descriptor.action.actionId,dispatchId:descriptor.dispatchId,
  onRetry:()=>retries++,onAttemptFailure:e=>events.push(e)}));
 assert.equal(reads,1);assert.equal(retries,0);assert.deepEqual(Object.keys(events[0]).sort(),['attempt','code','status']);
});
test('stream read retry is bounded and Stop cancels the retry delay',async()=>{
 let reads=0;const args={callId,actionId:descriptor.action.actionId,dispatchId:descriptor.dispatchId};
 const client={rpc(){reads++;return Promise.resolve({status:503,error:{message:'unavailable'}});}};
 await assert.rejects(readWebsiteInterviewStream({...args,client}));assert.equal(reads,2);
 const controller=new AbortController();reads=0;
 await assert.rejects(readWebsiteInterviewStream({...args,client,signal:controller.signal,onRetry:()=>controller.abort('manual_hangup')}),e=>e.name==='AbortError');
 assert.equal(reads,1);
});
test('a retired stream read remains a null result rather than being retried',async()=>{
 let reads=0;const value=await readWebsiteInterviewStream({client:{rpc(){reads++;return Promise.resolve({status:200,error:null,data:null});}},callId,actionId:descriptor.action.actionId,dispatchId:descriptor.dispatchId});
 assert.equal(value,null);assert.equal(reads,1);
});
test('protocol4 outcome uses website receipts and preserves approval separately from termination',async()=>{
 const result=await resolveOnboardingOutcome({onboardingProtocolVersion:4,client:{rpc:()=>Promise.resolve({error:null,data:{callId,currentCallId:callId,interviewId:callId,revision:3,state:'closing',approvalReceiptId:'33333333-3333-4333-8333-333333333333',terminal:{outcome:'unfinished'},budgetStatus:'settled',providerTerminationState:'confirmed'}})},callId,reason:'manual_hangup'});
 assert.deepEqual(result,{status:'approved',revision:3,protocolVersion:4,approvalReceiptId:'33333333-3333-4333-8333-333333333333'});
});
test('explicit rollback onboarding uses native protocol5 and actual remote samples before startup resolves, while preserving Stop',async()=>{
 const b=browser({payload:nativeResponse}),timings=[],captions=[];let current,settled=false;
 const starting=startVoiceSession({sessionType:'onboarding',onboardingProtocolVersion:5,accessToken:'test',
  onTiming:e=>timings.push(e),onEvent:e=>captions.push(e),stopTimeoutMs:20}).then(value=>{settled=true;return value;});starting.catch(()=>{});
 try{
  await until(()=>b.sent.some(e=>e.item?.content?.[0]?.text?.startsWith('ligou.website_native_ready:')));
  assert.deepEqual(b.requests,[{sdp:'offer',session_type:'onboarding',opening_mode_requested:'realtime_native_v1',onboarding_protocol_version:5,speech_contract_version:3}]);
  assert.equal(b.audios.length,1);assert.equal(b.audios[0].src,undefined);assert.equal(b.audios[0].muted,false);assert.equal(b.mic.enabled,true);assert.equal(settled,false);
  b.channel.emit({type:'response.created',response:{id:'native_1',output_modalities:['audio'],status:'in_progress'}});
  b.channel.emit({type:'output_audio_buffer.started',event_id:'native_buffer_start',response_id:'native_1'});
  current=await starting;assert.ok(timings.some(e=>e.event==='speech_first_nonzero_sample'&&e.transport==='realtime_native_v1'));
  b.channel.emit({type:'input_audio_buffer.speech_started',item_id:'native_owner_1'});assert.equal(b.mic.enabled,true);
  b.channel.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'native_owner_1',transcript:'Pode começar.'});
  assert.deepEqual(captions,[{kind:'caller',text:'Pode começar.'}]);
  current.end('manual_hangup');assert.equal(b.mic.stopped,true);assert.equal(b.peers[0].closeCalls,0);
  assert.equal(b.sent.filter(e=>e.item.content[0].text.startsWith('ligou.website_stop:')).length,1);
  b.channel.close();assert.equal(b.peers[0].closeCalls,1);
 }finally{current?.end('manual_hangup');b.channel?.close();await starting.catch(()=>{});b.restore();}
});

test('native bootstrap mismatch cannot open the microphone or send native ready',async()=>{
 for(const changes of [{callId:'44444444-4444-4444-8444-444444444444'}, {sourceDigest:'not-a-hash'}, {approval:true}]){
  const payload=structuredClone(nativeResponse);Object.assign(payload.opening_payload.native,changes);const b=browser({payload});
  try{await assert.rejects(startVoiceSession({sessionType:'onboarding',onboardingProtocolVersion:5,accessToken:'test',speechClient:{rpc(){}},stopTimeoutMs:10}));
   assert.equal(b.sent.length,0);assert.equal(b.audios[0].muted,true);assert.equal(b.mic.stopped,true);
  }finally{b.restore();}
 }
});

test('native first-audio deadline still terminates an otherwise ready but silent connection',async()=>{
 const b=browser({payload:nativeResponse}),timings=[];
 const starting=startVoiceSession({sessionType:'onboarding',onboardingProtocolVersion:5,accessToken:'test',speechClient:{rpc(){}},
  connectionTimeoutMs:40,stopTimeoutMs:10,onTiming:event=>timings.push(event)});starting.catch(()=>{});
 try{
  await until(()=>b.sent.some(e=>e.item?.content?.[0]?.text?.startsWith('ligou.website_native_ready:')));
  await assert.rejects(starting);assert.equal(b.mic.stopped,true);assert.equal(b.audios[0].muted,true);
  assert.equal(timings.some(event=>event.event==='speech_first_nonzero_sample'),false);
 }finally{b.channel?.close();await starting.catch(()=>{});b.restore();}
});

test('native protocol5 resolves eligible reviewing resume through the website receipt path',async()=>{
 const reads=[];const result=await resolveOnboardingOutcome({onboardingProtocolVersion:5,callId,reason:'manual_hangup',client:{rpc(name,args){reads.push({name,args});return Promise.resolve({error:null,data:{callId,currentCallId:callId,interviewId:callId,revision:95,state:'reviewing',completed:false,resumeEligible:true,digest:'b'.repeat(64),callStatus:'ended',providerTerminationState:'confirmed',budgetStatus:'settled',terminal:{outcome:'unfinished'}}});}}});
 assert.deepEqual(reads,[{name:'get_website_interview_status',args:{p_call:callId}}]);
 assert.equal(result.status,'resumable');assert.equal(result.resumeState,'reviewing');assert.equal(result.protocolVersion,5);
});

const liveResponse={...response,model:'gpt-live-1',onboarding_protocol_version:6,opening_mode_applied:'live_managed_v1',
 opening_payload:{version:6,live:{callId,interviewId:callId,revision:0,sourceDigest:'b'.repeat(64),sessionId:'live_session_1'}}};
const liveClosed=(seconds=12)=>({type:'session.closed',session:{id:'live_session_1'},reason:'close_requested',usage:{seconds}});
test('default Live starts full duplex without Realtime commands or waiting for a transcript',async()=>{
 const b=browser({payload:liveResponse}),timings=[],captions=[],ends=[];let current;
 try{
  current=await startVoiceSession({sessionType:'onboarding',accessToken:'test',onTiming:e=>timings.push(e),onEvent:e=>captions.push(e),onEnd:e=>ends.push(e)});
  assert.deepEqual(b.requests,[{sdp:'offer',session_type:'onboarding',model:'gpt-live-1',opening_mode_requested:'live_managed_v1',onboarding_protocol_version:6}]);
  assert.equal(b.mic.enabled,true);assert.equal(b.audios[0].muted,false);assert.equal(b.sent.length,0);
  assert.deepEqual(b.beforeOffer,{events:true,close:true,microphoneEnabled:true});
  b.channel.emit({type:'session.output_transcript.delta',event_id:'out1',delta:'Oi, ',start_ms:0,end_ms:700});
  b.channel.emit({type:'session.input_transcript.delta',event_id:'in1',delta:'Quero corrigir.',start_ms:400,end_ms:950});
  assert.equal(b.mic.enabled,true);assert.equal(captions.length,2);assert.equal(captions[0].text,'Oi, ');
  b.channel.emit({type:'session.usage.updated',usage:{seconds:10}});b.channel.emit({type:'session.usage.updated',usage:{seconds:9}});
  current.end('manual_hangup');current.end('manual_hangup');
  assert.equal(b.mic.enabled,false);assert.equal(b.mic.stopped,false);assert.equal(b.audios[0].muted,true);
  assert.equal(b.peers[0].closeCalls,0);assert.deepEqual(b.sent.map(e=>e.type),['session.close']);assert.equal(ends.length,0);
  b.channel.emit(liveClosed(12));assert.equal(ends.length,1);assert.equal(ends[0].providerFinalized,true);assert.equal(ends[0].seconds,12);
  assert.equal(ends[0].finalUsageConfirmed,true);assert.equal(b.mic.stopped,true);assert.equal(b.peers[0].closeCalls,1);
  b.channel.close();assert.equal(ends.length,1);assert.equal(timings.some(e=>e.event==='live_finalization_incomplete'),false);
 }finally{b.channel?.close();b.restore();}
});
test('Live Stop during known-call startup waits for session.started before sending close and never unmutes',async()=>{
 const b=browser({payload:liveResponse}),ends=[];
 try{
  await assert.rejects(startVoiceSession({sessionType:'onboarding',accessToken:'test',stopTimeoutMs:25,
   onCallCreated:session=>session.end('manual_hangup'),onEnd:e=>ends.push(e)}));
  assert.deepEqual(b.sent.map(e=>e.type),['session.close']);assert.equal(b.audios[0].muted,true);assert.equal(b.mic.enabled,false);
  assert.equal(b.mic.stopped,true);assert.equal(ends[0].providerFinalized,false);
 }finally{b.restore();}
});
test('Live Stop failure releases devices with incomplete finalization instead of claiming success',async()=>{
 const b=browser({payload:liveResponse}),ends=[];let current;
 try{
  current=await startVoiceSession({sessionType:'onboarding',accessToken:'test',stopTimeoutMs:10,onEnd:e=>ends.push(e)});
  current.end('manual_hangup');await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(b.mic.stopped,true);assert.equal(b.peers[0].closeCalls,1);assert.equal(ends[0].providerFinalized,false);
  assert.match(ends[0].message,/reconciliada/);
 }finally{b.restore();}
});
test('Live transport loss without final event is incomplete; a nonfatal provider error does not stop audio',async()=>{
 const b=browser({payload:liveResponse}),ends=[];let current;
 try{
  current=await startVoiceSession({sessionType:'onboarding',accessToken:'test',onEnd:e=>ends.push(e)});
  b.channel.emit({type:'error',error:{code:'moderation_interruption'}});assert.equal(b.mic.enabled,true);assert.equal(ends.length,0);
  b.channel.close();assert.equal(ends.length,1);assert.equal(ends[0].providerFinalized,false);assert.equal(b.mic.stopped,true);
 }finally{b.restore();}
});
test('Live cannot silently use a Realtime model or accept a mismatched provider session',async()=>{
 const b=browser({payload:liveResponse,autoStart:false});
 try{
  await assert.rejects(startVoiceSession({sessionType:'onboarding',accessToken:'test',model:'gpt-realtime-2.1-mini'}),e=>e.code==='live_model_mismatch');
  assert.equal(b.permission,0);assert.equal(b.requests.length,0);
  const started=startVoiceSession({sessionType:'onboarding',accessToken:'test',connectionTimeoutMs:30,stopTimeoutMs:5});started.catch(()=>{});
  await until(()=>b.channel&&b.audios[0].srcObject);
  b.channel.emit({type:'session.started',session:{id:'foreign',model:'gpt-live-1',delegation:{type:'responses'}}});
  await assert.rejects(started);assert.equal(b.mic.stopped,true);assert.equal(b.sent.length,0);
 }finally{b.restore();}
});
test('Live native autoplay failure releases the session and never switches to recorded audio',async()=>{
 const b=browser({payload:liveResponse,blockAudio:true});
 try{
  await assert.rejects(startVoiceSession({sessionType:'onboarding',accessToken:'test',stopTimeoutMs:5}));
  assert.deepEqual(b.sent.map(e=>e.type),['session.close']);assert.equal(b.mic.stopped,true);assert.equal(b.audios.length,1);assert.equal(b.audios[0].src,undefined);
 }finally{b.restore();}
});
test('Live outcome uses durable website status; transport finalization alone cannot approve',async()=>{
 const result=await resolveOnboardingOutcome({onboardingProtocolVersion:6,callId,reason:'remote_hangup',
  client:{rpc:()=>Promise.resolve({error:null,data:{callId,currentCallId:callId,interviewId:callId,revision:3,state:'unfinished',completed:false,
   resumeEligible:true,digest:'b'.repeat(64),callStatus:'ended',providerTerminationState:'confirmed',budgetStatus:'settled',terminal:{outcome:'unfinished'}}})}});
 assert.equal(result.status,'resumable');assert.equal(result.protocolVersion,6);
});
