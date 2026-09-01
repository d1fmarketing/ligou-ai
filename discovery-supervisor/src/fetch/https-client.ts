import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { LookupFunction } from "node:net";
import { peerAddressMatches, type ResolvedAddress } from "./address-policy";

export interface HttpsRequest {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly maxBytes: number;
  readonly deadlineAt: number;
}

export interface HttpsResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Buffer;
  readonly remoteAddress: string | undefined;
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

function normalizeHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string | readonly string[] | undefined>> {
  return Object.freeze({ ...headers });
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
      const lookup: LookupFunction = ((_hostname, _options, callback) => {
        callback(null, input.address.address, input.address.family);
      }) as LookupFunction;
      const request = https.request({
        protocol: "https:",
        hostname: input.url.hostname,
        port: 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: "GET",
        servername: input.url.hostname,
        lookup,
        agent: false,
        rejectUnauthorized: true,
        headers: {
          Accept: "text/html",
          "Accept-Encoding": "identity",
          "Cache-Control": "no-cache",
          Connection: "close",
          Host: input.url.hostname,
          "User-Agent": "Ligou-Discovery-Gateway/1.0",
        },
      }, (response) => {
        const remoteAddress = response.socket.remoteAddress;
        if (!peerAddressMatches(input.address.address, remoteAddress)) {
          response.destroy();
          finishReject(new HttpsPolicyError("peer address mismatch"));
          return;
        }
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
          if (byteLength > input.maxBytes) {
            response.destroy();
            finishReject(new ResponseByteLimitError());
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          if (hardDeadlineTimer !== undefined) clearTimeout(hardDeadlineTimer);
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: normalizeHeaders(response.headers),
            body: Buffer.concat(chunks, byteLength),
            remoteAddress,
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
    const response = await this.transport.request(input);
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
