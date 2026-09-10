import {describe,expect,test} from 'bun:test';
import {createLiveWebRtcSession,createLiveLifecycle,liveDurationCostUsd,LiveCreationError} from '../src/onboarding-live-protocol.ts';

const sessionId='live_opaque-session-7';
const creation={sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111',voice:'bossa' as const,instructions:'Você é o Ligou. Delegue decisões ao backend.'};
const started={type:'session.started',event_id:'event-started',session:{id:sessionId,model:'gpt-live-1'}};
const closed=(reason='close_requested',seconds=24)=>({type:'session.closed',event_id:'event-closed',session:{id:sessionId,model:'gpt-live-1'},reason,usage:{seconds}});

describe('Live WebRTC server boundary',()=>{
 test('uses actual Live JSON transport and restricts the untrusted frontend',async()=>{
  let request:any;
  const result=await createLiveWebRtcSession(creation,{apiKey:'fixture-key',fetch:async(url,init)=>{
   request={url,body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)};
   return Response.json({session:{id:sessionId},transport:{type:'webrtc',sdp:'v=0\r\nanswer'}},{status:201});
  }});
  expect(request.url).toBe('https://api.openai.com/v1/live/sessions');
  expect(request.body.transport).toEqual({type:'webrtc',sdp:creation.sdp});
  expect(request.body.session).toMatchObject({model:'gpt-live-1',delegation:{type:'client'},audio:{output:{voice:'bossa'}},store:false});
  expect(request.body.session.client.data_channel.allowed_client_events).toEqual(['session.close','session.input_audio.mute','session.input_audio.unmute']);
  expect(request.body.session.client.data_channel.allowed_server_events).not.toContain('session.delegation.created');
  expect(request.body.session).not.toHaveProperty('tools');
  expect(request.body.session.audio).not.toHaveProperty('format');
  expect(result).toEqual({sessionId,sdp:'v=0\r\nanswer'});
  expect(JSON.stringify(result)).not.toContain('fixture-key');
 });
 test('preserves history roles and rejects unsafe startup configuration before calling provider',async()=>{
  let calls=0;const deps={apiKey:'fixture',fetch:async()=>{calls++;return new Response();}};
  for(const value of [{...creation,voice:'unknown'},{...creation,history:[{role:'system',text:'wrong role'}]},{...creation,sdp:''}]){
   await expect(createLiveWebRtcSession(value as any,deps)).rejects.toThrow();
  }
  expect(calls).toBe(0);
 });
 test('does not retry an ambiguous creation and never reports it as definitive rejection',async()=>{
  let calls=0;
  try{await createLiveWebRtcSession(creation,{apiKey:'fixture',fetch:async()=>{calls++;throw new TypeError('sensitive response');}});throw Error('must fail');}
  catch(e){expect(e).toBeInstanceOf(LiveCreationError);expect((e as LiveCreationError).outcome).toBe('unknown');expect(String(e)).not.toContain('sensitive response');}
  expect(calls).toBe(1);
 });
 test('HTTP rejection is different from malformed successful creation',async()=>{
  for(const [response,outcome] of [[Response.json({error:{code:'model_not_found'}},{status:404}),'rejected'],[Response.json({session:{id:sessionId}},{status:201}),'unknown']] as const){
   try{await createLiveWebRtcSession(creation,{apiKey:'fixture',fetch:async()=>response});throw Error('must fail');}
   catch(e){expect(e).toBeInstanceOf(LiveCreationError);expect((e as LiveCreationError).outcome).toBe(outcome);}
  }
 });
});

describe('Live session lifecycle, independently of business approval',()=>{
 test('Realtime events do not establish Live readiness or usage',()=>{
  const sent:any[]=[];const live=createLiveLifecycle({sessionId,send:e=>sent.push(e)});
  live.observe({type:'session.created',session:{id:sessionId}});
  live.observe({type:'response.done',response:{usage:{total_tokens:300}}});
  expect(live.status()).toMatchObject({phase:'connecting',seconds:0,finalized:false});
  expect(()=>live.greet('Apresente-se em português.')).toThrow('live_not_started');
  expect(sent).toEqual([]);
 });
 test('greeting starts only after readiness; input is never muted and append ack is not playback',()=>{
  const sent:any[]=[];const live=createLiveLifecycle({sessionId,send:e=>sent.push(e)});
  live.observe(started);live.greet('Apresente-se em português e pergunte o assunto atual.');
  expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({type:'session.instructions.append',delegation_id:null});
  live.observe({type:'session.instructions.appended',client_event_id:sent[0].event_id,start_ms:1,end_ms:100});
  expect(live.status()).toMatchObject({phase:'running',finalized:false});
  expect(sent.map(x=>x.type)).not.toContain('session.input_audio.mute');
  expect(sent.map(x=>x.type)).not.toContain('session.start');
 });
 test('close observes a synchronous final event, deduplicates Stop and cleans up afterward',async()=>{
  const order:string[]=[];let live:ReturnType<typeof createLiveLifecycle>;
  live=createLiveLifecycle({sessionId,send:e=>{order.push(e.type);if(e.type==='session.close')live.observe(closed());},cleanup:()=>order.push('cleanup')});
  live.observe(started);const first=live.close();const second=live.close();
  expect(first).toBe(second);
  expect(await first).toEqual({finalized:true,reason:'close_requested',seconds:24});
  expect(order).toEqual(['session.close','cleanup']);
  expect(live.status()).toMatchObject({phase:'closed',finalized:true,seconds:24});
  expect(live.status()).not.toHaveProperty('approved');
 });
 test('cumulative duration snapshots are not summed and stale observations cannot regress',async()=>{
  const live=createLiveLifecycle({sessionId,send:()=>{}});live.observe(started);
  for(const seconds of [12,12,19,13])live.observe({type:'session.usage.updated',usage:{seconds}});
  expect(live.status().seconds).toBe(19);live.observe(closed('connection_lost',24));
  expect(await live.close()).toEqual({finalized:true,reason:'connection_lost',seconds:24});
  expect(liveDurationCostUsd(24)).toBe(0.02);
 });
 test('timeout releases resources with unconfirmed final usage, not fabricated success',async()=>{
  let cleanups=0;const live=createLiveLifecycle({sessionId,send:()=>{},cleanup:()=>{cleanups++;},closeTimeoutMs:5});
  live.observe(started);live.observe({type:'session.usage.updated',usage:{seconds:12}});
  expect(await live.close()).toEqual({finalized:false,reason:'finalization_timeout',seconds:12});
  expect(cleanups).toBe(1);
  expect(()=>live.commentary('item_delegation','saved')).toThrow('live_not_running');
 });
 test('wrong session close cannot finalize this session and invalid duration cannot poison accounting',async()=>{
  const live=createLiveLifecycle({sessionId,send:()=>{},closeTimeoutMs:5});live.observe(started);
  live.observe({...closed(),session:{id:'other-live-session'}});
  for(const seconds of [-1,NaN,Infinity,'24'])live.observe({type:'session.usage.updated',usage:{seconds}});
  expect(live.status()).toMatchObject({finalized:false,seconds:0,phase:'running'});
  await live.close();
 });
 test('transport failure on Stop settles cleanup without waiting for a second user action',async()=>{
  let cleanups=0;const live=createLiveLifecycle({sessionId,send:()=>{throw Error('connection gone');},cleanup:()=>{cleanups++;}});live.observe(started);
  expect(await live.close()).toMatchObject({finalized:false,reason:'transport_unavailable'});expect(cleanups).toBe(1);
 });
 test('duration accounts initialization as a floor, not an extra increment',()=>{
  expect(liveDurationCostUsd(0,{created:true})).toBe(0.0125);
  expect(liveDurationCostUsd(30,{created:true})).toBe(0.025);
  expect(()=>liveDurationCostUsd(-1)).toThrow();
 });
 test('a synchronous greeting acknowledgment is retained',()=>{
  let live:ReturnType<typeof createLiveLifecycle>;
  live=createLiveLifecycle({sessionId,send:e=>live.observe({type:'session.instructions.appended',client_event_id:e.event_id,start_ms:0,end_ms:10})});
  live.observe(started);live.greet('Apresente-se.');expect(live.status().greetingAccepted).toBe(true);
 });
 test('provider finalization does not certify missing or contradictory final usage',async()=>{
  const live=createLiveLifecycle({sessionId,send:()=>{}});live.observe(started);
  live.observe({type:'session.usage.updated',usage:{seconds:19}});
  live.observe({...closed(),usage:{seconds:12}});
  expect((await live.close()).finalized).toBe(true);
  expect(live.status()).toMatchObject({seconds:19,finalUsageConfirmed:false});
 });
});
