import type {LiveScope} from './onboarding-live-context.ts';

type Credentials={accessToken:string;chatgptAccountId:string;chatgptPlanType?:string};
export interface LiveCodexConnection {
  request(method:string,params:Record<string,unknown>):Promise<any>;
  notify(method:string,params:Record<string,unknown>):void;
  subscribe(handler:(method:string,params:any)=>void):()=>void;
  handleRequests(handler:(method:string,params:any)=>Promise<any>):void;
}
type Context={scope:LiveScope;revision:number;fragments:unknown[];taskState:unknown};
type Options={scope:LiveScope;connection:LiveCodexConnection;credentials:()=>Promise<Credentials>;
  instructions:string;outputSchema:Record<string,unknown>;timeoutMs?:number};

/** Codex 0.154.0 stdio contract. The host owns subscription authentication.
 * No hosted Responses fallback, environment, general tool or shared customer thread.
 * Results are proposals: the caller must validate and execute the business action.
 */
export function createLiveCodexDelegate(options:Options){
  if(options.timeoutMs!==undefined&&(!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0))throw Error('live_backend_deadline_invalid');
  const scope={...options.scope},connection=options.connection;
  let startup:Promise<void>|undefined,threadId:string|undefined,accountId:string|undefined,busy=false;
  const validCredentials=(value:Credentials)=>{
    if(!value.accessToken||!value.chatgptAccountId)throw Error('live_backend_credentials_unavailable');
    if(accountId&&accountId!==value.chatgptAccountId)throw Error('live_backend_account_mismatch');
    return value;
  };
  function start(){
    if(startup)return startup;
    startup=(async()=>{
      connection.handleRequests(async(method,params)=>{
        if(method!=='account/chatgptAuthTokens/refresh')throw Error('live_backend_request_not_allowed');
        if(params.previousAccountId!==accountId)throw Error('live_backend_account_mismatch');
        return validCredentials(await options.credentials());
      });
      await connection.request('initialize',{clientInfo:{name:'ligou_live_delegation',title:'Ligou onboarding',version:'1'},capabilities:{experimentalApi:true}});
      connection.notify('initialized',{});
      const credentials=validCredentials(await options.credentials());accountId=credentials.chatgptAccountId;
      const login=await connection.request('account/login/start',{type:'chatgptAuthTokens',...credentials});
      if(login?.type!=='chatgptAuthTokens')throw Error('live_backend_auth_mode_mismatch');
      const result=await connection.request('thread/start',{
        model:'gpt-6-astra',approvalPolicy:'never',sandbox:'readOnly',environments:[],dynamicTools:[],
        selectedCapabilityRoots:[],ephemeral:true,allowProviderModelFallback:false,
        baseInstructions:options.instructions,serviceName:'ligou_live_onboarding',
        config:{'features.shell_tool':false,'features.unified_exec':false,'features.apps':false,
          'features.multi_agent':false,'agents.enabled':false,web_search:'disabled'},
      });
      if(typeof result?.thread?.id!=='string'||!result.thread.id)throw Error('live_backend_thread_missing');
      threadId=result.thread.id;
    })();
    return startup;
  }
  async function run(context:Context,signal?:AbortSignal){
    if(!['tenantId','interviewId','callId','providerSessionId'].every(k=>context.scope[k as keyof LiveScope]===scope[k as keyof LiveScope]))throw Error('live_backend_scope_mismatch');
    if(!Number.isSafeInteger(context.revision)||context.revision<0||!Array.isArray(context.fragments))throw Error('live_backend_context_invalid');
    if(busy)throw Error('live_backend_busy');
    if(signal?.aborted)throw Error('live_backend_cancelled');
    busy=true;
    try{
      await start();
      if(signal?.aborted)throw Error('live_backend_cancelled');
      const boundThreadId=threadId!;
      return await new Promise<{decision:unknown;threadId:string;turnId:string;billingBasis:'chatgpt_subscription'}>((resolve,reject)=>{
        let turnId:string|undefined,finalText:string|undefined,settled=false;
        const early:{method:string;params:any}[]=[];
        let unsubscribe=()=>{};
        const finish=(error?:Error)=>{
          if(settled)return;settled=true;clearTimeout(timer);unsubscribe();signal?.removeEventListener('abort',cancel);
          if(error){reject(error);return;}
          try{
            if(!turnId||!finalText||Buffer.byteLength(finalText)>65536)throw Error();
            const decision=JSON.parse(finalText);
            if(!decision||typeof decision!=='object'||Array.isArray(decision))throw Error();
            resolve({decision,threadId:boundThreadId,turnId,billingBasis:'chatgpt_subscription'});
          }catch{reject(Error('live_backend_output_invalid'));}
        };
        const interrupt=()=>{if(turnId)void connection.request('turn/interrupt',{threadId:boundThreadId,turnId}).catch(()=>{});};
        const cancel=()=>{interrupt();finish(Error('live_backend_cancelled'));};
        // The session/task owner may supply its existing deadline. Live itself
        // imposes no extra per-delegation timeout and voice must keep flowing.
        const timer=options.timeoutMs===undefined?undefined:setTimeout(()=>{interrupt();finish(Error('live_backend_timeout'));},options.timeoutMs);
        const receive=(method:string,params:any)=>{
          if(settled||params?.threadId!==boundThreadId)return;
          if(method!=='item/completed'&&method!=='turn/completed')return;
          if(!turnId){
            // Do not retain or expose private reasoning or irrelevant tool events.
            if(method==='item/completed'&&params.item?.type!=='agentMessage')return;
            if(early.length>=128){finish(Error('live_backend_event_limit'));return;}
            early.push({method,params});return;
          }
          if(method==='item/completed'&&params.turnId===turnId&&params.item?.type==='agentMessage'
            &&(!params.item.phase||params.item.phase==='final_answer')&&typeof params.item.text==='string')finalText=params.item.text;
          if(method==='turn/completed'&&params.turn?.id===turnId){
            if(params.turn.status!=='completed')finish(Error(params.turn.status==='interrupted'?'live_backend_interrupted':'live_backend_failed'));
            else finish();
          }
        };
        unsubscribe=connection.subscribe(receive);signal?.addEventListener('abort',cancel,{once:true});
        void connection.request('turn/start',{
          threadId:boundThreadId,environments:[],effort:'medium',outputSchema:options.outputSchema,
          input:[{type:'text',text:JSON.stringify(context)}],
        }).then(response=>{
          if(typeof response?.turn?.id!=='string'||!response.turn.id){finish(Error('live_backend_turn_missing'));return;}
          turnId=response.turn.id;
          if(settled){interrupt();return;}
          for(const event of early)receive(event.method,event.params);early.length=0;
          if(signal?.aborted)cancel();
        }).catch(()=>finish(Error('live_backend_start_failed')));
      });
    }finally{busy=false;}
  }
  return{start,run};
}
