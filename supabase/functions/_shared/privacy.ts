const encoder = new TextEncoder();
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PAYMENT_DIGITS = /\b(?:\d[ -]*){13,19}\b/g;
const PAYMENT_LABEL = /\b(?:account|routing|card|credit\s+card|debit\s+card|iban|swift|ssn|social\s+security|tax\s+id)\s*(?:number|no\.?|#)?\s*[:#=-]?\s*(?:(?:\d[ -]?){4,34}|[A-Z]{2}[A-Z0-9-]{3,32})\b/gi;
const PHONE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?)\s*[\s.-]?\d{1,6})?/g;
const ADDRESS = /\b\d{1,6}\s+(?:[A-Z0-9.'-]+\s+){0,5}(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|way|highway|hwy\.?|circle|cir\.?)\b(?:,\s*[A-Z.'-]+(?:\s+[A-Z.'-]+){0,2}(?:\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)?)?/gi;
const ACCESS_CODE = /\b(?:(?:gate|door|alarm|entry|access)\s*(?:code|pin)?|(?:pin|access\s+code|gate\s+code))\s*(?:is|=|:|#)?\s*[A-Z0-9-]{3,8}\b/gi;

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function decodeKey(value: string): Uint8Array {
  if (!value) throw new Error("contact_hash_key_missing");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("contact_hash_key_invalid");
  }
  if (bytes.byteLength !== 32) throw new Error("contact_hash_key_must_be_32_bytes");
  return bytes;
}

function runtimeContactKey(): string {
  const denoValue = (globalThis as any).Deno?.env?.get?.("CONTACT_HASH_KEY");
  const processValue = (globalThis as any).process?.env?.CONTACT_HASH_KEY;
  return denoValue ?? processValue ?? "";
}

export function canonicalContact(contact: string): string {
  const raw = String(contact ?? "").normalize("NFKC").trim().toLowerCase();
  const uriIdentity = raw.match(/(?:sips?|tel):\s*([^@;>]+)/i)?.[1]?.trim();
  const candidate = uriIdentity ?? raw;
  if (!uriIdentity && raw.includes("@")) return raw.replace(/\s+/g, "");
  const digits = candidate.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export async function hashCanonicalContact(contact: string, encodedKey = runtimeContactKey()): Promise<string> {
  const canonical = canonicalContact(contact);
  if (!canonical || canonical.length > 320) throw new Error("contact_invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(decodeKey(encodedKey)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, ownedBuffer(encoder.encode(canonical)));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashLegacyCanonicalContact(contact: string): Promise<string> {
  const raw = String(contact ?? "").trim().toLowerCase();
  const canonical = raw.includes("@")
    ? raw.replace(/\s+/g, "")
    : (() => {
        const digits = raw.replace(/\D/g, "");
        return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
      })();
  if (!canonical || canonical.length > 320) throw new Error("contact_invalid");
  const digest = await crypto.subtle.digest("SHA-256", ownedBuffer(encoder.encode(canonical)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function minimizeAndRedact(value: string, maxChars = 600): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 8_000) throw new Error("redaction_budget_invalid");
  const minimized = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return minimized
    .replace(PAYMENT_DIGITS, "[payment-redacted]")
    .replace(PAYMENT_LABEL, "[payment-redacted]")
    .replace(EMAIL, "[email-redacted]")
    .replace(ADDRESS, "[address-redacted]")
    .replace(PHONE, "[phone-redacted]")
    .replace(ACCESS_CODE, "[access-code-redacted]")
    .slice(0, maxChars);
}
