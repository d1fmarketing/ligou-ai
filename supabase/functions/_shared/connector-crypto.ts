const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export interface ConnectorTokenAad {
  tenantId: string;
  provider: string;
  accountRef: string;
  keyVersion: number;
}

export interface ConnectorTokenWire {
  ciphertext: string;
  iv: string;
  keyVersion: number;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("connector_token_base64_invalid");
  try { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
  catch { throw new Error("connector_token_base64_invalid"); }
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function aadBytes(aad: ConnectorTokenAad): Uint8Array {
  if (aad.keyVersion !== 1) throw new Error("connector_token_key_version_unsupported");
  if (!aad.tenantId || !aad.provider || !aad.accountRef) throw new Error("connector_token_aad_invalid");
  return encoder.encode(JSON.stringify({
    schema: "ligou.connector-token.aad",
    version: 1,
    tenant_id: aad.tenantId,
    provider: aad.provider,
    account_ref: aad.accountRef,
    key_version: aad.keyVersion,
  }));
}

async function importAesKey(encoded: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const bytes = decodeBase64(encoded);
  if (bytes.byteLength !== 32) throw new Error("connector_token_key_must_be_32_bytes");
  return crypto.subtle.importKey("raw", ownedBuffer(bytes), { name: "AES-GCM", length: 256 }, false, usage);
}

export async function encryptConnectorToken(
  plaintext: string,
  aad: ConnectorTokenAad,
  encodedKey: string,
): Promise<ConnectorTokenWire> {
  if (!plaintext) throw new Error("connector_token_empty");
  const key = await importAesKey(encodedKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ownedBuffer(iv), additionalData: ownedBuffer(aadBytes(aad)), tagLength: 128 },
    key,
    ownedBuffer(encoder.encode(plaintext)),
  );
  return { ciphertext: encodeBase64(new Uint8Array(encrypted)), iv: encodeBase64(iv), keyVersion: aad.keyVersion };
}

export async function decryptConnectorToken(
  wire: ConnectorTokenWire,
  aad: ConnectorTokenAad,
  keyring: Record<number, string | undefined>,
): Promise<string> {
  if (!Number.isSafeInteger(wire.keyVersion) || wire.keyVersion !== aad.keyVersion) {
    throw new Error("connector_token_key_version_mismatch");
  }
  const encodedKey = keyring[wire.keyVersion];
  if (!encodedKey) throw new Error("connector_token_key_version_unavailable");
  const iv = decodeBase64(wire.iv);
  if (iv.byteLength !== 12) throw new Error("connector_token_iv_invalid");
  const ciphertext = decodeBase64(wire.ciphertext);
  const key = await importAesKey(encodedKey, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ownedBuffer(iv), additionalData: ownedBuffer(aadBytes(aad)), tagLength: 128 },
    key,
    ownedBuffer(ciphertext),
  );
  return decoder.decode(decrypted);
}
