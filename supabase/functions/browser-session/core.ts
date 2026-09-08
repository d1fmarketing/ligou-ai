import { resolveOwnedTenantForSession } from "../_shared/owned-tenant.ts";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export const BROWSER_SESSION_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Server-Timing",
};

const APPLICATION_MODE = "application_tts_v1";
const STREAM_MODE = "realtime_stream_v1";
const NATIVE_MODE = "realtime_native_v1";
const PROVIDER_MODE = "provider_model_v1";
const APPLICATION_STARTUP_DEADLINE_MS = 35_000;
const PROVIDER_STARTUP_DEADLINE_MS = 20_000;
const CANCEL_ACK_POLL_MS = 200;
const CANCEL_ACK_MAX_POLLS = 60;
const CLEANUP_COLUMNS = "id,status,session_type,call_id,answer_sdp,error,opening_mode_requested,opening_mode_applied,opening_payload,onboarding_protocol_version";
const OPENING_V1_KEYS = [
  "version",
  "item_id",
  "text",
  "text_sha256",
  "audio_base64",
  "audio_sha256",
  "mime",
  "voice",
  "tts_model",
  "cost_usd",
] as const;
const OPENING_V2_KEYS = [...OPENING_V1_KEYS, "resume_context"] as const;

function validWebsiteOpening(payload: Record<string, unknown>): boolean {
  if (!exactKeys(payload, ["version", "item_id", "speech"]) || !payload.speech || typeof payload.speech !== "object" || Array.isArray(payload.speech)) return false;
  const speech = payload.speech as Record<string, unknown>;
  const rate = ttsRate(speech.tts_model);
  if (!exactKeys(speech, ["schema", "actionId", "interviewId", "callId", "revision", "kind", "text", "sourceDigest", "text_sha256", "audio_base64", "audio_sha256", "mime", "voice", "tts_model", "cost_usd"])) return false;
  const hashPattern = /^[0-9a-f]{64}$/;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (speech.schema !== "onboarding.speech.v1" || speech.kind !== "ASK_NEXT_GAP" ||
    ![speech.actionId, speech.sourceDigest, speech.text_sha256, speech.audio_sha256].every(v => typeof v === "string" && hashPattern.test(v)) ||
    typeof speech.callId !== "string" || !uuidPattern.test(speech.callId) ||
    typeof speech.interviewId !== "string" || !uuidPattern.test(speech.interviewId) ||
    !Number.isSafeInteger(speech.revision) || (speech.revision as number) < 0 ||
    payload.item_id !== `lgs-${String(speech.actionId).slice(0, 28)}` ||
    typeof speech.text !== "string" || !speech.text.trim() || [...speech.text].length > 4096 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(speech.text) ||
    speech.mime !== "audio/mpeg" || speech.voice !== "ash" || rate === null ||
    speech.cost_usd !== exactTtsCost(speech.text, rate) || !boundedString(speech.audio_base64, 4, 2_000_000)) return false;
  const normalized = speech.text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ");
  if (/\bposso (?:te )?ajudar\b|\btem mais alguma coisa\b|\bo que mais voce gostaria\b|\be so me chamar\b/.test(normalized)) return false;
  const audio = Buffer.from(speech.audio_base64, "base64");
  return audio.length >= 4 && audio.length <= 1_500_000 && audio.toString("base64") === speech.audio_base64 &&
    ((audio[0] === 73 && audio[1] === 68 && audio[2] === 51) ||
      (audio[0] === 255 && (audio[1]! & 224) === 224 && (audio[1]! & 6) !== 0 && (audio[2]! & 240) !== 240 && (audio[2]! & 12) !== 12)) &&
    createHash("sha256").update(speech.text).digest("hex") === speech.text_sha256 &&
    createHash("sha256").update(audio).digest("hex") === speech.audio_sha256;
}

type OpeningMode = typeof APPLICATION_MODE | typeof STREAM_MODE | typeof NATIVE_MODE | typeof PROVIDER_MODE;
const controlledOpening=(mode:unknown)=>mode===APPLICATION_MODE || mode===STREAM_MODE || mode===NATIVE_MODE;
const protocolOpeningMode=(version:number)=>version===5?NATIVE_MODE:version===4?STREAM_MODE:APPLICATION_MODE;
const invalidOpeningContract=(mode:OpeningMode)=>mode===NATIVE_MODE?"invalid_native_opening_contract":mode===STREAM_MODE?"invalid_stream_opening_contract":"invalid_application_opening_contract";

export function isStreamOpeningPayload(value:unknown):value is Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value) || !exactKeys(value as Record<string,unknown>,["version","stream"]))return false;
  const envelope=value as Record<string,unknown>,stream=envelope.stream as Record<string,unknown>;
  if(envelope.version!==4 || !stream || typeof stream!=="object" || Array.isArray(stream) || !exactKeys(stream,["schema","action","dispatchId","receiptId"]))return false;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[0-9a-f]{64}$/;
  if(stream.schema!=="onboarding.stream.v1" || typeof stream.dispatchId!=="string" || !uuid.test(stream.dispatchId)
    || typeof stream.receiptId!=="string" || !uuid.test(stream.receiptId))return false;
  const action=stream.action as Record<string,unknown>;
  return Boolean(action && typeof action==="object" && !Array.isArray(action)
    && exactKeys(action,["actionId","interviewId","callId","revision","kind","text","sourceDigest"])
    && [action.callId,action.interviewId].every(id=>typeof id==="string"&&uuid.test(id))
    && [action.actionId,action.sourceDigest].every(id=>typeof id==="string"&&hash.test(id))
    && Number.isSafeInteger(action.revision) && (action.revision as number)>=0
    && typeof action.kind==="string" && ["ASK_NEXT_GAP","CLARIFY_CURRENT_GAP","CONFIRM_AND_ASK_NEXT","DEFER_OFF_SCOPE_AND_CONTINUE","GENERATE_FINAL_SUMMARY","REQUEST_FINAL_APPROVAL","HANDLE_OWNER_CORRECTION","SPEAK_FINAL_SIGNOFF","SPEAK_TERMINAL_ERROR","SPEAK_AMENDMENT_SIGNOFF"].includes(action.kind)
    && typeof action.text==="string" && Boolean(action.text.trim()) && [...action.text].length<=4096
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.text));
}

export function isNativeOpeningPayload(value:unknown):value is Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value))return false;
  const payload=value as Record<string,unknown>;
  if(!exactKeys(payload,["version","native"]) || payload.version!==5 || !payload.native || typeof payload.native!=="object" || Array.isArray(payload.native))return false;
  const native=payload.native as Record<string,unknown>;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return exactKeys(native,["callId","interviewId","revision","sourceDigest"])
    && typeof native.callId==="string" && uuid.test(native.callId)
    && typeof native.interviewId==="string" && uuid.test(native.interviewId)
    && Number.isSafeInteger(native.revision) && Number(native.revision)>=0
    && typeof native.sourceDigest==="string" && /^[0-9a-f]{64}$/.test(native.sourceDigest);
}

interface BrowserSessionDependencies {
  env(name: string): string | undefined;
  createClient(url: string, serviceKey: string): any;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  monotonic?(): number;
  onTiming?(event: BrowserSessionTiming): void;
}

interface BrowserSessionTiming {
  event: "voice.edge.startup";
  timingVersion: 1;
  timingAvailable: boolean;
  status: number;
  requestId?: string;
  callId?: string;
  pollCount: number;
  firstProcessingMs?: number;
  firstReadyMs?: number;
  durations: Record<string, number>;
}

type StartupStage = "edge_config" | "edge_auth" | "edge_body_contract" | "edge_tenant" |
  "edge_enqueue" | "edge_wait_ready" | "edge_opening_validate" | "edge_call_model" |
  "edge_cleanup" | "edge_serialize";

/** Per-request monotonic timings only; nested poll durations are subdivisions
 * of wait_ready, never extra serial work. Observers cannot alter admission. */
function startupTiming(dependencies: BrowserSessionDependencies) {
  let available=true,last=0,reported=false;
  const clock=()=>{
    try {
      const value=(dependencies.monotonic??(()=>performance.now()))();
      if(!Number.isFinite(value))throw new Error("timing_clock_invalid");
      last=Math.max(last,value);return last;
    } catch {available=false;return last;}
  };
  const began=clock(),durations:Record<string,number>={};
  let stage:StartupStage="edge_config",stageAt=began;
  let requestId:string|undefined,callId:string|undefined,pollCount=0;
  let firstProcessingMs:number|undefined,firstReadyMs:number|undefined;
  const safeId=(id:unknown)=>typeof id==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)?id:undefined;
  const add=(name:string,elapsed:number)=>{durations[name]=(durations[name]??0)+Math.max(0,elapsed);};
  const enter=(next:StartupStage)=>{const at=clock();add(stage,at-stageAt);stage=next;stageAt=at;};
  const report=(status:number,response?:Response)=>{
    if(reported)return;reported=true;
    const at=clock();add(stage,at-stageAt);durations.edge_total=at-began;
    const rounded=available?Object.fromEntries(Object.entries(durations).map(([key,value])=>[key,Number(value.toFixed(2))])):{};
    if(available && response)response.headers.set("Server-Timing",Object.entries(rounded).map(([key,value])=>`${key};dur=${value}`).join(", "));
    try {dependencies.onTiming?.({event:"voice.edge.startup",timingVersion:1,timingAvailable:available,status,
      ...(requestId?{requestId}:{}),...(callId?{callId}:{}),pollCount,
      ...(available && firstProcessingMs!==undefined?{firstProcessingMs}:{}),
      ...(available && firstReadyMs!==undefined?{firstReadyMs}:{}),durations:rounded});} catch { /* Timing is never a control-plane dependency. */ }
  };
  return {enter,report,
    bindRequest(id:unknown){requestId=safeId(id);},
    observe(row:Record<string,unknown>|null){
      pollCount++;callId=safeId(row?.call_id)??callId;
      if(row?.status==="processing")firstProcessingMs??=Number((clock()-began).toFixed(2));
      if(row?.status==="ready")firstReadyMs??=Number((clock()-began).toFixed(2));
    },
    async poll<T>(name:"edge_poll_sleep"|"edge_poll_read",work:()=>PromiseLike<T>):Promise<T>{
      const at=clock();try{return await work();}finally{add(name,clock()-at);}
    },
    json(body:Record<string,unknown>,status=200){
      enter("edge_serialize");const response=Response.json(body,{status,headers:BROWSER_SESSION_CORS});report(status,response);return response;
    },
  };
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length &&
    wanted.every((key, index) => keys[index] === key);
}

function ttsRate(model: unknown): 15 | 30 | null {
  return model === "tts-1" ? 15 : model === "tts-1-hd" ? 30 : null;
}

function exactTtsCost(text: string, rate: 15 | 30): number {
  return Number(([...text].length * rate / 1_000_000).toFixed(8));
}

function validResumeContext(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  if (!exactKeys(context, [
    "coverage_receipt_id", "revision", "snapshot_digest", "next_action",
  ]) ||
    !boundedString(context.coverage_receipt_id, 36, 36) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      context.coverage_receipt_id,
    ) ||
    context.revision !== 1 ||
    !boundedString(context.snapshot_digest, 64, 64) ||
    !/^[0-9a-f]{64}$/.test(context.snapshot_digest) ||
    !context.next_action || typeof context.next_action !== "object" ||
    Array.isArray(context.next_action)) return false;
  const action = context.next_action as Record<string, unknown>;
  const keys = ["type", "field", "question_pt"];
  if (action.subject !== undefined) keys.push("subject");
  return exactKeys(action, keys) && action.type === "ask" &&
    boundedString(action.field, 1, 255) && Boolean(action.field.trim()) &&
    boundedString(action.question_pt, 1, 1_000) &&
    Boolean(action.question_pt.trim()) &&
    (action.subject === undefined ||
      (boundedString(action.subject, 1, 255) && Boolean(action.subject.trim())));
}

export function isApplicationOpeningPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (payload.version === 3) return validWebsiteOpening(payload);
  if (payload.version === 1) {
    if (!exactKeys(payload, OPENING_V1_KEYS) || payload.tts_model !== "tts-1")
      return false;
  } else if (payload.version === 2) {
    if (!exactKeys(payload, OPENING_V2_KEYS) ||
      ttsRate(payload.tts_model) === null ||
      !(payload.resume_context === null ||
        validResumeContext(payload.resume_context))) return false;
  } else return false;
  if (!boundedString(payload.item_id, 32, 32) || !/^lgo-[0-9a-f]{28}$/.test(payload.item_id)) return false;
  if (!boundedString(payload.text, 1, 1000) || !payload.text.trim()) return false;
  if (!boundedString(payload.text_sha256, 64, 64) || !/^[0-9a-f]{64}$/.test(payload.text_sha256)) return false;
  if (!boundedString(payload.audio_base64, 4, 2_000_000)) return false;
  if (payload.audio_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.audio_base64)) return false;
  if (!boundedString(payload.audio_sha256, 64, 64) || !/^[0-9a-f]{64}$/.test(payload.audio_sha256)) return false;
  if (payload.mime !== "audio/mpeg" || payload.voice !== "ash") return false;
  const rate = ttsRate(payload.tts_model);
  return rate !== null && typeof payload.cost_usd === "number"
    && Number.isFinite(payload.cost_usd)
    && payload.cost_usd === exactTtsCost(
      String(payload.text),
      rate,
    );
}

function expectedApplicationOpeningText(
  businessName: string,
  payload: Record<string, unknown>,
): string | null {
  const identity =
    `Oi! Aqui é o Ligou, agente de inteligência artificial da ${businessName}.`;
  if (payload.version === 1 || payload.resume_context === null)
    return `${identity} Quais serviços sua empresa oferece?`;
  if (!validResumeContext(payload.resume_context)) return null;
  const question = String(
    (payload.resume_context.next_action as Record<string, unknown>).question_pt,
  );
  return question.startsWith("Eu já analisei seu website")
    ? `${identity} ${question}`
    : `${identity} Vamos continuar de onde paramos. ${question}`;
}

function validReadyOpening(
  requested: OpeningMode,
  row: Record<string, unknown>,
  protocolVersion: number | null,
  businessName?: string,
): boolean {
  if (!boundedString(row.answer_sdp, 1, 1_000_000) || !boundedString(row.call_id, 1, 128)) return false;
  if (requested === PROVIDER_MODE) {
    return protocolVersion === null &&
      row.onboarding_protocol_version == null &&
      row.opening_mode_applied === PROVIDER_MODE &&
      row.opening_payload === null;
  }
  if(requested===STREAM_MODE){
    if(protocolVersion!==4 || row.onboarding_protocol_version!==4 || row.opening_mode_applied!==STREAM_MODE
      || !isStreamOpeningPayload(row.opening_payload))return false;
    return ((row.opening_payload.stream as Record<string,unknown>).action as Record<string,unknown>).callId===row.call_id;
  }
  if(requested===NATIVE_MODE){
    if(protocolVersion!==5 || row.onboarding_protocol_version!==5 || row.opening_mode_applied!==NATIVE_MODE
      || !isNativeOpeningPayload(row.opening_payload))return false;
    return (row.opening_payload.native as Record<string,unknown>).callId===row.call_id;
  }
  if (row.onboarding_protocol_version !== protocolVersion ||
    row.opening_mode_applied !== APPLICATION_MODE ||
    !isApplicationOpeningPayload(row.opening_payload) ||
    ([2, 3].includes(protocolVersion as number) &&
      row.opening_payload.version !== protocolVersion)) return false;
  if (protocolVersion === 3) return (row.opening_payload.speech as Record<string, unknown>).callId === row.call_id;
  return businessName === undefined ||
    row.opening_payload.text === expectedApplicationOpeningText(
      businessName,
      row.opening_payload,
    );
}

async function waitForPollOrAbort(
  signal: AbortSignal,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(300), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function exactExpiredCleanup(
  row: Record<string, unknown>,
  requestId: string,
  expectedCallId: string | null,
  requested: OpeningMode,
  protocolVersion: number | null,
): boolean {
  return row.id === requestId
    && row.status === "expired"
    && row.call_id === expectedCallId
    && (expectedCallId === null || (
      row.session_type === "onboarding"
      && controlledOpening(requested)
      && row.opening_mode_requested === requested
      && row.onboarding_protocol_version === protocolVersion
    ))
    && row.answer_sdp === null
    && row.opening_mode_applied === null
    && row.opening_payload === null;
}

function exactCancellableReady(
  row: Record<string, unknown>,
  requestId: string,
  requested: OpeningMode,
  protocolVersion: number | null,
  status: "ready" | "cancel_requested",
  expectedCallId?: string,
): boolean {
  return row.id === requestId
    && row.status === status
    && controlledOpening(requested)
    && row.session_type === "onboarding"
    && row.opening_mode_requested === requested
    && (expectedCallId === undefined || row.call_id === expectedCallId)
    && validReadyOpening(requested, row, protocolVersion);
}

function exactCancellableProcessing(
  row: Record<string, unknown>,
  requestId: string,
  requested: OpeningMode,
  protocolVersion: number | null,
  status: "processing" | "cancel_requested",
  expectedCallId?: string,
): boolean {
  return row.id === requestId
    && row.status === status
    && controlledOpening(requested)
    && row.session_type === "onboarding"
    && row.opening_mode_requested === requested
    && row.onboarding_protocol_version === protocolVersion
    && typeof row.call_id === "string"
    && (expectedCallId === undefined || row.call_id === expectedCallId)
    && row.answer_sdp === null
    && row.opening_mode_applied === null
    && row.opening_payload === null;
}

function exactInvalidApplicationReadyCleanupIdentity(
  row: Record<string, unknown>,
  requestId: string,
  protocolVersion: number,
  status: "ready" | "cancel_requested",
  expectedCallId: string,
): boolean {
  return row.id === requestId
    && row.status === status
    && row.session_type === "onboarding"
    && row.opening_mode_requested === protocolOpeningMode(protocolVersion)
    && row.onboarding_protocol_version === protocolVersion
    && row.call_id === expectedCallId
    && boundedString(row.answer_sdp, 1, 1_000_000);
}

async function readCleanupRow(client: any, requestId: string) {
  const { data, error } = await client.from("browser_session_requests")
    .select(CLEANUP_COLUMNS)
    .eq("id", requestId)
    .single();
  return error || !data ? null : data as Record<string, unknown>;
}

async function expireOpenRequest(
  dependencies: BrowserSessionDependencies,
  client: any,
  requestId: string,
  reason: "request_aborted" | "controller_timeout",
  requested: OpeningMode,
  protocolVersion: number | null,
): Promise<boolean> {
  const { data: expiredRows, error: expireError } = await client.from("browser_session_requests")
    .update({ status: "expired", error: reason })
    .eq("id", requestId)
    .in("status", ["pending", "processing"])
    .is("call_id", null)
    .select(CLEANUP_COLUMNS);
  if (expireError || !Array.isArray(expiredRows) || expiredRows.length > 1) return false;
  if (expiredRows.length === 1) {
    return exactExpiredCleanup(expiredRows[0], requestId, null, requested, protocolVersion);
  }

  let row = await readCleanupRow(client, requestId);
  if (!row) return false;
  if (row.status === "expired") {
    const retainedCallId = typeof row.call_id === "string" ? row.call_id : null;
    return exactExpiredCleanup(row, requestId, retainedCallId, requested, protocolVersion);
  }

  let expectedCallId: string;
  let boundKind: "processing" | "ready";
  let sourceStatus: "processing" | "ready";
  if (exactCancellableReady(
    row, requestId, requested, protocolVersion, "ready"
  )) {
    expectedCallId = row.call_id as string;
    boundKind = "ready";
    sourceStatus = "ready";
  } else if (exactCancellableProcessing(
    row, requestId, requested, protocolVersion, "processing"
  )) {
    expectedCallId = row.call_id as string;
    boundKind = "processing";
    sourceStatus = "processing";
  } else if (exactCancellableReady(
    row, requestId, requested, protocolVersion, "cancel_requested"
  )) {
    expectedCallId = row.call_id as string;
    boundKind = "ready";
    sourceStatus = "ready";
  } else if (exactCancellableProcessing(
    row, requestId, requested, protocolVersion, "cancel_requested"
  )) {
    expectedCallId = row.call_id as string;
    boundKind = "processing";
    sourceStatus = "processing";
  } else {
    return false;
  }

  if (row.status !== "cancel_requested") {
    const { data: cancelRows, error: cancelError } = await client.from("browser_session_requests")
      .update({ status: "cancel_requested", error: reason })
      .eq("id", requestId)
      .eq("status", sourceStatus)
      .eq("call_id", expectedCallId)
      .select(CLEANUP_COLUMNS);
    if (cancelError || !Array.isArray(cancelRows) || cancelRows.length > 1) return false;
    if (cancelRows.length === 1) {
      const exact = boundKind === "ready"
        ? exactCancellableReady(
          cancelRows[0], requestId, requested, protocolVersion,
          "cancel_requested", expectedCallId,
        )
        : exactCancellableProcessing(
          cancelRows[0], requestId, requested, protocolVersion,
          "cancel_requested", expectedCallId,
        );
      if (!exact) return false;
      row = cancelRows[0];
    } else {
      row = await readCleanupRow(client, requestId);
      if (!row) return false;
      if (exactExpiredCleanup(row, requestId, expectedCallId, requested, protocolVersion)) return true;
      const exact = boundKind === "ready"
        ? exactCancellableReady(
          row, requestId, requested, protocolVersion,
          "cancel_requested", expectedCallId,
        )
        : exactCancellableProcessing(
          row, requestId, requested, protocolVersion,
          "cancel_requested", expectedCallId,
        );
      if (!exact) return false;
    }
  }

  for (let attempt = 0; attempt < CANCEL_ACK_MAX_POLLS; attempt += 1) {
    await dependencies.sleep(CANCEL_ACK_POLL_MS);
    row = await readCleanupRow(client, requestId);
    if (!row) return false;
    if (exactExpiredCleanup(row, requestId, expectedCallId, requested, protocolVersion)) return true;
    const exact = boundKind === "ready"
      ? exactCancellableReady(
        row, requestId, requested, protocolVersion,
        "cancel_requested", expectedCallId,
      )
      : exactCancellableProcessing(
        row, requestId, requested, protocolVersion,
        "cancel_requested", expectedCallId,
      );
    if (!exact) return false;
  }
  return false;
}

async function cancelInvalidApplicationReady(
  dependencies: BrowserSessionDependencies,
  client: any,
  observedRow: Record<string, unknown>,
  requestId: string,
  protocolVersion: number,
): Promise<boolean> {
  const requested=protocolOpeningMode(protocolVersion);
  const expectedCallId = typeof observedRow.call_id === "string"
    ? observedRow.call_id
    : "";
  if (!boundedString(expectedCallId, 1, 128)) return false;
  if (!exactInvalidApplicationReadyCleanupIdentity(
    observedRow,
    requestId,
    protocolVersion,
    "ready",
    expectedCallId,
  )) return false;

  const reason = invalidOpeningContract(requested);
  const { data: cancelRows, error: cancelError } = await client
    .from("browser_session_requests")
    .update({ status: "cancel_requested", error: reason })
    .eq("id", requestId)
    .eq("status", "ready")
    .eq("call_id", expectedCallId)
    .select(CLEANUP_COLUMNS);
  if (cancelError || !Array.isArray(cancelRows) || cancelRows.length > 1)
    return false;

  let row: Record<string, unknown> | null = cancelRows.length === 1
    ? cancelRows[0]
    : await readCleanupRow(client, requestId);
  if (!row) return false;
  if (exactExpiredCleanup(row, requestId, expectedCallId, requested, protocolVersion) &&
    row.onboarding_protocol_version === protocolVersion) return true;
  if (!exactInvalidApplicationReadyCleanupIdentity(
    row,
    requestId,
    protocolVersion,
    "cancel_requested",
    expectedCallId,
  )) return false;

  for (let attempt = 0; attempt < CANCEL_ACK_MAX_POLLS; attempt += 1) {
    await dependencies.sleep(CANCEL_ACK_POLL_MS);
    row = await readCleanupRow(client, requestId);
    if (!row) return false;
    if (exactExpiredCleanup(row, requestId, expectedCallId, requested, protocolVersion) &&
      row.onboarding_protocol_version === protocolVersion) return true;
    if (!exactInvalidApplicationReadyCleanupIdentity(
      row,
      requestId,
      protocolVersion,
      "cancel_requested",
      expectedCallId,
    )) return false;
  }
  return false;
}

export function createBrowserSessionHandler(dependencies: BrowserSessionDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { headers: BROWSER_SESSION_CORS });
    const timing=startupTiming(dependencies),json=timing.json;
    const run=async()=>{
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (request.signal.aborted) return json({ error: "request_aborted" }, 499);

    const url = dependencies.env("SUPABASE_URL");
    const serviceKey = dependencies.env("SERVICE_KEY");
    if (!url || !serviceKey) return json({ error: "server_configuration_error" }, 503);
    const client = dependencies.createClient(url, serviceKey);

    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
    let userResponse: Response;
    timing.enter("edge_auth");
    try {
      userResponse = await dependencies.fetch(`${url}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: auth },
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) return json({ error: "request_aborted" }, 499);
      throw error;
    }
    if (request.signal.aborted) return json({ error: "request_aborted" }, 499);
    if (!userResponse.ok) return json({ error: "unauthorized" }, 401);
    const user = await userResponse.json().catch(() => null);
    if (!user?.id) return json({ error: "unauthorized" }, 401);

    timing.enter("edge_body_contract");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (!body.sdp) return json({ error: "sdp_required" }, 400);
    const sessionType = typeof body.session_type === "string" ? body.session_type : "owner_browser";
    if (!["customer", "owner_browser", "onboarding"].includes(sessionType)) {
      return json({ error: "invalid_session_type" }, 400);
    }
    const protocolVersion = sessionType === "onboarding"
      ? body.onboarding_protocol_version
      : null;
    const openingModeRequested: OpeningMode = sessionType === "onboarding"
      ? NATIVE_MODE
      : PROVIDER_MODE;
    if (sessionType === "onboarding" && (protocolVersion !== 5
      || body.opening_mode_requested !== openingModeRequested)) {
      return json({ error: "client_upgrade_required" }, 409);
    }
    // New calls use native audio and retain client playback evidence capability.
    // Historical payload validation must never re-enable an older speech path.
    if (sessionType === "onboarding" && body.speech_contract_version !== 3) {
      return json({ error: "client_upgrade_required" }, 409);
    }

    const defaultTenant = dependencies.env("LIGOU_TENANT") ?? "rocha-plumbing";
    let tenant;
    timing.enter("edge_tenant");
    try {
      tenant = await resolveOwnedTenantForSession(client, String(user.id), defaultTenant);
    } catch (error: any) {
      return json({ error: error?.message ?? "ownership_check_failed" }, error?.status ?? 500);
    }
    if (request.signal.aborted) return json({ error: "request_aborted" }, 499);
    const businessName = typeof tenant.name === "string" ? tenant.name.trim() : "";
    if (!businessName || businessName.length > 256) return json({ error: "tenant_identity_invalid" }, 503);

    timing.enter("edge_enqueue");
    const { data: requestRow, error: insertError } = await client.from("browser_session_requests").insert({
      tenant_id: tenant.id,
      user_id: user.id,
      session_type: sessionType,
      model_override: body.model ?? null,
      offer_sdp: String(body.sdp),
      opening_mode_requested: openingModeRequested,
      ...(sessionType === "onboarding"
        ? { onboarding_protocol_version: protocolVersion }
        : {}),
    }).select("id").single();
    if (insertError || !requestRow) return json({ error: `enqueue_failed: ${insertError?.message}` }, 500);
    timing.bindRequest(requestRow.id);

    const stopOpenRequest = async (
      reason: "request_aborted" | "controller_timeout",
      status: 499 | 504,
    ) => {
      timing.enter("edge_cleanup");
      const expired = await expireOpenRequest(
        dependencies,
        client,
        String(requestRow.id),
        reason,
        openingModeRequested,
        protocolVersion as number | null,
      );
      if (!expired) return json({ error: "request_cleanup_failed" }, 502);
      if (reason === "request_aborted") return json({ error: reason }, status);
      return json({
        error: reason,
        hint: "controller offline? check ligou-controller on the EC2",
      }, status);
    };
    if (request.signal.aborted) return stopOpenRequest("request_aborted", 499);

    const startupDeadline = controlledOpening(openingModeRequested)
      ? APPLICATION_STARTUP_DEADLINE_MS
      : PROVIDER_STARTUP_DEADLINE_MS;
    const deadline = dependencies.now() + startupDeadline;
    timing.enter("edge_wait_ready");
    while (dependencies.now() < deadline) {
      await timing.poll("edge_poll_sleep",()=>waitForPollOrAbort(request.signal, dependencies.sleep));
      if (request.signal.aborted) return stopOpenRequest("request_aborted", 499);
      if (dependencies.now() >= deadline) break;
      const { data: row } = await timing.poll<{data:any}>("edge_poll_read",()=>client.from("browser_session_requests")
        .select(CLEANUP_COLUMNS)
        .eq("id", requestRow.id)
        .single());
      timing.observe(row);
      if (request.signal.aborted) return stopOpenRequest("request_aborted", 499);
      if (!row) break;
      if (row.status === "ready") {
        timing.enter("edge_opening_validate");
        if (!validReadyOpening(
          openingModeRequested,
          row,
          protocolVersion as number | null,
          businessName,
        )) {
          const error = controlledOpening(openingModeRequested)
            ? invalidOpeningContract(openingModeRequested)
            : "invalid_provider_opening_contract";
          if (controlledOpening(openingModeRequested)) {
            timing.enter("edge_cleanup");
            const cleaned = await cancelInvalidApplicationReady(
              dependencies,
              client,
              row as Record<string, unknown>,
              String(requestRow.id),
              protocolVersion as number,
            );
            if (!cleaned)
              return json({ error: "request_cleanup_failed" }, 502);
          }
          return json({ error }, 502);
        }
        timing.enter("edge_call_model");
        const { data: call } = await client.from("calls").select("model").eq("id", row.call_id).single();
        if (request.signal.aborted) return stopOpenRequest("request_aborted", 499);
        return json({
          sdp: row.answer_sdp,
          call_id: row.call_id,
          max_minutes: sessionType === "onboarding" ? 55 : 15,
          model: call?.model ?? null,
          opening_mode_applied: row.opening_mode_applied,
          opening_payload: row.opening_payload,
          ...(sessionType === "onboarding"
            ? {
                onboarding_protocol_version: protocolVersion,
                ...(protocolVersion === 2 ? { resume_context: (row.opening_payload as Record<string, unknown>)
                  .resume_context,
                opening_text: (row.opening_payload as Record<string, unknown>)
                  .text } : {}),
              }
            : {}),
          business_name: businessName,
        });
      }
      if (row.status === "error") {
        const status = row.error?.includes("budget") ? 402 : 502;
        return json({ error: row.error ?? "session_failed" }, status);
      }
    }
    return stopOpenRequest("controller_timeout", 504);
    };
    try {return await run();} catch(error){timing.report(500);throw error;}
  };
}
