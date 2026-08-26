// Voice tools — executed ONLY server-side under a CALLER capability. The model proposes; these handlers answer.
// F1 surface: deterministic read/decision tools + create_async_case. Booking mutations arrive in F2 via the action worker.
import { createHash, randomUUID } from "node:crypto";
import {
  loadTenant,
  priceRules,
  ruleByMaterializationKey,
  servicePolicies,
  supa,
  type Rule,
} from "./rules.ts";
import { calendarPort, overlapsBusy, zonedInstantIso, spokenLocal } from "./calendar.ts";
import { checkPower, normalizeGeography } from "./powers.ts";
import { issueQuote, issueSlotOffers, readQuote } from "./offers.ts";
import { CUSTOMER_OUTCOME } from "./customer-language.ts";
import { buildTrustedHermesContext, consultHermes, HERMES_TOPICS } from "./hermes.ts";
import { mintSimulationSlots } from "./simulation.ts";
import {
  recordOnboardingAnswer,
  recordOnboardingVoiceApproval,
  type OnboardingAnswerArgs,
} from "./onboarding-store.ts";

export type CapabilitySessionType = "customer" | "owner_browser" | "onboarding";

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
  simulation: boolean; // simulation_only tenant: role-play never reaches offers/powers/provider
  sessionType: CapabilitySessionType;
  ownerUserId?: string;
}

export function makeCapability(
  tenantSlug: string,
  tenantId: string,
  callId: string,
  maxMinutes: number,
  sessionType: CapabilitySessionType = "customer",
  epochs: { authEpoch: number; policyEpoch: number; simulation?: boolean } = { authEpoch: 1, policyEpoch: 1 },
  ownerUserId?: string,
): Capability {
  const allowedTools = sessionType === "onboarding"
    ? ["get_business_info", "record_interview_answer", "approve_onboarding_summary", "end_session"]
    : ["get_business_info", "quote_price", "evaluate_offer", "check_availability", "create_async_case", "consult_ligou_brain", "propose_booking", "close_deal"];
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
    simulation: epochs.simulation === true,
    sessionType,
    ...(sessionType !== "customer" && ownerUserId
      ? { ownerUserId }
      : {}),
  };
}

// OpenAI Realtime function-tool schemas
const ONBOARDING_COVERAGE_FIELDS = [
  "business.customer_types",
  "business.excluded_work",
  "business.languages_tone",
  "area.coverage",
  "area.out_of_area_policy",
  "area.travel_fee",
  "schedule.business_hours",
  "schedule.same_day_lead_time",
  "schedule.capacity_buffer",
  "schedule.reschedule_cancel",
  "schedule.holidays",
  "emergency.types",
  "emergency.safety_escalation",
  "emergency.after_hours",
  "emergency.fee_authority",
  "policy.payment_estimate",
  "policy.warranty_materials",
  "policy.access_cancellation",
  "policy.complaints_returns",
  "authority.quote_price",
  "authority.negotiate_floor",
  "authority.read_calendar",
  "authority.book",
  "authority.reschedule_cancel",
  "authority.charge_fee",
  "authority.emergency",
  "authority.out_of_area",
  "service.catalog_closure",
  "service.name_synonyms",
  "service.price_mode",
  "service.price_target",
  "service.negotiation",
  "service.duration",
  "service.inclusions_exclusions",
  "service.materials_parts",
  "service.warranty",
  "service.emergency_eligibility",
  "service.escalation",
] as const;

const allToolSchemas = [
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
    description: "Finalizes a proposed booking. Only status confirmed authorizes booked language. Processing means the team is confirming and will contact the caller; never claim it is booked.",
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
    name: "consult_ligou_brain",
    description: "Requests one safe operational action for a known service. Pass only the topic enum and approved service identifier; never pass caller text, contact details, an address, or pricing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: { type: "string", enum: HERMES_TOPICS },
        service_id: { type: "string", description: "Approved service identifier returned by get_business_info" },
      },
      required: ["topic", "service_id"],
    },
  },
  {
    type: "function",
    name: "record_interview_answer",
    description: "ONBOARDING ONLY: records exactly one owner-provided fact as suggested evidence. One call maps one field; it does not approve rules, grant powers, or change operational mode.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: { type: "string", enum: ["servicos", "area", "precos", "agenda", "emergencia", "outro"] },
        field: { type: "string", enum: ONBOARDING_COVERAGE_FIELDS },
        subject: { type: "string", description: "Top-level normalized service identifier required for every service.* field; omit for service.catalog_closure and non-service fields." },
        disposition: { type: "string", enum: ["answered", "not_applicable", "owner_review_required"] },
        rule_text: { type: "string", description: "short evidence paraphrase only; the server never uses this model-authored text as operational policy" },
        structured: { type: "object", description: 'Use exactly {"value":...}: service.name_synonyms -> non-empty string array; service.price_mode -> fixed|starting_at|estimate|owner_review; service.price_target -> nonnegative number; service.negotiation -> {"floor":number} or "non_negotiable" when answered (or use owner_review_required disposition); service.duration -> positive minutes; service.catalog_closure -> true only after explicit no-more-services.' },
        owner_words: { type: "string", description: "the owner's exact words (Portuguese), as evidence" },
      },
      required: ["topic", "field", "disposition", "rule_text", "owner_words"],
    },
  },
  {
    type: "function",
    name: "approve_onboarding_summary",
    description: "ONBOARDING ONLY: persists the owner's explicit voice acknowledgement of the current application-provided coverage summary. It does not approve rules or grant powers.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        owner_words: { type: "string", description: "the owner's explicit approval words (Portuguese)" },
      },
      required: ["owner_words"],
    },
  },
  {
    type: "function",
    name: "end_session",
    description: "ONBOARDING ONLY: requests application-owned close after the current lifecycle signoff command. This tool never authorizes or performs hangup by itself.",
    parameters: { type: "object", properties: {}, required: [] },
  },
] as const;

const ONBOARDING_TOOL_NAMES = new Set([
  "get_business_info",
  "record_interview_answer",
  "approve_onboarding_summary",
  "end_session",
]);
const CUSTOMER_TOOL_NAMES = new Set([
  "get_business_info",
  "quote_price",
  "evaluate_offer",
  "check_availability",
  "create_async_case",
  "propose_booking",
  "close_deal",
  "consult_ligou_brain",
]);

export function toolSchemasForSessionType(sessionType: CapabilitySessionType) {
  const allowed = sessionType === "onboarding"
    ? ONBOARDING_TOOL_NAMES
    : CUSTOMER_TOOL_NAMES;
  return allToolSchemas.filter((schema) => allowed.has(schema.name));
}

// Backward-compatible customer/phone export. Owner onboarding must call the
// session-scoped selector so it never receives the customer mutation surface.
export const toolSchemas = toolSchemasForSessionType("customer");

// map external tool name -> internal capability name
const CAP_NAME: Record<string, string> = {
  get_business_info: "get_business_info",
  quote_price: "quote_price",
  evaluate_offer: "evaluate_offer",
  check_availability: "check_availability",
  create_async_case: "create_async_case",
  propose_booking: "propose_booking",
  close_deal: "close_deal",
  consult_ligou_brain: "consult_ligou_brain",
  record_interview_answer: "record_interview_answer",
  approve_onboarding_summary: "approve_onboarding_summary",
  end_session: "end_session",
};

export interface ToolResult { ok: boolean; body: Record<string, unknown>; durationMs: number }

function hasDomainV2(rules: Rule[], key: string): boolean {
  return rules.some((rule) => rule.structured?.materialization_key === key);
}

function areaCities(rule: Rule | undefined): string[] {
  return Array.isArray(rule?.structured?.cities)
    ? rule.structured.cities
        .map((city) => normalizeGeography(String(city)))
        .filter(Boolean)
    : [];
}

function scheduleWindow(rules: Rule[]):
  | { kind: "legacy"; days: Set<string>; opens: number; closes: number }
  | { kind: "v2"; days: Set<string>; opens: number; closes: number }
  | { kind: "blocked" } {
  const key = "domain:schedule";
  const rule = ruleByMaterializationKey(rules, key, "agenda");
  if (!hasDomainV2(rules, key))
    return {
      kind: "legacy",
      days: new Set(["mon", "tue", "wed", "thu", "fri", "sat"]),
      opens: 8,
      closes: 18,
    };
  if (
    !rule || rule.structured?.operational_state !== "active" ||
    !rule.structured.business_hours ||
    typeof rule.structured.business_hours !== "object" ||
    Array.isArray(rule.structured.business_hours)
  ) return { kind: "blocked" };
  const hours = rule.structured.business_hours as {
    days?: unknown;
    hours?: { opens?: unknown; closes?: unknown };
  };
  const allowedDays = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  const days = Array.isArray(hours.days) && hours.days.every(
      (day) => typeof day === "string" && allowedDays.has(day.toLowerCase()),
    )
    ? new Set(hours.days.map((day) => String(day).toLowerCase()))
    : null;
  const hour = (value: unknown) => {
    const match = /^([01]?[0-9]|2[0-3]):00$/.exec(
      String(value ?? ""),
    );
    return match ? Number(match[1]) : null;
  };
  const opens = hour(hours.hours?.opens);
  const closes = hour(hours.hours?.closes);
  return days && days.size > 0 && opens !== null && closes !== null && opens < closes
    ? { kind: "v2", days, opens, closes }
    : { kind: "blocked" };
}

export async function runTool(
  cap: Capability,
  name: string,
  args: Record<string, unknown>,
  providerToolCallId?: string,
): Promise<ToolResult> {
  const started = Date.now();
  const done = (body: Record<string, unknown>, ok = true): ToolResult => ({ ok, body, durationMs: Date.now() - started });

  const capName = CAP_NAME[name];
  if (!capName || !cap.allowedTools.includes(capName)) return done({ error: "tool_not_allowed" }, false);
  if (Date.now() > cap.expiresAt) return done({ error: "capability_expired" }, false);

  // Pure close signal: no tenant data is read or written, so it resolves before loadTenant.
  // The sideband owns actual hangup after lifecycle proof and audited provider termination.
  if (name === "end_session")
    return done({ status: "application_owned_close", ending: false });
  if (
    (name === "record_interview_answer" ||
      name === "approve_onboarding_summary") &&
    !providerToolCallId
  )
    return done({ error: "provider_tool_call_id_required" }, false);

  try {
    const { tenant, rules } = await loadTenant(cap.tenantSlug);
    if (tenant.id !== cap.tenantId) return done({ error: "tenant_mismatch" }, false);
    if (tenant.auth_epoch !== cap.authEpoch) return done({ error: "authorization_epoch_stale" }, false);
    if (tenant.policy_epoch !== cap.policyEpoch) return done({ error: "policy_epoch_stale" }, false);

    switch (name) {
      case "get_business_info": {
        const services = servicePolicies(rules).map((s) => s.service_type);
        const area = ruleByMaterializationKey(rules, "domain:area", "area");
        const agenda = ruleByMaterializationKey(
          rules,
          "domain:schedule",
          "agenda",
        );
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
        const match = servicePolicies(rules).find((s) => s.service_type === svc);
        if (!match) {
          return done({ status: "needs_owner", service_type: svc, reason: "service_not_in_approved_list", say: "Tell the caller you'll check with the team and take their contact info." });
        }
        if (match.surcharge != null) {
          return done({ status: "surcharge", service_type: svc, surcharge_usd: match.surcharge, requires_team_confirmation: true });
        }
        if (
          !match.quoteable ||
          match.operational_state === "owner_review_required" ||
          !Number.isFinite(Number(match.price_target)) ||
          !Number.isFinite(Number(match.price_min)) ||
          !Number.isFinite(Number(match.duration_min))
        )
          return done({
            status: "needs_owner",
            service_type: svc,
            reason: match.price_mode === "estimate"
              ? "estimate_requires_owner"
              : "service_policy_requires_owner",
          });
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
          price_mode: match.price_mode === "legacy" ? "fixed" : match.price_mode,
          negotiable_note: match.negotiable
            ? "If the caller makes another offer, use evaluate_offer. Never choose a negotiated price yourself."
            : "This approved public price is not negotiable; do not call evaluate_offer.",
          duration_min: match.duration_min ?? null,
        });
      }
      case "evaluate_offer": {
        const svc = String(args.service_type ?? "").toLowerCase().trim();
        const offered = Number(args.offered_price ?? NaN);
        const match = priceRules(rules).find((s) => s.service_type === svc);
        if (!match || !Number.isFinite(offered) || match.surcharge != null
          || (match.schema === "ligou.rule.service.v2" && !match.negotiable)
          || match.price_min == null || !Number.isFinite(Number(match.price_min))) {
          return done({ status: "needs_owner" });
        }
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
          : privateMinimum < target
            ? Math.min(target, Math.max(privateMinimum + 1, Math.ceil((privateMinimum + target) / 2)))
            : target;
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
        if (match.price_min == null || !Number.isFinite(Number(match.price_min))) {
          return done({ status: "needs_owner", reason: "pricing_policy_incomplete" });
        }
        const geography = normalizeGeography(String(args.service_city ?? ""));
        if (!geography) return done({ status: "needs_owner", reason: "geography_required" });
        const areaKey = "domain:area";
        const areaRule = ruleByMaterializationKey(rules, areaKey, "area");
        if (
          hasDomainV2(rules, areaKey) &&
          (!areaRule || areaRule.structured?.operational_state !== "active")
        )
          return done({
            status: "needs_owner",
            reason: "area_policy_requires_owner",
            say: CUSTOMER_OUTCOME.needsTeam,
          });
        const cities = areaCities(areaRule);
        if (cities.length > 0 && !cities.includes(geography))
          return done({
            status: "needs_owner",
            reason: "geography_not_served",
            say: CUSTOMER_OUTCOME.needsTeam,
          });
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
        const schedule = scheduleWindow(rules);
        if (schedule.kind === "blocked")
          return done({
            status: "needs_owner",
            reason: "schedule_policy_requires_owner",
            say: CUSTOMER_OUTCOME.needsTeam,
          });
        // Slots must be real instants (ISO/Z) derived from the TENANT's wall clock. A bare local string
        // ("2026-08-20T08:00:00") is rejected by Google freeBusy (HTTP 400) and is silently read by
        // Date.parse as the SERVER's zone — on the UTC EC2 that shifts every slot 7h and would offer
        // hours already sold. Caught live on 2026-08-19.
        const candidates: Array<{ start: string; end: string; local: string; price_usd: number | null }> = [];
        for (let d = 1; d <= 7 && candidates.length < 12; d++) {
          const day = new Date(now.getTime() + d * 86_400_000);
          const weekday = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            weekday: "short",
          }).format(day).slice(0, 3).toLowerCase();
          if (!schedule.days.has(weekday)) continue;
          const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(day);
          const candidateHours = schedule.kind === "legacy"
            ? [8, 10, 13, 15]
            : Array.from(
                { length: Math.ceil((schedule.closes - schedule.opens) / 2) },
                (_unused, index) => schedule.opens + index * 2,
              );
          for (const hour of candidateHours) {
            if (hour + durH > schedule.closes) continue;
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
            say: CUSTOMER_OUTCOME.scheduleUnreadable,
          });
        }
        const freeCandidates = candidates.filter((c) => !overlapsBusy(c.start, c.end, intervals));
        if (cap.simulation) {
          // Simulation: real rules, real quote, real free/busy — but slots never
          // enter the offers ledger and no booking power is consulted or required.
          // The approved service area IS still rehearsed, so the owner sees the
          // agent refuse geographies the business does not serve.
          const chosen = freeCandidates.slice(0, 3);
          if (!chosen.length) return done({ status: "no_slots", timezone: tz, say: CUSTOMER_OUTCOME.noSlots });
          const slots = mintSimulationSlots(cap.callId, cap.tenantId, svc, Number(quote.public_quote), chosen);
          return done({ status: "ok", timezone: tz, simulated: true, slots, note: "Offer at most two options at a time; say the local text and pass only the matching slot_token to propose_booking." });
        }
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
          return done({ status: "no_slots", timezone: tz, say: CUSTOMER_OUTCOME.noSlots });
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
        return done({ status: "pendente", case_id: data.id, say: CUSTOMER_OUTCOME.needsTeam });
      }
      case "consult_ligou_brain": {
        let context;
        try {
          context = buildTrustedHermesContext(
            String(args.topic ?? ""),
            String(args.service_id ?? ""),
            tenant,
            rules,
          );
        } catch {
          return done({ status: "unavailable", reason: "invalid_structured_request" }, false);
        }
        const advice = await consultHermes({ id: tenant.id, slug: tenant.slug }, context);
        return done(advice, advice.status === "ok");
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
        const result = await recordOnboardingAnswer(
          cap,
          providerToolCallId!,
          args as OnboardingAnswerArgs,
        );
        if (!result.ok)
          return done(
            {
              status: "unknown",
              error: result.code,
              detail: result.safeDetail,
            },
            false,
          );
        return done({
          status: result.status,
          rule_id: result.ruleId,
          coverage_receipt_id: result.coverageReceiptId,
          revision: result.revision,
          complete: result.complete,
          missing: result.missing,
          ambiguous: result.ambiguous,
          next_action: result.nextAction,
          snapshot_hash: result.digest,
        });
      }
      case "approve_onboarding_summary": {
        const result = await recordOnboardingVoiceApproval(
          cap,
          providerToolCallId!,
          typeof args.owner_words === "string" ? args.owner_words : "",
        );
        if (!result.ok)
          return done(
            {
              status: "unknown",
              error: result.code,
              detail: result.safeDetail,
            },
            false,
          );
        return done({
          status: result.status,
          approval_receipt_id: result.approvalReceiptId,
          coverage_receipt_id: result.coverageReceiptId,
          revision: result.revision,
          snapshot_hash: result.digest,
        });
      }
      default:
        return done({ error: "unknown_tool" }, false);
    }
  } catch (e) {
    return done({ status: "unknown", error: String(e) }, false);
  }
}
