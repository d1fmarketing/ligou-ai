import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export interface ParsedHtmlPage {
  readonly excerpt: string;
  readonly links: readonly string[];
  readonly contentHash: string;
}

export interface HtmlPageParser {
  parse(bytes: Buffer, signal: AbortSignal, deadlineAt: number): Promise<ParsedHtmlPage>;
}

interface ParserWorker {
  on(event: "message" | "error" | "exit", listener: (...arguments_: any[]) => void): unknown;
  off(event: "message" | "error" | "exit", listener: (...arguments_: any[]) => void): unknown;
  postMessage(value: unknown): void;
  terminate(): Promise<number> | number;
}

interface ParserWorkerResult {
  readonly ok: boolean;
  readonly page?: ParsedHtmlPage;
  readonly error?: string;
}

interface ParserWaiter {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly now: () => number;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class HtmlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlPolicyError";
  }
}

export interface ParserWorkerLimiterOptions {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
}

export class ParserWorkerLimiter {
  private active = 0;
  private readonly waiters: ParserWaiter[] = [];

  constructor(private readonly options: ParserWorkerLimiterOptions) {
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1 || options.maxConcurrent > 8) {
      throw new HtmlPolicyError("invalid parser worker concurrency limit");
    }
    if (!Number.isSafeInteger(options.maxQueued) || options.maxQueued < 0 || options.maxQueued > 256) {
      throw new HtmlPolicyError("invalid parser worker queue limit");
    }
  }

  acquire(
    signal: AbortSignal,
    deadlineAt: number,
    now: () => number = Date.now,
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new HtmlPolicyError("parser worker acquisition aborted"));
    if (deadlineAt <= now()) return Promise.reject(new HtmlPolicyError("parser worker queue deadline exceeded"));
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    if (this.waiters.length >= this.options.maxQueued) {
      return Promise.reject(new HtmlPolicyError("parser worker queue limit exceeded"));
    }
    return new Promise((resolve, reject) => {
      const waiter: ParserWaiter = {
        signal,
        deadlineAt,
        now,
        resolve,
        reject,
        abort: () => this.rejectWaiter(waiter, new HtmlPolicyError("parser worker acquisition aborted")),
        timer: undefined,
      };
      waiter.timer = setTimeout(
        () => this.rejectWaiter(waiter, new HtmlPolicyError("parser worker queue deadline exceeded")),
        Math.max(0, deadlineAt - now()),
      );
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  private rejectWaiter(waiter: ParserWaiter, error: Error): void {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    this.cleanupWaiter(waiter);
    waiter.reject(error);
  }

  private cleanupWaiter(waiter: ParserWaiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.abort);
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        this.cleanupWaiter(waiter);
        if (waiter.signal.aborted) {
          waiter.reject(new HtmlPolicyError("parser worker acquisition aborted"));
          continue;
        }
        if (waiter.deadlineAt <= waiter.now()) {
          waiter.reject(new HtmlPolicyError("parser worker queue deadline exceeded"));
          continue;
        }
        waiter.resolve(this.releaseHandle());
        return;
      }
      this.active -= 1;
    };
  }
}

const SHARED_PARSER_WORKER_LIMITER = new ParserWorkerLimiter({
  maxConcurrent: 4,
  maxQueued: 64,
});

export class WorkerHtmlPageParser implements HtmlPageParser {
  constructor(
    private readonly workerFactory: () => ParserWorker = () =>
      new Worker(new URL("./html-parser-worker.ts", import.meta.url)),
    private readonly now: () => number = Date.now,
    private readonly limiter: ParserWorkerLimiter = SHARED_PARSER_WORKER_LIMITER,
  ) {}

  async parse(bytes: Buffer, signal: AbortSignal, deadlineAt: number): Promise<ParsedHtmlPage> {
    if (signal.aborted || deadlineAt <= this.now()) {
      throw new HtmlPolicyError("HTML parsing aborted");
    }
    const releasePermit = await this.limiter.acquire(signal, deadlineAt, this.now);
    if (signal.aborted || deadlineAt <= this.now()) {
      releasePermit();
      throw new HtmlPolicyError("HTML parsing aborted");
    }
    let worker: ParserWorker;
    try {
      worker = this.workerFactory();
    } catch (error) {
      releasePermit();
      throw error;
    }
    return new Promise<ParsedHtmlPage>((resolve, reject) => {
      let settled = false;
      const stopWorker = async (): Promise<void> => {
        try {
          await worker.terminate();
        } catch {
          // The parse outcome remains authoritative if termination reports an error.
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        worker.off("message", messaged);
        worker.off("error", errored);
        worker.off("exit", exited);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void stopWorker().then(() => {
          releasePermit();
          reject(error);
        });
      };
      const aborted = (): void => fail(new HtmlPolicyError("HTML parsing aborted"));
      const messaged = (message: ParserWorkerResult): void => {
        if (!message.ok || message.page === undefined) {
          fail(new HtmlPolicyError(message.error ?? "HTML parser worker failed"));
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        const result = Object.freeze({
          excerpt: message.page.excerpt,
          links: Object.freeze([...message.page.links]),
          contentHash: message.page.contentHash,
        });
        void stopWorker().then(() => {
          releasePermit();
          resolve(result);
        });
      };
      const errored = (error: Error): void => fail(error);
      const exited = (code: number): void => {
        if (!settled) fail(new HtmlPolicyError(`HTML parser worker exited before result: ${code}`));
      };
      const timer = setTimeout(aborted, Math.max(0, deadlineAt - this.now()));
      signal.addEventListener("abort", aborted, { once: true });
      worker.on("message", messaged);
      worker.on("error", errored);
      worker.on("exit", exited);
      try {
        worker.postMessage(Buffer.from(bytes));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

const OMITTED_ELEMENTS = new Set([
  "script", "style", "noscript", "template", "form", "iframe", "object", "embed",
  "svg", "canvas", "audio", "video", "source",
]);

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((candidate) => candidate.name.toLowerCase() === name)?.value;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  return bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, "").trimEnd();
}

function decodeHtml(bytes: Buffer): string {
  const withoutBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  const binaryPrefix = withoutBom.subarray(0, 512).toString("latin1").replace(/^\s*/u, "");
  if (/^(?:%PDF-|%!PS-|GIF8|\x89PNG\r\n\x1a\n|\xff\xd8\xff|PK\x03\x04|\x7fELF|MZ|RIFF)/.test(binaryPrefix)) {
    throw new HtmlPolicyError("content sniffing detected a non-HTML binary prefix");
  }
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HtmlPolicyError("HTML body is not valid UTF-8");
  }
  if (html.includes("\0")) throw new HtmlPolicyError("HTML body contains binary data");
  const controls = [...html.slice(0, 4_096)].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== "\t" && character !== "\n" && character !== "\r";
  }).length;
  if (controls > 4) throw new HtmlPolicyError("HTML body contains binary control data");
  const probe = html.slice(0, 4_096);
  if (!/<(?:!doctype\s+html|html|head|body|title|meta|main|article|section|div|p|h[1-6]|a)(?:\s|>)/i.test(probe)) {
    throw new HtmlPolicyError("content sniffing did not identify HTML");
  }
  return html;
}

export function parseStaticHtml(bytes: Buffer): ParsedHtmlPage {
  const html = decodeHtml(bytes);
  const document = parse(html);
  const text: string[] = [];
  const links: string[] = [];

  const visit = (node: Node, omitted: boolean): void => {
    const element = isElement(node) ? node : undefined;
    const nextOmitted = omitted || (element !== undefined && OMITTED_ELEMENTS.has(element.tagName));
    if (!nextOmitted && "value" in node) text.push(node.value);
    if (!nextOmitted && element?.tagName === "a") {
      const href = attribute(element, "href");
      if (href !== undefined && href !== "" && attribute(element, "download") === undefined) {
        links.push(href);
      }
    }
    if ("childNodes" in node && !nextOmitted) {
      for (const child of node.childNodes) visit(child, false);
    }
  };
  visit(document, false);

  return Object.freeze({
    excerpt: truncateUtf8(text.join(" ").replace(/\s+/gu, " ").trim(), 16_384),
    links: Object.freeze(links),
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  });
}
