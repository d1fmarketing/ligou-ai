import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { peerAddressMatches, type ResolvedAddress } from "./address-policy";

export interface HttpsRequest {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly maxBytes: number;
  readonly deadlineAt: number;
  readonly onBodyBytes?: (byteLength: number) => void;
  readonly signal?: AbortSignal;
}

export interface HttpsResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Buffer;
  readonly remoteAddress: string | undefined;
  readonly bodyBytesConsumed: number;
  readonly bodyDiscarded: boolean;
}

export interface PinnedHttpsTransport {
  readonly abortSettlement?: "drained";
  request(input: HttpsRequest): Promise<HttpsResponse>;
}

export class HttpsPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpsPolicyError";
  }
}

export class ResponseByteLimitError extends HttpsPolicyError {
  constructor() {
    super("response byte limit exceeded");
    this.name = "ResponseByteLimitError";
  }
}

function responseHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (typeof value === "string" || value === undefined) return value;
  return value.join(", ");
}

export function shouldBufferResponseBody(
  statusCode: number,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): boolean {
  if (statusCode < 200 || statusCode >= 300) return false;
  const mime = responseHeader(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime !== "text/html") return false;
  if (/(?:^|,)\s*attachment(?:\s*;|\s*,|\s*$)/i.test(responseHeader(headers, "content-disposition") ?? "")) {
    return false;
  }
  const encoding = responseHeader(headers, "content-encoding")?.trim().toLowerCase();
  return encoding === undefined || encoding === "" || encoding === "identity";
}

interface NodeHelperInput {
  readonly url: string;
  readonly address: ResolvedAddress;
  readonly maxBytes: number;
  readonly deadlineAt: number;
}

type NodeHelperEmitter = (event: unknown) => void;
type NodeHelperExecutor = (
  input: NodeHelperInput,
  emit: NodeHelperEmitter,
  signal?: AbortSignal,
) => Promise<void>;

const HELPER_PATH = fileURLToPath(new URL("./https-client-node-helper.mjs", import.meta.url));

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsPolicyError(`${name} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new HttpsPolicyError(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function helperHeaders(value: unknown): HttpsResponse["headers"] {
  const headers = plainRecord(value, "pinned HTTPS helper headers");
  if (Object.keys(headers).length > 200 || Object.entries(headers).some(([key, raw]) =>
    !/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/.test(key) ||
    !(typeof raw === "string" && raw.length <= 16_384 && !/[\r\n\0]/.test(raw)) &&
    !(Array.isArray(raw) && raw.length <= 32 && raw.every((item) =>
      typeof item === "string" && item.length <= 16_384 && !/[\r\n\0]/.test(item)
    ))
  )) {
    throw new HttpsPolicyError("pinned HTTPS helper headers are invalid");
  }
  return Object.freeze({ ...headers }) as HttpsResponse["headers"];
}

function helperBody(value: unknown): Buffer {
  if (typeof value !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HttpsPolicyError("pinned HTTPS helper body is invalid");
  }
  const body = Buffer.from(value, "base64");
  if (body.byteLength < 1 || body.toString("base64") !== value) {
    throw new HttpsPolicyError("pinned HTTPS helper body is invalid");
  }
  return body;
}

function helperError(code: unknown): Error {
  if (code === "response_byte_limit") return new ResponseByteLimitError();
  if (code === "peer_address_mismatch") return new HttpsPolicyError("peer address mismatch");
  if (code === "deadline") return new HttpsPolicyError("attempt deadline exceeded");
  return new HttpsPolicyError("HTTPS request failed");
}

export function createPinnedNodeHelperExecutor(
  spawnHelper: typeof spawn = spawn,
): NodeHelperExecutor {
  return async function executeNodeHelper(
    input: NodeHelperInput,
    emit: NodeHelperEmitter,
    signal?: AbortSignal,
  ): Promise<void> {
    const remaining = input.deadlineAt - Date.now();
    if (remaining <= 0) throw new HttpsPolicyError("attempt deadline exceeded");
    return new Promise((resolve, reject) => {
      const child = spawnHelper("node", [HELPER_PATH], {
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let pending = Buffer.alloc(0);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let terminalError: Error | undefined;
      let terminating = false;
      const maximumOutput = Math.ceil(input.maxBytes * 4 / 3) + 131_072;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const terminate = (error: Error): void => {
        terminalError ??= error;
        if (terminating) return;
        terminating = true;
        child.kill("SIGKILL");
      };
      const aborted = (): void => terminate(new HttpsPolicyError("HTTPS request aborted"));
      const timer = setTimeout(
        () => terminate(new HttpsPolicyError("attempt deadline exceeded")),
        remaining,
      );
      child.once("error", (error) => {
        terminalError ??= error instanceof Error
          ? error
          : new HttpsPolicyError("pinned HTTPS helper failed");
      });
      child.stdout.on("data", (chunk: Buffer | Uint8Array | string) => {
        if (settled || terminating) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes > maximumOutput) {
          terminate(new ResponseByteLimitError());
          return;
        }
        pending = Buffer.concat([pending, buffer]);
        for (let newline = pending.indexOf(0x0a); newline >= 0; newline = pending.indexOf(0x0a)) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (line.byteLength === 0) {
            terminate(new HttpsPolicyError("pinned HTTPS helper response is invalid"));
            return;
          }
          try {
            emit(JSON.parse(line.toString("utf8")));
          } catch (error) {
            terminate(error instanceof Error
              ? error
              : new HttpsPolicyError("pinned HTTPS helper response is invalid"));
            return;
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer | Uint8Array | string) => {
        if (settled || terminating) return;
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > 16_384) terminate(new HttpsPolicyError("pinned HTTPS helper failed"));
      });
      child.once("close", (code, closeSignal) => {
        if (settled) return;
        if (terminalError !== undefined) {
          finish(terminalError);
          return;
        }
        if (code !== 0 || closeSignal !== null || stderrBytes !== 0 || pending.byteLength !== 0) {
          finish(new HttpsPolicyError("pinned HTTPS helper failed"));
          return;
        }
        finish();
      });
      child.stdin.on("error", () => undefined);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) {
        aborted();
        return;
      }
      child.stdin.end(JSON.stringify(input));
    });
  };
}

const executeNodeHelper = createPinnedNodeHelperExecutor();

export function createPinnedNodeHelperTransport(
  execute: NodeHelperExecutor = executeNodeHelper,
): PinnedHttpsTransport {
  return Object.freeze({
    abortSettlement: "drained" as const,
    async request(input: HttpsRequest): Promise<HttpsResponse> {
      let statusCode: number | undefined;
      let headers: HttpsResponse["headers"] | undefined;
      let remoteAddress: string | undefined;
      let bufferBody = false;
      let meteredBytes = 0;
      let bodyBytesConsumed = 0;
      let ended = false;
      const chunks: Buffer[] = [];
      await execute({
        url: input.url.href,
        address: input.address,
        maxBytes: input.maxBytes,
        deadlineAt: input.deadlineAt,
      }, (value) => {
        const event = plainRecord(value, "pinned HTTPS helper event");
        if (event.type === "error" && Object.keys(event).length === 2 &&
            Object.hasOwn(event, "error")) {
          throw helperError(event.error);
        }
        if (event.type === "headers" && Object.keys(event).length === 4 &&
            Object.hasOwn(event, "statusCode") && Object.hasOwn(event, "headers") &&
            Object.hasOwn(event, "remoteAddress") && statusCode === undefined && !ended &&
            Number.isSafeInteger(event.statusCode) && (event.statusCode as number) >= 100 &&
            (event.statusCode as number) <= 599 && typeof event.remoteAddress === "string" &&
            event.remoteAddress.length > 0 && event.remoteAddress.length <= 100) {
          statusCode = event.statusCode as number;
          headers = helperHeaders(event.headers);
          remoteAddress = event.remoteAddress;
          if (!peerAddressMatches(input.address.address, remoteAddress)) {
            throw new HttpsPolicyError("peer address mismatch");
          }
          bufferBody = shouldBufferResponseBody(statusCode, headers);
          return;
        }
        if (event.type === "meter" && Object.keys(event).length === 2 &&
            Object.hasOwn(event, "byteLength") && statusCode !== undefined && !ended &&
            Number.isSafeInteger(event.byteLength) && (event.byteLength as number) > 0 &&
            Number.isSafeInteger(meteredBytes + (event.byteLength as number))) {
          const byteLength = event.byteLength as number;
          meteredBytes += byteLength;
          input.onBodyBytes?.(byteLength);
          if (meteredBytes > input.maxBytes) throw new ResponseByteLimitError();
          return;
        }
        if (event.type === "data" && Object.keys(event).length === 2 &&
            Object.hasOwn(event, "bodyBase64") && statusCode !== undefined && !ended) {
          const body = helperBody(event.bodyBase64);
          bodyBytesConsumed += body.byteLength;
          if (bodyBytesConsumed > meteredBytes || bodyBytesConsumed > input.maxBytes) {
            throw new HttpsPolicyError("pinned HTTPS helper response is invalid");
          }
          if (bufferBody) chunks.push(body);
          return;
        }
        if (event.type === "end" && Object.keys(event).length === 2 &&
            Object.hasOwn(event, "bodyBytesConsumed") && statusCode !== undefined && !ended &&
            Number.isSafeInteger(event.bodyBytesConsumed) &&
            event.bodyBytesConsumed === bodyBytesConsumed && meteredBytes === bodyBytesConsumed) {
          ended = true;
          return;
        }
        throw new HttpsPolicyError("pinned HTTPS helper response is invalid");
      }, input.signal);
      if (statusCode === undefined || headers === undefined || remoteAddress === undefined || !ended) {
        throw new HttpsPolicyError("pinned HTTPS helper response is invalid");
      }
      return Object.freeze({
        statusCode,
        headers,
        body: bufferBody ? Buffer.concat(chunks, bodyBytesConsumed) : Buffer.alloc(0),
        remoteAddress,
        bodyBytesConsumed,
        bodyDiscarded: !bufferBody,
      });
    },
  });
}

const pinnedNodeHelperTransport = createPinnedNodeHelperTransport();

export class HttpsClient {
  constructor(private readonly transport: PinnedHttpsTransport = pinnedNodeHelperTransport) {}

  async request(input: HttpsRequest): Promise<HttpsResponse> {
    let meteredBytes = 0;
    const pending = this.transport.request({
      ...input,
      onBodyBytes: (byteLength) => {
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
          throw new HttpsPolicyError("invalid transport byte meter value");
        }
        meteredBytes += byteLength;
        input.onBodyBytes?.(byteLength);
      },
    });
    const response = this.transport.abortSettlement === "drained"
      ? await pending
      : await raceWithSignal(pending, input.signal);
    if (response.bodyBytesConsumed !== meteredBytes || response.body.byteLength > meteredBytes) {
      throw new HttpsPolicyError("transport body metering mismatch");
    }
    if (response.bodyBytesConsumed > input.maxBytes) throw new ResponseByteLimitError();
    if (!peerAddressMatches(input.address.address, response.remoteAddress)) {
      throw new HttpsPolicyError("peer address mismatch");
    }
    if (response.body.byteLength > input.maxBytes) throw new ResponseByteLimitError();
    return Object.freeze({
      ...response,
      headers: Object.freeze({ ...response.headers }),
      body: Buffer.from(response.body),
    });
  }
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new HttpsPolicyError("HTTPS request aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      cleanup();
      reject(new HttpsPolicyError("HTTPS request aborted"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
