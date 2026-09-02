import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { LookupFunction } from "node:net";
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

export function buildPinnedHttpsRequestOptions(input: HttpsRequest): https.RequestOptions {
  const lookup: LookupFunction = ((_hostname, _options, callback) => {
    if (typeof _options === "object" && _options !== null && _options.all === true) {
      (callback as (error: null, addresses: Array<{ address: string; family: number }>) => void)(
        null,
        [{ address: input.address.address, family: input.address.family }],
      );
      return;
    }
    (callback as (error: null, address: string, family: number) => void)(
      null,
      input.address.address,
      input.address.family,
    );
  }) as LookupFunction;
  return {
    protocol: "https:",
    hostname: input.url.hostname,
    port: 443,
    path: `${input.url.pathname}${input.url.search}`,
    method: "GET",
    servername: input.url.hostname,
    lookup,
    agent: false,
    rejectUnauthorized: true,
    signal: input.signal,
    headers: {
      Accept: "text/html",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-cache",
      Connection: "close",
      Host: input.url.hostname,
      "User-Agent": "Ligou-Discovery-Gateway/1.0",
    },
  };
}

function normalizeHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string | readonly string[] | undefined>> {
  return Object.freeze({ ...headers });
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

const nodeTransport: PinnedHttpsTransport = {
  request(input): Promise<HttpsResponse> {
    return new Promise((resolve, reject) => {
      const remaining = input.deadlineAt - Date.now();
      if (remaining <= 0) {
        reject(new HttpsPolicyError("attempt deadline exceeded"));
        return;
      }

      let settled = false;
      let hardDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (hardDeadlineTimer !== undefined) clearTimeout(hardDeadlineTimer);
        reject(error);
      };
      const request = https.request(buildPinnedHttpsRequestOptions(input), (response) => {
        const remoteAddress = response.socket.remoteAddress;
        if (!peerAddressMatches(input.address.address, remoteAddress)) {
          response.destroy();
          finishReject(new HttpsPolicyError("peer address mismatch"));
          return;
        }
        const headers = normalizeHeaders(response.headers);
        const bufferBody = shouldBufferResponseBody(response.statusCode ?? 0, headers);
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
          response.destroy();
          finishReject(new ResponseByteLimitError());
          return;
        }
        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("data", (chunk: Buffer | Uint8Array | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteLength += buffer.byteLength;
          try {
            input.onBodyBytes?.(buffer.byteLength);
          } catch (error) {
            response.destroy();
            finishReject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (byteLength > input.maxBytes) {
            response.destroy();
            finishReject(new ResponseByteLimitError());
            return;
          }
          if (bufferBody) chunks.push(buffer);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          if (hardDeadlineTimer !== undefined) clearTimeout(hardDeadlineTimer);
          resolve({
            statusCode: response.statusCode ?? 0,
            headers,
            body: bufferBody ? Buffer.concat(chunks, byteLength) : Buffer.alloc(0),
            remoteAddress,
            bodyBytesConsumed: byteLength,
            bodyDiscarded: !bufferBody,
          });
        });
        response.on("error", finishReject);
      });
      request.setTimeout(Math.min(remaining, 30_000), () => {
        request.destroy(new HttpsPolicyError("HTTPS request timed out"));
      });
      hardDeadlineTimer = setTimeout(() => {
        request.destroy(new HttpsPolicyError("attempt deadline exceeded"));
      }, remaining);
      request.on("error", (error) => finishReject(error instanceof Error ? error : new Error(String(error))));
      request.end();
    });
  },
};

export class HttpsClient {
  constructor(private readonly transport: PinnedHttpsTransport = nodeTransport) {}

  async request(input: HttpsRequest): Promise<HttpsResponse> {
    let meteredBytes = 0;
    const response = await raceWithSignal(this.transport.request({
      ...input,
      onBodyBytes: (byteLength) => {
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
          throw new HttpsPolicyError("invalid transport byte meter value");
        }
        meteredBytes += byteLength;
        input.onBodyBytes?.(byteLength);
      },
    }), input.signal);
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
