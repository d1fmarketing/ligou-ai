// Custody storage for supabase-js: the persisted session must never contain the
// Google provider tokens, and the PKCE verifier lives only in a temporary store
// that refuses to hold sessions or provider material.

const TRANSIENT_KEY_SUFFIXES = ["-code-verifier"];
const PROVIDER_FIELDS = ["provider_token", "provider_refresh_token"];
const SESSION_MARKERS = ['"access_token"', '"refresh_token"', '"provider_token"', '"provider_refresh_token"'];

function isTransientKey(key) {
  return TRANSIENT_KEY_SUFFIXES.some((suffix) => String(key).endsWith(suffix));
}

function looksLikeSessionPayload(value) {
  return SESSION_MARKERS.some((marker) => String(value).includes(marker));
}

function stripProviderFields(node) {
  if (typeof node !== "object" || node === null) return node;
  if (Array.isArray(node)) return node.map(stripProviderFields);
  const output = {};
  for (const [key, value] of Object.entries(node)) {
    if (PROVIDER_FIELDS.includes(key)) continue;
    output[key] = stripProviderFields(value);
  }
  return output;
}

export function createCustodyStorage({ persistent, temporary }) {
  return {
    getItem(key) {
      return isTransientKey(key) ? temporary.getItem(key) : persistent.getItem(key);
    },
    setItem(key, value) {
      const text = String(value);
      if (isTransientKey(key)) {
        if (looksLikeSessionPayload(text)) {
          throw new Error("custody_transient_store_rejects_session_material");
        }
        temporary.setItem(key, text);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Fail closed: an opaque payload that mentions provider tokens is never persisted.
        if (text.includes("provider_token")) return;
        persistent.setItem(key, text);
        return;
      }
      persistent.setItem(key, JSON.stringify(stripProviderFields(parsed)));
    },
    removeItem(key) {
      temporary.removeItem(key);
      persistent.removeItem(key);
    },
  };
}

function memoryFallback() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

export function browserCustodyStorage() {
  const persistent = typeof window !== "undefined" && window.localStorage ? window.localStorage : memoryFallback();
  const temporary = typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : memoryFallback();
  return createCustodyStorage({ persistent, temporary });
}
