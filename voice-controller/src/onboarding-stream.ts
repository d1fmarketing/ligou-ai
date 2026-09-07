import { speechActionIsInternallyValid, type OnboardingSpeechAction } from './onboarding-speech.ts';

export interface StreamAuthorization {
  schema:'onboarding.stream.v1';action:OnboardingSpeechAction;dispatchId:string;receiptId:string;
}
export interface StreamMediaEvidence {
  schema:'onboarding.stream.media.v1';nonzeroSamples:number;observedMs:number;
  firstSampleAtMs:number;lastSampleAtMs:number;unmuted:true;playbackStarted:true;
}
export interface StreamProof {
  actionId:string;dispatchId:string;responseId:string;itemId:string;
  status:'preparing'|'ready'|'played'|'rejected';generationReceiptId?:string;playoutReceiptId?:string;receiptId?:string;
  reason?:'transcript_mismatch';
}
export const STREAM_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function streamAuthorizationIsValid(value:unknown,action?:OnboardingSpeechAction):value is StreamAuthorization {
  if(!object(value)||!exact(value,['schema','action','dispatchId','receiptId'])||value.schema!=='onboarding.stream.v1'
    ||typeof value.dispatchId!=='string'||!STREAM_UUID.test(value.dispatchId)||typeof value.receiptId!=='string'||!STREAM_UUID.test(value.receiptId)
    ||!speechActionIsInternallyValid(value.action))return false;
  return !action||Object.keys(action).every(key=>value.action[key as keyof OnboardingSpeechAction]===action[key as keyof OnboardingSpeechAction]);
}
export function streamMediaEvidenceIsValid(value:unknown):value is StreamMediaEvidence {
  if(!object(value)||!exact(value,['schema','nonzeroSamples','observedMs','firstSampleAtMs','lastSampleAtMs','unmuted','playbackStarted'])
    ||value.schema!=='onboarding.stream.media.v1'||value.unmuted!==true||value.playbackStarted!==true
    ||!Number.isSafeInteger(value.nonzeroSamples)||Number(value.nonzeroSamples)<1)return false;
  return ['observedMs','firstSampleAtMs','lastSampleAtMs'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)
    &&Number(value.observedMs)<=180_000&&Number(value.lastSampleAtMs)>=Number(value.firstSampleAtMs);
}
export function streamControlId(kind:'notice'|'ready'|'played'|'interrupted'|'retire',dispatchId:string):string {
  if(!STREAM_UUID.test(dispatchId))throw new Error('stream_dispatch_invalid');
  return ({notice:'lsn-',ready:'lsr-',played:'lsp-',interrupted:'lsi-',retire:'lsd-'}[kind])+dispatchId.replaceAll('-','').slice(0,28);
}
export function streamResponseMetadata(stream:StreamAuthorization):Record<string,string>{
  return {ligou_transport:'realtime_stream_v1',ligou_call_id:stream.action.callId,ligou_action_id:stream.action.actionId,
    ligou_source_digest:stream.action.sourceDigest,ligou_dispatch_id:stream.dispatchId};
}
export function streamResponseMatches(metadata:unknown,stream:StreamAuthorization):boolean{
  return object(metadata)&&Object.entries(streamResponseMetadata(stream)).every(([key,value])=>metadata[key]===value);
}

/** Ordered lexical verification, not semantic approval. Only explicit harmless
 * presentation variants are normalized; all remaining values/conditions remain. */
export function normalizeWebsiteStreamTranscript(text:string):string {
  let t=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  t=t.replace(/^\s*(?:(?:claro|certo|perfeito|bem|bom|entao|olha|ok)\s*[,!:.]\s*){1,2}/,'');
  t=t.replace(/^\s*(?:oi|ola)[,!:.\s]+/,'');
  t=t.replace(/\b(?:pra|pras)\b/g,m=>m==='pras'?'para as':'para').replace(/\b(?:pro|pros)\b/g,m=>m==='pros'?'para os':'para').replace(/\bta\b/g,'esta');
  t=t.replace(/^\s*(?:aqui e|sou) (?:o )?ligou\b/,'ligou');
  t=t.replace(/\bem quais cidades\b/g,'quais cidades').replace(/\bquais sao as cidades\b/g,'quais cidades');
  t=t.replace(/\b(?:o|a|os|as) (?=(?:resumo|configuracao|empresa|cidades|horario|horarios)\b)/g,'');
  t=t.replace(/(\d)\s*[–—]\s*(?=\d)/g,'$1-');
  t=t.replace(/([+-])\s+(?=\d)/g,'$1').replace(/(\d)\s+([%°])/g,'$1$2');
  return (t.match(/[+-]?\d+(?:[.,:]\d+)*(?:[%°])?|[\p{L}][\p{L}\p{N}]*|[%$€£<>≤≥=]/gu)??[]).join(' ');
}
export function websiteStreamTranscriptMatches(action:OnboardingSpeechAction,transcript:unknown):boolean {
  return speechActionIsInternallyValid(action)&&typeof transcript==='string'&&transcript.trim().length>0&&transcript.length<=8192
    &&normalizeWebsiteStreamTranscript(action.text)===normalizeWebsiteStreamTranscript(transcript);
}
