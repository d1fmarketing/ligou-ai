// Voice tools — executed ONLY server-side under a CALLER capability. The model proposes; these handlers answer.
// F1 surface: read-only + create_async_case + consult_hermes. Booking mutations arrive in F2 via the action worker.
import { createHash, randomUUID } from "node:crypto";
import { loadTenant, priceRules, supa } from "./rules.ts";
import { consultHermes } from "./hermes.ts";
import { calendarPort, overlapsBusy, zonedInstantIso, spokenLocal } from "./calendar.ts";
import { checkPower, normalizeGeography } from "./powers.ts";
import { issueQuote, issueSlotOffers, readQuote } from "./offers.ts";

export interface Capability {
  actor: "CALLER";
  tenantSlug: string;
  tenantId: string;
  callId: string; // internal calls.id
  jti: string;
  expiresAt: number;
  allowedTools: string[];
  authEpoch: number;
  policyEpoch: number;
}

export function makeCapability(
  tenantSlug: string,
  tenantId: string,
  callId: string,
  maxMinutes: number,
  sessionType: "customer" | "owner_browser" | "onboarding" = "customer",
  epochs: { authEpoch: number; policyEpoch: number } = { authEpoch: 1, policyEpoch: 1 },
): Capability {
  const allowedTools = sessionType === "onboarding"
    ? ["get_business_info", "record_interview_answer"]
    : ["get_business_info", "quote_price", "evaluate_offer", "check_availability", "create_async_case", "consult_hermes", "propose_booking", "close_deal"];
  return {
    actor: "CALLER",
    tenantSlug,
    tenantId,
    callId,
    jti: randomUUID(),
    expiresAt: Date.now() + maxMinutes * 60_000,
    allowedTools,
    authEpoch: epochs.authEpoch,
    policyEpoch: epochs.policyEpoch,
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
    description: "The ONLY source of prices. Returns one public server-bound quote for a service. If the service is not approved, returns needs_owner — never invent a price.",
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
    name: "evaluate_offer",
    description: "Evaluates a caller's offer against private server policy. Use the returned public price and quote_id exactly; never infer or describe internal limits.",
    parameters: {
      type: "object",
      properties: {
        service_type: { type: "string" },
        offered_price: { type: "number" },
        quote_id: { type: "string", description: "Opaque quote_id returned by quote_price or a prior evaluate_offer" },
      },
      required: ["service_type", "offered_price", "quote_id"],
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
        quote_id: { type: "string", description: "Opaque quote_id returned by quote_price or evaluate_offer" },
        service_city: { type: "string", description: "City where service will occur" },
        date_preference: { type: "string", description: "caller preference in natural language, optional" },
      },
      required: ["service_type", "quote_id", "service_city"],
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
    description: "Consumes the exact opaque slot offer selected by the caller. Pass only the slot_token from check_availability plus customer details; times, service, geography, and price come from the server-bound offer.",
    parameters: {
      type: "object",
      properties: {
        slot_token: { type: "string", description: "Opaque token returned by check_availability" },
        client_name: { type: "string" },
        contact: { type: "string", description: "phone or email for confirmation" },
      },
      required: ["slot_token"],
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
      },
      required: ["booking_id"],
    },
  },
  {
    type: "function",
    name: "record_interview_answer",
    description: "ONBOARDING ONLY: records one answer from the owner interview as a suggested rule (topic + the rule in clear text + structured data when it is a price). Call once per fact learned; the owner approves the batch later in the dashboard.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", enum: ["servicos", "area", "precos", "agenda", "emergencia", "outro"] },
        rule_text: { type: "string", description: "the rule in clear operational language (English)" },
        structured: { type: "object", description: "for prices: {service_type, price_min, price_target, duration_min}" },
        owner_words: { type: "string", description: "the owner's exact words (Portuguese), as evidence" },
      },
      required: ["topic", "rule_text"],
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
  evaluate_offer: "evaluate_offer",
  check_availability: "check_availability",
  create_async_case: "create_async_case",
  consult_ligou_brain: "consult_hermes",
  propose_booking: "propose_booking",
  close_deal: "close_deal",
  record_interview_answer: "record_interview_answer",
};

const TOPIC_CATEGORY: Record<string, string> = {
  servicos: "preco", precos: "preco", area: "area", agenda: "agenda", emergencia: "emergencia", outro: "geral",
};
const TOPIC_ESCOPO: Record<string, string> = {
  servicos: "servico", precos: "servico", area: "localizacao", agenda: "geral", emergencia: "geral", outro: "geral",
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
    if (tenant.auth_epoch !== cap.authEpoch) return done({ error: "authorization_epoch_stale" }, false);
    if (tenant.policy_epoch !== cap.policyEpoch) return done({ error: "policy_epoch_stale" }, false);

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
        const issued = await issueQuote({
          tenantId: cap.tenantId,
          callId: cap.callId,
          serviceType: svc,
          publicQuote: Number(match.price_target),
          ruleId: match.rule_id,
          policyEpoch: cap.policyEpoch,
        });
        return done({
          status: "quoted",
          service_type: svc,
          quote_usd: match.price_target,
          quote_id: issued.quoteId,
          negotiable_note: "If the caller makes another offer, use evaluate_offer. Never choose a negotiated price yourself.",
          duration_min: match.duration_min ?? null,
        });
      }
      case "evaluate_offer": {
        const svc = String(args.service_type ?? "").toLowerCase().trim();
        const offered = Number(args.offered_price ?? NaN);
        const match = priceRules(rules).find((s) => s.service_type === svc);
        if (!match || !Number.isFinite(offered) || match.surcharge != null) return done({ status: "needs_owner" });
        const source = await readQuote({
          quoteId: String(args.quote_id ?? ""), tenantId: cap.tenantId, callId: cap.callId,
          serviceType: svc, policyEpoch: cap.policyEpoch,
        });
        if (!source || source.rule_id !== match.rule_id) return done({ status: "needs_owner" });
        const target = Number(match.price_target);
        const privateMinimum = Number(match.price_min);
        const accepted = offered >= privateMinimum;
        const publicPrice = accepted
          ? Math.min(offered, target)
          : Math.max(privateMinimum + 1, Math.ceil((privateMinimum + target) / 2));
        const issued = await issueQuote({
          tenantId: cap.tenantId, callId: cap.callId, serviceType: svc,
          publicQuote: publicPrice, ruleId: match.rule_id, policyEpoch: cap.policyEpoch,
        });
        return done({ status: accepted ? "accept" : "counter", service_type: svc, public_price_usd: publicPrice, quote_id: issued.quoteId });
      }
      case "check_availability": {
        const svc = String(args.service_type ?? "").toLowerCase().trim();
        const match = priceRules(rules).find((s) => s.service_type === svc);
        if (!match) return done({ status: "needs_owner", reason: "service_not_in_approved_list" });
        const geography = normalizeGeography(String(args.service_city ?? ""));
        if (!geography) return done({ status: "needs_owner", reason: "geography_required" });
        const quote = await readQuote({
          quoteId: String(args.quote_id ?? ""), tenantId: cap.tenantId, callId: cap.callId,
          serviceType: svc, policyEpoch: cap.policyEpoch,
        });
        if (!quote || quote.rule_id !== match.rule_id) return done({ status: "needs_owner", reason: "quote_invalid" });
        // Candidate slots inside business hours, then filtered against the calendar: never offer an hour
        // that is already sold. If the calendar can't be read, say so instead of guessing (rulebook: no
        // invented availability).
        const tz = tenant.timezone;
        const now = new Date();
        const durH = Math.ceil((match.duration_min ?? 60) / 60);
        // Slots must be real instants (ISO/Z) derived from the TENANT's wall clock. A bare local string
        // ("2026-08-20T08:00:00") is rejected by Google freeBusy (HTTP 400) and is silently read by
        // Date.parse as the SERVER's zone — on the UTC EC2 that shifts every slot 7h and would offer
        // hours already sold. Caught live on 2026-08-19.
        const candidates: Array<{ start: string; end: string; local: string; price_usd: number | null }> = [];
        for (let d = 1; d <= 7 && candidates.length < 12; d++) {
          const day = new Date(now.getTime() + d * 86_400_000);
          if (new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(day) === "Sun") continue;
          const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(day);
          for (const hour of [8, 10, 13, 15]) {
            if (hour + durH > 18) continue; // must finish inside business hours
            const start = zonedInstantIso(ymd, hour, tz);
            candidates.push({
              start,
              end: zonedInstantIso(ymd, hour + durH, tz),
              local: spokenLocal(start, tz), // what the agent says out loud
              price_usd: match.price_target ?? null,
            });
          }
        }
        const windowFrom = candidates[0]?.start ?? new Date().toISOString();
        const windowTo = candidates[candidates.length - 1]?.end ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
        const { intervals, unknown } = await calendarPort().busy(cap.tenantId, windowFrom, windowTo);
        if (unknown) {
          return done({
            status: "unavailable",
            reason: "calendar_unreadable",
            say: "Tell the caller you can't confirm the schedule right now, take their preferred time and contact, and let them know the team will confirm.",
          });
        }
        const freeCandidates = candidates.filter((c) => !overlapsBusy(c.start, c.end, intervals));
        const authorized: Array<{ start: string; end: string; local: string; powerId: string }> = [];
        for (const candidate of freeCandidates) {
          const power = await checkPower(cap.tenantId, "voice_agent", "create_booking", svc, {
            amountUsd: Number(quote.public_quote), geography, channel: "voice", purpose: "booking",
            appointmentAt: new Date(candidate.start), expectedAuthEpoch: cap.authEpoch,
          });
          if (power.granted && power.powerId) authorized.push({ ...candidate, powerId: power.powerId });
          if (authorized.length === 3) break;
        }
        if (!authorized.length) {
          return done({ status: "no_slots", timezone: tz, say: "Tell the caller nothing is open in the next few days and offer to have the team call with options." });
        }
        const slots = await issueSlotOffers({
          tenantId: cap.tenantId, callId: cap.callId, serviceType: svc, geography,
          quote, candidates: authorized,
        });
        return done({ status: "ok", timezone: tz, slots, note: "Offer at most two options at a time; say the local text and pass only the matching slot_token to propose_booking." });
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
      case "record_interview_answer": {
        const topic = String(args.topic ?? "outro");
        const ruleText = String(args.rule_text ?? "").slice(0, 600);
        if (!ruleText) return done({ error: "rule_text_required" }, false);
        const { data, error } = await supa().from("rules").insert({
          tenant_id: cap.tenantId,
          origem: "onboarding",
          escopo: TOPIC_ESCOPO[topic] ?? "geral",
          status: "sugerido",
          category: TOPIC_CATEGORY[topic] ?? "geral",
          text: ruleText,
          structured: (args.structured as Record<string, unknown>) ?? null,
          evidence_quote: args.owner_words ? String(args.owner_words).slice(0, 1000) : null,
          related_call_id: cap.callId,
        }).select("id").single();
        if (error) return done({ status: "unknown", error: error.message }, false);
        return done({ status: "recorded", rule_id: data.id, note: "Suggested rule saved; the owner approves the batch in the dashboard." });
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
