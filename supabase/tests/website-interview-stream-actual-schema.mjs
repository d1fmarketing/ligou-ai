// Rollback-only stream transport coverage using the gate's real selected source
// and interview. Existing legacy/runtime/source checks continue afterward.
import {runWebsiteStreamCases} from './website-interview-stream-cases.mjs';
import {runWebsiteStreamSummaryCases} from './website-interview-stream-summary-cases.mjs';
const q=value=>`'${String(value).replaceAll("'","''")}'`;
export function websiteStreamActualPrelude({owner,tenant,call,request,streamCall,streamRequest}) {
  return `
    update public.calls set status='ended',ended_at=clock_timestamp(),duration_seconds=0,provider_termination_state='confirmed',provider_termination_reason='fixture_stream_parent_ended',provider_usage_state='resolved',cost_estimate_usd=0 where id=${q(call)};
    update public.browser_session_requests set status='cancel_requested' where id=${q(request)} and status='ready';
    update public.browser_session_requests set status='expired',answer_sdp=null,opening_mode_applied=null,opening_payload=null where id=${q(request)} and status='cancel_requested';
    update public.browser_session_requests set status='error',error='fixture_parent_ended',answer_sdp=null,opening_mode_applied=null,opening_payload=null where id=${q(request)} and status in ('pending','processing','error');
    update public.budget_reservations set status='settled',outcome='ended',final_cost_usd=0,final_minutes=0,settled_at=clock_timestamp() where call_id=${q(call)};
    -- This rollback-only batch represents separate real Start transactions.
    -- Do not collapse sequential calls onto the transaction-wide now() default.
    insert into public.calls(id,tenant_id,channel,session_type,status,test_memory_generation,provider_usage_state,started_at)
      values(${q(streamCall)},${q(tenant)},'browser','onboarding','active',2,'not_applicable',clock_timestamp());
    do $chronology$ begin
      if (select started_at from public.calls where id=${q(call)}) >= (select started_at from public.calls where id=${q(streamCall)}) then
        raise exception 'stream_fixture_call_chronology_invalid';
      end if;
    end $chronology$;
    insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version,test_memory_generation)
      values(${q(streamRequest)},${q(tenant)},${q(owner)},'onboarding','actual-stream-offer','processing',${q(streamCall)},'realtime_stream_v1',4,2);
    select public.reserve_call_budget(${q(tenant)},${q(streamCall)},7.5,55);
    select public.resolve_prepared_website_source(${q(owner)},${q(streamCall)},${q(streamRequest)});
    select public.attach_website_interview(${q(owner)},${q(streamCall)},${q(streamRequest)},${q(call)},${q(call)});
  `;
}
export async function runWebsiteStreamActualSchemaProbe(input) {
  const streamCall='9c000000-0000-4000-8000-000000000001',streamRequest='9c000000-0000-4000-8000-000000000002';
  return runWebsiteStreamCases({...input,call:streamCall,request:streamRequest,
    prelude:websiteStreamActualPrelude({...input,streamCall,streamRequest})});
}
export async function runWebsiteStreamSummaryActualSchemaProbe(input) {
  const streamCall='9c000000-0000-4000-8000-000000000011',streamRequest='9c000000-0000-4000-8000-000000000012';
  return runWebsiteStreamSummaryCases({...input,call:streamCall,request:streamRequest,
    prelude:websiteStreamActualPrelude({...input,streamCall,streamRequest})});
}
