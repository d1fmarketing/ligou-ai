// Booking flow — the deterministic hands. The model proposes; these functions verify grants, bands, and idempotency.
// close_deal never claims success without an ACCEPTED receipt (with read-back proof) — tri-state, unknown never resends.
import { createHash } from "node:crypto";
import { loadTenant, priceRules, supa } from "./rules.ts";
import { checkPower, normalizeGeography } from "./powers.ts";
import type { Capability } from "./tools.ts";
import { opaqueTokenHash } from "./offers.ts";
import { CUSTOMER_OUTCOME } from "./customer-language.ts";

const DENY_SAY = CUSTOMER_OUTCOME.needsTeam;
const PENDING_SAY = CUSTOMER_OUTCOME.bookingPending;

export async function proposeBooking(cap: Capability, args: Record<string, unknown>) {
  const { tenant } = await loadTenant(cap.tenantSlug);
  const slotToken = String(args.slot_token ?? "");
  const clientName = args.client_name ? String(args.client_name).slice(0, 120) : null;
  const contact = args.contact ? String(args.contact).slice(0, 120) : null;
  if (!slotToken) return { status: "invalid_offer", error: "slot_token_required" };
  if (tenant.auth_epoch !== cap.authEpoch) return { status: "denied", error: "authorization_epoch_stale" };
  if (tenant.policy_epoch !== cap.policyEpoch) return { status: "denied", error: "policy_epoch_stale" };
  const { data: consumed, error } = await supa().rpc("consume_slot_offer", {
    p_tenant: tenant.id,
    p_call: cap.callId,
    p_token_hash: opaqueTokenHash(slotToken),
    p_expected_auth_epoch: cap.authEpoch,
    p_expected_policy_epoch: cap.policyEpoch,
    p_client_name: clientName,
    p_contact: contact,
  });
  if (error || !consumed) return { status: "invalid_offer", error: error?.message ?? "slot_offer_not_found", say: DENY_SAY };
  return {
    status: "proposed", booking_id: consumed.booking_id,
    say: "Confirm the details out loud with the caller (service, time, price), then use close_deal to finalize.",
  };
}

export async function closeDeal(cap: Capability, args: Record<string, unknown>) {
  const { tenant, rules } = await loadTenant(cap.tenantSlug);
  const bookingId = String(args.booking_id ?? "");
  if (!bookingId) return { status: "invalid", error: "booking_id required" };

  const { data: booking } = await supa()
    .from("bookings").select("*").eq("id", bookingId).eq("tenant_id", tenant.id).eq("call_id", cap.callId).single();
  if (!booking) return { status: "invalid", error: "booking_not_found" };
  const confirmed = Number(booking.price_agreed ?? NaN);
  if (!Number.isFinite(confirmed)) return { status: "invalid", error: "booking_price_missing" };
  if (tenant.auth_epoch !== cap.authEpoch) return { status: "denied", error: "authorization_epoch_stale" };
  if (tenant.policy_epoch !== cap.policyEpoch) return { status: "denied", error: "policy_epoch_stale" };
  if (booking.status === "confirmed") {
    const { data: confirmation, error: confirmationError } = await supa().rpc("get_booking_confirmation", {
      p_tenant: tenant.id, p_call: cap.callId, p_booking: bookingId,
    });
    if (!confirmationError && confirmation?.confirmed === true && confirmation.receipt_id) {
      return {
        status: "confirmed", receipt: "accepted", receipt_id: confirmation.receipt_id,
        calendar_event_id: confirmation.external_id, say: CUSTOMER_OUTCOME.bookingAlreadyConfirmed,
      };
    }
    return { status: "processing", receipt: "unknown", say: PENDING_SAY };
  }
  if (booking.status === "pending_approval") return { status: "pending_approval", say: DENY_SAY };
  if (booking.status !== "proposed") return { status: booking.status, say: PENDING_SAY };

  // server-side floor + grant re-check at the moment of commitment (never trust the conversation)
  const band = priceRules(rules).find((s) => s.service_type === booking.service_type);
  const authorityContext = (booking.authority_context ?? {}) as Record<string, unknown>;
  const appointmentAt = new Date(String(authorityContext.appointment_at ?? booking.slot_start));
  const power = await checkPower(tenant.id, "voice_agent", "create_booking", booking.service_type, {
    amountUsd: confirmed,
    geography: typeof authorityContext.geography === "string" ? authorityContext.geography : undefined,
    channel: typeof authorityContext.channel === "string" ? authorityContext.channel : undefined,
    purpose: typeof authorityContext.purpose === "string" ? authorityContext.purpose : undefined,
    appointmentAt,
    expectedAuthEpoch: cap.authEpoch,
  });
  if (!band || band.price_min == null || !Number.isFinite(Number(band.price_min))
      || confirmed < Number(band.price_min) || !power.granted) {
    const caseIdem = createHash("sha256").update(`${cap.callId}:close-case:${bookingId}:${confirmed}`).digest("hex");
    const { data: kase } = await supa().from("approval_cases").upsert({
      tenant_id: tenant.id, call_id: cap.callId,
      request: `Close attempt below policy: ${booking.service_type} for $${confirmed}`,
      proposed_action: `Book ${booking.service_type} at ${booking.slot_start} for $${confirmed}`,
      client_name: booking.client_name, contact: booking.contact,
      price_quoted: confirmed, urgency: "normal", idempotency_key: caseIdem,
    }, { onConflict: "idempotency_key" }).select("id").single();
    await supa().from("bookings").update({ status: "pending_approval", case_id: kase?.id ?? null, price_agreed: confirmed })
      .eq("id", bookingId).eq("status", "proposed");
    return { status: "pending_approval", case_id: kase?.id, say: DENY_SAY };
  }

  // server-issued idempotency bound to tenant + booking + price + policy epoch — never model-supplied
  const intentIdem = createHash("sha256")
    .update(`${tenant.id}|calendar_book|${bookingId}|${confirmed}|epoch:${power.authEpoch ?? 1}`)
    .digest("hex");
  const payload = {
    summary: `${booking.service_type} — ${booking.client_name ?? "customer"} ($${confirmed})`,
    description: `Booked by Ligou. Contact: ${booking.contact ?? "?"}. Call ${cap.callId}.`,
    start_iso: booking.slot_start, end_iso: booking.slot_end ?? booking.slot_start,
  };
  const { data: intent, error: ie } = await supa().rpc("authorize_booking_intent", {
    p_tenant: tenant.id,
    p_call: cap.callId,
    p_booking: bookingId,
    p_power: power.powerId,
    p_rule: band.rule_id,
    p_confirmed_price: confirmed,
    p_expected_auth_epoch: cap.authEpoch,
    p_expected_policy_epoch: cap.policyEpoch,
    p_payload: payload,
    p_idempotency_key: intentIdem,
  });
  if (ie || !intent) {
    return { status: "pending_approval", say: DENY_SAY, reason: "authority_changed_before_enqueue", error: ie?.message };
  }

  // Nudge the worker NOW instead of waiting for its next tick. RJ's first real booking was already
  // confirmed in Google, yet the agent said "processing, you'll get a text" because this tool gave up
  // before the tick landed — technically honest, but it undersells a booking that actually happened.
  void import("./worker.ts").then((w) => w.tickIntents()).catch(() => { /* the polling loop remains the safety net */ });

  // wait briefly for the worker (fat tool): confirmed in-call when fast, honest pending otherwise
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const { data: confirmation, error: confirmationError } = await supa().rpc("get_booking_confirmation", {
      p_tenant: tenant.id, p_call: cap.callId, p_booking: bookingId,
    });
    if (!confirmationError && confirmation?.confirmed === true && confirmation.receipt_id) {
      return {
        status: "confirmed", receipt: "accepted", receipt_id: confirmation.receipt_id,
        calendar_event_id: confirmation.external_id, say: CUSTOMER_OUTCOME.bookingConfirmed,
      };
    }
    const { data: b } = await supa().from("bookings").select("status").eq("id", bookingId)
      .eq("tenant_id", tenant.id).eq("call_id", cap.callId).single();
    if (b?.status === "failed") return { status: "failed", receipt: "failed", say: "Apologize, say the time slot could not be secured, and offer another slot." };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { status: "processing", receipt: "unknown", say: PENDING_SAY };
}
