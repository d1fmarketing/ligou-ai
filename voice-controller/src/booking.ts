// Booking flow — the deterministic hands. The model proposes; these functions verify grants, bands, and idempotency.
// close_deal never claims success without an ACCEPTED receipt (with read-back proof) — tri-state, unknown never resends.
import { createHash } from "node:crypto";
import { loadTenant, priceRules, supa } from "./rules.ts";
import { checkPower, normalizeGeography } from "./powers.ts";
import type { Capability } from "./tools.ts";

const DENY_SAY = "Tell the caller: that specific request needs a quick confirmation from the team, and someone will get back to them shortly. Do not promise a text message — SMS is not connected yet.";
const PENDING_SAY = "Tell the caller the request went through and the team will confirm the time shortly. Do NOT say it is booked yet, and do NOT promise a text message — SMS is not connected yet.";

export async function proposeBooking(cap: Capability, args: Record<string, unknown>) {
  const { tenant, rules } = await loadTenant(cap.tenantSlug);
  const svc = String(args.service_type ?? "").toLowerCase().trim();
  const slotStart = String(args.slot_start ?? "");
  const price = Number(args.price ?? NaN);
  const clientName = args.client_name ? String(args.client_name).slice(0, 120) : null;
  const contact = args.contact ? String(args.contact).slice(0, 120) : null;
  if (!svc || !slotStart || Number.isNaN(price)) return { status: "invalid", error: "service_type, slot_start and price are required" };

  const band = priceRules(rules).find((s) => s.service_type === svc);
  const idem = createHash("sha256").update(`${tenant.id}|booking|${svc}|${slotStart}|${cap.callId}`).digest("hex");
  if (tenant.auth_epoch !== cap.authEpoch) return { status: "denied", error: "authorization_epoch_stale" };
  if (tenant.policy_epoch !== cap.policyEpoch) return { status: "denied", error: "policy_epoch_stale" };
  const appointmentAt = new Date(slotStart);
  if (Number.isNaN(appointmentAt.getTime())) return { status: "invalid", error: "slot_start_invalid" };
  const geography = args.service_city ? normalizeGeography(String(args.service_city)) : undefined;
  const authorityContext = {
    geography,
    channel: "voice",
    purpose: "booking",
    appointment_at: appointmentAt.toISOString(),
  };

  // out-of-policy paths → async case, caller never waits
  const power = await checkPower(tenant.id, "voice_agent", "create_booking", svc, {
    amountUsd: price,
    geography,
    channel: authorityContext.channel,
    purpose: authorityContext.purpose,
    appointmentAt,
    expectedAuthEpoch: cap.authEpoch,
  });
  const belowFloor = band && band.price_min != null && price < Number(band.price_min);
  const unknownService = !band;
  if (unknownService || belowFloor || !power.granted) {
    const reason = unknownService ? "service_not_approved" : belowFloor ? "price_below_minimum" : power.reason;
    const caseIdem = createHash("sha256").update(`${cap.callId}:booking-case:${idem}`).digest("hex");
    const { data: kase } = await supa()
      .from("approval_cases")
      .upsert({
        tenant_id: tenant.id, call_id: cap.callId,
        request: `Booking request outside policy (${reason}): ${svc} at ${slotStart} for $${price}`,
        proposed_action: `Book ${svc} at ${slotStart} for $${price}`,
        client_name: clientName, contact, price_quoted: price,
        urgency: "normal", idempotency_key: caseIdem,
      }, { onConflict: "idempotency_key" })
      .select("id").single();
    const { data: booking } = await supa()
      .from("bookings")
      .upsert({
        tenant_id: tenant.id, call_id: cap.callId, case_id: kase?.id ?? null,
        client_name: clientName, contact, service_type: svc, price_agreed: price,
        slot_start: slotStart, status: "pending_approval", idempotency_key: idem,
        authority_context: authorityContext,
      }, { onConflict: "idempotency_key" })
      .select("id").single();
    return { status: "pending_approval", booking_id: booking?.id, case_id: kase?.id, reason, say: DENY_SAY };
  }

  const { data: booking, error } = await supa()
    .from("bookings")
    .upsert({
      tenant_id: tenant.id, call_id: cap.callId,
      client_name: clientName, contact, service_type: svc, price_agreed: price,
      slot_start: slotStart,
      slot_end: args.slot_end ? String(args.slot_end) : null,
      authority_context: authorityContext,
      status: "proposed", idempotency_key: idem,
    }, { onConflict: "idempotency_key" })
    .select("id,status").single();
  if (error || !booking) return { status: "unknown", say: PENDING_SAY, error: error?.message };
  return {
    status: "proposed", booking_id: booking.id,
    say: "Confirm the details out loud with the caller (service, time, price), then use close_deal to finalize.",
  };
}

export async function closeDeal(cap: Capability, args: Record<string, unknown>) {
  const { tenant, rules } = await loadTenant(cap.tenantSlug);
  const bookingId = String(args.booking_id ?? "");
  const confirmed = Number(args.confirmed_price ?? NaN);
  if (!bookingId || Number.isNaN(confirmed)) return { status: "invalid", error: "booking_id and confirmed_price required" };

  const { data: booking } = await supa()
    .from("bookings").select("*").eq("id", bookingId).eq("tenant_id", tenant.id).single();
  if (!booking) return { status: "invalid", error: "booking_not_found" };
  if (tenant.auth_epoch !== cap.authEpoch) return { status: "denied", error: "authorization_epoch_stale" };
  if (tenant.policy_epoch !== cap.policyEpoch) return { status: "denied", error: "policy_epoch_stale" };
  if (booking.status === "confirmed") return { status: "confirmed", receipt: "accepted", say: "Already booked — you can tell the caller it is confirmed." };
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
  if (!band || (band.price_min != null && confirmed < Number(band.price_min)) || !power.granted) {
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
  const { data: intent, error: ie } = await supa()
    .from("action_intents")
    .upsert({
      tenant_id: tenant.id, call_id: cap.callId, booking_id: bookingId,
      kind: "calendar_book",
      payload: {
        summary: `${booking.service_type} — ${booking.client_name ?? "customer"} ($${confirmed})`,
        description: `Booked by Ligou. Contact: ${booking.contact ?? "?"}. Call ${cap.callId}.`,
        start_iso: booking.slot_start, end_iso: booking.slot_end ?? booking.slot_start,
      },
      policy_snapshot: {
        power_id: power.powerId,
        auth_epoch: power.authEpoch,
        policy_epoch: tenant.policy_epoch,
        price_min: band.price_min,
        price_confirmed: confirmed,
        rule_id: band.rule_id,
        authority_context: authorityContext,
      },
      idempotency_key: intentIdem, status: "queued",
    }, { onConflict: "idempotency_key" })
    .select("id,status").single();
  if (ie || !intent) return { status: "unknown", say: PENDING_SAY, error: ie?.message };

  await supa().from("bookings").update({ intent_id: intent.id, price_agreed: confirmed }).eq("id", bookingId);

  // Nudge the worker NOW instead of waiting for its next tick. RJ's first real booking was already
  // confirmed in Google, yet the agent said "processing, you'll get a text" because this tool gave up
  // before the tick landed — technically honest, but it undersells a booking that actually happened.
  void import("./worker.ts").then((w) => w.tickIntents()).catch(() => { /* the polling loop remains the safety net */ });

  // wait briefly for the worker (fat tool): confirmed in-call when fast, honest pending otherwise
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const { data: b } = await supa().from("bookings").select("status,calendar_event_id").eq("id", bookingId).single();
    if (b?.status === "confirmed") {
      return { status: "confirmed", receipt: "accepted", calendar_event_id: b.calendar_event_id, say: "You can now tell the caller it is booked and repeat date, time and price." };
    }
    if (b?.status === "failed") return { status: "failed", receipt: "failed", say: "Apologize, say the time slot could not be secured, and offer another slot." };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { status: "processing", receipt: "unknown", say: PENDING_SAY };
}
