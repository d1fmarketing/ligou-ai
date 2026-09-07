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
