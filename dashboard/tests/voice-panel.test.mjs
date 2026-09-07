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

async function browserExecutable() {
  for (const candidate of [process.env.LIGOU_TEST_BROWSER_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_BIN, "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next supported browser. */ }
  }
  return null;
}

// This is a real React/browser interaction regression with simulated media,
// authentication and transport. It never creates a provider session.
function moduleSource() {
  const callId = "11111111-1111-4111-8111-111111111111";
  const text = "Oi! Aqui é o Ligou, agente de inteligência artificial da Empresa de teste. Eu já analisei seu website. Quais cidades sua empresa atende?";
  const bytes = Buffer.from("ID3test-mp3");
  const speech = { schema: "onboarding.speech.v1", actionId: "a".repeat(64), interviewId: callId, callId,
    revision: 0, kind: "ASK_NEXT_GAP", text, sourceDigest: "b".repeat(64), text_sha256: hash(text),
    audio_base64: bytes.toString("base64"), audio_sha256: hash(bytes), mime: "audio/mpeg", voice: "ash",
    tts_model: "tts-1-hd", cost_usd: Number(([...text].length * 30 / 1e6).toFixed(8)) };
  const response = { sdp: "simulated-answer", call_id: callId, max_minutes: 1, business_name: "Empresa de teste",
    onboarding_protocol_version: 3, opening_mode_applied: "application_tts_v1",
    opening_payload: { version: 3, item_id: `lgs-${speech.actionId.slice(0, 28)}`, speech } };
  return `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import '/src/styles.css';
    window.__voice = { auth: [], permission: [], tracks: [], audios: [], peers: [], timing: [], bootstrap: 0, statusReads: [] };
    const state = window.__voice;
    const response = ${JSON.stringify(response)};
    state.speech = response.opening_payload.speech;
    state.outcome={callId:response.call_id,currentCallId:response.call_id,interviewId:response.call_id,revision:0,state:'unfinished',
      callStatus:'active',providerTerminationState:'active',budgetStatus:'active',resumeEligible:false,digest:response.opening_payload.speech.sourceDigest};
    const vad = {type:'session.updated',session:{output_modalities:['text'],audio:{input:{turn_detection:{type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false}}}}};
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
      src = ''; srcObject = null; muted = false; duration = 4;
      constructor() { super(); state.audios.push(this); }
      play() {
        if(state.blockAudio)return Promise.reject(new DOMException('simulated autoplay block','NotAllowedError'));
        queueMicrotask(() => this.dispatchEvent(new Event('playing'))); return Promise.resolve();
      }
      pause() {} load() {} removeAttribute() {}
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
          channel.onmessage?.({data:JSON.stringify({type:'conversation.item.done',item:JSON.parse(body).item})});
          channel.onmessage?.({data:JSON.stringify(vad)});
        });
        this.channel = channel; return channel;
      }
      addTrack() {} createOffer() { return Promise.resolve({type:'offer',sdp:'simulated-offer'}); }
      setLocalDescription() { return Promise.resolve(); }
      setRemoteDescription() { return Promise.resolve(); }
      close() { this.connectionState = 'closed'; }
    };
    window.fetch = async () => { state.bootstrap++; return {ok:true,json:async()=>response}; };
    const { VoicePanel } = await import('/src/voice/VoicePanel.jsx');
    createRoot(document.getElementById('root')).render(<VoicePanel onClose={()=>{}} initialSessionType="onboarding"
      lockedOnboarding onboardingProtocolVersion={3} onTiming={entry=>state.timing.push(entry)} />);
  `;
}

async function openBrowser(executable) {
  const profile = await mkdtemp(path.join(tmpdir(), "ligou-voice-panel-"));
  const virtual = "/__voice_panel_test.jsx";
  const server = await createServer({ root, configFile: false, cacheDir: path.join(profile, "vite-cache"),
    appType: "custom", server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    resolve: { dedupe: ["react", "react-dom"] },
    plugins: [react(), {
      name: "voice-panel-simulated-transport",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === virtual) return virtual;
        if (id === "../lib/supabase.js" && importer?.endsWith("/voice/VoicePanel.jsx")) return "\0voice-panel-client";
        return null;
      },
      load(id) {
        if (id === virtual) return moduleSource();
        if (id === "\0voice-panel-client") return `export const supabase={
          auth:{getSession:()=>new Promise(resolve=>window.__voice.auth.push(resolve))},
          channel:()=>{const c={on:()=>c,subscribe:()=>c};return c;},removeChannel(){},
          rpc:async(name,args)=>{if(name==='get_website_interview_status'){window.__voice.statusReads.push(args);return{data:window.__voice.outcome,error:null};}
            return{data:window.__voice.speech,error:null};}};`;
        return null;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__voice_panel__") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(await vite.transformIndexHtml(request.url,
            `<!doctype html><html lang="pt-BR"><body><div id="root"></div><script type="module" src="${virtual}"></script></body></html>`));
        });
      },
    }],
  });
  let browser;
  let socket;
  const close = async () => {
    socket?.close();
    if (browser && browser.exitCode === null) {
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill("SIGTERM");
      await Promise.race([exited, sleep(2_000)]);
      if (browser.exitCode === null) browser.kill("SIGKILL");
    }
    await server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    browser = spawn(executable, ["--headless=new", "--disable-background-networking", "--disable-component-update",
      "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const debugUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("voice_test_browser_timeout")), 8_000);
      browser.stderr.on("data", (chunk) => {
        const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      browser.once("exit", (code) => { clearTimeout(timer); reject(new Error(`voice_test_browser_exit_${code}`)); });
    });
    const pages = await (await fetch(`${debugUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.+$/, "")}/json/list`)).json();
    socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve) => { socket.onopen = resolve; });
    const pending = new Map();
    let nextId = 0;
    socket.onmessage = ({ data }) => { const message = JSON.parse(data); pending.get(message.id)?.(message); pending.delete(message.id); };
    const send = (method, params) => new Promise((resolve) => {
      const id = ++nextId; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || "voice_test_evaluation_failed");
      return result.result?.result?.value;
    };
    const until = async (expression) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(30); }
      throw new Error(`voice_panel_expected:${expression}:${await evaluate("document.body.innerText")}`);
    };
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/__voice_panel__` });
    await until("Boolean(document.querySelector('.voice-live-button'))");
    return { evaluate, until, close };
  } catch (error) { await close(); throw error; }
}

test("rendered panel responds promptly, starts once, cancels unresolved permission, retries and stops playback", async (t) => {
  const executable = await browserExecutable();
  if (!executable) return t.skip("No supported local browser for the rendered interaction regression.");
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
    assert.equal(await browser.evaluate("window.__voice.tracks[1].enabled"), false);
    assert.match(await browser.evaluate("document.querySelector('[role=status]').textContent"), /Ligou está falando/);
    await browser.evaluate("window.__voice.audios[1].dispatchEvent(new Event('ended'));");
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
 const executable=await browserExecutable();if(!executable)return t.skip('No supported local browser');
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
