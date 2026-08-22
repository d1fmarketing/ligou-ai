const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function calendarTenantId(state) {
  const tenantId = state?.business?.id;
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new Error("business_tenant_required");
  return tenantId;
}

export function connectorPresentation(status) {
  if (status?.status === "active") {
    return { connected: true, actionable: false, message: "Conectada" };
  }
  const reconnect = new Set(["reconnect_required", "revoked", "error"]).has(status?.status);
  return {
    connected: false,
    actionable: true,
    message: reconnect ? "Reconectar Google Calendar" : "Conectar Google Calendar",
  };
}

function absoluteFunctionsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("functions_base_invalid"); }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !loopback)) {
    throw new Error("functions_base_invalid");
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveFunctionsBase(configuredBase, supabaseUrl) {
  if (configuredBase) return absoluteFunctionsUrl(configuredBase);
  if (!supabaseUrl) throw new Error("functions_base_required");
  let base;
  try { base = new URL(supabaseUrl); } catch { throw new Error("functions_base_invalid"); }
  if (base.pathname !== "/" || base.search || base.hash) throw new Error("functions_base_invalid");
  return absoluteFunctionsUrl(`${base.origin}/functions/v1`);
}

export function dashboardRedirectUrl(origin, baseUrl) {
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch { throw new Error("dashboard_origin_invalid"); }
  if (parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash
    || typeof baseUrl !== "string" || !baseUrl.startsWith("/") || !baseUrl.endsWith("/")) {
    throw new Error("dashboard_base_invalid");
  }
  return `${parsedOrigin.origin}${baseUrl}`;
}

export function calendarScopesGranted(scopes) {
  const granted = new Set(String(scopes ?? "").split(/\s+/).filter(Boolean));
  return granted.has("https://www.googleapis.com/auth/calendar.events")
    && granted.has("https://www.googleapis.com/auth/calendar.freebusy");
}
