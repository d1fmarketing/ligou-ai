import { timingSafeEqual } from "node:crypto";
import {
  ContractValidationError,
  parseSourceSnapshots,
  parseWorkerResult,
  type DiscoverySourceSnapshot,
  type WorkerResult,
} from "../contracts";
import type { DiscoveryAttemptContext } from "../fetch/discovery-fetch-gateway";

export const DISCOVERY_MCP_TOOL_NAMES = Object.freeze([
  "fetch_discovery_page",
  "submit_discovery_result",
] as const);

export interface McpToolDefinition {
  readonly name: typeof DISCOVERY_MCP_TOOL_NAMES[number];
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface BridgeConnection {
  readonly remote_address: string;
}

export const DISCOVERY_MCP_TOOL_PARAMETERS = Object.freeze({
  fetch_discovery_page: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["url"]),
    properties: Object.freeze({
      url: Object.freeze({ type: "string", minLength: 9, maxLength: 2_048 }),
    }),
  }),
  submit_discovery_result: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["result"]),
    properties: Object.freeze({ result: Object.freeze({ type: "object" }) }),
  }),
});

export interface AttemptMcpBridgeOptions {
  readonly proxy_marker: string;
  readonly expected_remote_address: string;
  readonly fetch_context: DiscoveryAttemptContext;
  readonly source_snapshots: readonly DiscoverySourceSnapshot[];
  readonly fetch_page: (
    context: DiscoveryAttemptContext,
    url: string,
  ) => Promise<DiscoverySourceSnapshot>;
  readonly submit_result: (result: WorkerResult) => Promise<void>;
  readonly retire_attempt?: (context: DiscoveryAttemptContext) => void;
}

const FETCH_TOOL: McpToolDefinition = Object.freeze({
  name: "fetch_discovery_page",
  description: "Read one supervisor-approved immutable public company evidence snapshot.",
  inputSchema: DISCOVERY_MCP_TOOL_PARAMETERS.fetch_discovery_page,
});

const SUBMIT_TOOL: McpToolDefinition = Object.freeze({
  name: "submit_discovery_result",
  description: "Submit one bounded company_discovery.result.v1 candidate for supervisor validation.",
  inputSchema: DISCOVERY_MCP_TOOL_PARAMETERS.submit_discovery_result,
});

const TOOL_DEFINITIONS = Object.freeze([FETCH_TOOL, SUBMIT_TOOL]);

function plainRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError(`${message}: expected plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractValidationError(`${message}: expected plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], message: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new ContractValidationError(`${message}: expected exact keys ${keys.join(",")}`);
  }
}

function secretMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function sameSnapshots(
  left: readonly DiscoverySourceSnapshot[],
  right: readonly DiscoverySourceSnapshot[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class AttemptMcpBridge {
  readonly #connections = new WeakSet<object>();
  readonly #marker: string;
  readonly #expectedRemoteAddress: string;
  readonly #fetchContext: DiscoveryAttemptContext;
  readonly #sourceSnapshots: readonly DiscoverySourceSnapshot[];
  readonly #sourceByUrl: ReadonlyMap<string, DiscoverySourceSnapshot>;
  readonly #fetchPage: AttemptMcpBridgeOptions["fetch_page"];
  readonly #submitResult: AttemptMcpBridgeOptions["submit_result"];
  readonly #retireAttempt?: AttemptMcpBridgeOptions["retire_attempt"];
  #retired = false;
  #submitted = false;
  #submitting = false;

  constructor(options: AttemptMcpBridgeOptions) {
    if (options.proxy_marker.trim() === "" || options.proxy_marker.length > 512) {
      throw new ContractValidationError("bridge proxy marker is invalid");
    }
    if (options.expected_remote_address.trim() === "") {
      throw new ContractValidationError("bridge expected remote address is invalid");
    }
    this.#marker = options.proxy_marker;
    this.#expectedRemoteAddress = options.expected_remote_address;
    this.#fetchContext = options.fetch_context;
    this.#sourceSnapshots = parseSourceSnapshots(options.source_snapshots);
    this.#sourceByUrl = new Map(this.#sourceSnapshots.map((snapshot) => [snapshot.url, snapshot]));
    this.#fetchPage = options.fetch_page;
    this.#submitResult = options.submit_result;
    this.#retireAttempt = options.retire_attempt;
  }

  listTools(): readonly McpToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  bindConnection(input: { readonly bearer: string; readonly remote_address: string }): BridgeConnection {
    if (!secretMatches(input.bearer, this.#marker) || input.remote_address !== this.#expectedRemoteAddress) {
      throw new ContractValidationError("trusted bridge connection rejected");
    }
    if (this.#retired) throw new ContractValidationError("attempt bridge is retired");
    const connection = Object.freeze({ remote_address: input.remote_address });
    this.#connections.add(connection);
    return connection;
  }

  async callTool(connection: BridgeConnection, name: string, args: unknown): Promise<any> {
    if (!this.#connections.has(connection)) {
      throw new ContractValidationError("trusted bridge connection required");
    }
    if (this.#retired) throw new ContractValidationError("attempt bridge is retired");
    if (name === "fetch_discovery_page") return this.#fetch(args);
    if (name === "submit_discovery_result") return this.#submit(args);
    throw new ContractValidationError(`unknown MCP tool: ${name}`);
  }

  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#retireAttempt?.(this.#fetchContext);
  }

  async #fetch(args: unknown): Promise<DiscoverySourceSnapshot> {
    const candidate = plainRecord(args, "fetch_discovery_page arguments");
    exactKeys(candidate, ["url"], "fetch_discovery_page arguments");
    if (typeof candidate.url !== "string" || candidate.url.length < 9 || candidate.url.length > 2_048) {
      throw new ContractValidationError("fetch_discovery_page.url is invalid");
    }
    const expected = this.#sourceByUrl.get(candidate.url);
    if (expected === undefined) {
      throw new ContractValidationError("fetch_discovery_page URL is outside immutable bound evidence");
    }
    const fetched = parseSourceSnapshots([await this.#fetchPage(this.#fetchContext, candidate.url)])[0]!;
    if (!sameSnapshots([fetched], [expected])) {
      throw new ContractValidationError("fetch_discovery_page evidence changed after binding");
    }
    if (this.#retired) throw new ContractValidationError("attempt bridge is retired");
    return fetched;
  }

  async #submit(args: unknown): Promise<{ readonly accepted: true }> {
    const candidate = plainRecord(args, "submit_discovery_result arguments");
    exactKeys(candidate, ["result"], "submit_discovery_result arguments");
    if (this.#submitted || this.#submitting) {
      throw new ContractValidationError("discovery result already submitted");
    }
    const parsed = parseWorkerResult(candidate.result);
    if (!sameSnapshots(parsed.source_snapshots, this.#sourceSnapshots)) {
      throw new ContractValidationError("discovery result evidence must equal immutable bound evidence");
    }
    this.#submitting = true;
    try {
      if (this.#retired) throw new ContractValidationError("attempt bridge is retired");
      await this.#submitResult(parsed);
      if (this.#retired) throw new ContractValidationError("attempt bridge is retired");
      this.#submitted = true;
      return Object.freeze({ accepted: true });
    } finally {
      this.#submitting = false;
    }
  }
}
