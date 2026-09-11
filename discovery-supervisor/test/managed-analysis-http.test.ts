import {describe,expect,test} from 'bun:test';
import {createManagedAnalysisHttpHandler,createManagedAnalysisHttpService,ManagedAnalysisHttpError,type ManagedAnalysisProductClient} from '../src/managed/http';
import {managedAnalysisRequest,type ManagedAnalysisClient,type ManagedAnalysisJob} from '../src/managed/workflow';
const id=(n:number)=>`ac000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner=id(1),tenant=id(2),sourceJob=id(3),sourceAttempt=id(4),sourceResult=id(5),managedJob=id(6),managedAttempt=id(7),requestId=id(8);
const source={url:'https://example.com/',retrieved_at:'2026-09-10T00:00:00.000Z',http_status:200,mime_type:'text/html' as const,byte_length:16,content_hash:'a'.repeat(64),excerpt:'Example Plumbing',crawl_order:0,crawl_depth:0};
const output={company:{name:null,description:null,public_phone:null,public_email:null,public_address:null},services:[],public_prices_and_conditions:[],service_area:[],business_hours:null,guarantees:[],booking_restrictions:[],emergency_and_safety:[],missing_questions:['Quais condições precisam ser confirmadas?'],contradictions:[]};
const finalResult={schema_version:'company_discovery.result.v2',source_snapshots:[source],candidate_facts:[],missing_questions:output.missing_questions,contradictions:[],uncertainty:[]};
async function* stream<T>(values:T[]){yield* values;}
function fixture(options:{invalidAuth?:boolean;ambiguousOwner?:boolean;noPolicy?:boolean;denyBudget?:boolean;lostCreate?:boolean;invalidSignature?:boolean}={}){
  let job:ManagedAnalysisJob|undefined,creates=0,providerReads=0,cancels=0;const rpcCalls:any[]=[],queries:any[]=[],authTokens:string[]=[];
  let providerStatus='in_progress';
  const data:Record<string,any[]>={
    tenants:[{id:tenant,owner_user_id:owner},...(options.ambiguousOwner?[{id:id(99),owner_user_id:owner}]:[])],
    worker_jobs:[{id:sourceJob,tenant_id:tenant,selected_attempt_id:sourceAttempt}],
    worker_attempts:[{id:sourceAttempt,tenant_id:tenant,job_id:sourceJob,status:'selected',result_id:sourceResult}],
    worker_results:[{id:sourceResult,tenant_id:tenant,job_id:sourceJob,attempt_id:sourceAttempt,result_hash:'b'.repeat(64),validation_state:'validated'}],
  };
  const product={
    auth:{getUser:async(token:string)=>{authTokens.push(token);return{data:{user:options.invalidAuth?null:{id:owner}},error:null};}},
    from(table:string){
      let selected=[...(data[table]??[])];const log={table,filters:[] as any[]};queries.push(log);
      const query:any={select:()=>query,eq:(key:string,value:unknown)=>{log.filters.push([key,value]);selected=selected.filter(row=>row[key]===value);return query;},
        not:(key:string,_:string,value:unknown)=>{selected=selected.filter(row=>row[key]!==value);return query;},order:()=>query,limit:(n:number)=>{selected=selected.slice(0,n);return query;},
        then:(resolve:Function)=>Promise.resolve({data:selected,error:null}).then(value=>resolve(value))};return query;
    },
    async rpc(name:string,args:any){
      rpcCalls.push({name,args});
      if(name==='find_company_discovery_managed_session')return{data:job?.session_id===args.p_session_id?job:null,error:null};
      if(name!=='company_discovery_managed_job')throw Error('legacy RPC forbidden');
      if(args.p_action==='prepare'){
        expect(args.p_job_id).toBe(sourceResult);expect(args.p_tenant_id).toBe(tenant);expect(args.p_payload.input_version).toBe('b'.repeat(64));
        job??={job_id:managedJob,tenant_id:tenant,attempt_id:managedAttempt,input_version:'b'.repeat(64),state:'prepared',session_id:null,turn_id:null,result_id:null,created_at:'2026-09-10T00:00:00Z',source_snapshots:[source]};
      }else if(!job||args.p_job_id!==job.job_id||args.p_tenant_id!==tenant)return{data:null,error:{message:'managed_analysis_job_not_found'}};
      if(args.p_action==='claim'){const claimed=job!.state==='prepared';if(claimed)job!.state='launching';return{data:{claimed,job},error:null};}
      if(args.p_action==='bind'){job!.session_id=args.p_payload.session_id;job!.state='running';}
      if(args.p_action==='cancel'){job!.state='cancel_requested';}
      if(args.p_action==='observe'){
        Object.assign(job!,{state:args.p_payload.observation.state,turn_id:args.p_payload.observation.turn_id,provider_status:args.p_payload.observation.provider_status});
        if(args.p_payload.result){job!.result_id=id(10);data.worker_results!.push({id:job!.result_id,tenant_id:tenant,job_id:managedJob,attempt_id:managedAttempt,result_schema:'company_discovery.result.v2',validation_state:'validated',candidate_result:args.p_payload.result});}
      }
      return{data:structuredClone(job),error:null};
    },
  } as ManagedAnalysisProductClient;
  const session=()=>({id:'session-one',metadata:managedAnalysisRequest(job!).metadata,agent:{model:'gpt-5.6-terra'},environment:{type:'none'},status:providerStatus==='completed'?'idle':'in_progress',usage:null,required_actions:[],error:null,created_at:Date.parse(job!.created_at)/1000});
  const provider={beta:{agents:{sessions:{
    create:async()=>{creates++;if(options.lostCreate)throw Error('lost create response');return session();},
    retrieve:async()=>{providerReads++;return session();},list:()=>stream([session()]),
    turns:{list:()=>stream([{id:'turn-one',session_id:'session-one',subagent_id:null,status:providerStatus,usage:null,error:null}])},
    items:{list:()=>stream([{id:'item-one',type:'message',role:'assistant',phase:'final_answer',turn_id:'turn-one',status:'completed',content:[{type:'output_text',text:JSON.stringify(output)}]}])},
    events:{create:async()=>{cancels++;providerStatus='cancelled';}},
  }}},webhooks:{verifySignature:async()=>{if(options.invalidSignature)throw Error('invalid signature');}}} as unknown as ManagedAnalysisClient;
  const handle=createManagedAnalysisHttpHandler({product,provider,allowedOrigins:['https://dashboard.example'],
    authorizeLaunch:async()=>{if(options.denyBudget)throw new ManagedAnalysisHttpError(402,'existing_api_allowance_exhausted');},
    ...(options.noPolicy?{}:{resolveLaunchPolicy:async()=>({deadlineAt:'2026-10-01T00:00:00Z',retentionDeleteAt:null})}),
  });
  const request=(suffix='',method='POST',body?:unknown,extra:Record<string,string>={})=>handle(new Request('https://host.example/managed-analysis'+suffix,{method,
    headers:{authorization:'Bearer authenticated-fixture',origin:'https://dashboard.example',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return{request,product,counts:()=>({creates,providerReads,cancels}),rpcCalls,queries,authTokens,job:()=>job,data,complete:()=>{providerStatus='completed';}};
}

describe('managed analysis product HTTP entrypoints',()=>{
  test('verified owner resolves tenant and selected source before starting one managed analysis',async()=>{
    const f=fixture();const response=await f.request('','POST',{requestId});expect(response.status).toBe(202);
    const body=await response.json();expect(body.job).toMatchObject({jobId:managedJob,state:'running',inputVersion:'b'.repeat(64),providerSessionId:'session-one',selectionChangedByThisRequest:false});
    expect(body.job).not.toHaveProperty('source_snapshots');expect(f.authTokens).toEqual(['authenticated-fixture']);expect(f.counts().creates).toBe(1);
    expect(f.queries.find(q=>q.table==='tenants').filters).toContainEqual(['owner_user_id',owner]);
    expect(f.rpcCalls.some(c=>/direct_model|subscription|claim_company_discovery_attempt/.test(c.name))).toBe(false);
  });
  test('rejects payload-authored tenant, source, model or spend configuration',async()=>{
    const f=fixture();for(const extra of [{tenantId:id(99)},{sourceResultId:id(99)},{model:'gpt-6-astra'},{maxUsd:100}])expect((await f.request('','POST',{requestId,...extra})).status).toBe(400);
    expect(f.counts().creates).toBe(0);expect(f.rpcCalls).toHaveLength(0);
  });
  test('authentication failure and ambiguous owned tenant do not reach provider or writes',async()=>{
    for(const options of [{invalidAuth:true},{ambiguousOwner:true}]){const f=fixture(options);expect((await f.request('','POST',{requestId})).status).toBe(options.invalidAuth?401:403);expect(f.counts().creates).toBe(0);expect(f.rpcCalls).toHaveLength(0);}
  });
  test('missing explicit launch policy leaves mission uncreated',async()=>{
    const f=fixture({noPolicy:true});const response=await f.request('','POST',{requestId});expect(response.status).toBe(503);expect((await response.json()).code).toBe('managed_analysis_policy_not_configured');expect(f.rpcCalls).toHaveLength(0);
  });
  test('host composition uses installed SDK and remains safely unavailable without a launch policy',async()=>{
    const f=fixture();const handle=createManagedAnalysisHttpService({product:f.product,apiKey:'unused-local-fixture',authorizeLaunch:async()=>undefined});
    const result=await handle(new Request('https://host.example/managed-analysis',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({requestId})}));
    expect(result.status).toBe(503);expect(f.rpcCalls).toHaveLength(0);
  });
  test('existing spend authority rejection retains prepared job without paid create',async()=>{
    const f=fixture({denyBudget:true});const response=await f.request('','POST',{requestId});expect(response.status).toBe(402);expect((await response.json()).job.state).toBe('prepared');expect(f.counts().creates).toBe(0);
  });
  test('repeating same authorized request recovers one mission',async()=>{
    const f=fixture();await f.request('','POST',{requestId});await f.request('','POST',{requestId});expect(f.counts().creates).toBe(1);
  });
  test('lost create response returns the durable job ID for reconciliation without retrying create',async()=>{
    const f=fixture({lostCreate:true});const initial=await(await f.request('','POST',{requestId})).json();expect(initial).toMatchObject({outcome:'observation_pending',job:{jobId:managedJob,state:'launching'}});
    await f.request(`/${managedJob}/reconcile`,'POST',{});expect(f.counts().creates).toBe(1);expect(f.job()!.session_id).toBe('session-one');
  });
  test('job GET is read-only and cross-tenant/unknown job IDs cannot observe or cancel provider work',async()=>{
    const f=fixture();await f.request('','POST',{requestId});const previous=f.counts().providerReads;
    expect((await f.request(`/${managedJob}`,'GET')).status).toBe(200);expect(f.counts().providerReads).toBe(previous);
    expect((await f.request(`/${id(99)}/cancel`,'POST',{})).status).toBe(404);expect(f.counts().cancels).toBe(0);
  });
  test('completed report is returned in the existing consumer contract without selecting or approving it',async()=>{
    const f=fixture();await f.request('','POST',{requestId});f.complete();await f.request(`/${managedJob}/reconcile`,'POST',{});
    const response=await f.request(`/${managedJob}/result`,'GET');expect(response.status).toBe(200);const body=await response.json();
    expect(body.result).toEqual(finalResult);expect(body.authority).toEqual({rulesApproved:false,powersGranted:false});
    expect(f.data.worker_jobs![0]!.selected_attempt_id).toBe(sourceAttempt);expect(f.rpcCalls.some(c=>c.name==='select_company_discovery_result')).toBe(false);
  });
  test('cancels only the owned provider session and records terminal state',async()=>{
    const f=fixture();await f.request('','POST',{requestId});const response=await f.request(`/${managedJob}/cancel`,'POST',{});expect(response.status).toBe(200);expect((await response.json()).job.state).toBe('cancelled');expect(f.counts().cancels).toBe(1);
  });
  test('invalid signed webhook cannot reach provider observation',async()=>{
    const f=fixture({invalidSignature:true});const response=await f.request('/webhook','POST',{id:'evt',type:'agent.session.idle',data:{id:'session-one'}});
    expect(response.status).toBe(400);expect(f.counts().providerReads).toBe(0);
  });
  test('origin and request size checks happen before mission creation',async()=>{
    const f=fixture();expect((await f.request('','POST',{requestId},{origin:'https://foreign.example'})).status).toBe(403);
    expect((await f.request('','POST',{requestId:'x'.repeat(5000)})).status).toBe(413);expect(f.counts().creates).toBe(0);
  });
});
