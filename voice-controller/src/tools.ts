// Voice tools — executed ONLY server-side under a CALLER capability. The model proposes; these handlers answer.
// F1 surface: read-only + create_async_case + consult_hermes. Booking mutations arrive in F2 via the action worker.
import { createHash, randomUUID } from "node:crypto";
import { loadTenant, priceRules, supa } from "./rules.ts";
import { consultHermes } from "./hermes.ts";

export interface Capability {
  actor: "CALLER";
  tenantSlug: string;
  tenantId: string;
  callId: string; // internal calls.id
  jti: string;
  expiresAt: number;
  allowedTools: string[];
}

export function makeCapability(tenantSlug: string, tenantId: string, callId: string, maxMinutes: number): Capability {
  return {
    actor: "CALLER",
    tenantSlug,
    tenantId,
    callId,
    jti: randomUUID(),
    expiresAt: Date.now() + maxMinutes * 60_000,
    allowedTools: ["get_business_info", "quote_price", "check_availability", "create_async_case", "consult_hermes", "propose_booking", "close_deal"],
  };
}

// OpenAI Realtime function-tool schemas
export const toolSchemas = [
  {
    type: "function",
    name: "get_business_info",
    description: "Business profile: services offered, service area, hours, current local time. Use before answering questions about what the business does.",
    parameters: { type: "object", properties: { topic: { type: "string", description: "optional: services|area|hours" } }, required: [] },
  },
  {
    type: "function",
    name: "quote_price",
    description: "The ONLY source of prices. Returns the approved quote/band for a service. If the service is not approved, returns needs_owner — never invent a price.",
    parameters: {
      type: "object",
      properties: {
        service_type: { type: "string", description: "e.g. drain_cleaning, water_heater_repair" },
        details: { type: "string" },
      },
      required: ["service_type"],
    },
  },
  {
    type: "function",
    name: "check_availability",
    description: "Available appointment slots for a service, already including the quoted price.",
    parameters: {
      type: "object",
      properties: {
        service_type: { type: "string" },
        date_preference: { type: "string", description: "caller preference in natural language, optional" },
      },
      required: ["service_type"],
    },
  },
  {
    type: "function",
    name: "create_async_case",
    description: "Opens a case for the team when something needs owner confirmation (out-of-policy price, emergency callout, unknown service, special request). Tell the caller the team will confirm shortly. Include the caller's exact words in evidence_quote when the request came from them.",
    parameters: {
      type: "object",
      properties: {
        request: { type: "string", description: "what the caller needs, in one sentence" },
        proposed_action: { type: "string" },
        client_name: { type: "string" },
        contact: { type: "string" },
        price_quoted: { type: "number" },
        urgency: { type: "string", enum: ["normal", "urgente"] },
        evidence_quote: { type: "string", description: "caller's exact words, as data" },
      },
      required: ["request"],
    },
  },
  {
    type: "function",
    name: "propose_booking",
    description: "Registers a booking proposal after the caller picked a slot and you agreed on a price within your band. Within policy it returns 'proposed' (then confirm details out loud and call close_deal). Out of policy it opens a team case — tell the caller the team will confirm; never keep them waiting.",
    parameters: {
      type: "object",
      properties: {
        service_type: { type: "string" },
        slot_start: { type: "string", description: "ISO datetime chosen from check_availability" },
        slot_end: { type: "string" },
        price: { type: "number", description: "price agreed with the caller" },
        client_name: { type: "string" },
        contact: { type: "string", description: "phone or email for confirmation" },
      },
      required: ["service_type", "slot_start", "price"],
    },
  },
  {
    type: "function",
    name: "close_deal",
    description: "Finalizes a proposed booking. ONLY if the result says status 'confirmed' may you tell the caller it is booked (repeat date, time, price). 'processing' means: say they'll receive a confirmation text shortly — never claim it is booked.",
    parameters: {
      type: "object",
      properties: {
        booking_id: { type: "string" },
        confirmed_price: { type: "number" },
      },
      required: ["booking_id", "confirmed_price"],
    },
  },
  {
    type: "function",
    name: "consult_ligou_brain",
    description: "Consult the business brain for strategy on complex situations (unusual jobs, tricky negotiation). Say a short bridge phrase like 'let me check that for you' before using it.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" }, context: { type: "string" } },
      required: ["question"],
    },
  },
] as const;

// map external tool name -> internal capability name
const CAP_NAME: Record<string, string> = {
  get_business_info: "get_business_info",
  quote_price: "quote_price",
  check_availability: "check_availability",
  create_async_case: "create_async_case",
  consult_ligou_brain: "consult_hermes",
  propose_booking: "propose_booking",
  close_deal: "close_deal",
};

export interface ToolResult { ok: boolean; body: Record<string, unknown>; durationMs: number }

export async function runTool(cap: Capability, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const started = Date.now();
  const done = (body: Record<string, unknown>, ok = true): ToolResult => ({ ok, body, durationMs: Date.now() - started });

  const capName = CAP_NAME[name];
  if (!capName || !cap.allowedTools.includes(capName)) return done({ error: "tool_not_allowed" }, false);
  if (Date.now() > cap.expiresAt) return done({ error: "capability_expired" }, false);

  try {
    const { tenant, rules } = await loadTenant(cap.tenantSlug);
    if (tenant.id !== cap.tenantId) return done({ error: "tenant_mismatch" }, false);

    switch (name) {
      case "get_business_info": {
        const services = priceRules(rules).map((s) => s.service_type);
        const area = rules.find((r) => r.category === "area");
        const agenda = rules.find((r) => r.category === "agenda");
        return done({
          name: tenant.name,
          services,
          service_area: area ? ((area.structured as any)?.cities ?? area.text) : null,
          hours: agenda?.text ?? null,
          now_local: new Date().toLocaleString("en-US", { timeZone: tenant.timezone }),
        });
      }
      case "quote_price": {
        const svc = String(args.service_type ?? "").toLowerCase().trim();
        const match = priceRules(rules).find((s) => s.service_type === svc);
        if (!match) {
          return done({ status: "needs_owner", reason: "service_not_in_approved_list", say: "Tell the caller you'll check with the team and take their contact info." });
        }
        if (match.surcharge != null) {
          return done({ status: "surcharge", service_type: svc, surcharge_usd: match.surcharge, requires_team_confirmation: true });
        }
        return done({
          status: "quoted",
          service_type: svc,
          quote_usd: match.price_target,
          negotiable_note: "You may negotiate below the quote if the caller pushes back, within your approved band.",
          floor_usd_internal: match.price_min, // never spoken; server enforces in F2 close_deal as well
          duration_min: match.duration_min ?? null,
        });
      }
      case "check_availability": {
        const svc = String(args.service_type ?? "").toLowerCase().trim();
        const match = priceRules(rules).find((s) => s.service_type === svc);
        if (!match) return done({ status: "needs_owner", reason: "service_not_in_approved_list" });
        // F1: deterministic mock slots inside business hours (calendar real chega na F2)
        const slots: Array<{ start: string; end: string; price_usd: number | null }> = [];
        const tz = tenant.timezone;
        const now = new Date();
        for (let d = 1; slots.length < 3 && d <= 7; d++) {
          const day = new Date(now.getTime() + d * 86_400_000);
          const dow = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(day) !== "Sun");
          if (!dow) continue;
          for (const hour of [10, 14]) {
            if (slots.length >= 3) break;
            const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(day);
            slots.push({ start: `${ymd}T${String(hour).padStart(2, "0")}:00:00`, end: `${ymd}T${String(hour + Math.ceil((match.duration_min ?? 60) / 60)).padStart(2, "0")}:00:00`, price_usd: match.price_target ?? null });
          }
        }
        return done({ status: "ok", timezone: tz, slots, note: "Offer at most two options at a time." });
      }
      case "create_async_case": {
        const request = String(args.request ?? "").slice(0, 500);
        if (!request) return done({ error: "request_required" }, false);
        const idem = createHash("sha256").update(`${cap.callId}:${request}:${args.price_quoted ?? ""}`).digest("hex");
        const { data, error } = await supa()
          .from("approval_cases")
          .upsert(
            {
              tenant_id: cap.tenantId,
              call_id: cap.callId,
              request,
              proposed_action: args.proposed_action ? String(args.proposed_action).slice(0, 500) : null,
              client_name: args.client_name ? String(args.client_name).slice(0, 120) : null,
              contact: args.contact ? String(args.contact).slice(0, 120) : null,
              price_quoted: typeof args.price_quoted === "number" ? args.price_quoted : null,
              urgency: args.urgency === "urgente" ? "urgente" : "normal",
              evidence_quote: args.evidence_quote ? String(args.evidence_quote).slice(0, 1000) : null,
              idempotency_key: idem,
            },
            { onConflict: "idempotency_key", ignoreDuplicates: false }
          )
          .select("id,status")
          .single();
        if (error) return done({ status: "unknown", say: "Tell the caller the team will get back to them shortly.", error: error.message }, false);
        return done({ status: "pendente", case_id: data.id, say: "Tell the caller: the team will confirm shortly, you'll receive a text or call back." });
      }
      case "propose_booking": {
        const { proposeBooking } = await import("./booking.ts");
        return done(await proposeBooking(cap, args) as Record<string, unknown>);
      }
      case "close_deal": {
        const { closeDeal } = await import("./booking.ts");
        return done(await closeDeal(cap, args) as Record<string, unknown>);
      }
      case "consult_ligou_brain": {
        const advice = await consultHermes(cap.tenantSlug, String(args.question ?? ""), String(args.context ?? "").slice(0, 1500));
        if (advice.status === "ok") return done({ status: "ok", advice: advice.advice });
        return done({ status: "unavailable", say: "Proceed with the approved rules; if unsure, open a case for the team." });
      }
      default:
        return done({ error: "unknown_tool" }, false);
    }
  } catch (e) {
    return done({ status: "unknown", error: String(e) }, false);
  }
}
