import {afterEach,describe,expect,test} from 'bun:test';
import {runPostcallRecording,buildPostcallTurns,buildPostcallInput,validatePostcallDecisions,authorityExplicit,AUTHORITY_HEDGE,AUTHORITY_EXPLICIT,
  POSTCALL_PROMPT,POSTCALL_SCHEMA,type PostcallContext,type PostcallDecision} from '../src/onboarding-live-postcall';
import {createLiveInterviewStore,LivePersistenceError} from '../src/onboarding-live-store';
import {createOnboardingAgenda,getAgendaAction,getAgendaItems} from '../src/onboarding-agenda';
import {onboardingAgendaDigest} from '../src/onboarding-agenda-store';
import type {LiveFragment} from '../src/onboarding-live-context';

const id=(n:number)=>`9f000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const binding={interviewId:id(1),callId:id(1),draftId:id(2),draftHash:'a'.repeat(64),sourceResultId:id(3),sourceResultHash:'b'.repeat(64)};
const scope={ownerId:id(4),callId:id(1),requestId:id(5),tenantId:id(6),interviewId:id(1),providerSessionId:'live-session-one'};
const CANDIDATE=`candidate:${id(7)}`;
const frag=(eventId:string,speaker:'owner'|'assistant',text:string,startMs:number,endMs:number,arrival=0):LiveFragment=>({eventId,speaker,text,startMs,endMs,arrival});
// One owner turn (d1) split across two deltas, an authority answer (d2) and a plain answer (d3).
const TRANSCRIPT:LiveFragment[]=[
  frag('l-1','assistant','Qual a regra de domingo?',0,900,0),
  frag('o-1','owner','No domingo, ',1000,1300,1),frag('o-2','owner','só emergência.',1300,1600,2),
  frag('l-2','assistant','E o Ligou pode confirmar agendamentos sozinho?',2000,2900,3),
  frag('o-3','owner','Sim, pode confirmar.',3000,3500,4),
  frag('l-3','assistant','Qual o horário de semana?',4000,4500,5),
  frag('o-4','owner','Das oito às dezoito.',5000,5600,6),
];
const withOwnerTurn=(eventId:string,text:string)=>TRANSCRIPT.map(f=>f.eventId===eventId?{...f,text}:f);
const PRICED_USAGE={input_tokens:800,output_tokens:120,total_tokens:920,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}};
const UNPRICED_USAGE={input_tokens:800,output_tokens:120,total_tokens:920,input_tokens_details:{cached_tokens:0}};
const dec=(targetId:string,kind:PostcallDecision['kind'],interpretation:string,sourceTurnIds:string[],explicit=false):PostcallDecision=>({targetId,kind,interpretation,sourceTurnIds,explicit});
type Options={preAnswer?:{targetId:string;interpretation:string}[];rejectCommit?:{code?:string;message:string;once?:boolean};conflictFirstCommit?:boolean;
  scopeInvalidCommit?:boolean;commitLost?:boolean;commitVanished?:boolean;holdCommit?:number};

function fixture(options:Options={}){
  const agenda=createOnboardingAgenda(binding,[
    {id:'book',source:'owner_private_requirement',subject:'authority.book',questionPt:'O Ligou pode confirmar agendamentos sozinho?',coverageRefs:['authority.book'],relatedItemIds:[],blocking:true},
    {id:'sunday',source:'contradiction',subject:'business_hours',questionPt:'Qual a regra de domingo?',coverageRefs:['hours'],relatedItemIds:[],blocking:true},
    {id:'price',source:'missing_website_information',subject:'repair_diagnostic',questionPt:'Qual o preço do diagnóstico?',coverageRefs:['repair_diagnostic:service.price_target'],relatedItemIds:[],blocking:false},
    {id:'floor',source:'owner_private_requirement',subject:'negotiation',questionPt:'Qual o limite privado de negociação?',coverageRefs:['floor'],relatedItemIds:[],blocking:true},
    {id:'weekday',source:'missing_website_information',subject:'business_hours',questionPt:'Qual o horário de semana?',coverageRefs:['hours'],relatedItemIds:[],blocking:false},
  ],[{id:CANDIDATE,subject:'service',questionPt:'Qual o preço correto da limpeza?',coverageRefs:[`discovery.candidate.${id(7).replaceAll('-','')}`]}]);
  let stored:any={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:id(8),nextAction:getAgendaAction(agenda),state:'unfinished',replayed:false};
  // Two service claims: repair_diagnostic is emphasised relative to the others, so 'price' is a tier-3 clarification point.
  const projection:any={provenance:{tenantId:id(6)},candidateRecap:[{claim_id:id(7),claim_type:'service',value:{service_type:'repair_diagnostic',public_price:{amount:'149.00',currency:'USD'}}},
    {claim_id:id(9),claim_type:'service',value:{service_type:'repair_diagnostic',service_names:['Diagnóstico de reparo']}}]};
  const records=new Map<string,any>(),operations=new Map<string,any>(),calls:any[]=[];let commits=0,externals=0;
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
    if(!target)throw Object.assign(Error('live_target_not_in_catalogue'),{code:'P0001'});
    if(['answered','corrected','not_applicable','context_resolved'].includes(target.status)&&args.p_kind==='answer')throw Object.assign(Error('live_resolved_target_requires_correction'),{code:'P0001'});
    const ownerEvidence={turnId:`${scope.callId}:${args.p_operation}`,text:args.p_interpretation,provenance:'model_interpretation'};
    target.evidence.push(ownerEvidence);next.ownerTurns.push(ownerEvidence);next.revision++;
    target.answerRevision+=args.p_kind==='defer'?0:1;
    target.status=({answer:'answered',correction:'corrected',reopen:'open',defer:'deferred_owner_review',not_applicable:'not_applicable'} as any)[args.p_kind];
    stored={...stored,agenda:next,revision:next.revision,storeVersion:stored.storeVersion+1,digest:onboardingAgendaDigest(next),receiptId:id(20+next.revision),nextAction:getAgendaAction(next)};
    const proof={operationRef:args.p_operation,operationReceiptId:stored.receiptId,operationRevision:stored.revision,kind:args.p_kind,targetId:args.p_target,
      sourceEventIds:args.p_source_ids,interpretation:args.p_interpretation,providerSessionId:args.p_session};operations.set(args.p_operation,proof);
    return{...stored,...proof};
  }
  // A decision recorded outside the recorder (another session or the dashboard).
  const external=(targetId:string,interpretation:string,kind='answer')=>apply({p_operation:`ligou-live-op:${'e'.repeat(60)}${String(++externals).padStart(4,'0')}`,p_revision:stored.revision,p_digest:stored.digest,
    p_store_version:stored.storeVersion,p_kind:kind,p_target:targetId,p_source_ids:['external'],p_interpretation:interpretation,p_session:scope.providerSessionId});
  for(const pre of options.preAnswer??[])external(pre.targetId,pre.interpretation);
  const client={rpc:async(name:string,args:Record<string,unknown>)=>{
    calls.push({name,args});
    if(name==='read_website_interview')return{data:stored,error:null};
    if(name==='record_website_live_fragments'){
      let added=0;for(const f of args.p_fragments as any[]){if(!records.has(f.eventId)){records.set(f.eventId,f);added++;}}
      return{data:{callId:scope.callId,providerSessionId:scope.providerSessionId,added},error:null};
    }
    if(name==='read_website_live_operation')return{data:operations.get(args.p_operation as string)??null,error:null};
    if(name==='commit_website_live_decision'){
      const index=commits++;
      if(options.scopeInvalidCommit)return{data:null,error:{message:'permission denied for function commit_website_live_decision',code:'42501'},status:403};
      for(const sourceId of args.p_source_ids as string[])if(records.get(sourceId)?.speaker!=='owner')return{data:null,error:{message:'live_source_missing',code:'P0001'},status:400};
      if(options.holdCommit===index)await new Promise(()=>undefined);
      if(options.conflictFirstCommit&&index===0)external('floor','Desconto máximo de dez por cento.');
      if(options.rejectCommit&&(!options.rejectCommit.once||index===0))return{data:null,error:{message:options.rejectCommit.message,code:options.rejectCommit.code},status:400};
      if(options.commitVanished)throw new TypeError('connection lost before outcome');
      try{const data=apply(args);if(options.commitLost&&index===0)throw new TypeError('lost committed result');return{data,error:null};}
      catch(cause){if(cause instanceof TypeError)throw cause;return{data:null,error:{message:(cause as Error).message,code:(cause as any).code}};}
    }
    throw Error(`unexpected RPC ${name}`);
  }};
  const store=createLiveInterviewStore(client,scope,binding);
  const context=(fragments:LiveFragment[]=TRANSCRIPT,extra:Partial<PostcallContext>={}):PostcallContext=>({scope,store,stored,projection,fragments,evidenceFault:false,
    plan:{listed:3,clarificationTotal:3,clarificationPending:0,continuation:false},flush:async()=>{await store.recordFragments(fragments);},...extra});
  const item=(targetId:string)=>getAgendaItems(stored.agenda).find(i=>i.id===targetId)!;
  return{client,store,projection,records,operations,calls,context,item,stored:()=>stored,commits:()=>commits,commitCalls:()=>calls.filter(c=>c.name==='commit_website_live_decision')};
}
const responseWith=(body:unknown,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const completed=(out:{decisions:PostcallDecision[];ambiguous?:unknown[]},usage:unknown=PRICED_USAGE,extra:Record<string,unknown>={})=>responseWith({id:'resp_postcall_1',status:'completed',model:'gpt-6-astra',
  output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({ambiguous:[],...out})}]}],usage,...extra});
function fakeFetch(handler:(call:{url:string;init:any;body:any})=>unknown){
  const calls:{url:string;init:any;body:any}[]=[];
  const fetch=async(url:string,init:any)=>{const call={url,init,body:JSON.parse(init.body)};calls.push(call);return handler(call);};
  return{calls,fetch};
}
const deps=(fetch:unknown,extra:Record<string,unknown>={})=>({apiKey:'synthetic-key',fetch:fetch as typeof globalThis.fetch,modelTimeoutMs:2_000,signal:new AbortController().signal,stopReason:'close_requested',...extra});
async function record(f:ReturnType<typeof fixture>,decisions:PostcallDecision[],options:{ambiguous?:unknown[];fragments?:LiveFragment[];usage?:unknown;context?:Partial<PostcallContext>;deps?:Record<string,unknown>}={}){
  const fetch=fakeFetch(()=>completed({decisions,...(options.ambiguous?{ambiguous:options.ambiguous}:{})},options.usage));
  const state=await runPostcallRecording(f.context(options.fragments,options.context),deps(fetch.fetch,options.deps));
  return{state,fetch};
}
const logs:string[]=[];const original={log:console.log,error:console.error};
afterEach(()=>{console.log=original.log;console.error=original.error;logs.length=0;});

describe('post-call transcript turns and model input',()=>{
  test('owner deltas merge until an assistant fragment interrupts; ids d1../l1.. keep their event ids',()=>{
    const turns=buildPostcallTurns([...TRANSCRIPT].reverse());
    expect(turns.owner).toEqual([
      {id:'d1',speaker:'owner',t:1000,text:'No domingo, só emergência.',eventIds:['o-1','o-2']},
      {id:'d2',speaker:'owner',t:3000,text:'Sim, pode confirmar.',eventIds:['o-3']},
      {id:'d3',speaker:'owner',t:5000,text:'Das oito às dezoito.',eventIds:['o-4']}]);
    expect(turns.assistant.map(t=>[t.id,t.t,t.text])).toEqual([['l1',0,'Qual a regra de domingo?'],['l2',2000,'E o Ligou pode confirmar agendamentos sozinho?'],['l3',4000,'Qual o horário de semana?']]);
    expect(turns.all.map(t=>t.id)).toEqual(['l1','d1','l2','d2','l3','d3']);
  });
  test('the model input separates open items, resolved items (no question) and website candidates, with the transcript in order',()=>{
    const f=fixture({preAnswer:[{targetId:'price',interpretation:'Cento e nove dólares.'}]});
    const input=buildPostcallInput(f.stored(),buildPostcallTurns(TRANSCRIPT));
    expect(input.catalogo).toEqual([
      {targetId:'book',subject:'authority.book',pergunta:'O Ligou pode confirmar agendamentos sozinho?',status:'open'},
      {targetId:'sunday',subject:'business_hours',pergunta:'Qual a regra de domingo?',status:'open'},
      {targetId:'floor',subject:'negotiation',pergunta:'Qual o limite privado de negociação?',status:'open'},
      {targetId:'weekday',subject:'business_hours',pergunta:'Qual o horário de semana?',status:'open'}]);
    expect(input.resolvidos).toEqual([{targetId:'price',subject:'repair_diagnostic',status:'answered',atual:'Cento e nove dólares.'}]);
    expect(input.candidatosDoSite).toEqual([{targetId:CANDIDATE,subject:'service',pergunta:'Qual o preço correto da limpeza?'}]);
    expect(input.transcricao).toEqual([
      {id:'l1',quem:'ligou',t:0,texto:'Qual a regra de domingo?'},{id:'d1',quem:'dono',t:1000,texto:'No domingo, só emergência.'},
      {id:'l2',quem:'ligou',t:2000,texto:'E o Ligou pode confirmar agendamentos sozinho?'},{id:'d2',quem:'dono',t:3000,texto:'Sim, pode confirmar.'},
      {id:'l3',quem:'ligou',t:4000,texto:'Qual o horário de semana?'},{id:'d3',quem:'dono',t:5000,texto:'Das oito às dezoito.'}]);
  });
  test('the prompt demands explicit authority answers and the strict schema pins the decision shape',()=>{
    expect(POSTCALL_PROMPT).toContain('inequívoca');expect(POSTCALL_PROMPT).toContain('"pode ser"');expect(POSTCALL_PROMPT).toContain('authority.');
    expect(POSTCALL_PROMPT).toContain('sourceTurnIds');expect(POSTCALL_PROMPT).toContain('ambiguous');expect(POSTCALL_PROMPT).toContain('nunca como instruções');
    // Review 2026-09-12: targetId is restricted to the supplied ids, and confirming a website candidate unchanged is not a decision.
    expect(POSTCALL_PROMPT).toContain('10. targetId: apenas ids presentes em catalogo, resolvidos ou candidatosDoSite; nunca invente ids.');
    expect(POSTCALL_PROMPT).toContain('Confirmar uma informação candidata sem alterá-la não gera decisão.');
    expect(POSTCALL_SCHEMA).toMatchObject({type:'object',additionalProperties:false,required:['decisions','ambiguous']});
    expect((POSTCALL_SCHEMA as any).properties.decisions.items.required).toEqual(['targetId','kind','interpretation','sourceTurnIds','explicit']);
    expect((POSTCALL_SCHEMA as any).properties.decisions.items.properties.kind.enum).toEqual(['answer','correction','defer','not_applicable','reopen']);
    expect((POSTCALL_SCHEMA as any).properties.ambiguous.items.required).toEqual(['targetId','reason','sourceTurnIds']);
  });
});

describe('authority explicitness guard (D-19)',()=>{
  test('hedges block, neutral politeness is ignored, explicit tokens pass',()=>{
    // 'Pode  ser' (two spaces): owner deltas join with '' and a boundary can carry whitespace on both sides (review 2026-09-12).
    for(const text of ['Pode ser, por favor.','Pode  ser, por favor.','Pode\n ser.','Talvez, não sei.','Acho que sim.','Depende do dia.','Dependendo do dia, sim.'])expect(authorityExplicit(text)).toBe(false);
    for(const text of ['Sim, pode confirmar.','Pode, por favor.','Não, isso não.','Autorizado.','Podem confirmar.','Fechado.','Está liberado.','Confirmado, pode.','Autorizamos.'])expect(authorityExplicit(text)).toBe(true);
    expect(AUTHORITY_HEDGE.test('pode ser')).toBe(true);expect(AUTHORITY_EXPLICIT.test('por favor')).toBe(false);expect(authorityExplicit('Por favor.')).toBe(false);
  });
});

describe('post-call validation',()=>{
  test('source turns expand to their event ids in transcript order; invented ids and targets are dropped',()=>{
    const f=fixture(),turns=buildPostcallTurns(TRANSCRIPT);
    const result=validatePostcallDecisions(f.stored(),turns,[
      dec('sunday','answer','Domingo só emergência; de semana das oito às dezoito.',['d3','d1']),
      dec('weekday','answer','Das oito às dezoito.',['d9']),
      dec('weekday','answer','Das oito às dezoito.',[]),
      dec('ghost','answer','x',['d1']),
      dec('weekday','answer','   ',['d3']),
    ],[]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].decision).toEqual({kind:'answer',targetId:'sunday',interpretation:'Domingo só emergência; de semana das oito às dezoito.',sourceEventIds:['o-1','o-2','o-4']});
    expect(result.skipped).toEqual([{targetId:'weekday',reason:'unknown_turn'},{targetId:'weekday',reason:'no_source'},{targetId:'ghost',reason:'unknown_target'},{targetId:'weekday',reason:'interpretation_invalid'}]);
    expect(result.ambiguous).toEqual([]);
  });
  test('an assistant turn cited as a source is not owner evidence',()=>{
    const f=fixture(),turns=buildPostcallTurns(TRANSCRIPT);
    const result=validatePostcallDecisions(f.stored(),turns,[dec('sunday','answer','x',['l1'])],[]);
    expect(result.accepted).toEqual([]);expect(result.skipped).toEqual([{targetId:'sunday',reason:'unknown_turn'}]);
  });
  test('model ambiguity entries are kept under a fixed code; the model text never reaches the marker',()=>{
    const f=fixture(),turns=buildPostcallTurns(TRANSCRIPT);
    const result=validatePostcallDecisions(f.stored(),turns,[],[{targetId:'book',reason:'O dono disse "pode ser" sem confirmar',sourceTurnIds:['d2']},{targetId:'ghost',reason:'x',sourceTurnIds:[]}]);
    expect(result.ambiguous).toEqual([{targetId:'book',reason:'model_ambiguous'}]);expect(JSON.stringify(result)).not.toContain('pode ser');
  });
  test('a target the model lists in both decisions and ambiguous is not committed (finding: self-contradictory output)',()=>{
    const f=fixture(),turns=buildPostcallTurns(TRANSCRIPT);
    const result=validatePostcallDecisions(f.stored(),turns,[dec('price','answer','Cento e nove dólares.',['d3']),dec('sunday','answer','Só emergência.',['d1'])],[{targetId:'price',reason:'valor incerto',sourceTurnIds:['d3']}]);
    expect(result.accepted.map(e=>e.decision.targetId)).toEqual(['sunday']);
    expect(result.skipped).toEqual([{targetId:'price',reason:'model_ambiguous'}]);expect(result.ambiguous).toEqual([{targetId:'price',reason:'model_ambiguous'}]);
  });
});

describe('post-call recording end to end',()=>{
  test('an explicit authority answer is committed once through the live decision path',async()=>{
    const f=fixture();const {state}=await record(f,[dec('book','answer','O Ligou pode confirmar agendamentos sozinho.',['d2'],true)]);
    expect(state.outcome).toBe('done');expect(state.reason).toBe(null);expect(state.error).toBe(null);
    expect(state.operations).toEqual([{operationRef:expect.stringMatching(/^ligou-live-op:[a-f0-9]{64}$/),kind:'answer',targetId:'book',revision:1}]);
    expect(state.ambiguous).toEqual([]);expect(state.skipped).toEqual([]);
    expect(f.item('book').status).toBe('answered');expect(f.item('book').evidence.at(-1)).toMatchObject({text:'O Ligou pode confirmar agendamentos sozinho.',provenance:'model_interpretation'});
    expect(f.commitCalls()[0].args).toMatchObject({p_source_ids:['o-3'],p_target:'book',p_kind:'answer',p_session:scope.providerSessionId});
    expect(state.fragments).toEqual({owner:4,assistant:3,persisted:true});expect(state.plan).toEqual({listed:3,clarificationTotal:3,clarificationPending:0,continuation:false});
    expect(state).toMatchObject({version:1,model:'gpt-6-astra',responseId:'resp_postcall_1',stopReason:'close_requested',usage:{inputTokens:800,outputTokens:120,priced:true}});
    expect(state.usage!.costUsd).toBeGreaterThan(0);expect(state.pendingAfter).toBe(3);
    expect(typeof state.durationMs).toBe('number');expect(Date.parse(state.startedAt)).not.toBeNaN();expect(Date.parse(state.finishedAt)).not.toBeNaN();
    expect(state.usageRaw).toEqual(PRICED_USAGE);
  });
  test('D-19: "Pode ser, por favor." never becomes an authority decision even when the model claims explicit',async()=>{
    const f=fixture();const {state}=await record(f,[dec('book','answer','O Ligou pode confirmar.',['d2'],true)],{fragments:withOwnerTurn('o-3','Pode ser, por favor.')});
    expect(state.outcome).toBe('done');expect(state.operations).toEqual([]);expect(f.commits()).toBe(0);
    expect(state.ambiguous).toEqual([{targetId:'book',reason:'authority_not_explicit'}]);expect(f.item('book').status).toBe('open');
  });
  test('a non-authority target declared ambiguous by the model is skipped even when it also appears in decisions',async()=>{
    const f=fixture();const {state}=await record(f,[dec('price','answer','Cento e nove dólares.',['d3'])],{ambiguous:[{targetId:'price',reason:'valor incerto',sourceTurnIds:['d3']}]});
    expect(state.outcome).toBe('done');expect(state.operations).toEqual([]);expect(f.commits()).toBe(0);expect(f.item('price').status).toBe('open');
    expect(state.skipped).toEqual([{targetId:'price',reason:'model_ambiguous'}]);expect(state.ambiguous).toEqual([{targetId:'price',reason:'model_ambiguous'}]);
  });
  test('a clear authority answer the model did not mark explicit stays ambiguous',async()=>{
    const f=fixture();const {state}=await record(f,[dec('book','answer','O Ligou pode confirmar.',['d2'],false)]);
    expect(state.operations).toEqual([]);expect(f.commits()).toBe(0);expect(state.ambiguous).toEqual([{targetId:'book',reason:'authority_not_explicit'}]);
  });
  test('one owner turn cannot authorize two authority targets',async()=>{
    const f=fixture();const {state}=await record(f,[dec('book','answer','Pode confirmar.',['d2'],true),dec('floor','answer','Pode negociar.',['d2'],true)]);
    expect(state.operations).toEqual([]);expect(f.commits()).toBe(0);
    expect(state.ambiguous).toEqual([{targetId:'book',reason:'shared_authority_source'},{targetId:'floor',reason:'shared_authority_source'}]);
  });
  test('the guard applies to owner-private items without an authority coverage ref',async()=>{
    const f=fixture();const {state}=await record(f,[dec('floor','answer','Até dez por cento.',['d1'],true)]);
    expect(state.operations).toEqual([]);expect(state.ambiguous).toEqual([{targetId:'floor',reason:'authority_not_explicit'}]);
  });
  test('answer on a resolved item is committed as a correction',async()=>{
    const f=fixture({preAnswer:[{targetId:'price',interpretation:'Cento e quarenta e nove.'}]});
    const {state}=await record(f,[dec('price','answer','Cento e nove dólares.',['d3'])]);
    expect(state.operations).toEqual([{operationRef:expect.any(String),kind:'correction',targetId:'price',revision:2}]);expect(f.item('price').status).toBe('corrected');
  });
  test('correction on an open item without an answer is committed as an answer',async()=>{
    const f=fixture();const {state}=await record(f,[dec('sunday','correction','No domingo, só emergência.',['d1'])]);
    expect(state.operations).toEqual([{operationRef:expect.any(String),kind:'answer',targetId:'sunday',revision:1}]);expect(f.item('sunday').status).toBe('answered');
  });
  test('reopen on an item that was never answered is skipped',async()=>{
    const f=fixture();const {state}=await record(f,[dec('sunday','reopen','Não é isso.',['d1'])]);
    expect(state.operations).toEqual([]);expect(state.skipped).toEqual([{targetId:'sunday',reason:'reopen_on_open'}]);
  });
  test('defer and not_applicable on a resolved item are skipped',async()=>{
    const f=fixture({preAnswer:[{targetId:'price',interpretation:'Cento e quarenta e nove.'}]});
    const {state}=await record(f,[dec('price','defer','Fica pra depois.',['d3']),dec('price','not_applicable','Não se aplica.',['d3'])]);
    expect(state.operations).toEqual([]);expect(state.skipped).toEqual([{targetId:'price',reason:'resolved_target_requires_correction'},{targetId:'price',reason:'resolved_target_requires_correction'}]);
  });
  test('website candidates accept corrections only',async()=>{
    const f=fixture();const {state}=await record(f,[dec(CANDIDATE,'defer','Depois.',['d3']),dec(CANDIDATE,'answer','Limpeza custa cento e noventa.',['d3'])]);
    expect(state.skipped).toEqual([{targetId:CANDIDATE,reason:'candidate_requires_correction'}]);
    expect(state.operations).toEqual([{operationRef:expect.any(String),kind:'correction',targetId:CANDIDATE,revision:1}]);
    expect(f.stored().agenda.candidateOverrides.map((i:any)=>[i.id,i.status])).toEqual([[CANDIDATE,'corrected']]);
  });
  test('duplicate targets keep the decision whose sources come last',async()=>{
    const f=fixture();const {state}=await record(f,[dec('sunday','answer','Primeira versão.',['d3']),dec('sunday','answer','Versão anterior.',['d1'])]);
    expect(state.operations).toHaveLength(1);expect(f.item('sunday').evidence.at(-1)!.text).toBe('Primeira versão.');
    expect(state.skipped).toEqual([{targetId:'sunday',reason:'duplicate_target'}]);
  });
  test('commits run sequentially in transcript order on the readback of the previous commit',async()=>{
    const f=fixture();const {state}=await record(f,[dec('weekday','answer','Das oito às dezoito.',['d3']),dec('sunday','answer','No domingo, só emergência.',['d1'])]);
    expect(state.operations.map(o=>[o.targetId,o.revision])).toEqual([['sunday',1],['weekday',2]]);
    expect(f.commitCalls().map(c=>c.args.p_revision)).toEqual([0,1]);expect(f.stored().revision).toBe(2);expect(state.pendingAfter).toBe(3);
  });
  test('a revision conflict re-reads the interview and retries once',async()=>{
    const f=fixture({conflictFirstCommit:true});const {state}=await record(f,[dec('sunday','answer','No domingo, só emergência.',['d1'])]);
    expect(state.outcome).toBe('done');expect(state.operations).toEqual([{operationRef:expect.any(String),kind:'answer',targetId:'sunday',revision:2}]);
    const names=f.calls.map(c=>c.name);const first=names.indexOf('commit_website_live_decision');
    expect(names.slice(first)).toEqual(['commit_website_live_decision','read_website_interview','commit_website_live_decision']);expect(f.commits()).toBe(2);
  });
  test('an explicit rejection skips that decision and the rest still commit',async()=>{
    const f=fixture({rejectCommit:{message:'live_resolved_target_requires_correction',code:'P0001',once:true}});
    const {state}=await record(f,[dec('sunday','answer','No domingo, só emergência.',['d1']),dec('weekday','answer','Das oito às dezoito.',['d3'])]);
    expect(state.outcome).toBe('done');expect(state.skipped).toEqual([{targetId:'sunday',reason:'rejected:live_resolved_target_requires_correction'}]);
    expect(state.operations).toEqual([{operationRef:expect.any(String),kind:'answer',targetId:'weekday',revision:1}]);
  });
  test('a lost commit result is recovered by reading the operation back; a vanished one is unconfirmed',async()=>{
    const lost=fixture({commitLost:true});const first=await record(lost,[dec('sunday','answer','No domingo, só emergência.',['d1'])]);
    expect(first.state.operations).toEqual([{operationRef:expect.any(String),kind:'answer',targetId:'sunday',revision:1}]);
    expect(lost.calls.some(c=>c.name==='read_website_live_operation')).toBe(true);expect(lost.commits()).toBe(1);
    const vanished=fixture({commitVanished:true});const second=await record(vanished,[dec('sunday','answer','No domingo, só emergência.',['d1'])]);
    expect(second.state.operations).toEqual([]);expect(second.state.skipped).toEqual([{targetId:'sunday',reason:'unconfirmed'}]);expect(second.state.outcome).toBe('done');
  });
  test('a permission rejection aborts the pass as scope_invalid',async()=>{
    const f=fixture({scopeInvalidCommit:true});
    const {state}=await record(f,[dec('sunday','answer','No domingo, só emergência.',['d1']),dec('weekday','answer','Das oito às dezoito.',['d3'])]);
    expect(state.outcome).toBe('failed');expect(state.reason).toBe('scope_invalid');expect(state.operations).toEqual([]);expect(f.commits()).toBe(1);
  });
  test('a permission rejection while flushing the transcript is scope_invalid, not a persistence failure',async()=>{
    const f=fixture();const {state,fetch}=await record(f,[dec('sunday','answer','x',['d1'])],{context:{flush:async()=>{throw new LivePersistenceError('live_interview_scope_invalid','42501',403);}}});
    expect(state.outcome).toBe('failed');expect(state.reason).toBe('scope_invalid');expect(fetch.calls).toHaveLength(0);expect(state.fragments.persisted).toBe(false);
  });
  test('an already-aborted signal returns timeout before any model call',async()=>{
    const f=fixture();const controller=new AbortController();controller.abort();
    const {state,fetch}=await record(f,[dec('sunday','answer','x',['d1'])],{deps:{signal:controller.signal}});
    expect(state.outcome).toBe('timeout');expect(state.operations).toEqual([]);expect(fetch.calls).toHaveLength(0);expect(f.commits()).toBe(0);
  });
  test('a hanging commit is bounded by the signal; the marker lists the committed, in-flight and never-attempted decisions',async()=>{
    const f=fixture({holdCommit:1});const controller=new AbortController();setTimeout(()=>controller.abort(),30);
    const {state}=await record(f,[dec('sunday','answer','No domingo, só emergência.',['d1']),dec('weekday','answer','Das oito às dezoito.',['d3']),dec('price','answer','Cento e nove.',['d3'])],{deps:{signal:controller.signal}});
    expect(state.outcome).toBe('timeout');expect(state.reason).toBe('recorder_timeout');expect(state.operations.map(o=>o.targetId)).toEqual(['sunday']);
    expect(state.skipped).toEqual([{targetId:'weekday',reason:'in_flight'},{targetId:'price',reason:'not_attempted'}]);expect(f.commits()).toBe(2);
  });
  test('a permission rejection mid-pass lists the decisions it left unattempted',async()=>{
    const f=fixture({scopeInvalidCommit:true});
    const {state}=await record(f,[dec('sunday','answer','x',['d1']),dec('weekday','answer','y',['d3'])]);
    expect(state.reason).toBe('scope_invalid');expect(state.skipped).toEqual([{targetId:'weekday',reason:'not_attempted'}]);
  });
  test('a hanging model call is bounded by the signal',async()=>{
    const f=fixture();const controller=new AbortController();setTimeout(()=>controller.abort(),30);
    const fetch=fakeFetch(({init})=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})))));
    const state=await runPostcallRecording(f.context(),deps(fetch.fetch,{signal:controller.signal}));
    expect(state.outcome).toBe('timeout');expect(fetch.calls).toHaveLength(1);expect(f.commits()).toBe(0);
  });
  test('the model timeout alone fails the recording without a second attempt',async()=>{
    const f=fixture();
    const fetch=fakeFetch(({init})=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'TimeoutError'})))));
    const state=await runPostcallRecording(f.context(),deps(fetch.fetch,{modelTimeoutMs:20}));
    expect(state.outcome).toBe('failed');expect(state.reason).toBe('model_timeout');expect(fetch.calls).toHaveLength(1);
  });
  test('HTTP, incomplete, refusal and malformed model outcomes fail once without retry',async()=>{
    const cases:[string,()=>unknown][]=[
      ['model_http_500',()=>responseWith({error:{message:'boom'}},500)],
      ['model_incomplete',()=>completed({decisions:[]},PRICED_USAGE,{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}})],
      ['model_refusal',()=>responseWith({id:'resp_r',status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}],usage:PRICED_USAGE})],
      ['model_output_invalid',()=>responseWith({id:'resp_i',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"decisions":"nope"}'}]}],usage:PRICED_USAGE})],
      ['model_unreachable',()=>{throw new TypeError('fetch failed');}],
    ];
    for(const [reason,response] of cases){
      const f=fixture();const fetch=fakeFetch(response);const state=await runPostcallRecording(f.context(),deps(fetch.fetch));
      expect([reason,state.outcome]).toEqual([reason,'failed']);expect(state.reason).toBe(reason);expect(fetch.calls).toHaveLength(1);expect(f.commits()).toBe(0);
    }
  });
  test('no owner speech means nothing to record and no paid call',async()=>{
    const f=fixture();const {state,fetch}=await record(f,[],{fragments:TRANSCRIPT.filter(x=>x.speaker==='assistant')});
    expect(state.outcome).toBe('nothing_to_record');expect(fetch.calls).toHaveLength(0);expect(state.fragments).toEqual({owner:0,assistant:3,persisted:true});expect(state.pendingAfter).toBe(4);
  });
  test('unpersisted evidence stops the recorder before the model',async()=>{
    const f=fixture();const {state,fetch}=await record(f,[dec('sunday','answer','x',['d1'])],{context:{flush:async()=>{throw Error('temporarily unavailable');}}});
    expect(state.outcome).toBe('failed');expect(state.reason).toBe('evidence_not_persisted');expect(fetch.calls).toHaveLength(0);expect(state.fragments.persisted).toBe(false);
  });
  test('a corrupted transcript collector is never recorded from',async()=>{
    const f=fixture();const {state,fetch}=await record(f,[dec('sunday','answer','x',['d1'])],{context:{evidenceFault:true}});
    expect(state.outcome).toBe('failed');expect(state.reason).toBe('evidence_fault');expect(fetch.calls).toHaveLength(0);
  });
  test('the request is one strict-JSON Responses call on gpt-6-astra with low reasoning',async()=>{
    const f=fixture();const {fetch}=await record(f,[]);
    expect(fetch.calls).toHaveLength(1);const {url,init,body}=fetch.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({Authorization:'Bearer synthetic-key','Content-Type':'application/json'});expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body).toMatchObject({model:'gpt-6-astra',reasoning:{effort:'low'},store:false,max_output_tokens:16384,text:{format:{type:'json_schema',strict:true,name:'ligou_postcall_decisions',schema:POSTCALL_SCHEMA}}});
    expect(body.input[0]).toEqual({role:'developer',content:POSTCALL_PROMPT});expect(body.input[1].role).toBe('user');
    expect(Object.keys(JSON.parse(body.input[1].content))).toEqual(['catalogo','resolvidos','candidatosDoSite','transcricao']);
    expect(body).not.toHaveProperty('tools');expect(body).not.toHaveProperty('previous_response_id');
  });
  test('unpriced usage is summarised as unpriced with no invented cost',async()=>{
    const f=fixture();const {state}=await record(f,[],{usage:UNPRICED_USAGE});
    expect(state.usage).toEqual({inputTokens:800,outputTokens:120,costUsd:null,priced:false});expect(state.usageRaw).toEqual(UNPRICED_USAGE);
  });
  test('logs carry ids and counts only, never transcript text',async()=>{
    console.log=(...args:unknown[])=>{logs.push(args.map(String).join(' '));};console.error=(...args:unknown[])=>{logs.push(args.map(String).join(' '));};
    const f=fixture({rejectCommit:{message:'live_operation_conflict',code:'P0001',once:true}});
    const {state}=await record(f,[dec('sunday','answer','No domingo, só emergência.',['d1']),dec('book','answer','Pode confirmar.',['d2'],true)],
      {ambiguous:[{targetId:'weekday',reason:'O dono disse "das oito às dezoito" sem confirmar',sourceTurnIds:['d3']}]});
    const joined=logs.join('\n');expect(joined).toContain('live_postcall');
    for(const phrase of ['emergência','pode confirmar','dezoito','No domingo'])expect(joined.toLowerCase()).not.toContain(phrase.toLowerCase());
    // The persisted marker (calls.provider_usage_details.postcall, budget_reservations.detail) is ids and codes only.
    const marker=JSON.stringify(state).toLowerCase();
    for(const phrase of ['emergência','pode confirmar','dezoito','No domingo','sem confirmar'])expect(marker).not.toContain(phrase.toLowerCase());
    expect(state.ambiguous).toEqual([{targetId:'weekday',reason:'model_ambiguous'}]);
  });
});
