import {expect,test} from 'bun:test';
import {attachSalesSocket} from '../src/sales/socket.ts';
import {salesSessionConfig} from '../src/sales/provider.ts';
class Socket extends EventTarget {sent:any[]=[];closed=false;send(s:string){this.sent.push(JSON.parse(s));}close(){this.closed=true;this.dispatchEvent(new Event('close'));}event(type:string,data?:any){this.dispatchEvent(data?new MessageEvent(type,{data:JSON.stringify(data)}):new Event(type));}}
test('sideband ready waits for authoritative update ACK and queued transcript failure triggers hangup',async()=>{
 const socket=new Socket(),stops:string[]=[];let ready=false;
 const attached=attachSalesSocket({session_id:'s',claim_token:'c',model:'gpt-realtime-2.1',provider_call_id:'rtc',observed_cost_usd:0} as any,{apply:async()=>{throw Error('db failed');}} as any,async r=>{stops.push(r);},()=>socket as any).then(s=>{ready=true;return s;});
 socket.event('open');await Bun.sleep(1);expect(ready).toBe(false);expect(socket.sent[0].type).toBe('session.update');expect(socket.sent[0].session.model).toBeUndefined();
 socket.event('message',{type:'session.updated',session:salesSessionConfig('gpt-realtime-2.1')});
 const control=await attached;expect(ready).toBe(true);
 socket.event('message',{type:'conversation.item.input_audio_transcription.completed',item_id:'u',transcript:'Oi'});
 await Bun.sleep(1);expect(stops).toContain('sideband_evidence_failed');control.close();
});
test('socket closing before ACK rejects readiness and requests termination',async()=>{
 const socket=new Socket(),stops:string[]=[];
 const attached=attachSalesSocket({model:'gpt-realtime-2.1',provider_call_id:'rtc'} as any,{} as any,async r=>{stops.push(r);},()=>socket as any);
 socket.event('close');await expect(attached).rejects.toThrow('sideband_disconnected');expect(stops).toEqual(['sideband_disconnected']);
});
test('connected greeting does not collide with a visitor turn already started',async()=>{
 const socket=new Socket();const attached=attachSalesSocket({model:'gpt-realtime-2.1',provider_call_id:'rtc'} as any,{} as any,async()=>{},()=>socket as any);
 socket.event('open');socket.event('message',{type:'session.updated',session:salesSessionConfig('gpt-realtime-2.1')});const control=await attached;
 socket.event('message',{type:'input_audio_buffer.speech_started'});await Bun.sleep(1);
 control.greet();expect(socket.sent.filter(e=>e.type==='response.create')).toHaveLength(0);control.close();
});
test('connected greeting creates one response for a silent visitor',async()=>{
 const socket=new Socket();const attached=attachSalesSocket({model:'gpt-realtime-2.1',provider_call_id:'rtc'} as any,{} as any,async()=>{},()=>socket as any);
 socket.event('open');socket.event('message',{type:'session.updated',session:salesSessionConfig('gpt-realtime-2.1')});const control=await attached;
 control.greet();control.greet();expect(socket.sent.filter(e=>e.type==='response.create')).toHaveLength(1);control.close();
});

test('committed speech with no transcription ends within a bounded wait instead of indefinite capture',async()=>{
 const socket=new Socket(),stops:string[]=[];
 const row:any={session_id:'s',claim_token:'c',model:'gpt-realtime-2.1',provider_call_id:'rtc',observed_cost_usd:0,reserved_cost_usd:1.5};
 const controlPromise=attachSalesSocket(row,{apply:async()=>row} as any,async reason=>{stops.push(reason);},()=>socket as any,{transcriptionTimeoutMs:15});
 socket.event('open');socket.event('message',{type:'session.updated',session:salesSessionConfig('gpt-realtime-2.1')});
 const control=await controlPromise;
 socket.event('message',{type:'input_audio_buffer.committed',item_id:'missing'});
 await Bun.sleep(40);
 expect(stops).toEqual(['transcription_timeout']);
 control.close();
});

test('persisted transcription cancels capture deadline and socket cleanup cancels remaining waits',async()=>{
 const socket=new Socket(),stops:string[]=[];
 const row:any={session_id:'s',claim_token:'c',model:'gpt-realtime-2.1',provider_call_id:'rtc',observed_cost_usd:0,reserved_cost_usd:1.5};
 const controlPromise=attachSalesSocket(row,{apply:async()=>row} as any,async reason=>{stops.push(reason);},()=>socket as any,{transcriptionTimeoutMs:20});
 socket.event('open');socket.event('message',{type:'session.updated',session:salesSessionConfig('gpt-realtime-2.1')});
 const control=await controlPromise;
 socket.event('message',{type:'input_audio_buffer.committed',item_id:'speech'});
 socket.event('message',{type:'conversation.item.input_audio_transcription.completed',item_id:'speech',transcript:'Olá'});
 await Bun.sleep(35);expect(stops).toEqual([]);
 socket.event('message',{type:'input_audio_buffer.committed',item_id:'closing'});
 await Bun.sleep(1);control.close();
 await Bun.sleep(35);expect(stops).toEqual([]);
});

test('a greeting deferred by preconnection noise still starts once after empty transcription',async()=>{
 const socket=new Socket(),stops:string[]=[];
 const row:any={session_id:'s',claim_token:'c',model:'gpt-realtime-2.1',provider_call_id:'rtc',observed_cost_usd:0,reserved_cost_usd:1.5};
 const attaching=attachSalesSocket(row,{apply:async()=>row} as any,async reason=>{stops.push(reason);},()=>socket as any);
 socket.event('open');socket.event('message',{type:'session.updated',session:salesSessionConfig('gpt-realtime-2.1')});const control=await attaching;
 socket.event('message',{type:'input_audio_buffer.speech_started'});await Bun.sleep(1);control.greet();
 expect(socket.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 socket.event('message',{type:'input_audio_buffer.committed',item_id:'noise'});
 socket.event('message',{type:'conversation.item.input_audio_transcription.completed',item_id:'noise',transcript:''});
 await Bun.sleep(1);expect(socket.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
 control.greet();expect(socket.sent.filter(e=>e.type==='response.create')).toHaveLength(1);control.close();
});

test('transcript persistence finishing after timeout cannot start fresh provider audio',async()=>{
 const socket=new Socket(),stops:string[]=[];
 const row:any={session_id:'s',claim_token:'c',model:'gpt-realtime-2.1',provider_call_id:'rtc',observed_cost_usd:0,reserved_cost_usd:1.5};
 const attaching=attachSalesSocket(row,{apply:async()=>{await Bun.sleep(30);return row;}} as any,async reason=>{stops.push(reason);},()=>socket as any,{transcriptionTimeoutMs:10});
 socket.event('open');socket.event('message',{type:'session.updated',session:salesSessionConfig('gpt-realtime-2.1')});const control=await attaching;
 socket.event('message',{type:'input_audio_buffer.committed',item_id:'slow'});
 socket.event('message',{type:'conversation.item.input_audio_transcription.completed',item_id:'slow',transcript:'Minha empresa é ACME.'});
 await Bun.sleep(45);
 expect(stops).toEqual(['transcription_timeout']);
 expect(socket.sent.some(e=>e.item?.content?.[0]?.text?.includes('transcription_timeout'))).toBe(true);
 expect(socket.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 control.close();
});

test('a visitor turn arriving before greeting response ACK waits instead of creating overlapping audio',async()=>{
 const socket=new Socket();
 const row:any={session_id:'s',claim_token:'c',model:'gpt-realtime-2.1',provider_call_id:'rtc',observed_cost_usd:0,reserved_cost_usd:1.5};
 const attaching=attachSalesSocket(row,{apply:async()=>row} as any,async()=>{},()=>socket as any);
 socket.event('open');socket.event('message',{type:'session.updated',session:salesSessionConfig('gpt-realtime-2.1')});const control=await attaching;
 control.greet();
 socket.event('message',{type:'input_audio_buffer.committed',item_id:'early'});
 socket.event('message',{type:'conversation.item.input_audio_transcription.completed',item_id:'early',transcript:'Minha empresa é ACME.'});
 await Bun.sleep(1);expect(socket.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
 socket.event('message',{type:'response.created',response:{id:'greeting'}});
 socket.event('message',{type:'response.done',response:{id:'greeting',output:[]}});
 await Bun.sleep(1);expect(socket.sent.filter(e=>e.type==='response.create')).toHaveLength(2);control.close();
});
