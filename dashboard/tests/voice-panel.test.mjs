import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash("sha256").update(value).digest("hex");

const NATIVE_BROWSER_SKIP = 'Native browser check NOT RUN: RJ requires Codex in-app browser. Edge/Chrome launch and cleanup are disabled.';
async function browserExecutable() { return null; }

// This is a real React/browser interaction regression with simulated media,
// authentication and transport. It never creates a provider session.
function moduleSource() {
  const callId = "11111111-1111-4111-8111-111111111111";
  const text = "Oi! Aqui é o Ligou, agente de inteligência artificial da Empresa de teste. Eu já analisei seu website. Quais cidades sua empresa atende?";
  const native = { interviewId: callId, callId, revision: 0, sourceDigest: "b".repeat(64) };
  const response = { sdp: "simulated-answer", call_id: callId, max_minutes: 1, business_name: "Empresa de teste",
    onboarding_protocol_version: 5, opening_mode_applied: "realtime_native_v1",
    opening_payload: { version: 5, native } };
  return `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import '/src/styles.css';
    window.__voice = { auth: [], permission: [], tracks: [], audios: [], peers: [], timing: [], bootstrap: 0, statusReads: [] };
    const state = window.__voice;
    const response = ${JSON.stringify(response)};
    state.speech = {...response.opening_payload.native,text:${JSON.stringify(text)}};
    const metadata = {};
    state.outcome={callId:response.call_id,currentCallId:response.call_id,interviewId:response.call_id,revision:0,state:'unfinished',
      callStatus:'active',providerTerminationState:'active',budgetStatus:'active',resumeEligible:false,digest:state.speech.sourceDigest};
    const vad = {type:'session.updated',event_id:'native_config',session:{output_modalities:['audio'],audio:{input:{turn_detection:{type:'semantic_vad',eagerness:'medium',create_response:true,interrupt_response:true}}}}};
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => new Promise((resolve, reject) => state.permission.push({resolve, reject}))
    }});
    state.grant = (index) => {
      const track = { enabled: true, stopCalls: 0, stop() { this.stopCalls++; } };
      state.tracks.push(track);
      state.permission[index].resolve({ getTracks: () => [track] });
    };
    const originalCreate = document.createElement.bind(document);
    class Audio extends EventTarget {
      src = ''; srcObject = null; muted = false; duration = 4; volume = 1; paused = true;
      constructor() { super(); state.audios.push(this); }
      play() {
        if(state.blockAudio)return Promise.reject(new DOMException('simulated autoplay block','NotAllowedError'));
        this.paused = false; queueMicrotask(() => this.dispatchEvent(new Event('playing'))); return Promise.resolve();
      }
      pause() {this.paused=true;} load() {} removeAttribute() {}
    }
    document.createElement = (tag, options) => tag === 'audio' ? new Audio() : originalCreate(tag, options);
    window.RTCPeerConnection = class {
      connectionState = 'new';
      constructor() { state.peers.push(this); }
      createDataChannel() {
        const channel = new EventTarget();
        channel.readyState = 'open';
        channel.send = (body) => queueMicrotask(() => {
          if(JSON.parse(body).item?.content?.[0]?.text?.startsWith('ligou.website_stop:')) {
            setTimeout(()=>{channel.readyState='closed';channel.onclose?.();},20);return;
          }
          if(JSON.parse(body).item?.content?.[0]?.text?.startsWith('ligou.website_native_ready:')) {
            state.amplitude=.2;
            channel.onmessage?.({data:JSON.stringify({type:'response.created',response:{id:'response_1',status:'in_progress',metadata}})});
            channel.onmessage?.({data:JSON.stringify({type:'output_audio_buffer.started',event_id:'buffer_start',response_id:'response_1'})});
            state.finish=()=>{state.amplitude=0;
              channel.onmessage?.({data:JSON.stringify({type:'response.done',response:{id:'response_1',status:'completed',metadata,output:[{id:'item_1',type:'message',role:'assistant',status:'completed',content:[{type:'audio',transcript:state.speech.text}]}]}})});
              channel.onmessage?.({data:JSON.stringify({type:'output_audio_buffer.stopped',event_id:'buffer_stop',response_id:'response_1'})});
            };
          }
        });
        this.channel = channel; return channel;
      }
      addTrack() {} createOffer() { return Promise.resolve({type:'offer',sdp:'simulated-offer'}); }
      setLocalDescription() { return Promise.resolve(); }
      setRemoteDescription() {
        const stream=()=>({getTracks:()=>[{stop(){}}],getAudioTracks:()=>[{}],clone:()=>stream()});
        this.ontrack?.({streams:[stream()]});this.channel.onmessage?.({data:JSON.stringify(vad)});return Promise.resolve();
      }
      close() { this.connectionState = 'closed'; }
    };
    window.AudioContext = class {state='running';resume(){return Promise.resolve();}close(){return Promise.resolve();}createMediaStreamSource(){return{connect(){},disconnect(){}};}createAnalyser(){return{fftSize:512,getFloatTimeDomainData:array=>array.fill(state.amplitude??0)};}};
    window.fetch = async () => { state.bootstrap++; return {ok:true,json:async()=>response}; };
    const { VoicePanel } = await import('/src/voice/VoicePanel.jsx');
    createRoot(document.getElementById('root')).render(<VoicePanel onClose={()=>{}} initialSessionType="onboarding"
      lockedOnboarding onboardingProtocolVersion={5} onTiming={entry=>state.timing.push(entry)} />);
  `;
}

async function openBrowser() {
  throw new Error('native_browser_execution_disabled_use_codex_in_app');
}

test("rendered panel responds promptly, starts once, cancels unresolved permission, retries and stops playback", async (t) => {
  const executable = await browserExecutable();
  if (!executable) return t.skip(NATIVE_BROWSER_SKIP);
  const browser = await openBrowser(executable);
  const stage = (name) => `document.querySelector('.voice-live')?.dataset.voiceStage === '${name}'`;
  const auth = (index) => `window.__voice.auth[${index}]({data:{session:{access_token:'simulated-owner-token'}}})`;
  try {
    await browser.evaluate("{ const button=document.querySelector('.voice-live-button'); button.click(); button.click(); }");
    await browser.until(stage("authenticating"));
    assert.equal(await browser.evaluate("window.__voice.auth.length"), 1);
    assert.match(await browser.evaluate("document.querySelector('.voice-live-hangup').textContent"), /Cancelar/);
    await browser.until("window.__voice.timing.some(entry=>entry.event==='visible_response')");
    const visible = await browser.evaluate("window.__voice.timing.find(entry=>entry.event==='visible_response').elapsedMs");
    assert.ok(visible <= 300, `visible response took ${visible} ms`);

    await browser.evaluate("document.querySelector('.voice-live-hangup').click();");
    await browser.until(stage("ended"));
    await browser.evaluate("document.querySelector('.voice-live-button').click();");
    await browser.until("window.__voice.auth.length===2");
    await browser.evaluate(auth(0));
    assert.equal(await browser.evaluate("window.__voice.permission.length"), 0, "old auth must not acquire a microphone");
    await browser.evaluate(auth(1));
    await browser.until(stage("permission-required"));
    await browser.evaluate("document.querySelector('.voice-live-hangup').click(); window.__voice.grant(0);");
    await browser.until(stage("ended"));
    await browser.until("window.__voice.tracks[0].stopCalls===1");
    assert.equal(await browser.evaluate("window.__voice.bootstrap"), 0);

    await browser.evaluate("document.querySelector('.voice-live-button').click();");
    await browser.until("window.__voice.auth.length===3");
    await browser.evaluate(auth(2));
    await browser.until("window.__voice.permission.length===2");
    await browser.evaluate("window.__voice.permission[1].reject(new DOMException('simulated denial','NotAllowedError'));");
    await browser.until(stage("failed"));
    assert.match(await browser.evaluate("document.querySelector('[role=alert]').textContent"), /Permita o uso do microfone/);
    assert.match(await browser.evaluate("document.querySelector('.voice-live-button').textContent"), /Tentar novamente/);

    await browser.evaluate("document.querySelector('.voice-live-button').click();");
    await browser.until(stage("retrying"));
    await browser.evaluate(auth(3));
    await browser.until("window.__voice.permission.length===3");
    await browser.evaluate("window.__voice.grant(2);");
    await browser.until(stage("playing"));
    assert.equal(await browser.evaluate("window.__voice.tracks[1].enabled"), true);
    assert.match(await browser.evaluate("document.querySelector('[role=status]').textContent"), /Ligou está falando/);
    await browser.evaluate("window.__voice.finish();");
    await browser.until(stage("ready"));
    assert.equal(await browser.evaluate("window.__voice.tracks[1].enabled"), true);
    await browser.evaluate("document.querySelector('.voice-live-hangup').click();");
    await browser.until(stage("ended"));
    assert.equal(await browser.evaluate("window.__voice.tracks[1].stopCalls"), 1);
    assert.equal(await browser.evaluate("window.__voice.peers[0].connectionState"), "closed");
    await browser.until("window.__voice.statusReads.length>0");
    assert.equal(await browser.evaluate("document.querySelector('.voice-live-button').disabled"),true);
    await browser.evaluate("Object.assign(window.__voice.outcome,{callStatus:'ended',providerTerminationState:'confirmed',budgetStatus:'settled',resumeEligible:true});");
    await browser.until("document.querySelector('.voice-live-button').disabled===false");
    await browser.evaluate("window.__voice.blockAudio=true; document.querySelector('.voice-live-button').click();");
    await browser.until("window.__voice.auth.length===5");
    await browser.evaluate(auth(4));
    await browser.until("window.__voice.permission.length===4");
    await browser.evaluate("window.__voice.grant(3);");
    await browser.until("Boolean(document.querySelector('[role=alert]'))");
    assert.match(await browser.evaluate("document.querySelector('[role=alert]').textContent"), /navegador bloqueou o áudio/);
    assert.equal(await browser.evaluate("window.__voice.tracks[2].stopCalls"), 1);
    assert.equal(await browser.evaluate("window.__voice.peers[1].connectionState"), "closed");
    t.diagnostic(`Rendered interaction only; simulated media/provider. Browser: ${path.basename(executable)}. Visible response: ${visible.toFixed(1)} ms.`);
  } finally { await browser.close(); }
});

test('Stop during opening retains the known call and blocks new Start until resume proof',async t=>{
 const executable=await browserExecutable();if(!executable)return t.skip(NATIVE_BROWSER_SKIP);
 const browser=await openBrowser(executable);try{
  await browser.evaluate("document.querySelector('.voice-live-button').click();");
  await browser.until('window.__voice.auth.length===1');
  await browser.evaluate("window.__voice.auth[0]({data:{session:{access_token:'simulated-owner-token'}}});");
  await browser.until('window.__voice.permission.length===1');await browser.evaluate('window.__voice.grant(0);');
  await browser.until("document.querySelector('.voice-live')?.dataset.voiceStage==='playing'");
  await browser.evaluate("document.querySelector('.voice-live-hangup').click();");
  await browser.until("document.querySelector('.voice-live')?.dataset.voiceStage==='ended'");
  assert.equal(await browser.evaluate('window.__voice.statusReads.length>0'),true);
  assert.equal(await browser.evaluate("window.__voice.statusReads.every(read=>read.p_call===window.__voice.speech.callId)"),true);
  assert.equal(await browser.evaluate("document.querySelector('.voice-live-button').disabled"),true);
  await browser.evaluate("document.querySelector('.voice-live-button').click();");
  assert.equal(await browser.evaluate('window.__voice.auth.length'),1);
 }finally{await browser.close();}
});
