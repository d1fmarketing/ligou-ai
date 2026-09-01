import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";

export interface DnsLookup {
  resolveCname(hostname: string): Promise<readonly string[]>;
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PublicAddressResolver {
  resolvePublicAddresses(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]>;
}

export class AddressPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressPolicyError";
  }
}

function normalizeHost(hostname: string): string {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const normalized = domainToASCII(unbracketed.replace(/[.]$/, "").toLowerCase());
  if (normalized === "") throw new AddressPolicyError("invalid DNS hostname");
  return normalized;
}

function normalizedAddress(address: string): string {
  try {
    return ipaddr.process(address).toNormalizedString();
  } catch {
    throw new AddressPolicyError(`invalid IP address: ${address}`);
  }
}

export function assertPublicAddress(address: string): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new AddressPolicyError(`invalid IP address: ${address}`);
  }
  if (parsed.range() !== "unicast") {
    throw new AddressPolicyError(`non-public address: ${address}`);
  }
}

export function peerAddressMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined || actual === "") return false;
  try {
    return normalizedAddress(expected) === normalizedAddress(actual);
  } catch {
    return false;
  }
}

async function noRecordAsEmpty(operation: () => Promise<string[]>): Promise<readonly string[]> {
  try {
    return await operation();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENOENT") return [];
    throw error;
  }
}

const nodeDnsLookup: DnsLookup = {
  resolveCname: (hostname) => noRecordAsEmpty(() => dns.resolveCname(hostname)),
  resolve4: (hostname) => noRecordAsEmpty(() => dns.resolve4(hostname)),
  resolve6: (hostname) => noRecordAsEmpty(() => dns.resolve6(hostname)),
};

export class AddressPolicy implements PublicAddressResolver {
  constructor(private readonly lookup: DnsLookup = nodeDnsLookup) {}

  async resolvePublicAddresses(hostname: string): Promise<readonly ResolvedAddress[]> {
    let current = normalizeHost(hostname);
    const literalFamily = isIP(current);
    if (literalFamily !== 0) {
      assertPublicAddress(current);
      return Object.freeze([Object.freeze({ address: normalizedAddress(current), family: literalFamily as 4 | 6 })]);
    }

    const visited = new Set<string>();
    for (let depth = 0; ; depth += 1) {
      if (visited.has(current)) throw new AddressPolicyError("CNAME loop detected");
      visited.add(current);
      const cnames = [...await this.lookup.resolveCname(current)].map(normalizeHost);
      if (cnames.length > 1) throw new AddressPolicyError("multiple CNAME targets are forbidden");
      if (cnames.length === 0) break;
      if (depth >= 8) throw new AddressPolicyError("CNAME depth exceeds 8");
      current = cnames[0]!;
    }

    const [ipv4, ipv6] = await Promise.all([
      this.lookup.resolve4(current),
      this.lookup.resolve6(current),
    ]);
    const addresses: ResolvedAddress[] = [];
    for (const [address, family] of [
      ...ipv4.map((address) => [address, 4] as const),
      ...ipv6.map((address) => [address, 6] as const),
    ]) {
      assertPublicAddress(address);
      const normalized = normalizedAddress(address);
      if (!addresses.some((candidate) => candidate.address === normalized)) {
        addresses.push(Object.freeze({ address: normalized, family }));
      }
    }
    if (addresses.length === 0) throw new AddressPolicyError("hostname resolved to no A or AAAA records");
    return Object.freeze(addresses);
  }
}
