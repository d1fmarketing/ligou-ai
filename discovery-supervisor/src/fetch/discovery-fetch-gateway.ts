import type { DiscoveryBudget, DiscoverySourceSnapshot } from "../contracts";
import { AddressPolicy, type PublicAddressResolver } from "./address-policy";
import {
  HttpsClient,
  ResponseByteLimitError,
  type HttpsResponse,
} from "./https-client";
import { parseStaticHtml } from "./html-page";
import {
  assertWithinRegistrableDomain,
  normalizeDiscoveryUrl,
} from "./url-policy";

export interface DiscoveryAttemptContext {
  readonly normalized_origin: string;
  readonly deadline_at: string;
  readonly budget: DiscoveryBudget;
}

export interface DiscoveryFetchGatewayDependencies {
  readonly addressPolicy?: PublicAddressResolver;
  readonly httpsClient?: HttpsClient;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface RunState {
  readonly origin: URL;
  readonly deadlineAt: number;
  readonly budget: DiscoveryBudget;
}

interface FetchedPage {
  readonly snapshot: DiscoverySourceSnapshot;
  readonly links: readonly string[];
}

export class DiscoveryFetchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryFetchPolicyError";
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function header(response: HttpsResponse, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()];
  if (typeof value === "string" || value === undefined) return value;
  return value.join(", ");
}

function validateBudget(budget: DiscoveryBudget): DiscoveryBudget {
  const limits = {
    max_pages: 25,
    max_depth: 2,
    max_page_bytes: 1_048_576,
    max_job_bytes: 10_485_760,
    deadline_seconds: 600,
  } as const;
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    const value = budget[key];
    if (!Number.isSafeInteger(value) || value < (key === "max_depth" ? 0 : 1) || value > limits[key]) {
      throw new DiscoveryFetchPolicyError(`invalid ${key} budget`);
    }
  }
  return Object.freeze({ ...budget });
}

function validateHtmlResponse(response: HttpsResponse): void {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new DiscoveryFetchPolicyError(`HTTP status ${response.statusCode} is not a successful page`);
  }
  const mime = header(response, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime !== "text/html") throw new DiscoveryFetchPolicyError("text/html response required");
  if (/^\s*attachment(?:\s*;|\s*$)/i.test(header(response, "content-disposition") ?? "")) {
    throw new DiscoveryFetchPolicyError("attachment responses are forbidden");
  }
  const encoding = header(response, "content-encoding")?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    throw new DiscoveryFetchPolicyError("encoded responses are forbidden");
  }
}

export class DiscoveryFetchGateway {
  private readonly addressPolicy: PublicAddressResolver;
  private readonly httpsClient: HttpsClient;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly nextRequestAtByOrigin = new Map<string, number>();

  constructor(dependencies: DiscoveryFetchGatewayDependencies = {}) {
    this.addressPolicy = dependencies.addressPolicy ?? new AddressPolicy();
    this.httpsClient = dependencies.httpsClient ?? new HttpsClient();
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async fetchPage(
    attemptContext: DiscoveryAttemptContext,
    url: string,
  ): Promise<DiscoverySourceSnapshot> {
    const state = this.createRunState(attemptContext);
    return (await this.fetchContainedPage(state, url, 0, 0, state.budget.max_page_bytes)).snapshot;
  }

  async crawl(
    attemptContext: DiscoveryAttemptContext,
    originUrl: string,
  ): Promise<readonly DiscoverySourceSnapshot[]> {
    const state = this.createRunState(attemptContext);
    const initial = normalizeDiscoveryUrl(originUrl);
    assertWithinRegistrableDomain(state.origin, initial);
    const queue: Array<{ readonly url: string; readonly depth: number }> = [{ url: initial.href, depth: 0 }];
    const scheduled = new Set([initial.href]);
    const snapshots: DiscoverySourceSnapshot[] = [];
    let totalBytes = 0;

    while (queue.length > 0 && snapshots.length < state.budget.max_pages) {
      const next = queue.shift()!;
      const remaining = state.budget.max_job_bytes - totalBytes;
      if (remaining <= 0) throw new DiscoveryFetchPolicyError("job byte limit exceeded");
      let fetched: FetchedPage;
      try {
        fetched = await this.fetchContainedPage(
          state,
          next.url,
          snapshots.length,
          next.depth,
          Math.min(state.budget.max_page_bytes, remaining),
        );
      } catch (error) {
        if (error instanceof ResponseByteLimitError && remaining < state.budget.max_page_bytes) {
          throw new DiscoveryFetchPolicyError("job byte limit exceeded");
        }
        throw error;
      }
      totalBytes += fetched.snapshot.byte_length;
      if (totalBytes > state.budget.max_job_bytes) {
        throw new DiscoveryFetchPolicyError("job byte limit exceeded");
      }
      snapshots.push(fetched.snapshot);
      scheduled.add(fetched.snapshot.url);

      if (next.depth >= state.budget.max_depth) continue;
      const finalUrl = new URL(fetched.snapshot.url);
      for (const href of fetched.links) {
        let candidate: URL;
        try {
          candidate = normalizeDiscoveryUrl(href, finalUrl);
          assertWithinRegistrableDomain(state.origin, candidate);
        } catch {
          continue;
        }
        if (scheduled.has(candidate.href)) continue;
        scheduled.add(candidate.href);
        queue.push({ url: candidate.href, depth: next.depth + 1 });
      }
    }
    return Object.freeze(snapshots);
  }

  private createRunState(context: DiscoveryAttemptContext): RunState {
    const budget = validateBudget(context.budget);
    const origin = normalizeDiscoveryUrl(context.normalized_origin);
    const declaredDeadline = Date.parse(context.deadline_at);
    if (!Number.isFinite(declaredDeadline)) throw new DiscoveryFetchPolicyError("invalid attempt deadline");
    const deadlineAt = Math.min(
      declaredDeadline,
      this.now() + Math.min(budget.deadline_seconds, 600) * 1_000,
    );
    if (deadlineAt <= this.now()) throw new DiscoveryFetchPolicyError("attempt deadline exceeded");
    return { origin, deadlineAt, budget };
  }

  private async rateLimit(state: RunState, origin: string): Promise<void> {
    const now = this.now();
    const reservedStart = Math.max(now, this.nextRequestAtByOrigin.get(origin) ?? now);
    if (reservedStart >= state.deadlineAt) {
      throw new DiscoveryFetchPolicyError("attempt deadline exceeded while rate limiting");
    }
    this.nextRequestAtByOrigin.set(origin, reservedStart + 1_000);
    const wait = reservedStart - now;
    if (wait > 0) await this.sleep(wait);
    if (this.now() >= state.deadlineAt) throw new DiscoveryFetchPolicyError("attempt deadline exceeded");
  }

  private async fetchContainedPage(
    state: RunState,
    input: string,
    crawlOrder: number,
    crawlDepth: number,
    maxBytes: number,
  ): Promise<FetchedPage> {
    let current = normalizeDiscoveryUrl(input);
    assertWithinRegistrableDomain(state.origin, current);

    for (let redirects = 0; ; redirects += 1) {
      if (this.now() >= state.deadlineAt) throw new DiscoveryFetchPolicyError("attempt deadline exceeded");
      assertWithinRegistrableDomain(state.origin, current);
      await this.rateLimit(state, current.origin);
      const addresses = await this.addressPolicy.resolvePublicAddresses(current.hostname);
      const address = addresses[0];
      if (address === undefined) throw new DiscoveryFetchPolicyError("DNS produced no validated address");
      const response = await this.httpsClient.request({
        url: current,
        address,
        maxBytes,
        deadlineAt: state.deadlineAt,
      });
      if (this.now() >= state.deadlineAt) throw new DiscoveryFetchPolicyError("attempt deadline exceeded");

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        if (redirects >= 5) throw new DiscoveryFetchPolicyError("redirect limit exceeded");
        const location = header(response, "location");
        if (location === undefined || location === "") {
          throw new DiscoveryFetchPolicyError("redirect response is missing Location");
        }
        const redirected = normalizeDiscoveryUrl(location, current);
        current = redirected;
        continue;
      }

      validateHtmlResponse(response);
      const parsed = parseStaticHtml(response.body);
      const snapshot: DiscoverySourceSnapshot = Object.freeze({
        url: current.href,
        retrieved_at: new Date(this.now()).toISOString(),
        http_status: response.statusCode,
        mime_type: "text/html",
        byte_length: response.body.byteLength,
        content_hash: parsed.contentHash,
        excerpt: parsed.excerpt,
        crawl_order: crawlOrder,
        crawl_depth: crawlDepth,
      });
      return Object.freeze({ snapshot, links: parsed.links });
    }
  }
}
