import { readFileSync } from "node:fs";
import path from "node:path";

const PROVIDER = "openai-codex";

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unexpiredJwt(token, nowSeconds) {
  if (!nonempty(token) || token.length > 65_536) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const expiry = Number(payload?.exp);
    return Number.isFinite(expiry) && expiry > nowSeconds + 30;
  } catch {
    return false;
  }
}

function tokenPairReady(tokens, nowSeconds) {
  return Boolean(tokens && typeof tokens === "object" && !Array.isArray(tokens)
    && unexpiredJwt(tokens.access_token, nowSeconds)
    && nonempty(tokens.refresh_token));
}

function poolEntryReady(entry, nowSeconds) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const status = String(entry.last_status ?? "").trim().toLowerCase();
  const errorCode = Number(entry.last_error_code);
  if (status === "dead" || status === "exhausted" || errorCode === 401 || errorCode === 403) return false;
  return unexpiredJwt(entry.access_token, nowSeconds) && nonempty(entry.refresh_token);
}

export function classifyCodexAuthStore(store, nowSeconds = Date.now() / 1000) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    return { provider: PROVIDER, authenticated: false };
  }
  const rawPool = store.credential_pool?.[PROVIDER];
  if (Array.isArray(rawPool) && rawPool.length > 0) {
    return { provider: PROVIDER, authenticated: rawPool.some((entry) => poolEntryReady(entry, nowSeconds)) };
  }
  const provider = store.providers?.[PROVIDER];
  const terminal = provider?.last_auth_error?.relogin_required === true;
  return {
    provider: PROVIDER,
    authenticated: !terminal && tokenPairReady(provider?.tokens, nowSeconds),
  };
}

function separatedAuthFile() {
  const rawAuthHome = String(process.env.HERMES_AUTH_HOME ?? "").trim();
  const rawHermesHome = String(process.env.HERMES_HOME ?? "").trim();
  if (!rawAuthHome || !rawHermesHome) throw new Error("auth_state_unavailable");
  const authHome = path.resolve(rawAuthHome);
  const hermesHome = path.resolve(rawHermesHome);
  if (!path.isAbsolute(authHome) || !path.isAbsolute(hermesHome) || authHome === hermesHome) throw new Error("auth_state_unavailable");
  if (authHome.startsWith(`${hermesHome}${path.sep}`) || hermesHome.startsWith(`${authHome}${path.sep}`)) {
    throw new Error("auth_state_unavailable");
  }
  return path.join(authHome, "auth.json");
}

function main() {
  let result = { provider: PROVIDER, authenticated: false };
  try {
    const store = JSON.parse(readFileSync(separatedAuthFile(), "utf8"));
    result = classifyCodexAuthStore(store);
  } catch {}
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.env.LIGOU_AUTH_STATE_CLI === "1") main();
