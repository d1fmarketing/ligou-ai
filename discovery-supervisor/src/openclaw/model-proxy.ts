import { timingSafeEqual } from "node:crypto";
import { DISCOVERY_MCP_TOOL_PARAMETERS } from "./mcp-bridge";
import type { DiscoveryAdapterId } from "../contracts";

export const CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses" as const;

export type ModelProxyFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CodexAccessGrant {
  readonly access_token: string;
  readonly account_id: string;
  readonly expires_at: number;
  readonly source: "hermes-auth-store" | "credential_pool";
}

export interface FixedModelProxyOptions {
  readonly proxy_marker: string;
  readonly adapter_id: DiscoveryAdapterId;
  readonly codex_access_grant: CodexAccessGrant;
  readonly upstream_model: string;
  readonly deadline_at: string;
  readonly fetch: ModelProxyFetch;
  readonly now?: () => number;
  readonly create_request_id?: () => string;
  readonly lease_session_id: string;
  readonly max_request_count?: number;
  readonly max_input_bytes?: number;
  readonly max_output_bytes?: number;
  readonly max_concurrency?: number;
}

export interface ModelProxyUsage {
  readonly request_count: number;
  readonly upstream_request_count: number;
  readonly active_requests: number;
  readonly input_bytes: number;
  readonly output_bytes: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly usage_complete: boolean;
  readonly retired: boolean;
}

export class ModelProxyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProxyPolicyError";
  }
}

const TOOL_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  discovery__fetch_discovery_page: DISCOVERY_MCP_TOOL_PARAMETERS.fetch_discovery_page,
  discovery__submit_discovery_result: DISCOVERY_MCP_TOOL_PARAMETERS.submit_discovery_result,
});
const ALLOWED_TOOLS = new Set(Object.keys(TOOL_PARAMETERS));
const OPENCLAW_REQUEST_KEYS = new Set([
  "model", "store", "stream", "instructions", "input", "tools", "tool_choice",
  "parallel_tool_calls", "reasoning", "text", "include", "prompt_cache_key",
  "max_output_tokens",
]);
const DIRECT_REQUEST_KEYS = new Set([
  "model", "store", "stream", "instructions", "input",
]);
const TOOL_KEYS = new Set(["type", "name", "description", "parameters", "strict"]);
const DEFAULT_MAX_REQUESTS = 28;
const DEFAULT_MAX_INPUT_BYTES = 400_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608;
const MAX_RESPONSE_BYTES = 4_194_304;
const MAX_OBSERVED_INPUT_TOKENS = 400_000;
const MAX_OBSERVED_OUTPUT_TOKENS = 8_192;
const ACCESS_EXPIRY_SKEW_SECONDS = 120;

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new ModelProxyPolicyError(`${name} is invalid`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ModelProxyPolicyError(`${name} is invalid`);
  }
  return value as number;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelProxyPolicyError(`${name}: expected JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ModelProxyPolicyError(`${name}: expected plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectExtras(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ModelProxyPolicyError(`${name}: unexpected fields`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const candidate = record(value, "tool schema");
  return `{${Object.keys(candidate).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(candidate[key])}`
  ).join(",")}}`;
}

function validateTools(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ModelProxyPolicyError("model request tool authority must contain exactly two tools");
  }
  const tools = value.map((raw, index) => {
    const tool = record(raw, `model request tools[${index}]`);
    rejectExtras(tool, TOOL_KEYS, `model request tools[${index}]`);
    if (tool.type !== "function" || typeof tool.name !== "string" || !ALLOWED_TOOLS.has(tool.name)) {
      throw new ModelProxyPolicyError("model request tool authority is invalid");
    }
    if (tool.description !== undefined &&
        (typeof tool.description !== "string" || tool.description.length > 1_000)) {
      throw new ModelProxyPolicyError("model request tool description is invalid");
    }
    if (tool.strict !== undefined && tool.strict !== null && typeof tool.strict !== "boolean") {
      throw new ModelProxyPolicyError("model request tool strictness is invalid");
    }
    if (canonicalJson(tool.parameters) !== canonicalJson(TOOL_PARAMETERS[tool.name])) {
      throw new ModelProxyPolicyError("model request tool schema is invalid");
    }
    const normalized: Record<string, unknown> = { ...tool, strict: true };
    return Object.freeze(normalized);
  });
  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== 2) throw new ModelProxyPolicyError("model request tool authority is invalid");
  return Object.freeze(tools);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearer(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) {
    throw new ModelProxyPolicyError("Codex access grant token is invalid");
  }
  try {
    return record(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")), "Codex JWT");
  } catch (error) {
    if (error instanceof ModelProxyPolicyError) throw error;
    throw new ModelProxyPolicyError("Codex access grant token is invalid");
  }
}

function validateGrant(grant: CodexAccessGrant, deadlineAt: number): Readonly<CodexAccessGrant> {
  if (grant === null || typeof grant !== "object" || Array.isArray(grant) ||
      Object.keys(grant).length !== 4 ||
      !["access_token", "account_id", "expires_at", "source"].every((key) => Object.hasOwn(grant, key)) ||
      (grant.source !== "hermes-auth-store" && grant.source !== "credential_pool")) {
    throw new ModelProxyPolicyError("Codex access grant is invalid");
  }
  const token = boundedString(grant.access_token, "Codex access grant token", 65_536);
  const accountId = boundedString(grant.account_id, "Codex account id", 256);
  const expiresAt = integer(grant.expires_at, "Codex access grant expiry", 1, Number.MAX_SAFE_INTEGER);
  const claims = decodeJwt(token);
  const auth = record(claims["https://api.openai.com/auth"], "Codex auth claim");
  if (claims.exp !== expiresAt || auth.chatgpt_account_id !== accountId) {
    throw new ModelProxyPolicyError("Codex access grant identity is invalid");
  }
  if (expiresAt < Math.ceil(deadlineAt / 1_000) + ACCESS_EXPIRY_SKEW_SECONDS) {
    throw new ModelProxyPolicyError("Codex access grant expiry cannot cover the attempt");
  }
  return Object.freeze({ access_token: token, account_id: accountId, expires_at: expiresAt, source: grant.source });
}

function validateProxyMarker(
  marker: string,
  deadlineAt: number,
  grant: Readonly<CodexAccessGrant>,
): string {
  if (marker === grant.access_token) throw new ModelProxyPolicyError("proxy marker must not be a provider grant");
  const parts = marker.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{43}$/.test(parts[2]!)) {
    throw new ModelProxyPolicyError("proxy marker is invalid");
  }
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = record(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")), "proxy marker header");
    claims = decodeJwt(marker);
  } catch {
    throw new ModelProxyPolicyError("proxy marker is invalid");
  }
  const auth = record(claims["https://api.openai.com/auth"], "proxy marker auth claim");
  const accountId = auth.chatgpt_account_id;
  if (Object.keys(header).length !== 2 || header.alg !== "HS256" || header.typ !== "JWT" ||
      typeof accountId !== "string" || !/^ligou-stage0-[A-Za-z0-9_-]{24}$/.test(accountId) ||
      accountId === grant.account_id || !Number.isSafeInteger(claims.exp) ||
      Number(claims.exp) < Math.ceil(deadlineAt / 1_000)) {
    throw new ModelProxyPolicyError("proxy marker is invalid");
  }
  return marker;
}

function requestId(value: string): string {
  if (!/^stage0_[A-Za-z0-9_-]{10,100}$/.test(value)) {
    throw new ModelProxyPolicyError("Codex request id is invalid");
  }
  return value;
}

function sessionId(value: string): string {
  if (!/^stage0_session_[A-Za-z0-9_-]{16,80}$/.test(value)) {
    throw new ModelProxyPolicyError("Codex lease session id is invalid");
  }
  return value;
}

function newRequestId(): string {
  return `stage0_${crypto.randomUUID().replaceAll("-", "")}`;
}

function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  return integer(value ?? fallback, name, 1, maximum);
}

const MESSAGE_KEYS = new Set(["type", "role", "content", "status"]);
const TEXT_PART_KEYS = new Set(["type", "text", "annotations"]);
const REASONING_KEYS = new Set(["type", "id", "summary", "encrypted_content"]);
const SUMMARY_KEYS = new Set(["type", "text"]);
const FUNCTION_CALL_KEYS = new Set(["type", "id", "call_id", "name", "arguments", "status"]);
const FUNCTION_OUTPUT_KEYS = new Set(["type", "id", "call_id", "output", "status"]);

function boundedCallId(value: unknown, name: string): string {
  const result = boundedString(value, name, 200);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result)) throw new ModelProxyPolicyError(`${name} is invalid`);
  return result;
}

function validateToolArguments(name: string, value: unknown): void {
  const serialized = boundedString(value, "model input function arguments", 200_000);
  let args: Record<string, unknown>;
  try { args = record(JSON.parse(serialized), "model input function arguments"); }
  catch { throw new ModelProxyPolicyError("model input function arguments are invalid"); }
  if (name === "discovery__fetch_discovery_page") {
    if (Object.keys(args).length !== 1 || typeof args.url !== "string" ||
        args.url.length > 2_048 || !args.url.startsWith("https://")) {
      throw new ModelProxyPolicyError("model input fetch function arguments are invalid");
    }
    return;
  }
  if (name === "discovery__submit_discovery_result") {
    if (Object.keys(args).length !== 1 || args.result === null || typeof args.result !== "object" ||
        Array.isArray(args.result)) {
      throw new ModelProxyPolicyError("model input submit function arguments are invalid");
    }
    return;
  }
  throw new ModelProxyPolicyError("model input function authority is invalid");
}

function validateInput(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new ModelProxyPolicyError("model request input is invalid");
  }
  const calls = new Set<string>();
  const normalized = value.map((raw, index) => {
    const item = record(raw, `model input[${index}]`);
    const type = item.type;
    if (type === "message") {
      rejectExtras(item, MESSAGE_KEYS, `model input[${index}]`);
      if (item.role !== "user" && item.role !== "assistant") {
        throw new ModelProxyPolicyError("model input message role is invalid");
      }
      if (item.status !== undefined &&
          (item.role !== "assistant" || item.status !== "completed")) {
        throw new ModelProxyPolicyError("model input message status is invalid");
      }
      if (!Array.isArray(item.content) || item.content.length === 0 || item.content.length > 100) {
        throw new ModelProxyPolicyError("model input message content is invalid");
      }
      const content = item.content.map((rawPart, partIndex) => {
        const part = record(rawPart, `model input[${index}].content[${partIndex}]`);
        rejectExtras(part, TEXT_PART_KEYS, `model input[${index}].content[${partIndex}]`);
        const expected = item.role === "user" ? "input_text" : "output_text";
        if (part.type !== expected) throw new ModelProxyPolicyError("model input content type is invalid");
        const text = boundedString(part.text, "model input text", 65_536);
        if (part.annotations !== undefined &&
            (part.type !== "output_text" || !Array.isArray(part.annotations) || part.annotations.length !== 0)) {
          throw new ModelProxyPolicyError("model input annotations are invalid");
        }
        return Object.freeze({ type: expected, text });
      });
      return Object.freeze({ type: "message", role: item.role, content: Object.freeze(content) });
    }
    if (type === "reasoning") {
      rejectExtras(item, REASONING_KEYS, `model input[${index}]`);
      if (item.id !== undefined) boundedCallId(item.id, "model input reasoning id");
      boundedString(item.encrypted_content, "model input encrypted reasoning", 300_000);
      if (item.summary !== undefined) {
        if (!Array.isArray(item.summary) || item.summary.length > 20) {
          throw new ModelProxyPolicyError("model input reasoning summary is invalid");
        }
        item.summary.forEach((rawSummary, summaryIndex) => {
          const summary = record(rawSummary, `model input[${index}].summary[${summaryIndex}]`);
          rejectExtras(summary, SUMMARY_KEYS, `model input[${index}].summary[${summaryIndex}]`);
          if (summary.type !== "summary_text") throw new ModelProxyPolicyError("model input reasoning summary type is invalid");
          boundedString(summary.text, "model input reasoning summary text", 65_536);
        });
      }
      return Object.freeze({ ...item });
    }
    if (type === "function_call") {
      rejectExtras(item, FUNCTION_CALL_KEYS, `model input[${index}]`);
      if (typeof item.name !== "string" || !ALLOWED_TOOLS.has(item.name)) {
        throw new ModelProxyPolicyError("model input function authority is invalid");
      }
      const callId = boundedCallId(item.call_id, "model input function call id");
      if (calls.has(callId)) throw new ModelProxyPolicyError("model input function call id is duplicated");
      validateToolArguments(item.name, item.arguments);
      if (item.id !== undefined) boundedCallId(item.id, "model input function item id");
      if (item.status !== undefined && item.status !== "completed" && item.status !== "in_progress") {
        throw new ModelProxyPolicyError("model input function status is invalid");
      }
      calls.add(callId);
      return Object.freeze({ ...item });
    }
    if (type === "function_call_output") {
      rejectExtras(item, FUNCTION_OUTPUT_KEYS, `model input[${index}]`);
      const callId = boundedCallId(item.call_id, "model input function output call id");
      if (!calls.has(callId)) throw new ModelProxyPolicyError("model input function output is unbound");
      boundedString(item.output, "model input function output", 300_000);
      if (item.id !== undefined) boundedCallId(item.id, "model input function output item id");
      if (item.status !== undefined && item.status !== "completed") {
        throw new ModelProxyPolicyError("model input function output status is invalid");
      }
      return Object.freeze({ ...item });
    }
    throw new ModelProxyPolicyError("model request input type is invalid");
  });
  return Object.freeze(normalized);
}

function sanitizeOpenClawBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  rejectExtras(body, OPENCLAW_REQUEST_KEYS, "model request");
  if (body.model !== model) throw new ModelProxyPolicyError("model proxy requires the fixed model");
  if (body.store !== false || body.stream !== true) {
    throw new ModelProxyPolicyError("model proxy requires non-stored streaming Responses");
  }
  const instructions = boundedString(body.instructions, "model instructions", 65_536);
  const input = validateInput(body.input);
  const tools = validateTools(body.tools);
  if (body.tool_choice !== undefined && body.tool_choice !== "auto") {
    throw new ModelProxyPolicyError("model request tool choice is invalid");
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") {
    throw new ModelProxyPolicyError("model request parallel tool setting is invalid");
  }
  if (body.max_output_tokens !== undefined) {
    integer(body.max_output_tokens, "model request output token limit", 1, 8_192);
  }
  if (body.text !== undefined) {
    const text = record(body.text, "model request text");
    if (Object.keys(text).length !== 1 || text.verbosity !== "low") {
      throw new ModelProxyPolicyError("model request text settings are invalid");
    }
  }
  if (!Array.isArray(body.include) || body.include.length !== 1 ||
      body.include[0] !== "reasoning.encrypted_content") {
    throw new ModelProxyPolicyError("model request include is invalid");
  }
  const reasoning = record(body.reasoning, "model request reasoning");
  if (Object.keys(reasoning).some((key) => key !== "effort" && key !== "summary")) {
    throw new ModelProxyPolicyError("model request reasoning is invalid");
  }
  return Object.freeze({
    model,
    store: false,
    stream: true,
    instructions,
    input,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: Object.freeze({ effort: "high", summary: "auto" }),
    text: Object.freeze({ verbosity: "low" }),
    include: Object.freeze(["reasoning.encrypted_content"]),
  });
}

function sanitizeDirectBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  rejectExtras(body, DIRECT_REQUEST_KEYS, "direct model request");
  if (body.model !== model) throw new ModelProxyPolicyError("model proxy requires the fixed model");
  if (body.store !== false || body.stream !== true) {
    throw new ModelProxyPolicyError("direct model requires non-stored streaming Responses");
  }
  const instructions = boundedString(body.instructions, "direct model instructions", 65_536);
  if (!Array.isArray(body.input) || body.input.length !== 1) {
    throw new ModelProxyPolicyError("direct model input is invalid");
  }
  const item = record(body.input[0], "direct model input[0]");
  rejectExtras(item, MESSAGE_KEYS, "direct model input[0]");
  if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content) ||
      item.content.length !== 1 || item.status !== undefined) {
    throw new ModelProxyPolicyError("direct model input is invalid");
  }
  const part = record(item.content[0], "direct model input content");
  rejectExtras(part, TEXT_PART_KEYS, "direct model input content");
  if (part.type !== "input_text" || part.annotations !== undefined) {
    throw new ModelProxyPolicyError("direct model input type is invalid");
  }
  const directText = boundedString(part.text, "direct model input text", 400_000);
  return Object.freeze({
    model,
    store: false,
    stream: true,
    instructions,
    input: Object.freeze([{ type: "message", role: "user", content: Object.freeze([
      Object.freeze({ type: "input_text", text: directText }),
    ]) }]),
    text: Object.freeze({ verbosity: "low" }),
    reasoning: Object.freeze({ effort: "high", summary: "auto" }),
    include: Object.freeze(["reasoning.encrypted_content"]),
  });
}

function sanitizeBody(
  body: Record<string, unknown>,
  model: string,
  adapterId: DiscoveryAdapterId,
): Record<string, unknown> {
  return adapterId === "openclaw"
    ? sanitizeOpenClawBody(body, model)
    : sanitizeDirectBody(body, model);
}

interface ParsedUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

function parseUsage(body: Buffer): ParsedUsage | null {
  let rawUsage: unknown;
  let terminalCount = 0;
  for (const line of body.toString("utf8").split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      const event = record(JSON.parse(data), "Codex SSE event");
      if (event.type === "response.completed" || event.type === "response.done") {
        const response = record(event.response, "Codex SSE response");
        if (response.status !== "completed") return null;
        terminalCount += 1;
        rawUsage = response.usage;
      } else if (event.type === "response.failed" || event.type === "response.incomplete" ||
          event.type === "response.cancelled" || event.type === "error") {
        return null;
      }
    } catch {
      return null;
    }
  }
  if (rawUsage === undefined || terminalCount !== 1) return null;
  try {
    const usage = record(rawUsage, "Codex usage");
    const details = record(usage.input_tokens_details, "Codex input token details");
    const input = integer(usage.input_tokens, "Codex input tokens", 0, Number.MAX_SAFE_INTEGER);
    const cached = integer(details.cached_tokens, "Codex cached input tokens", 0, input);
    const output = integer(usage.output_tokens, "Codex output tokens", 0, Number.MAX_SAFE_INTEGER);
    const total = integer(usage.total_tokens, "Codex total tokens", 0, Number.MAX_SAFE_INTEGER);
    if (total !== input + output) return null;
    return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: total };
  } catch {
    return null;
  }
}

function validatedRetryAfterMilliseconds(value: string | null): string | null {
  if (value === null || value.length > 32 || !/^\d+(?:[.]\d+)?$/.test(value)) return null;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 3_600_000) return null;
  return value;
}

function validatedRetryAfter(value: string | null, now: number): string | null {
  if (value === null || value.length > 128) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3_600 ? value : null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.ceil((parsed - now) / 1_000);
  return seconds >= 1 && seconds <= 3_600 ? value : null;
}

async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new ModelProxyPolicyError("model proxy request aborted");
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maximum) {
        await reader.cancel("output limit").catch(() => undefined);
        throw new ModelProxyPolicyError("model proxy output byte limit exceeded");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export class FixedModelProxy {
  readonly #marker: string;
  readonly #adapterId: DiscoveryAdapterId;
  readonly #grant: Readonly<CodexAccessGrant>;
  readonly #model: string;
  readonly #deadlineAt: number;
  readonly #fetch: ModelProxyFetch;
  readonly #now: () => number;
  readonly #makeId: () => string;
  readonly #leaseSessionId: string;
  readonly #maxRequests: number;
  readonly #maxInputBytes: number;
  readonly #maxOutputBytes: number;
  readonly #maxConcurrency: number;
  readonly #controllers = new Set<AbortController>();
  #requests = 0;
  #upstreamRequests = 0;
  #active = 0;
  #inputBytes = 0;
  #upstreamInputBytes = 0;
  #outputBytes = 0;
  #inputTokens = 0;
  #cachedInputTokens = 0;
  #outputTokens = 0;
  #totalTokens = 0;
  #usageComplete = true;
  #retired = false;

  constructor(options: FixedModelProxyOptions) {
    if (options.adapter_id !== "openclaw" && options.adapter_id !== "direct_model") {
      throw new ModelProxyPolicyError("subscription adapter is invalid");
    }
    this.#adapterId = options.adapter_id;
    this.#model = boundedString(options.upstream_model, "fixed model", 200);
    if (this.#model !== "gpt-5.6-sol") throw new ModelProxyPolicyError("fixed subscription model is invalid");
    this.#now = options.now ?? Date.now;
    this.#deadlineAt = Date.parse(options.deadline_at);
    const remaining = this.#deadlineAt - this.#now();
    if (!Number.isFinite(this.#deadlineAt) || remaining <= 0 || remaining > 600_000) {
      throw new ModelProxyPolicyError("model proxy deadline is invalid");
    }
    this.#grant = validateGrant(options.codex_access_grant, this.#deadlineAt);
    this.#marker = validateProxyMarker(
      boundedString(options.proxy_marker, "proxy marker", 4_096),
      this.#deadlineAt,
      this.#grant,
    );
    this.#fetch = options.fetch;
    this.#makeId = options.create_request_id ?? newRequestId;
    this.#leaseSessionId = sessionId(options.lease_session_id);
    this.#maxRequests = limit(options.max_request_count, DEFAULT_MAX_REQUESTS, DEFAULT_MAX_REQUESTS, "model request count limit");
    this.#maxInputBytes = limit(options.max_input_bytes, DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_INPUT_BYTES, "model input byte limit");
    this.#maxOutputBytes = limit(options.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES, "model output byte limit");
    this.#maxConcurrency = limit(options.max_concurrency, 1, 1, "model concurrency limit");
  }

  usage(): Readonly<ModelProxyUsage> {
    return Object.freeze({
      request_count: this.#requests,
      upstream_request_count: this.#upstreamRequests,
      active_requests: this.#active,
      input_bytes: this.#inputBytes,
      output_bytes: this.#outputBytes,
      input_tokens: this.#inputTokens,
      cached_input_tokens: this.#cachedInputTokens,
      output_tokens: this.#outputTokens,
      total_tokens: this.#totalTokens,
      usage_complete: this.#usageComplete,
      retired: this.#retired,
    });
  }

  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    for (const controller of this.#controllers) controller.abort();
  }

  async forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/codex/responses" || url.search || url.hash) {
      throw new ModelProxyPolicyError("model proxy accepts only the fixed route /codex/responses");
    }
    if (request.method !== "POST") throw new ModelProxyPolicyError("model proxy accepts only POST");
    if (!safeEqual(bearer(request), this.#marker)) throw new ModelProxyPolicyError("model proxy marker rejected");
    if (this.#retired) throw new ModelProxyPolicyError("model proxy attempt is retired");
    if (this.#now() >= this.#deadlineAt) throw new ModelProxyPolicyError("model proxy deadline exceeded");
    if (this.#requests >= this.#maxRequests) throw new ModelProxyPolicyError("model proxy request count limit exceeded");
    this.#requests += 1;
    if (request.signal.aborted) throw new ModelProxyPolicyError("model proxy request aborted");
    if (this.#active >= this.#maxConcurrency) throw new ModelProxyPolicyError("model proxy concurrency limit exceeded");
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new ModelProxyPolicyError("model proxy requires application/json");

    const controller = new AbortController();
    this.#controllers.add(controller);
    this.#active += 1;
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, this.#deadlineAt - this.#now()));
    try {
      const bytes = Buffer.from(await request.arrayBuffer());
      if (bytes.length === 0 || bytes.length > this.#maxInputBytes - this.#inputBytes) {
        throw new ModelProxyPolicyError("model proxy aggregate input byte limit exceeded");
      }
      this.#inputBytes += bytes.length;
      let decoded: unknown;
      try { decoded = JSON.parse(bytes.toString("utf8")); }
      catch { throw new ModelProxyPolicyError("model proxy request is not valid JSON"); }
      const id = requestId(this.#makeId());
      const body = JSON.stringify(sanitizeBody(
        record(decoded, "model request"),
        this.#model,
        this.#adapterId,
      ));
      const upstreamInputBytes = Buffer.byteLength(body);
      if (upstreamInputBytes > this.#maxInputBytes - this.#upstreamInputBytes) {
        throw new ModelProxyPolicyError("model proxy sanitized input byte limit exceeded");
      }
      const outputRemaining = this.#maxOutputBytes - this.#outputBytes;
      if (outputRemaining <= 0) throw new ModelProxyPolicyError("model proxy aggregate output byte limit exceeded");
      this.#upstreamInputBytes += upstreamInputBytes;
      this.#upstreamRequests += 1;
      const upstream = await this.#fetch(CODEX_RESPONSES_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#grant.access_token}`,
          "chatgpt-account-id": this.#grant.account_id,
          originator: "codex_cli_rs",
          "user-agent": "codex_cli_rs/0.0.0 (Ligou via Hermes)",
          "openai-beta": "responses=experimental",
          accept: "text/event-stream",
          "content-type": "application/json",
          session_id: this.#leaseSessionId,
          "x-client-request-id": id,
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      const responseBody = await readBounded(
        upstream,
        Math.min(MAX_RESPONSE_BYTES, outputRemaining),
        controller.signal,
      );
      this.#outputBytes += responseBody.length;
      const upstreamType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (upstream.ok && upstreamType !== "text/event-stream") {
        this.#usageComplete = false;
        throw new ModelProxyPolicyError("Codex upstream requires text/event-stream");
      }
      const usage = upstream.ok ? parseUsage(responseBody) : null;
      if (upstream.ok && usage === null) this.#usageComplete = false;
      else if (usage !== null) {
        if (this.#inputTokens + usage.input_tokens > MAX_OBSERVED_INPUT_TOKENS ||
            this.#outputTokens + usage.output_tokens > MAX_OBSERVED_OUTPUT_TOKENS) {
          this.#usageComplete = false;
          throw new ModelProxyPolicyError("model proxy observed token limit exceeded");
        }
        this.#inputTokens += usage.input_tokens;
        this.#cachedInputTokens += usage.cached_input_tokens;
        this.#outputTokens += usage.output_tokens;
        this.#totalTokens += usage.total_tokens;
      }
      const headers = new Headers({ "cache-control": "no-store" });
      if (upstreamType) headers.set("content-type", upstreamType);
      const upstreamId = upstream.headers.get("x-request-id") ?? upstream.headers.get("x-oai-request-id");
      if (upstreamId && /^[A-Za-z0-9_.:-]{1,200}$/.test(upstreamId)) headers.set("x-request-id", upstreamId);
      const retryAfter = validatedRetryAfter(upstream.headers.get("retry-after"), this.#now());
      const retryAfterMs = validatedRetryAfterMilliseconds(upstream.headers.get("retry-after-ms"));
      if (retryAfter !== null) headers.set("retry-after", retryAfter);
      if (retryAfterMs !== null) headers.set("retry-after-ms", retryAfterMs);
      return new Response(responseBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      this.#controllers.delete(controller);
      this.#active -= 1;
    }
  }
}
