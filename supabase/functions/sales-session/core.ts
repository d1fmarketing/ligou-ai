// Visitor capability API. Existing customer authentication is intentionally untouched.
type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};
export type SalesSessionDependencies = {
  env: (name: string) => string | undefined;
  createClient: (url: string, key: string) => RpcClient;
};
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0"))
    .join("");
const sha = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}
async function boundedJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length") ?? 0) > 98304) {
    throw Error("request_too_large");
  }
  const reader = req.body?.getReader();
  if (!reader) throw Error("invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 98304) {
      await reader.cancel();
      throw Error("request_too_large");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw Error("invalid_request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Error("invalid_request");
  }
  return body as Record<string, unknown>;
}
function publicResult(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Error("service_unavailable");
  }
  const row = data as Record<string, unknown>,
    out: Record<string, unknown> = {};
  for (
    const k of [
      "session_id",
      "status",
      "max_minutes",
      "expires_at",
      "error",
      "provider_termination_state",
    ]
  ) if (row[k] !== undefined) out[k] = row[k];
  if (row.status === "ready" && typeof row.sdp === "string") out.sdp = row.sdp;
  return out;
}
const safeErrors = new Map<string, number>([
  ["invalid_request", 400],
  ["request_too_large", 413],
  ["session_not_found", 404],
  ["sales_disabled", 503],
  ["runtime_unavailable", 503],
  ["network_unavailable", 503],
  ["global_busy", 429],
  ["visitor_limit", 429],
  ["network_limit", 429],
  ["cancellation_limit", 429],
  ["session_not_ready", 409],
  ["daily_budget", 429],
  ["service_unavailable", 503],
]);
export function createSalesSessionHandler(deps: SalesSessionDependencies) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin") ?? "";
    const allowed = (deps.env("SALES_ALLOWED_ORIGINS") ?? "").split(",").map(
      (v) => v.trim(),
    ).filter(Boolean);
    const cors: Record<string, string> = {
      "cache-control": "no-store",
      "vary": "Origin",
      "content-type": "application/json",
    };
    const reply = (body: unknown, status = 200) =>
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: cors,
      });
    if (!origin || !allowed.includes(origin)) {
      return reply({ error: "origin_not_allowed" }, 403);
    }
    cors["access-control-allow-origin"] = origin;
    cors["access-control-allow-methods"] = "POST, OPTIONS";
    cors["access-control-allow-headers"] =
      "authorization, content-type, apikey, x-client-info";
    if (req.method === "OPTIONS") return reply(null, 204);
    if (req.method !== "POST") {
      return reply({ error: "method_not_allowed" }, 405);
    }
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.headers.get("authorization") ?? "",
    );
    if (!match) return reply({ error: "capability_required" }, 401);
    if (
      !req.headers.get("content-type")?.toLowerCase().startsWith(
        "application/json",
      )
    ) return reply({ error: "invalid_request" }, 400);
    try {
      // Only a controlled ingress may assert network identity. Never trust browser XFF.
      const proxySecret = deps.env("SALES_TRUSTED_PROXY_SECRET"),
        hashSecret = deps.env("SALES_HASH_SECRET");
      const presented = req.headers.get("x-sales-proxy-secret") ?? "";
      if (
        !proxySecret || proxySecret.length < 12 || !hashSecret ||
        hashSecret.length < 32 ||
        await sha(presented) !== await sha(proxySecret)
      ) throw Error("network_unavailable");
      const network = req.headers.get(
        deps.env("SALES_TRUSTED_NETWORK_HEADER") ?? "x-sales-network-ip",
      ) ?? "";
      // Ingress strips forwarded lists and provides one normalized IPv4/IPv6 address.
      if (
        !network || network.length > 64 ||
        !/^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[a-fA-F0-9:]+$/.test(network) ||
        network.includes(",")
      ) throw Error("network_unavailable");
      const body = await boundedJson(req), tokenHash = await sha(match[1]);
      const url = deps.env("SUPABASE_URL"),
        key = deps.env("SERVICE_KEY") ?? deps.env("SUPABASE_SERVICE_ROLE_KEY");
      if (!url || !key) throw Error("service_unavailable");
      let name: string, args: Record<string, unknown>;
      if (body.action === "start") {
        if (
          Object.keys(body).some((k) =>
            !["action", "request_id", "visitor_id", "sdp"].includes(k)
          ) || typeof body.request_id !== "string" ||
          !UUID.test(body.request_id) || typeof body.visitor_id !== "string" ||
          !UUID.test(body.visitor_id) || typeof body.sdp !== "string" ||
          body.sdp.length < 1 || body.sdp.length > 65536
        ) throw Error("invalid_request");
        if (deps.env("SALES_ENABLED") !== "true") throw Error("sales_disabled");
        name = "sales_admit";
        args = {
          p_request_id: body.request_id,
          p_token_hash: tokenHash,
          p_visitor_hash: await hmac(hashSecret, `visitor:${body.visitor_id}`),
          p_network_hash: await hmac(
            hashSecret,
            `network:${network.toLowerCase()}`,
          ),
          p_offer_sdp: body.sdp,
        };
      } else if (
        body.action === "status" || body.action === "end" ||
        body.action === "connected"
      ) {
        if (
          Object.keys(body).some((k) =>
            !["action", "session_id"].includes(k)
          ) || typeof body.session_id !== "string" ||
          !UUID.test(body.session_id)
        ) throw Error("invalid_request");
        name = body.action === "connected"
          ? "sales_client_connected"
          : "sales_public_session";
        args = {
          p_session_id: body.session_id,
          p_token_hash: tokenHash,
          ...(body.action === "connected" ? {} : {
            p_end: body.action === "end",
            p_network_hash: await hmac(
              hashSecret,
              `network:${network.toLowerCase()}`,
            ),
          }),
        };
      } else throw Error("invalid_request");
      const result = await deps.createClient(url, key).rpc(name, args);
      if (result.error) {
        const code = [...safeErrors.keys()].find((k) =>
          result.error?.message === k ||
          result.error?.message?.startsWith(`${k}\n`)
        );
        throw Error(code ?? "service_unavailable");
      }
      return reply(publicResult(result.data));
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "service_unavailable";
      const code = safeErrors.has(message) ? message : "service_unavailable";
      return reply({ error: code }, safeErrors.get(code));
    }
  };
}
