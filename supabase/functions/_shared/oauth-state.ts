const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(value)) throw new Error("oauth_state_malformed");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("oauth_state_malformed");
  }
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ownedBuffer(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface OAuthStateRecord {
  stateId: string;
  tenantId: string;
  userId: string;
  redirectUri: string;
  nonceHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface OAuthStateProof {
  stateId: string;
  tenantId: string;
  userId: string;
  redirectUri: string;
  nonceHash: string;
}

function validBindingId(value: string): string {
  if (!UUID.test(value)) throw new Error("oauth_state_malformed");
  return value.toLowerCase();
}

function validRedirect(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("oauth_state_redirect_invalid"); }
  const localHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) throw new Error("oauth_state_redirect_invalid");
  parsed.hash = "";
  return parsed.toString();
}

export async function buildOAuthState(input: {
  stateId: string;
  tenantId: string;
  userId: string;
  redirectUri: string;
  now?: Date;
  ttlMs?: number;
  nonce?: Uint8Array;
}) {
  const stateId = validBindingId(input.stateId);
  const tenantId = validBindingId(input.tenantId);
  const userId = validBindingId(input.userId);
  const redirectUri = validRedirect(input.redirectUri);
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000) throw new Error("oauth_state_ttl_invalid");
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(32));
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 32) throw new Error("oauth_state_nonce_invalid");
  const encodedNonce = base64Url(nonce);
  const nonceHash = await sha256Hex(nonce);
  return {
    publicState: ["v1", stateId, tenantId, userId, encodedNonce].join("."),
    record: {
      stateId,
      tenantId,
      userId,
      redirectUri,
      nonceHash,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      consumedAt: null,
    } satisfies OAuthStateRecord,
  };
}

export async function parseOAuthState(publicState: string, redirectUri: string): Promise<OAuthStateProof> {
  const parts = publicState.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") throw new Error("oauth_state_malformed");
  const nonce = fromBase64Url(parts[4]!);
  if (nonce.byteLength !== 32) throw new Error("oauth_state_malformed");
  return {
    stateId: validBindingId(parts[1]!),
    tenantId: validBindingId(parts[2]!),
    userId: validBindingId(parts[3]!),
    redirectUri: validRedirect(redirectUri),
    nonceHash: await sha256Hex(nonce),
  };
}

export function validateOAuthStateRecord(record: OAuthStateRecord, proof: OAuthStateProof, now = new Date()) {
  if (record.consumedAt) throw new Error("oauth_state_consumed");
  if (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now.getTime()) {
    throw new Error("oauth_state_expired");
  }
  if (record.stateId !== proof.stateId
    || record.tenantId !== proof.tenantId
    || record.userId !== proof.userId
    || record.redirectUri !== proof.redirectUri
    || record.nonceHash !== proof.nonceHash) {
    throw new Error("oauth_state_binding_mismatch");
  }
  return { tenantId: record.tenantId, userId: record.userId, redirectUri: record.redirectUri };
}
