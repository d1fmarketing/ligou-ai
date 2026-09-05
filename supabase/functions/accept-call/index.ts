// Signed OpenAI SIP events are durably queued; the controller owns provider actions.
import {createClient} from '@supabase/supabase-js';
import {persistPhoneEvent} from '../_shared/accept-call.ts';
import {handlePhoneWebhook} from '../_shared/phone-webhook.ts';
Deno.serve(req=>handlePhoneWebhook(req,{
 webhookSecret:Deno.env.get('OPENAI_WEBHOOK_SECRET')??'',
 contactHashKey:Deno.env.get('CONTACT_HASH_KEY')??'',
 persist:row=>{
  const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SERVICE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input:RequestInfo|URL,init?:RequestInit)=>fetch(input,{...init,signal:AbortSignal.timeout(4000)})}});
  return persistPhoneEvent(client,row);
 },
}));
