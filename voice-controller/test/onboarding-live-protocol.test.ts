import {describe,expect,test} from 'bun:test';
import {createLiveWebRtcSession,createLiveLifecycle,liveDurationCostUsd,LiveCreationError} from '../src/onboarding-live-protocol.ts';

const sessionId='live_opaque-session-7';
const creation={sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111',voice:'bossa' as const,instructions:'Você é o Ligou. Delegue decisões ao backend.',
 responses:{instructions:'Use somente as ferramentas autorizadas do Ligou.',tools:[{type:'function' as const,name:'save_answer',parameters:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},strict:true}]}};
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
  expect(request.body.session).toMatchObject({model:'gpt-live-1',delegation:{type:'responses',responses:{model:'gpt-6-astra',instructions:creation.responses.instructions,
   tools:creation.responses.tools,reasoning:{effort:'low'},service_tier:'default',tool_choice:'auto',parallel_tool_calls:false}},audio:{output:{voice:'bossa'}},store:false});
  expect(request.body.session.client.data_channel.allowed_client_events).toEqual(['session.close','session.input_audio.mute','session.input_audio.unmute']);
  expect(request.body.session.client.data_channel.allowed_server_events).toEqual([
   {type:'session.started'},{type:'session.closed'},{type:'session.usage.updated'},{type:'session.input_transcript.delta'},{type:'session.output_transcript.delta'},{type:'error'},{type:'info'},
  ]);
  expect(request.body.session.client.data_channel.allowed_client_events).not.toContain('response.item.create');
  expect(request.body.session.client.data_channel.allowed_client_events).not.toContain('response.create');
  expect(request.body.session).not.toHaveProperty('tools');
  expect(request.body.session.audio).not.toHaveProperty('format');
  expect(result).toEqual({sessionId,sdp:'v=0\r\nanswer',expiresAt:null});
  expect(JSON.stringify(result)).not.toContain('fixture-key');
 });
 test('preserves history roles and rejects unsafe startup configuration before calling provider',async()=>{
  let calls=0;const deps={apiKey:'fixture',fetch:async()=>{calls++;return new Response();}};
  for(const value of [{...creation,voice:'unknown'},{...creation,history:[{role:'system',text:'wrong role'}]},{...creation,sdp:''},
   {...creation,responses:undefined},{...creation,responses:{...creation.responses,instructions:''}},
   {...creation,responses:{...creation.responses,tools:[{type:'mcp',name:'unapproved'}]}},
   {...creation,responses:{...creation.responses,tools:[...creation.responses.tools,...creation.responses.tools]}}]){
   await expect(createLiveWebRtcSession(value as any,deps)).rejects.toThrow();
  }
  expect(calls).toBe(0);
 });
 test('retains a known provider session ID when the successful response has no usable SDP',async()=>{
  try{await createLiveWebRtcSession(creation,{apiKey:'fixture',fetch:async()=>Response.json({session:{id:sessionId}},{status:201})});throw Error('must fail');}
  catch(error){expect(error).toBeInstanceOf(LiveCreationError);expect(error).toMatchObject({outcome:'unknown',status:201,sessionId});}
 });
 test('an abort after creation preserves the session handle for caller-owned cleanup',async()=>{
  const controller=new AbortController();
  const response={ok:true,status:201,json:async()=>{controller.abort();return{session:{id:sessionId},transport:{type:'webrtc',sdp:'answer'}};}} as Response;
  try{await createLiveWebRtcSession(creation,{apiKey:'fixture',signal:controller.signal,fetch:async()=>response});throw Error('must fail');}
  catch(error){expect(error).toBeInstanceOf(LiveCreationError);expect(error).toMatchObject({outcome:'unknown',sessionId});}
 });
 test('retains only the actual provider expiry from the successful response',async()=>{
  const result=await createLiveWebRtcSession(creation,{apiKey:'fixture',fetch:async()=>Response.json({session:{id:sessionId,expires_at:1_800_000_000},transport:{type:'webrtc',sdp:'answer'}},{status:201})});
  expect(result.expiresAt).toBe(1_800_000_000);
 });
 test('sets one explicitly selected backend without exposing backend instructions in startup history',async()=>{
  let body:any;
  await createLiveWebRtcSession({...creation,responses:{...creation.responses,model:'gpt-6-astra',reasoning:{effort:'medium'}}},{apiKey:'fixture',fetch:async(_url,init)=>{
   body=JSON.parse(String(init?.body));return Response.json({session:{id:sessionId},transport:{type:'webrtc',sdp:'answer'}},{status:201});
  }});
  expect(body.session.delegation.responses).toMatchObject({model:'gpt-6-astra',reasoning:{effort:'medium'}});
  expect(body.session.input).toEqual([]);
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
 test('verified sideband attachment permits lifecycle control but greeting needs actual session.started',()=>{
  const sent:any[]=[];const live=createLiveLifecycle({sessionId,send:e=>sent.push(e)});
  live.readyFromAttachment();live.readyFromAttachment();
  expect(live.status()).toMatchObject({phase:'running',greetingAccepted:false,finalized:false,seconds:0});
  expect(sent).toEqual([]);expect(()=>live.greet('Apresente-se em português.')).toThrow('live_not_started');
  live.observe(started);live.greet('Apresente-se em português.');
  expect(sent.map(e=>e.type)).toEqual(['session.instructions.append']);
 });
 test('one matching greeting acknowledgment requests one short commentary nudge',()=>{
  const sent:any[]=[];const live=createLiveLifecycle({sessionId,send:e=>sent.push(e)});live.observe(started);
  const requestId=live.greet('Apresente-se naturalmente em português.');
  live.observe({type:'session.instructions.appended',client_event_id:'other-command'});expect(sent).toHaveLength(1);
  live.observe({type:'session.instructions.appended',client_event_id:requestId});
  live.observe({type:'session.instructions.appended',client_event_id:requestId});live.greet('Outra tentativa.');
  expect(sent.map(e=>e.type)).toEqual(['session.instructions.append','session.commentary.append']);
  expect(sent[1]).toMatchObject({delegation_id:null,content:'Comece a conversa agora seguindo as instruções fornecidas.'});
  expect(live.status()).toMatchObject({greetingAccepted:true,sessionStarted:true});expect(live.status()).not.toHaveProperty('greetingHeard');
 });
 test('a rejected greeting instruction does not trigger commentary after a contradictory late ack',()=>{
  const sent:any[]=[];const live=createLiveLifecycle({sessionId,send:e=>sent.push(e)});live.observe(started);const requestId=live.greet('Apresente-se.');
  live.observe({type:'error',error:{code:'invalid_request',client_event_id:requestId}});
  live.observe({type:'session.instructions.appended',client_event_id:requestId});
  expect(sent.map(e=>e.type)).toEqual(['session.instructions.append']);expect(live.status()).toMatchObject({phase:'running',greetingAccepted:false,greetingError:'invalid_request'});
 });
 test('Stop before the greeting acknowledgment prevents the commentary nudge',async()=>{
  const sent:any[]=[];const live=createLiveLifecycle({sessionId,send:e=>sent.push(e),closeTimeoutMs:5});live.observe(started);const requestId=live.greet('Apresente-se.');
  const stopping=live.close();live.observe({type:'session.instructions.appended',client_event_id:requestId});live.observe(closed());await stopping;
  expect(sent.map(e=>e.type)).toEqual(['session.instructions.append','session.close']);
 });
 test('a failed commentary send is observable and is not replayed on duplicate greeting acknowledgment',()=>{
  const sent:any[]=[];const live=createLiveLifecycle({sessionId,send:e=>{sent.push(e);if(e.type==='session.commentary.append')throw Error('connection unavailable');}});
  live.observe(started);const requestId=live.greet('Apresente-se.');
  expect(()=>live.observe({type:'session.instructions.appended',client_event_id:requestId})).not.toThrow();
  live.observe({type:'session.instructions.appended',client_event_id:requestId});
  expect(sent).toHaveLength(2);expect(live.status().greetingError).toBe('transport_unavailable');
 });
 test('a late sideband attachment cannot revive a closing or closed lifecycle',async()=>{
  const live=createLiveLifecycle({sessionId,send:()=>{},closeTimeoutMs:5});
  const closing=live.close();live.readyFromAttachment();expect(live.status().phase).toBe('closing');
  await closing;live.readyFromAttachment();expect(live.status().phase).toBe('closed');
  expect(()=>live.greet('Apresente-se.')).toThrow('live_not_started');
 });
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
