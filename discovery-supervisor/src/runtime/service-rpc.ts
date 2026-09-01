import type {
  ServiceRpcClient,
} from "../job-store";

export type ServiceRpcFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SupabaseServiceRpcClientOptions {
  readonly url: string;
  readonly service_key: string;
  readonly fetch?: ServiceRpcFetch;
  readonly timeout_ms?: number;
  readonly max_response_bytes?: number;
}

const ALLOWED_RPCS = new Set([
  "claim_company_discovery_attempt",
  "read_company_discovery_model_access",
  "read_company_discovery_subscription_recovery",
  "bind_company_discovery_runtime",
  "terminalize_company_discovery_attempt",
  "commit_company_discovery_result",
  "select_company_discovery_result",
  "claim_expired_company_discovery_cleanup",
  "record_company_discovery_cleanup",
  "quarantine_company_discovery_slot",
  "reserve_company_discovery_subscription_request",
  "settle_company_discovery_subscription_request",
]);

function endpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Supabase RPC URL is invalid"); }
  const local = parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if ((parsed.protocol !== "https:" && !local) || parsed.username !== "" ||
      parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Supabase RPC URL is invalid");
  }
  return parsed.href.replace(/\/$/u, "");
}

function protectedKey(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 8 ||
      value.length > 131_072 || /[\r\n\0]/u.test(value)) {
    throw new Error("Supabase service credential is invalid");
  }
  return value;
}

async function boundedResponse(response: Response, maximum: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maximum) {
        await reader.cancel("RPC response limit").catch(() => undefined);
        throw new Error("Supabase RPC response exceeded byte limit");
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function redactedError(name: string, status: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: "SupabaseRpcError",
    code: `http_${status}`,
    status,
    message: `${name} failed with HTTP ${status}`,
  });
}

export class SupabaseServiceRpcClient implements ServiceRpcClient {
  readonly #url: string;
  readonly #key: string;
  readonly #fetch: ServiceRpcFetch;
  readonly #timeoutMs: number;
  readonly #maximum: number;

  constructor(options: SupabaseServiceRpcClientOptions) {
    this.#url = endpoint(options.url);
    this.#key = protectedKey(options.service_key);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeout_ms ?? 30_000;
    this.#maximum = options.max_response_bytes ?? 16_777_216;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 ||
        this.#timeoutMs > 60_000 || !Number.isSafeInteger(this.#maximum) ||
        this.#maximum < 1_024 || this.#maximum > 33_554_432) {
      throw new Error("Supabase RPC transport bounds are invalid");
    }
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<{
    readonly data: unknown;
    readonly error: unknown;
  }> {
    if (!ALLOWED_RPCS.has(name)) throw new Error("Supabase RPC is not allowlisted");
    if (args === null || typeof args !== "object" || Array.isArray(args) ||
        (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)) {
      throw new Error("Supabase RPC arguments must be a plain object");
    }
    let body: string;
    try { body = JSON.stringify(args); }
    catch { throw new Error("Supabase RPC arguments are not serializable"); }
    if (Buffer.byteLength(body, "utf8") > 12_582_912) {
      throw new Error("Supabase RPC request exceeded byte limit");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(
          `${this.#url}/rest/v1/rpc/${name}`,
          {
            method: "POST",
            headers: {
              apikey: this.#key,
              authorization: `Bearer ${this.#key}`,
              "content-type": "application/json",
              accept: "application/json",
              "content-profile": "public",
              "accept-profile": "public",
              "cache-control": "no-store",
            },
            body,
            signal: controller.signal,
            redirect: "error",
          },
        );
      } catch {
        return {
          data: null,
          error: Object.freeze({
            name: "SupabaseRpcError",
            code: controller.signal.aborted ? "timeout" : "transport",
            message: `${name} transport failed`,
          }),
        };
      }
      const raw = await boundedResponse(response, this.#maximum);
      if (!response.ok) return { data: null, error: redactedError(name, response.status) };
      if (raw === "") return { data: null, error: null };
      try { return { data: JSON.parse(raw), error: null }; }
      catch { return { data: null, error: redactedError(name, 502) }; }
    } finally {
      clearTimeout(timer);
    }
  }
}
