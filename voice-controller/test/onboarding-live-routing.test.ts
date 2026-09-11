import {expect,mock,test} from 'bun:test';

const starts:unknown[]=[];
mock.module('../src/onboarding-live-runtime.ts',()=>({
  managedLiveSessions:new Set(),
  setManagedLiveDiagnosticObserver:()=>{},
  startManagedBrowserSession:async(args:unknown)=>{starts.push(args);return{model:'gpt-live-1',opening_mode_applied:'live_managed_v1',sdp:'live-answer'};},
}));
const {startSession,onboardingSessionMaxMinutes}=await import('../src/server.ts');
const owner='10000000-0000-4000-8000-000000000001',tenant='10000000-0000-4000-8000-000000000002';
const call='10000000-0000-4000-8000-000000000003',request='10000000-0000-4000-8000-000000000004';
const options={onboardingProtocolVersion:6 as const,openingModeRequested:'live_managed_v1' as const,requestedCallId:call,browserRequestId:request};

test('protocol 6 dispatches owner and durable request scope to Live directly',async()=>{
  const before=starts.length,cleanup=()=>{};
  const result=await startSession(owner,'onboarding','offer','gpt-live-1',tenant,cleanup,options);
  expect(result).toMatchObject({model:'gpt-live-1',opening_mode_applied:'live_managed_v1'});
  expect(starts.slice(before)).toEqual([{userId:owner,tenantId:tenant,callId:call,requestId:request,sdpOffer:'offer',registerCleanup:cleanup}]);
  expect(onboardingSessionMaxMinutes(6)).toBe(55);
});

test('conflicting protocol/model and missing scope never fall through to Realtime',async()=>{
  const before=starts.length;
  for(const [type,model,opts] of [
    ['customer','gpt-live-1',options],['onboarding','gpt-realtime-2.1',options],
    ['onboarding','gpt-live-1',{...options,onboardingProtocolVersion:5}],
    ['onboarding','gpt-live-1',{...options,openingModeRequested:'realtime_native_v1'}],
    ['onboarding','gpt-live-1',{...options,browserRequestId:undefined}],
  ] as const)await expect(startSession(owner,type,'offer',model,tenant,undefined,opts as any)).rejects.toThrow();
  expect(starts.length).toBe(before);
});
