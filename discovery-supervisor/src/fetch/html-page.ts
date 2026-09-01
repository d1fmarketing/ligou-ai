import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export interface ParsedHtmlPage {
  readonly excerpt: string;
  readonly links: readonly string[];
  readonly contentHash: string;
}

export class HtmlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlPolicyError";
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
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HtmlPolicyError("HTML body is not valid UTF-8");
  }
  if (html.includes("\0")) throw new HtmlPolicyError("HTML body contains binary data");
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
