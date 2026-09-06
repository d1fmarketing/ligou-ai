import { domainToASCII } from "node:url";
import { getDomain } from "tldts";

export class UrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlPolicyError";
  }
}

function authorityContainsUserinfo(input: string, base?: URL): boolean {
  if (base !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(input)) return false;
  const authority = input.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  return authority?.includes("@") ?? false;
}

export function normalizeDiscoveryUrl(input: string | URL, base?: URL): URL {
  const raw = input instanceof URL ? input.href : input;
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    throw new UrlPolicyError("invalid URL");
  }

  if (url.protocol !== "https:") throw new UrlPolicyError("HTTPS required");
  if (url.username !== "" || url.password !== "" || authorityContainsUserinfo(raw, base)) {
    throw new UrlPolicyError("URL credentials are forbidden");
  }
  if (url.href.includes("#")) throw new UrlPolicyError("URL fragments are forbidden");
  if (url.port !== "" && url.port !== "443") {
    throw new UrlPolicyError("HTTPS default port 443 required");
  }

  const unbracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const asciiHost = domainToASCII(unbracketed.replace(/[.]$/, "").toLowerCase());
  if (asciiHost === "") throw new UrlPolicyError("invalid hostname");
  url.hostname = asciiHost.includes(":") ? `[${asciiHost}]` : asciiHost;
  url.port = "";
  return url;
}

export function registrableDomain(url: URL): string {
  const domain = getDomain(url.hostname, {
    allowPrivateDomains: true,
    detectIp: true,
    validateHostname: true,
  });
  if (domain === null) throw new UrlPolicyError("public registrable domain required");
  return domain.toLowerCase();
}

export function isWithinRegistrableDomain(origin: URL, candidate: URL): boolean {
  return registrableDomain(origin) === registrableDomain(candidate);
}

export function assertWithinRegistrableDomain(origin: URL, candidate: URL): void {
  if (!isWithinRegistrableDomain(origin, candidate)) {
    throw new UrlPolicyError("redirect or navigation escaped the submitted registrable domain");
  }
}
