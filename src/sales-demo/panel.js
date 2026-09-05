import {createVoiceBridge, ACTIVE_STATES} from './ui-controller.js';
import {createSalesVoiceSession} from './voice-client.js';

const labels = {
  idle:'Pronto para conversar', requesting_microphone:'Aguardando o microfone',
  connecting:'Conectando com o Ligou', listening:'Conversa conectada',
  speaking:'Ligou está falando', reconnecting:'Reconectando a conversa',
  ending:'Confirmando o encerramento', ending_unconfirmed:'Encerramento pendente',
  ended:'Conversa encerrada', error:'Não foi possível conectar',
};
const hints = {
  idle:'Converse em português e conheça o Ligou usando a sua voz.',
  requesting_microphone:'Permita o uso do microfone na mensagem do navegador. Nenhuma conversa começa antes da sua permissão.',
  connecting:'Estamos preparando sua conversa. Isso pode levar alguns instantes.',
  listening:'Conte sobre sua empresa, faça uma pergunta ou peça uma demonstração.',
  speaking:'Você pode interromper ou fazer uma pergunta a qualquer momento.',
  reconnecting:'Sua conexão oscilou. Estamos tentando recuperar a mesma conversa.',
  ending:'Seu microfone já está desligado. Estamos confirmando o término no servidor.',
  ending_unconfirmed:'Seu microfone está desligado. A confirmação do servidor ainda está pendente; uma nova conversa ficará bloqueada até a conferência.',
  ended:'Obrigado pela conversa. Qualquer próximo passo depende do que vocês combinaram.',
  error:'Confira a orientação abaixo e tente novamente quando estiver pronto.',
};
let singleton;

function createPanel(endpoint) {
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = '/assets/sales-demo.css'; css.dataset.ligouSalesStyle = '';
  if (!document.querySelector('[data-ligou-sales-style]')) document.head.append(css);
  const host = document.createElement('div');
  host.className = 'sales-demo';
  host.innerHTML = `<dialog class="sales-demo__panel" aria-labelledby="sales-demo-title" aria-describedby="sales-demo-description">
    <header class="sales-demo__header">
      <div><span class="sales-demo__eyebrow">LIGOU? ATENDIDO.</span><h2 id="sales-demo-title">Fale com o Ligou.</h2></div>
      <button class="sales-demo__minimize" type="button" aria-label="Minimizar conversa" title="Minimizar conversa">−</button>
    </header>
    <p id="sales-demo-description" class="sales-demo__intro">Uma conversa por voz com inteligência artificial, de até 5 minutos. Você pode parar quando quiser.</p>
    <p class="sales-demo__intro">A transcrição e os dados que você informar ficam registrados para avaliar seu caso. <a href="/privacidade/" target="_blank" rel="noopener">Privacidade</a>.</p>
    <div class="sales-demo__presence" aria-hidden="true"><img src="/assets/crop-logo-mark.png" alt="" width="60" height="60"><span></span><span></span><span></span><span></span><span></span></div>
    <div class="sales-demo__status-row"><p class="sales-demo__status" role="status" aria-live="polite"></p><span class="sales-demo__timer" aria-label="Tempo da conversa">00:00 / 05:00</span></div>
    <p class="sales-demo__hint"></p><p class="sales-demo__error" role="alert" hidden></p>
    <p class="sales-demo__diagnostic" role="status" hidden></p>
    <div class="sales-demo__input" hidden><label for="sales-demo-microphone">Microfone <span class="sales-demo__level" aria-hidden="true"><i></i></span></label><select id="sales-demo-microphone" aria-label="Selecionar microfone"></select></div>
    <div class="sales-demo__captions-header"><button class="sales-demo__caption-toggle" type="button" aria-expanded="true" aria-controls="sales-demo-captions">Ocultar legendas</button><span>Transcrição automática</span></div>
    <div class="sales-demo__captions" id="sales-demo-captions" role="region" aria-label="Legendas da conversa" tabindex="0"><p class="sales-demo__empty">As falas aparecem aqui quando a conversa começar.</p></div>
    <div class="sales-demo__controls"><button class="sales-demo__mute" type="button" aria-pressed="false" hidden>Silenciar microfone</button><button class="sales-demo__end" type="button" hidden>Desligar</button><button class="sales-demo__start" type="button">Tentar novamente</button><button class="sales-demo__audio" type="button" hidden>Ouvir áudio</button></div>
    <p class="sales-demo__footer">É uma demonstração: não agenda nem faz ligações externas reais. Qualquer contato posterior depende da sua autorização.</p>
  </dialog><button class="sales-demo__dock" type="button" hidden><span class="sales-demo__dock-dot" aria-hidden="true"></span><span class="sales-demo__dock-label">Voltar à conversa</span><span aria-hidden="true">↗</span></button>`;
  document.body.append(host);
  const $ = selector => host.querySelector(selector);
  const dialog = $('.sales-demo__panel'), dock = $('.sales-demo__dock');
  const status = $('.sales-demo__status'), hint = $('.sales-demo__hint'), error = $('.sales-demo__error');
  const captions = $('.sales-demo__captions'), captionToggle = $('.sales-demo__caption-toggle');
  const mute = $('.sales-demo__mute'), end = $('.sales-demo__end'), start = $('.sales-demo__start'), audio = $('.sales-demo__audio');
  const input = $('.sales-demo__input'), microphone = $('#sales-demo-microphone'), diagnostic = $('.sales-demo__diagnostic');
  const data = {state:'idle',muted:false,expanded:false,captions:new Map(),elapsed:0,error:null,audioBlocked:false};
  let returnFocus = null;

  function expand() {
    if (dialog.open) return;
    if (!host.contains(document.activeElement)) returnFocus = document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else {dialog.setAttribute('open',''); dialog.setAttribute('aria-modal','true');}
    data.expanded = true; dock.hidden = true;
    $('.sales-demo__minimize').focus({preventScroll:true});
  }
  function minimize() {
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    data.expanded = false;
    dock.hidden = !ACTIVE_STATES.has(data.state);
    if (!dock.hidden) dock.focus({preventScroll:true});
    else if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
  }
  function renderCaption(caption) {
    if (!caption || typeof caption.text !== 'string' || !caption.id) return;
    const shouldFollow = captions.scrollTop + captions.clientHeight >= captions.scrollHeight - 48;
    $('.sales-demo__empty')?.remove();
    const key = `${caption.role}:${caption.id}`;
    let row = data.captions.get(key);
    if (!row) {
      row = document.createElement('p'); row.className = 'sales-demo__caption';
      const label = document.createElement('strong'); label.textContent = caption.role === 'caller' ? 'Você' : 'Ligou';
      row.append(label, document.createElement('span')); captions.append(row); data.captions.set(key,row);
      if (data.captions.size > 100) {const first = data.captions.keys().next().value; data.captions.get(first).remove(); data.captions.delete(first);}
    }
    row.lastElementChild.textContent = caption.text.slice(-8000);
    if (shouldFollow) captions.scrollTop = captions.scrollHeight;
  }
  function update(patch) {
    if (patch.captions) {data.captions.clear(); captions.replaceChildren();}
    for (const key of ['state','muted','elapsed','error','audioBlocked','providerTerminationState']) if (key in patch) data[key] = patch[key];
    if (patch.expanded) expand();
    if (patch.caption) renderCaption(patch.caption);
    if ('inputLevel' in patch) $('.sales-demo__level i').style.width = `${Math.round(Math.max(0,Math.min(1,patch.inputLevel)) * 100)}%`;
    if (Object.keys(patch).every(key => ['caption','inputLevel'].includes(key))) return;
    if (patch.microphones) {
      microphone.replaceChildren(...patch.microphones.devices.map(device => {const option = document.createElement('option');option.value = device.id;option.textContent = device.label;return option;}));
      if (patch.microphones.selected) microphone.value = patch.microphones.selected;
    }
    if (patch.diagnostic) {diagnostic.hidden = !patch.diagnostic.code; diagnostic.textContent = patch.diagnostic.code === 'transcription_timeout' ? 'Não conseguimos transcrever sua fala. Confira o microfone selecionado e tente falar mais perto dele.' : patch.diagnostic.code === 'no_speech_detected' ? 'Não detectamos fala. Confira a entrada do microfone abaixo e tente novamente.' : '';}
    host.dataset.state = data.state;
    const expired = data.state === 'ended' && data.providerTerminationState === 'expired';
    status.textContent = expired ? 'Conversa expirada' : data.muted && ['listening','speaking'].includes(data.state) ? 'Seu microfone está silenciado' : labels[data.state] || labels.idle;
    hint.textContent = expired ? 'A sessão anterior expirou e seu microfone está desligado. Você pode iniciar outra conversa.' : hints[data.state] || hints.idle;
    const seconds = Math.min(300,Math.max(0,data.elapsed));
    $('.sales-demo__timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')} / 05:00`;
    error.textContent = data.error || ''; error.hidden = !data.error;
    const talking = ['listening','speaking','reconnecting'].includes(data.state);
    input.hidden = !talking || !microphone.options.length;
    mute.hidden = !talking; mute.setAttribute('aria-pressed',String(data.muted));
    mute.textContent = data.muted ? 'Ativar microfone' : 'Silenciar microfone';
    end.hidden = !ACTIVE_STATES.has(data.state) || data.state === 'ending_unconfirmed';
    end.disabled = data.state === 'ending'; end.textContent = data.state === 'ending' ? 'Encerrando…' : 'Desligar';
    start.hidden = !['idle','ended','error','ending_unconfirmed'].includes(data.state);
    start.textContent = data.state === 'ending_unconfirmed' ? 'Conferir encerramento' : data.state === 'ended' ? 'Conversar novamente' : 'Tentar novamente';
    audio.hidden = !data.audioBlocked || !talking;
    dock.hidden = data.expanded || !ACTIVE_STATES.has(data.state);
    $('.sales-demo__dock-label').textContent = data.state === 'ending_unconfirmed' ? 'Conferir encerramento' : 'Voltar à conversa';
    // A focused control can disappear as the connection settles. Keep keyboard
    // focus in the dialog without stealing it on caption updates.
    if (dialog.open && document.activeElement?.hidden) $('.sales-demo__minimize').focus({preventScroll:true});
  }
  const bridge = createVoiceBridge({endpoint,loadClient:async () => ({createSalesVoiceSession}),emit:update});
  $('.sales-demo__minimize').addEventListener('click',minimize);
  dock.addEventListener('click',expand);
  dialog.addEventListener('cancel',event => {event.preventDefault(); minimize();});
  dialog.addEventListener('keydown',event => {
    if (event.key === 'Escape') {event.preventDefault(); minimize(); return;}
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(el => !el.hidden && el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {event.preventDefault();last?.focus();}
    else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first?.focus();}
  });
  mute.addEventListener('click',() => bridge.setMuted(!data.muted));
  end.addEventListener('click',() => {void bridge.end();});
  start.addEventListener('click',() => {void (data.state === 'ending_unconfirmed' ? bridge.end() : bridge.start());});
  audio.addEventListener('click',() => {void bridge.resumeAudio();});
  microphone.addEventListener('change',async () => {microphone.disabled = true; try {await bridge.selectMicrophone(microphone.value);} finally {microphone.disabled = false;}});
  captionToggle.addEventListener('click',() => {captions.hidden = !captions.hidden; captionToggle.setAttribute('aria-expanded',String(!captions.hidden)); captionToggle.textContent = captions.hidden ? 'Mostrar legendas' : 'Ocultar legendas';});
  update({state:'idle'});
  return {open() {expand();return bridge.start();},minimize,getState:() => data.state};
}

/** Lazy integration: import('/assets/js/sales-demo.js').then(m =>
 * m.openSalesDemo({endpoint:'/api/sales-session'})). Later CTAs may dispatch
 * window.dispatchEvent(new CustomEvent('ligou:sales-open')). */
export function openSalesDemo({endpoint = '/api/sales-session'} = {}) {
  if (!singleton) singleton = createPanel(endpoint);
  return singleton.open();
}
export function getSalesDemoState() {return singleton?.getState() || 'idle';}
if (typeof window !== 'undefined') window.addEventListener('ligou:sales-open',() => {void openSalesDemo();});
