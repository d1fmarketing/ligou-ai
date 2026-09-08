import type {OnboardingAgenda} from './onboarding-agenda.ts';

export interface WebsiteContextTimezone {
  readonly itemId:string;
  readonly timeZone:string;
  readonly origin:'website_configuration'|'location_inference';
  readonly sourceClaimIds:readonly string[];
  readonly evidenceRefs:readonly string[];
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const normal=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const object=(v:unknown):Record<string,any>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:null;
const sorted=(values:readonly string[])=>[...new Set(values)].sort();

/** Intl supplies date-dependent IANA rules, not a geographic lookup. Never
 * convert a fixed UTC offset or an ambiguous abbreviation into a location. */
export function canonicalNamedTimezone(value:unknown):string|null {
  if(typeof value!=='string'||value.length>128||!(/^[A-Za-z_+-]+\/[A-Za-z0-9_+/-]+$/.test(value)||value==='UTC'))return null;
  try{return new Intl.DateTimeFormat('en-US',{timeZone:value}).resolvedOptions().timeZone;}catch{return null;}
}
/** Classifies the stored question's topic, never the owner's answer wording.
 * Compound business-hours questions retain their independent obligations. */
export function isTimezoneQuestion(question:string):boolean {
  return /^(?:qual (?:e )?(?:o )?(?:fuso(?: horario)?|timezone)(?: oficial)?(?: (?:usado|utilizado) para os horarios publicados)?|(?:what|which) (?:is (?:the )?)?time ?zone(?: is used for (?:the )?published hours)?)\??$/.test(normal(question.trim()));
}
export function checkedContextTimezone(value:unknown):WebsiteContextTimezone {
  const v=object(value),keys=['itemId','timeZone','origin','sourceClaimIds','evidenceRefs'];
  if(!v||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k))
    ||typeof v.itemId!=='string'||!v.itemId.trim()||v.itemId.length>512||canonicalNamedTimezone(v.timeZone)===null
    ||!['website_configuration','location_inference'].includes(v.origin)
    ||!['sourceClaimIds','evidenceRefs'].every(k=>Array.isArray(v[k])&&v[k].length>0&&v[k].length<=100
      &&v[k].every((id:unknown)=>typeof id==='string'&&uuid.test(id))&&JSON.stringify(v[k])===JSON.stringify(sorted(v[k]))))throw new Error('Invalid context timezone');
  return Object.freeze({...v,sourceClaimIds:Object.freeze([...v.sourceClaimIds]),evidenceRefs:Object.freeze([...v.evidenceRefs])}) as WebsiteContextTimezone;
}

/** Narrow, documented US/CA inference from the selected website candidate. The
 * actual owner can override it using the retained timezone item's correction ID.
 * No tenant default, browser clock, city allowlist, radius or external geo API. */
export function resolveWebsiteContextTimezone(facts:readonly Record<string,any>[],itemId:string):WebsiteContextTimezone|null {
  const source=(used:readonly Record<string,any>[],timeZone:string,origin:WebsiteContextTimezone['origin'])=>{
    try{return checkedContextTimezone({itemId,timeZone,origin,sourceClaimIds:sorted(used.map(f=>f.claim_id)),evidenceRefs:sorted(used.flatMap(f=>f.evidence_refs??[]))});}catch{return null;}
  };
  const hours=facts.filter(f=>f.claim_type==='business_hours');
  const declared=hours.filter(f=>typeof object(f.value)?.timezone==='string'&&f.value.timezone.trim());
  if(declared.length){
    const zones=declared.map(f=>f.value.timezone as string);
    if(zones.some(z=>canonicalNamedTimezone(z)===null)||new Set(zones).size!==1||declared.some(f=>f.contradiction_status!=='none'
      ||(f.missing_fields??[]).includes('timezone')||(f.ambiguous_fields??[]).includes('timezone')))return null;
    return source(declared,zones[0]!,'website_configuration');
  }
  const clear=(f:Record<string,any>)=>f.contradiction_status==='none'&&Array.isArray(f.missing_fields)&&f.missing_fields.length===0
    &&Array.isArray(f.ambiguous_fields)&&f.ambiguous_fields.length===0&&Array.isArray(f.uncertainty)&&f.uncertainty.length===0;
  const territory=facts.filter(f=>f.claim_type==='service_territory'),addresses=facts.filter(f=>f.claim_type==='public_address');
  if(!territory.length||territory.some(f=>!clear(f)||!object(f.value)||f.value.radius!==null||f.value.service_type!==null
    ||!Array.isArray(f.value.included_areas)||!f.value.included_areas.length||f.value.included_areas.some((a:any)=>!object(a)
      ||a.country_code!=='US'||a.region_state!=='CA'||!['city','county','state'].includes(a.kind)||typeof a.name!=='string'||!a.name.trim())))return null;
  // A conflicting or unparsed address prevents geographic inference. This is a
  // US postal-region consistency check, not a city-to-time-zone map.
  if(addresses.some(f=>!clear(f)||typeof f.value!=='string'||!/,\s*CA\s+\d{5}(?:-\d{4})?(?:,?\s*(?:USA|United States))?\s*$/i.test(f.value)))return null;
  return source([...territory,...addresses],'America/Los_Angeles','location_inference');
}

export function projectWebsiteTimezone(agenda:OnboardingAgenda){
  const items=agenda.items.filter(i=>isTimezoneQuestion(i.questionPt));
  const decisions=items.filter(i=>['answered','corrected'].includes(i.status)&&i.evidence.length>0);
  if(decisions.length===1){
    const item=decisions[0],evidence=item.evidence.at(-1)!;
    return{state:'owner_decision' as const,itemId:item.id,timeZone:canonicalNamedTimezone(evidence.text.trim()),origin:'owner_statement' as const,
      evidence:{...evidence},askTimezone:false};
  }
  if(decisions.length>1)return{state:'unresolved' as const,reason:'multiple_owner_timezone_decisions',askTimezone:true};
  if(agenda.contextTimezone)return{state:'resolved' as const,...agenda.contextTimezone,askTimezone:false};
  return{state:'unresolved' as const,reason:'no_supported_timezone_context',askTimezone:true};
}
export function timezoneContextQuestion(question:string,context:ReturnType<typeof projectWebsiteTimezone>):string {
  if(context.askTimezone)return question;
  return question.replace(/\s+e\s+o\s+fuso\s+hor[aá]rio\b/giu,'').replace(/\s+and\s+(?:the\s+)?time\s*zone\b/giu,'');
}
