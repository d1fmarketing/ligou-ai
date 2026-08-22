// Simulation sandbox for simulation_only tenants: role-play uses REAL rules,
// REAL quotes and REAL free/busy, but slots and bookings live only in this
// process — nothing touches slot_offers, bookings, powers, intents or the
// provider. Tokens are single-use and bound to the call that minted them.
import { randomUUID } from "node:crypto";

const SIM_TTL_MS = 30 * 60_000;

export interface SimulationSlot {
  callId: string;
  tenantId: string;
  serviceType: string;
  price: number;
  start: string;
  end: string;
  local: string;
  expiresAt: number;
}

export interface SimulationBooking {
  callId: string;
  serviceType: string;
  price: number;
  slotStart: string;
  slotEnd: string;
  local: string;
  clientName: string | null;
  contact: string | null;
  closed?: boolean;
  expiresAt?: number;
}

const simSlots = new Map<string, SimulationSlot>();
const simBookings = new Map<string, SimulationBooking>();

function sweep(now: number) {
  for (const [token, slot] of simSlots) if (slot.expiresAt <= now) simSlots.delete(token);
  for (const [id, booking] of simBookings) if ((booking.expiresAt ?? 0) <= now) simBookings.delete(id);
}

export function mintSimulationSlots(
  callId: string,
  tenantId: string,
  serviceType: string,
  price: number,
  candidates: Array<{ start: string; end: string; local: string }>,
  now = Date.now(),
): Array<{ slot_token: string; local: string; price_usd: number }> {
  sweep(now);
  return candidates.map((candidate) => {
    const token = `sim.${randomUUID()}`;
    simSlots.set(token, {
      callId, tenantId, serviceType, price,
      start: candidate.start, end: candidate.end, local: candidate.local,
      expiresAt: now + SIM_TTL_MS,
    });
    return { slot_token: token, local: candidate.local, price_usd: price };
  });
}

export function consumeSimulationSlot(callId: string, token: string, now = Date.now()): SimulationSlot | null {
  sweep(now);
  const slot = simSlots.get(token);
  if (!slot || slot.callId !== callId) return null;
  simSlots.delete(token); // single-use, like the real offer ledger
  return slot;
}

export function createSimulationBooking(
  callId: string,
  slot: SimulationSlot,
  clientName: string | null,
  contact: string | null,
  now = Date.now(),
): string {
  const id = `sim.${randomUUID()}`;
  simBookings.set(id, {
    callId, serviceType: slot.serviceType, price: slot.price,
    slotStart: slot.start, slotEnd: slot.end, local: slot.local,
    clientName, contact, expiresAt: now + SIM_TTL_MS,
  });
  return id;
}

export function readSimulationBooking(callId: string, bookingId: string, now = Date.now()): SimulationBooking | null {
  sweep(now);
  const booking = simBookings.get(bookingId);
  if (!booking || booking.callId !== callId) return null;
  return booking;
}

export function markSimulationBookingClosed(bookingId: string) {
  const booking = simBookings.get(bookingId);
  if (booking) booking.closed = true;
}

// test seams
export function _resetSimulationStore() {
  simSlots.clear();
  simBookings.clear();
}

export function _seedSimulationBooking(callId: string, booking: Omit<SimulationBooking, "callId" | "expiresAt">): string {
  const id = `sim.${randomUUID()}`;
  simBookings.set(id, { ...booking, callId, expiresAt: Date.now() + SIM_TTL_MS });
  return id;
}
