import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createVoiceBridge } from '../src/sales-demo/ui-controller.js';
import { createSalesVoiceSession } from '../src/sales-demo/voice-client.js';

function fixture({ microphoneError, responder, connect = true, microphone, options = {} } = {}) {
  const states = [], captions = [], errors = [], requests = [], tracks = [];
  const storage = new Map(), listeners = new Map();
  let peer;
  class Peer {
    connectionState = 'new'; localDescription = null;
    constructor() { peer = this; }
    addTrack() {}
    createDataChannel() { this.channel = { close() {}, onmessage: null }; return this.channel; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=offer' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription() {
      if (connect) { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
    }
    close() { this.closed = true; this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
  }
  class Audio { autoplay = false; srcObject = null; async play() {} pause() { this.paused = true; } }
  const env = {
    crypto: webcrypto, RTCPeerConnection: Peer, Audio, Date,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener:(event,handler)=>listeners.set(event,handler),removeEventListener:(event,handler)=>{if(listeners.get(event)===handler)listeners.delete(event);},
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    navigator: { mediaDevices: { async getUserMedia() {
      if (microphoneError) throw microphoneError;
      if (microphone) return microphone();
      const track = { enabled: true, stopped: false, stop() { this.stopped = true; } }; tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({url,headers:options.headers,body,keepalive:options.keepalive});
      if (responder) { const response = await responder(body, requests); if (response) return response; }
      const status = body.action === 'start' ? 'pending' : body.action === 'end' ? 'ended' : 'ready';
      return Response.json({session_id:body.request_id ?? body.session_id,status,provider_termination_state:status==='ended'?'confirmed':'not_started',max_minutes:5,expires_at:new Date(Date.now()+300000).toISOString(),...(status==='ready'?{sdp:'v=0\r\na=answer'}:{})});
    },
  };
  const session = createSalesVoiceSession({endpoint:'https://example.supabase.co/functions/v1/sales-session',onState:s=>states.push(s),onCaption:c=>captions.push(c),onError:e=>errors.push(e),pollIntervalMs:1,...options}, env);
  return {session,env,states,captions,errors,requests,tracks,storage,listeners,get peer(){return peer;}};
}

test('a double click starts one peer and one admitted session; no owner token is used', async () => {
  const f=fixture(); const a=f.session.start(), b=f.session.start();
  assert.equal(a,b); await a;
  assert.equal(f.requests.filter(r=>r.body.action==='start').length,1);
  assert.equal(f.tracks.length,1);
  assert.equal(f.session.getState(),'listening');
  const request=f.requests[0];
  assert.match(request.headers.Authorization,/^Bearer [A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(request.body).sort(),['action','request_id','sdp','visitor_id']);
  await f.session.end();
});

test('microphone denial never admits a provider session and gives an actionable error', async () => {
  const f=fixture({microphoneError:Object.assign(new Error('denied'),{name:'NotAllowedError'})});
  await assert.rejects(f.session.start());
  assert.equal(f.requests.length,0); assert.equal(f.session.getState(),'error');
  assert.equal(f.errors[0].code,'microphone_denied');
});

test('mute affects the microphone and end requests server termination plus local release', async () => {
  const f=fixture(); await f.session.start();
  f.session.setMuted(true); assert.equal(f.tracks[0].enabled,false);
  f.session.setMuted(false); assert.equal(f.tracks[0].enabled,true);
  await f.session.end();
  assert.equal(f.requests.filter(r=>r.body.action==='end').length,1);
  assert.equal(f.tracks[0].stopped,true); assert.equal(f.peer.closed,true);
  assert.equal(f.session.getState(),'ended');
});

test('caller and agent captions come from actual RTC transcription events',async()=>{
  const f=fixture();await f.session.start();
  for(const event of [
    {type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'Minha empresa é de limpeza.'},
    {type:'response.output_audio_transcript.delta',item_id:'a1',delta:'Prazer'},
    {type:'response.output_audio_transcript.done',item_id:'a1',transcript:'Prazer em conhecer sua empresa.'},
  ]) f.peer.channel.onmessage({data:JSON.stringify(event)});
  assert.deepEqual(f.captions[0],{id:'u1',role:'caller',text:'Minha empresa é de limpeza.',final:true});
  assert.equal(f.captions.at(-1).text,'Prazer em conhecer sua empresa.');
  assert.equal(f.captions.at(-1).final,true);await f.session.end();
});

test('early cancel during startup ends the same admitted session, never starts another',async()=>{
  let release;const held=new Promise(r=>release=r);
  const f=fixture({responder:async body=>{if(body.action==='start')await held;}});
  const starting=f.session.start();
  while(!f.requests.length)await new Promise(r=>setTimeout(r,1));
  const ending=f.session.end();release();await starting;await ending;
  const begin=f.requests.find(r=>r.body.action==='start'),end=f.requests.find(r=>r.body.action==='end');
  assert.equal(end.body.session_id,begin.body.request_id);assert.equal(f.tracks[0].stopped,true);
  assert.equal(f.session.getState(),'ended');
});

test('missing endpoint fails before asking for microphone',async()=>{
  const f=fixture();const s=createSalesVoiceSession({endpoint:'',onError:e=>f.errors.push(e)},f.env);
  await assert.rejects(s.start());assert.equal(f.tracks.length,0);assert.equal(f.requests.length,0);
  assert.equal(f.errors[0].code,'not_configured');
});

test('admission limit message releases the microphone and does not report connected',async()=>{
  const f=fixture({responder:async b=>b.action==='start'?Response.json({error:'daily_limit'},{status:429}):null});
  await assert.rejects(f.session.start());assert.equal(f.tracks[0].stopped,true);
  assert.equal(f.states.includes('listening'),false);assert.equal(f.errors[0].code,'daily_limit');
});

test('a broken status response cannot be used as a successful SDP answer',async()=>{
  const f=fixture({responder:async b=>b.action==='status'?Response.json({status:'ready',sdp:'',session_id:b.session_id}):null});
  await assert.rejects(f.session.start());assert.equal(f.states.includes('listening'),false);
  assert.equal(f.tracks[0].stopped,true);
});

const activeKey='ligou.sales.active.v1';
const prior={id:'12345678-1234-4123-8123-123456789abc',token:'a'.repeat(43),endpoint:'https://example.supabase.co/functions/v1/sales-session'};
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,1));}assert.fail('Expected async state did not arrive');}

test('automatic transport failure keeps the shared CTA locked until end settles',async()=>{
 let release;const held=new Promise(r=>release=r);
 const f=fixture({responder:async body=>{if(body.action==='end')await held;}}),patches=[];
 let created=0,repeated;const bridge=createVoiceBridge({endpoint:prior.endpoint,emit:p=>patches.push(p),loadClient:async()=>({createSalesVoiceSession:options=>{created++;return createSalesVoiceSession({...options,pollIntervalMs:1},f.env);}})});
 try{
  await bridge.start();f.peer.connectionState='failed';f.peer.onconnectionstatechange();
  await until(()=>f.requests.some(r=>r.body.action==='end'));
  repeated=bridge.start();await new Promise(r=>setTimeout(r,1));assert.equal(created,1);assert.equal(f.requests.filter(r=>r.body.action==='start').length,1);assert.equal(f.tracks.length,1);
 }finally{release();await repeated;await bridge.end();}
});

for(const scenario of ['failed-end','nonterminal-end','quarantined'])test(`prior capability retained and new admission blocked for ${scenario}`,async()=>{
 const f=fixture({responder:async body=>{
  if(body.session_id!==prior.id)return;
  if(scenario==='failed-end')throw new Error('offline');
  return Response.json({session_id:prior.id,status:scenario==='quarantined'?'quarantined':'ending',provider_termination_state:'unknown'});
 }});
 f.storage.set(activeKey,JSON.stringify(prior));let now=0;f.env.Date={now:()=>now+=5000};
 try{await assert.rejects(f.session.start(),e=>e.code==='ending_unconfirmed');
  assert.equal(f.storage.get(activeKey),JSON.stringify(prior));assert.equal(f.tracks.length,0);assert.equal(f.requests.some(r=>r.body.action==='start'),false);
 }finally{await f.session.end();}
});

test('confirmed prior termination permits one new identity after reconciliation',async()=>{
 const f=fixture();f.storage.set(activeKey,JSON.stringify(prior));await f.session.start();
 assert.equal(f.requests[0].body.action,'end');assert.equal(f.requests[0].headers.Authorization,`Bearer ${prior.token}`);
 assert.equal(f.requests.filter(r=>r.body.action==='start').length,1);assert.notEqual(JSON.parse(f.storage.get(activeKey)).id,prior.id);await f.session.end();
});

test('pagehide during held admission cancels the same identity before the response arrives',async()=>{
 let release;const held=new Promise(r=>release=r);const f=fixture({responder:async body=>{if(body.action==='start')await held;}});
 const started=f.session.start();await until(()=>f.requests.some(r=>r.body.action==='start'));
 try{assert.equal(typeof f.listeners.get('pagehide'),'function');f.listeners.get('pagehide')();
  await until(()=>f.requests.some(r=>r.body.action==='end'));const begin=f.requests.find(r=>r.body.action==='start'),end=f.requests.find(r=>r.body.action==='end');
  assert.equal(end.body.session_id,begin.body.request_id);assert.equal(end.headers.Authorization,begin.headers.Authorization);assert.equal(end.keepalive,true);assert.equal(f.tracks[0].stopped,true);await f.session.end();assert.equal(f.peer.closed,true);
 }finally{release();await started;await f.session.end();}
});

for(const [code,message] of [['sales_disabled','temporariamente indisponível'],['global_busy','outra conversa'],['daily_budget','limite de conversas']])test(`server error ${code} has actionable Portuguese message`,async()=>{
 const f=fixture({responder:async body=>body.action==='start'?Response.json({error:code},{status:429}):null});await assert.rejects(f.session.start());assert.equal(f.errors[0].code,code);assert.ok(f.errors[0].message.includes(message));
});

test('connected ACK waits for RTC connection and is single flight despite repeated connected events',async()=>{
 let release;const held=new Promise(r=>release=r);const f=fixture({connect:false,responder:async body=>{if(body.action==='connected')await held;}});
 const started=f.session.start();await until(()=>typeof f.peer?.onconnectionstatechange==='function');
 assert.equal(f.requests.some(r=>r.body.action==='connected'),false);f.peer.connectionState='connected';f.peer.onconnectionstatechange();f.peer.onconnectionstatechange();
 try{await until(()=>f.requests.some(r=>r.body.action==='connected'));assert.equal(f.session.getState(),'connecting');assert.equal(f.requests.filter(r=>r.body.action==='connected').length,1);
 }finally{release();await started;await f.session.end();}
});

test('failed connected ACK releases local transport and ends the same admitted identity',async()=>{
 const f=fixture({responder:async body=>body.action==='connected'?Response.json({error:'runtime_unavailable'},{status:503}):null});
 try{await assert.rejects(f.session.start());const begin=f.requests.find(r=>r.body.action==='start'),end=f.requests.find(r=>r.body.action==='end');assert.equal(end.body.session_id,begin.body.request_id);assert.equal(f.tracks[0].stopped,true);assert.equal(f.states.includes('listening'),false);}finally{await f.session.end();}
});

test('uncertain end retains the actual admission capability across a new client retry',async()=>{
 const f=fixture({responder:async body=>{if(body.action==='end')throw new Error('offline');}});await f.session.start();const retained=f.storage.get(activeKey);await f.session.end();assert.equal(f.storage.get(activeKey),retained);
 const retry=createSalesVoiceSession({endpoint:prior.endpoint,pollIntervalMs:1},f.env);await assert.rejects(retry.start(),e=>e.code==='ending_unconfirmed');assert.equal(f.storage.get(activeKey),retained);assert.equal(f.requests.filter(r=>r.body.action==='start').length,1);assert.equal(f.tracks.length,1);
});

test('a configured endpoint change cannot discard an unresolved capability or admit anew',async()=>{
 const f=fixture();f.storage.set(activeKey,JSON.stringify({...prior,endpoint:'https://previous.example.com/sales'}));
 try{await assert.rejects(f.session.start(),e=>e.code==='ending_unconfirmed');assert.equal(f.tracks.length,0);assert.equal(f.requests.length,0);assert.equal(JSON.parse(f.storage.get(activeKey)).id,prior.id);}finally{await f.session.end();}
});

test('transport failure while connected ACK is held ends the admission and never reports listening',async()=>{
 let release;const held=new Promise(r=>release=r);const f=fixture({responder:async body=>{if(body.action==='connected')await held;}});
 const started=f.session.start();await until(()=>f.requests.some(r=>r.body.action==='connected'));
 try{f.peer.connectionState='failed';f.peer.onconnectionstatechange();await until(()=>f.requests.some(r=>r.body.action==='end'));assert.equal(f.tracks[0].stopped,true);assert.equal(f.states.includes('listening'),false);}finally{release();await started;await f.session.end();}
});

test('an unanswered microphone prompt times out without an admission and a late stream is stopped',async()=>{
 let grant;const pending=new Promise(resolve=>grant=resolve);
 const f=fixture({microphone:()=>pending,options:{microphoneTimeoutMs:5}});
 await assert.rejects(f.session.start(),error=>error.code==='microphone_timeout');
 assert.equal(f.requests.length,0);assert.equal(f.session.getState(),'error');
 let stopped=false;grant({getTracks:()=>[{stop(){stopped=true;}}]});
 await until(()=>stopped);assert.equal(f.requests.length,0);
});

test('cancel during microphone permission settles immediately and closes a late stream',async()=>{
 let grant;const pending=new Promise(resolve=>grant=resolve);
 const f=fixture({microphone:()=>pending});const started=f.session.start();
 await until(()=>f.states.includes('requesting_microphone'));
 await f.session.end();await started;assert.equal(f.session.getState(),'ended');assert.equal(f.requests.length,0);
 let stopped=false;grant({getTracks:()=>[{stop(){stopped=true;}}]});await until(()=>stopped);
});

test('unknown provider termination stays pending and an explicit end retry reuses its capability',async()=>{
 let confirmed=false;
 const f=fixture({responder:async b=>b.action==='end'?Response.json({session_id:b.session_id,status:confirmed?'ended':'quarantined',provider_termination_state:confirmed?'confirmed':'unknown'}):null});
 await f.session.start();const capability=f.storage.get(activeKey);
 const first=await f.session.end();assert.equal(first.confirmed,false);assert.equal(f.session.getState(),'ending_unconfirmed');assert.equal(f.states.includes('ended'),false);assert.equal(f.tracks[0].stopped,true);assert.equal(f.peer.closed,true);assert.equal(f.storage.get(activeKey),capability);
 confirmed=true;const second=await f.session.end();assert.equal(second.confirmed,true);assert.equal(f.session.getState(),'ended');assert.equal(f.storage.has(activeKey),false);
 const endings=f.requests.filter(r=>r.body.action==='end');assert.equal(endings.length,2);assert.equal(endings[0].headers.Authorization,endings[1].headers.Authorization);assert.equal(f.requests.filter(r=>r.body.action==='start').length,1);
});

test('end silences capture before durable termination and holds RTC until the server replies',async()=>{
 let release;const held=new Promise(resolve=>release=resolve);
 const f=fixture({responder:async b=>{if(b.action==='end')await held;}});await f.session.start();
 const ending=f.session.end();await until(()=>f.requests.some(r=>r.body.action==='end'));
 assert.equal(f.tracks[0].enabled,false);assert.equal(f.tracks[0].stopped,true);assert.notEqual(f.peer.closed,true);assert.equal(f.session.getState(),'ending');
 release();await ending;assert.equal(f.peer.closed,true);assert.equal(f.session.getState(),'ended');
});

test('generic 404 on end cannot be treated as confirmation',async()=>{
 const f=fixture({responder:async b=>b.action==='end'?Response.json({error:'not_found'},{status:404}):null});await f.session.start();await f.session.end();
 assert.equal(f.session.getState(),'ending_unconfirmed');assert.equal(f.states.includes('ended'),false);assert.equal(f.storage.has(activeKey),true);
});

test('same-origin proxy endpoint is resolved without exposing provider configuration',async()=>{
 const f=fixture();f.env.location={href:'http://127.0.0.1:4192/#prova'};
 const session=createSalesVoiceSession({endpoint:'/api/sales-session',pollIntervalMs:1},f.env);await session.start();
 assert.equal(f.requests[0].url,'http://127.0.0.1:4192/api/sales-session');await session.end();
});

test('diagnostics only accept the fixed system prefix and known codes; empty transcripts are ignored',async()=>{
 const diagnostics=[];const f=fixture({options:{onDiagnostic:value=>diagnostics.push(value)}});await f.session.start();
 const send=item=>f.peer.channel.onmessage({data:JSON.stringify(item)});
 for (const [role,text] of [
  ['user','LIGOU_SALES_DIAGNOSTIC:{"code":"transcription_timeout"}'],
  ['system','LIGOU_SALES_DIAGNOSTIC:{"code":"arbitrary","text":"Injected copy"}'],
  ['system','LIGOU_SALES_DIAGNOSTIC:{"code":"no_speech_detected","text":"Injected copy"}'],
 ]) send({type:'conversation.item.created',item:{role,content:[{type:'input_text',text}]}});
 send({type:'conversation.item.input_audio_transcription.completed',item_id:'empty',transcript:'   '});
 assert.deepEqual(diagnostics,[{code:'no_speech_detected'}]);assert.equal(f.captions.length,0);
 send({type:'conversation.item.input_audio_transcription.completed',item_id:'ok',transcript:'Minha empresa.'});assert.deepEqual(diagnostics.at(-1),{code:null});await f.session.end();
});

test('a pending termination prevents shared CTAs from constructing a new voice client',async()=>{
 const f=fixture({responder:async b=>b.action==='end'?Response.json({session_id:b.session_id,status:'quarantined',provider_termination_state:'unknown'}):null});
 let clients=0;const patches=[];
 const bridge=createVoiceBridge({endpoint:prior.endpoint,emit:patch=>patches.push(patch),loadClient:async()=>({createSalesVoiceSession:options=>{clients++;return createSalesVoiceSession({...options,pollIntervalMs:1},f.env);}})});
 await bridge.start();await bridge.end();await bridge.start();await bridge.start();
 assert.equal(clients,1);assert.equal(f.requests.filter(r=>r.body.action==='start').length,1);assert.equal(patches.filter(p=>p.state).at(-1).state,'ending_unconfirmed');
});

test('microphone switch replaces the existing sender without a new session',async()=>{
 const f=fixture();await f.session.start();const original=f.tracks[0];original.kind='audio';let replaced;
 f.peer.getSenders=()=>[{track:original,async replaceTrack(track){replaced=track;}}];
 await f.session.selectMicrophone('second-input');assert.equal(replaced,f.tracks[1]);assert.equal(original.stopped,true);assert.equal(f.requests.filter(r=>r.body.action==='start').length,1);await f.session.end();assert.equal(f.tracks[1].stopped,true);
});

test('explicit first admission rejection releases its unused capability without an end request',async()=>{
 const f=fixture({responder:async b=>b.action==='start'?Response.json({error:'global_busy'},{status:429}):null});await assert.rejects(f.session.start());
 assert.equal(f.storage.has(activeKey),false);assert.equal(f.requests.length,1);assert.equal(f.session.getState(),'error');assert.equal(f.tracks[0].stopped,true);
});

test('a rejection after an ambiguous start retains the identity until termination is confirmed',async()=>{
 let starts=0;const f=fixture({responder:async b=>{
  if(b.action==='start'){starts++;if(starts===1)throw new Error('response lost');return Response.json({error:'sales_disabled'},{status:503});}
  if(b.action==='end')return Response.json({error:'network_unavailable'},{status:503});
 }});await assert.rejects(f.session.start());assert.equal(starts,2);assert.equal(f.storage.has(activeKey),true);assert.equal(f.session.getState(),'ending_unconfirmed');
 const admissions=f.requests.filter(r=>r.body.action==='start');assert.equal(admissions[0].body.request_id,admissions[1].body.request_id);assert.equal(admissions[0].headers.Authorization,admissions[1].headers.Authorization);
});

test('admission response arriving during hangup does not close RTC ahead of termination acknowledgment',async()=>{
 let releaseStart,releaseEnd;const heldStart=new Promise(r=>releaseStart=r),heldEnd=new Promise(r=>releaseEnd=r);
 const f=fixture({responder:async b=>{if(b.action==='start')await heldStart;if(b.action==='end')await heldEnd;}});
 const started=f.session.start();await until(()=>f.requests.some(r=>r.body.action==='start'));
 const ending=f.session.end();releaseStart();await started;assert.notEqual(f.peer.closed,true);assert.equal(f.session.getState(),'ending');
 releaseEnd();await ending;assert.equal(f.peer.closed,true);assert.equal(f.session.getState(),'ended');
});

test('RTC speech events cannot claim a connected conversation before the server ACK',async()=>{
 let release;const held=new Promise(r=>release=r);const f=fixture({responder:async b=>{if(b.action==='connected')await held;}});
 const started=f.session.start();await until(()=>f.requests.some(r=>r.body.action==='connected'));
 f.peer.channel.onmessage({data:JSON.stringify({type:'input_audio_buffer.speech_started'})});assert.equal(f.session.getState(),'connecting');
 release();await started;assert.equal(f.session.getState(),'listening');await f.session.end();
});

test('a stalled termination request respects the bounded deadline and retains its capability',async()=>{
 const f=fixture({options:{terminationTimeoutMs:5}});await f.session.start();
 f.env.fetch=async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('timeout'),{name:'AbortError'})),{once:true}));
 const began=Date.now();await f.session.end();assert.ok(Date.now()-began < 500);assert.equal(f.session.getState(),'ending_unconfirmed');assert.equal(f.peer.closed,true);assert.equal(f.storage.has(activeKey),true);
});

test('proven natural expiration releases a prior identity and permits one new conversation',async()=>{
 const f=fixture({responder:async b=>b.session_id===prior.id?Response.json({session_id:prior.id,status:'ended',provider_termination_state:'expired'}):null});
 f.storage.set(activeKey,JSON.stringify(prior));await f.session.start();assert.equal(f.session.getState(),'listening');assert.equal(f.requests.filter(r=>r.body.action==='start').length,1);assert.notEqual(JSON.parse(f.storage.get(activeKey)).id,prior.id);await f.session.end();
});

test('expired end is resolved without claiming the provider sent a termination ACK',async()=>{
 const f=fixture({responder:async b=>b.action==='end'?Response.json({session_id:b.session_id,status:'ended',provider_termination_state:'expired'}):null});
 await f.session.start();const result=await f.session.end();assert.deepEqual(result,{resolved:true,confirmed:false,providerTerminationState:'expired'});assert.equal(f.session.getState(),'ended');assert.equal(f.storage.has(activeKey),false);assert.deepEqual(await f.session.end(),result);
});

test('shared bridge preserves expiration metadata for the panel instead of an ACK label',async()=>{
 const f=fixture({responder:async b=>b.action==='end'?Response.json({session_id:b.session_id,status:'ended',provider_termination_state:'expired'}):null});const patches=[];
 const bridge=createVoiceBridge({endpoint:prior.endpoint,emit:p=>patches.push(p),loadClient:async()=>({createSalesVoiceSession:options=>createSalesVoiceSession({...options,pollIntervalMs:1},f.env)})});
 await bridge.start();await bridge.end();assert.equal(patches.at(-1).state,'ended');assert.equal(patches.at(-1).providerTerminationState,'expired');await bridge.start();assert.equal(f.requests.filter(r=>r.body.action==='start').length,2);await bridge.end();
});

test('expired metadata without an ended status cannot release a quarantined session',async()=>{
 const f=fixture({responder:async b=>b.action==='end'?Response.json({session_id:b.session_id,status:'quarantined',provider_termination_state:'expired'}):null});await f.session.start();await f.session.end();assert.equal(f.session.getState(),'ending_unconfirmed');assert.equal(f.storage.has(activeKey),true);
});
