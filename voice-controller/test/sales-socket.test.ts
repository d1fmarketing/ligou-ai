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
