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
const metadata={ligou_transport:'realtime_stream_v1',ligou_call_id:callId,ligou_action_id:descriptor.action.actionId,ligou_source_digest:descriptor.action.sourceDigest,ligou_dispatch_id:descriptor.dispatchId};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail('expected stream browser state');}
function browser({payload=response,blockAudio=false,holdChannel=false}={}){
 const keys=['navigator','document','RTCPeerConnection','AudioContext','fetch'];
 const original=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const state={requests:[],audios:[],mic:{enabled:true,stopped:false,stop(){this.stopped=true;}},peers:[],sent:[],permission:0,amplitude:.2};
 const define=(key,value)=>Object.defineProperty(globalThis,key,{value,configurable:true});
 const stream=()=>({getTracks:()=>[{stop(){}}],getAudioTracks:()=>[{}],clone:()=>stream()});
 class Audio extends EventTarget {muted=true;volume=1;paused=true;srcObject=null;playCalls=0;
  play(){this.playCalls++;if(blockAudio)return Promise.reject(new Error('autoplay'));this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve();}pause(){this.paused=true;}}
 class Peer {connectionState='new';closeCalls=0;
  constructor(){state.peers.push(this);}addTrack(){}createOffer(){return Promise.resolve({type:'offer',sdp:'offer'});}setLocalDescription(){return Promise.resolve();}
  createDataChannel(){const channel=new EventTarget();channel.readyState=holdChannel?'connecting':'open';channel.sent=state.sent;
   channel.emit=e=>channel.onmessage?.({data:JSON.stringify(e)});channel.open=()=>{channel.readyState='open';channel.dispatchEvent(new Event('open'));channel.onopen?.();};
   channel.close=()=>{channel.readyState='closed';channel.onclose?.();};
   channel.send=body=>state.sent.push(JSON.parse(body));state.channel=channel;return channel;}
  setRemoteDescription(){this.ontrack?.({streams:[stream()]});state.channel.emit(vad);return Promise.resolve();}
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
for(const protocol of[2,3])test(`new onboarding rejects legacy protocol ${protocol} before microphone or provider work`,async()=>{
 const b=browser();try{await assert.rejects(startVoiceSession({sessionType:'onboarding',onboardingProtocolVersion:protocol,accessToken:'test'}),e=>e.code==='client_upgrade_required');assert.equal(b.permission,0);assert.equal(b.requests.length,0);}finally{b.restore();}
});
test('one remote streaming element handles opening without an audio file; buffer completion gates ready and Stop retains transport',async()=>{
 const b=browser(),stages=[],timings=[],captions=[];let current;
 const starting=startVoiceSession({sessionType:'onboarding',accessToken:'test',onboardingProtocolVersion:4,speechClient:{rpc(){assert.fail('opening authorization already came through bootstrap');}},onStage:s=>stages.push(s),onTiming:e=>timings.push(e),onEvent:e=>captions.push(e),stopTimeoutMs:100});
 try{await until(()=>b.sent.length===1);
  assert.deepEqual(b.requests,[{sdp:'offer',session_type:'onboarding',opening_mode_requested:'realtime_stream_v1',onboarding_protocol_version:4,speech_contract_version:3}]);
  assert.equal(b.audios.length,1);assert.equal(b.audios[0].muted,true);
  b.begin();assert.equal(b.audios[0].muted,false);assert.equal(b.mic.enabled,true);
  await new Promise(resolve=>setTimeout(resolve,25));assert.ok(timings.some(e=>e.event==='speech_first_nonzero_sample'));
  assert.equal(stages.includes('ready'),false);b.finish();current=await starting;
  assert.equal(stages.at(-1),'ready');assert.equal(captions[0].text,descriptor.action.text);
  current.end('manual_hangup');assert.equal(b.mic.stopped,true);assert.equal(b.audios[0].muted,true);assert.equal(b.peers[0].closeCalls,0);
  assert.equal(b.sent.filter(e=>e.item.content[0].text.startsWith('ligou.website_stop:')).length,1);
  b.channel.close();assert.equal(b.peers[0].closeCalls,1);
 }finally{b.channel.close();await starting.catch(()=>{});b.restore();}
});
test('stream autoplay failure never sends ready, and returns a technical failure with closed output',async()=>{
 const b=browser({blockAudio:true});try{await assert.rejects(startVoiceSession({sessionType:'onboarding',onboardingProtocolVersion:4,accessToken:'test',speechClient:{rpc(){}},stopTimeoutMs:10}));assert.equal(b.sent.some(e=>e.item.content[0].text.startsWith('ligou.website_stream_ready:')),false);assert.equal(b.audios[0].muted,true);assert.equal(b.mic.stopped,true);}finally{b.restore();}
});

test('one failed network read of the next authorized stream recovers without ending the active call',async()=>{
 const b=browser(),timings=[];let current,reads=0;
 const next=structuredClone(descriptor);next.action={...next.action,revision:1,kind:'CONFIRM_AND_ASK_NEXT',actionId:'c'.repeat(64),text:'O Ligou pode confirmar agendamentos?'};
 next.dispatchId='44444444-4444-4444-8444-444444444444';next.receiptId='55555555-5555-4555-8555-555555555555';
 const client={rpc(name,args){assert.equal(name,'read_website_interview_stream');assert.deepEqual(args,{p_call:callId,p_action:next.action.actionId,p_dispatch:next.dispatchId});reads++;
  return Promise.resolve(reads===1?{data:null,error:{code:'',message:'TypeError: Failed to fetch'},status:0}:{data:next,error:null,status:200});}};
 const starting=startVoiceSession({sessionType:'onboarding',accessToken:'test',onboardingProtocolVersion:4,speechClient:client,onTiming:e=>timings.push(e),stopTimeoutMs:20});
 try{
  await until(()=>b.sent.length===1);b.begin();await new Promise(r=>setTimeout(r,25));b.finish();current=await starting;
  b.channel.emit({type:'conversation.item.done',item:{id:'lsn-'+next.dispatchId.replaceAll('-','').slice(0,28),type:'message',role:'system',status:'completed',content:[{type:'input_text',text:'ligou.website_stream:'+JSON.stringify(next)}]}});
  const deadline=Date.now()+1000;while(reads<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(reads,2);await until(()=>b.sent.some(e=>e.item?.content?.[0]?.text?.includes(next.dispatchId)));
  assert.equal(b.sent.some(e=>e.item?.content?.[0]?.text?.startsWith('ligou.website_stop:')),false);
  assert.equal(b.mic.stopped,false);assert.ok(timings.some(e=>e.event==='speech_read_retry'));
 }finally{current?.end('manual_hangup');b.channel.close();await starting.catch(()=>{});b.restore();}
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
test('authenticated recap resume starts its selected summary without inventing an introduction',async()=>{
 const payload=structuredClone(response);payload.opening_payload.stream.action.kind='GENERATE_FINAL_SUMMARY';
 payload.opening_payload.stream.action.text='Resumo salvo: atendimento somente nas cidades confirmadas. Fora delas, exige aprovação do dono.';
 const b=browser({payload});let known;
 const starting=startVoiceSession({sessionType:'onboarding',onboardingProtocolVersion:4,accessToken:'test',speechClient:{rpc(){}},onCallCreated:call=>known=call,stopTimeoutMs:10});starting.catch(()=>{});
 try{await until(()=>b.sent.some(e=>e.item.content[0].text.startsWith('ligou.website_stream_ready:')));assert.equal(b.audios.length,1);
  known.end('manual_hangup');b.channel.close();await starting.catch(()=>{});
 }finally{b.channel?.close();await starting.catch(()=>{});b.restore();}
});
