import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { dirname } from "node:path";
import { Readable } from "node:stream";
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
import { FixedModelProxy } from "./model-proxy";
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
  readonly model_proxy: FixedModelProxy;
  readonly max_proxy_request_bytes?: number;
}

export interface TrustedBridgeAddress {
  readonly http_url: string;
  readonly http_port: number;
  readonly relay_port: number;
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

async function boundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximum) throw new Error("trusted bridge request exceeds byte limit");
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

export class TrustedBridgeServer {
  readonly #options: TrustedBridgeServerOptions;
  readonly #httpServer: ReturnType<typeof createHttpServer>;
  readonly #relayServer: TcpServer;
  readonly #sockets = new Set<Socket>();
  readonly #mcpServers = new Set<McpProtocolServer>();
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
    this.#options = options;
    this.#httpServer = createHttpServer((request, response) => {
      void this.#handleHttp(request, response).catch((error) => {
        if (!response.headersSent) {
          writeJson(response, 500, {
            error: "trusted_bridge_request_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        } else {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    this.#httpServer.maxHeadersCount = 32;
    this.#httpServer.headersTimeout = 5_000;
    this.#httpServer.requestTimeout = 600_000;
    this.#httpServer.keepAliveTimeout = 5_000;
    this.#httpServer.on("connection", (socket) => this.#trackSocket(socket));
    this.#relayServer = createTcpServer((socket) => this.#relay(socket));
    this.#relayServer.on("connection", (socket) => this.#trackSocket(socket));
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
    if (requestUrl.pathname === "/v1/responses" && requestUrl.search === "") {
      await this.#handleProxy(request, response);
      return;
    }
    writeJson(response, 404, { error: "route_not_found" });
  }

  async #handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
    const server = createMcpServer(this.#options.mcp_bridge, connection);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    this.#mcpServers.add(server);
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } finally {
      this.#mcpServers.delete(server);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  async #handleProxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const maximum = this.#options.max_proxy_request_bytes ?? 10_485_760;
    const bytes = await boundedBody(request, maximum);
    const controller = new AbortController();
    const aborted = (): void => controller.abort();
    request.once("aborted", aborted);
    try {
      const webRequest = new Request(`http://bridge/v1/responses`, {
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
        Readable.fromWeb(proxied.body as any).pipe(response);
      }
    } finally {
      request.off("aborted", aborted);
    }
  }

  #relay(socket: Socket): void {
    if (this.#closed) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const upstream = connectTcp(this.#options.relay_target.port, this.#options.relay_target.host);
    this.#trackSocket(upstream);
    const fail = (): void => {
      socket.destroy();
      upstream.destroy();
    };
    socket.once("error", fail);
    upstream.once("error", fail);
    socket.pipe(upstream).pipe(socket);
  }

  #trackSocket(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
  }
}

interface BridgeProcessSecret {
  readonly upstream_api_key: string;
  readonly upstream_url: string;
  readonly upstream_model: string;
  readonly proxy_marker: string;
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
    "upstream_api_key",
    "upstream_url",
    "upstream_model",
    "proxy_marker",
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
  return Object.freeze({
    upstream_api_key: processString(candidate.upstream_api_key, "bridge upstream API key"),
    upstream_url: processString(candidate.upstream_url, "bridge upstream URL", 2_048),
    upstream_model: processString(candidate.upstream_model, "bridge upstream model", 200),
    proxy_marker: processString(candidate.proxy_marker, "bridge proxy marker", 512),
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
  const modelProxy = new FixedModelProxy({
    proxy_marker: secret.proxy_marker,
    upstream_api_key: secret.upstream_api_key,
    upstream_url: secret.upstream_url,
    upstream_model: secret.upstream_model,
    fetch: globalThis.fetch,
  });
  const server = new TrustedBridgeServer({
    host: "0.0.0.0",
    http_port: httpPort,
    relay_port: relayPort,
    relay_target: { host: cellHost, port: gatewayPort },
    mcp_bridge: mcpBridge,
    model_proxy: modelProxy,
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
