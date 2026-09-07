import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as harness from '../../scripts/voice-onboarding-audio-acceptance.mjs';

test('native launch entry rejects before examining configuration or starting a process',async()=>{
 assert.equal(typeof harness.openRealBrowser,'function','native entry must expose its explicit disabled contract');
 await assert.rejects(harness.openRealBrowser(null,null),/native_browser_execution_disabled_use_codex_in_app/);
});
test('in-app observer source is scoped, repeat-safe JavaScript without carrying authentication',()=>{
 assert.equal(typeof harness.buildBrowserHarnessSource,'function');
 const source=harness.buildBrowserHarnessSource({origin:'https://client-nine-taupe-24.vercel.app',isolatedTestOnly:true,recordTestAudio:true});
 assert.doesNotThrow(()=>new Function(source));
 assert.throws(()=>harness.buildBrowserHarnessSource({origin:'https://example.com/path',isolatedTestOnly:true,recordTestAudio:true}),/origin/);
 assert.throws(()=>harness.buildBrowserHarnessSource({origin:'https://example.com',recordTestAudio:true}),/isolated/);
 const prior={existing:true};let reads=0;
 const samePage={location:{origin:'https://client-nine-taupe-24.vercel.app'},__voiceAcceptance:prior};
 const install=new Function('location','window',source);
 assert.doesNotThrow(()=>install(samePage.location,samePage));assert.equal(samePage.__voiceAcceptance,prior);
 const wrongPage={get fetch(){reads++;throw new Error('wrong origin touched');}};
 assert.doesNotThrow(()=>install({origin:'https://unrelated.example'},wrongPage));assert.equal(reads,0);
});
test('local file manifest retains all114 questions and verifies selected owner WAV metadata',async()=>{
 assert.equal(typeof harness.buildOwnerFileManifest,'function');
 const plan={schema:'ligou.browser_audio_answer_plan.v1',provenance:{itemCount:114,candidateCount:21},
  items:Array.from({length:114},(_,index)=>({itemId:'item-'+index,questionPt:'Question '+index})),candidateRecap:[],unhandledItems:[],specials:{},
  clips:[{id:'owner-1',filename:'caller/owner-1.wav',audio:{sha256:'a'.repeat(64),durationMs:1500}},
    {id:'owner-2',filename:'caller/owner-2.wav',audio:{sha256:'b'.repeat(64),durationMs:2500}}]};
 const manifest=harness.buildOwnerFileManifest(plan,'/Users/d1f/Desktop/Ligou.AI/output/voice-onboarding-20260906/audio-acceptance');
 assert.equal(manifest.schema,'ligou.in_app_owner_audio.v1');assert.equal(manifest.provenance.itemCount,114);
 assert.equal(manifest.clips.length,2);assert.equal(manifest.items.length,114);
 assert.ok(manifest.clips.every(clip=>clip.absolutePath.startsWith('/Users/d1f/Desktop/Ligou.AI/output/')&&/^[a-f0-9]{64}$/.test(clip.audio.sha256)));
 const bad=structuredClone(plan);bad.clips[0].filename='../outside.wav';assert.throws(()=>harness.buildOwnerFileManifest(bad,'/tmp/voice'),/file/);
});

test('local owner file verification rejects changed bytes, names and non-WAV files before audio injection',async()=>{
 const bytes=new Uint8Array(48);bytes.set(new TextEncoder().encode('RIFF'));bytes.set(new TextEncoder().encode('WAVE'),8);
 const audio={sha256:createHash('sha256').update(bytes).digest('hex'),durationMs:100};
 const clip={id:'owner-1',basename:'owner-1.wav',audio};const file=new File([bytes],'owner-1.wav',{type:'audio/wav'});
 assert.deepEqual(await harness.validateOwnerAudioFile(file,clip),bytes);
 await assert.rejects(harness.validateOwnerAudioFile(file,{...clip,basename:'different.wav'}),/file_invalid/);
 const changed=bytes.slice();changed[44]=1;
 await assert.rejects(harness.validateOwnerAudioFile(new File([changed],'owner-1.wav'),clip),/hash_mismatch/);
 await assert.rejects(harness.validateOwnerAudioFile(new File([new Uint8Array(48)],'owner-1.wav'),clip),/not_wav/);
});

const capturedOpening=()=>({
 recording:{bytes:500,sha256:'a'.repeat(64),nonzeroObserved:true,outputIndex:1,actionId:'action-1',dispatchId:'dispatch-1',responseId:'response-1',
  captureEvidence:'actual_remote_stream_with_observed_output_gate',startedBrowserMs:122331.8,stoppedBrowserMs:143066.3,expectedText:'Oi! Aqui é o Ligou.'},
 events:[{event:'start_clicked',browserMs:115640.1},{event:'output_first_nonzero_sample',browserMs:123197.4,
  outputIndex:1,actionId:'action-1',dispatchId:'dispatch-1',responseId:'response-1',evidence:'remote_webrtc_media'}],
 waveform:{signalFirstMs:872.75,signalLastMs:20340.5,durationMs:20700,sampleRate:16000,signalThreshold:0.001,sha256:'b'.repeat(64)},
 words:[{word:'Oi,',start:0,end:1.06,probability:0.81},{word:'aqui',start:1.88,end:2.08,probability:0.98},
  ...['Quais','cidades','exatas','sua'].map((word,index)=>({word,start:17.78+index*0.2,end:17.98+index*0.2,probability:0.99}))],
});

test('legacy ASR-zero alignment cannot report words before matching captured media',()=>{
 const {recording,events}=capturedOpening();
 recording.alignment={available:true,sourceRecordingSha256:recording.sha256,firstIntelligibleBrowserMs:recording.startedBrowserMs,
  actionableQuestion:{browserMs:recording.startedBrowserMs+17780}};
 const metrics=harness.summarizeAttempt({recordings:[recording],events});
 assert.equal(metrics.startToFirstNonzeroCapturedSampleMs,7557.299999999988);
 assert.equal(metrics.startToFirstIntelligibleAudioMs,null,'uncalibrated Whisper offsets must not become browser latency');
 assert.equal(metrics.startToFirstActionableQuestionMs,null,'legacy recording-start arithmetic is not calibrated evidence');
});

test('cached pilot word zero is bounded by waveform onset and the same response sample observation',()=>{
 const {recording,events,waveform,words}=capturedOpening();
 const aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
 assert.equal(aligned.firstAsrTokenOffsetMs,0);
 assert.equal(aligned.firstVerifiedPhrase.offsetMs,0,'raw ASR evidence stays visible');
 assert.equal(aligned.browserClock.available,true);
 assert.equal(aligned.browserClock.observedFirstNonzeroBrowserMs,123197.4);
 assert.equal(aligned.firstIntelligibleBrowserMs,123204.55);
 assert.equal(aligned.actionableQuestion.browserMs,140111.8);
 assert.ok(aligned.firstIntelligibleBrowserMs>=events[1].browserMs);
 recording.alignment={...aligned,available:true,sourceRecordingSha256:recording.sha256};
 const metrics=harness.summarizeAttempt({recordings:[recording],events});
 assert.equal(metrics.startToFirstIntelligibleAudioMs,7564.449999999997);
 assert.equal(metrics.physicalSpeakerVerified,false);
 assert.equal(metrics.audioTimingEvidence,'conservative_captured_media_alignment');
});

test('a delayed recording clock shifts subsequent words conservatively without discarding leading silence twice',()=>{
 const {recording,events,waveform,words}=capturedOpening();
 events[1].browserMs=124000;
 const aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
 assert.equal(aligned.firstIntelligibleBrowserMs,124000);
 assert.equal(aligned.actionableQuestion.browserMs,124000+(17780-waveform.signalFirstMs));
 assert.ok(aligned.browserClock.originAdjustmentMs>0);
});

test('missing, wrong-response, wrong-dispatch, provider-only and out-of-recording samples cannot align words',()=>{
 for(const mutate of [
  events=>events.pop(),
  events=>{events[1].responseId='other-response';},
  events=>{events[1].dispatchId='other-dispatch';},
  events=>{events[1].outputIndex=2;},
  events=>{events[1].evidence='provider_output_buffer_started';},
  events=>{events[1].browserMs=144000;},
 ]){
  const {recording,events,waveform,words}=capturedOpening();mutate(events);
  const aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
  assert.equal(aligned.browserClock.available,false);
  assert.equal(aligned.firstIntelligibleBrowserMs,null);
  assert.equal(aligned.actionableQuestion,null);
 }
});

test('an ASR word entirely before the waveform or a word beyond capture end stays unmeasured',()=>{
 const {recording,events,waveform,words}=capturedOpening();
 words[0].end=0.5;
 let aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
 assert.equal(aligned.firstIntelligibleBrowserMs,null);
 assert.ok(aligned.actionableQuestion.browserMs>events[1].browserMs);
 recording.stoppedBrowserMs=124500;
 aligned=harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?');
 assert.equal(aligned.actionableQuestion,null);
});

test('summary rechecks sample identity and rejects a changed early aligned timestamp',()=>{
 const {recording,events,waveform,words}=capturedOpening();
 recording.alignment={available:true,sourceRecordingSha256:recording.sha256,
  ...harness.alignCapturedWords(recording,events,waveform,words,'Quais cidades exatas sua empresa atende?')};
 recording.alignment.firstIntelligibleBrowserMs=recording.startedBrowserMs;
 assert.equal(harness.summarizeAttempt({recordings:[recording],events}).startToFirstIntelligibleAudioMs,null);
 events[1].responseId='other-response';
 const metrics=harness.summarizeAttempt({recordings:[recording],events});
 assert.equal(metrics.startToFirstIntelligibleAudioMs,null);
 assert.equal(metrics.startToFirstActionableQuestionMs,null);
 assert.equal(metrics.audioTimingEvidence,null);
});
