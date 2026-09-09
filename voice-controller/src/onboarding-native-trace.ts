import {createHash} from 'node:crypto';

export type NativeTraceDirection='inbound'|'outbound';
export interface NativeTraceTransportInfo {socketAttempt?:number;sendOutcome?:'socket_queued'|'send_failed'}
const inbound=new Set(['session.created','session.updated','session.ended','input_audio_buffer.speech_started','input_audio_buffer.speech_stopped',
 'input_audio_buffer.committed','input_audio_buffer.cleared','conversation.item.added','conversation.item.created','conversation.item.done','conversation.item.truncated',
 'conversation.item.input_audio_transcription.completed','conversation.item.input_audio_transcription.failed','response.created','response.done',
 'response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done','response.function_call_arguments.done',
 'response.output_audio.done','response.output_audio_transcript.done','output_audio_buffer.started','output_audio_buffer.stopped','output_audio_buffer.cleared','error']);
const outbound=new Set(['session.update','response.create','response.cancel','output_audio_buffer.clear','conversation.item.create']);
const names=['submit_website_interview_proposal','approve_website_interview'];
const statuses=['in_progress','completed','cancelled','failed','incomplete'];
const types=['message','function_call','function_call_output','reasoning'];
const contentTypes=['input_text','input_audio','output_text','audio','output_audio'];
const codes=new Set(['response_cancel_not_active','conversation_already_has_active_response','input_audio_buffer_commit_empty','invalid_value','invalid_request_error',
 'server_error','rate_limit_exceeded','insufficient_quota','model_not_found','not_found','conversation_item_not_found','audio_unintelligible',
 'owner_input_unavailable','draft_version_changed','proposal_not_admitted','proposal_content_missing','proposal_content_invalid','native_operation_unconfirmed',
 'amendment_not_admitted','approval_not_admitted','invalid_tool_arguments','unknown_tool','operation_unconfirmed','owner_evidence_unavailable']);
const allowed=(value:unknown,values:readonly string[])=>typeof value==='string'&&values.includes(value)?value:null;
const secretLike=(value:string)=>/(?:^|[.\s:_])(?:sk-|sk_(?:live|test)_|rk_(?:live|test)_|ek_|sb_secret_|github_pat_|gh[pousr]_|xox[baprs]-|bearer(?:[\s:_-]|$))/i.test(value)
 ||/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/.test(value);
export const safeNativeTraceId=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,256}$/.test(value)&&!secretLike(value)?value:null;
const id=safeNativeTraceId;
const errorParam=(value:unknown)=>typeof value==='string'&&value.length<=256&&!secretLike(value)
 &&/^[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,6}\])?(?:\.[A-Za-z0-9_]+(?:\[\d{1,6}\])?)*$/.test(value)?value:null;
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)?value:null;
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
const number=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const boolean=(value:unknown)=>typeof value==='boolean'?value:null;
const code=(value:unknown)=>typeof value==='string'&&codes.has(value)?value:null;
const object=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value:{};
const textHash=(value:unknown)=>typeof value==='string'&&value.length<=1_048_576?createHash('sha256').update(value).digest('hex'):null;
function itemShape(value:any){
 const item=object(value),content=Array.isArray(item.content)?item.content:null;
 return{itemId:id(item.id),itemType:allowed(item.type,types),role:allowed(item.role,['system','user','assistant']),status:allowed(item.status,statuses),
  toolCallId:id(item.call_id),toolName:allowed(item.name,names),contentCount:content?.length??null,
  contentTypes:content?.slice(0,8).map(part=>allowed(part?.type,contentTypes))??null,contentTruncated:content?content.length>8:false};
}
function configuration(value:any){
 const session=object(value),input=session.audio?.input,vad=input?.turn_detection,transcription=input?.transcription,languages=transcription?.languages;
 return{model:allowed(session.model,['gpt-realtime','gpt-realtime-2.1','gpt-realtime-2.1-mini']),
  outputVoice:allowed(session.audio?.output?.voice,['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar']),
  reasoningEffort:allowed(session.reasoning?.effort,['minimal','low','medium','high','xhigh']),
  transcriptionModel:allowed(transcription?.model,['gpt-live-transcribe','gpt-4o-transcribe','gpt-4o-mini-transcribe','whisper-1']),
  languages:Array.isArray(languages)&&languages.length<=8&&languages.every(x=>typeof x==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(x))?[...languages]:null,
  vadType:allowed(vad?.type,['semantic_vad','server_vad']),vadEagerness:allowed(vad?.eagerness,['auto','low','medium','high']),
  createResponse:boolean(vad?.create_response),interruptResponse:boolean(vad?.interrupt_response),
  noiseReduction:allowed(input?.noise_reduction?.type,['near_field','far_field']),instructionsSha256:textHash(session.instructions)};
}
function toolResult(output:unknown){
 if(typeof output!=='string'||output.length>65536)return{parsed:false};
 try{
  const value=object(JSON.parse(output));
  return{parsed:true,saved:boolean(value.saved),replayed:boolean(value.replayed),operationApplied:boolean(value.operationApplied),approved:boolean(value.approved),
   amendmentRequested:boolean(value.amendmentRequested),approvalPreserved:boolean(value.approvalPreserved),code:code(value.code),
   savedReceiptId:uuid(value.savedReceiptId),approvalReceiptId:uuid(value.approvalReceiptId),savedRevision:number(value.savedRevision),revision:number(value.revision),
   digest:digest(value.digest),sourceItemId:id(value.sourceItemId),state:allowed(value.context?.state,['unfinished','reviewing','closing','complete'])};
 }catch{return{parsed:false};}
}
/** Fixed metadata projection only. Never serialize the supplied event or content. */
export function projectNativeTraceEvent(direction:NativeTraceDirection,value:unknown):Record<string,unknown>|null{
 if(direction!=='inbound'&&direction!=='outbound')return null;
 const event=object(value);if(!(direction==='inbound'?inbound:outbound).has(event.type))return null;
 const response=object(event.response),details=object(response.status_details),item=object(event.item),metadata=object(response.metadata);
 const result:Record<string,unknown>={eventType:event.type,providerEventId:direction==='inbound'?id(event.event_id):null,
  clientEventId:direction==='outbound'?id(event.event_id):id(event.error?.event_id),responseId:id(event.response_id??response.id),
  itemId:id(event.item_id??item.id),toolCallId:id(event.call_id??item.call_id),previousItemId:id(event.previous_item_id),
  nativeRequestId:uuid(metadata.native_request_id),checkpoint:allowed(metadata.native_checkpoint,['review','signoff']),
  budgetPause:metadata.native_budget_pause==='true',status:allowed(response.status??item.status,statuses),
  statusDetailsType:allowed(details.type,statuses),statusReason:allowed(details.reason,['turn_detected','client_cancelled','max_output_tokens','content_filter']),
  errorCode:code(event.error?.code??details.error?.code),errorParam:errorParam(event.error?.param??details.error?.param),outputIndex:number(event.output_index),contentIndex:number(event.content_index),
  audioStartMs:number(event.audio_start_ms),audioEndMs:number(event.audio_end_ms)};
 if(event.type.startsWith('session.')){result.providerSessionId=id(event.session?.id);result.sessionConfig=configuration(event.session);}
 if(event.type==='response.create')Object.assign(result,{modalities:Array.isArray(response.output_modalities)?response.output_modalities.slice(0,2).map(x=>allowed(x,['audio','text'])):null,
  toolsSpecified:Object.hasOwn(response,'tools'),toolCount:Array.isArray(response.tools)?response.tools.length:null,
  toolChoice:allowed(response.tool_choice,['auto','none','required']),toolChoiceSpecified:Object.hasOwn(response,'tool_choice'),
  maxOutputTokens:response.max_output_tokens==='inf'?'inf':number(response.max_output_tokens),instructionsSha256:textHash(response.instructions)});
 if(Array.isArray(response.output))Object.assign(result,{outputCount:response.output.length,outputItems:response.output.slice(0,16).map(itemShape),outputTruncated:response.output.length>16});
 if(event.item)result.item=itemShape(item);
 if(event.part)result.partType=allowed(event.part.type,contentTypes);
 if(event.type==='response.function_call_arguments.done')Object.assign(result,{toolName:allowed(event.name,names),argumentChars:typeof event.arguments==='string'?event.arguments.length:null,argumentsSha256:textHash(event.arguments)});
 if(typeof event.transcript==='string')Object.assign(result,{transcriptChars:event.transcript.length,transcriptSha256:textHash(event.transcript)});
 if(item.type==='function_call_output')result.toolResult=toolResult(item.output);
 if(item.role==='system'&&item.type==='message'&&Array.isArray(item.content)&&item.content.length===1&&item.content[0]?.type==='input_text'){
  const text=item.content[0].text;
  if(typeof text==='string')for(const [prefix,kind] of [['ligou.website_native_ready:','native_ready'],['ligou.website_native_played:','native_played'],['ligou.website_stop:','website_stop'],['ligou.website_native:','native_context']])if(text.startsWith(prefix))result.controlKind=kind;
 }
 return result;
}
