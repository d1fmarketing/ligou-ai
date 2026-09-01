import type { DiscoveryBudget, DiscoverySourceSnapshot } from "../contracts";
import { AddressPolicy, type PublicAddressResolver } from "./address-policy";
import {
  HttpsClient,
  type HttpsResponse,
} from "./https-client";
import {
  parseStaticHtml,
  WorkerHtmlPageParser,
  type HtmlPageParser,
} from "./html-page";
import {
  assertWithinRegistrableDomain,
  normalizeDiscoveryUrl,
} from "./url-policy";

export interface DiscoveryAttemptContext {
  readonly normalized_origin: string;
  readonly deadline_at: string;
  readonly budget: DiscoveryBudget;
  readonly signal: AbortSignal;
}

export interface DiscoveryAttemptContextInput {
  readonly normalized_origin: string;
  readonly deadline_at: string;
  readonly budget: DiscoveryBudget;
  readonly signal?: AbortSignal;
}

export interface DiscoveryFetchGatewayDependencies {
  readonly addressPolicy?: PublicAddressResolver;
  readonly httpsClient?: HttpsClient;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly parseHtml?: typeof parseStaticHtml;
  readonly htmlParser?: HtmlPageParser;
  readonly governor?: RequestGovernor;
  readonly maxGlobalConcurrency?: number;
  readonly maxPerOriginConcurrency?: number;
  readonly maxTrackedOrigins?: number;
  readonly originStateTtlMs?: number;
  readonly maxGovernorQueued?: number;
}

interface RunState {
  readonly origin: URL;
  readonly deadlineAt: number;
  readonly budget: DiscoveryBudget;
  readonly ledger: AttemptLedger;
  readonly operation: AttemptOperation;
}

interface AttemptOperation {
  readonly controller: AbortController;
  active: boolean;
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

interface AttemptLedger {
  readonly budget: DiscoveryBudget;
  pagesReserved: number;
  requestsReserved: number;
  bytesConsumed: number;
  exhausted: boolean;
  retired: boolean;
  readonly activeControllers: Set<AbortController>;
  readonly fetchedPages: Map<string, FetchedPage>;
  readonly inFlightPages: Map<string, Promise<FetchedPage>>;
  readonly redirectDependencies: Map<string, Map<string, number>>;
}

const ATTEMPT_LEDGERS = new WeakMap<object, AttemptLedger>();

export function createDiscoveryAttemptContext(
  input: DiscoveryAttemptContextInput,
): DiscoveryAttemptContext {
  const budget = validateBudget(input.budget);
  const context: DiscoveryAttemptContext = Object.freeze({
    normalized_origin: normalizeDiscoveryUrl(input.normalized_origin).href,
    deadline_at: input.deadline_at,
    budget,
    signal: input.signal ?? new AbortController().signal,
  });
  ATTEMPT_LEDGERS.set(context, {
    budget,
    pagesReserved: 0,
    requestsReserved: 0,
    bytesConsumed: 0,
    exhausted: false,
    retired: false,
    activeControllers: new Set(),
    fetchedPages: new Map(),
    inFlightPages: new Map(),
    redirectDependencies: new Map(),
  });
  return context;
}

function attemptLedger(context: DiscoveryAttemptContext): AttemptLedger {
  if (context === null || typeof context !== "object") {
    throw new DiscoveryFetchPolicyError("trusted attempt context required");
  }
  const existing = ATTEMPT_LEDGERS.get(context);
  if (existing !== undefined) return existing;
  throw new DiscoveryFetchPolicyError("trusted attempt context required");
}

function assertLiveAttempt(ledger: AttemptLedger): void {
  if (ledger.exhausted) throw new DiscoveryFetchPolicyError("attempt byte budget is exhausted");
  if (ledger.retired) throw new DiscoveryFetchPolicyError("attempt is retired");
}

function assertActiveOperation(state: RunState): void {
  assertLiveAttempt(state.ledger);
  if (!state.operation.active || state.operation.controller.signal.aborted) {
    throw new DiscoveryFetchPolicyError("attempt operation aborted");
  }
}

function reservePage(state: RunState): void {
  assertActiveOperation(state);
  if (state.ledger.pagesReserved >= state.ledger.budget.max_pages) {
    throw new DiscoveryFetchPolicyError("attempt page limit exceeded");
  }
  state.ledger.pagesReserved += 1;
}

function reserveRequest(state: RunState): void {
  assertActiveOperation(state);
  if (state.ledger.requestsReserved >= state.ledger.budget.max_pages * 6) {
    throw new DiscoveryFetchPolicyError("attempt request limit exceeded");
  }
  state.ledger.requestsReserved += 1;
}

function consumeBodyBytes(state: RunState, byteLength: number): void {
  assertActiveOperation(state);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new DiscoveryFetchPolicyError("invalid consumed byte count");
  }
  state.ledger.bytesConsumed += byteLength;
  if (state.ledger.bytesConsumed > state.ledger.budget.max_job_bytes) {
    state.ledger.exhausted = true;
    state.ledger.retired = true;
    for (const controller of state.ledger.activeControllers) {
      if (controller !== state.operation.controller) controller.abort();
    }
    throw new DiscoveryFetchPolicyError("attempt byte limit exceeded (job byte limit)");
  }
}

function remainingAttemptBytes(state: RunState): number {
  assertActiveOperation(state);
  const remaining = state.ledger.budget.max_job_bytes - state.ledger.bytesConsumed;
  if (remaining <= 0) {
    state.ledger.exhausted = true;
    state.ledger.retired = true;
    for (const controller of state.ledger.activeControllers) {
      if (controller !== state.operation.controller) controller.abort();
    }
    throw new DiscoveryFetchPolicyError("attempt byte budget is exhausted");
  }
  return remaining;
}

class CachedSnapshotPositionError extends DiscoveryFetchPolicyError {
  constructor(readonly url: string) {
    super("cached canonical snapshot has a conflicting crawl position");
    this.name = "CachedSnapshotPositionError";
  }
}

function assertSnapshotPosition(page: FetchedPage, crawlOrder: number, crawlDepth: number): void {
  if (page.snapshot.crawl_order !== crawlOrder || page.snapshot.crawl_depth !== crawlDepth) {
    throw new CachedSnapshotPositionError(page.snapshot.url);
  }
}

function redirectPathExists(
  ledger: AttemptLedger,
  from: string,
  target: string,
  visited = new Set<string>(),
): boolean {
  if (from === target) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  for (const next of ledger.redirectDependencies.get(from)?.keys() ?? []) {
    if (redirectPathExists(ledger, next, target, visited)) return true;
  }
  return false;
}

function registerRedirectDependency(ledger: AttemptLedger, from: string, to: string): () => void {
  if (redirectPathExists(ledger, to, from)) {
    throw new DiscoveryFetchPolicyError("redirect dependency cycle detected");
  }
  const targets = ledger.redirectDependencies.get(from) ?? new Map<string, number>();
  targets.set(to, (targets.get(to) ?? 0) + 1);
  ledger.redirectDependencies.set(from, targets);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const currentTargets = ledger.redirectDependencies.get(from);
    const count = currentTargets?.get(to);
    if (currentTargets === undefined || count === undefined) return;
    if (count <= 1) currentTargets.delete(to);
    else currentTargets.set(to, count - 1);
    if (currentTargets.size === 0) ledger.redirectDependencies.delete(from);
  };
}

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
  if (/(?:^|,)\s*attachment(?:\s*;|\s*,|\s*$)/i.test(header(response, "content-disposition") ?? "")) {
    throw new DiscoveryFetchPolicyError("attachment responses are forbidden");
  }
  const encoding = header(response, "content-encoding")?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    throw new DiscoveryFetchPolicyError("encoded responses are forbidden");
  }
}

function untrustedEvidenceExcerpt(excerpt: string): string {
  const labelled = `[UNTRUSTED WEBSITE EVIDENCE]\n${excerpt}`;
  const bytes = Buffer.from(labelled, "utf8");
  if (bytes.byteLength <= 16_384) return labelled;
  return bytes.subarray(0, 16_384).toString("utf8").replace(/\uFFFD$/u, "").trimEnd();
}

interface SemaphoreWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
}

class BoundedSemaphore {
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
  ) {}

  get idle(): boolean {
    return this.active === 0 && this.waiters.length === 0;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new DiscoveryFetchPolicyError("request governor aborted"));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(new DiscoveryFetchPolicyError("request governor queue limit exceeded"));
    }
    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new DiscoveryFetchPolicyError("request governor aborted"));
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        waiter.signal.removeEventListener("abort", waiter.abort);
        if (waiter.signal.aborted) continue;
        waiter.resolve(this.releaseHandle());
        return;
      }
      this.active -= 1;
    };
  }
}

interface OriginGovernorState {
  readonly semaphore: BoundedSemaphore;
  nextStartAt: number;
  lastUsedAt: number;
}

export interface RequestGovernorOptions {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxGlobalConcurrency?: number;
  readonly maxPerOriginConcurrency?: number;
  readonly maxTrackedOrigins?: number;
  readonly originStateTtlMs?: number;
  readonly maxQueued?: number;
}

export class RequestGovernor {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly globalSemaphore: BoundedSemaphore;
  private readonly maxPerOriginConcurrency: number;
  private readonly maxTrackedOrigins: number;
  private readonly originStateTtlMs: number;
  private readonly maxQueued: number;
  private readonly origins = new Map<string, OriginGovernorState>();

  constructor(options: RequestGovernorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const globalLimit = options.maxGlobalConcurrency ?? 16;
    this.maxPerOriginConcurrency = options.maxPerOriginConcurrency ?? 2;
    this.maxTrackedOrigins = options.maxTrackedOrigins ?? 1_024;
    this.originStateTtlMs = options.originStateTtlMs ?? 600_000;
    this.maxQueued = options.maxQueued ?? 1_024;
    for (const [name, value, maximum] of [
      ["maxGlobalConcurrency", globalLimit, 256],
      ["maxPerOriginConcurrency", this.maxPerOriginConcurrency, 32],
      ["maxTrackedOrigins", this.maxTrackedOrigins, 16_384],
      ["originStateTtlMs", this.originStateTtlMs, 86_400_000],
      ["maxQueued", this.maxQueued, 16_384],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new DiscoveryFetchPolicyError(`invalid request governor ${name}`);
      }
    }
    this.globalSemaphore = new BoundedSemaphore(globalLimit, this.maxQueued);
  }

  async acquire(origin: string, deadlineAt: number, signal: AbortSignal): Promise<() => void> {
    const state = this.originState(origin);
    const releaseOrigin = await state.semaphore.acquire(signal);
    if (signal.aborted) {
      releaseOrigin();
      throw new DiscoveryFetchPolicyError("request governor aborted");
    }
    let releaseGlobal: (() => void) | undefined;
    try {
      releaseGlobal = await this.globalSemaphore.acquire(signal);
      if (signal.aborted) throw new DiscoveryFetchPolicyError("request governor aborted");
    } catch (error) {
      releaseGlobal?.();
      releaseOrigin();
      throw error;
    }
    try {
      const now = this.now();
      const reservedStart = Math.max(now, state.nextStartAt);
      if (reservedStart >= deadlineAt) {
        throw new DiscoveryFetchPolicyError("attempt deadline exceeded while rate limiting");
      }
      state.nextStartAt = reservedStart + 1_000;
      state.lastUsedAt = now;
      if (reservedStart > now) {
        await this.abortable(this.sleep(reservedStart - now), signal);
      }
      const completedAt = this.now();
      if (signal.aborted) throw new DiscoveryFetchPolicyError("request governor aborted");
      state.lastUsedAt = completedAt;
    } catch (error) {
      releaseGlobal();
      releaseOrigin();
      throw error;
    }
    if (signal.aborted) {
      releaseGlobal();
      releaseOrigin();
      throw new DiscoveryFetchPolicyError("request governor aborted");
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGlobal!();
      releaseOrigin();
      state.lastUsedAt = this.now();
    };
  }

  private originState(origin: string): OriginGovernorState {
    const now = this.now();
    for (const [key, state] of this.origins) {
      if (state.semaphore.idle && now - state.lastUsedAt >= this.originStateTtlMs) {
        this.origins.delete(key);
      }
    }
    const existing = this.origins.get(origin);
    if (existing !== undefined) return existing;
    if (this.origins.size >= this.maxTrackedOrigins) {
      let candidate: { key: string; used: number } | undefined;
      for (const [key, state] of this.origins) {
        if (state.semaphore.idle && (candidate === undefined || state.lastUsedAt < candidate.used)) {
          candidate = { key, used: state.lastUsedAt };
        }
      }
      if (candidate === undefined) {
        throw new DiscoveryFetchPolicyError("request governor origin capacity exceeded");
      }
      this.origins.delete(candidate.key);
    }
    const created: OriginGovernorState = {
      semaphore: new BoundedSemaphore(this.maxPerOriginConcurrency, this.maxQueued),
      nextStartAt: now,
      lastUsedAt: now,
    };
    this.origins.set(origin, created);
    return created;
  }

  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      promise.catch(() => undefined);
      return Promise.reject(new DiscoveryFetchPolicyError("request governor aborted"));
    }
    return new Promise<T>((resolve, reject) => {
      const aborted = (): void => {
        cleanup();
        reject(new DiscoveryFetchPolicyError("request governor aborted"));
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
}

const SHARED_GOVERNORS = new WeakMap<() => number, RequestGovernor>();

function sharedGovernor(
  dependencies: DiscoveryFetchGatewayDependencies,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): RequestGovernor {
  if (dependencies.governor !== undefined) return dependencies.governor;
  const existing = SHARED_GOVERNORS.get(now);
  if (existing !== undefined) return existing;
  const created = new RequestGovernor({
    now,
    sleep,
    maxGlobalConcurrency: dependencies.maxGlobalConcurrency,
    maxPerOriginConcurrency: dependencies.maxPerOriginConcurrency,
    maxTrackedOrigins: dependencies.maxTrackedOrigins,
    originStateTtlMs: dependencies.originStateTtlMs,
    maxQueued: dependencies.maxGovernorQueued,
  });
  SHARED_GOVERNORS.set(now, created);
  return created;
}

export class DiscoveryFetchGateway {
  private readonly addressPolicy: PublicAddressResolver;
  private readonly httpsClient: HttpsClient;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly htmlParser: HtmlPageParser;
  private readonly governor: RequestGovernor;

  constructor(dependencies: DiscoveryFetchGatewayDependencies = {}) {
    this.addressPolicy = dependencies.addressPolicy ?? new AddressPolicy();
    this.httpsClient = dependencies.httpsClient ?? new HttpsClient();
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.htmlParser = dependencies.htmlParser ?? (dependencies.parseHtml === undefined
      ? new WorkerHtmlPageParser(undefined, this.now)
      : { parse: async (bytes) => dependencies.parseHtml!(bytes) });
    this.governor = sharedGovernor(dependencies, this.now, this.sleep);
  }

  async fetchPage(
    attemptContext: DiscoveryAttemptContext,
    url: string,
  ): Promise<DiscoverySourceSnapshot> {
    return this.runAttemptOperation(attemptContext, async (state) => {
      return (await this.fetchContainedPage(state, url, 0, 0, state.budget.max_page_bytes)).snapshot;
    });
  }

  async crawl(
    attemptContext: DiscoveryAttemptContext,
    originUrl: string,
  ): Promise<readonly DiscoverySourceSnapshot[]> {
    return this.runAttemptOperation(attemptContext, (state) => this.crawlWithinOperation(state, originUrl));
  }

  private async crawlWithinOperation(
    state: RunState,
    originUrl: string,
  ): Promise<readonly DiscoverySourceSnapshot[]> {
    const initial = normalizeDiscoveryUrl(originUrl);
    assertWithinRegistrableDomain(state.origin, initial);
    const queue: Array<{ readonly url: string; readonly depth: number }> = [{ url: initial.href, depth: 0 }];
    const scheduled = new Set([initial.href]);
    const completed = new Set<string>();
    const snapshots: DiscoverySourceSnapshot[] = [];

    while (queue.length > 0 && snapshots.length < state.budget.max_pages) {
      const next = queue.shift()!;
      if (completed.has(next.url)) continue;
      let fetched: FetchedPage;
      try {
        fetched = await this.fetchContainedPage(
          state,
          next.url,
          snapshots.length,
          next.depth,
          state.budget.max_page_bytes,
        );
      } catch (error) {
        if (error instanceof CachedSnapshotPositionError && completed.has(error.url)) continue;
        throw error;
      }
      if (completed.has(fetched.snapshot.url)) continue;
      assertSnapshotPosition(fetched, snapshots.length, next.depth);
      completed.add(fetched.snapshot.url);
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
    const ledger = attemptLedger(context);
    assertLiveAttempt(ledger);
    const budget = ledger.budget;
    const origin = normalizeDiscoveryUrl(context.normalized_origin);
    const declaredDeadline = Date.parse(context.deadline_at);
    if (!Number.isFinite(declaredDeadline)) throw new DiscoveryFetchPolicyError("invalid attempt deadline");
    const deadlineAt = Math.min(
      declaredDeadline,
      this.now() + Math.min(budget.deadline_seconds, 600) * 1_000,
    );
    if (deadlineAt <= this.now()) throw new DiscoveryFetchPolicyError("attempt deadline exceeded");
    const operation: AttemptOperation = { controller: new AbortController(), active: true };
    return { origin, deadlineAt, budget, ledger, operation };
  }

  retireAttempt(context: DiscoveryAttemptContext): void {
    const ledger = attemptLedger(context);
    ledger.retired = true;
    for (const controller of ledger.activeControllers) controller.abort();
  }

  private async runAttemptOperation<T>(
    context: DiscoveryAttemptContext,
    operation: (state: RunState) => Promise<T>,
  ): Promise<T> {
    const state = this.createRunState(context);
    const controller = state.operation.controller;
    const relayAbort = (): void => controller.abort();
    context.signal.addEventListener("abort", relayAbort, { once: true });
    if (context.signal.aborted) controller.abort();
    state.ledger.activeControllers.add(controller);
    const remaining = Math.max(0, state.deadlineAt - this.now());
    const deadlineTimer = setTimeout(() => controller.abort(), remaining);
    try {
      return await this.awaitOperation(operation(state), state);
    } finally {
      state.operation.active = false;
      clearTimeout(deadlineTimer);
      context.signal.removeEventListener("abort", relayAbort);
      state.ledger.activeControllers.delete(controller);
    }
  }

  private awaitOperation<T>(
    promise: Promise<T>,
    state: RunState,
    disposeLate?: (value: T) => void,
  ): Promise<T> {
    const signal = state.operation.controller.signal;
    if (!state.operation.active || state.ledger.retired || signal.aborted) {
      promise.then((value) => disposeLate?.(value), () => undefined);
      return Promise.reject(new DiscoveryFetchPolicyError("attempt operation aborted"));
    }
    return new Promise<T>((resolve, reject) => {
      const aborted = (): void => {
        cleanup();
        reject(new DiscoveryFetchPolicyError("attempt operation aborted"));
      };
      const cleanup = (): void => signal.removeEventListener("abort", aborted);
      signal.addEventListener("abort", aborted, { once: true });
      promise.then(
        (value) => {
          cleanup();
          try {
            assertActiveOperation(state);
            resolve(value);
          } catch (error) {
            disposeLate?.(value);
            reject(error);
          }
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private async fetchContainedPage(
    state: RunState,
    input: string,
    crawlOrder: number,
    crawlDepth: number,
    maxBytes: number,
  ): Promise<FetchedPage> {
    return this.fetchAttemptPage(
      state,
      normalizeDiscoveryUrl(input),
      crawlOrder,
      crawlDepth,
      maxBytes,
      true,
      0,
      new Set(),
      undefined,
    );
  }

  private async fetchAttemptPage(
    state: RunState,
    current: URL,
    crawlOrder: number,
    crawlDepth: number,
    maxBytes: number,
    reservePageSlot: boolean,
    redirects: number,
    visited: ReadonlySet<string>,
    dependencyFrom: string | undefined,
  ): Promise<FetchedPage> {
    assertActiveOperation(state);
    assertWithinRegistrableDomain(state.origin, current);
    if (visited.has(current.href)) throw new DiscoveryFetchPolicyError("redirect loop detected");
    const cached = state.ledger.fetchedPages.get(current.href);
    if (cached !== undefined) {
      assertSnapshotPosition(cached, crawlOrder, crawlDepth);
      return cached;
    }
    const removeDependency = dependencyFrom === undefined
      ? () => undefined
      : registerRedirectDependency(state.ledger, dependencyFrom, current.href);
    try {
      const inFlight = state.ledger.inFlightPages.get(current.href);
      if (inFlight !== undefined) {
        const fetched = await this.awaitOperation(inFlight, state);
        assertSnapshotPosition(fetched, crawlOrder, crawlDepth);
        return fetched;
      }
      if (redirects > 5) throw new DiscoveryFetchPolicyError("redirect limit exceeded");
      if (reservePageSlot) reservePage(state);
      const nextVisited = new Set(visited);
      nextVisited.add(current.href);
      const request = this.fetchCanonicalNetwork(
        state,
        current,
        crawlOrder,
        crawlDepth,
        maxBytes,
        redirects,
        nextVisited,
      );
      state.ledger.inFlightPages.set(current.href, request);
      try {
        const fetched = await this.awaitOperation(request, state);
        assertActiveOperation(state);
        assertSnapshotPosition(fetched, crawlOrder, crawlDepth);
        state.ledger.fetchedPages.set(current.href, fetched);
        state.ledger.fetchedPages.set(fetched.snapshot.url, fetched);
        return fetched;
      } finally {
        if (state.ledger.inFlightPages.get(current.href) === request) {
          state.ledger.inFlightPages.delete(current.href);
        }
      }
    } finally {
      removeDependency();
    }
  }

  private async fetchCanonicalNetwork(
    state: RunState,
    current: URL,
    crawlOrder: number,
    crawlDepth: number,
    maxBytes: number,
    redirects: number,
    visited: ReadonlySet<string>,
  ): Promise<FetchedPage> {
    if (this.now() >= state.deadlineAt) throw new DiscoveryFetchPolicyError("attempt deadline exceeded");
    assertWithinRegistrableDomain(state.origin, current);
    reserveRequest(state);
    const releaseGovernor = await this.awaitOperation(this.governor.acquire(
      current.origin,
      state.deadlineAt,
      state.operation.controller.signal,
    ), state, (release) => release());
    let response: HttpsResponse;
    try {
      const addresses = await this.awaitOperation(
        this.addressPolicy.resolvePublicAddresses(
          current.hostname,
          state.operation.controller.signal,
          state.deadlineAt,
        ),
        state,
      );
      const address = addresses[0];
      if (address === undefined) throw new DiscoveryFetchPolicyError("DNS produced no validated address");
      const responseByteLimit = Math.min(maxBytes, remainingAttemptBytes(state));
      response = await this.httpsClient.request({
        url: current,
        address,
        maxBytes: responseByteLimit,
        deadlineAt: state.deadlineAt,
        onBodyBytes: (byteLength) => consumeBodyBytes(state, byteLength),
        signal: state.operation.controller.signal,
      });
    } finally {
      releaseGovernor();
    }
    assertActiveOperation(state);
    if (this.now() >= state.deadlineAt) throw new DiscoveryFetchPolicyError("attempt deadline exceeded");

    if (REDIRECT_STATUSES.has(response.statusCode)) {
      if (redirects >= 5) throw new DiscoveryFetchPolicyError("redirect limit exceeded");
      const location = header(response, "location");
      if (location === undefined || location === "") {
        throw new DiscoveryFetchPolicyError("redirect response is missing Location");
      }
      const redirected = normalizeDiscoveryUrl(location, current);
      return this.fetchAttemptPage(
        state,
        redirected,
        crawlOrder,
        crawlDepth,
        maxBytes,
        false,
        redirects + 1,
        visited,
        current.href,
      );
    }

    validateHtmlResponse(response);
    const parsed = await this.awaitOperation(this.htmlParser.parse(
      response.body,
      state.operation.controller.signal,
      state.deadlineAt,
    ), state);
    const retrievedAt = this.now();
    if (retrievedAt >= state.deadlineAt) throw new DiscoveryFetchPolicyError("attempt deadline exceeded");
    assertActiveOperation(state);
    const snapshot: DiscoverySourceSnapshot = Object.freeze({
      url: current.href,
      retrieved_at: new Date(retrievedAt).toISOString(),
      http_status: response.statusCode,
      mime_type: "text/html",
      byte_length: response.body.byteLength,
      content_hash: parsed.contentHash,
      excerpt: untrustedEvidenceExcerpt(parsed.excerpt),
      crawl_order: crawlOrder,
      crawl_depth: crawlDepth,
    });
    return Object.freeze({ snapshot, links: parsed.links });
  }
}
