import {Buffer} from 'node:buffer';
import {getAgendaItems,type AgendaItem} from './onboarding-agenda.ts';
import type {StoredWebsiteInterview} from './onboarding-agenda-store.ts';
import type {WebsiteAgendaSeedProjection} from './onboarding-agenda-seed.ts';

/** Internal ceiling of clarification points per call. Never announced to the
 * owner: the voice prompt lists the points as data and closes when they are
 * done, so no number, limit or rule is ever spoken. Ten is a ceiling, not a
 * target: fewer points end the call normally; only points left over keep the
 * interview unfinished for another day. */
export const LIVE_QUESTION_CAP=10;
/** Byte budget of the JSON question list embedded in the voice prompt (design
 * §3.5: Foghorn top-10 measured at 1066 B). Bounds any site's list so the
 * per-second voice session never pays for a long catalogue. */
export const LIVE_QUESTION_BYTES=1280;
export type LiveQuestionTier=1|2|3|4;
export type LiveQuestion={targetId:string;subject:string;questionPt:string;tier:LiveQuestionTier};
export type LiveQuestionPlan={questions:LiveQuestion[];clarificationTotal:number;clarificationPending:number;continuation:boolean;byteLength:number;tiers:Record<LiveQuestionTier,number>};
type Ranked=LiveQuestion&{seedIndex:number;emphasis:number};
type Stored=Pick<StoredWebsiteInterview,'agenda'>;
type Projection=Pick<WebsiteAgendaSeedProjection,'candidateRecap'>;

const PRICE_REF=/:service\.(price_target|price_mode)$/;
/** Per-service negotiation/escalation clones: one pair per service in the
 * catalogue, private to the owner but not a decision the Ligou needs before it
 * can operate (review 2026-09-12: with them in tier 2 the Foghorn ceiling became
 * a five-call march of "Este preço é negociável? (service X)"). */
const SERVICE_TERMS_REF=/:service\.(negotiation|escalation)$/;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const unresolved=(item:AgendaItem)=>item.status==='open'||item.status==='awaiting_clarification';
const authority=(item:AgendaItem)=>item.coverageRefs.some(ref=>ref.startsWith('authority.'));
/** How much the website emphasises a service: number of service claims whose
 * service_type is the item subject. Existing metadata only; no model call. */
function emphasisBySubject(projection:Projection){
  const counts=new Map<string,number>();
  for(const claim of projection.candidateRecap){
    if(claim.claim_type!=='service'||!object(claim.value)||typeof claim.value.service_type!=='string')continue;
    counts.set(claim.value.service_type,(counts.get(claim.value.service_type)??0)+1);
  }
  return counts;
}
/** Median service-claim count over the services the website mentions (0 when
 * it mentions none). */
function medianEmphasis(counts:Map<string,number>){
  const values=[...counts.values()].sort((a,b)=>a-b);
  if(!values.length)return 0;
  const mid=values.length>>1;
  return values.length%2?values[mid]:(values[mid-1]+values[mid])/2;
}
/** A service is emphasised relative to the others when the website carries at
 * least two service claims for it, or strictly more than the median service.
 * One claim per service (the usual draft shape) emphasises nothing, so price
 * and negotiation/escalation questions then stay out of the clarification set. */
const emphasised=(emphasis:number,median:number)=>emphasis>=2||emphasis>median;
/** Tier 1: the website contradicts itself or is ambiguous. Tier 2: authority
 * decisions only the owner can make (authority.*, emergency.fee_authority and
 * the owner's private questions). Tier 3: price and negotiation/escalation
 * conditions of services the site emphasises relative to the others, and owner
 * questions born from the analysis. Tier 4: the rest of the catalogue, never
 * asked by voice in this design. */
function tierOf(item:AgendaItem,emphasis:number,median:number):LiveQuestionTier{
  if(item.source==='contradiction'||item.source==='ambiguity')return 1;
  const serviceTerms=item.coverageRefs.some(ref=>SERVICE_TERMS_REF.test(ref));
  if(item.source==='owner_private_requirement'&&!serviceTerms)return 2;
  if((serviceTerms||item.coverageRefs.some(ref=>PRICE_REF.test(ref)))&&emphasised(emphasis,median))return 3;
  if(item.subject.startsWith('discovery.owner_question.'))return 3;
  return 4;
}

/** Deterministic ranking over existing item metadata (design §4). seedIndex is
 * the position in the canonical catalogue (items then candidate overrides). */
export function rankLiveQuestions(stored:Stored,projection:Projection):Ranked[]{
  const counts=emphasisBySubject(projection),median=medianEmphasis(counts);
  const ranked=getAgendaItems(stored.agenda).map((item,seedIndex)=>({item,seedIndex})).filter(({item})=>unresolved(item)).map(({item,seedIndex})=>{
    const emphasis=counts.get(item.subject)??0;
    return{targetId:item.id,subject:item.subject,questionPt:item.questionPt,tier:tierOf(item,emphasis,median),seedIndex,emphasis,authority:authority(item)};
  });
  ranked.sort((a,b)=>a.tier-b.tier
    ||(a.tier===2?Number(b.authority)-Number(a.authority):0)
    ||(a.tier===2||a.tier===3?b.emphasis-a.emphasis:0)
    ||a.seedIndex-b.seedIndex);
  return ranked.map(({authority:_,...question})=>question);
}

/** Clarification points for one call: tiers 1-3 up to the cap, trimmed from
 * the end while the JSON list exceeds the byte budget. A question that alone
 * exceeds the budget is skipped (it stays pending) instead of emptying the
 * list behind it. No tier-4 fallback: a short list ends the call normally
 * instead of marching the catalogue. */
export function selectLiveQuestions(stored:Stored,projection:Projection,cap=LIVE_QUESTION_CAP,maxBytes=LIVE_QUESTION_BYTES):LiveQuestionPlan{
  const ranked=rankLiveQuestions(stored,projection);
  const tiers:Record<LiveQuestionTier,number>={1:0,2:0,3:0,4:0};
  for(const question of ranked)tiers[question.tier]++;
  const clarification=ranked.filter(question=>question.tier<4);
  const fits=(question:LiveQuestion)=>Buffer.byteLength(JSON.stringify([question.questionPt]))<=maxBytes;
  const questions:LiveQuestion[]=clarification.filter(fits).slice(0,cap).map(({seedIndex:_,emphasis:__,...question})=>question);
  const bytes=()=>Buffer.byteLength(JSON.stringify(questions.map(question=>question.questionPt)));
  let byteLength=bytes();
  while(questions.length&&byteLength>maxBytes){questions.pop();byteLength=bytes();}
  const clarificationPending=clarification.length-questions.length;
  return{questions,clarificationTotal:clarification.length,clarificationPending,continuation:clarificationPending>0,byteLength,tiers};
}
