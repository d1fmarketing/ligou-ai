#!/usr/bin/env node
import {pathToFileURL}from'node:url';
const sid=(prefix,value)=>new RegExp('^'+prefix+'[a-fA-F0-9]{32}$').test(value);
const uuid=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const number=value=>/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(value);
export function createFirstPhonePlan(env={}){
 const keys=['LIGOU_TWILIO_ACCOUNT_SID','LIGOU_OPENAI_PROJECT_ID','LIGOU_PHONE_TENANT_ID','LIGOU_SUPABASE_URL'];
 const missing=keys.filter(key=>!env[key]);
 const validators={LIGOU_TWILIO_ACCOUNT_SID:v=>sid('AC',v),LIGOU_OPENAI_PROJECT_ID:v=>/^proj_[a-zA-Z0-9_-]{1,100}$/.test(v),LIGOU_PHONE_TENANT_ID:uuid,LIGOU_SUPABASE_URL:v=>/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(v),LIGOU_PHONE_NUMBER:number,LIGOU_TWILIO_TRUNK_SID:v=>sid('TK',v),LIGOU_PHONE_AREA_CODE:v=>/^[2-9]\d{2}$/.test(v)};
 for(const[key,validate]of Object.entries(validators))if(env[key]&&!validate(env[key]))throw Error('invalid_'+key);
 const result={status:missing.length?'configuration_needed':'plan_ready',missing,purchase_performed:false,traffic_activated:false,direction:'inbound',required_secret_names:['LIGOU_TWILIO_API_KEY_SID + LIGOU_TWILIO_API_KEY_SECRET (or LIGOU_TWILIO_AUTH_TOKEN)','OPENAI_WEBHOOK_SECRET','SERVICE_KEY','CONTACT_HASH_KEY'],remaining_proofs:['phone backend release installed','OpenAI webhook registered and signature verified','pilot business approved','carrier call accepted and terminated']};
 if(missing.length)return result;
 return {...result,account_sid:env.LIGOU_TWILIO_ACCOUNT_SID,tenant_id:env.LIGOU_PHONE_TENANT_ID,phone_number:env.LIGOU_PHONE_NUMBER||null,trunk_sid:env.LIGOU_TWILIO_TRUNK_SID||null,area_code:env.LIGOU_PHONE_AREA_CODE||null,sip_uri:`sip:${env.LIGOU_OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls`,webhook_url:env.LIGOU_SUPABASE_URL.replace(/\/$/,'')+'/functions/v1/accept-call',webhook_event:'realtime.call.incoming',trunk_settings:{secure:true,recording:'do-not-record',transfer_mode:'disable-all'},binding:env.LIGOU_PHONE_NUMBER?{rpc:'configure_first_phone_number',arguments:{p_tenant_id:env.LIGOU_PHONE_TENANT_ID,p_phone_number:env.LIGOU_PHONE_NUMBER,p_enabled:false,p_max_minutes:5},executable:true}:null};
}
async function readJson(url,authorization,fetchImpl){
 const controller=new AbortController();let timer;
 try{return await Promise.race([(async()=>{const response=await fetchImpl(url,{method:'GET',headers:{Authorization:authorization},redirect:'error',signal:controller.signal});if(!response.ok)throw Error('twilio_http_'+response.status);const text=await response.text();if(text.length>262144)throw Error('twilio_response_too_large');return JSON.parse(text);})(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('twilio_timeout'))},6000)})]);}
 finally{if(timer)clearTimeout(timer);controller.abort();}
}
export async function inspectFirstPhone(env={},fetchImpl=fetch){
 const plan=createFirstPhonePlan(env),report={...plan,provider_configuration_matches:false,carrier_call_verified:false,findings:[]};
 if(plan.status!=='plan_ready')return report;
 try{
  let login=plan.account_sid,secret=env.LIGOU_TWILIO_AUTH_TOKEN;
  if(env.LIGOU_TWILIO_API_KEY_SID){if(!sid('SK',env.LIGOU_TWILIO_API_KEY_SID))throw Error('invalid_twilio_api_key_sid');login=env.LIGOU_TWILIO_API_KEY_SID;secret=env.LIGOU_TWILIO_API_KEY_SECRET;}
  if(typeof secret!=='string'||!secret||secret.length>512)throw Error('twilio_credentials_missing');
  const authorization='Basic '+Buffer.from(login+':'+secret).toString('base64');
  const get=url=>readJson(url,authorization,fetchImpl);
  const base=`https://api.twilio.com/2010-04-01/Accounts/${plan.account_sid}`;
  const account=await get(base+'.json');
  if(account.sid!==plan.account_sid){report.findings.push('account_identity_mismatch');return report;}
  if(account.status!=='active')report.findings.push('account_not_active');if(account.type!=='Full')report.findings.push('account_not_upgraded');
  if(!plan.phone_number){
    if(!plan.area_code){report.findings.push('choose_area_code_or_existing_number');return report;}
    const result=await get(base+`/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&AreaCode=${plan.area_code}&PageSize=5`);
    report.candidates=(Array.isArray(result.available_phone_numbers)?result.available_phone_numbers:[]).filter(n=>number(n.phone_number)&&n.capabilities?.voice===true&&n.iso_country==='US').slice(0,5).map(n=>({phone_number:n.phone_number,locality:typeof n.locality==='string'?n.locality:'',address_requirements:n.address_requirements??'unverified'}));
    report.findings.push('number_not_purchased');return report;
  }
  const result=await get(base+'/IncomingPhoneNumbers.json?PhoneNumber='+encodeURIComponent(plan.phone_number)+'&PageSize=2');
  const owned=Array.isArray(result.incoming_phone_numbers)?result.incoming_phone_numbers.filter(n=>n.phone_number===plan.phone_number):[];
  if(owned.length!==1){report.findings.push('number_not_uniquely_owned');return report;}
  const phone=owned[0];if(phone.account_sid!==plan.account_sid||!sid('PN',phone.sid)){report.findings.push('number_identity_mismatch');return report;}
  if(phone.capabilities?.voice!==true)report.findings.push('number_not_voice_capable');
  const trunkSid=phone.trunk_sid;
  if(!sid('TK',trunkSid??'')){report.findings.push('number_not_attached_to_trunk');return report;}
  if(plan.trunk_sid&&plan.trunk_sid!==trunkSid){report.findings.push('number_trunk_mismatch');return report;}
  const trunkBase='https://trunking.twilio.com/v1/Trunks/'+trunkSid;
  const trunk=await get(trunkBase);if(trunk.sid!==trunkSid||trunk.account_sid!==plan.account_sid){report.findings.push('trunk_identity_mismatch');return report;}
  if(trunk.secure!==true)report.findings.push('secure_trunking_not_enabled');
  if(trunk.recording?.mode!=='do-not-record')report.findings.push('recording_must_be_off_for_initial_test');
  if(trunk.transfer_mode!=='disable-all')report.findings.push('transfer_not_disabled_for_initial_test');
  if(trunk.disaster_recovery_url)report.findings.push('unreviewed_disaster_recovery_route');
  const routes=await get(trunkBase+'/OriginationUrls?PageSize=20');
  if(routes.meta?.next_page_url)report.findings.push('trunk_route_list_incomplete');
  const active=Array.isArray(routes.origination_urls)?routes.origination_urls.filter(r=>r.enabled===true):[];
  if(active.length!==1||active[0].sip_url!==plan.sip_uri||active[0].account_sid!==plan.account_sid||active[0].trunk_sid!==trunkSid)report.findings.push('origination_route_mismatch');
  report.number_sid=phone.sid;report.trunk_sid=trunkSid;report.provider_configuration_matches=report.findings.length===0;
 }catch(error){const code=error instanceof Error?error.message:'';report.findings.push(/^(twilio_http_\d{3}|twilio_timeout|twilio_credentials_missing|invalid_twilio_api_key_sid)$/.test(code)?code:'provider_inspection_failed');}
 return report;
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const args=process.argv.slice(2),mode=args[0]??'plan';
 try{if(args.length>1||!['plan','inspect'].includes(mode))throw Error('usage: first-phone-number.mjs [plan|inspect]');const result=mode==='plan'?createFirstPhonePlan(process.env):await inspectFirstPhone(process.env);console.log(JSON.stringify(result,null,2));if(result.status==='configuration_needed'||(mode==='inspect'&&!result.provider_configuration_matches))process.exitCode=2;}
 catch(error){console.error(error instanceof Error?error.message:'phone_preparation_failed');process.exitCode=1;}
}
