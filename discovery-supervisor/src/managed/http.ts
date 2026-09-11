import OpenAI from 'openai';
import { parseWorkerResult } from '../contracts';
import type { ServiceRpcClient } from '../job-store';
import { ManagedDiscoveryStore } from './store';
import { ManagedDiscoveryWorkflow, type ManagedAnalysisClient, type ManagedAnalysisJob } from './workflow';

type QueryResult = {data:unknown;error:unknown};
interface Query extends PromiseLike<QueryResult> {
  select(columns:string):Query; eq(column:string,value:unknown):Query;
  not(column:string,operator:string,value:unknown):Query;
  order(column:string,options:{ascending:boolean}):Query; limit(count:number):Query;
}
export interface ManagedAnalysisProductClient extends ServiceRpcClient {
  auth:{getUser(jwt:string):PromiseLike<{data:{user:{id:string}|null};error:unknown}>};
  from(table:string):{select(columns:string):Query};
}
export class ManagedAnalysisHttpError extends Error {
  constructor(readonly status:number,readonly code:string){super(code);}
}
type OwnedSource={ownerId:string;tenantId:string;sourceJobId:string;sourceResultId:string;inputVersion:string};
export type ManagedAnalysisLaunchPolicy={deadlineAt:string;retentionDeleteAt:string|null};
type Options={
  product:ManagedAnalysisProductClient; provider:ManagedAnalysisClient;
  authorizeLaunch:(job:ManagedAnalysisJob)=>Promise<void>;
  // Deliberately no invented deadline, retention or paid-API allowance defaults.
  resolveLaunchPolicy?:(source:OwnedSource)=>Promise<ManagedAnalysisLaunchPolicy>;
  allowedOrigins?:readonly string[];
  basePath?:string;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash=/^[a-f0-9]{64}$/;
const object=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(status:number,code:string):never=>{throw new ManagedAnalysisHttpError(status,code);};
const exact=(row:Record<string,unknown>,keys:string[])=>Object.keys(row).length===keys.length&&keys.every(key=>Object.hasOwn(row,key));
async function rows(query:PromiseLike<QueryResult>):Promise<Record<string,any>[]> {
  const result=await query;
  if(result.error||!Array.isArray(result.data)||!result.data.every(object))return fail(503,'analysis_source_lookup_failed');
  return result.data;
}
async function requestText(request:Request,maximum:number):Promise<string> {
  if(!request.body)return '';
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;
    if(bytes>maximum){await reader.cancel();fail(413,'analysis_request_too_large');}chunks.push(next.value);}}
  finally{reader.releaseLock();}
  const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder().decode(body);
}
function jobView(job:ManagedAnalysisJob){
  return{jobId:job.job_id,state:job.state,inputVersion:job.input_version,resultId:job.result_id,providerSessionId:job.session_id,
    providerTurnId:job.turn_id,providerStatus:job.provider_status??null,usage:job.usage??null,
    cost:{usd:null,state:'unreconciled',billingBasis:'paid_api'},selectionChangedByThisRequest:false};
}

/** Mount on an existing HTTP host. No listener, worker loop, scheduler or local
 * agent harness is created. Every public business request verifies the owner JWT. */
export function createManagedAnalysisHttpHandler(options:Options){
  const base=(options.basePath??'/managed-analysis').replace(/\/$/,'');
  if(!base.startsWith('/')||base==='')throw Error('managed_analysis_base_path_invalid');
  const store=new ManagedDiscoveryStore(options.product),workflow=new ManagedDiscoveryWorkflow({client:options.provider,store,authorizeLaunch:options.authorizeLaunch});
  async function ownerTenant(request:Request){
    const auth=request.headers.get('authorization');
    if(!auth?.startsWith('Bearer ')||!auth.slice(7).trim())return fail(401,'authentication_required');
    const verified=await options.product.auth.getUser(auth.slice(7));
    if(verified.error||!verified.data.user||!uuid.test(verified.data.user.id))return fail(401,'authentication_required');
    const ownerId=verified.data.user.id;
    const tenants=await rows(options.product.from('tenants').select('id,owner_user_id').eq('owner_user_id',ownerId).limit(2));
    if(tenants.length!==1||tenants[0]!.owner_user_id!==ownerId||!uuid.test(tenants[0]!.id))return fail(403,'owner_tenant_ambiguous');
    return{ownerId,tenantId:tenants[0]!.id as string};
  }
  async function selectedSource(owner:{ownerId:string;tenantId:string}):Promise<OwnedSource>{
    const jobs=await rows(options.product.from('worker_jobs').select('id,tenant_id,selected_attempt_id')
      .eq('tenant_id',owner.tenantId).not('selected_attempt_id','is',null).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1));
    const job=jobs[0];
    if(!job||job.tenant_id!==owner.tenantId||!uuid.test(job.id)||!uuid.test(job.selected_attempt_id))return fail(409,'selected_source_unavailable');
    const attempts=await rows(options.product.from('worker_attempts').select('id,tenant_id,job_id,status,result_id')
      .eq('id',job.selected_attempt_id).eq('job_id',job.id).eq('tenant_id',owner.tenantId).limit(1));
    const attempt=attempts[0];
    if(!attempt||attempt.status!=='selected'||!uuid.test(attempt.result_id))return fail(409,'selected_source_unavailable');
    const results=await rows(options.product.from('worker_results').select('id,tenant_id,job_id,attempt_id,result_hash,validation_state')
      .eq('id',attempt.result_id).eq('tenant_id',owner.tenantId).eq('job_id',job.id).eq('attempt_id',attempt.id).limit(1));
    const result=results[0];
    if(!result||result.validation_state!=='validated'||!hash.test(result.result_hash))return fail(409,'selected_source_unavailable');
    return{...owner,sourceJobId:job.id,sourceResultId:result.id,inputVersion:result.result_hash};
  }
  return async(request:Request):Promise<Response>=>{
    const url=new URL(request.url),origin=request.headers.get('origin');
    const cors:Record<string,string>=origin&&(origin===url.origin||options.allowedOrigins?.includes(origin))?{'Access-Control-Allow-Origin':origin,Vary:'Origin'}:{};
    const send=(body:unknown,status=200)=>Response.json(body,{status,headers:{...cors,'Cache-Control':'no-store'}});
    if(origin&&!Object.hasOwn(cors,'Access-Control-Allow-Origin'))return send({ok:false,code:'origin_not_allowed'},403);
    if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return send({ok:false,code:'not_found'},404);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...cors,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'authorization, content-type','Cache-Control':'no-store'}});
    try{
      const suffix=url.pathname.slice(base.length);
      if(suffix==='/webhook'){
        if(request.method!=='POST')return send({ok:false,code:'method_not_allowed'},405);
        const payload=await requestText(request,256*1024);
        let job;
        try{job=await workflow.webhook(payload,request.headers);}catch(cause){
          if(cause instanceof Error&&/signature|webhook secret|timestamp/i.test(cause.message))return send({ok:false,code:'webhook_verification_failed'},400);
          throw cause;
        }
        return send({ok:true,observed:job!==null});
      }
      const owner=await ownerTenant(request);
      if((suffix===''||suffix==='/')&&request.method==='POST'){
        if(!options.resolveLaunchPolicy)return send({ok:false,code:'managed_analysis_policy_not_configured'},503);
        let body;try{body=JSON.parse(await requestText(request,4096));}catch(cause){if(cause instanceof ManagedAnalysisHttpError)throw cause;return fail(400,'invalid_analysis_request');}
        if(!object(body)||!exact(body,['requestId'])||typeof body.requestId!=='string'||!uuid.test(body.requestId))return fail(400,'invalid_analysis_request');
        const source=await selectedSource(owner),policy=await options.resolveLaunchPolicy(source);
        const job=await store.prepare({tenantId:owner.tenantId,sourceResultId:source.sourceResultId,inputVersion:source.inputVersion,
          idempotencyKey:body.requestId,deadlineAt:policy.deadlineAt,retentionDeleteAt:policy.retentionDeleteAt});
        try{return send({ok:true,job:jobView(await workflow.launch({jobId:job.job_id,tenantId:owner.tenantId}))},202);}
        catch(cause){
          const current=await store.read({jobId:job.job_id,tenantId:owner.tenantId});
          if(current.state==='launching'||current.session_id)return send({ok:true,outcome:'observation_pending',job:jobView(current)},202);
          if(cause instanceof ManagedAnalysisHttpError)return send({ok:false,code:cause.code,job:jobView(current)},cause.status);
          return send({ok:false,code:'analysis_launch_unavailable',job:jobView(current)},503);
        }
      }
      const match=/^\/([^/]+)(?:\/(reconcile|cancel|result))?$/.exec(suffix);
      if(!match||!uuid.test(match[1]!))return send({ok:false,code:'not_found'},404);
      const identity={jobId:match[1]!,tenantId:owner.tenantId};
      // Resolve ownership in the database before any provider observation/cancellation.
      let job;try{job=await store.read(identity);}catch(cause){
        if(object(cause)&&object(cause.cause)&&cause.cause.message==='managed_analysis_job_not_found')return send({ok:false,code:'analysis_job_not_found'},404);
        return send({ok:false,code:'analysis_temporarily_unavailable'},503);
      }
      if(!match[2]&&request.method==='GET')return send({ok:true,job:jobView(job)});
      if(match[2]==='result'&&request.method==='GET'){
        if(job.state!=='completed'||!job.result_id)return send({ok:false,code:'analysis_result_not_ready',job:jobView(job)},409);
        const results=await rows(options.product.from('worker_results').select('id,job_id,tenant_id,attempt_id,result_schema,validation_state,candidate_result')
          .eq('id',job.result_id).eq('tenant_id',owner.tenantId).eq('job_id',job.job_id).eq('attempt_id',job.attempt_id).limit(1));
        const result=results[0];
        if(!result||result.validation_state!=='validated'||result.result_schema!=='company_discovery.result.v2')return fail(409,'analysis_result_not_ready');
        return send({ok:true,job:jobView(job),result:parseWorkerResult(result.candidate_result),authority:{rulesApproved:false,powersGranted:false}});
      }
      if((match[2]==='reconcile'||match[2]==='cancel')&&request.method==='POST'){
        const body=await requestText(request,4096);if(body.trim()&&body.trim()!=='{}')return fail(400,'invalid_analysis_request');
        job=match[2]==='reconcile'?await workflow.reconcile(identity):await workflow.cancel(identity);
        return send({ok:true,job:jobView(job)},job.state==='completed'||job.state==='cancelled'||job.state==='failed'?200:202);
      }
      return send({ok:false,code:'method_not_allowed'},405);
    }catch(cause){
      if(cause instanceof ManagedAnalysisHttpError)return send({ok:false,code:cause.code},cause.status);
      // Never send provider, SQL or authentication error bodies to the browser.
      return send({ok:false,code:'analysis_temporarily_unavailable'},503);
    }
  };
}

/** The existing host can compose this without adding OpenAI to its own package.
 * The API key stays in this server-only SDK client and is never returned. */
export function createManagedAnalysisHttpService(options:Omit<Options,'provider'>&{apiKey:string;webhookSecret?:string}){
  const {apiKey,webhookSecret,...rest}=options;
  return createManagedAnalysisHttpHandler({...rest,provider:new OpenAI({apiKey,...(webhookSecret?{webhookSecret}:{})})});
}
