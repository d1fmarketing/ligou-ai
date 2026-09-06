export interface WorkerSession {
  session_id: string; request_id: string; status: string; offer_sdp: string; answer_sdp: string | null;
  client_connected_at: string | null; provider_call_id: string | null; model: string | null; max_minutes: number; expires_at: string; created_at: string;
  stop_requested: boolean; claim_token: string; lease_expires_at: string; create_intent_at: string | null;
  create_attempts: number; reserved_cost_usd: number; observed_cost_usd: number; usage_state: string;
  provider_termination_state: string; error: string | null;
}
export interface SalesStore {
  heartbeat(workerId: string): Promise<{ enabled: boolean }>;
  claim(workerId: string): Promise<WorkerSession | null>;
  apply(session: WorkerSession, operation: string, payload?: Record<string, unknown>): Promise<WorkerSession>;
}
export function createSalesStore(client: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }> }, options: {timeoutMs?:number} = {}): SalesStore {
  async function rpc(name: string, args: Record<string, unknown>) {
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout = new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('sales_store_timeout')),options.timeoutMs??4000);});
    let result:{data:any;error:any};
    try{result=await Promise.race([Promise.resolve(client.rpc(name,args)),timeout]);}finally{if(timer)clearTimeout(timer);}
    const {data,error}=result;
    if (error) throw new Error(`sales_store_${name}_failed`);
    return data;
  }
  return {
    heartbeat: workerId => rpc('sales_heartbeat',{p_worker_id:workerId}),
    claim: workerId => rpc('sales_claim',{p_worker_id:workerId}),
    async apply(session,operation,payload={}) {
      const result = await rpc('sales_worker_apply',{p_session_id:session.session_id,p_claim_token:session.claim_token,p_operation:operation,p_payload:payload});
      if (!result || result.session_id !== session.session_id || result.claim_token !== session.claim_token) throw new Error('sales_fence_lost');
      return result;
    },
  };
}
