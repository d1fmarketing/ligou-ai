import { timingSafeEqual } from "node:crypto";
import { DISCOVERY_MCP_TOOL_PARAMETERS } from "./mcp-bridge";

export type ModelProxyFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FixedModelProxyOptions {
  readonly proxy_marker: string;
  readonly upstream_api_key: string;
  readonly upstream_url: string;
  readonly upstream_model: string;
  readonly fetch: ModelProxyFetch;
  readonly max_request_bytes?: number;
}

export class ModelProxyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProxyPolicyError";
  }
}

const ALLOWED_TOOL_NAMES = new Set([
  "discovery__fetch_discovery_page",
  "discovery__submit_discovery_result",
]);

const TOOL_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  discovery__fetch_discovery_page: DISCOVERY_MCP_TOOL_PARAMETERS.fetch_discovery_page,
  discovery__submit_discovery_result: DISCOVERY_MCP_TOOL_PARAMETERS.submit_discovery_result,
});

function boundedSecret(value: string, name: string): string {
  if (value.trim() === "" || value.length > 4_096) {
    throw new ModelProxyPolicyError(`${name} is invalid`);
  }
  return value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function bearer(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function plainRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelProxyPolicyError(`${message}: expected JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ModelProxyPolicyError(`${message}: expected plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const candidate = plainRecord(value, "tool schema");
  return `{${Object.keys(candidate).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(candidate[key])}`
  ).join(",")}}`;
}

function assertToolAuthority(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ModelProxyPolicyError("model request tool authority must contain exactly two tools");
  }
  const names = value.map((tool, index) => {
    const candidate = plainRecord(tool, `model request tools[${index}]`);
    if (candidate.type !== "function" || typeof candidate.name !== "string") {
      throw new ModelProxyPolicyError("model request tool authority is invalid");
    }
    const expectedParameters = TOOL_PARAMETERS[candidate.name];
    if (expectedParameters !== undefined &&
        canonicalJson(candidate.parameters) !== canonicalJson(expectedParameters)) {
      throw new ModelProxyPolicyError("model request tool schema is invalid");
    }
    return candidate.name;
  });
  if (new Set(names).size !== 2 || names.some((name) => !ALLOWED_TOOL_NAMES.has(name))) {
    throw new ModelProxyPolicyError("model request tool authority is invalid");
  }
}

export class FixedModelProxy {
  readonly #marker: string;
  readonly #upstreamKey: string;
  readonly #upstreamUrl: string;
  readonly #upstreamModel: string;
  readonly #fetch: ModelProxyFetch;
  readonly #maxRequestBytes: number;

  constructor(options: FixedModelProxyOptions) {
    this.#marker = boundedSecret(options.proxy_marker, "proxy marker");
    this.#upstreamKey = boundedSecret(options.upstream_api_key, "upstream API key");
    this.#upstreamModel = boundedSecret(options.upstream_model, "fixed model");
    const upstream = new URL(options.upstream_url);
    if (upstream.protocol !== "https:" || upstream.username !== "" || upstream.password !== "" ||
        upstream.port !== "" || upstream.pathname !== "/v1/responses" ||
        upstream.search !== "" || upstream.hash !== "") {
      throw new ModelProxyPolicyError("fixed upstream must be an exact HTTPS /v1/responses URL");
    }
    this.#upstreamUrl = upstream.href;
    this.#fetch = options.fetch;
    this.#maxRequestBytes = options.max_request_bytes ?? 10_485_760;
    if (!Number.isSafeInteger(this.#maxRequestBytes) || this.#maxRequestBytes < 1 ||
        this.#maxRequestBytes > 10_485_760) {
      throw new ModelProxyPolicyError("model proxy request byte limit is invalid");
    }
  }

  async forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/responses" || url.search !== "" || url.hash !== "") {
      throw new ModelProxyPolicyError("model proxy accepts only the fixed route /v1/responses");
    }
    if (request.method !== "POST") {
      throw new ModelProxyPolicyError("model proxy accepts only POST");
    }
    if (!safeEqual(bearer(request), this.#marker)) {
      throw new ModelProxyPolicyError("model proxy marker rejected");
    }
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new ModelProxyPolicyError("model proxy requires application/json");
    }
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.#maxRequestBytes) {
      throw new ModelProxyPolicyError("model proxy request exceeds byte limit");
    }
    const bodyBytes = Buffer.from(await request.arrayBuffer());
    if (bodyBytes.byteLength === 0 || bodyBytes.byteLength > this.#maxRequestBytes) {
      throw new ModelProxyPolicyError("model proxy request exceeds byte limit");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bodyBytes.toString("utf8"));
    } catch {
      throw new ModelProxyPolicyError("model proxy request is not valid JSON");
    }
    const body = plainRecord(decoded, "model request");
    if (body.model !== this.#upstreamModel) {
      throw new ModelProxyPolicyError("model proxy requires the fixed model");
    }
    assertToolAuthority(body.tools);
    body.max_output_tokens = 16_384;
    body.store = false;
    body.background = false;
    body.parallel_tool_calls = false;
    const forwardedBody = JSON.stringify(body);
    if (Buffer.byteLength(forwardedBody, "utf8") > this.#maxRequestBytes) {
      throw new ModelProxyPolicyError("model proxy request exceeds byte limit");
    }
    const upstream = await this.#fetch(this.#upstreamUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#upstreamKey}`,
        "content-type": "application/json",
      },
      body: forwardedBody,
      signal: request.signal,
    });
    const responseHeaders = new Headers();
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType !== null) responseHeaders.set("content-type", responseContentType);
    const requestId = upstream.headers.get("x-request-id");
    if (requestId !== null) responseHeaders.set("x-request-id", requestId);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }
}
