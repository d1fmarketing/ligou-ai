import {expect,test} from 'bun:test';
import {createLiveConversation,liveOperationReference} from '../src/onboarding-live-context.ts';

const scope={tenantId:'tenant-a',interviewId:'interview-a',callId:'call-a',providerSessionId:'live-a'};
const input=(id:string,delta:string,start_ms:number,end_ms:number)=>({type:'session.input_transcript.delta',event_id:id,delta,start_ms,end_ms});
const delegate=(id:string,offset_ms=1500)=>({type:'session.delegation.created',event_id:`notice-${id}`,offset_ms,delegation:{id,type:'delegation',target:'client'}});

test('an early delegation is retained with no invented utterance or completed-turn marker',()=>{
 const context=createLiveConversation(scope);context.observe(delegate('item-delegate'));
 expect(context.pending()).toEqual(['item-delegate']);expect(context.forDelegation('item-delegate')).toBeNull();
 context.observe(input('event-1','No domingo,',900,1300));
 const first=context.forDelegation('item-delegate')!;
 expect(first.fragments[0]).toEqual({eventId:'event-1',speaker:'owner',text:'No domingo,',startMs:900,endMs:1300,arrival:0});
 expect(first).not.toHaveProperty('turnCompleted');expect(first).not.toHaveProperty('providerItemId');
 context.observe(input('event-2','só emergências.',1300,2200));
 expect(context.forDelegation('item-delegate')!.fragments).toHaveLength(2);
 expect(context.pending()).toEqual(['item-delegate']);
});

test('overlapping acknowledgments retain independent speaker/time provenance',()=>{
 const context=createLiveConversation(scope);
 context.observe(input('event-1','Não temos um mínimo',1000,2000));
 context.observe({type:'session.output_transcript.delta',event_id:'event-2',delta:'Entendi.',start_ms:1700,end_ms:1900});
 context.observe(input('event-3','numérico definido.',2000,2800));context.observe(delegate('item-1',2700));
 expect(context.forDelegation('item-1')!.fragments.map(f=>[f.speaker,f.text])).toEqual([['owner','Não temos um mínimo'],['assistant','Entendi.'],['owner','numérico definido.']]);
 expect(context.forDelegation('item-1')!.fragments[1].startMs).toBe(1700);
});

test('duplicate events replay without duplication; conflicting event identity is rejected',()=>{
 const context=createLiveConversation(scope);const e=input('event-1','Sim',0,100);
 context.observe(e);context.observe(e);context.observe(delegate('item-1'));context.observe(delegate('item-1'));
 expect(context.forDelegation('item-1')!.fragments).toHaveLength(1);
 expect(()=>context.observe({...e,delta:'Não'})).toThrow('live_event_conflict');
});

test('delayed fragments keep provider timeline and arrival order without claiming silence',()=>{
 const context=createLiveConversation(scope);context.observe(input('later','com aprovação.',3000,4000));
 context.observe(delegate('item-1',3900));context.observe(input('earlier','Só',2000,2900));
 const result=context.forDelegation('item-1')!;
 expect(result.fragments.map(f=>f.eventId)).toEqual(['earlier','later']);
 expect(result.fragments.map(f=>f.arrival)).toEqual([1,0]);
 expect(result).not.toHaveProperty('silenceMs');
});

test('context returned to a backend cannot mutate retained evidence',()=>{
 const context=createLiveConversation(scope);context.observe(input('e1','Sim',1,2));context.observe(delegate('d1'));
 context.forDelegation('d1')!.fragments[0].text='changed';
 expect(context.forDelegation('d1')!.fragments[0].text).toBe('Sim');
});

test('new input does not cancel backend work, but explicit supersession retains an audit record',()=>{
 const context=createLiveConversation(scope);context.observe(input('e1','sexta',1,2));context.observe(delegate('d1'));
 context.observe(input('e2','quinta, não sexta',3,4));context.observe(delegate('d2'));
 expect(context.pending()).toEqual(['d1','d2']);context.supersede('d1','d2');
 expect(context.pending()).toEqual(['d2']);expect(context.forDelegation('d1')!.delegation.supersededBy).toBe('d2');
});

test('separate scopes cannot share transcript or delegation context',()=>{
 const first=createLiveConversation(scope),second=createLiveConversation({...scope,tenantId:'tenant-b',providerSessionId:'live-b'});
 first.observe(input('e1','private owner information',1,2));first.observe(delegate('d1'));
 expect(second.forDelegation('d1')).toBeNull();expect(second.pending()).toEqual([]);
});

test('operation identity is application-owned and independent of a fresh delegation ID',()=>{
 const a={scope,kind:'answer',targetIds:['sunday'],sourceEventIds:['e1','e2'],interpretation:'Somente emergências.'};
 const ref=liveOperationReference(a);
 expect(ref).toMatch(/^ligou-live-op:[a-f0-9]{64}$/);
 expect(liveOperationReference({...a,delegationId:'d2'} as any)).toBe(ref);
 expect(liveOperationReference({...a,sourceEventIds:['e2','e1']})).toBe(ref);
 expect(liveOperationReference({...a,sourceEventIds:['e3'],kind:'correction'})).not.toBe(ref);
 expect(liveOperationReference({...a,scope:{...scope,tenantId:'other'}})).not.toBe(ref);
 expect(liveOperationReference({...a,interpretation:'Atendimento normal.'})).not.toBe(ref);
});

test('invalid timing and legacy transcript events do not fabricate Live evidence',()=>{
 const context=createLiveConversation(scope);
 context.observe({type:'conversation.item.input_audio_transcription.completed',item_id:'old',transcript:'unrelated'});
 expect(()=>context.observe(input('bad','x',-1,2))).toThrow('live_transcript_invalid');
 expect(()=>context.observe(input('bad','x',3,2))).toThrow('live_transcript_invalid');
 context.observe(delegate('d1'));expect(context.forDelegation('d1')).toBeNull();
});
