import {beforeAll,test,expect} from 'bun:test';
import {createClient} from '@supabase/supabase-js';
import {handleIncoming} from '../src/phone.ts';
import {_setClient} from '../src/rules.ts';
import {handlePhoneWebhook} from '../../supabase/functions/_shared/phone-webhook.ts';
import {persistPhoneEvent} from '../../supabase/functions/_shared/accept-call.ts';
const url=process.env.SUPABASE_URL??'';
if(process.env.LIGOU_LOCAL_PROJECT_ID!=='ligou-v0-1-rc1'||url!=='http://127.0.0.1:54321'||process.env.PGHOST!=='127.0.0.1'||process.env.PGPORT!=='54322')throw Error('first phone integration requires the guarded disposable local stack');
const client=createClient(url,process.env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});_setClient(client);
const key=btoa('01234567890123456789012345678901'),number='+14155550123';let tenantId:string;
async function rpc(name:string,args:any){const{data,error}=await client.rpc(name,args);if(error)throw Error(name+': '+error.message);return data;}
beforeAll(async()=>{
 const seed=crypto.randomUUID();const user=await client.auth.admin.createUser({email:'first-phone-'+seed+'@example.test',password:'QA-'+seed+'aA!9',email_confirm:true});if(user.error)throw user.error;
 tenantId=crypto.randomUUID();const inserted=await client.from('tenants').insert({id:tenantId,slug:'first-phone-'+seed,name:'First Phone Local QA',vertical:'cleaning',owner_user_id:user.data.user.id,status:'active',operational_mode:'simulation_only',daily_budget_usd:15});if(inserted.error)throw inserted.error;
 for(let attempt=0;;attempt++){try{await rpc('configure_first_phone_number',{p_tenant_id:tenantId,p_phone_number:number,p_enabled:true,p_max_minutes:5});break;}catch(error){if(attempt>=30)throw error;await Bun.sleep(300);}}
},20000);
async function incoming(destination=number){
 const id='rtc_first_'+crypto.randomUUID();const text=JSON.stringify({type:'realtime.call.incoming',data:{call_id:id,sip_headers:[{name:'To',value:'sip:'+destination+'@fixture.test'},{name:'From',value:'sip:+14155550124@fixture.test'}]}});const timestamp=String(Math.floor(Date.now()/1000)),webhookId='wh_'+crypto.randomUUID();
 const hmac=await crypto.subtle.importKey('raw',Uint8Array.from(atob(key),c=>c.charCodeAt(0)),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signed=await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(`${webhookId}.${timestamp}.${text}`));
 const request=new Request('http://fixture/accept-call',{method:'POST',headers:{'webhook-id':webhookId,'webhook-timestamp':timestamp,'webhook-signature':'v1,'+btoa(String.fromCharCode(...new Uint8Array(signed)))},body:text});
 const response=await handlePhoneWebhook(request,{webhookSecret:'whsec_'+key,contactHashKey:key,persist:row=>persistPhoneEvent(client,row)});expect(response.status).toBe(200);
 const result=await client.from('phone_events').select('*').eq('openai_call_id',id).single();if(result.error)throw result.error;return result.data;
}
function provider(){const actions:string[]=[],caps:any[]=[];return{actions,caps,options:{fetchImpl:async(input:any,init:any)=>{const target=new URL(String(input));expect(target.origin).toBe('https://api.openai.com');expect(target.pathname).toMatch(/^\/v1\/realtime\/calls\/rtc_first_[a-f0-9-]+\/(accept|reject|hangup)$/);actions.push(target.pathname.split('/').at(-1)!);if(actions.at(-1)==='accept'){const body=JSON.parse(init.body);expect(body.audio.output.voice).toBe('ash');expect(body.audio.input.turn_detection.create_response).toBe(false);}return new Response(null,{status:200});},attachSidebandImpl:(cap:any,_id:any,_model:any,options:any)=>{caps.push(cap);return{opened:rpc('confirm_phone_sideband',{p_event_id:options.phone.eventId,p_claim_token:options.phone.claimToken}).then(value=>{expect(value).toBe(true)}),cancel(){}};}}};}
async function close(row:any){const{data,error}=await client.from('phone_events').select('*').eq('id',row.id).single();if(error)throw error;const args={p_event_id:row.id,p_claim_token:data.lifecycle_claim_token};const intent=await rpc('begin_phone_termination',{...args,p_mode:'hangup',p_reason:'local_test_complete',p_accept_state:'accepted'});expect(intent.should_attempt).toBe(true);await rpc('complete_phone_termination',{...args,p_confirmed:true,p_error:null});}
test('signed webhook reaches the assigned customer, budget reservation and sideband activation',async()=>{
 const row=await incoming(),fake=provider();await handleIncoming({...row,openai_call_id:'forged-payload-id'},fake.options as any);expect(fake.actions).toEqual(['accept']);expect(fake.caps[0].tenantId).toBe(tenantId);expect(fake.caps[0].simulation).toBe(true);expect(fake.caps[0].expiresAt-Date.now()).toBeLessThanOrEqual(300000);
 const{data}=await client.from('phone_events').select('*').eq('id',row.id).single();expect(data.tenant_id).toBe(tenantId);expect(data.lifecycle_state).toBe('active');const reserved=await client.from('budget_reservations').select('status,reserved_cost_usd').eq('call_id',data.call_id).single();expect(reserved.error).toBeNull();expect(reserved.data.status).toBe('active');await close(row);
},20000);
test('unknown destinations reject without a customer call or fallback tenant',async()=>{
 const row=await incoming('+14155550125'),fake=provider();await handleIncoming(row,fake.options as any);expect(fake.actions).toEqual(['reject']);expect(fake.caps).toHaveLength(0);const{data}=await client.from('phone_events').select('tenant_id,call_id,status').eq('id',row.id).single();expect(data.tenant_id).toBeNull();expect(data.call_id).toBeNull();expect(data.status).toBe('rejected');
},20000);
test('two concurrent calls admit only one assigned phone session',async()=>{
 const a=await incoming(),b=await incoming(),fake=provider();await Promise.all([handleIncoming(a,fake.options as any),handleIncoming(b,fake.options as any)]);expect(fake.actions.filter(x=>x==='accept')).toHaveLength(1);expect(fake.actions.filter(x=>x==='reject')).toHaveLength(1);expect(fake.caps).toHaveLength(1);const{data}=await client.from('phone_events').select('*').in('id',[a.id,b.id]);const accepted=data!.find(r=>r.lifecycle_state==='active');expect(accepted).toBeDefined();await close(accepted);
},20000);
