import {expect,test} from 'bun:test';
import * as timezone from '../src/onboarding-timezone-context.ts';
import {createOnboardingAgenda,applyVerifiedOwnerTurn,getAgendaAction,parseOnboardingAgenda} from '../src/onboarding-agenda.ts';
import {onboardingAgendaDigest} from '../src/onboarding-agenda-store.ts';
import {buildNativeOnboardingContext} from '../src/onboarding-native-session.ts';
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const territory={claim_id:id(1),claim_type:'service_territory',evidence_refs:[id(11)],missing_fields:[],ambiguous_fields:[],contradiction_status:'none',uncertainty:[],
 value:{included_areas:[{kind:'city',name:'Chico',country_code:'US',region_state:'CA'}],excluded_areas:[],radius:null,service_type:null}};
const address={...territory,claim_id:id(2),claim_type:'public_address',evidence_refs:[id(12)],value:'10 Main Street, Chico, CA 95926'};
const hours={...territory,claim_id:id(3),claim_type:'business_hours',evidence_refs:[id(13)],missing_fields:['timezone'],value:{timezone:null}};
const facts=()=>structuredClone([territory,address,hours]);
const binding={interviewId:id(21),callId:id(21),draftId:id(22),draftHash:'a'.repeat(64),sourceResultId:id(23),sourceResultHash:'b'.repeat(64)};
const seeds=[{id:'area',source:'ambiguity' as const,subject:'area.coverage',questionPt:'Quais cidades atende?',coverageRefs:['area.coverage'],relatedItemIds:[],blocking:true},
 {id:'timezone',source:'missing_website_information' as const,subject:'discovery.owner_question.timezone',questionPt:'Qual é o fuso horário oficial usado para os horários publicados?',coverageRefs:['discovery.owner_question.timezone'],relatedItemIds:[],blocking:true},
 {id:'hours',source:'ambiguity' as const,subject:'schedule.business_hours',questionPt:'Confirme os horários normais da empresa e o fuso horário, inclusive domingo.',coverageRefs:['schedule.business_hours'],relatedItemIds:[],blocking:true}];
const candidates=[territory,address,hours].map(f=>({id:'candidate:'+f.claim_id,subject:f.claim_type,questionPt:'Candidato do website.',coverageRefs:['discovery.candidate.'+f.claim_id.replaceAll('-','')]}));
test('a compound source question never loses its independent hours or weekend obligation',()=>{
 for(const question of ['Qual é o fuso horário e quais são os horários normais, inclusive domingo?','Qual é o fuso horário? Atende aos domingos?'])expect(timezone.isTimezoneQuestion(question)).toBe(false);
 expect(timezone.isTimezoneQuestion(seeds[1].questionPt)).toBe(true);
});
test('US/CA structured operating scope yields a named, source-bound inference without city hardcodes',()=>{
 const result=timezone.resolveWebsiteContextTimezone(facts(),'timezone');
 expect(result).toEqual({itemId:'timezone',timeZone:'America/Los_Angeles',origin:'location_inference',sourceClaimIds:[id(1),id(2)],evidenceRefs:[id(11),id(12)]});
 const changed=facts();changed[0].value.included_areas[0].name='Santa Barbara';changed[1].value='20 State St, Santa Barbara, CA 93101';
 expect(timezone.resolveWebsiteContextTimezone(changed,'timezone')?.timeZone).toBe('America/Los_Angeles');
});
test('technical defaults, ambiguous/multiple regions and incomplete locality do not infer a zone',()=>{
 expect(timezone.resolveWebsiteContextTimezone([], 'timezone')).toBeNull();
 for(const mutate of [(f:any[])=>f[0].value.included_areas[0].country_code='CA',(f:any[])=>f[0].value.included_areas[0].region_state='NV',
  (f:any[])=>f[0].value.included_areas.push({kind:'city',name:'Phoenix',country_code:'US',region_state:'AZ'}),(f:any[])=>f[0].value.radius={km:100},
  (f:any[])=>f[1].value='An ambiguous address',(f:any[])=>f[1].value='10 Main St, Reno, NV 89501',(f:any[])=>f[0].contradiction_status='possible']){
  const f=facts();mutate(f);expect(timezone.resolveWebsiteContextTimezone(f,'timezone')).toBeNull();
 }
});
test('a stated valid website zone takes precedence, invalid/contradictory zones never silently become California',()=>{
 const f=facts();f[2].value={timezone:'America/New_York'};f[2].missing_fields=[];
 expect(timezone.resolveWebsiteContextTimezone(f,'timezone')).toMatchObject({timeZone:'America/New_York',origin:'website_configuration',sourceClaimIds:[id(3)]});
 for(const value of ['PST','-08:00','Not/AZone']){f[2].value={timezone:value};expect(timezone.resolveWebsiteContextTimezone(f,'timezone')).toBeNull();}
 f[2].value={timezone:'America/New_York'};f.push({...f[2],claim_id:id(4),value:{timezone:'America/Los_Angeles'}});
 expect(timezone.resolveWebsiteContextTimezone(f,'timezone')).toBeNull();
});
test('context-resolved timezone remains a correction target with no fake owner turn or lost hours question',()=>{
 const context=timezone.resolveWebsiteContextTimezone(facts(),'timezone')!;
 const original=createOnboardingAgenda(binding,seeds,candidates,context);
 expect(original.items[1]).toMatchObject({status:'context_resolved',answerRevision:0,evidence:[]});expect(original.ownerTurns).toEqual([]);
 expect(parseOnboardingAgenda(original,binding)).toEqual(original);
 const answer=applyVerifiedOwnerTurn(original,{type:'verified_owner_turn',binding,turnId:'turn-area',text:'Atendemos esta cidade.',provenance:'model_interpretation',proposal:{kind:'answer',itemId:'area'}});
 expect(getAgendaAction(answer.agenda).itemId).toBe('hours');expect(answer.agenda.contextTimezone).toEqual(context);
 const native=buildNativeOnboardingContext({agenda:answer.agenda,revision:1,storeVersion:1,digest:onboardingAgendaDigest(answer.agenda),receiptId:id(40),nextAction:getAgendaAction(answer.agenda),state:'unfinished',replayed:false},'Empresa');
 expect(native.time_zone_context).toMatchObject({origin:'location_inference',timeZone:'America/Los_Angeles',askTimezone:false});
 expect(native.current_item?.question).toBe('Confirme os horários normais da empresa, inclusive domingo.');
 expect(native.correction_catalog.items.map(i=>i.id)).toContain('timezone');
 const correction=applyVerifiedOwnerTurn(answer.agenda,{type:'verified_owner_turn',binding,turnId:'turn-zone',text:'Usamos America/New_York.',provenance:'model_interpretation',proposal:{kind:'correction',affectedItems:[{itemId:'timezone',disposition:'corrected'}]}});
 expect(correction.agenda).not.toHaveProperty('contextTimezone');expect(correction.agenda.items[1].status).toBe('corrected');
 expect(original.contextTimezone).toEqual(context);
 expect(timezone.projectWebsiteTimezone(correction.agenda)).toMatchObject({state:'owner_decision',timeZone:null,itemId:'timezone',evidence:{text:'Usamos America/New_York.'}});
});
test('free owner prose is retained, never canonicalized by extracting even a negated timezone token',()=>{
 for(const text of ['Não use America/New_York; mantenha o Pacífico.','America/New_York e America/Los_Angeles dependem da filial.','Entendi que o fuso horário oficial é o fuso do Pacífico, adotando horário de verão quando aplicável.']){
  const original=createOnboardingAgenda(binding,seeds,candidates);
  const agenda=applyVerifiedOwnerTurn(original,{type:'verified_owner_turn',binding,turnId:'turn-zone',text,provenance:'model_interpretation',proposal:{kind:'correction',affectedItems:[{itemId:'timezone',disposition:'corrected'}]}}).agenda;
  expect(timezone.projectWebsiteTimezone(agenda)).toMatchObject({state:'owner_decision',timeZone:null,askTimezone:false,evidence:{text,provenance:'model_interpretation'}});
 }
});
test('saved owner timezone suppresses only the timezone facet of a later hours question',()=>{
 const original=createOnboardingAgenda(binding,seeds,candidates);
 const answered=applyVerifiedOwnerTurn(original,{type:'verified_owner_turn',binding,turnId:'turn-zone',text:'Entendi que o fuso horário oficial é o fuso do Pacífico, adotando horário de verão quando aplicável.',provenance:'model_interpretation',proposal:{kind:'correction',affectedItems:[{itemId:'timezone',disposition:'corrected'}]}}).agenda;
 const resolution=timezone.projectWebsiteTimezone(answered);expect(resolution.state).toBe('owner_decision');
 expect(timezone.timezoneContextQuestion(seeds[2].questionPt,resolution)).toBe('Confirme os horários normais da empresa, inclusive domingo.');
 expect(answered.items[2].questionPt).toBe(seeds[2].questionPt);expect(answered.items[2].status).toBe('open');
});
test('IANA formatting retains the same local clock across summer/winter; a fixed offset is not the zone',()=>{
 const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 expect(fmt.format(new Date('2026-01-15T16:00:00Z'))).toBe('08:00');expect(fmt.format(new Date('2026-07-15T15:00:00Z'))).toBe('08:00');
 expect(timezone.canonicalNamedTimezone('-08:00')).toBeNull();expect(timezone.canonicalNamedTimezone('PST')).toBeNull();
});
