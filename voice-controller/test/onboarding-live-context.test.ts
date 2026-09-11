import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createLiveEvidence,liveOperationReference} from '../src/onboarding-live-context.ts';
const scope={tenantId:'tenant-a',interviewId:'interview-a',callId:'call-a',providerSessionId:'live-a'};
const input=(event_id:string,delta:string,start_ms:number,end_ms:number)=>({type:'session.input_transcript.delta',event_id,delta,start_ms,end_ms});

test('records original speaker/timeline evidence without rebuilding delegation input or turns',()=>{
 const evidence=createLiveEvidence(scope);
 evidence.observe(input('later','somente emergências.',600,1100));
 evidence.observe({type:'session.output_transcript.delta',event_id:'ack',delta:'Uhum.',start_ms:400,end_ms:700});
 evidence.observe(input('earlier','Domingo: ',100,500));
 evidence.observe({type:'session.delegation.created',delegation:{id:'d1',target:'responses'},offset_ms:1100});
 expect(evidence.fragments().map(f=>[f.speaker,f.text,f.arrival])).toEqual([['owner','Domingo: ',2],['assistant','Uhum.',1],['owner','somente emergências.',0]]);
 expect(evidence).not.toHaveProperty('forDelegation');expect(evidence).not.toHaveProperty('pending');
});
test('duplicate source events do not duplicate evidence and conflicts cannot rewrite it',()=>{
 const evidence=createLiveEvidence(scope),event=input('e1','Não',0,100);evidence.observe(event);evidence.observe(event);
 expect(evidence.fragments()).toHaveLength(1);expect(()=>evidence.observe({...event,delta:'Sim'})).toThrow('live_event_conflict');
 const copy=evidence.fragments();copy[0].text='changed';expect(evidence.fragments()[0].text).toBe('Não');
});
test('evidence remains session isolated; malformed and legacy input never fabricates Live provenance',()=>{
 const a=createLiveEvidence(scope),b=createLiveEvidence({...scope,tenantId:'other'});a.observe(input('e1','private',1,2));
 expect(b.fragments()).toEqual([]);
 expect(()=>a.observe(input('bad','x',3,2))).toThrow('live_transcript_invalid');
 a.observe({type:'conversation.item.input_audio_transcription.completed',item_id:'legacy',transcript:'x'});
 expect(a.fragments()).toHaveLength(1);
});
test('business operation identity is independent of delegation ID and paraphrased retry payload',()=>{
 const value={scope,kind:'answer',targetIds:['sunday'],sourceEventIds:['e1','e2'],interpretation:'Somente emergências.'};
 const ref=liveOperationReference(value);expect(ref).toMatch(/^ligou-live-op:[a-f0-9]{64}$/);
 expect(liveOperationReference({...value,delegationId:'d2'} as any)).toBe(ref);
 expect(liveOperationReference({...value,sourceEventIds:['e2','e1'],interpretation:'changed payload'})).toBe(ref);
 expect(liveOperationReference({...value,sourceEventIds:['e3'],kind:'correction'})).not.toBe(ref);
 expect(liveOperationReference({...value,scope:{...scope,tenantId:'other'}})).not.toBe(ref);
});
test('opaque mixed-case provider IDs retain existing JavaScript ASCII operation identities',()=>{
 const ids=['event_EMprtp89IJG3fQjJgW3Kj','event_EMprtP9ibMmap8NZdtgPz'];
 const input={scope,kind:'answer',targetIds:['sunday'],sourceEventIds:ids,interpretation:'No automated discount.'};
 const previous='ligou-live-op:'+createHash('sha256').update(JSON.stringify([1,scope.tenantId,scope.interviewId,scope.callId,scope.providerSessionId,'answer',['sunday'],[...ids].sort()])).digest('hex');
 expect(liveOperationReference(input)).toBe(previous);
 expect(liveOperationReference({...input,sourceEventIds:[...ids].reverse()})).toBe(previous);
});
test('opaque Unicode identities use UTF8 byte order instead of default UTF16 ordering',()=>{
 const ids=['event_😀','event_\uE000'];
 expect([...ids].sort()).toEqual(['event_😀','event_\uE000']);
 const canonical='ligou-live-op:'+createHash('sha256').update(JSON.stringify([1,scope.tenantId,scope.interviewId,scope.callId,scope.providerSessionId,'answer',['sunday'],['event_\uE000','event_😀']])).digest('hex');
 expect(liveOperationReference({scope,kind:'answer',targetIds:['sunday'],sourceEventIds:ids,interpretation:'Unicode identity test.'})).toBe(canonical);
});
