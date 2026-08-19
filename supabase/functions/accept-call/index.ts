// F6 webhook: OpenAI `realtime.call.incoming` -> insert phone_events row (Realtime wakes the controller).
// Fast ACK; the controller (outbound-only) does accept + sideband. Signature: standard-webhooks scheme.
// Deploy: supabase functions deploy accept-call --no-verify-jwt
// Secrets: supabase secrets set OPENAI_WEBHOOK_SECRET=whsec_... SERVICE_KEY=sb_secret_...
import { createClient } from "npm:@supabase/supabase-js@2";

const enc = new TextEncoder();

async function verifySignature(req: Request, rawBody: string, secret: string): Promise<boolean> {
  try {
    const id = req.headers.get("webhook-id") ?? "";
    const ts = req.headers.get("webhook-timestamp") ?? "";
    const sigHeader = req.headers.get("webhook-signature") ?? "";
    if (!id || !ts || !sigHeader) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay window
    const secretBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${ts}.${rawBody}`));
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return sigHeader.split(" ").some((part) => part.split(",")[1] === expected);
  } catch {
    return false;
  }
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("OPENAI_WEBHOOK_SECRET") ?? "";
  const raw = await req.text();
  if (!secret || !(await verifySignature(req, raw, secret))) {
    return new Response("invalid signature", { status: 401 });
  }
  const event = JSON.parse(raw);
  if (event.type !== "realtime.call.incoming") return Response.json({ ignored: true });

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SERVICE_KEY")!, { auth: { persistSession: false } });
  const headers: Record<string, string> = {};
  for (const h of event.data?.sip_headers ?? []) headers[h.name?.toLowerCase() ?? ""] = h.value ?? "";
  await supa.from("phone_events").upsert({
    openai_call_id: event.data?.call_id,
    called_number: headers["to"] ?? null,
    caller_number_hash: headers["from"] ? await sha256hex(headers["from"]) : null,
    sip_headers: headers,
  }, { onConflict: "openai_call_id", ignoreDuplicates: true });

  return Response.json({ received: true });
});
