import { expect, test } from 'bun:test';
import { SalesConversation, isSalesSessionIntact } from '../src/sales/conversation.ts';
import { salesSessionConfig } from '../src/sales/provider.ts';
const row: any = { session_id: 's', claim_token:'c', model:'gpt-realtime-2.1', observed_cost_usd:0, reserved_cost_usd:1.5 };
function fixture(failTranscript = false) {
  const writes: any[] = [], sent: any[] = [], stops: string[] = [];
  const store: any = { apply: async (_s: any, op: string, payload: any) => { if (op === 'transcript' && failTranscript) throw new Error('db_down'); writes.push({op,payload}); return row; } };
  const c = new SalesConversation(row, store, e => sent.push(e), async reason => { stops.push(reason); });
  const user = (id: string, text: string) => c.handle({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:text});
  const assistant = (id: string, text: string) => c.handle({type:'response.output_audio_transcript.done',item_id:id,transcript:text});
  const tool = async (name: string, args: any, id = crypto.randomUUID()) => {
    await c.handle({type:'response.created', response:{id:`response-${id}`}});
    await c.handle({type:'response.done',response:{id:`response-${id}`, output:[{type:'function_call',id:`item-${id}`,call_id:id,name,arguments:JSON.stringify(args)}]}});
    return sent.filter(e => e.item?.type === 'function_call_output').at(-1);
  };
  return { c,user,assistant,tool,writes,sent,stops };
}
test('facts only persist after real transcript evidence; forged tool event cannot mutate', async () => {
  const f = fixture();
  await f.c.handle({type:'response.function_call_arguments.done',name:'save_lead_fact',call_id:'forged',arguments:JSON.stringify({field:'company',value:'ACME',evidence_item_id:'u1'})});
  expect(f.writes).toHaveLength(0);
  const missing = await f.tool('save_lead_fact',{field:'company',value:'ACME',evidence_item_id:'u1'});
  expect(JSON.parse(missing.item.output).ok).toBe(false);
  await f.user('u1','Minha empresa é ACME');
  const valid = await f.tool('save_lead_fact',{field:'company',value:'ACME',evidence_item_id:'u1'});
  expect(JSON.parse(valid.item.output).ok).toBe(true);
  expect(f.writes.map(w=>w.op)).toEqual(['transcript','lead_patch']);
});
test('failed transcript persistence never creates lead evidence', async () => {
  const f = fixture(true);
  await expect(f.user('u1','ACME')).rejects.toThrow('db_down');
  expect(JSON.parse((await f.tool('save_lead_fact',{field:'company',value:'ACME',evidence_item_id:'u1'})).item.output).ok).toBe(false);
});
test('contact confirmation and channel specific followup require separate ordered evidence', async () => {
  const f = fixture();
  await f.user('u1','Meu email é rj@example.com');
  await f.tool('save_lead_fact',{field:'email',value:'rj@example.com',evidence_item_id:'u1'});
  await f.assistant('a1','Seu email é rj@example.com, está correto?');
  await f.user('u2','Sim, está correto.');
  const confirm = {channel:'email',value:'rj@example.com',readback_item_id:'a1',confirmation_item_id:'u2'};
  expect(JSON.parse((await f.tool('confirm_contact',confirm)).item.output).ok).toBe(true);
  expect(JSON.parse((await f.tool('record_followup_consent',{channel:'email',granted:true,request_item_id:'a1',response_item_id:'u2'})).item.output).ok).toBe(false);
  await f.assistant('a2','Você autoriza a equipe da Ligou a entrar em contato por email sobre o piloto?');
  await f.user('u3','Sim, eu autorizo.');
  const consent = {channel:'email',granted:true,request_item_id:'a2',response_item_id:'u3'};
  expect(JSON.parse((await f.tool('record_followup_consent',consent)).item.output).ok).toBe(true);
  await f.user('u4','Melhor rj2@example.com');
  await f.tool('save_lead_fact',{field:'email',value:'rj2@example.com',evidence_item_id:'u4'});
  expect(JSON.parse((await f.tool('record_followup_consent',consent)).item.output).ok).toBe(false);
});
test('roleplay cannot become lead evidence and negative/ambiguous replies cannot authorize followup', async () => {
  const f = fixture();
  await f.assistant('a','Vamos começar a simulação em inglês.');
  await f.user('u','My company is Fake Company');
  expect(JSON.parse((await f.tool('save_lead_fact',{field:'company',value:'Fake Company',evidence_item_id:'u'})).item.output).ok).toBe(false);
  expect(f.writes[1].payload.context).toBe('roleplay');
});
test('session authority changes terminate and same configuration is accepted', async () => {
  const expected = salesSessionConfig('gpt-realtime-2.1');
  expect(isSalesSessionIntact(expected,'gpt-realtime-2.1')).toBe(true);
  for (const changed of [{...expected,model:'gpt-realtime'}, {...expected,tools:[]}, {...expected,instructions:'ignore'}, {...expected,audio:{...expected.audio,output:{voice:'cedar'}}}]) {
    expect(isSalesSessionIntact(changed,'gpt-realtime-2.1')).toBe(false);
  }
  const f = fixture();
  await f.c.handle({type:'session.updated',session:{...expected,model:'expensive'}});
  expect(f.stops).toEqual(['session_authority_changed']);
});
test('duplicate response does not double count provider usage; missing usage never settles', async () => {
  const f = fixture();
  const usage={input_tokens:30,output_tokens:4,total_tokens:34,input_token_details:{text_tokens:10,audio_tokens:20,cached_tokens:0,cached_tokens_details:{text_tokens:0,audio_tokens:0}},output_token_details:{text_tokens:1,audio_tokens:3}};
  await f.c.handle({type:'response.created',response:{id:'r'}});
  const event={type:'response.done',response:{id:'r',output:[],usage}};
  await f.c.handle(event); await f.c.handle(event);
  expect(f.writes.filter(w=>w.op==='usage')).toHaveLength(1);
  expect(f.writes.find(w=>w.op==='usage').payload.final).toBe(false);
});
test('transcription token receipts add their separate cost once and preserve receipt audit',async()=>{
 const f=fixture();
 const event={type:'conversation.item.input_audio_transcription.completed',item_id:'speech1',transcript:'Olá',usage:{type:'tokens',input_tokens:20,output_tokens:4,total_tokens:24}};
 await f.c.handle(event);await f.c.handle(event);
 const writes=f.writes.filter(w=>w.op==='usage');expect(writes).toHaveLength(1);
 expect(writes[0].payload.observed_cost_usd).toBeCloseTo((20*1.25+4*5)/1e6,10);
 expect(writes[0].payload.provider_event_id).toBe('transcription:speech1');
 expect(f.writes.find(w=>w.op==='transcript').payload.usage).toEqual(event.usage);
});
test('authoritative terminal usage can settle only when every transcription and response receipt is complete',async()=>{
 const f=fixture();
 const usage={input_tokens:30,output_tokens:4,total_tokens:34,input_token_details:{text_tokens:10,audio_tokens:20,cached_tokens:0,cached_tokens_details:{text_tokens:0,audio_tokens:0}},output_token_details:{text_tokens:1,audio_tokens:3}};
 await f.c.handle({type:'input_audio_buffer.committed',item_id:'u'});
 await f.c.handle({type:'conversation.item.input_audio_transcription.completed',item_id:'u',transcript:'Olá',usage:{type:'tokens',input_tokens:20,output_tokens:4,total_tokens:24}});
 await f.c.handle({type:'response.created',response:{id:'r'}});
 await f.c.handle({type:'response.done',response:{id:'r',usage,output:[]}});
 await f.c.handle({type:'session.ended',event_id:'end1',usage});
 expect(f.writes.filter(w=>w.op==='usage').at(-1).payload.final).toBe(true);
 const missing=fixture();await missing.user('u','Olá');await missing.c.handle({type:'session.ended',event_id:'end2',usage});
 expect(missing.writes.filter(w=>w.op==='usage').at(-1).payload.final).toBe(false);
});
test('a negative or qualified confirmation cannot authorize contact',async()=>{
 for(const reply of ['Não está correto','Sim, mas não autorizo','Talvez','Sim, se eu decidir depois','Yes, but not now','Yes, if I decide later','Sí, pero no ahora']){
  const f=fixture();await f.user('u','Meu email é rj@example.com');await f.tool('save_lead_fact',{field:'email',value:'rj@example.com',evidence_item_id:'u'});
  await f.assistant('a','Seu email é rj@example.com, correto?');await f.user('reply',reply);
  expect(JSON.parse((await f.tool('confirm_contact',{channel:'email',value:'rj@example.com',readback_item_id:'a',confirmation_item_id:'reply'})).item.output).ok).toBe(false);
 }
});
test('English and Spanish contact confirmation and separate consent preserve withdrawal',async()=>{
 for(const [read,yes,request,withdrawal] of [
  ['Your email is rj@example.com, correct?','Yes, correct.','Do you authorize the Ligou team to contact you by email about the pilot?','Please do not contact me.'],
  ['Tu correo es rj@example.com, ¿correcto?','Sí, correcto.','¿Autoriza al equipo Ligou a contactarle por email sobre el piloto?','No me contacte más.'],
 ]) {
  const f=fixture();await f.user('fact','rj@example.com');await f.tool('save_lead_fact',{field:'email',value:'rj@example.com',evidence_item_id:'fact'});
  await f.assistant('read',read);await f.user('confirm',yes);
  expect(JSON.parse((await f.tool('confirm_contact',{channel:'email',value:'rj@example.com',readback_item_id:'read',confirmation_item_id:'confirm'})).item.output).ok).toBe(true);
  await f.assistant('ask',request);await f.user('allow',yes);
  expect(JSON.parse((await f.tool('record_followup_consent',{channel:'email',granted:true,request_item_id:'ask',response_item_id:'allow'})).item.output).ok).toBe(true);
  await f.user('revoke',withdrawal);
  expect(f.writes.filter(w=>w.op==='lead_patch'&&w.payload.followup_consent).at(-1).payload.followup_consent.granted).toBe(false);
 }
});
test('unrelated later yes cannot retroactively confirm contact',async()=>{
 const f=fixture();await f.user('u','Meu email é rj@example.com');await f.tool('save_lead_fact',{field:'email',value:'rj@example.com',evidence_item_id:'u'});
 await f.assistant('a','Seu email é rj@example.com, correto?');await f.user('other','Quero saber o preço');await f.assistant('a2','Quer ouvir sobre o piloto?');await f.user('yes','Sim');
 expect(JSON.parse((await f.tool('confirm_contact',{channel:'email',value:'rj@example.com',readback_item_id:'a',confirmation_item_id:'yes'})).item.output).ok).toBe(false);
});
test('browser override to textual response or larger output is terminated',async()=>{
 for(const response of [{id:'r',output_modalities:['text']},{id:'r',max_output_tokens:10000}]){
  const f=fixture();await f.c.handle({type:'response.created',response});expect(f.stops).toEqual(['response_authority_changed']);
 }
});
test('agent end waits for buffered farewell playback to finish',async()=>{
 const f=fixture();await f.c.handle({type:'output_audio_buffer.started'});await f.tool('end_sales_call',{});expect(f.stops).toHaveLength(0);
 await f.c.handle({type:'output_audio_buffer.stopped'});expect(f.stops).toEqual(['agent_ended']);
});
async function consentFixture(){
 const f=fixture();
 await f.user('contact','Meu email é rj@example.com');await f.tool('save_lead_fact',{field:'email',value:'rj@example.com',evidence_item_id:'contact'});
 await f.assistant('read','Seu email é rj@example.com, correto?');await f.user('confirm','Sim, correto');
 await f.tool('confirm_contact',{channel:'email',value:'rj@example.com',readback_item_id:'read',confirmation_item_id:'confirm'});
 await f.assistant('ask','Você autoriza a equipe da Ligou a entrar em contato por email sobre o piloto?');await f.user('yes','Sim, eu autorizo');
 const grant={channel:'email',granted:true,request_item_id:'ask',response_item_id:'yes'};
 await f.tool('record_followup_consent',grant);
 return {...f,grant,decision:()=>f.writes.filter(w=>w.op==='lead_patch'&&w.payload.followup_consent).at(-1)?.payload.followup_consent};
}
test('real unsolicited withdrawal immediately clears consent before any model tool and old yes stays rejected',async()=>{
 const f=await consentFixture();expect(f.decision().granted).toBe(true);
 await f.assistant('thanks','Muito obrigado.');await f.user('withdraw','Não autorizo mais o contato');
 expect(f.decision()).toEqual({granted:false,response_item_id:'withdraw'});
 expect(JSON.parse((await f.tool('record_followup_consent',f.grant)).item.output).ok).toBe(false);
 expect(f.decision().granted).toBe(false);
 expect(JSON.parse((await f.tool('record_followup_consent',{granted:false,response_item_id:'withdraw'})).item.output).ok).toBe(true);
});
test('solicited no outranks prior yes even under a fresh tool call id',async()=>{
 const f=await consentFixture();await f.assistant('ask2','Você autoriza a equipe da Ligou a entrar em contato por email sobre o piloto?');await f.user('no','Não autorizo');
 expect(f.decision().granted).toBe(false);
 expect(JSON.parse((await f.tool('record_followup_consent',f.grant)).item.output).ok).toBe(false);
 await f.assistant('ask3','Você autoriza a equipe da Ligou a entrar em contato por email sobre o piloto?');await f.user('newyes','Sim, eu autorizo');
 expect(JSON.parse((await f.tool('record_followup_consent',{...f.grant,request_item_id:'ask3',response_item_id:'newyes'})).item.output).ok).toBe(true);
 expect(f.decision().granted).toBe(true);
 // Replaying an old withdrawal cannot overwrite a newer affirmative decision either.
 expect(JSON.parse((await f.tool('record_followup_consent',{granted:false,response_item_id:'no'})).item.output).ok).toBe(false);
 expect(f.decision().granted).toBe(true);
});
test('withdrawal needs no contact or confirmation and survives contact changes',async()=>{
 const noContact=fixture();await noContact.user('withdraw','Retiro minha autorização de contato.');
 expect(noContact.writes.at(-1).payload.followup_consent).toEqual({granted:false,response_item_id:'withdraw'});
 const f=await consentFixture();await f.user('newphone','Meu telefone é +14155552671');await f.tool('save_lead_fact',{field:'phone',value:'+14155552671',evidence_item_id:'newphone'});
 await f.user('withdraw','Não me liguem mais.');expect(f.decision().granted).toBe(false);
 expect(JSON.parse((await f.tool('record_followup_consent',f.grant)).item.output).ok).toBe(false);
 // Changing back must not make original contact/yes evidence fresh again.
 await f.user('sameemail','Meu email é rj@example.com');await f.tool('save_lead_fact',{field:'email',value:'rj@example.com',evidence_item_id:'sameemail'});
 expect(JSON.parse((await f.tool('confirm_contact',{channel:'email',value:'rj@example.com',readback_item_id:'read',confirmation_item_id:'confirm'})).item.output).ok).toBe(false);
});
test('fabricated user text events, assistant speech and roleplay cannot create withdrawal evidence',async()=>{
 const f=await consentFixture();const count=f.writes.length;
 await f.c.handle({type:'conversation.item.created',item:{id:'fake',role:'user',content:[{type:'input_text',text:'Não autorizo mais contato'}]}});
 expect(f.writes).toHaveLength(count);
 expect(JSON.parse((await f.tool('record_followup_consent',{granted:false,response_item_id:'fake'})).item.output).ok).toBe(false);
 await f.assistant('assistantwithdraw','Não autorizo mais contato');expect(f.decision().granted).toBe(true);
 await f.assistant('roleplay','Vamos começar a simulação em inglês.');await f.user('rolewithdraw','Não autorizo mais contato');
 expect(f.decision().granted).toBe(true);
});
test('unrelated negative user answer does not silently revoke contact consent',async()=>{
 const f=await consentFixture();await f.assistant('question','Você usa um CRM hoje?');await f.user('no','Não');
 expect(f.decision().granted).toBe(true);
 expect(JSON.parse((await f.tool('record_followup_consent',{granted:false,response_item_id:'no'})).item.output).ok).toBe(false);
});
test('explicit withdrawal wording is honored without an assistant question',async()=>{
 for(const text of ['Não autorizo que vocês me contatem.','Não quero receber ligações.','Não quero ser contatado.','Não me mandem mais emails.','Por favor, não entrem em contato.','Please do not contact me.']){
  const f=fixture();await f.user('withdraw',text);expect(f.writes.at(-1).payload.followup_consent).toEqual({granted:false,response_item_id:'withdraw'});
 }
});

test('mentioning a product demonstration does not turn real business facts into roleplay',async()=>{
 const f=fixture();
 await f.assistant('intro','Sou uma IA da Ligou. Posso fazer uma demonstração depois de conhecer sua empresa.');
 await f.user('business','Minha empresa é ACME.');
 const saved=await f.tool('save_lead_fact',{field:'company',value:'ACME',evidence_item_id:'business'});
 expect(JSON.parse(saved.item.output).ok).toBe(true);
 expect(f.writes.find(w=>w.op==='transcript'&&w.payload.provider_item_id==='business').payload.context).toBe('real');
});

test('a tool waits for committed audio evidence instead of asking the visitor to repeat it',async()=>{
 const f=fixture();
 await f.c.handle({type:'input_audio_buffer.committed',item_id:'business'});
 await f.c.handle({type:'response.created',response:{id:'r-pending'}});
 await f.c.handle({type:'response.done',response:{id:'r-pending',output:[{type:'function_call',call_id:'save-business',name:'save_lead_fact',arguments:JSON.stringify({field:'company',value:'ACME',evidence_item_id:'business'})}]}});
 expect(f.sent.filter(e=>e.item?.type==='function_call_output')).toHaveLength(0);
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 await f.user('business','Minha empresa é ACME.');
 const outputs=f.sent.filter(e=>e.item?.type==='function_call_output');
 expect(outputs).toHaveLength(1);
 expect(JSON.parse(outputs[0].item.output).ok).toBe(true);
 expect(f.writes.map(w=>w.op)).toEqual(['transcript','lead_patch']);
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
 await f.user('business','Minha empresa é ACME.');
 expect(f.sent.filter(e=>e.item?.type==='function_call_output')).toHaveLength(1);
});

test('deferred tool continuation does not collide with an active provider response',async()=>{
 const f=fixture();
 await f.c.handle({type:'input_audio_buffer.committed',item_id:'business'});
 await f.tool('save_lead_fact',{field:'company',value:'ACME',evidence_item_id:'business'},'deferred');
 await f.c.handle({type:'response.created',response:{id:'r-active'}});
 await f.user('business','Minha empresa é ACME.');
 expect(f.sent.filter(e=>e.item?.type==='function_call_output')).toHaveLength(1);
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 await f.c.handle({type:'response.done',response:{id:'r-active',output:[]}});
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
});

test('declining a simulation keeps subsequent business facts in the real conversation',async()=>{
 const f=fixture();
 await f.assistant('decline','Não vamos começar a simulação agora. Vamos falar da sua empresa.');
 await f.user('business','Minha empresa é ACME.');
 expect(JSON.parse((await f.tool('save_lead_fact',{field:'company',value:'ACME',evidence_item_id:'business'})).item.output).ok).toBe(true);
});

test('a delayed caller transcript stays before the assistant readback for contact confirmation',async()=>{
 const f=fixture();
 await f.c.handle({type:'input_audio_buffer.committed',item_id:'contact'});
 await f.assistant('read','Seu email é rj@example.com, está correto?');
 await f.user('contact','Meu email é rj@example.com');
 await f.tool('save_lead_fact',{field:'email',value:'rj@example.com',evidence_item_id:'contact'});
 await f.user('yes','Sim, está correto.');
 expect(JSON.parse((await f.tool('confirm_contact',{channel:'email',value:'rj@example.com',readback_item_id:'read',confirmation_item_id:'yes'})).item.output).ok).toBe(true);
 expect(f.writes.filter(w=>w.op==='transcript').map(w=>w.payload.provider_item_id)).toEqual(['contact','read','yes']);
});

test('automatic VAD replies are disabled while Ash, semantic VAD and interruption remain unchanged',()=>{
 const s=salesSessionConfig('gpt-realtime-2.1');
 expect(s.audio.input.turn_detection).toEqual({type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:true});
 expect(s.audio.output.voice).toBe('ash');
 expect(s.model).toBe('gpt-realtime-2.1');
 expect(isSalesSessionIntact({...s,audio:{...s.audio,input:{...s.audio.input,turn_detection:{...s.audio.input.turn_detection,create_response:true}}}},'gpt-realtime-2.1')).toBe(false);
});

test('a real caller turn creates one response only after persisted transcription',async()=>{
 const f=fixture();
 await f.c.handle({type:'input_audio_buffer.speech_started',item_id:'u'});
 await f.c.handle({type:'input_audio_buffer.committed',item_id:'u'});
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 await f.user('u','Minha empresa é ACME');
 expect(f.writes[0].op).toBe('transcript');
 expect(f.sent[0].item.content[0].text).toContain('Evidência persistida');
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
 await f.user('u','Minha empresa é ACME');
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
});

test('empty transcription emits a diagnostic without starting another repeat request',async()=>{
 const f=fixture();
 await f.c.handle({type:'input_audio_buffer.committed',item_id:'noise'});
 await f.user('noise','  ');
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 expect(f.sent.some(e=>e.item?.content?.[0]?.text?.includes('LIGOU_SALES_DIAGNOSTIC:{"code":"no_speech_detected"}'))).toBe(true);
 expect(f.writes.filter(w=>w.op==='transcript')).toHaveLength(0);
});

test('caller interrupt waits for the cancelled response completion before responding',async()=>{
 const f=fixture();
 await f.c.handle({type:'response.created',response:{id:'speaking'}});
 await f.c.handle({type:'input_audio_buffer.speech_started',item_id:'interrupt'});
 await f.c.handle({type:'input_audio_buffer.committed',item_id:'interrupt'});
 await f.user('interrupt','Quero saber o preço.');
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 await f.c.handle({type:'response.done',response:{id:'speaking',status:'cancelled',output:[]}});
 expect(f.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
});

test('explicit English and Spanish simulations cannot become real leads',async()=>{
 for(const [start,end] of [['Starting the simulation.','End of simulation, back to your business.'],['Comenzamos la simulación.','Fin de la simulación, volviendo a tu empresa.']]){
  const f=fixture();await f.assistant('start',start);await f.user('fake','Fake Company');
  expect(JSON.parse((await f.tool('save_lead_fact',{field:'company',value:'Fake Company',evidence_item_id:'fake'})).item.output).ok).toBe(false);
  await f.assistant('end',end);await f.user('real','Real Company');
  expect(JSON.parse((await f.tool('save_lead_fact',{field:'company',value:'Real Company',evidence_item_id:'real'})).item.output).ok).toBe(true);
 }
});
