// Public session bootstrap for the dashboard — works from anywhere, while the EC2 keeps ZERO inbound ports.
// Flow: verify owner JWT -> verify provisioned tenant -> insert browser_session_requests(pending) -> the controller
// (outbound-only) picks it up via Realtime, runs the canonical startSession (budget, ek_, SDP exchange,
// sideband) and writes the answer -> this function returns it to the browser. Same response contract as the
// local controller's POST /session, so the dashboard just points here in remote mode.
// Deploy: supabase functions deploy browser-session --no-verify-jwt   (JWT is verified explicitly below)
// Secrets: SERVICE_KEY=sb_secret_...  (SUPABASE_URL is injected by the platform)
import { createClient } from "@supabase/supabase-js";
import { createBrowserSessionHandler } from "./core.ts";

Deno.serve(createBrowserSessionHandler({
  env: (name) => Deno.env.get(name),
  createClient: (url, serviceKey) => createClient(url, serviceKey, { auth: { persistSession: false } }),
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  monotonic: () => performance.now(),
  onTiming: (event) => console.log(JSON.stringify(event)),
}));
