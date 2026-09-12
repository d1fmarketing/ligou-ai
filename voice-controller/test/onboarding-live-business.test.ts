import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createLiveBusinessSession,projectLiveBusinessContext,LIVE_BUSINESS_TOOLS} from '../src/onboarding-live-business';
import {selectLiveQuestions,rankLiveQuestions,LIVE_QUESTION_CAP,LIVE_QUESTION_BYTES} from '../src/onboarding-live-questions';
import {buildWebsiteAgendaSeeds} from '../src/onboarding-agenda-seed';
import {buildWebsiteCandidateContext} from '../src/onboarding-website-summary';
import {createLiveInterviewStore} from '../src/onboarding-live-store';
import {createOnboardingAgenda,getAgendaAction,getAgendaItems} from '../src/onboarding-agenda';
import {onboardingAgendaDigest} from '../src/onboarding-agenda-store';
import type {PreparedWebsiteInterview} from '../src/onboarding-website-bootstrap';
const id=(n:number)=>`9f000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const binding={interviewId:id(1),callId:id(1),draftId:id(2),draftHash:'a'.repeat(64),sourceResultId:id(3),sourceResultHash:'b'.repeat(64)};
const actor={ownerId:id(4),callId:id(1),requestId:id(5)};
const scope={...actor,tenantId:id(6),interviewId:id(1),providerSessionId:'live-session-one'};
const ctx={delegationId:'delegation-one',responseId:'response-one',toolCallId:'tool-one',delegationOffsetMs:1000};
const fragment=(event_id='owner-one',delta='No domingo, só emergência.',start_ms=100,end_ms=500)=>({type:'session.input_transcript.delta',event_id,delta,start_ms,end_ms});
function fixture(options:{recordFails?:boolean;commitLost?:boolean;commitUnknown?:boolean;holdRecord?:boolean;readCorrupt?:boolean;commitRejection?:{code:string;message:string}}={}){
  const agenda=createOnboardingAgenda(binding,[
    {id:'permissions',source:'owner_private_requirement',subject:'calendar',questionPt:'Pode consultar a agenda?',coverageRefs:['calendar'],relatedItemIds:[],blocking:true},
    {id:'sunday',source:'contradiction',subject:'business_hours',questionPt:'Qual a regra de domingo?',coverageRefs:['hours'],relatedItemIds:[],blocking:true},
    {id:'floor',source:'owner_private_requirement',subject:'negotiation',questionPt:'Qual o limite privado?',coverageRefs:['floor'],relatedItemIds:[],blocking:true},
  ],[{id:`candidate:${id(7)}`,subject:'service',questionPt:'Qual o preço correto da limpeza?',coverageRefs:[`discovery.candidate.${id(7).replaceAll('-','')}`]}]);
  let stored:any={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:id(8),nextAction:getAgendaAction(agenda),state:'unfinished',replayed:false};
  const projection:any={provenance:{tenantId:id(6)},candidateRecap:[{claim_id:id(7),claim_type:'service',value:{service_type:'Limpeza',public_price:{amount:'149.00',currency:'USD'}}}]};
  const prepared={scope:actor,stored,projection} as PreparedWebsiteInterview;
  const records=new Map<string,any>(),operations=new Map<string,any>(),calls:any[]=[];let stops=0,commits=0,lastArgs:any;
  function apply(args:any){
    const prior=operations.get(args.p_operation);
    if(prior){
      if(prior.interpretation!==args.p_interpretation)throw Object.assign(Error('live_operation_conflict'),{code:'P0001'});
      return{...stored,replayed:true,operationRef:args.p_operation,operationReceiptId:prior.operationReceiptId,operationRevision:prior.operationRevision};
    }
    if(args.p_revision!==stored.revision||args.p_digest!==stored.digest||args.p_store_version!==stored.storeVersion)throw Object.assign(Error('interview_revision_changed'),{code:'40001'});
    const next=structuredClone(stored.agenda);let target=[...next.items,...next.candidateOverrides].find((i:any)=>i.id===args.p_target);
    if(!target&&['correction','reopen'].includes(args.p_kind)){
      const candidate=next.candidateContext.find((i:any)=>i.id===args.p_target);
      if(candidate){target={...candidate,source:'contradiction',relatedItemIds:[],blocking:true,status:'open',answerRevision:0,clarificationCount:0,lastQuestionPt:candidate.questionPt,evidence:[]};next.candidateOverrides.push(target);}
    }
    if(!target)throw Error('live_target_not_in_catalogue');
    const ownerEvidence={turnId:`${scope.callId}:${args.p_operation}`,text:args.p_interpretation,provenance:'model_interpretation'};
    target.evidence.push(ownerEvidence);next.ownerTurns.push(ownerEvidence);next.revision++;
    target.answerRevision+=args.p_kind==='defer'?0:1;
    target.status=({answer:'answered',correction:'corrected',reopen:'open',defer:'deferred_owner_review',not_applicable:'not_applicable'} as any)[args.p_kind];
    stored={...stored,agenda:next,revision:next.revision,storeVersion:stored.storeVersion+1,digest:onboardingAgendaDigest(next),receiptId:id(20+next.revision),nextAction:getAgendaAction(next)};
    const proof={operationRef:args.p_operation,operationReceiptId:stored.receiptId,operationRevision:stored.revision,kind:args.p_kind,targetId:args.p_target,
      sourceEventIds:args.p_source_ids,interpretation:args.p_interpretation,providerSessionId:args.p_session};operations.set(args.p_operation,proof);
    return{...stored,...proof};
  }
  const client={rpc:async(name:string,args:Record<string,unknown>)=>{
    calls.push({name,args});
    if(name==='read_website_interview')return{data:options.readCorrupt?{...stored,digest:'c'.repeat(64)}:stored,error:null};
    if(name==='record_website_live_fragments'){
      if(options.holdRecord)await new Promise(()=>undefined);
      if(options.recordFails)return{data:null,error:{message:'temporarily unavailable'},status:503};
      let added=0;for(const f of args.p_fragments as any[]){if(!records.has(f.eventId)){records.set(f.eventId,f);added++;}}
      return{data:{callId:scope.callId,providerSessionId:scope.providerSessionId,added},error:null};
    }
    if(name==='read_website_live_operation')return{data:operations.get(args.p_operation as string)??null,error:null};
    if(name==='commit_website_live_decision'){
      commits++;lastArgs=args;
      for(const sourceId of args.p_source_ids as string[])if(records.get(sourceId)?.speaker!=='owner')throw Error('source missing');
      if(options.commitUnknown)throw new TypeError('connection lost before outcome');
      if(options.commitRejection)return{data:null,error:options.commitRejection,status:400};
      try{const data=apply(args);if(options.commitLost&&commits===1)throw new TypeError('lost committed result');return{data,error:null};}
      catch(cause){if(cause instanceof TypeError)throw cause;return{data:null,error:{message:(cause as Error).message,code:(cause as any).code}};}
    }
    throw Error(`unexpected RPC ${name}`);
  }};
  const business=createLiveBusinessSession({prepared,businessName:'Empresa teste',client,onStop:()=>{stops++;}});
  business.bindSession(scope.providerSessionId);
  const context=()=>business.execute('get_context',{},ctx);
  const save=(contextRef:unknown,targetId='sunday',kind='answer',interpretation='No domingo, somente emergências.')=>business.execute('save_decision',{contextRef,targetId,kind,interpretation},ctx);
  return{business,client,prepared,options,records,operations,calls,context,save,stored:()=>stored,counts:()=>({commits,stops}),resolvePending:()=>apply(lastArgs)};
}

describe('Live managed business tools',()=>{
  test('voice prompt defines owner setup, ranked clarification points and end_call-only delegation',()=>{
    const f=fixture(),prompt=f.business.voiceInstructions,backend=f.business.backendInstructions;
    for(const label of ['Backend tools:','Delegate to the backend when:','Do not delegate to the backend when:'])expect(prompt.split(label)).toHaveLength(2);
    expect(prompt).toContain('configurar como o Ligou atenderá os clientes');
    expect(prompt).toContain('informações já coletadas do website');
    expect(prompt).toContain('Nenhum nome pessoal');
    expect(prompt).not.toContain('Ao iniciar a entrevista');expect(prompt).not.toContain('peça ao backend o estado atual');
    // Ranked clarification points (design §4): the contradiction first, then the owner-private items in seed order; all three fit.
    const positions=['Qual a regra de domingo?','Pode consultar a agenda?','Qual o limite privado?'].map(q=>prompt.indexOf(JSON.stringify(q)));
    expect(positions.every(p=>p>=0)).toBe(true);expect(positions).toEqual([...positions].sort((a,b)=>a-b));
    expect(backend).not.toContain('contextoInicial');expect(backend).not.toContain('save_decision');expect(backend).not.toContain('get_context');expect(backend).toContain('end_call');
    expect(backend).not.toContain('"contextRef"');expect(backend).not.toContain('"receiptId"');
    for(const trigger of ['corrigir','indefinido','encerrar','condições','regras'])expect(prompt).toContain(trigger);
    expect(prompt).toContain('sem consultar o backend');
    expect(prompt).toContain('cumprimento');expect(prompt).toContain('repetir');expect(prompt).toContain('clarificação');
    // Review 2026-09-12: the no-recording sentence names the backend, so identity confirmation and owner clarifications stay allowed.
    expect(prompt).toContain('não peça ao backend para registrar ou confirmar nada durante a conversa');expect(prompt).not.toContain('confirmação a ninguém');
    expect(prompt).toContain('Não faça perguntas fora da lista');
    // The closing is an example in the model's own words ("sem seguir frases fixas" stays), never a quoted script.
    expect(prompt).toContain('com suas palavras e em uma única fala, algo como:');expect(prompt).toContain('sem seguir frases fixas');
    // Owner questions about the Ligou itself are answered by the voice; the backend never ends a call on a stray delegation.
    expect(prompt).toContain('sobre o próprio Ligou');expect(backend).toContain('Em qualquer outro caso, responda em uma frase curta e não chame end_call');
    // Owner decisions (2026-09-12): no "vou registrar" pauses mid-call, and the internal ten-question ceiling is never announced as a limit, count or rule.
    expect(prompt).not.toMatch(/get_context|save_decision|contextRef|session\.close|response\.create|ASR|aguarde silêncio|frase exata|vou registrar|vou anotar|transcri[çc]|depois da conversa|limite de perguntas|dez perguntas|\b10 perguntas|número de perguntas|máximo de perguntas|regra interna|só posso (fazer|perguntar)/i);
    expect(prompt).toContain('por hoje é isso');expect(prompt).not.toContain('volto a falar');
    expect(f.business.tools.map(t=>t.name)).toEqual(['end_call']);
    expect(backend).toContain('despedida breve');expect(backend).toContain('cinco palavras');expect(backend).toContain('stopRequested=true');
  });
  test('website identity takes precedence over the account label without asserting legal confirmation',async()=>{
    const f=fixture(),name='Foghorn "Air", Inc.';
    const prepared={...f.prepared,projection:{...f.prepared.projection,candidateRecap:[...f.prepared.projection.candidateRecap,{claim_id:id(90),claim_type:'business_name',value:name}]}};
    const business=createLiveBusinessSession({prepared,businessName:'D1f Marketing',client:f.client,onStop:()=>{}});
    business.bindSession(scope.providerSessionId);
    expect(business.voiceInstructions).toContain(JSON.stringify(name));
    expect(business.voiceInstructions).not.toContain('D1f Marketing');
    const result=await business.execute('get_context',{},ctx);
    expect(result).toMatchObject({businessName:name,businessIdentity:{source:'selected_website_candidate',confirmed:false,candidateNames:[name]}});
  });
  test('missing website identity does not substitute the account label',async()=>{
    const f=fixture();expect(await f.context()).toMatchObject({businessName:null,businessIdentity:{candidateNames:[],confirmed:false}});
    expect(f.business.voiceInstructions).not.toContain('Empresa teste');
  });
  test('saves Sunday in its explicit target instead of the first unrelated question',async()=>{
    const f=fixture();f.business.observe(fragment());const context=await f.context();const result=await f.save(context.contextRef);
    expect(result.saved).toBe(true);expect(f.stored().agenda.items[0].status).toBe('open');expect(f.stored().agenda.items[1].status).toBe('answered');
    expect(f.stored().agenda.items[1].evidence[0]).toMatchObject({text:'No domingo, somente emergências.',provenance:'model_interpretation'});
    const write=f.calls.find(c=>c.name==='commit_website_live_decision').args;
    expect(write).toMatchObject({p_owner:actor.ownerId,p_call:actor.callId,p_request:actor.requestId,p_session:scope.providerSessionId,p_source_ids:['owner-one'],p_target:'sunday'});
    expect(write).not.toHaveProperty('p_agenda');expect(write).not.toHaveProperty('p_item');
  });
  test('uses actual available owner fragments and excludes assistant/future fragments',async()=>{
    const f=fixture();f.business.observe(fragment('owner-one','No domingo, ',100,300));f.business.observe(fragment('owner-two','só emergência.',300,600));
    f.business.observe({...fragment('assistant','Certo.',300,600),type:'session.output_transcript.delta'});f.business.observe(fragment('future','Depois outra coisa.',2000,2300));
    const c=await f.context();await f.save(c.contextRef);
    expect(f.calls.find(call=>call.name==='commit_website_live_decision').args.p_source_ids).toEqual(['owner-one','owner-two']);
    expect(f.records.get('owner-one')).not.toHaveProperty('arrival');
  });
  test('model cannot author tenant identity or provider fragment IDs',async()=>{
    const f=fixture();f.business.observe(fragment());const c=await f.context();
    expect((await f.business.execute('save_decision',{contextRef:c.contextRef,targetId:'sunday',kind:'answer',interpretation:'x',sourceEventIds:['invented']},ctx)).code).toBe('invalid_tool_arguments');
    expect((await f.business.execute('save_decision',{contextRef:c.contextRef,targetId:'sunday',kind:'answer',interpretation:'x',tenantId:id(99)},ctx)).code).toBe('invalid_tool_arguments');expect(f.counts().commits).toBe(0);
  });
  test('late Live source is recoverable without waiting for a legacy final ASR event',async()=>{
    const f=fixture();const c=await f.context();expect((await f.save(c.contextRef)).code).toBe('context_pending');
    f.business.observe({type:'conversation.item.input_audio_transcription.completed',item_id:'old',transcript:'No domingo'});
    expect((await f.save((await f.context()).contextRef)).code).toBe('context_pending');
    f.business.observe(fragment());expect((await f.save((await f.context()).contextRef)).saved).toBe(true);
  });
  test('unknown or null delegation offset does not manufacture source provenance',async()=>{
    const f=fixture();f.business.observe(fragment());const c=await f.business.execute('get_context',{}, {...ctx,delegationOffsetMs:null});
    expect((await f.save(c.contextRef)).code).toBe('context_pending');expect(f.counts().commits).toBe(0);
  });
  test('explicit indefinite limit is deferred with its actual condition, not another clarification loop',async()=>{
    const f=fixture();f.business.observe(fragment('limits','Prefiro deixar os limites indefinidos por enquanto.'));const c=await f.context();
    expect((await f.save(c.contextRef,'floor','defer','Limites de negociação indefinidos; qualquer exceção exige consulta ao dono.')).saved).toBe(true);
    expect(f.stored().agenda.items[2]).toMatchObject({status:'deferred_owner_review',clarificationCount:0});
  });
  test('correction uses returned fresh revision and preserves the named catalog service',async()=>{
    const f=fixture();f.business.observe(fragment());const first=await f.save((await f.context()).contextRef);
    f.business.observe(fragment('price','A limpeza custa cento e oitenta, não cento e quarenta e nove.',700,950));
    const c=await f.business.execute('get_context',{subject:null,targetIds:[`candidate:${id(7)}`]},ctx);expect(c.websiteCandidates).toEqual([{targetId:`candidate:${id(7)}`,subject:'service',value:{service_type:'Limpeza',public_price:{amount:'149.00',currency:'USD'}}}]);
    const result=await f.save(c.contextRef,`candidate:${id(7)}`,'correction','Limpeza: preço público USD 180.00.');
    expect(result.saved).toBe(true);expect(result.revision).toBe(2);expect(first.revision).toBe(1);expect(f.stored().agenda.candidateOverrides[0].status).toBe('corrected');
    const detail=await f.business.execute('get_context',{subject:null,targetIds:[`candidate:${id(7)}`]},ctx);
    expect((detail.catalogue as any[])[0]).toMatchObject({interpretation:'Limpeza: preço público USD 180.00.',provenance:'model_interpretation',status:'corrected'});
    expect((detail.websiteCandidates as any[])[0].value.public_price.amount).toBe('149.00');
  });
  test('stale revision cannot overwrite a newer decision',async()=>{
    const f=fixture();f.business.observe(fragment());const c=await f.context();await f.save(c.contextRef);
    expect((await f.save(c.contextRef,'floor','defer','Indefinido.')).code).toBe('revision_changed');expect(f.stored().revision).toBe(1);
  });
  test('failed evidence persistence does not advance Sunday and can be retried after recovery',async()=>{
    const f=fixture({recordFails:true});f.business.observe(fragment());const c=await f.context();
    expect((await f.save(c.contextRef)).code).toBe('evidence_not_persisted');expect(f.counts().commits).toBe(0);expect(f.stored().revision).toBe(0);
    f.options.recordFails=false;expect((await f.save(c.contextRef)).saved).toBe(true);
  });
  test('lost successful commit is reconciled from its receipt without another write',async()=>{
    const f=fixture({commitLost:true});f.business.observe(fragment());const c=await f.context();const result=await f.save(c.contextRef);
    expect(result).toMatchObject({saved:true,replayed:true,operationRevision:1});expect(f.counts().commits).toBe(1);
  });
  test('unknown write blocks additional effects, allows Stop and only retries observation',async()=>{
    const f=fixture({commitUnknown:true});f.business.observe(fragment());const c=await f.context();const result=await f.save(c.contextRef);
    expect(result).toMatchObject({saved:false,code:'operation_unconfirmed',outcome:'unknown'});
    await f.save(c.contextRef);await f.save(c.contextRef,'floor','defer','Indefinido');expect(f.counts().commits).toBe(1);expect(f.stored().revision).toBe(0);
    expect((await f.business.execute('end_call',{},ctx)).stopRequested).toBe(true);expect(f.counts().stops).toBe(1);
  });
  test('definite SQL validation and constraint rejections do not poison later business operations',async()=>{
    for(const rejection of [{code:'P0001',message:'live_operation_invalid'},{code:'P0001',message:'live_source_missing'},{code:'23514',message:'constraint failed'},{code:'22023',message:'invalid arguments'}]){
      const f=fixture({commitRejection:rejection});f.business.observe(fragment());const context=await f.context();
      expect((await f.save(context.contextRef)).code).toBe('decision_rejected');expect((await f.context()).pendingOperations).toEqual([]);expect(f.stored().revision).toBe(0);
      f.options.commitRejection=undefined;expect((await f.save(context.contextRef)).saved).toBe(true);expect(f.stored().revision).toBe(1);
    }
  });
  test('a database connection exception remains uncertain instead of allowing another effect',async()=>{
    const f=fixture({commitRejection:{code:'08006',message:'connection failure'}});f.business.observe(fragment());const context=await f.context();
    expect((await f.save(context.contextRef)).code).toBe('operation_unconfirmed');f.options.commitRejection=undefined;
    expect((await f.save(context.contextRef)).code).toBe('operation_unconfirmed');expect(f.counts().commits).toBe(1);
  });
  test('operation receipt can later recover the write and restore authoritative progress',async()=>{
    const f=fixture({commitUnknown:true});f.business.observe(fragment());const result=await f.save((await f.context()).contextRef);f.resolvePending();
    const proof=await f.business.execute('get_operation',{operationRef:result.operationRef},ctx);
    expect(proof).toMatchObject({saved:true,replayed:true,revision:1});expect(f.counts().commits).toBe(1);
  });
  test('changed interpretation cannot reuse an unresolved operation as proof of the changed text',async()=>{
    const f=fixture({commitUnknown:true});f.business.observe(fragment());const c=await f.context();await f.save(c.contextRef);f.resolvePending();
    expect((await f.save(c.contextRef,'sunday','answer','Domingo fechado.')).code).toBe('operation_payload_conflict');expect(f.counts().commits).toBe(1);
  });
  test('same operation under a new delegation reuses the operation identity',async()=>{
    const f=fixture();f.business.observe(fragment());const c=await f.context();const first=await f.save(c.contextRef);
    const retry=await f.business.execute('save_decision',{contextRef:c.contextRef,targetId:'sunday',kind:'answer',interpretation:'No domingo, somente emergências.'},{...ctx,delegationId:'delegation-two'});
    expect(retry.operationRef).toBe(first.operationRef);expect(retry.replayed).toBe(true);expect(f.stored().revision).toBe(1);
  });
  test('Stop is immediate and idempotent even when evidence recording never resolves',async()=>{
    const f=fixture({holdRecord:true});f.business.observe(fragment());
    expect(await f.business.execute('end_call',{},ctx)).toMatchObject({stopRequested:true,onboardingCompleted:false});
    await f.business.execute('end_call',{},ctx);expect(f.counts().stops).toBe(1);
  });
  test('does not advertise unimplemented approval or claim final completion',async()=>{
    const f=fixture();expect(f.business.tools.map(t=>t.name)).toEqual(['end_call']);
    expect((await f.context()).approvalAvailable).toBe(false);expect(f.business.backendInstructions).toContain('não declare onboarding concluído');
    expect(f.business.voiceInstructions).not.toContain('MP3');
  });
  test('rejects corrupt readback and cross-call binding before reporting durable success',async()=>{
    const f=fixture({readCorrupt:true});await expect(f.context()).rejects.toThrow('proof_invalid');
    expect(()=>createLiveInterviewStore(f.client,{...scope,callId:id(99)},binding)).toThrow('scope_invalid');
  });
  test('provider binding is single assignment and wrong-session operation proof is rejected',async()=>{
    const f=fixture();expect(()=>f.business.bindSession('another-session')).toThrow('rebind');f.business.observe(fragment());
    const saved=await f.save((await f.context()).contextRef);const proof=f.operations.get(saved.operationRef as string);proof.providerSessionId='other';
    const store=createLiveInterviewStore(f.client,scope,binding);await expect(store.readOperation(saved.operationRef as string)).rejects.toThrow('proof_invalid');
  });
  test('malformed diagnostic evidence does not throw into the voice path or prevent Stop',async()=>{
    const f=fixture();f.business.observe(fragment());expect(()=>f.business.observe({...fragment(),delta:'Conflicting text'})).not.toThrow();
    expect((await f.save((await f.context()).contextRef)).code).toBe('context_pending');
    expect((await f.business.execute('end_call',{},ctx)).stopRequested).toBe(true);
  });
  test('strict get_context schema advertises nullable subject and exact IDs while legacy empty calls still work',async()=>{
    const f=fixture(),tool=LIVE_BUSINESS_TOOLS.find(t=>t.name==='get_context')!;
    expect(tool.parameters.required).toEqual(['subject','targetIds']);
    expect(await f.business.execute('get_context',{subject:null,targetIds:[]},ctx)).toMatchObject({ok:true,view:'overview',receiptId:id(8)});
    expect((await f.context()).view).toBe('overview');
    const overview=await f.context(),detail=await f.business.execute('get_context',{subject:'business_hours',targetIds:[]},ctx);
    expect(detail.contextRef).toBe(overview.contextRef);expect(detail.revision).toBe(overview.revision);
    const combined=await f.business.execute('get_context',{subject:'calendar',targetIds:['sunday']},ctx);
    expect(combined.ok).toBe(true);
    expect((combined.catalogue as Array<{targetId:string}>).map(item=>item.targetId)).toEqual(['permissions','sunday']);
    expect(f.counts().commits).toBe(0);
  });
  test('unknown subject or foreign target does not fall back to exposing the whole context',async()=>{
    const f=fixture();
    for(const selection of [{subject:'other-company',targetIds:[]},{subject:null,targetIds:[id(999)]}]){
      const result=await f.business.execute('get_context',selection,ctx);
      expect(result).toMatchObject({ok:false,code:'context_selector_not_found'});expect(result).not.toHaveProperty('catalogue');expect(result).not.toHaveProperty('contextRef');
    }
  });
});

describe('startup context is a snapshot, never a write path',()=>{
  test('a startup contextRef cannot save and the backend prompt does not change after reads',async()=>{
    const f=fixture();const before=f.business.backendInstructions;
    const denied=await f.business.execute('save_decision',{contextRef:'live-context:startup',targetId:'sunday',kind:'answer',interpretation:'x'},ctx) as any;
    expect(denied.code).toBe('context_pending');expect(f.counts().commits).toBe(0);
    await f.context();expect(f.business.backendInstructions).toBe(before);
  });
});

describe('live question selection: internal ceiling, never announced',()=>{
  const seed=(id:string,source:string,subject:string,questionPt:string,coverageRefs:string[]=[subject])=>({id,source,subject,questionPt,coverageRefs,relatedItemIds:[],blocking:true}) as any;
  const storedFor=(seeds:any[])=>{const agenda=createOnboardingAgenda(binding,seeds);return{agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:id(8),nextAction:getAgendaAction(agenda),state:'unfinished',replayed:false} as any;};
  const noClaims:any={provenance:{tenantId:id(6)},candidateRecap:[]};
  const sessionFor=(stored:any,projection:any=noClaims)=>createLiveBusinessSession({prepared:{scope:actor,stored,projection} as PreparedWebsiteInterview,businessName:'Empresa teste',client:{rpc:async()=>({data:null,error:null})} as any,onStop:()=>{}});
  test('3-item fixture: contradiction first, then owner-private items in seed order; nothing left pending',()=>{
    const f=fixture(),plan=selectLiveQuestions(f.prepared.stored,f.prepared.projection);
    expect(plan.questions.map(q=>q.targetId)).toEqual(['sunday','permissions','floor']);
    expect(plan.questions.map(q=>q.tier)).toEqual([1,2,2]);
    expect(plan).toMatchObject({clarificationTotal:3,clarificationPending:0,continuation:false,tiers:{1:1,2:2,3:0,4:0}});
    expect(rankLiveQuestions(f.prepared.stored,f.prepared.projection).map(q=>q.seedIndex)).toEqual([1,0,2]);
  });
  test('tier-4 catalogue items never fill the list: the ceiling is not a target',()=>{
    const seeds=[seed('c1','contradiction','hours','Contradição de horário?'),seed('p1','owner_private_requirement','authority.book','Pode confirmar agendamentos?',['authority.book']),
      seed('q1','missing_website_information','discovery.owner_question.abc','Pergunta nascida do site?',['discovery.owner_question.abc']),
      seed('pm','missing_website_information','repair','Preço fixo ou estimativa?',['service:repair:service.price_mode']),
      ...Array.from({length:70},(_,i)=>seed(`t4-${i}`,'missing_website_information',`policy.${i}`,`Pergunta de rotina ${i}?`))];
    const projection:any={provenance:{tenantId:id(6)},candidateRecap:[{claim_id:id(7),claim_type:'service',value:{service_type:'repair'}},{claim_id:id(8),claim_type:'service',value:{service_type:'repair'}}]};
    const plan=selectLiveQuestions(storedFor(seeds),projection);
    expect(plan.questions.map(q=>q.targetId)).toEqual(['c1','p1','pm','q1']);
    expect(plan).toMatchObject({clarificationTotal:4,clarificationPending:0,continuation:false,tiers:{1:1,2:1,3:2,4:70}});
    const prompt=sessionFor(storedFor(seeds),projection).voiceInstructions;
    expect(prompt).not.toContain('Pergunta de rotina');expect(prompt).toContain('por hoje é isso');expect(prompt).not.toContain('volto a falar');
  });
  // Review 2026-09-12: "emphasised" is relative to the other services (at least two service claims, or strictly
  // above the median service); one claim per service (the usual draft shape) emphasises nothing.
  const claims=(...types:string[]):any=>({candidateRecap:types.map((service_type,i)=>({claim_id:id(30+i),claim_type:'service',value:{service_type}}))});
  test('price questions only count as clarification when the website emphasises that service relative to the others',()=>{
    const seeds=[seed('pm','missing_website_information','repair','Preço fixo ou estimativa?',['service:repair:service.price_mode']),
      seed('pl','missing_website_information','limpeza','Preço da limpeza?',['service:limpeza:service.price_target'])];
    expect(selectLiveQuestions(storedFor(seeds),noClaims).questions).toEqual([]);
    expect(selectLiveQuestions(storedFor(seeds),claims('repair')).questions).toEqual([]);
    expect(selectLiveQuestions(storedFor(seeds),claims('repair','limpeza')).questions).toEqual([]);
    expect(selectLiveQuestions(storedFor(seeds),claims('repair','repair')).questions.map(q=>[q.targetId,q.tier])).toEqual([['pm',3]]);
    expect(selectLiveQuestions(storedFor(seeds),claims('repair','repair','limpeza')).questions.map(q=>[q.targetId,q.tier])).toEqual([['pm',3]]);
  });
  test('authority items are tier 2; per-service negotiation and escalation are tier 3 only for an emphasised service, else tier 4',()=>{
    const seeds=[seed('n1','owner_private_requirement','repair','Negociável?',['service:repair:service.negotiation']),seed('a1','owner_private_requirement','authority.book','Pode confirmar?',['authority.book']),
      seed('e1','owner_private_requirement','limpeza','Escalar?',['service:limpeza:service.escalation']),seed('f1','owner_private_requirement','emergency.fee_authority','Quem confirma taxa?',['emergency.fee_authority'])];
    const plan=selectLiveQuestions(storedFor(seeds),claims('limpeza','limpeza','repair'));
    expect(plan.questions.map(q=>[q.targetId,q.tier])).toEqual([['a1',2],['f1',2],['e1',3]]);
    expect(plan.tiers).toEqual({1:0,2:2,3:1,4:1});
    // Ten services with one claim each: the twenty negotiation/escalation clones never become clarification points.
    const clones=Array.from({length:10},(_,i)=>[seed(`n${i}`,'owner_private_requirement',`s${i}`,`Negociável ${i}?`,[`service:s${i}:service.negotiation`]),seed(`x${i}`,'owner_private_requirement',`s${i}`,`Escalar ${i}?`,[`service:s${i}:service.escalation`])]).flat();
    const march=selectLiveQuestions(storedFor([...clones,seed('a1','owner_private_requirement','authority.book','Pode confirmar?',['authority.book'])]),claims(...Array.from({length:10},(_,i)=>`s${i}`)));
    expect(march.questions.map(q=>q.targetId)).toEqual(['a1']);expect(march).toMatchObject({clarificationTotal:1,continuation:false,tiers:{2:1,4:20}});
  });
  test('a question too long for the byte budget is skipped, not the whole tail of the list; an all-oversized list closes normally',()=>{
    const huge=seed('c0','contradiction','topic.0','Contradição enorme '+'x'.repeat(1500)+'?');
    const plan=selectLiveQuestions(storedFor([huge,seed('c1','contradiction','topic.1','Curta um?'),seed('c2','contradiction','topic.2','Curta dois?')]),noClaims);
    expect(plan.questions.map(q=>q.targetId)).toEqual(['c1','c2']);expect(plan).toMatchObject({clarificationTotal:3,clarificationPending:1,continuation:true});
    expect(plan.byteLength).toBeLessThanOrEqual(LIVE_QUESTION_BYTES);
    const prompt=sessionFor(storedFor([huge,seed('c1','contradiction','topic.1','Curta um?')])).voiceInstructions;
    expect(prompt).toContain('"Curta um?"');expect(prompt).not.toContain('Contradição enorme');expect(prompt).toContain('Por hoje já temos bastante coisa');
    const empty=selectLiveQuestions(storedFor([huge]),noClaims);
    expect(empty).toMatchObject({questions:[],clarificationTotal:1,clarificationPending:1,continuation:true});
    const emptyPrompt=sessionFor(storedFor([huge])).voiceInstructions;
    expect(emptyPrompt).toContain('Não há pontos a esclarecer nesta conversa');expect(emptyPrompt).toContain('por hoje é isso');expect(emptyPrompt).not.toContain('volto a falar');
  });
  test('twelve contradictions: ten listed, two stay pending for another day, closing excuse names no limit',()=>{
    const seeds=Array.from({length:12},(_,i)=>seed(`c${i}`,'contradiction',`topic.${i}`,`Contradição número ${i}?`));
    const plan=selectLiveQuestions(storedFor(seeds),noClaims);
    expect(plan.questions).toHaveLength(LIVE_QUESTION_CAP);expect(plan.questions.map(q=>q.targetId)).toEqual(seeds.slice(0,10).map(s=>s.id));
    expect(plan).toMatchObject({clarificationTotal:12,clarificationPending:2,continuation:true});
    const prompt=sessionFor(storedFor(seeds)).voiceInstructions;
    expect(prompt).toContain('Por hoje já temos bastante coisa');expect(prompt).not.toContain('por hoje é isso');expect(prompt).not.toContain('Contradição número 10?');
    expect(prompt).not.toMatch(/limite de perguntas|dez perguntas|\b10 perguntas|número de perguntas|máximo de perguntas|regra interna|só posso (fazer|perguntar)/i);
  });
  test('long questions are trimmed from the end of the list to respect the byte budget',()=>{
    const seeds=Array.from({length:6},(_,i)=>seed(`c${i}`,'contradiction',`topic.${i}`,`Pergunta ${i} `+'x'.repeat(380)+'?'));
    const plan=selectLiveQuestions(storedFor(seeds),noClaims);
    expect(plan.byteLength).toBeLessThanOrEqual(LIVE_QUESTION_BYTES);expect(plan.questions.map(q=>q.targetId)).toEqual(['c0','c1','c2']);
    expect(plan).toMatchObject({clarificationTotal:6,clarificationPending:3,continuation:true});
    expect(selectLiveQuestions(storedFor(seeds),noClaims,10,100_000).questions).toHaveLength(6);
  });
  test('no clarification points: empty list, normal closing, no invented question',()=>{
    const seeds=Array.from({length:5},(_,i)=>seed(`t${i}`,'missing_website_information',`policy.${i}`,`Rotina ${i}?`));
    expect(selectLiveQuestions(storedFor(seeds),noClaims)).toMatchObject({questions:[],clarificationTotal:0,clarificationPending:0,continuation:false,tiers:{4:5}});
    const prompt=sessionFor(storedFor(seeds)).voiceInstructions;
    expect(prompt).toContain('Não há pontos a esclarecer nesta conversa');expect(prompt).not.toContain('Rotina 0?');expect(prompt).toContain('por hoje é isso');
    expect(prompt).not.toContain('Pontos a esclarecer nesta conversa, em ordem de prioridade');
  });
  test('resolved items leave the ranking so a follow-up call lists only what is still open',async()=>{
    const f=fixture();f.business.observe(fragment());await f.save((await f.context()).contextRef);
    expect(selectLiveQuestions(f.stored(),f.prepared.projection).questions.map(q=>q.targetId)).toEqual(['permissions','floor']);
  });
});

describe('post-call hook',()=>{
  test('postcallContext throws before bind and exposes transcript fragments, plan and a flush that persists them',async()=>{
    const f=fixture({recordFails:true});
    const unbound=createLiveBusinessSession({prepared:f.prepared,businessName:'Empresa teste',client:f.client,onStop:()=>{}});
    expect(()=>unbound.postcallContext()).toThrow('live_business_session_unbound');
    f.business.observe(fragment('owner-one','No domingo, só emergência.',100,500));
    f.business.observe({...fragment('assistant-one','Certo.',600,900),type:'session.output_transcript.delta'});
    await Promise.resolve();expect(f.records.size).toBe(0);
    const context=f.business.postcallContext();
    expect(context.fragments.map(x=>[x.eventId,x.speaker,x.text])).toEqual([['owner-one','owner','No domingo, só emergência.'],['assistant-one','assistant','Certo.']]);
    expect(context.plan).toEqual({listed:3,clarificationTotal:3,clarificationPending:0,continuation:false});
    expect(context.scope).toMatchObject({callId:actor.callId,providerSessionId:scope.providerSessionId,tenantId:id(6),interviewId:id(1)});
    expect(context.stored.revision).toBe(0);expect(context.evidenceFault).toBe(false);expect((await context.store.read()).revision).toBe(0);
    f.options.recordFails=false;f.business.observe(fragment('owner-two','E sábado fechado.',1000,1400));
    await context.flush();
    for(const eventId of ['owner-one','assistant-one','owner-two'])expect(f.records.get(eventId)).toMatchObject({eventId});
    expect(f.records.get('assistant-one').speaker).toBe('assistant');
  });
  test('postcallContext keeps working after session.closed and after an owner-requested stop',async()=>{
    const f=fixture();f.business.observe(fragment());
    await f.business.execute('end_call',{},ctx);f.business.observe({type:'session.closed'});
    expect((await f.business.execute('get_context',{},ctx)).code).toBe('session_stopped');
    const context=f.business.postcallContext();expect(context.fragments).toHaveLength(1);await context.flush();
  });
});

describe('compact Live business projection of the real website fixture',()=>{
  const source=JSON.parse(readFileSync(new URL('./fixtures/foghorn-website-first-voice.json',import.meta.url),'utf8'));
  const {tenant_id:_,...draftReadback}=source.draft_row;
  const projection=buildWebsiteAgendaSeeds({draftReadback,initialCoverage:source.initial_coverage.snapshot});
  const b={...binding,callId:projection.provenance.callId,draftId:projection.provenance.draftId,draftHash:projection.provenance.draftHash,
    sourceResultId:projection.provenance.sourceResultId,sourceResultHash:projection.provenance.sourceResultHash};
  const agenda=createOnboardingAgenda(b,projection.seeds,buildWebsiteCandidateContext(projection),projection.contextTimezone);
  const stored:any={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:id(8),nextAction:getAgendaAction(agenda),state:'unfinished',replayed:false};
  test('startup prompts carry the ranked clarification points within byte budgets; the backend only ends calls',()=>{
    const business=createLiveBusinessSession({prepared:{scope:actor,stored,projection} as PreparedWebsiteInterview,businessName:'Account Label',client:{rpc:async()=>({data:null,error:null})} as any,onStop:()=>{}});
    const plan=selectLiveQuestions(stored,projection),items=getAgendaItems(agenda),byRef=(ref:string)=>items.find(i=>i.coverageRefs.includes(ref))!.id;
    const contradictions=items.filter(i=>i.source==='contradiction').map(i=>i.id);expect(contradictions).toHaveLength(2);
    // Design §4 (measured on this fixture): 6 tier-1 points in seed order, then the authority.* items of tier 2.
    expect(plan.questions.map(q=>q.targetId)).toEqual([byRef('area.coverage'),...contradictions,byRef('service:comfort_plan_maintenance:service.price_mode'),
      byRef('service:repair_diagnostic:service.price_mode'),byRef('schedule.business_hours'),byRef('authority.quote_price'),byRef('authority.negotiate_floor'),byRef('authority.read_calendar'),byRef('authority.book')]);
    expect(plan.questions.map(q=>q.tier)).toEqual([1,1,1,1,1,1,2,2,2,2]);
    // Review 2026-09-12: every Foghorn service carries exactly one service claim, so nothing is emphasised relative to the
    // others: tier 2 is the 8 authority.* items + emergency.fee_authority, tier 3 the 5 owner questions born from the
    // analysis, and the 20 per-service negotiation/escalation clones + 10 price items stay in tier 4 (two calls, not five).
    expect(plan).toMatchObject({continuation:true,clarificationTotal:20,tiers:{1:6,2:9,3:5,4:93}});expect(plan.clarificationPending).toBe(plan.clarificationTotal-LIVE_QUESTION_CAP);
    expect(items.filter(i=>i.source==='owner_private_requirement'&&i.coverageRefs.some(r=>/:service\.(negotiation|escalation)$/.test(r)))).toHaveLength(20);
    expect(business.voiceInstructions).not.toContain('Este preço é negociável?');expect(business.voiceInstructions).not.toContain('exige aprovação do dono');
    expect(plan.byteLength).toBeLessThanOrEqual(LIVE_QUESTION_BYTES);
    // 3936 B measured on Foghorn @1f06991 + this change (design §3.5); 4038 B after the 2026-09-12 review fixes (backend-named
    // no-recording sentence, closing "algo como", Ligou-questions bullet). The pin keeps ~58 B of slack on this fixed fixture.
    expect(Buffer.byteLength(business.voiceInstructions)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(business.backendInstructions)).toBeLessThanOrEqual(1024);
    for(const q of plan.questions)expect(business.voiceInstructions).toContain(JSON.stringify(q.questionPt));
    expect(business.voiceInstructions).not.toContain(plan.questions[0].targetId);expect(business.voiceInstructions).not.toContain('subjectIndex');
    expect(business.voiceInstructions).not.toContain('Account Label');
    expect(business.voiceInstructions).toContain('Por hoje já temos bastante coisa');
    // Tier-3/4 items beyond the ceiling are not listed; the catalogue is not marched in seed order.
    expect(business.voiceInstructions).not.toContain('Qual é a política de funcionamento em feriados?');
    expect(business.voiceInstructions).not.toContain('Qual é a duração típica deste serviço?');
    for(const key of ['contextRef','receiptId','pendingOperations','approvalAvailable','onboardingApproved','revision','catalogue','serviceIndex','subjectIndex','savedDecisionIds','businessIdentity'])expect(business.backendInstructions).not.toContain(`"${key}"`);
  });
  test('overview provides two suggestions and indexes without all 114 full rows or candidate values',()=>{
    const before=JSON.stringify(stored),result=projectLiveBusinessContext(stored,projection);
    expect(agenda.items.length).toBeGreaterThan(100);expect(projection.candidateRecap).toHaveLength(21);
    expect(result).toMatchObject({ok:true,view:'overview'});expect(result.catalogue).toHaveLength(2);
    expect(result).not.toHaveProperty('websiteCandidates');expect((result as any).serviceIndex).toHaveLength(10);
    expect((result as any).subjectIndex.filter((s:any)=>s.subject.startsWith('discovery.owner_question.')).every((s:any)=>s.label?.length>0)).toBe(true);
    expect(JSON.stringify(stored)).toBe(before);expect(stored.agenda.contextTimezone).toEqual(projection.contextTimezone);
  });
  test('repair diagnostic exact lookup includes its price and excludes same-day repair pricing',()=>{
    const result=projectLiveBusinessContext(stored,projection,{subject:'repair_diagnostic',targetIds:[]});
    expect(result.ok).toBe(true);expect(result.catalogue!.length).toBeGreaterThan(0);
    expect(result.catalogue!.every(r=>r.subject==='repair_diagnostic')).toBe(true);
    const candidates=(result as any).websiteCandidates;
    expect(candidates.length).toBeGreaterThan(0);expect(candidates.every((c:any)=>c.value.service_type==='repair_diagnostic')).toBe(true);
    expect(JSON.stringify(candidates)).not.toContain('same_day_repair');
  });
  test('Sunday remains discoverable by its actual opaque subject label and target ID',()=>{
    const overview=projectLiveBusinessContext(stored,projection) as any;
    const sunday=overview.subjectIndex.find((s:any)=>s.label&&/domingo/i.test(s.label));
    expect(sunday).toBeDefined();
    const bySubject=projectLiveBusinessContext(stored,projection,{subject:sunday.subject,targetIds:[]});
    const item=bySubject.catalogue!.find(r=>/domingo/i.test(r.questionPt));expect(item).toBeDefined();
    const byId=projectLiveBusinessContext(stored,projection,{subject:null,targetIds:[item!.targetId]});
    expect(byId.catalogue).toEqual([item!]);expect(byId).not.toHaveProperty('serviceIndex');
  });
});
