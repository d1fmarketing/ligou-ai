// Dedicated entry: bun run src/sales/server.ts. Never imports server.ts or starts customer workers.
import {createClient} from '@supabase/supabase-js';
import {config} from '../config.ts';
import {createSalesStore} from './store.ts';
import {salesWorkerLoop} from './worker.ts';
if(import.meta.main){
 if(process.env.LIGOU_SALES_ENABLED!=='1')throw new Error('sales_runtime_disabled');
 if(!config.openaiKey)throw new Error('sales_voice_key_missing');
 const client=createClient(config.supabaseUrl,config.supabaseSecretKey,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(4000)})}});
 const store=createSalesStore(client),abort=new AbortController();
 process.once('SIGTERM',()=>abort.abort());process.once('SIGINT',()=>abort.abort());
 const workerId=`sales-${crypto.randomUUID()}`;
 // No inbound route or open port: Edge uses durable queue and runtime heartbeat.
 console.info('sales_worker_started');
 await salesWorkerLoop(store,workerId,abort.signal);
}
