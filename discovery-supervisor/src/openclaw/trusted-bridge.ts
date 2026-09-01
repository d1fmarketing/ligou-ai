import {
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { lookup } from "node:dns/promises";
import { setMaxListeners } from "node:events";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AttemptMcpBridge,
  type BridgeConnection,
} from "./mcp-bridge";
import {
  parseSourceSnapshots,
  parseWorkerResult,
  type DiscoveryBudget,
  type DiscoverySourceSnapshot,
  type WorkerResult,
} from "../contracts";
import { createDiscoveryAttemptContext } from "../fetch/discovery-fetch-gateway";

export interface TrustedBridgeServerOptions {
  readonly host: string;
  readonly http_port: number;
  readonly relay_port: number;
  readonly relay_target: {
    readonly host: string;
    readonly port: number;
  };
  readonly mcp_bridge: AttemptMcpBridge;
  readonly model_proxy: SubscriptionRequestForwarder;
  readonly max_proxy_request_bytes?: number;
  readonly max_mcp_request_bytes?: number;
  readonly max_http_connections?: number;
  readonly max_mcp_concurrency?: number;
  readonly max_relay_connections?: number;
  readonly unauthenticated_admission_timeout_ms?: number;
  readonly authenticated_session_timeout_ms?: number;
}

export interface SubscriptionRequestForwarder {
  forward(request: Request): Promise<Response>;
  retire(): void;
}

export interface TrustedBridgeAddress {
  readonly http_url: string;
  readonly http_port: number;
  readonly relay_port: number;
}

class BridgeRequestLimitError extends Error {
  constructor() {
    super("trusted bridge request exceeds byte limit");
    this.name = "BridgeRequestLimitError";
  }
}

function normalizedAddress(value: string | undefined): string {
  if (value === undefined) return "";
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function requestBearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function activePort(server: ReturnType<typeof createHttpServer> | TcpServer, message: string): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(message);
  return address.port;
}

async function listen(
  server: ReturnType<typeof createHttpServer> | TcpServer,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const error = (cause: Error): void => {
      server.off("listening", ready);
      reject(cause);
    };
    const ready = (): void => {
      server.off("error", error);
      resolve();
    };
    server.once("error", error);
    server.once("listening", ready);
    server.listen(port, host);
  });
}

async function closeServer(server: ReturnType<typeof createHttpServer> | TcpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function boundedBody(
  request: IncomingMessage,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum)) {
    throw new BridgeRequestLimitError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw new Error("trusted bridge request aborted");
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximum) throw new BridgeRequestLimitError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function webHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return headers;
}

function createMcpServer(
  bridge: AttemptMcpBridge,
  connection: BridgeConnection,
): McpProtocolServer {
  const server = new McpProtocolServer(
    { name: "ligou-stage0-discovery-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: bridge.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as any,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const value = await bridge.callTool(
      connection,
      request.params.name,
      request.params.arguments ?? {},
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
      isError: false,
    };
  });
  return server;
}

export interface UnixSubscriptionForwarderOptions {
  readonly socket_path: string;
  readonly attempt_marker: string;
  readonly max_request_bytes?: number;
}

export class UnixSubscriptionForwarder implements SubscriptionRequestForwarder {
  readonly #socketPath: string;
  readonly #marker: string;
  readonly #maxRequestBytes: number;
  readonly #requests = new Set<ClientRequest>();
  #retired = false;

  constructor(options: UnixSubscriptionForwarderOptions) {
    if (options.socket_path !== "/run/ligou-subscription/subscription.sock") {
      throw new Error("subscription socket path is invalid");
    }
    this.#socketPath = options.socket_path;
    this.#marker = processString(options.attempt_marker, "subscription attempt marker", 4_096);
    this.#maxRequestBytes = options.max_request_bytes ?? 400_000;
    if (!Number.isSafeInteger(this.#maxRequestBytes) ||
        this.#maxRequestBytes < 1 || this.#maxRequestBytes > 400_000) {
      throw new Error("subscription forwarder request limit is invalid");
    }
  }

  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    for (const request of this.#requests) request.destroy(new Error("subscription relay retired"));
  }

  async forward(request: Request): Promise<Response> {
    if (this.#retired) throw new Error("subscription relay is retired");
    if (request.signal.aborted) throw new Error("subscription relay request aborted");
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/codex/responses" || url.search || url.hash) {
      throw new Error("subscription relay route is invalid");
    }
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length === 0 || body.length > this.#maxRequestBytes) {
      throw new Error("subscription relay request exceeds byte limit");
    }
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const forwarded = httpRequest({
        socketPath: this.#socketPath,
        path: "/codex/responses",
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#marker}`,
          "content-type": "application/json",
          "content-length": String(body.length),
          accept: "text/event-stream",
          connection: "close",
        },
      }, (response) => {
        settled = true;
        cleanup();
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(", "));
        }
        const status = response.statusCode ?? 502;
        resolve(new Response(
          status === 204 || status === 304 ? null : Readable.toWeb(response) as ReadableStream,
          { status, statusText: response.statusMessage, headers },
        ));
      });
      this.#requests.add(forwarded);
      const cleanup = (): void => {
        request.signal.removeEventListener("abort", aborted);
        this.#requests.delete(forwarded);
      };
      const aborted = (): void => { forwarded.destroy(new Error("subscription relay request aborted")); };
      forwarded.once("error", (error) => {
        cleanup();
        if (!settled) reject(error);
      });
      forwarded.once("close", cleanup);
      request.signal.addEventListener("abort", aborted, { once: true });
      if (request.signal.aborted || this.#retired) {
        aborted();
        return;
      }
      forwarded.end(body);
    });
  }
}

export class TrustedBridgeServer {
  readonly #options: TrustedBridgeServerOptions;
  readonly #httpServer: ReturnType<typeof createHttpServer>;
  readonly #relayServer: TcpServer;
  readonly #sockets = new Set<Socket>();
  readonly #mcpServers = new Set<McpProtocolServer>();
  readonly #maxProxyRequestBytes: number;
  readonly #maxMcpRequestBytes: number;
  readonly #maxMcpConcurrency: number;
  readonly #maxRelayConnections: number;
  readonly #admissionTimeoutMs: number;
  readonly #authenticatedSessionTimeoutMs: number;
  readonly #httpAdmissionTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
  #activeMcpRequests = 0;
  #activeRelayConnections = 0;
  #started = false;
  #closed = false;

  constructor(options: TrustedBridgeServerOptions) {
    if (options.host.trim() === "" || !Number.isSafeInteger(options.http_port) ||
        options.http_port < 0 || options.http_port > 65_535 ||
        !Number.isSafeInteger(options.relay_port) || options.relay_port < 0 ||
        options.relay_port > 65_535 || options.relay_target.host.trim() === "" ||
        !Number.isSafeInteger(options.relay_target.port) || options.relay_target.port < 1 ||
        options.relay_target.port > 65_535) {
      throw new Error("trusted bridge listener configuration is invalid");
    }
    const boundedOption = (value: number | undefined, fallback: number, maximum: number, name: string) => {
      const parsed = value ?? fallback;
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new Error(`${name} is invalid`);
      }
      return parsed;
    };
    this.#options = options;
    this.#maxProxyRequestBytes = boundedOption(
      options.max_proxy_request_bytes,
      400_000,
      400_000,
      "trusted bridge proxy byte limit",
    );
    this.#maxMcpRequestBytes = boundedOption(
      options.max_mcp_request_bytes,
      262_144,
      262_144,
      "trusted bridge MCP byte limit",
    );
    this.#maxMcpConcurrency = boundedOption(
      options.max_mcp_concurrency,
      1,
      1,
      "trusted bridge MCP concurrency",
    );
    this.#maxRelayConnections = boundedOption(
      options.max_relay_connections,
      1,
      1,
      "trusted bridge relay concurrency",
    );
    this.#admissionTimeoutMs = boundedOption(
      options.unauthenticated_admission_timeout_ms,
      15_000,
      30_000,
      "trusted bridge unauthenticated admission timeout",
    );
    this.#authenticatedSessionTimeoutMs = boundedOption(
      options.authenticated_session_timeout_ms,
      600_000,
      600_000,
      "trusted bridge authenticated session timeout",
    );
    this.#httpServer = createHttpServer((request, response) => {
      void this.#handleHttp(request, response).catch((error) => {
        if (!response.headersSent) {
          writeJson(
            response,
            error instanceof BridgeRequestLimitError ? 413 : 500,
            { error: error instanceof BridgeRequestLimitError
              ? "trusted_bridge_request_too_large"
              : "trusted_bridge_request_failed" },
          );
        } else {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    this.#httpServer.maxHeadersCount = 32;
    this.#httpServer.maxConnections = boundedOption(
      options.max_http_connections,
      8,
      32,
      "trusted bridge HTTP connection limit",
    );
    this.#httpServer.maxRequestsPerSocket = 32;
    this.#httpServer.headersTimeout = Math.min(5_000, this.#admissionTimeoutMs);
    this.#httpServer.requestTimeout = this.#admissionTimeoutMs;
    this.#httpServer.keepAliveTimeout = Math.min(5_000, this.#admissionTimeoutMs);
    this.#httpServer.on("connection", (socket) => this.#trackHttpSocket(socket));
    this.#relayServer = createTcpServer((socket) => this.#relay(socket));
    this.#relayServer.on("connection", (socket) => this.#trackRelaySocket(socket));
  }

  async start(): Promise<TrustedBridgeAddress> {
    if (this.#closed) throw new Error("trusted bridge is closed");
    if (this.#started) throw new Error("trusted bridge already started");
    this.#started = true;
    try {
      await listen(this.#httpServer, this.#options.http_port, this.#options.host);
      await listen(this.#relayServer, this.#options.relay_port, this.#options.host);
    } catch (error) {
      await closeServer(this.#httpServer);
      await closeServer(this.#relayServer);
      throw error;
    }
    const httpPort = activePort(this.#httpServer, "trusted bridge HTTP listener missing");
    const relayPort = activePort(this.#relayServer, "trusted bridge relay listener missing");
    return Object.freeze({
      http_url: `http://${this.#options.host}:${httpPort}`,
      http_port: httpPort,
      relay_port: relayPort,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.mcp_bridge.retire();
    this.#options.model_proxy.retire();
    for (const socket of this.#sockets) socket.destroy();
    await Promise.allSettled([...this.#mcpServers].map((server) => server.close()));
    await Promise.all([closeServer(this.#httpServer), closeServer(this.#relayServer)]);
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#closed) {
      writeJson(response, 503, { error: "trusted_bridge_closed" });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "bridge"}`);
    if (requestUrl.pathname === "/mcp" && requestUrl.search === "") {
      await this.#handleMcp(request, response);
      return;
    }
    if (requestUrl.pathname === "/codex/responses" && requestUrl.search === "") {
      await this.#handleProxy(request, response);
      return;
    }
    writeJson(response, 404, { error: "route_not_found" });
  }

  async #handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "mcp_post_required" });
      return;
    }
    const rawContentType = request.headers["content-type"];
    const contentType = typeof rawContentType === "string"
      ? rawContentType.split(";", 1)[0]?.trim().toLowerCase()
      : undefined;
    if (contentType !== "application/json") {
      writeJson(response, 415, { error: "mcp_json_required" });
      return;
    }
    let connection: BridgeConnection;
    try {
      connection = this.#options.mcp_bridge.bindConnection({
        bearer: requestBearer(request),
        remote_address: normalizedAddress(request.socket.remoteAddress),
      });
    } catch {
      writeJson(response, 401, { error: "mcp_connection_rejected" });
      return;
    }
    if (this.#activeMcpRequests >= this.#maxMcpConcurrency) {
      writeJson(response, 429, { error: "mcp_concurrency_limited" });
      return;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once("aborted", abort);
    const responseClosed = (): void => { if (!response.writableEnded) abort(); };
    response.once("close", responseClosed);
    this.#activeMcpRequests += 1;
    const server = createMcpServer(this.#options.mcp_bridge, connection);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    this.#mcpServers.add(server);
    try {
      const bytes = await boundedBody(request, this.#maxMcpRequestBytes, controller.signal);
      this.#markHttpAdmitted(request.socket);
      let parsedBody: unknown;
      try { parsedBody = JSON.parse(bytes.toString("utf8")); }
      catch {
        writeJson(response, 400, { error: "mcp_json_invalid" });
        return;
      }
      await server.connect(transport);
      await transport.handleRequest(request, response, parsedBody);
    } finally {
      this.#activeMcpRequests -= 1;
      request.off("aborted", abort);
      response.off("close", responseClosed);
      this.#mcpServers.delete(server);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  async #handleProxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const aborted = (): void => controller.abort();
    request.once("aborted", aborted);
    const responseClosed = (): void => { if (!response.writableEnded) aborted(); };
    response.once("close", responseClosed);
    try {
      const bytes = await boundedBody(request, this.#maxProxyRequestBytes, controller.signal);
      this.#markHttpAdmitted(request.socket);
      const webRequest = new Request(`http://bridge/codex/responses`, {
        method: request.method,
        headers: webHeaders(request),
        body: bytes,
        signal: controller.signal,
      });
      const proxied = await this.#options.model_proxy.forward(webRequest);
      response.statusCode = proxied.status;
      response.statusMessage = proxied.statusText;
      proxied.headers.forEach((value, name) => response.setHeader(name, value));
      response.setHeader("cache-control", "no-store");
      if (proxied.body === null) {
        response.end();
      } else {
        await pipeline(
          Readable.fromWeb(proxied.body as any),
          response,
          { signal: controller.signal },
        );
      }
    } finally {
      request.off("aborted", aborted);
      response.off("close", responseClosed);
    }
  }

  #relay(socket: Socket): void {
    if (this.#closed || this.#activeRelayConnections >= this.#maxRelayConnections) {
      socket.destroy();
      return;
    }
    this.#activeRelayConnections += 1;
    socket.setNoDelay(true);
    const upstream = connectTcp(this.#options.relay_target.port, this.#options.relay_target.host);
    this.#trackAuthenticatedSocket(upstream);
    // Two abort-aware pipelines share each duplex socket (one per direction).
    // Raise only these attempt-local emitters above Node's default listener cap.
    setMaxListeners(24, socket, upstream);
    const controller = new AbortController();
    let released = false;
    const fail = (): void => {
      controller.abort();
      socket.destroy();
      upstream.destroy();
      if (!released) {
        released = true;
        this.#activeRelayConnections -= 1;
      }
    };
    socket.once("error", fail);
    upstream.once("error", fail);
    socket.once("timeout", fail);
    upstream.once("timeout", fail);
    socket.once("close", fail);
    upstream.once("close", fail);
    void Promise.all([
      pipeline(socket, upstream, { signal: controller.signal }),
      pipeline(upstream, socket, { signal: controller.signal }),
    ]).catch(fail);
  }

  #trackHttpSocket(socket: Socket): void {
    this.#sockets.add(socket);
    const admissionTimer = setTimeout(() => socket.destroy(), this.#admissionTimeoutMs);
    this.#httpAdmissionTimers.set(socket, admissionTimer);
    socket.once("close", () => {
      clearTimeout(admissionTimer);
      this.#httpAdmissionTimers.delete(socket);
      this.#sockets.delete(socket);
    });
  }

  #markHttpAdmitted(socket: Socket): void {
    const timer = this.#httpAdmissionTimers.get(socket);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#httpAdmissionTimers.delete(socket);
    }
    // Authenticated model work is bounded by the central attempt deadline, not
    // by the unauthenticated 15-second admission window.
    socket.setTimeout(0);
  }

  #trackRelaySocket(socket: Socket): void {
    this.#sockets.add(socket);
    const admissionTimer = setTimeout(() => socket.destroy(), this.#admissionTimeoutMs);
    const admitted = (): void => {
      clearTimeout(admissionTimer);
      const sessionTimer = setTimeout(
        () => socket.destroy(),
        this.#authenticatedSessionTimeoutMs,
      );
      socket.once("close", () => clearTimeout(sessionTimer));
    };
    socket.once("data", admitted);
    socket.once("close", () => {
      clearTimeout(admissionTimer);
      socket.off("data", admitted);
      this.#sockets.delete(socket);
    });
  }

  #trackAuthenticatedSocket(socket: Socket): void {
    this.#sockets.add(socket);
    const sessionTimer = setTimeout(
      () => socket.destroy(),
      this.#authenticatedSessionTimeoutMs,
    );
    socket.once("close", () => {
      clearTimeout(sessionTimer);
      this.#sockets.delete(socket);
    });
  }
}

interface BridgeProcessSecret {
  readonly upstream_model: string;
  readonly proxy_marker: string;
  readonly subscription_socket_path: string;
  readonly normalized_origin: string;
  readonly deadline_at: string;
  readonly budget: DiscoveryBudget;
  readonly source_snapshots: readonly DiscoverySourceSnapshot[];
}

function processRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${message}: expected plain object`);
  }
  return value as Record<string, unknown>;
}

function exactProcessKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  message: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${message}: unexpected fields`);
  }
}

function processString(value: unknown, name: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function processPort(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

async function readProcessSecret(path: string): Promise<BridgeProcessSecret> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`bridge secret could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = processRecord(decoded, "bridge secret");
  const keys = [
    "upstream_model",
    "proxy_marker",
    "subscription_socket_path",
    "normalized_origin",
    "deadline_at",
    "budget",
    "source_snapshots",
  ] as const;
  exactProcessKeys(candidate, keys, "bridge secret");
  const normalizedOrigin = processString(candidate.normalized_origin, "bridge normalized origin", 2_048);
  const deadlineAt = processString(candidate.deadline_at, "bridge deadline", 32);
  const context = createDiscoveryAttemptContext({
    normalized_origin: normalizedOrigin,
    deadline_at: deadlineAt,
    budget: candidate.budget as DiscoveryBudget,
  });
  const socketPath = processString(
    candidate.subscription_socket_path,
    "bridge subscription socket path",
    96,
  );
  if (socketPath !== "/run/ligou-subscription/subscription.sock") {
    throw new Error("bridge subscription socket path is invalid");
  }
  return Object.freeze({
    upstream_model: processString(candidate.upstream_model, "bridge upstream model", 200),
    proxy_marker: processString(candidate.proxy_marker, "bridge proxy marker", 512),
    subscription_socket_path: socketPath,
    normalized_origin: context.normalized_origin,
    deadline_at: context.deadline_at,
    budget: context.budget,
    source_snapshots: parseSourceSnapshots(candidate.source_snapshots, { budget: context.budget }),
  });
}

async function resolveCellAddress(host: string, maximumWaitMs = 30_000): Promise<string> {
  const deadline = Date.now() + maximumWaitMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return normalizedAddress((await lookup(host)).address);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`cell runtime identity could not be resolved: ${String(lastError)}`);
}

async function atomicResultSink(path: string, candidate: WorkerResult): Promise<void> {
  const parsed = parseWorkerResult(candidate);
  try {
    await access(path);
    throw new Error("discovery result already exists");
  } catch (error) {
    if (error instanceof Error && error.message === "discovery result already exists") throw error;
  }
  const temporary = `${path}.pending`;
  const body = JSON.stringify(parsed);
  if (Buffer.byteLength(body, "utf8") > 10_485_760) throw new Error("discovery result exceeds byte limit");
  if (dirname(path) === ".") throw new Error("bridge output path must be absolute");
  await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

export async function startTrustedBridgeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TrustedBridgeServer> {
  const secretPath = processString(environment.BRIDGE_SECRET_PATH, "BRIDGE_SECRET_PATH", 4_096);
  const outputPath = processString(environment.BRIDGE_OUTPUT_PATH, "BRIDGE_OUTPUT_PATH", 4_096);
  if (!secretPath.startsWith("/") || !outputPath.startsWith("/")) {
    throw new Error("bridge paths must be absolute");
  }
  const cellHost = processString(environment.OPENCLAW_CELL_HOST, "OPENCLAW_CELL_HOST", 253);
  const gatewayPort = processPort(environment.OPENCLAW_CELL_GATEWAY_PORT, "OPENCLAW_CELL_GATEWAY_PORT");
  const httpPort = processPort(environment.BRIDGE_HTTP_PORT, "BRIDGE_HTTP_PORT");
  const relayPort = processPort(environment.BRIDGE_RELAY_PORT, "BRIDGE_RELAY_PORT");
  const [secret, cellAddress] = await Promise.all([
    readProcessSecret(secretPath),
    resolveCellAddress(cellHost),
  ]);
  const context = createDiscoveryAttemptContext({
    normalized_origin: secret.normalized_origin,
    deadline_at: secret.deadline_at,
    budget: secret.budget,
  });
  const byUrl = new Map(secret.source_snapshots.map((snapshot) => [snapshot.url, snapshot]));
  const mcpBridge = new AttemptMcpBridge({
    proxy_marker: secret.proxy_marker,
    expected_remote_address: cellAddress,
    fetch_context: context,
    source_snapshots: secret.source_snapshots,
    fetch_page: async (receivedContext, url) => {
      if (receivedContext !== context) throw new Error("opaque fetch context mismatch");
      const snapshot = byUrl.get(url);
      if (snapshot === undefined) throw new Error("URL is outside immutable bound evidence");
      return snapshot;
    },
    submit_result: (result) => atomicResultSink(outputPath, result),
    retire_attempt: () => undefined,
  });
  const modelProxy = new UnixSubscriptionForwarder({
    socket_path: secret.subscription_socket_path,
    attempt_marker: secret.proxy_marker,
  });
  const remainingAttemptMs = Date.parse(secret.deadline_at) - Date.now();
  if (!Number.isFinite(remainingAttemptMs) || remainingAttemptMs <= 0 ||
      remainingAttemptMs > 600_000) {
    throw new Error("bridge attempt deadline is invalid");
  }
  const server = new TrustedBridgeServer({
    host: "0.0.0.0",
    http_port: httpPort,
    relay_port: relayPort,
    relay_target: { host: cellHost, port: gatewayPort },
    mcp_bridge: mcpBridge,
    model_proxy: modelProxy,
    authenticated_session_timeout_ms: Math.ceil(remainingAttemptMs),
  });
  await server.start();
  const shutdown = (): void => {
    void server.close().finally(() => {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void startTrustedBridgeFromEnvironment().catch((error) => {
    process.stderr.write(`trusted bridge startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
