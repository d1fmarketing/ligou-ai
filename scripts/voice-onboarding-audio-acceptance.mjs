#!/usr/bin/env node
// Test-only browser/media harness. Default preparation is entirely local.
// No transcript/tool injection, paid text API, microphone-gate override, or output muting.
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'output/voice-onboarding-20260906/audio-acceptance');
const DEFAULT_AUTH = '/Users/d1f/.config/ligou/voice-onboarding-20260906/test-auth.json';
const FIXTURE = path.join(ROOT, 'voice-controller/test/fixtures/foghorn-website-first-voice.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = code => { throw new Error(code); };
const publicRuntime = new WeakMap();

export function parseArgs(args) {
  const options = { command: 'prepare', output: DEFAULT_OUTPUT, scenario: 'normal', condition: 'warm', count: 1, synthesize: true };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (['prepare', 'run', 'report', 'self-test', 'export-in-app'].includes(key)) options.command = key;
    else if (key === '--execute') options.execute = true;
    else if (key === '--browser-smoke') options.browserSmoke = true;
    else if (key === '--no-synthesis') options.synthesize = false;
    else if (key === '--help') options.help = true;
    else if (['--output', '--config', '--scenario', '--condition', '--count', '--mode', '--result', '--origin'].includes(key)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) fail('missing_option_value');
      options[key.slice(2)] = args[++index];
      if (key === '--result') (options.results ??= []).push(options.result);
    } else fail('unknown_option');
  }
  options.count = Number(options.count);
  if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > 15) fail('invalid_attempt_count');
  if (!['normal', 'variation', 'recovery'].includes(options.scenario)) fail('unknown_scenario');
  if (!['warm', 'cold'].includes(options.condition)) fail('unknown_start_condition');
  return options;
}

async function localCommand(command, args, { timeoutMs = 120_000, input, maxBytes = 8_000_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('local_command_timeout')); }, timeoutMs);
    const finish = error => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(stdout); };
    child.on('error', () => finish(new Error('local_command_unavailable')));
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > maxBytes) { child.kill(); finish(new Error('local_command_output_limit')); } });
    child.stderr.on('data', chunk => { if (stderr.length < 2048) stderr += chunk; });
    child.on('exit', code => finish(code === 0 ? null : new Error(`local_command_failed_${path.basename(command)}_${code}`)));
    child.stdin.end(input);
  });
}

async function fixtureProjection() {
  const code = `import fs from 'node:fs';
    import {buildWebsiteAgendaSeeds} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'voice-controller/src/onboarding-agenda-seed.ts')).href)};
    const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(FIXTURE)},'utf8'));
    const {tenant_id,...draftReadback}=fixture.draft_row;
    const projection=buildWebsiteAgendaSeeds({draftReadback,initialCoverage:fixture.initial_coverage.snapshot});
    process.stdout.write(JSON.stringify({fixtureHash:${JSON.stringify(sha(await readFile(FIXTURE)))},projection}));`;
  return JSON.parse(await localCommand(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', code]));
}

const TERRITORY = 'Uhum. Olha, atende só Novato, San Rafael e Petaluma. Nada além dessas três. Já teve pedido de gente de outras cidades, mas não é pra atender. Se pintar alguma coisa fora, é só com aprovação explícita do dono, combinado?';
const TERRITORY_VARIATION = 'A nossa área é bem restrita. Trabalhamos exclusivamente em Novato, San Rafael e Petaluma, na Califórnia. Fora dessas três cidades, recuse o pedido, a menos que eu aprove a exceção explicitamente. Essa aprovação tem que ser caso a caso.';
const HOURS = 'De segunda a sexta, das sete da manhã às sete da noite. Aos sábados, das oito da manhã às cinco da tarde. Domingo não tem atendimento comum, apenas emergência previamente aprovada pelo dono. Tudo no horário do Pacífico, América Los Angeles, incluindo o horário de verão.';
const WARRANTY = 'Para todos os nossos serviços, as peças elegíveis têm garantia de doze anos do fabricante, com registro e manutenção exigidos pelo fabricante. A nossa empresa oferece dois anos de garantia da mão de obra. Ficam excluídos desgaste normal, uso indevido, alterações de terceiros e peças fornecidas pelo cliente. Qualquer exceção depende da minha aprovação.';
const CANCELLATION = 'Pode pedir cancelamento ou reagendamento com vinte e quatro horas de antecedência, sem taxa. Com menos antecedência, falta do cliente ou acesso impossível, encaminhe ao dono antes de confirmar alteração ou cobrança. Não cobramos taxa automática por ausência. Depósito só quando estiver no orçamento aprovado pelo dono.';
const SERVICES = {
  air_quality_and_smoke_season_services: ['qualidade do ar e serviços para a época de fumaça', 250, 120, true],
  comfort_plan_maintenance: ['plano de manutenção Comfort Plan', 24, 90, false],
  filter_cabinet_upgrade: ['melhoria do gabinete de filtros', 1450, 180, false],
  heat_pump_installation: ['instalação de bomba de calor', 15000, 480, false],
  light_commercial_hvac: ['climatização comercial de pequeno porte', 380, 180, false],
  new_system_assessment: ['avaliação de um sistema novo', 0, 60, false],
  repair: ['reparo de climatização', 180, 120, true],
  repair_diagnostic: ['diagnóstico para reparo', 89, 60, true],
  same_day_repair: ['reparo no mesmo dia', 320, 120, true],
  single_zone_ductless_heat_pump_installation: ['instalação de bomba de calor sem dutos para uma zona', 11900, 480, false],
};
const GLOBAL_ANSWERS = {
  'area.coverage': TERRITORY,
  'area.out_of_area_policy': TERRITORY_VARIATION,
  'area.travel_fee': 'Dentro das três cidades atendidas não cobramos deslocamento. Para qualquer exceção fora da área, o dono precisa aprovar antes o atendimento e o valor do deslocamento. Não confirme nem cobre uma taxa por conta própria.',
  'schedule.business_hours': HOURS,
  'schedule.holidays': 'Nos feriados não há atendimento normal. Somente emergências previamente aprovadas pelo dono. Essa regra vale para todos os serviços.',
  'schedule.same_day_lead_time': 'Para atendimento comum no mesmo dia, o pedido precisa chegar até o meio-dia e ter pelo menos duas horas de antecedência. A disponibilidade deve ser consultada, e a confirmação depende do dono. Aos domingos vale apenas a regra de emergência.',
  'schedule.capacity_buffer': 'Reserve trinta minutos de intervalo entre atendimentos e no máximo três visitas por técnico por dia. A duração de cada serviço também precisa caber na agenda. Nunca confirme um encaixe sem aprovação do dono.',
  'service.catalog_closure': 'Confirmo os dez serviços que você encontrou no website. Essa é a lista completa, não há outro serviço para acrescentar. Mantenha os nomes e as condições publicados, com as correções que eu informar nesta entrevista.',
  'authority.quote_price': 'Pode informar somente os preços públicos e suas condições já confirmadas. Não pode prometer preço final, oferecer desconto, fechar orçamento ou cobrar por conta própria; isso depende da aprovação explícita do dono.',
  'authority.negotiate_floor': 'Não autorizo negociação nem desconto automático em nenhum serviço. Não há mínimo privado liberado para o Ligou. Qualquer exceção de preço precisa da minha aprovação explícita antes de ser apresentada ao cliente.',
  'authority.read_calendar': 'Pode consultar a agenda para ver disponibilidade, mas somente leitura. Essa permissão não autoriza reservar, confirmar, remarcar nem cancelar nada.',
  'authority.book': 'Pode coletar o horário desejado e consultar a disponibilidade. Só pode confirmar o agendamento depois da aprovação explícita do dono para aquele pedido.',
  'authority.reschedule_cancel': 'Pode receber o pedido de remarcação ou cancelamento e encaminhar ao dono. Precisa da minha aprovação explícita antes de alterar um compromisso.',
  'authority.charge_fee': 'Não pode confirmar cobrança nem cobrar taxa automaticamente. Apresente ao dono o motivo e o valor e espere aprovação explícita antes de comunicar uma cobrança.',
  'authority.emergency': 'Em emergência, pode coletar as informações e encaminhar ao dono imediatamente. Não pode prometer atendimento, disponibilidade, valor, despacho ou visita sem aprovação explícita do dono.',
  'authority.out_of_area': 'Fora de Novato, San Rafael e Petaluma, o padrão é não atender. Somente o dono pode aprovar explicitamente uma exceção para aquele endereço. O Ligou não pode ampliar a área nem aceitar a exceção sozinho.',
  'emergency.types': 'Consideramos emergência a perda total de aquecimento ou refrigeração quando há risco imediato para pessoas ou para equipamentos essenciais. O Ligou deve encaminhar a situação ao dono; classificar como urgente não autoriza confirmar o serviço.',
  'emergency.fee_authority': 'Somente o dono pode confirmar uma taxa de emergência ou de visita. A existência de um preço publicado não autoriza cobrar. Sempre aguarde aprovação explícita do valor para aquele pedido.',
  'policy.payment_estimate': 'Aceitamos cartão de crédito, cartão de débito e transferência bancária após o orçamento aprovado. Diagnóstico e avaliação não exigem depósito. Para instalação, o depósito é de vinte por cento do orçamento aprovado. Nenhuma cobrança pode ser feita sem autorização do dono.',
  'policy.warranty_materials': WARRANTY + ' Usamos materiais e peças fornecidos pela empresa. Material trazido pelo cliente exige análise e aprovação do dono antes de aceitar o trabalho.',
  'policy.access_cancellation': CANCELLATION,
  'policy.complaints_returns': 'Registre a reclamação, o serviço e um contato de retorno e encaminhe ao dono. Não prometa reembolso, visita gratuita, troca ou retrabalho antes de avaliação e aprovação explícita do dono.',
  'business.customer_types': 'Atendemos clientes residenciais e pequenos estabelecimentos comerciais, sempre dentro das três cidades confirmadas. Instalações industriais de grande porte não fazem parte do atendimento.',
  'business.excluded_work': 'Não fazemos obras industriais de grande porte, encanamento, reformas estruturais nem serviços fora do nosso catálogo de climatização. Não prometa esses trabalhos. Pedidos fora da área também dependem da aprovação explícita do dono.',
  'business.languages_tone': 'Apresente-se como Ligou, agente de inteligência artificial da empresa, de forma clara, cordial e objetiva. Com os clientes, atenda em inglês ou espanhol. Nesta configuração, fale comigo em português brasileiro.',
};

function sourceAnswer(question) {
  const q = normalize(question);
  if (q.includes('fuso horario')) return 'Nosso fuso é o horário do Pacífico, América Los Angeles. Considere o horário de verão quando estiver em vigor.';
  if (q.includes('feriados')) return GLOBAL_ANSWERS['schedule.holidays'];
  if (q.includes('garantias')) return WARRANTY;
  if (q.includes('cancelamento')) return CANCELLATION;
  if (q.includes('taxas adicionais')) return 'Não há adicional fixo para emergência ou fora do horário publicado. O dono avalia cada pedido e aprova o orçamento antes de qualquer promessa ou cobrança. Essa regra vale para todos os serviços.';
  if (q.includes('limites exatos')) return TERRITORY_VARIATION;
  if (q.includes('sabado') || q.includes('domingo')) return HOURS;
  return null;
}

function answerFor(item) {
  for (const ref of item.coverageRefs) {
    if (GLOBAL_ANSWERS[ref]) return GLOBAL_ANSWERS[ref];
    if (ref.startsWith('discovery.owner_question.')) return sourceAnswer(item.questionPt);
    if (!ref.startsWith('service:')) continue;
    const [, subject, field] = ref.split(':');
    const service = SERVICES[subject];
    if (!service) return null;
    const [name, price, duration, emergency] = service;
    if (['service.price_mode', 'service.price_target'].includes(field)) {
      if (subject === 'comfort_plan_maintenance') return 'O plano Comfort Plan custa vinte e quatro dólares por mês, por sistema. É uma mensalidade fixa nessas condições, não uma visita avulsa. Confirme essa condição em toda informação de preço.';
      if (subject === 'repair_diagnostic') return 'O diagnóstico custa oitenta e nove dólares. Esse valor é creditado no reparo quando o cliente aprova o conserto. Preserve essa condição; não é uma visita gratuita sem condição.';
      return `Para ${name}, o preço público é a partir de ${price} dólares. O valor final depende de orçamento aprovado pelo dono; não há autorização para desconto automático.`;
    }
    if (field === 'service.negotiation') return GLOBAL_ANSWERS['authority.negotiate_floor'];
    if (field === 'service.duration') return `A duração típica de ${name} é de ${duration} minutos. Essa é uma estimativa para uma visita, não uma promessa de horário ou disponibilidade.`;
    if (field === 'service.inclusions_exclusions') return `Para ${name}, estão incluídos a avaliação técnica e o trabalho especificado no orçamento aprovado. Ficam fora obras estruturais, elétrica adicional, peças extras e outros serviços não descritos no orçamento. Qualquer extra exige aprovação do dono.`;
    if (field === 'service.materials_parts') return 'Para todos os nossos serviços, usamos materiais e peças fornecidos pela empresa e descritos no orçamento. Peças extras são orçadas separadamente. Material do cliente só pode ser aceito depois da aprovação explícita do dono.';
    if (field === 'service.warranty') return WARRANTY;
    if (field === 'service.emergency_eligibility') return emergency
      ? `O serviço de ${name} pode ser avaliado como emergência quando houver o risco definido na nossa política. Isso não autoriza aceitar ou despachar sozinho; é necessária aprovação explícita do dono.`
      : `O serviço de ${name} não é oferecido como emergência. Deve seguir o agendamento normal, sujeito à aprovação do dono.`;
    if (field === 'service.escalation') return 'Para todos os nossos serviços, encaminhe ao dono qualquer desconto, preço final, cobrança, agendamento, mudança de compromisso, emergência, exceção de área, dúvida técnica ou alteração de garantia. Aguarde aprovação explícita antes de confirmar a ação.';
  }
  return null;
}

export function buildAnswerPlan(projection, fixtureHash) {
  const clips = new Map();
  const clip = (text, label) => {
    const id = `pt-${sha(text).slice(0, 16)}`;
    if (!clips.has(id)) clips.set(id, { id, filename: `caller/${id}.wav`, text, labels: [label], synthesis: { engine: 'macOS say', voice: 'Luciana', language: 'pt-BR', rate: 185 } });
    else clips.get(id).labels.push(label);
    return id;
  };
  const items = projection.seeds.map(item => {
    const answer = answerFor(item);
    return { itemId: item.id, questionPt: item.questionPt, subject: item.subject, coverageRefs: item.coverageRefs,
      relatedItemIds: item.relatedItemIds, blocking: item.blocking, answerClipId: answer ? clip(answer, item.id) : null };
  });
  const specials = {
    acknowledgment: clip('Ah, entendi.', 'initial_acknowledgment'),
    variedTerritory: clip(TERRITORY_VARIATION, 'territory_paraphrase'),
    offScope: clip('Antes de continuar, você consegue escrever um texto de propaganda para o meu website?', 'off_scope_request'),
    correction: clip('Preciso corrigir o preço do diagnóstico que está no website. O preço correto é noventa e nove dólares, creditados no reparo aprovado. São noventa e nove, não oitenta e nove. Mantenha as outras informações.', 'candidate_price_correction'),
    approval: clip('Eu revisei o resumo e aprovo explicitamente esta configuração, com as correções que confirmei.', 'explicit_recap_approval'),
  };
  return { schema: 'ligou.browser_audio_answer_plan.v1', provenance: { fixturePath: path.relative(ROOT, FIXTURE), fixtureHash,
      draftHash: projection.provenance.draftHash, sourceResultHash: projection.provenance.sourceResultHash,
      seedsHash: projection.seedsHash, itemCount: projection.seeds.length, candidateCount: projection.candidateRecap.length },
    policyNotice: 'Fictional owner answers for an isolated Foghorn fixture test only; never real-owner policy or authorization.',
    items, candidateRecap: projection.candidateRecap, specials, clips: [...clips.values()],
    unhandledItems: items.filter(item => !item.answerClipId).map(item => ({ itemId: item.itemId, questionPt: item.questionPt })),
    scenarios: { normal: { initialAcknowledgment: true }, variation: { variedTerritory: true, offScopeAfterAnswers: 1, correctionDuringSummary: true },
      recovery: { failOneSpeechReadAfterAnswers: 1, resumeThroughUi: true } } };
}

function wavSignal(buffer, expectedRate = 48000) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') fail('not_pcm_wav');
  let offset = 12, rate, channels, bits, pcm;
  while (offset + 8 <= buffer.length) {
    const tag = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (tag === 'fmt ') { channels = buffer.readUInt16LE(start + 2); rate = buffer.readUInt32LE(start + 4); bits = buffer.readUInt16LE(start + 14); }
    if (tag === 'data') pcm = buffer.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (!pcm || channels !== 1 || bits !== 16 || rate !== expectedRate) fail('unexpected_wav_format');
  const count = pcm.length / 2;
  let first = null, last = null, peak = 0;
  for (let index = 0; index < count; index++) {
    const amplitude = Math.abs(pcm.readInt16LE(index * 2)) / 32768;
    peak = Math.max(peak, amplitude);
    if (amplitude > 0.001) { first ??= index; last = index; }
  }
  return { durationMs: count / rate * 1000, sampleRate: rate, channels, bitsPerSample: bits,
    signalFirstMs: first === null ? null : first / rate * 1000, signalLastMs: last === null ? null : last / rate * 1000,
    signalThreshold: 0.001, peak, bytes: buffer.length, sha256: sha(buffer) };
}

async function synthesizeClips(plan, output) {
  await mkdir(path.join(output, 'caller'), { recursive: true });
  let completed = 0;
  for (const clip of plan.clips) {
    const target = path.join(output, clip.filename);
    try { clip.audio = wavSignal(await readFile(target)); }
    catch {
      const aiff = path.join(output, 'caller', `${clip.id}.aiff`);
      const words = path.join(output, 'caller', `${clip.id}.txt`);
      await writeFile(words, clip.text + '\n', { mode: 0o600 });
      await localCommand('/usr/bin/say', ['-v', 'Luciana', '-r', String(clip.synthesis.rate), '-f', words, '-o', aiff]);
      await localCommand('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', target]);
      clip.audio = wavSignal(await readFile(target));
      await rm(aiff); await rm(words);
    }
    if (clip.audio.signalFirstMs === null) fail('silent_caller_fixture');
    if (++completed % 10 === 0) process.stdout.write(`Prepared ${completed}/${plan.clips.length} local caller clips.\n`);
  }
}

// Runs in the actual dashboard document. Only media input, observation and
// test controls are added; all production session/state logic stays in place.
export async function validateOwnerAudioFile(file, clip) {
  if (!file || typeof file.arrayBuffer !== 'function' || file.name !== clip?.basename
    || !/^[A-Za-z0-9_-]{1,160}$/.test(clip?.id ?? '') || !/^[a-f0-9]{64}$/.test(clip?.audio?.sha256 ?? '')
    || !Number.isFinite(file.size) || file.size < 44 || file.size > 25_000_000) throw new Error('owner_audio_file_invalid');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE') throw new Error('owner_audio_file_not_wav');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== clip.audio.sha256) throw new Error('owner_audio_file_hash_mismatch');
  return bytes;
}

export function safeProviderSessionConfig(session) {
  const allowed = (value, values) => values.includes(value) ? value : null;
  const boolean = value => typeof value === 'boolean' ? value : null;
  const transcription = session?.audio?.input?.transcription, vad = session?.audio?.input?.turn_detection;
  const languages = transcription?.languages;
  return { model: allowed(session?.model, ['gpt-realtime', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini']),
    reasoningEffort: allowed(session?.reasoning?.effort, ['minimal', 'low', 'medium', 'high', 'xhigh']),
    transcriptionModel: allowed(transcription?.model, ['gpt-live-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']),
    languages: Array.isArray(languages) && languages.length <= 8
      && languages.every(value => typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value)) ? [...languages] : null,
    vadType: allowed(vad?.type, ['semantic_vad', 'server_vad']), vadEagerness: allowed(vad?.eagerness, ['auto', 'low', 'medium', 'high']),
    createResponse: boolean(vad?.create_response), interruptResponse: boolean(vad?.interrupt_response) };
}

export function installBrowserHarness(settings, verifyOwnerAudioFile, readSessionConfig) {
  if (location.origin !== settings.origin || window.__voiceAcceptance) return;
  const state = { events: [], recordings: [], speech: null, stage: null, callId: null, clickAt: null,
    peers: [], inputs: [], sources: new Set(), observers: new Set(), outputSequence: 0, answered: 0,
    faultArmed: false, faultInjected: false, closed: false, context: null, outputElements: new Set(), responseCaptures: new Map(),
    ownerFiles: new Map(), recordingFiles: new Map(), recordingLinks: new Map() };
  const now = () => performance.now();
  const stamp = (event, details = {}) => state.events.push({ event, browserMs: now(),
    elapsedMs: state.clickAt === null ? null : now() - state.clickAt, ...details });
  const context = () => state.context ??= new AudioContext({ sampleRate: 48000 });
  const cleanId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value) ? value : null;
  const speech = value => {
    if (!value || value.schema !== 'onboarding.stream.v1' || !/^[a-f0-9]{64}$/.test(value.action?.actionId ?? '')
      || !cleanId(value.dispatchId)) return;
    const action = value.action;
    state.speech = { actionId: action.actionId, revision: action.revision, kind: action.kind,
      text: String(action.text).slice(0, 8192), dispatchId: value.dispatchId, callId: cleanId(action.callId), sourceDigest: action.sourceDigest };
    stamp('selected_speech', state.speech);
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const pathname = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname;
    const isSpeechRead = pathname.endsWith('/rpc/read_website_interview_stream');
    const isBootstrap = /\/(?:session|voice-session|browser-session)$/.test(pathname);
    if (isSpeechRead && state.faultArmed && !state.faultInjected) {
      state.faultInjected = true; stamp('isolated_fault_injected', { kind: 'one_browser_speech_read_network_failure' });
      throw new TypeError('Synthetic isolated acceptance network failure');
    }
    const began = now();
    if (isSpeechRead || isBootstrap) stamp(isSpeechRead ? 'opening_or_next_speech_read_started' : 'bootstrap_fetch_started');
    const response = await nativeFetch(...args);
    const headersMs = now() - began;
    const edgeServerTiming = {};
    if (isBootstrap) {
      // Only fixed numeric Edge metric names enter the diagnostic artifact.
      // Never copy arbitrary headers, which may contain session credentials.
      for (const part of (response.headers.get('Server-Timing') ?? '').split(',')) {
        const match = part.trim().match(/^(edge_(?:config|auth|body_contract|tenant|enqueue|wait_ready|opening_validate|call_model|cleanup|serialize|poll_sleep|poll_read|total));dur=(\d+(?:\.\d+)?)$/);
        if (match && Number(match[2]) <= 300_000) edgeServerTiming[match[1]] = Number(match[2]);
      }
    }
    if (isSpeechRead || isBootstrap) {
      stamp(isSpeechRead ? 'opening_or_next_speech_read_headers' : 'bootstrap_response_headers', { status: response.status, headersMs, ...(isBootstrap ? { edgeServerTiming } : {}) });
      void response.clone().json().then(data => {
        stamp(isSpeechRead ? 'opening_or_next_speech_read_body' : 'bootstrap_response_body', { bodyCompleteMs: now() - began });
        if (isSpeechRead) speech(data);
        else if (data?.call_id) {
          state.callId = cleanId(data.call_id);
          state.bootstrap = { callId: state.callId, roundTripMs: now() - began, status: response.status, maxMinutes: data.max_minutes,
            responseHeadersMs: headersMs, edgeServerTiming,
            model: data.model, protocolVersion: data.onboarding_protocol_version, openingVersion: data.opening_payload?.version,
            speechCallId: cleanId(data.opening_payload?.stream?.action?.callId), openingMode: data.opening_mode_applied };
          stamp('bootstrap_observed', state.bootstrap);
          speech(data.opening_payload?.stream);
        }
      }).catch(() => stamp('observed_payload_unavailable', { status: response.status }));
    }
    return response;
  };
  const NativePeer = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args); state.peers.push(this);
      this.addEventListener('connectionstatechange', () => stamp('peer_state', { state: this.connectionState }));
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      channel.addEventListener('message', message => {
        try {
          const event = JSON.parse(message.data);
          observeStreamEvent(event);
          if (event.type === 'session.updated') {
            // Select fixed configuration fields only; a session can contain secrets.
            stamp('provider_event', { type: event.type, sessionConfig: readSessionConfig(event.session) });
            return;
          }
          if (['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped',
            'conversation.item.input_audio_transcription.completed', 'conversation.item.input_audio_transcription.failed',
            'response.created', 'response.done', 'response.output_audio_transcript.done',
            'output_audio_buffer.started', 'output_audio_buffer.stopped', 'output_audio_buffer.cleared', 'error'].includes(event.type)) {
            const details = { type: event.type, itemId: cleanId(event.item_id), code: cleanId(event.error?.code),
              responseId: cleanId(event.response?.id ?? event.response_id), eventId: cleanId(event.event_id), status: cleanId(event.response?.status) };
            if (event.type === 'response.done' && Array.isArray(event.response?.output)) {
              const shape = { count: event.response.output.length, functionCalls: 0, messages: 0, reasoning: 0, other: 0,
                matchingFunction: 0, completedFunction: 0, missingFunctionStatus: 0, otherFunctionStatus: 0 };
              for (const item of event.response.output) {
                if (item?.type === 'function_call') {
                  shape.functionCalls++;
                  if (item.name === 'submit_website_interview_proposal') {
                    shape.matchingFunction++;
                    if (item.status === 'completed') shape.completedFunction++;
                    else if (item.status === undefined) shape.missingFunctionStatus++;
                    else shape.otherFunctionStatus++;
                  }
                } else if (item?.type === 'message') shape.messages++;
                else if (item?.type === 'reasoning') shape.reasoning++;
                else shape.other++;
              }
              details.outputShape = shape;
            }
            if (settings.recordTestAudio && typeof event.transcript === 'string') details.transcript = event.transcript.slice(0, 8192);
            stamp('provider_event', details);
          }
        } catch { /* Non-JSON or unselected provider messages are not logged. */ }
      });
      channel.addEventListener('close', () => stamp('data_channel_closed'));
      return channel;
    }
  };
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
    if (!constraints?.audio || constraints.video) throw new DOMException('Audio-only test input', 'NotSupportedError');
    const ctx = context(); await ctx.resume();
    const destination = ctx.createMediaStreamDestination();
    const oscillator = ctx.createOscillator(), silence = ctx.createGain();
    silence.gain.value = 0; oscillator.connect(silence).connect(destination); oscillator.start();
    const input = { destination, track: destination.stream.getAudioTracks()[0], oscillator, silence };
    const stop = input.track.stop.bind(input.track);
    input.track.stop = () => { stop(); try { oscillator.stop(); oscillator.disconnect(); silence.disconnect(); } catch {} stamp('input_track_stopped'); };
    state.inputs.push(input); state.input = input; stamp('synthetic_input_acquired');
    return destination.stream;
  } });
  // Edge can starve the first capture when a second observer calls the native
  // method. Keep one root for this playback and give every observer a clone;
  // ending an observer must not end another observer's audio source.
  const capturedElements = new WeakMap(), captureRoots = new Set();
  const nativeCapture = HTMLMediaElement.prototype.captureStream;
  if (typeof nativeCapture === 'function') {
    HTMLMediaElement.prototype.captureStream = function (...args) {
      let capture = capturedElements.get(this);
      if (capture && !capture.stream.getTracks().some(track => track.readyState === 'live')) { capture.release(); capture = null; }
      if (!capture) {
        const element = this, stream = nativeCapture.apply(element, args);
        const release = () => {
          for (const event of ['ended', 'emptied', 'error']) element.removeEventListener(event, release);
          if (capturedElements.get(element)?.stream === stream) capturedElements.delete(element);
          captureRoots.delete(release);
          for (const track of stream.getTracks()) track.stop();
        };
        capture = { stream, release };
        capturedElements.set(element, capture); captureRoots.add(release);
        for (const event of ['ended', 'emptied', 'error']) element.addEventListener(event, release, { once: true });
      }
      return capture.stream.clone();
    };
  }
  function startOutputCapture(audio, selected, responseId = null) {
    const index = ++state.outputSequence, startedBrowserMs = now();
    const startedElapsedMs = state.clickAt === null ? null : startedBrowserMs - state.clickAt;
    stamp(responseId ? 'output_capture_started' : 'output_playing', { outputIndex: index, actionId: selected?.actionId,
      dispatchId: selected?.dispatchId, responseId, kind: selected?.kind, volume: audio.volume, muted: audio.muted });
    let stream, source, recorder, frame, gate, destination, stopped = false, nonzero = false;
    const chunks = [], capture = { responseId, selected, finish: null, providerStatus: null, providerTranscript: null };
    const syncGate = () => {
      if (gate) gate.gain.value = !audio.muted && !audio.paused && audio.volume > 0 ? audio.volume : 0;
    };
    const cleanup = (reason = 'transport_closed') => {
      if (stopped) return; stopped = true; cancelAnimationFrame(frame);
      capture.stopReason = reason; capture.stoppedBrowserMs = now();
      audio.removeEventListener('volumechange', syncGate); audio.removeEventListener('pause', syncGate); audio.removeEventListener('playing', syncGate);
      try { if (recorder?.state !== 'inactive') recorder?.stop(); source?.disconnect(); gate?.disconnect(); } catch {}
      for (const track of stream?.getTracks?.() ?? []) track.stop();
      for (const track of destination?.stream?.getTracks?.() ?? []) track.stop();
      state.observers.delete(cleanup);
    };
    capture.finish = cleanup; state.observers.add(cleanup);
    try {
      stream = responseId && audio.srcObject?.clone ? audio.srcObject.clone() : audio.captureStream();
      if (!stream.getAudioTracks().length) throw new Error('capture_track_missing');
      const ctx = context(), analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      source = ctx.createMediaStreamSource(stream); gate = ctx.createGain();
      source.connect(gate); gate.connect(analyser); syncGate();
      // This observation branch has no connection to the speakers. Its gain
      // follows the real element so muted/cancelled output cannot be aligned as audible.
      audio.addEventListener('volumechange', syncGate); audio.addEventListener('pause', syncGate); audio.addEventListener('playing', syncGate);
      const samples = new Float32Array(analyser.fftSize);
      const inspect = () => {
        if (stopped) return; syncGate();
        if (ctx.state === 'running' && !audio.muted && !audio.paused && audio.volume > 0) {
          analyser.getFloatTimeDomainData(samples);
          if (!nonzero && samples.some(sample => Math.abs(sample) > 0.0001)) {
            nonzero = true; stamp('output_first_nonzero_sample', { outputIndex: index, actionId: selected?.actionId,
              dispatchId: selected?.dispatchId, responseId, evidence: responseId ? 'remote_webrtc_media' : 'media_element_capture' });
          }
        }
        frame = requestAnimationFrame(inspect);
      };
      inspect();
      if (settings.recordTestAudio) {
        destination = ctx.createMediaStreamDestination(); gate.connect(destination);
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
        recorder = new MediaRecorder(destination.stream, { mimeType: mime });
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = async () => {
          const bytes = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer());
          let binary = ''; for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
          const recording = { filename: 'output-' + String(index).padStart(4, '0') + '.webm', base64: btoa(binary),
            outputIndex: index, actionId: selected?.actionId, dispatchId: selected?.dispatchId, responseId,
            kind: selected?.kind, revision: selected?.revision, expectedText: selected?.text,
            startedBrowserMs, startedElapsedMs, stoppedBrowserMs: capture.stoppedBrowserMs,
            stopReason: capture.stopReason, providerStatus: capture.providerStatus, providerTranscript: capture.providerTranscript,
            bytes: bytes.length, captureEvidence: responseId ? 'actual_remote_stream_with_observed_output_gate' : 'actual_html_media_capture', nonzeroObserved: nonzero };
          const hash = await crypto.subtle.digest('SHA-256', bytes);
          recording.sha256 = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
          state.recordingFiles.set(recording.filename, { blob: new Blob(chunks, { type: mime }), recording });
          state.recordings.push(recording);
        };
        recorder.start(250);
      }
    } catch { stamp('output_capture_unavailable', { outputIndex: index, responseId }); }
    if (!responseId) audio.addEventListener('ended', () => {
      stamp('output_ended', { outputIndex: index, actionId: selected?.actionId }); cleanup('html_media_ended');
    }, { once: true });
    if (responseId) audio.addEventListener('pause', () => cleanup('media_paused'), { once: true });
    audio.addEventListener('emptied', () => cleanup('media_emptied'), { once: true });
    audio.addEventListener('error', () => cleanup('media_error'), { once: true });
    return capture;
  }
  function observeStreamEvent(event) {
    if (['conversation.item.created','conversation.item.done'].includes(event?.type)
      && event.item?.role === 'system' && event.item.content?.[0]?.text?.startsWith('ligou.website_stream:')) {
      try { speech(JSON.parse(event.item.content[0].text.slice('ligou.website_stream:'.length))); } catch { /* Observation only. */ }
    }
    const responseId = cleanId(event?.response?.id ?? event?.response_id);
    if (event?.type === 'response.created' && event.response?.metadata?.ligou_transport === 'realtime_stream_v1') {
      const binding = event.response.metadata, selected = state.speech;
      if (!responseId || !selected || state.responseCaptures.has(responseId)
        || binding.ligou_call_id !== state.callId || binding.ligou_dispatch_id !== selected.dispatchId
        || binding.ligou_action_id !== selected.actionId || binding.ligou_source_digest !== selected.sourceDigest) {
        stamp('unmatched_stream_response', { responseId }); return;
      }
      const audio = [...state.outputElements].find(element => element.srcObject?.getAudioTracks?.().length);
      if (!audio) { stamp('stream_output_element_unavailable', { responseId }); return; }
      state.responseCaptures.set(responseId, startOutputCapture(audio, selected, responseId));
    }
    const capture = state.responseCaptures.get(responseId);
    if (capture) {
      if (event.type === 'response.done') {
        capture.providerStatus = cleanId(event.response.status);
        const content = event.response.output?.find(item => item.type === 'message')?.content;
        capture.providerTranscript = settings.recordTestAudio ? content?.filter(part => ['audio','output_audio'].includes(part.type))
          .map(part => String(part.transcript ?? '')).join(' ').slice(0, 8192) : null;
        if (event.response.status !== 'completed') capture.finish('generation_' + (capture.providerStatus ?? 'unknown'));
      }
      if (event.type === 'output_audio_buffer.started') stamp('output_playing', { responseId,
        actionId: capture.selected.actionId, dispatchId: capture.selected.dispatchId, evidence: 'provider_output_buffer_started' });
      if (['output_audio_buffer.stopped','output_audio_buffer.cleared'].includes(event.type)) {
        stamp(event.type.endsWith('.stopped') ? 'output_buffer_stopped' : 'output_cleared', { responseId,
          actionId: capture.selected.actionId, dispatchId: capture.selected.dispatchId, eventId: cleanId(event.event_id), evidence: event.type });
        if (event.type.endsWith('.cleared')) capture.finish(event.type);
      }
    }
    if (event?.type === 'input_audio_buffer.speech_started') for (const current of state.responseCaptures.values()) current.finish('owner_barge_in');
  }
  function observeOutput(audio) {
    state.outputElements.add(audio);
    if (audio.__ligouAcceptanceObserved) return;
    audio.__ligouAcceptanceObserved = true;
    audio.addEventListener('playing', () => {
      if (audio.srcObject || audio.muted || audio.volume === 0 || state.closed) return;
      startOutputCapture(audio, state.speech);
    });
  }
  const nativeCreate = document.createElement.bind(document);
  document.createElement = (tag, options) => { const element = nativeCreate(tag, options); if (String(tag).toLowerCase() === 'audio') observeOutput(element); return element; };
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) { if (this instanceof HTMLAudioElement) observeOutput(this); return nativePlay.apply(this, args); };
  document.addEventListener('click', event => {
    if (event.target.closest?.('.voice-live-button')) {
      const observedBrowserMs = now();
      state.clickAt = Number.isFinite(event.timeStamp) && event.timeStamp >= 0 && event.timeStamp <= observedBrowserMs ? event.timeStamp : observedBrowserMs;
      state.speech = null; state.callId = null; state.bootstrap = null;
      stamp('start_clicked', { browserMs: state.clickAt, observedBrowserMs, trusted: event.isTrusted });
      void context().resume();
    }
  }, true);
  window.addEventListener('ligou:voice-timing', ({ detail }) => {
    const allowed = ['event', 'attemptId', 'elapsedMs', 'callId', 'audioRole', 'actionKind', 'actionId', 'dispatchId', 'responseId', 'evidence', 'reason', 'mediaDurationMs'];
    stamp('application_timing', Object.fromEntries(allowed.filter(key => Object.hasOwn(detail ?? {}, key)).map(key => [key === 'event' ? 'timingEvent' : key === 'elapsedMs' ? 'sourceElapsedMs' : key, detail[key]])));
    if (detail?.callId) state.callId = cleanId(detail.callId);
    if (detail?.event === 'speech_ended' && detail.evidence === 'webrtc_buffer_stop_and_local_media_drained') {
      const capture = state.responseCaptures.get(detail.responseId);
      if (capture && capture.selected.actionId === detail.actionId && capture.selected.dispatchId === detail.dispatchId) {
        stamp('output_ended', { responseId: detail.responseId, actionId: detail.actionId, dispatchId: detail.dispatchId, evidence: detail.evidence });
        capture.finish('browser_stream_drained');
      }
    }
  });
  async function playWavBytes(bytes, clip, allowBargeIn = false) {
      const input = state.input;
      if (!input || input.track.readyState !== 'live' || !input.track.enabled) throw new Error('input_gate_closed');
      const stage = document.querySelector('[data-voice-stage]')?.dataset.voiceStage;
      if (!allowBargeIn && stage !== 'ready') throw new Error('owner_turn_not_ready');
      const ctx = context(); await ctx.resume();
      const decoded = await ctx.decodeAudioData(bytes.buffer);
      if (!Number.isFinite(clip?.audio?.durationMs) || Math.abs(decoded.duration * 1000 - clip.audio.durationMs) > 2)
        throw new Error('caller_audio_duration_changed');
      if (state.input !== input || !input.track.enabled || input.track.readyState !== 'live') throw new Error('input_gate_changed');
      const source = ctx.createBufferSource(); source.buffer = decoded; source.connect(input.destination); state.sources.add(source);
      const began = now();
      stamp('caller_audio_start', { clipId: clip.id, filename: clip.filename, durationMs: decoded.duration * 1000,
        sourceSignalFirstBrowserMs: began + clip.audio.signalFirstMs, sourceSignalLastBrowserMs: began + clip.audio.signalLastMs, allowBargeIn });
      await new Promise(resolve => { source.onended = resolve; source.start(); });
      stamp('caller_audio_ended', { clipId: clip.id }); source.disconnect(); state.sources.delete(source);
      state.answered++;
  }
  window.__voiceAcceptance = {
    prepareOwnerFileInput() {
      const id = 'ligou-owner-audio-files';
      let input = document.getElementById(id);
      if (!input) {
        input = document.createElement('input'); input.id = id; input.type = 'file'; input.multiple = true;
        input.accept = '.wav,.json,audio/wav,application/json'; input.hidden = true;
        document.body.append(input);
      }
      return { selector: '#' + id, selectedFiles: input.files?.length ?? 0 };
    },
    async loadOwnerAudioFiles() {
      if (typeof verifyOwnerAudioFile !== 'function') throw new Error('owner_audio_verifier_unavailable');
      const files = [...(document.getElementById('ligou-owner-audio-files')?.files ?? [])];
      const file = files.find(value => value.name === 'owner-audio-manifest.json');
      if (!file || file.size > 2_000_000) throw new Error('owner_audio_manifest_missing');
      const manifest = JSON.parse(await file.text());
      if (manifest?.schema !== 'ligou.in_app_owner_audio.v1' || manifest.isolatedTestOnly !== true
        || manifest.provenance?.itemCount !== 114 || manifest.provenance?.candidateCount !== 21
        || manifest.items?.length !== 114 || !Array.isArray(manifest.clips) || manifest.clips.length > 180)
        throw new Error('owner_audio_manifest_invalid');
      const loaded = new Map();
      for (const clip of manifest.clips) {
        if (loaded.has(clip.id)) throw new Error('owner_audio_clip_duplicate');
        const selected = files.filter(value => value.name === clip.basename);
        if (selected.length !== 1) throw new Error('owner_audio_file_missing_or_duplicate');
        await verifyOwnerAudioFile(selected[0], clip);
        loaded.set(clip.id, { file: selected[0], clip });
      }
      state.ownerFiles = loaded;
      return { loaded: loaded.size, itemCount: manifest.items.length, fixtureHash: manifest.provenance.fixtureHash };
    },
    async playWavFile(clipId, allowBargeIn = false) {
      const selected = state.ownerFiles.get(clipId);
      if (!selected) throw new Error('owner_audio_clip_not_loaded');
      return playWavBytes(await verifyOwnerAudioFile(selected.file, selected.clip), selected.clip, allowBargeIn);
    },
    async playWav(base64, clip, allowBargeIn = false) {
      return playWavBytes(Uint8Array.from(atob(base64), char => char.charCodeAt(0)), clip, allowBargeIn);
    },
    recordingLink(filename) {
      const value = state.recordingFiles.get(filename);
      if (!value) throw new Error('recording_not_available');
      let link = state.recordingLinks.get(filename);
      if (!link) {
        link = document.createElement('a'); link.id = 'ligou-recording-' + value.recording.outputIndex;
        link.download = filename; link.href = URL.createObjectURL(value.blob); link.textContent = 'Download ' + filename;
        document.body.append(link); state.recordingLinks.set(filename, link);
      }
      return { selector: '#' + link.id, filename, bytes: value.recording.bytes, sha256: value.recording.sha256 };
    },
    armFault() { state.faultArmed = true; stamp('isolated_fault_armed'); },
    drain({ includeRecordingBytes = false } = {}) {
      const stage = document.querySelector('[data-voice-stage]')?.dataset.voiceStage ?? null;
      if (stage !== state.stage) { state.stage = stage; stamp('ui_stage', { stage }); }
      const recordings = state.recordings.splice(0).map(recording => {
        if (includeRecordingBytes) return recording;
        const { base64, ...metadata } = recording; return metadata;
      });
      return { stage, callId: state.callId, bootstrap: state.bootstrap ?? null, speech: state.speech, events: state.events.splice(0), recordings,
        inputEnabled: state.input?.track.enabled === true && state.input?.track.readyState === 'live', faultInjected: state.faultInjected,
        uiText: document.querySelector('.voice-live')?.innerText?.slice(0, 20000) ?? null };
    },
    async cleanup() {
      state.closed = true;
      for (const source of state.sources) { try { source.stop(); } catch {} }
      for (const stop of [...state.observers]) stop();
      for (const release of [...captureRoots]) release();
      for (const input of state.inputs) if (input.track.readyState !== 'ended') input.track.stop();
      for (const peer of state.peers) if (peer.connectionState !== 'closed') peer.close();
      await state.context?.close(); await new Promise(resolve => setTimeout(resolve, 100));
    },
  };
}

// RJ requires browser work in Codex's own in-app surface. Keep this former
// entrypoint as an explicit failure so old CLI invocations cannot launch or
// close Edge, Chrome, Safari, or another native browser accidentally.
export async function openRealBrowser() {
  fail('native_browser_execution_disabled_use_codex_in_app');
}

export function buildBrowserHarnessSource(settings) {
  if (settings?.isolatedTestOnly !== true || settings.recordTestAudio !== true) fail('isolated_audio_test_required');
  let target;
  try { target = new URL(settings.origin); } catch { fail('in_app_origin_invalid'); }
  if (target.origin !== settings.origin || target.username || target.password
    || !(target.protocol === 'https:' || (target.protocol === 'http:' && ['127.0.0.1','localhost'].includes(target.hostname)))) fail('in_app_origin_invalid');
  return `(${installBrowserHarness.toString()})(${JSON.stringify({ origin: target.origin, recordTestAudio: true })},(${validateOwnerAudioFile.toString()}),(${safeProviderSessionConfig.toString()}));`;
}

export function buildOwnerFileManifest(plan, output) {
  if (plan?.schema !== 'ligou.browser_audio_answer_plan.v1' || plan.provenance?.itemCount !== 114
    || plan.provenance?.candidateCount !== 21 || plan.items?.length !== 114 || plan.unhandledItems?.length !== 0
    || !Array.isArray(plan.clips) || !path.isAbsolute(output)) fail('faithful_fixture_incomplete');
  const seen = new Set();
  const clips = plan.clips.map(clip => {
    if (typeof clip.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(clip.id) || seen.has(clip.id)
      || typeof clip.filename !== 'string' || path.isAbsolute(clip.filename) || clip.filename.split(/[\\/]/).includes('..')
      || !clip.filename.endsWith('.wav') || !HASH.test(clip.audio?.sha256 ?? '')
      || !Number.isFinite(clip.audio?.durationMs) || clip.audio.durationMs <= 0) fail('owner_audio_file_invalid');
    seen.add(clip.id);
    return { id: clip.id, filename: clip.filename, basename: path.basename(clip.filename),
      absolutePath: path.resolve(output, clip.filename), audio: { ...clip.audio } };
  });
  if (new Set(clips.map(clip => clip.basename)).size !== clips.length) fail('owner_audio_file_name_collision');
  return { schema: 'ligou.in_app_owner_audio.v1', isolatedTestOnly: true, provenance: { ...plan.provenance },
    policyNotice: plan.policyNotice, items: plan.items, candidateRecap: plan.candidateRecap, specials: plan.specials,
    clips, browserAudioVerified: false, browserSurface: 'codex_in_app_only' };
}

export async function writeInAppHarnessArtifacts({ origin, output = DEFAULT_OUTPUT }) {
  const source = buildBrowserHarnessSource({ origin, isolatedTestOnly: true, recordTestAudio: true });
  const plan = JSON.parse(await readFile(path.join(output, 'answer-plan.json'), 'utf8'));
  const manifest = buildOwnerFileManifest(plan, output);
  const directory = path.join(output, 'in-app');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const observerPath = path.join(directory, 'observer.js'), manifestPath = path.join(directory, 'owner-audio-manifest.json');
  await writeFile(observerPath, source, { mode: 0o600 });
  await writeFile(manifestPath, json(manifest), { mode: 0o600 });
  return { schema: 'ligou.in_app_harness_artifacts.v1', observerPath, observerSha256: sha(source), manifestPath,
    manifestSha256: sha(json(manifest)), clips: manifest.clips.length, items: manifest.items.length,
    browserExecution: 'NOT_RUN', nativeBrowserExecution: 'DISABLED', providerCalls: 0 };
}

export function validateExecution(config, options, plan, session) {
  if (!options.execute) fail('execution_not_requested');
  if (config.schema !== 'ligou.voice_audio_acceptance_config.v1' || config.isolatedTestOnly !== true) fail('isolated_test_config_required');
  if (!['interview', 'start-sample'].includes(options.mode ?? 'interview')) fail('unknown_run_mode');
  if (typeof config.targetUrl !== 'string' || typeof config.supabaseUrl !== 'string') fail('execution_urls_not_prepared');
  const target = new URL(config.targetUrl), backend = new URL(config.supabaseUrl);
  if (target.protocol !== 'https:' || backend.protocol !== 'https:' || target.search || target.hash || target.username || backend.username) fail('invalid_execution_url');
  if (![config.expectedOwnerId, config.expectedTenantId].every(value => UUID.test(value ?? ''))
    || !Number.isSafeInteger(config.expectedGeneration) || config.expectedGeneration < 0
    || ![config.expectedDraftHash, config.expectedResultHash].every(value => HASH.test(value ?? ''))) fail('isolated_identity_proof_required');
  if (session.user?.id !== config.expectedOwnerId || !session.user?.email?.endsWith('@ligou.test')) fail('auth_not_controlled_test_owner');
  if (typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') fail('test_auth_missing');
  const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  if (claims.sub !== config.expectedOwnerId || claims.exp * 1000 < Date.now() + 60_000) fail('test_auth_expired_or_wrong_owner');
  if (plan.provenance.itemCount !== 114 || plan.provenance.candidateCount !== 21 || plan.unhandledItems.length) fail('faithful_fixture_incomplete');
  if (config.recordSyntheticTestAudio !== true) fail('test_audio_evidence_not_enabled');
  if (options.condition === 'cold' && !config.coldDefinition?.trim()) fail('cold_definition_required');
  if (options.scenario === 'recovery' && config.allowIsolatedBrowserReadFault !== true) fail('isolated_fault_not_configured');
  if (!Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1 || config.maxTurns > 180
    || !Number.isFinite(config.maxSessionSeconds) || config.maxSessionSeconds < 1 || config.maxSessionSeconds > 3600
    || !Number.isFinite(config.sessionMaxMinutes) || config.maxSessionSeconds > config.sessionMaxMinutes * 60) fail('explicit_session_limits_required');
  if ((options.mode ?? 'interview') === 'interview' && options.count !== 1) fail('prepare_each_complete_interview_separately');
  if (options.condition === 'warm' && options.count > 10 || options.condition === 'cold' && options.count > 5) fail('startup_sample_budget_exceeded');
  return true;
}

async function loadPublicRuntime(config) {
  const allowed = new Set(['SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY']);
  const values = {};
  if (config.publicEnvFile) {
    const contents = await readFile(config.publicEnvFile, 'utf8');
    for (const line of contents.split('\n')) {
      const match = /^(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match && allowed.has(match[1])) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    }
  }
  config.supabaseUrl ??= values.SUPABASE_URL ?? values.VITE_SUPABASE_URL ?? null;
  const key = process.env[config.publishableKeyEnv ?? 'SUPABASE_PUBLISHABLE_KEY']
    ?? process.env.SUPABASE_ANON_KEY ?? values.SUPABASE_PUBLISHABLE_KEY ?? values.SUPABASE_ANON_KEY;
  if (!key) fail('publishable_key_environment_missing');
  if (!key.startsWith('sb_publishable_')) {
    let claims;
    try { claims = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch {}
    if (claims?.role !== 'anon') fail('publishable_key_role_invalid');
  }
  publicRuntime.set(config, { key });
}

async function authenticatedRead(config, session, pathname, body) {
  const runtime = publicRuntime.get(config);
  // Supabase in the real dashboard owns normal token refresh. Read its current
  // controlled session privately so a long interview cannot leave teardown
  // verification using the stale token that launched the browser.
  if (runtime?.browser && session.expires_at * 1000 < Date.now() + 120_000) {
    const authKey = `sb-${new URL(config.supabaseUrl).hostname.split('.')[0]}-auth-token`;
    const fresh = await runtime.browser.evaluate(`(()=>{const value=localStorage.getItem(${JSON.stringify(authKey)});return value?JSON.parse(value):null;})()`);
    if (fresh?.user?.id !== config.expectedOwnerId) fail('refreshed_auth_owner_mismatch');
    if (typeof fresh.access_token === 'string' && fresh.expires_at > session.expires_at) Object.assign(session, fresh);
  }
  const key = publicRuntime.get(config)?.key;
  if (!key) fail('publishable_key_environment_missing');
  const response = await fetch(new URL(pathname, config.supabaseUrl), { method: body ? 'POST' : 'GET',
    headers: { apikey: key, Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) fail(`owner_read_http_${response.status}`);
  return await response.json();
}

async function checkIsolation(config, session, read = authenticatedRead) {
  const rows = await read(config, session,
    `/rest/v1/tenants?id=eq.${config.expectedTenantId}&select=id,owner_user_id,test_memory_generation,operational_mode,session_max_minutes,daily_budget_usd`);
  const tenant = rows?.length === 1 ? rows[0] : null;
  if (tenant?.id !== config.expectedTenantId || tenant.owner_user_id !== config.expectedOwnerId
    || tenant.test_memory_generation !== config.expectedGeneration) fail('live_test_tenant_binding_mismatch');
  if (typeof config.expectedOperationalMode !== 'string' || tenant.operational_mode !== config.expectedOperationalMode) fail('unexpected_operational_mode');
  if (Number(tenant.session_max_minutes) !== config.expectedTenantSessionMaxMinutes || Number(tenant.daily_budget_usd) !== config.expectedDailyBudgetUsd) fail('existing_budget_or_session_cap_changed');
  const [setup,drafts] = await Promise.all([
    read(config, session, '/rest/v1/rpc/company_discovery_setup_status', {}),
    read(config, session, `/rest/v1/company_discovery_onboarding_drafts?tenant_id=eq.${tenant.id}&order=version.desc&limit=1&select=id,tenant_id,created_by,draft_hash,source_job_id,source_result_id`),
  ]);
  const draft = drafts?.length === 1 ? drafts[0] : null;
  if (draft?.tenant_id !== tenant.id || draft.created_by !== config.expectedOwnerId || draft.draft_hash !== config.expectedDraftHash
    || ![draft.id,draft.source_job_id,draft.source_result_id].every(value=>UUID.test(value??''))) fail('live_website_source_mismatch');
  const [results,jobs] = await Promise.all([
    read(config, session, `/rest/v1/worker_results?id=eq.${draft.source_result_id}&tenant_id=eq.${tenant.id}&select=id,tenant_id,job_id,attempt_id,result_hash,validation_state,result_schema`),
    read(config, session, `/rest/v1/worker_jobs?id=eq.${draft.source_job_id}&tenant_id=eq.${tenant.id}&select=id,tenant_id,selected_attempt_id,status`),
  ]);
  const result = results?.length === 1 ? results[0] : null, job = jobs?.length === 1 ? jobs[0] : null;
  if (result?.id !== draft.source_result_id || result.tenant_id !== tenant.id || result.job_id !== draft.source_job_id
    || result.result_hash !== config.expectedResultHash || result.validation_state !== 'validated' || result.result_schema !== 'company_discovery.result.v2'
    || !UUID.test(result.attempt_id??'') || job?.id !== draft.source_job_id || job.tenant_id !== tenant.id
    || job.selected_attempt_id !== result.attempt_id || job.status !== 'awaiting_review') fail('live_website_source_mismatch');
  const proof = {job_id:job.id,attempt_id:result.attempt_id,result_id:result.id,result_hash:result.result_hash,draft_id:draft.id,draft_hash:draft.draft_hash};
  // Setup readiness legitimately disappears on completion; source custody does
  // not. Verify the persisted source above, and reconcile any visible ready proof.
  if (setup?.ready_proof && Object.keys(proof).some(key=>setup.ready_proof[key]!==proof[key])) fail('live_website_source_mismatch');
  return { tenantId: tenant.id, ownerId: tenant.owner_user_id, generation: tenant.test_memory_generation,
    operationalMode: tenant.operational_mode, setupState: setup?.state??null, websiteProof: proof };
}

async function verifyBootstrap(config, session, bootstrap) {
  if (bootstrap.protocolVersion !== 4 || bootstrap.openingVersion !== 4 || bootstrap.openingMode !== 'realtime_stream_v1' || bootstrap.speechCallId !== bootstrap.callId
    || !UUID.test(bootstrap.callId ?? '') || !Number.isFinite(bootstrap.maxMinutes) || bootstrap.maxMinutes < 1
    || bootstrap.maxMinutes > config.sessionMaxMinutes || !config.allowedModels?.includes(bootstrap.model)) fail('bootstrap_contract_mismatch');
  const reservations = await authenticatedRead(config, session,
    `/rest/v1/budget_reservations?call_id=eq.${bootstrap.callId}&select=id,tenant_id,call_id,reserved_cost_usd,status,budget_day`);
  const reservation = reservations?.length === 1 ? reservations[0] : null;
  if (reservation?.tenant_id !== config.expectedTenantId || Number(reservation.reserved_cost_usd) !== config.expectedPerCallBudgetUsd) fail('call_budget_reservation_mismatch');
  return { ...bootstrap, reservation };
}

async function terminalRead(config, session, callId, { timeoutMs = 180_000, read = authenticatedRead, now = () => performance.now(), wait = sleep } = {}) {
  if (!UUID.test(callId ?? '')) return { clean: false, reason: 'call_identity_unavailable' };
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    try {
      last = await read(config, session, '/rest/v1/rpc/get_website_interview_status', { p_call: callId });
      if (last.callId !== callId) fail('terminal_call_mismatch');
      const terminalCall = ['ended', 'error', 'killed_budget', 'killed_deadline'].includes(last.callStatus);
      const providerConfirmed = last.providerTerminationState === 'confirmed' || last.terminal?.providerConfirmed === true;
      if (terminalCall && providerConfirmed && last.budgetStatus === 'settled') return { clean: true, status: last };
    } catch { /* Bounded reconciliation; never infer teardown from a closed tab. */ }
    await wait(500);
  }
  return { clean: false, reason: 'terminal_or_budget_not_confirmed', status: last };
}

function completedInterview(status, callId, reservationId) {
  const terminal = status?.terminal;
  return status?.callId === callId && status.currentCallId === callId && status.state === 'complete' && status.completed === true
    && UUID.test(status.approvalReceiptId ?? '') && terminal?.outcome === 'complete' && terminal.callId === callId
    && terminal.approvalReceiptId === status.approvalReceiptId && terminal.providerConfirmed === true
    && terminal.interviewId === status.interviewId && terminal.budgetReservationId === reservationId
    && UUID.test(reservationId ?? '') && terminal.budgetSettled === true && terminal.callStatus === 'ended' && UUID.test(terminal.receiptId ?? '');
}

export function matchQuestion(plan, speech) {
  if (!speech || typeof speech.text !== 'string') return null;
  const spoken = normalize(speech.text);
  const matches = plan.items.filter(item => spoken.includes(normalize(item.questionPt)));
  // Longest exact source question wins over a shorter overlapping wording.
  matches.sort((a, b) => b.questionPt.length - a.questionPt.length);
  return matches[0] ?? null;
}

async function saveDrain(browser, result, directory) {
  const current = await browser.evaluate('window.__voiceAcceptance?.drain({includeRecordingBytes:true})');
  if (!current) return null;
  result.events.push(...current.events);
  for (const recording of current.recordings) {
    const bytes = Buffer.from(recording.base64, 'base64');
    delete recording.base64;
    if (bytes.length !== recording.bytes || bytes.length > 25_000_000) fail('recording_size_invalid');
    await writeFile(path.join(directory, recording.filename), bytes, { mode: 0o600 });
    result.recordings.push({ ...recording, sha256: sha(bytes) });
  }
  if (current.callId) result.callId = current.callId;
  result.lastUi = { stage: current.stage, text: current.uiText };
  return current;
}

async function waitFor(browser, expression, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { if (await browser.evaluate(expression)) return; await sleep(100); }
  fail('rendered_state_timeout');
}

async function playClip(browser, plan, clipId, output, result, allowBargeIn = false) {
  const clip = plan.clips.find(candidate => candidate.id === clipId);
  if (!clip?.audio) fail('caller_audio_not_prepared');
  if (Number.isFinite(result.sessionDeadlineHostMs) && performance.now() + clip.audio.durationMs > result.sessionDeadlineHostMs) fail('caller_clip_exceeds_remaining_session_budget');
  const bytes = await readFile(path.join(output, clip.filename));
  if (sha(bytes) !== clip.audio.sha256) fail('caller_audio_hash_mismatch');
  result.callerClips.push({ id: clip.id, filename: clip.filename, audio: clip.audio, allowBargeIn });
  const expression = `window.__voiceAcceptance.playWav(${JSON.stringify(bytes.toString('base64'))},${JSON.stringify({ id: clip.id, filename: clip.filename, audio: clip.audio })},${allowBargeIn})`;
  await browser.evaluate(expression, Math.ceil(clip.audio.durationMs) + 15000);
}

async function attempt(browser, config, session, options, plan, output, label) {
  const directory = path.join(output, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = { schema: 'ligou.real_browser_audio_attempt.v1', label, mode: options.mode ?? 'interview', scenario: options.scenario,
    harnessSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    condition: options.condition, coldDefinition: options.condition === 'cold' ? config.coldDefinition : null,
    warmDefinition: 'Dashboard JavaScript and page loaded; same browser profile and rendered panel reused between measured starts. A real voice session is started each time.',
    testFixture: plan.provenance, browser: path.basename(browser.executable), startedWallClock: new Date().toISOString(),
    clock: 'performance.now inside one dashboard document; cross-host clocks are not subtracted',
    events: [], recordings: [], callerClips: [], exercised: [], unhandled: [], callId: null, verdict: 'running' };
  let returned = false, acknowledged = false, offScope = false, corrected = false, approvalSent = false, resumed = false;
  let realAnswers = 0;
  const handled = new Set(), questionRepeats = new Map();
  const began = performance.now();
  try {
    result.isolationBefore = await checkIsolation(config, session);
    await waitFor(browser, 'Boolean(window.__voiceAcceptance)');
    result.dashboardScriptPaths = await browser.evaluate('Array.from(document.scripts).filter(script=>script.src).map(script=>new URL(script.src).pathname)');
    if (!await browser.evaluate('Boolean(document.querySelector(".voice-live-button"))')) {
      await waitFor(browser, `Boolean(document.querySelector(${JSON.stringify(config.openPanelSelector ?? '.website-setup-start')}))`);
      await browser.click(config.openPanelSelector ?? '.website-setup-start');
    }
    await waitFor(browser, 'Boolean(document.querySelector(".voice-live-button") && !document.querySelector(".voice-live-button").disabled)');
    await browser.click('.voice-live-button');
    const started = performance.now();
    result.sessionDeadlineHostMs = started + config.maxSessionSeconds * 1000;
    const verifiedCalls = new Set();
    result.bootstrapProofs = [];
    while (performance.now() < result.sessionDeadlineHostMs) {
      const current = await saveDrain(browser, result, directory);
      if (!current) { await sleep(100); continue; }
      if (current.bootstrap && !verifiedCalls.has(current.bootstrap.callId)) {
        const proof = await verifyBootstrap(config, session, current.bootstrap);
        verifiedCalls.add(proof.callId); result.bootstrapProofs.push(proof);
        process.stdout.write(json({ event: 'verified_test_call', callId: proof.callId, model: proof.model,
          protocolVersion: proof.protocolVersion, maxMinutes: proof.maxMinutes, reservedCostUsd: Number(proof.reservation.reserved_cost_usd) }));
        result.sessionDeadlineHostMs = Math.min(result.sessionDeadlineHostMs, performance.now() + proof.maxMinutes * 60_000);
      }
      const selected = current.speech;
      if (['ended', 'failed'].includes(current.stage)) {
        if (options.scenario === 'recovery' && current.faultInjected && !resumed) {
          result.cleanupBeforeResume = await terminalRead(config, session, result.callId);
          if (!result.cleanupBeforeResume.clean || result.cleanupBeforeResume.status?.resumeEligible !== true) fail('recovery_resume_not_durably_available');
          result.exercised.push('confirmed_failure_and_resume'); resumed = true; returned = false;
          await waitFor(browser, 'Boolean(document.querySelector(".voice-live-button") && !document.querySelector(".voice-live-button").disabled)');
          await browser.click('.voice-live-button'); continue;
        }
        returned = true; break;
      }
      if (result.mode === 'start-sample') {
        if (current.stage === 'ready' && selected && verifiedCalls.has(current.callId)
          && result.events.some(event => event.event === 'output_ended' && event.actionId === selected.actionId)) break;
        if (performance.now() - started > 45_000) fail('startup_sample_deadline');
        await sleep(100); continue;
      }
      if (options.scenario === 'variation' && selected?.kind === 'GENERATE_FINAL_SUMMARY' && !corrected
        && current.stage === 'playing') {
        if (!current.inputEnabled) fail('summary_barge_in_not_available');
        await sleep(1200);
        await playClip(browser, plan, plan.specials.correction, output, result, true);
        corrected = true; result.exercised.push('recap_interruption_and_candidate_correction');
        await sleep(250); continue;
      }
      if (current.stage !== 'ready' || !selected || !verifiedCalls.has(current.callId) || handled.has(`${current.callId}:${selected.dispatchId ?? selected.actionId}`)) { await sleep(100); continue; }
      if (result.callerClips.length >= config.maxTurns) fail('turn_budget_exhausted');
      handled.add(`${current.callId}:${selected.dispatchId ?? selected.actionId}`);
      if (selected.kind === 'REQUEST_FINAL_APPROVAL') {
        if (options.scenario === 'variation' && (!offScope || !corrected)) fail('variation_required_path_not_exercised');
        if (options.scenario === 'recovery' && !resumed) fail('recovery_path_not_exercised');
        result.beforeApproval = await authenticatedRead(config, session, '/rest/v1/rpc/get_website_interview_status', { p_call: result.callId });
        if (result.beforeApproval.revision !== selected.revision || !Array.isArray(result.beforeApproval.summaryParts)
          || !result.beforeApproval.summaryParts.length || result.beforeApproval.approvalReceiptId) fail('current_unapproved_recap_receipt_unavailable');
        const summaries = result.recordings.filter(recording => recording.kind === 'GENERATE_FINAL_SUMMARY' && recording.revision === selected.revision
          && recording.stopReason === 'browser_stream_drained' && recording.providerStatus === 'completed');
        if (!summaries.length || summaries.some(recording => !recording.nonzeroObserved)) fail('summary_playback_not_observed');
        if (!result.beforeApproval.summaryParts.every(part => summaries.some(recording => normalize(recording.expectedText) === normalize(part)))) fail('all_current_summary_parts_not_observed');
        if (options.scenario === 'variation' && !summaries.some(recording => /noventa e nove|\b99\b/i.test(recording.expectedText ?? ''))) fail('corrected_price_missing_from_recap');
        if (approvalSent) fail('duplicate_approval_request');
        await playClip(browser, plan, plan.specials.approval, output, result); approvalSent = true;
        result.exercised.push('explicit_current_recap_approval'); continue;
      }
      const item = matchQuestion(plan, selected);
      if (!item?.answerClipId) {
        result.unhandled.push({ actionId: selected.actionId, kind: selected.kind, spokenText: selected.text, reason: 'no_exact_prepared_question_match' });
        fail('unhandled_runtime_question');
      }
      if (options.scenario === 'normal' && !acknowledged) {
        acknowledged = true; await playClip(browser, plan, plan.specials.acknowledgment, output, result);
        result.exercised.push('initial_acknowledgment'); continue;
      }
      if (options.scenario === 'variation' && realAnswers >= 1 && !offScope) {
        offScope = true; await playClip(browser, plan, plan.specials.offScope, output, result);
        result.exercised.push('off_scope_request'); continue;
      }
      const repetitions = (questionRepeats.get(item.itemId) ?? 0) + 1;
      questionRepeats.set(item.itemId, repetitions);
      if (repetitions > 3) fail('repeated_question_without_verified_progress');
      if (options.scenario === 'recovery' && realAnswers === 0 && !current.faultInjected && !resumed) await browser.evaluate('window.__voiceAcceptance.armFault()');
      const clip = options.scenario === 'variation' && item.coverageRefs.includes('area.coverage') ? plan.specials.variedTerritory : item.answerClipId;
      await playClip(browser, plan, clip, output, result); realAnswers++;
    }
    if (result.mode === 'interview' && !returned) fail('interview_deadline');
    result.verdict = result.mode === 'start-sample' ? 'startup_observed_pending_cleanup_and_alignment' : 'ended_pending_durable_verification';
  } catch (error) {
    result.verdict = 'failed'; result.failureCode = /^[a-z0-9_]+$/.test(error.message) ? error.message : 'browser_audio_attempt_failed';
    try {
      result.failureUi = await browser.evaluate(`({path:location.pathname,text:document.body.innerText.slice(0,16000),buttons:Array.from(document.querySelectorAll('button')).map(button=>({text:button.innerText,disabled:button.disabled,className:button.className})),headings:Array.from(document.querySelectorAll('h1,h2')).map(node=>node.innerText)})`);
    } catch { /* Preserve the original failure when the browser is unavailable. */ }
  } finally {
    try { if (await browser.evaluate('Boolean(document.querySelector(".voice-live-hangup"))')) await browser.click('.voice-live-hangup'); } catch {}
    try { await sleep(100); await saveDrain(browser, result, directory); } catch {}
    result.cleanup = await terminalRead(config, session, result.callId);
    try { await saveDrain(browser, result, directory); } catch {}
    try { result.isolationAfter = await checkIsolation(config, session); } catch { result.isolationAfter = { verified: false }; }
    if (!result.cleanup.clean) { result.verdict = 'failed'; result.failureCode ??= 'cleanup_unconfirmed'; }
    if (result.isolationAfter?.operationalMode !== result.isolationBefore?.operationalMode) { result.verdict = 'failed'; result.failureCode ??= 'isolation_after_unconfirmed'; }
    if (result.mode === 'interview' && result.verdict !== 'failed') {
      const reservationId = result.bootstrapProofs?.find(proof => proof.callId === result.callId)?.reservation.id;
      result.verdict = completedInterview(result.cleanup.status, result.callId, reservationId) && approvalSent ? 'provider_audio_interview_completed_pending_alignment_review' : 'failed';
      if (result.verdict === 'failed') result.failureCode ??= 'durable_completion_not_proven';
    }
    result.elapsedHostMs = performance.now() - began;
    delete result.sessionDeadlineHostMs;
    result.endedWallClock = new Date().toISOString();
    result.artifactDirectory = directory;
    await writeFile(path.join(directory, 'result.json'), json(result), { mode: 0o600 });
  }
  return result;
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  if (fraction === 0.5) return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function questionPhrase(question) {
  const sentences = String(question).split(/(?<=[.!?])\s+/);
  return sentences.find(sentence => sentence.includes('?')) ?? sentences.find(sentence => /^(confirme|confirma|informe|explique)/i.test(sentence)) ?? null;
}

function alignedQuestion(words, phrase) {
  if (!phrase) return null;
  const target = normalize(phrase).split(' ').slice(0, 4);
  if (target.length < 3) return null;
  const actual = words.map(word => normalize(word.word));
  for (let index = 0; index <= actual.length - target.length; index++) {
    if (target.every((word, offset) => word === actual[index + offset] && (words[index + offset].probability ?? 0) >= 0.5)) return { offsetMs: words[index].start * 1000,
      endOffsetMs: words[index].end * 1000,
      matchedWords: words.slice(index, index + target.length).map(word => word.word).join(''), evidence: 'local_whisper_word_alignment' };
  }
  return null;
}

function firstVerifiedPhrase(words, expectedText) {
  const expected = normalize(expectedText ?? '').split(' ').filter(Boolean).slice(0, 10);
  for (let index = 0; index < words.length - 1; index++) {
    if ((words[index].probability ?? 0) < 0.5 || (words[index + 1].probability ?? 0) < 0.5) continue;
    const first = normalize(words[index].word), second = normalize(words[index + 1].word);
    if (expected.some((word, offset) => word === first && expected[offset + 1] === second)) return { offsetMs: words[index].start * 1000,
      endOffsetMs: words[index].end * 1000,
      matchedWords: words[index].word + words[index + 1].word, evidence: 'local_asr_matches_known_speech_prefix' };
  }
  return null;
}

function recordingSample(recording, events) {
  if (!(recording.bytes > 0) || recording.nonzeroObserved !== true || !Number.isSafeInteger(recording.outputIndex)
    || !recording.actionId || !Number.isFinite(recording.startedBrowserMs) || !Number.isFinite(recording.stoppedBrowserMs)) return null;
  const streamed = recording.captureEvidence === 'actual_remote_stream_with_observed_output_gate';
  if (streamed ? !recording.responseId || !recording.dispatchId : recording.captureEvidence !== 'actual_html_media_capture') return null;
  return (events ?? []).filter(event => event.event === 'output_first_nonzero_sample'
    && event.evidence === (streamed ? 'remote_webrtc_media' : 'media_element_capture')
    && event.outputIndex === recording.outputIndex && event.actionId === recording.actionId
    && (event.responseId ?? null) === (recording.responseId ?? null) && (event.dispatchId ?? null) === (recording.dispatchId ?? null)
    && Number.isFinite(event.browserMs) && event.browserMs >= recording.startedBrowserMs && event.browserMs <= recording.stoppedBrowserMs)
    .toSorted((left, right) => left.browserMs - right.browserMs)[0] ?? null;
}

export function alignCapturedWords(recording, events, waveform, words, questionPt) {
  const firstPhrase = firstVerifiedPhrase(words, recording.expectedText);
  const question = alignedQuestion(words, questionPhrase(questionPt));
  const alignment = { firstAsrTokenOffsetMs: words.length ? words[0].start * 1000 : null, firstVerifiedPhrase: firstPhrase,
    browserClock: { available: false, reason: 'matching_capture_sample_or_waveform_missing' },
    firstIntelligibleBrowserMs: null, actionableQuestion: null };
  const sample = recordingSample(recording, events);
  if (!sample || !Number.isFinite(waveform?.signalFirstMs) || waveform.signalFirstMs < 0
    || !Number.isFinite(waveform.signalLastMs) || waveform.signalLastMs < waveform.signalFirstMs
    || !Number.isFinite(waveform.durationMs) || waveform.durationMs < waveform.signalLastMs) return alignment;
  // Recorder start is not speech start. ASR may assign a word to leading
  // silence. Anchor to the same capture's observed signal without moving the
  // recording clock earlier; polling, codec and ASR timing remain estimates.
  const originBrowserMs = Math.max(recording.startedBrowserMs, sample.browserMs - waveform.signalFirstMs);
  alignment.browserClock = { available: true, method: 'conservative_captured_media_alignment',
    observedFirstNonzeroBrowserMs: sample.browserMs, waveformSignalFirstMs: waveform.signalFirstMs,
    waveformSignalLastMs: waveform.signalLastMs, waveformDurationMs: waveform.durationMs,
    waveformSha256: waveform.sha256, waveformSignalThreshold: waveform.signalThreshold,
    originBrowserMs, originAdjustmentMs: originBrowserMs - recording.startedBrowserMs };
  const browserTime = phrase => {
    if (!phrase || phrase.endOffsetMs < waveform.signalFirstMs || phrase.offsetMs > waveform.signalLastMs) return null;
    const time = originBrowserMs + Math.max(phrase.offsetMs, waveform.signalFirstMs);
    return Number.isFinite(time) && time <= recording.stoppedBrowserMs ? time : null;
  };
  alignment.firstIntelligibleBrowserMs = browserTime(firstPhrase);
  const questionMs = browserTime(question);
  alignment.actionableQuestion = questionMs === null ? null : { ...question, browserMs: questionMs };
  return alignment;
}

export async function alignRecordings(result, plan) {
  const directory = path.join(result.artifactDirectory, 'alignment');
  await mkdir(directory, { recursive: true });
  const status = { available: false, toolingAvailable: false, recordingCount: result.recordings.length,
    alignedRecordingCount: 0, model: 'cached local Whisper small', downloads: 0, paidApiCalls: 0 };
  for (const recording of result.recordings) recording.alignment = { available: false,
    reason: recording.bytes > 0 && recording.nonzeroObserved ? 'alignment_pending' : 'no_captured_audio_samples' };
  const model = path.join(process.env.HOME ?? '/Users/d1f', '.cache/whisper/small.pt');
  try { await access(model, constants.R_OK); await access('/opt/homebrew/bin/whisper', constants.X_OK); await access('/opt/homebrew/bin/ffmpeg', constants.X_OK); }
  catch { return { ...status, reason: 'cached_local_alignment_tools_unavailable' }; }
  status.toolingAvailable = true;
  const eligible = [], pending = [];
  for (const recording of result.recordings) {
    if (!(recording.bytes > 0) || !recording.nonzeroObserved) continue;
    const wav = path.join(directory, `${path.basename(recording.filename, '.webm')}.wav`);
    const transcriptFile = path.join(directory, `${path.basename(wav, '.wav')}.json`);
    let recordingHash, waveform;
    try {
      const bytes = await readFile(path.join(result.artifactDirectory, recording.filename));
      recordingHash = sha(bytes);
      if (bytes.length !== recording.bytes || (recording.sha256 && recording.sha256 !== recordingHash)) throw new Error('recording_changed');
      await localCommand('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i',
        path.join(result.artifactDirectory, recording.filename), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
      waveform = wavSignal(await readFile(wav), 16000);
      if (waveform.signalFirstMs === null) throw new Error('silent_recording');
    } catch { recording.alignment = { available: false, reason: 'recording_missing_changed_or_undecodable' }; continue; }
    const entry = { recording, wav, transcriptFile, recordingHash, waveform };
    eligible.push(entry);
    let cached;
    try { cached = JSON.parse(await readFile(transcriptFile, 'utf8')); } catch {}
    if (cached?.sourceRecordingSha256 !== recordingHash) {
      // File names recur across attempts. Reuse only a transcript bound to these
      // exact media bytes, never a stale JSON file left by an earlier run.
      await rm(transcriptFile, { force: true }); pending.push(entry);
    }
  }
  if (pending.length) {
    process.stdout.write(`Aligning ${pending.length} actual output recordings with the cached local Whisper model.\n`);
    // An absolute existing model path prevents model download and uses no API.
    try {
      await localCommand('/opt/homebrew/bin/whisper', [...pending.map(entry => entry.wav), '--model', model, '--language', 'Portuguese', '--word_timestamps', 'True',
        '--condition_on_previous_text', 'False', '--temperature', '0', '--fp16', 'False', '--output_format', 'json', '--output_dir', directory],
      { timeoutMs: Math.max(120_000, pending.length * 90_000), maxBytes: 20_000_000 });
    } catch { for (const entry of pending) entry.failed = true; }
  }
  for (const { recording, transcriptFile, recordingHash, waveform, failed } of eligible) {
    if (failed) { recording.alignment = { available: false, reason: 'local_alignment_failed' }; continue; }
    let transcript;
    try {
      transcript = JSON.parse(await readFile(transcriptFile, 'utf8'));
      transcript.sourceRecordingSha256 = recordingHash;
      await writeFile(transcriptFile, json(transcript), { mode: 0o600 });
    } catch { recording.alignment = { available: false, reason: 'local_transcript_unavailable' }; continue; }
    const words = (transcript.segments ?? []).flatMap(segment => segment.words ?? [])
      .filter(word => normalize(word.word) && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start);
    if (!words.length) { recording.alignment = { available: false, reason: 'no_aligned_words' }; continue; }
    const item = matchQuestion(plan, { text: recording.expectedText });
    const captured = alignCapturedWords(recording, result.events, waveform, words, item?.questionPt);
    recording.alignment = { available: captured.browserClock.available, sourceRecordingSha256: recordingHash, transcript: transcript.text, ...captured,
      limitation: 'Conservative estimate of recognizable speech in captured browser media, bounded by waveform onset and its matching browser sample observation. Recorder, codec, polling and ASR timing are not a calibrated physical speaker clock; audibility and comprehension require live acceptance.' };
    if (recording.alignment.available) status.alignedRecordingCount++;
  }
  status.available = status.alignedRecordingCount > 0;
  return { ...status, allRecordingsAligned: status.available && status.alignedRecordingCount === status.recordingCount,
    ...(!status.available ? { reason: 'no_recordings_with_browser_aligned_words' } : {}) };
}

export function summarizeAttempt(result) {
  const firstStart = result.events.find(event => event.event === 'start_clicked');
  const startMs = firstStart?.browserMs;
  const nextStartMs = result.events.find(event => event.event === 'start_clicked' && event.browserMs > startMs)?.browserMs ?? Infinity;
  const afterStart = event => Number.isFinite(startMs) && event.browserMs >= startMs && event.browserMs < nextStartMs;
  const app = name => result.events.find(event => afterStart(event) && event.event === 'application_timing' && event.timingEvent === name);
  const alignedRecordings = result.recordings.filter(row => {
    const clock = row.alignment?.browserClock, sample = recordingSample(row, result.events);
    return row.alignment?.available === true && row.alignment.sourceRecordingSha256 === row.sha256 && sample
      && clock?.available === true && clock.method === 'conservative_captured_media_alignment'
      && clock.observedFirstNonzeroBrowserMs === sample.browserMs && Number.isFinite(clock.waveformSignalFirstMs)
      && clock.waveformSignalFirstMs >= 0 && clock.originBrowserMs === Math.max(row.startedBrowserMs, sample.browserMs - clock.waveformSignalFirstMs);
  }).map(row => {
    const clock = row.alignment.browserClock;
    const bounded = time => Number.isFinite(time) && time >= Math.max(clock.observedFirstNonzeroBrowserMs, row.startedBrowserMs + clock.waveformSignalFirstMs)
      && time <= row.stoppedBrowserMs;
    return { ...row, alignment: { ...row.alignment,
      firstIntelligibleBrowserMs: bounded(row.alignment.firstIntelligibleBrowserMs) ? row.alignment.firstIntelligibleBrowserMs : null,
      actionableQuestion: bounded(row.alignment.actionableQuestion?.browserMs) ? row.alignment.actionableQuestion : null } };
  });
  const recording = alignedRecordings.find(row => row.startedBrowserMs >= startMs && row.startedBrowserMs < nextStartMs && row.alignment.firstIntelligibleBrowserMs);
  const question = alignedRecordings.find(row => row.startedBrowserMs >= startMs && row.startedBrowserMs < nextStartMs && row.alignment.actionableQuestion);
  const harnessSample = result.events.find(event => afterStart(event) && event.event === 'output_first_nonzero_sample'
    && ['media_element_capture','remote_webrtc_media'].includes(event.evidence));
  const appSample = result.events.find(event => afterStart(event) && event.event === 'application_timing'
    && event.timingEvent === 'speech_first_nonzero_sample' && ['media_element_capture','remote_webrtc_media'].includes(event.evidence));
  const firstSample = harnessSample ?? appSample;
  const difference = (end, start) => Number.isFinite(end) && Number.isFinite(start) ? end - start : null;
  const turns = result.events.filter(event => event.event === 'caller_audio_start').map((caller, index, all) => {
    const nextCaller = all[index + 1]?.browserMs ?? Infinity;
    const final = result.events.find(event => event.event === 'provider_event' && event.type === 'conversation.item.input_audio_transcription.completed'
      && event.browserMs >= caller.sourceSignalLastBrowserMs && event.browserMs < nextCaller);
    const response = alignedRecordings.find(row => row.alignment?.firstIntelligibleBrowserMs >= caller.sourceSignalLastBrowserMs
      && row.alignment.firstIntelligibleBrowserMs < nextCaller);
    const selected = result.events.find(event => event.event === 'selected_speech' && event.browserMs >= final?.browserMs && event.browserMs < nextCaller);
    const audioLatency = difference(response?.alignment?.firstIntelligibleBrowserMs, caller.sourceSignalLastBrowserMs);
    const progress = result.events.some(event => event.event === 'ui_stage' && ['retrying', 'processing', 'connecting'].includes(event.stage)
      && event.browserMs >= caller.sourceSignalLastBrowserMs && event.browserMs <= caller.sourceSignalLastBrowserMs + 5000);
    return { clipId: caller.clipId, ownerSignalEndBrowserMs: caller.sourceSignalLastBrowserMs,
      finalAsrBrowserMs: final?.browserMs ?? null, transcriptFinalizationMs: difference(final?.browserMs, caller.sourceSignalLastBrowserMs),
      browserTranscriptToSpeechPayloadMs: difference(selected?.browserMs, final?.browserMs), backendProcessingMs: null,
      meaningfulAudioBrowserMs: response?.alignment?.firstIntelligibleBrowserMs ?? null,
      endOfOwnerSpeechToMeaningfulAudioMs: audioLatency,
      silenceLongerThanFiveSeconds: Number.isFinite(audioLatency) ? audioLatency > 5000 : null,
      visibleProgressWithinFiveSeconds: progress };
  });
  return { label: result.label, mode: result.mode, scenario: result.scenario, condition: result.condition, verdict: result.verdict,
    callId: result.callId, browser: result.browser, model: result.bootstrapProofs?.[0]?.model ?? null,
    returnedMaxMinutes: result.bootstrapProofs?.[0]?.maxMinutes ?? null, coldDefinition: result.coldDefinition,
    visibleResponseMs: difference(app('visible_response')?.browserMs, startMs),
    visibleResponseHandlerRelativeMs: app('visible_response')?.sourceElapsedMs ?? null,
    authenticationMs: difference(app('auth_completed')?.browserMs, app('auth_started')?.browserMs),
    microphonePermissionMs: difference(app('microphone_ready')?.browserMs, app('microphone_requested')?.browserMs),
    startToFirstNonzeroCapturedSampleMs: difference(firstSample?.browserMs, startMs),
    firstNonzeroSampleObserver: harnessSample ? 'harness_media_capture' : appSample ? 'application_media_capture' : null,
    firstNonzeroSampleHandlerRelativeMs: appSample?.sourceElapsedMs ?? null,
    startToFirstIntelligibleAudioMs: difference(recording?.alignment?.firstIntelligibleBrowserMs, startMs),
    startToFirstActionableQuestionMs: difference(question?.alignment?.actionableQuestion?.browserMs, startMs),
    audioTimingEvidence: alignedRecordings.length ? 'conservative_captured_media_alignment' : null, physicalSpeakerVerified: false,
    startupIncludesPermissionWaiting: true, turns, cleanupConfirmed: result.cleanup?.clean === true,
    backendTimingLimitation: 'Join server monotonic stage durations using callId separately; browser and server wall clocks are never subtracted.' };
}

export function summarizeSample(samples) {
  const group = condition => {
    const raw = samples.filter(sample => sample.mode === 'start-sample' && sample.condition === condition);
    const audio = raw.map(sample => sample.startToFirstIntelligibleAudioMs).filter(Number.isFinite);
    const questions = raw.map(sample => sample.startToFirstActionableQuestionMs).filter(Number.isFinite);
    return { count: raw.length, audioMeasuredCount: audio.length, actionableQuestionMeasuredCount: questions.length,
      medianMs: percentile(audio, 0.5), empiricalP95Ms: percentile(audio, 0.95), maximumMs: audio.length ? Math.max(...audio) : null,
      actionableQuestionMedianMs: percentile(questions, 0.5), actionableQuestionP95Ms: percentile(questions, 0.95), raw };
  };
  const warm = group('warm'), cold = group('cold');
  const turnValues = samples.flatMap(sample => sample.turns ?? []).map(turn => turn.endOfOwnerSpeechToMeaningfulAudioMs).filter(Number.isFinite);
  const targetsPass = warm.count === 10 && cold.count === 5 && warm.audioMeasuredCount === 10 && cold.audioMeasuredCount === 5
    && warm.actionableQuestionMeasuredCount === 10 && cold.actionableQuestionMeasuredCount === 5
    && warm.medianMs <= 3000 && warm.empiricalP95Ms <= 5000 && cold.maximumMs <= 8000
    && [...warm.raw, ...cold.raw].every(sample => sample.cleanupConfirmed && Number.isFinite(sample.visibleResponseMs) && sample.visibleResponseMs <= 300 && sample.verdict !== 'failed');
  return { schema: 'ligou.voice_audio_acceptance_sample.v1', warm, cold,
    conversationalTurns: { measuredCount: turnValues.length, empiricalP95Ms: percentile(turnValues, 0.95), targetMs: 3000 },
    startupTargetsPass: targetsPass, populationSlaClaim: false,
    interpretation: 'Small controlled sample only. Missing alignment, missing samples, failed cleanup or unperformed runs cannot produce PASS.' };
}

async function prepare(options) {
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const { projection, fixtureHash } = await fixtureProjection();
  const plan = buildAnswerPlan(projection, fixtureHash);
  if (options.synthesize) await synthesizeClips(plan, options.output);
  await writeFile(path.join(options.output, 'answer-plan.json'), json(plan), { mode: 0o600 });
  const config = { schema: 'ligou.voice_audio_acceptance_config.v1', isolatedTestOnly: true,
    targetUrl: 'https://client-nine-taupe-24.vercel.app/dashboard/setup/website', supabaseUrl: null,
    publicEnvFile: '/Users/d1f/.config/ligou/supabase.env', publishableKeyEnv: 'SUPABASE_PUBLISHABLE_KEY', authFile: DEFAULT_AUTH,
    expectedOwnerId: '05495cf9-239d-4f9e-ac45-8d4f6b5e2cc9', expectedTenantId: '49ef9a84-d0e1-4774-94a4-34538670c615',
    expectedGeneration: 0, expectedOperationalMode: 'simulation_only', sessionMaxMinutes: 55, expectedTenantSessionMaxMinutes: 15,
    expectedDailyBudgetUsd: 15, expectedPerCallBudgetUsd: 7.5, allowedModels: ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini'],
    expectedDraftHash: null, expectedResultHash: null, openPanelSelector: '.website-setup-start',
    coldDefinition: 'Fresh Edge Beta profile/context with empty cache and a fresh dashboard app instance; persisted website source ready; synthetic microphone already supplied. Backend controller remains shared and warm, and is not restarted. This measures browser/app cold conditions, not a cold backend process.',
    recordSyntheticTestAudio: true, allowIsolatedBrowserReadFault: true, maxTurns: 160, maxSessionSeconds: 3300,
    retention: 'Controlled test-owner audio only. Retain locally for acceptance review; no customer recordings. Delete under the project retention policy after review.' };
  await writeFile(path.join(options.output, 'config.example.json'), json(config), { mode: 0o600 });
  const status = { schema: 'ligou.voice_audio_offline_preparation.v1', preparedAt: new Date().toISOString(),
    providerAttemptsExecuted: 0, productionMutations: 0, fixture: plan.provenance, preparedClips: plan.clips.filter(clip => clip.audio).length,
    uniqueClips: plan.clips.length, uniqueCallerAudioSeconds: plan.clips.reduce((sum, clip) => sum + (clip.audio?.durationMs ?? 0) / 1000, 0),
    oneAnswerPerItemCallerSeconds: plan.items.reduce((sum, item) => sum + (plan.clips.find(clip => clip.id === item.answerClipId)?.audio?.durationMs ?? 0) / 1000, 0),
    sessionCapSeconds: 3300, budgetCaveat: 'Protocol 3 already has a 55-minute cap and a $7.50 reservation/hard cap. The tenant non-onboarding cap is 15 minutes. The unchanged $15 daily budget can constrain sequential real tests; the harness verifies returned max_minutes and per-call reservation without raising or bypassing either cap.',
    unhandledItems: plan.unhandledItems,
    runtimeCoverageLimits: ['Unknown or paraphrased questions without an exact prepared match are recorded and stop the driver.',
      'Recovery injection covers a browser speech-read network failure and UI resume, not a server-side timeout-after-commit.',
      'Physical microphone permission/hardware and physical speaker listening are not exercised by this synthetic-input harness.',
      'No real interviews or startup samples have been executed; fixture mapping and local smoke are not acceptance evidence.'],
    remainingSetup: ['Fill the isolated owner, tenant, generation, operational mode and selected website proof in a separate config.json.',
      'Supply the deployed candidate URL, Supabase URL and publishable key through the named environment variable.',
      'Confirm current auth file is fresh and the exact isolated attempt is prepared through the existing authorized path.',
      'Run each full scenario on its separately prepared faithful attempt; preserve previous attempts and receipts.',
      'Confirm cold-start definition and existing session/budget limits before execution.',
      'Real-provider browser playback, alignment, 10 warm / 5 cold samples, 3 complete interviews and human acceptance are unperformed.'] };
  await writeFile(path.join(options.output, 'preparation-status.json'), json(status), { mode: 0o600 });
  await writeFile(path.join(options.output, 'README.md'), `# Offline browser audio acceptance preparation

Prepared source: ${plan.provenance.itemCount} agenda items and ${plan.provenance.candidateCount} website candidates. No provider calls or production writes were made by preparation.

The answer plan is fictional test-owner policy. It does not change the website fixture or authorize a real owner's business. Unknown runtime questions stop the run and are recorded; the harness does not guess a next action or write answers directly.

## Commands

Create a separate config.json from config.example.json and fill the isolated identities and source proofs supplied by the release owner. Keep auth in the existing private authFile; never paste credentials into this directory or command arguments.

\`\`\`sh
node scripts/voice-onboarding-audio-acceptance.mjs self-test
node scripts/voice-onboarding-audio-acceptance.mjs prepare
# Execution commands below create real provider sessions. They have NOT been run.
node scripts/voice-onboarding-audio-acceptance.mjs run --execute --config ${path.join(options.output, 'config.json')} --mode interview --scenario normal
node scripts/voice-onboarding-audio-acceptance.mjs run --execute --config ${path.join(options.output, 'config.json')} --mode interview --scenario variation
node scripts/voice-onboarding-audio-acceptance.mjs run --execute --config ${path.join(options.output, 'config.json')} --mode interview --scenario recovery
node scripts/voice-onboarding-audio-acceptance.mjs run --execute --config ${path.join(options.output, 'config.json')} --mode start-sample --condition warm --count 10
node scripts/voice-onboarding-audio-acceptance.mjs run --execute --config ${path.join(options.output, 'config.json')} --mode start-sample --condition cold --count 5
node scripts/voice-onboarding-audio-acceptance.mjs report --result /absolute/path/to/run-set.json
\`\`\`

Full interview scenarios need separately prepared isolated attempts. Startup samples reuse the persisted website source and start through the actual panel; each must prove technical termination and settled usage before another can start. A missing receipt stops the batch for reconciliation. No automatic shared-server restart, draft reset, deletion or mutation hook is provided.

Normal: acknowledgment, exact cities/exception answer, actual next questions and explicit approval after every current summary part played. Variation: paraphrase, off-scope request, correction during recap and a revised price recap. Recovery: one browser-local speech-read network failure after the first answer, followed by the real UI resume path only after durable resume eligibility.

## Evidence and limits

Edge Beta runs in a fresh private test profile. Start, Stop and resume use rendered controls with trusted browser input. Caller WAVs enter a MediaStreamAudioDestinationNode and then the application's normal getUserMedia/WebRTC path. The application retains control of track.enabled. No transcript or tool text is injected; provider, backend, persistence and teardown are real during execution.

Speaker output is never muted or rerouted by the harness. MediaRecorder/captureStream collect actual HTML media output, with nonzero sample observation separate from playing/ended events. The physical microphone and physical speaker hardware remain untested. Local Whisper small aligns the captured recordings without downloads or paid APIs; missing alignment remains null and cannot pass latency targets. The first actionable question is aligned within the mixed opening audio, not equated with its greeting.

Raw application timing, provider ASR events, synthetic caller signal bounds, recordings, selected speech, terminal receipts and usage settlement are saved per attempt. Tokens, refresh tokens, request headers and SDP are excluded. Browser monotonic durations never use cross-host timestamp subtraction. Backend-processing duration still requires the server's own structured timing evidence correlated by callId.

Preparation does not assert voice E2E, the 10/5 sample, target latency or live acceptance. Run records and sample reports are distinct from those gates.
`, { mode: 0o600 });
  process.stdout.write(json({ prepared: true, output: options.output, items: plan.provenance.itemCount, candidates: plan.provenance.candidateCount,
    clips: status.preparedClips, unhandled: plan.unhandledItems.length, providerAttemptsExecuted: 0 }));
}

async function run(options) {
  if (!options.execute || !options.config) fail('run_requires_execute_and_isolated_config');
  const config = JSON.parse(await readFile(options.config, 'utf8'));
  await loadPublicRuntime(config);
  const plan = JSON.parse(await readFile(path.join(options.output, 'answer-plan.json'), 'utf8'));
  const session = JSON.parse(await readFile(config.authFile ?? DEFAULT_AUTH, 'utf8'));
  validateExecution(config, options, plan, session);
  const results = []; let browser;
  try {
    for (let index = 0; index < options.count; index++) {
      if (!browser) browser = await openRealBrowser(config, session);
      publicRuntime.get(config).browser = browser;
      const result = await attempt(browser, config, session, options, plan, options.output, `${options.mode ?? 'interview'}-${options.scenario}-${options.condition}-${index + 1}`);
      results.push(result.artifactDirectory);
      process.stdout.write(json({ attempt: index + 1, verdict: result.verdict, callId: result.callId, artifacts: result.artifactDirectory }));
      if (result.verdict === 'failed') break;
      if (options.condition === 'cold') { try { await browser.evaluate('window.__voiceAcceptance.cleanup()'); } catch {} await browser.close(); browser = null; }
    }
  } finally {
    if (browser) { try { await browser.evaluate('window.__voiceAcceptance.cleanup()'); } catch {} await browser.close(); }
    const filename = path.join(options.output, `run-set-${Date.now()}.json`);
    await writeFile(filename, json({ schema: 'ligou.voice_audio_run_set.v1', attempted: results.length,
      requested: options.count, mode: options.mode ?? 'interview', condition: options.condition, results }), { mode: 0o600 });
    process.stdout.write(`Run set: ${filename}\n`);
  }
}

async function report(options) {
  if (!options.result) fail('report_requires_result_or_run_set');
  const paths = [];
  for (const input of options.results ?? [options.result]) {
    const source = JSON.parse(await readFile(input, 'utf8'));
    paths.push(...(source.schema === 'ligou.voice_audio_run_set.v1' ? source.results.map(directory => path.join(directory, 'result.json')) : [input]));
  }
  const plan = JSON.parse(await readFile(path.join(options.output, 'answer-plan.json'), 'utf8'));
  const samples = [];
  for (const filename of new Set(paths)) {
    const result = JSON.parse(await readFile(filename, 'utf8'));
    result.localAlignment = await alignRecordings(result, plan);
    result.metrics = summarizeAttempt(result); samples.push(result.metrics);
    await writeFile(filename, json(result), { mode: 0o600 });
  }
  const summary = summarizeSample(samples), filename = path.join(path.dirname(options.result), 'sample-report.json');
  await writeFile(filename, json(summary), { mode: 0o600 });
  process.stdout.write(json({ report: filename, warmObserved: summary.warm.count, coldObserved: summary.cold.count, startupTargetsPass: summary.startupTargetsPass }));
}

async function browserSmoke(options, assert) {
  const directory = path.join(options.output, 'offline-browser-smoke');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const plan = JSON.parse(await readFile(path.join(options.output, 'answer-plan.json'), 'utf8'));
  const clip = plan.clips.find(item => item.id === plan.specials.acknowledgment);
  const bytes = await readFile(path.join(options.output, clip.filename));
  const server = createServer((request, response) => {
    if (request.url === '/caller.wav') { response.setHeader('Content-Type', 'audio/wav'); response.end(bytes); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html lang="pt-BR"><body><main class="voice-live" data-voice-stage="idle"><h1>Offline harness smoke test</h1>
      <p>Local synthetic audio only. No backend or provider connection.</p><div style="height:200vh">A faithful setup summary can put its Start control below the fold.</div><button class="voice-live-button">Start local media check</button>
      <button class="voice-live-hangup">Stop</button></main><script>
      let stream,audio;window.__captureSmoke={sampleObserved:false,cloneStopped:false};document.querySelector('.voice-live-button').onclick=async()=>{
        stream=await navigator.mediaDevices.getUserMedia({audio:true});
        document.querySelector('.voice-live').dataset.voiceStage='ready';
        audio=document.createElement('audio');audio.src='/caller.wav';
        // Reproduce the app's independent first-sample observer after the
        // harness recorder already captured this exact media element.
        audio.addEventListener('playing',()=>{
          const observer=audio.captureStream(),ctx=new AudioContext(),analyser=ctx.createAnalyser();analyser.fftSize=256;
          const source=ctx.createMediaStreamSource(observer);source.connect(analyser);const samples=new Float32Array(256);
          const inspect=()=>{analyser.getFloatTimeDomainData(samples);if(samples.some(value=>Math.abs(value)>0.0001)){
            window.__captureSmoke.sampleObserved=true;source.disconnect();for(const track of observer.getTracks())track.stop();
            window.__captureSmoke.cloneStopped=observer.getTracks().every(track=>track.readyState==='ended');
            window.__captureSmoke.cloneStoppedBrowserMs=performance.now();void ctx.close();
          }else requestAnimationFrame(inspect);};void ctx.resume().then(inspect);
        },{once:true});audio.addEventListener('ended',()=>{window.__captureSmoke.playbackEnded=true;},{once:true});await audio.play();
      };document.querySelector('.voice-live-hangup').onclick=()=>{
        for(const track of stream?.getTracks()??[])track.stop();
        if(audio){audio.pause();audio.removeAttribute('src');audio.load();}
        document.querySelector('.voice-live').dataset.voiceStage='ended';
      };</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let browser;
  const evidence = { mode: 'offline_harness_smoke', providerCalls: 0, backendCalls: 0, events: [], recordings: [], callerClips: [], artifactDirectory: directory };
  try {
    browser = await openRealBrowser({ targetUrl: `http://127.0.0.1:${port}/`, supabaseUrl: 'https://local.invalid', recordSyntheticTestAudio: true }, {});
    await waitFor(browser, 'Boolean(window.__voiceAcceptance && document.querySelector(".voice-live-button"))');
    assert.ok(await browser.evaluate('document.querySelector(".voice-live-button").getBoundingClientRect().top>innerHeight'),'exercise a real offscreen control');
    await browser.click('.voice-live-button');
    await waitFor(browser, 'document.querySelector(".voice-live").dataset.voiceStage === "ready"');
    await playClip(browser, plan, clip.id, options.output, evidence);
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) { await saveDrain(browser, evidence, directory); if (evidence.recordings.length) break; await sleep(50); }
    assert.ok(evidence.events.some(event => event.event === 'caller_audio_start'));
    evidence.independentObserver=await browser.evaluate('window.__captureSmoke');
    assert.equal(evidence.independentObserver.sampleObserved,true,'second observer must see real samples');
    assert.equal(evidence.independentObserver.cloneStopped,true,'stopping the second observer must not starve the recorder');
    assert.equal(evidence.independentObserver.playbackEnded,true,'the actual unmuted media element must finish playback');
    assert.ok(evidence.events.some(event => event.event === 'output_first_nonzero_sample'), 'actual local media output must expose a nonzero sample');
    assert.ok(evidence.recordings.some(recording => recording.bytes > 100 && recording.nonzeroObserved));
    const recorded = evidence.recordings.find(recording => recording.bytes > 100 && recording.nonzeroObserved);
    const decodedFile = path.join(directory, 'captured-output.wav');
    await localCommand('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i',
      path.join(directory, recorded.filename), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', decodedFile]);
    evidence.decodedOutput = wavSignal(await readFile(decodedFile), 16000);
    assert.ok(evidence.decodedOutput.signalLastMs > clip.audio.durationMs * 0.6, 'record the continuing audio, not only an initial chunk');
    assert.ok(recorded.startedBrowserMs + evidence.decodedOutput.signalLastMs > evidence.independentObserver.cloneStoppedBrowserMs + 300,
      'real recorded samples must continue well after the other observer stops its clone');
    assert.equal(await browser.evaluate('audio.muted'),false);
    assert.equal(await browser.evaluate('audio.volume'),1);
    await browser.click('.voice-live-hangup'); await browser.evaluate('window.__voiceAcceptance.cleanup()');
    await saveDrain(browser, evidence, directory); evidence.verdict = 'PASS';
  } catch (error) {
    evidence.failure = error.message;
    try { evidence.diagnostic = await browser.evaluate('({readyState:document.readyState,secure:isSecureContext,harness:typeof window.__voiceAcceptance,mediaDevices:typeof navigator.mediaDevices,peer:typeof RTCPeerConnection,title:document.title,body:document.body?.innerText?.slice(0,200)})'); } catch {}
    throw error;
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    await writeFile(path.join(directory, 'smoke.json'), json(evidence), { mode: 0o600 });
  }
  process.stdout.write(json({ offlineBrowserSmoke: evidence.verdict, browser: 'Edge Beta preferred', providerCalls: 0, backendCalls: 0, artifacts: directory }));
}

async function browserStreamSmoke(options, assert) {
  const directory = path.join(options.output, 'offline-stream-browser-smoke');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const plan = JSON.parse(await readFile(path.join(options.output, 'answer-plan.json'), 'utf8'));
  const clip = plan.clips.find(item => item.id === plan.specials.acknowledgment);
  const bytes = await readFile(path.join(options.output, clip.filename));
  const playerSource = await readFile(path.join(ROOT, 'dashboard/src/voice/website-stream.js'), 'utf8');
  const callId = '11111111-1111-4111-8111-111111111111';
  const descriptors = [0, 1].map(index => ({schema:'onboarding.stream.v1', action:{callId,interviewId:callId,
    actionId:sha('local-stream-smoke-' + index),sourceDigest:'b'.repeat(64),revision:index,kind:'ASK_NEXT_GAP',text:clip.text},
    dispatchId:index ? '55555555-5555-4555-8555-555555555555' : '22222222-2222-4222-8222-222222222222',
    receiptId:'33333333-3333-4333-8333-333333333333'}));
  const bootstrap={call_id:callId,model:'local-loopback-no-provider',max_minutes:1,onboarding_protocol_version:4,
    opening_mode_applied:'realtime_stream_v1',opening_payload:{version:4,stream:descriptors[0]}};
  const server = createServer((request, response) => {
    if (request.url === '/caller.wav') { response.setHeader('Content-Type','audio/wav'); response.end(bytes); return; }
    if (request.url === '/website-stream.js') { response.setHeader('Content-Type','application/javascript'); response.end(playerSource); return; }
    if (request.url === '/browser-session') { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify(bootstrap)); return; }
    response.setHeader('Content-Type','text/html');
    response.end(`<!doctype html><html lang="pt-BR"><body><main class="voice-live" data-voice-stage="idle">
      <h1>Local streaming transport regression</h1><p>Two local WebRTC peers. Test owner audio only. No provider.</p>
      <button class="voice-live-button">Start</button><button class="voice-live-hangup">Stop</button></main>
      <script type="module">
      import {createWebsiteStreamPlayer,observeRemoteStreamMedia} from '/website-stream.js';
      const descriptors=${JSON.stringify(descriptors)},callId=${JSON.stringify(callId)};
      const state=window.__streamSmoke={played:[],captions:[],endedEvents:0,playingEvents:0,failures:[]};
      const stage=value=>document.querySelector('.voice-live').dataset.voiceStage=value;
      let audio,player,receiver,sender,ctx;
      const gather=pc=>pc.iceGatheringState==='complete'?Promise.resolve():new Promise(resolve=>pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete')resolve();}));
      document.querySelector('.voice-live-button').onclick=async()=>{try{
        await navigator.mediaDevices.getUserMedia({audio:true});
        const opening=await(await fetch('/browser-session')).json();
        ctx=new AudioContext();await ctx.resume();const output=ctx.createMediaStreamDestination();
        const silence=ctx.createOscillator(),silentGain=ctx.createGain();silentGain.gain.value=0;silence.connect(silentGain).connect(output);silence.start();
        const wav=await ctx.decodeAudioData(await(await fetch('/caller.wav')).arrayBuffer());
        audio=document.createElement('audio');audio.muted=true;audio.autoplay=true;
        audio.addEventListener('ended',()=>state.endedEvents++);audio.addEventListener('playing',()=>state.playingEvents++);
        receiver=new RTCPeerConnection({iceServers:[]});sender=new RTCPeerConnection({iceServers:[]});receiver.addTransceiver('audio',{direction:'recvonly'});
        let trackReady;const track=new Promise(resolve=>trackReady=resolve);
        receiver.ontrack=event=>{audio.srcObject=event.streams[0];trackReady();};
        for(const entry of output.stream.getTracks())sender.addTrack(entry,output.stream);
        const channel=receiver.createDataChannel('stream-smoke');let opened;const ready=new Promise(resolve=>opened=resolve);
        channel.addEventListener('open',opened);channel.onmessage=event=>player.handleEvent(JSON.parse(event.data));
        player=createWebsiteStreamPlayer({callId,interviewId:callId,readStream:async(action,dispatch)=>descriptors.find(value=>value.dispatchId===dispatch),
          prepareOutput:async()=>{await track;await audio.play();},observeMedia:(sample,unavailable)=>observeRemoteStreamMedia(audio,sample,unavailable),
          outputIsActive:()=>!audio.muted&&!audio.paused&&audio.volume>0,setOutput:active=>audio.muted=!active,setMicrophone:()=>{},
          send:event=>channel.send(JSON.stringify(event)),onCaption:event=>state.captions.push(event),
          onTiming:(event,details)=>window.dispatchEvent(new CustomEvent('ligou:voice-timing',{detail:{event,...details}})),
          onPhase:value=>stage(value),onFailure:error=>{state.failures.push(error.message);stage('failed');}});
        sender.ondatachannel=event=>{const remote=event.channel;const emit=value=>remote.send(JSON.stringify(value));
          const activate=()=>emit({type:'session.updated',session:{output_modalities:['text'],tools:[],audio:{input:{turn_detection:{type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false}}}}});
          if(remote.readyState==='open')activate();else remote.addEventListener('open',activate,{once:true});
          remote.onmessage=async message=>{const control=JSON.parse(message.data).item?.content?.[0]?.text??'';
            if(control.startsWith('ligou.website_stream_ready:')){
              const value=JSON.parse(control.slice('ligou.website_stream_ready:'.length));const index=descriptors.findIndex(d=>d.dispatchId===value.dispatchId),d=descriptors[index],responseId='local_response_'+index;
              const metadata={ligou_transport:'realtime_stream_v1',ligou_call_id:callId,ligou_action_id:d.action.actionId,ligou_source_digest:d.action.sourceDigest,ligou_dispatch_id:d.dispatchId};
              emit({type:'response.created',response:{id:responseId,status:'in_progress',metadata}});
              emit({type:'output_audio_buffer.started',response_id:responseId,event_id:'local_start_'+index});
              await new Promise(resolve=>setTimeout(resolve,80));const source=ctx.createBufferSource();source.buffer=wav;source.connect(output);
              await new Promise(resolve=>{source.onended=resolve;source.start();});source.disconnect();
              await new Promise(resolve=>setTimeout(resolve,250));
              emit({type:'response.done',response:{id:responseId,status:'completed',metadata,output:[{id:'local_item_'+index,type:'message',role:'assistant',status:'completed',content:[{type:'audio',transcript:d.action.text}]}]}});
              emit({type:'output_audio_buffer.stopped',response_id:responseId,event_id:'local_stop_'+index});
            }else if(control.startsWith('ligou.website_stream_played:')){
              state.played.push(JSON.parse(control.slice('ligou.website_stream_played:'.length)));
              if(state.played.length===1){const d=descriptors[1];emit({type:'conversation.item.created',item:{id:'lsn-'+d.dispatchId.replaceAll('-','').slice(0,28),type:'message',role:'system',status:'completed',content:[{type:'input_text',text:'ligou.website_stream:'+JSON.stringify(d)}]}});}
              else{state.complete=true;stage('complete');}
            }
          };
        };
        const offer=await receiver.createOffer();await receiver.setLocalDescription(offer);await gather(receiver);
        await sender.setRemoteDescription(receiver.localDescription);await sender.setLocalDescription(await sender.createAnswer());await gather(sender);
        await receiver.setRemoteDescription(sender.localDescription);await player.start(opening.opening_payload.stream,ready);
      }catch(error){state.failures.push(error.message);stage('failed');}};
      document.querySelector('.voice-live-hangup').onclick=()=>{player?.stop();receiver?.close();sender?.close();audio?.pause();void ctx?.close();stage('ended');};
      </script></body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const evidence={mode:'offline_two_peer_webrtc_streaming_regression',providerCalls:0,events:[],recordings:[],callerClips:[],artifactDirectory:directory};
  let browser;
  try {
    browser=await openRealBrowser({targetUrl:`http://127.0.0.1:${server.address().port}/`,supabaseUrl:'https://local.invalid',recordSyntheticTestAudio:true},{});
    await waitFor(browser,'Boolean(window.__voiceAcceptance && document.querySelector(".voice-live-button"))');
    await browser.click('.voice-live-button');
    await waitFor(browser,'window.__streamSmoke?.complete || window.__streamSmoke?.failures.length',20_000);
    await sleep(300);await saveDrain(browser,evidence,directory);evidence.player=await browser.evaluate('window.__streamSmoke');
    assert.deepEqual(evidence.player.failures,[]);
    assert.equal(evidence.player.played.length,2,'two provider-completion/buffer/media joins must be observed');
    assert.equal(evidence.player.endedEvents,0,'continuous WebRTC media never ended between utterances');
    assert.equal(evidence.recordings.length,2,'one actual recording per streamed response');
    for(const recording of evidence.recordings){
      assert.ok(recording.bytes>100 && recording.nonzeroObserved,'each rendition contains actual unmuted samples');
      assert.equal(recording.stopReason,'browser_stream_drained');
      assert.equal(recording.providerStatus,'completed');
      assert.ok(evidence.player.played.some(proof=>proof.responseId===recording.responseId && proof.dispatchId===recording.dispatchId));
      const decoded=path.join(directory,recording.filename+'.wav');
      await localCommand('/opt/homebrew/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y','-i',path.join(directory,recording.filename),'-ar','16000','-ac','1','-c:a','pcm_s16le',decoded]);
      recording.decoded=wavSignal(await readFile(decoded),16000);
      assert.ok(recording.decoded.signalLastMs>clip.audio.durationMs*.6,'the continuous output was captured beyond its onset');
    }
    evidence.verdict='PASS';await browser.click('.voice-live-hangup');await browser.evaluate('window.__voiceAcceptance.cleanup()');
  }catch(error){evidence.failure=error.message;try{evidence.player=await browser.evaluate('window.__streamSmoke');}catch{}throw error;}
  finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(directory,'smoke.json'),json(evidence),{mode:0o600});}
  process.stdout.write(json({offlineStreamBrowserSmoke:evidence.verdict,providerCalls:0,recordings:evidence.recordings.length,artifacts:directory}));
}

async function selfTest(options) {
  const assert = (await import('node:assert/strict')).default;
  const { projection, fixtureHash } = await fixtureProjection();
  const plan = buildAnswerPlan(projection, fixtureHash);
  assert.equal(plan.items.length, 114); assert.equal(plan.candidateRecap.length, 21); assert.equal(plan.unhandledItems.length, 0);
  assert.ok(plan.clips.find(clip => clip.text === TERRITORY));
  assert.equal(matchQuestion(plan, { text: 'Oi. ' + plan.items[0].questionPt }).itemId, plan.items[0].itemId);
  assert.equal(matchQuestion(plan, { text: 'Uma pergunta que não existe no plano.' }), null);
  assert.equal(questionPhrase(plan.items[0].questionPt), 'Quais cidades exatas sua empresa atende?');
  assert.equal(percentile([4, 1, 2, 3], 0.5), 2.5); assert.equal(percentile([4, 1, 2, 3], 0.95), 4);
  assert.equal(summarizeSample([]).startupTargetsPass, false);
  const sample = { mode: 'start-sample', condition: 'warm', verdict: 'startup_observed_pending_cleanup_and_alignment', cleanupConfirmed: true,
    visibleResponseMs: 5, startToFirstIntelligibleAudioMs: 2000, startToFirstActionableQuestionMs: 10000, turns: [] };
  assert.equal(summarizeSample(Array.from({ length: 10 }, () => ({ ...sample }))).startupTargetsPass, false);
  const complete = [...Array.from({ length: 10 }, () => ({ ...sample })), ...Array.from({ length: 5 }, () => ({ ...sample, condition: 'cold' }))];
  assert.equal(summarizeSample(complete).startupTargetsPass, true);
  complete[0].startToFirstIntelligibleAudioMs = null;
  assert.equal(summarizeSample(complete).startupTargetsPass, false);
  const timingEvidence = { events: [
    { event: 'start_clicked', browserMs: 100 },
    { event: 'application_timing', timingEvent: 'start_clicked', browserMs: 250, sourceElapsedMs: 0 },
    { event: 'application_timing', timingEvent: 'visible_response', browserMs: 260, sourceElapsedMs: 10 },
    { event: 'application_timing', timingEvent: 'speech_first_nonzero_sample', browserMs: 1200, sourceElapsedMs: 950, evidence: 'media_element_capture' },
  ], recordings: [{ bytes: 0, nonzeroObserved: false, startedBrowserMs: 1100,
    alignment: { available: true, firstIntelligibleBrowserMs: 1300, actionableQuestion: { browserMs: 1400 } } }] };
  const clickTiming = summarizeAttempt(timingEvidence);
  assert.equal(clickTiming.visibleResponseMs, 160, 'visible feedback includes delay before the app handler');
  assert.equal(clickTiming.visibleResponseHandlerRelativeMs, 10);
  assert.equal(clickTiming.startToFirstNonzeroCapturedSampleMs, 1100, 'captured app samples retain the real click origin');
  assert.equal(clickTiming.firstNonzeroSampleObserver, 'application_media_capture');
  assert.equal(clickTiming.firstNonzeroSampleHandlerRelativeMs, 950);
  assert.equal(clickTiming.startToFirstIntelligibleAudioMs, null, 'app telemetry or an empty recording cannot prove words');
  assert.equal(clickTiming.startToFirstActionableQuestionMs, null);
  const noCapture = structuredClone(timingEvidence);
  noCapture.events.at(-1).evidence = 'html_media_playing';
  assert.equal(summarizeAttempt(noCapture).startToFirstNonzeroCapturedSampleMs, null);
  const capturedTiming = structuredClone(timingEvidence);
  capturedTiming.events.push({ event: 'output_first_nonzero_sample', browserMs: 1190, outputIndex: 1, actionId: 'speech-1', evidence: 'media_element_capture' });
  const capturedRow = Object.assign(capturedTiming.recordings[0], { bytes: 500, nonzeroObserved: true, outputIndex: 1, actionId: 'speech-1',
    sha256: 'a'.repeat(64), captureEvidence: 'actual_html_media_capture', stoppedBrowserMs: 2000, expectedText: 'Oi aqui' });
  capturedRow.alignment = { available: true, sourceRecordingSha256: capturedRow.sha256,
    ...alignCapturedWords(capturedRow, capturedTiming.events, { signalFirstMs: 100, signalLastMs: 800, durationMs: 900 },
      [{ word: 'Oi', start: 0.2, end: 0.25, probability: 1 }, { word: 'aqui', start: 0.25, end: 0.3, probability: 1 },
        ...['Quais', 'cidades', 'exatas', 'sua'].map((word, index) => ({ word, start: 0.3 + index * 0.1, end: 0.4 + index * 0.1, probability: 1 }))],
      'Quais cidades exatas sua empresa atende?') };
  const verifiedTiming = summarizeAttempt(capturedTiming);
  assert.equal(verifiedTiming.startToFirstNonzeroCapturedSampleMs, 1090);
  assert.equal(verifiedTiming.firstNonzeroSampleObserver, 'harness_media_capture');
  assert.equal(verifiedTiming.startToFirstIntelligibleAudioMs, 1200);
  assert.equal(verifiedTiming.startToFirstActionableQuestionMs, 1300);
  const alignmentDirectory = await mkdtemp(path.join(tmpdir(), 'ligou-voice-alignment-self-test-'));
  try {
    await mkdir(path.join(alignmentDirectory, 'alignment'));
    await writeFile(path.join(alignmentDirectory, 'output-0001.webm'), '');
    // A stale transcript must never turn an empty media file into aligned audio.
    await writeFile(path.join(alignmentDirectory, 'alignment/output-0001.json'), json({ text: 'Oi aqui',
      segments: [{ words: [{ word: 'Oi', start: 0, end: 0.2, probability: 1 }, { word: 'aqui', start: 0.2, end: 0.4, probability: 1 }] }] }));
    const emptyMedia = { artifactDirectory: alignmentDirectory, recordings: [{ filename: 'output-0001.webm', bytes: 0,
      nonzeroObserved: false, startedBrowserMs: 100, expectedText: 'Oi aqui' }] };
    const aligned = await alignRecordings(emptyMedia, plan);
    assert.equal(aligned.available, false, 'installed tools do not prove any recording was aligned');
    assert.equal(typeof aligned.toolingAvailable, 'boolean');
    assert.equal(emptyMedia.recordings[0].alignment.available, false);
    assert.equal((await alignRecordings({ artifactDirectory: alignmentDirectory, recordings: [] }, plan)).available, false);
  } finally { await rm(alignmentDirectory, { recursive: true, force: true }); }
  assert.throws(() => validateExecution({}, {}, plan, {}), /execution_not_requested/);
  // A completed setup intentionally hides ready_proof. Its immutable source
  // and tenant binding must remain verifiable without pretending it is ready.
  const ownerId='11111111-1111-4111-8111-111111111111',tenantId='22222222-2222-4222-8222-222222222222';
  const draftId='33333333-3333-4333-8333-333333333333',resultId='44444444-4444-4444-8444-444444444444';
  const jobId='55555555-5555-4555-8555-555555555555',attemptId='66666666-6666-4666-8666-666666666666';
  const isolationConfig={expectedTenantId:tenantId,expectedOwnerId:ownerId,expectedGeneration:0,expectedOperationalMode:'simulation_only',
    expectedTenantSessionMaxMinutes:15,expectedDailyBudgetUsd:15,expectedDraftHash:'a'.repeat(64),expectedResultHash:'b'.repeat(64)};
  const sourceRows={tenant:{id:tenantId,owner_user_id:ownerId,test_memory_generation:0,operational_mode:'simulation_only',session_max_minutes:15,daily_budget_usd:15},
    setup:{state:'onboarding_complete',ready_proof:null},
    draft:{id:draftId,tenant_id:tenantId,created_by:ownerId,draft_hash:'a'.repeat(64),source_result_id:resultId,source_job_id:jobId},
    result:{id:resultId,tenant_id:tenantId,job_id:jobId,attempt_id:attemptId,result_hash:'b'.repeat(64),validation_state:'validated',result_schema:'company_discovery.result.v2'},
    job:{id:jobId,tenant_id:tenantId,selected_attempt_id:attemptId,status:'awaiting_review'}};
  const sourceRead=async(_config,_session,pathname)=>{
    if(pathname.startsWith('/rest/v1/tenants?'))return [sourceRows.tenant];
    if(pathname==='/rest/v1/rpc/company_discovery_setup_status')return sourceRows.setup;
    if(pathname.startsWith('/rest/v1/company_discovery_onboarding_drafts?'))return [sourceRows.draft];
    if(pathname.startsWith('/rest/v1/worker_results?'))return [sourceRows.result];
    if(pathname.startsWith('/rest/v1/worker_jobs?'))return [sourceRows.job];
    throw new Error('unexpected_self_test_read');
  };
  const completeIsolation=await checkIsolation(isolationConfig,{},sourceRead);
  assert.equal(completeIsolation.operationalMode,'simulation_only');
  assert.equal(completeIsolation.websiteProof.draft_hash,isolationConfig.expectedDraftHash);
  sourceRows.draft.draft_hash='c'.repeat(64);
  await assert.rejects(()=>checkIsolation(isolationConfig,{},sourceRead),/live_website_source_mismatch/);
  sourceRows.draft.draft_hash='a'.repeat(64);sourceRows.result.tenant_id=ownerId;
  await assert.rejects(()=>checkIsolation(isolationConfig,{},sourceRead),/live_website_source_mismatch/);
  sourceRows.result.tenant_id=tenantId;sourceRows.job.selected_attempt_id=ownerId;
  await assert.rejects(()=>checkIsolation(isolationConfig,{},sourceRead),/live_website_source_mismatch/);
  let cleanupClock=0;
  const cleanupRead=async()=>({callId:attemptId,callStatus:'ended',providerTerminationState:'confirmed',budgetStatus:cleanupClock>=100_000?'settled':'active'});
  const cleanup=await terminalRead({}, {}, attemptId,{now:()=>cleanupClock,wait:async ms=>{cleanupClock+=ms;},read:cleanupRead});
  assert.equal(cleanup.clean,true,'a real reconciliation delay must not become a premature cleanup failure');
  assert.equal(cleanupClock,100_000);
  cleanupClock=0;
  const unconfirmed=await terminalRead({}, {}, attemptId,{timeoutMs:1000,now:()=>cleanupClock,wait:async ms=>{cleanupClock+=ms;},read:cleanupRead});
  assert.equal(unconfirmed.clean,false);assert.equal(cleanupClock,1000);
  new Function(`return (${installBrowserHarness.toString()});`)();
  process.stdout.write(json({ selfTest: 'PASS', offlineOnly: true, mappedItems: plan.items.length, clips: plan.clips.length, providerAttempts: 0 }));
  if (options.browserSmoke) process.stdout.write(json({ nativeBrowserChecks: 'SKIPPED', browserAudioVerified: false, reason: 'RJ requires Codex in-app browser; native launch and cleanup are disabled.' }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write('Usage: node scripts/voice-onboarding-audio-acceptance.mjs [prepare|self-test|export-in-app|report] [--execute --config FILE --mode interview|start-sample --scenario normal|variation|recovery --condition warm|cold --count N]\nDefault: offline preparation only.\n'); return; }
  if (options.command === 'export-in-app') process.stdout.write(json(await writeInAppHarnessArtifacts(options)));
  else if (options.command === 'prepare') await prepare(options);
  else if (options.command === 'run') await run(options);
  else if (options.command === 'report') await report(options);
  else await selfTest(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { const code = /^[a-z0-9_-]+$/.test(error.message ?? '') ? error.message : 'acceptance_harness_failed'; process.stderr.write(`Voice audio acceptance: ${code}\n`); process.exitCode = 1; });
}
