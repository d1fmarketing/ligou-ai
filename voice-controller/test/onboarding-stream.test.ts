import {expect,test} from 'bun:test';
import cases from './fixtures/website-stream-transcript-cases.json';
import {streamAuthorizationIsValid,streamMediaEvidenceIsValid,streamControlId,normalizeWebsiteStreamTranscript,websiteStreamTranscriptMatches} from '../src/onboarding-stream.ts';
const action={actionId:'a'.repeat(64),interviewId:'11111111-1111-4111-8111-111111111111',callId:'11111111-1111-4111-8111-111111111111',revision:0,kind:'ASK_NEXT_GAP' as const,text:'Quais cidades atende?',sourceDigest:'b'.repeat(64)};
test.each(cases)('stream transcript policy: $name',c=>{
 expect(websiteStreamTranscriptMatches({...action,text:c.expected},c.actual)).toBe(c.valid);
});
test('expected-only courtesy omission preserves the bound action and standalone normalization',()=>{
 const captured=cases.find(c=>c.name==='captured 0011 optional recorded-answer courtesy')!;
 const bound=Object.freeze({...action,kind:'CONFIRM_AND_ASK_NEXT' as const,text:captured.expected});
 const original=JSON.stringify(bound),transcript=captured.actual;
 expect(websiteStreamTranscriptMatches(bound,transcript)).toBe(true);
 expect(JSON.stringify(bound)).toBe(original);expect(transcript).toBe(captured.actual);
 const normalized=normalizeWebsiteStreamTranscript(bound.text);
 expect(normalized.startsWith('obrigado registrei sua resposta ')).toBe(true);
 expect(normalized).not.toBe(normalizeWebsiteStreamTranscript(transcript));
 expect(normalizeWebsiteStreamTranscript(bound.text)).toBe(normalized);
 expect(normalizeWebsiteStreamTranscript(normalized)).toBe(normalized);
 expect(normalizeWebsiteStreamTranscript('Obrigado, registrei sua resposta.')).toBe('obrigado registrei sua resposta');
 expect(normalizeWebsiteStreamTranscript('Obrigado, registrei sua resposta. !')).toBe('obrigado registrei sua resposta');
 expect(normalizeWebsiteStreamTranscript('Obrigado, registrei sua resposta. Obrigado, registrei sua resposta. Quais cidades atende?'))
  .toBe('obrigado registrei sua resposta obrigado registrei sua resposta quais cidades atende');
});
test('stream authorization binds seven-field action and two real receipt identities',()=>{
 const stream={schema:'onboarding.stream.v1',action,dispatchId:'22222222-2222-4222-8222-222222222222',receiptId:'33333333-3333-4333-8333-333333333333'};
 expect(streamAuthorizationIsValid(stream,action)).toBe(true);
 for(const patch of [{schema:'onboarding.speech.v1'},{dispatchId:'fake'},{receiptId:null},{audio_base64:'AAAA'}])expect(streamAuthorizationIsValid({...stream,...patch},action)).toBe(false);
 expect(streamControlId('ready',stream.dispatchId)).toBe('lsr-'+stream.dispatchId.replaceAll('-','').slice(0,28));
});
test('stream playout requires nonzero actual media evidence and bounded browser durations',()=>{
 const value={schema:'onboarding.stream.media.v1',nonzeroSamples:100,observedMs:250,firstSampleAtMs:10,lastSampleAtMs:260,unmuted:true,playbackStarted:true};
 expect(streamMediaEvidenceIsValid(value)).toBe(true);
 for(const patch of [{nonzeroSamples:0},{observedMs:180001},{lastSampleAtMs:9},{unmuted:false},{playbackStarted:false},{extra:true}])expect(streamMediaEvidenceIsValid({...value,...patch})).toBe(false);
});
