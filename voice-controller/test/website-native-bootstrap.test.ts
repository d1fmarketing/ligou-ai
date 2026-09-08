import { test,expect } from 'bun:test';
import fixture from './fixtures/foghorn-website-first-voice.json';
import { buildRealtimeSessionConfig,onboardingSessionMaxMinutes,startSession } from '../src/server.ts';
import { buildWebsiteAgendaSeeds } from '../src/onboarding-agenda-seed.ts';
import { createOnboardingAgenda,getAgendaAction } from '../src/onboarding-agenda.ts';
import { buildWebsiteCandidateContext } from '../src/onboarding-website-summary.ts';
import { onboardingAgendaDigest,type StoredWebsiteInterview } from '../src/onboarding-agenda-store.ts';

function currentWebsite(){
  const {tenant_id:_,...draftReadback}=fixture.draft_row;
  const projection=buildWebsiteAgendaSeeds({draftReadback,initialCoverage:fixture.initial_coverage.snapshot as any});
  const b=projection.provenance;
  const agenda=createOnboardingAgenda({interviewId:b.callId,callId:b.callId,draftId:b.draftId,draftHash:b.draftHash,
    sourceResultId:b.sourceResultId,sourceResultHash:b.sourceResultHash},projection.seeds,buildWebsiteCandidateContext(projection));
  const stored:StoredWebsiteInterview={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),
    receiptId:'d934be85-6f4c-4738-996b-4b02c1bda552',state:'unfinished',replayed:false,nextAction:getAgendaAction(agenda)};
  return {stored,businessName:'Foghorn Air, Inc.'};
}

test('native bootstrap config uses direct audio and the actual persisted business context',()=>{
  const nativeWebsite=currentWebsite();
  const session=buildRealtimeSessionConfig({model:'gpt-realtime-2.1',voice:'ash',instructions:'legacy text is not the native context',tools:[],
    openingMode:'realtime_native_v1',onboardingProtocolVersion:5,nativeWebsite});
  expect(session.model).toBe('gpt-realtime-2.1');expect(session.audio.output.voice).toBe('ash');
  expect(session.output_modalities).toEqual(['audio']);expect(session.tool_choice).toBe('auto');
  expect(session.audio.input.turn_detection).toEqual({type:'semantic_vad',eagerness:'medium',create_response:true,interrupt_response:true});
  expect(session.instructions).toContain('Foghorn Air, Inc.');
  expect(session.instructions).toContain(nativeWebsite.stored.nextAction.questionPt);
  expect(session.tools.some((t:any)=>t.name==='submit_website_interview_proposal')).toBe(true);
  expect(session.instructions).not.toContain('fala_selecionada');
});

test('native bootstrap refuses a missing authoritative website context',()=>{
  expect(()=>buildRealtimeSessionConfig({model:'gpt-realtime-2.1',voice:'ash',instructions:'',tools:[],
    openingMode:'realtime_native_v1',onboardingProtocolVersion:5})).toThrow('native_website_context_required');
});

test('native session retains the existing time ceiling rather than increasing the test budget',()=>{
  expect(onboardingSessionMaxMinutes(5)).toBe(55);
});

test.each([
  {openingModeRequested:'realtime_stream_v1',onboardingProtocolVersion:4},
  {openingModeRequested:'application_tts_v1',onboardingProtocolVersion:3},
  {openingModeRequested:'realtime_native_v1',onboardingProtocolVersion:4},
])('new onboarding rejects retired or mismatched speech modes before tenant/provider work: %j',async options=>{
  await expect(startSession('invalid-synthetic-owner','onboarding','unused-offer',undefined,undefined,undefined,options as any))
    .rejects.toMatchObject({message:'client_upgrade_required',status:409});
});
