import { proxySalesSession } from "./sales-proxy.mjs";

// The bundler emits this adapter and its shared proxy as one api/sales-session.mjs.
// Values are read at invocation time, never embedded into the public build.
export async function handleSalesSession(req, res, env = process.env, fetchImpl = fetch) {
  try {
    const allowedOrigins = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
      .filter(Boolean).map(host => `https://${host}`);
    allowedOrigins.push(...(env.LIGOU_SALES_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean));
    const method = req.method || "GET";
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers || {})) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : String(value));
    }
    const request = new Request("https://sales.invalid/api/sales-session", {
      method, headers,
      ...(method === "POST" ? {
        body: typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body ?? {}),
      } : {}),
    });
    const response = await proxySalesSession(request, {
      edgeUrl: env.LIGOU_SALES_EDGE_URL,
      proxySecret: env.LIGOU_SALES_PROXY_SECRET,
      allowedOrigins,
      // Vercel sets this header. Never fall back to generic/client forwarding headers.
      networkIp: env.VERCEL === "1" ? headers.get("x-vercel-forwarded-for") || "" : "",
    }, fetchImpl);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(await response.text());
  } catch {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ error: "service_unavailable" }));
  }
}

export default function handler(req, res) {
  return handleSalesSession(req, res);
}
