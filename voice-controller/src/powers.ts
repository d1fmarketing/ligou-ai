// Powers check — the grant ledger is the authority; colors are just product language derived from grants.
// Plan v4 §3: a grant carries conditions (geography, allowed_hours, channel, purpose...). Those conditions are
// ENFORCED here — a grant that says "mon-sat 08:00-18:00" must not authorize an action at 3am.
import { createHash } from "node:crypto";
import { supa } from "./rules.ts";

export interface PowerCheck {
  granted: boolean;
  powerId?: string;
  reason?: string; // when denied
  authEpoch?: number;
}

export interface PowerContext {
  amountUsd?: number;
  /** city / service area the action touches */
  geography?: string;
  channel?: string;
  purpose?: string;
  /** evaluation instant — defaults to now; tests pass a fixed one */
  at?: Date;
  timezone?: string;
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Local wall-clock "HH:MM" and weekday key for a tenant timezone. */
function localParts(at: Date, timezone: string): { hhmm: string; day: string } {
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(at).toLowerCase();
  return { hhmm, day: DAY_KEYS.includes(wd) ? wd : wd.slice(0, 3) };
}

/** Returns a denial reason when the grant's conditions do not allow this action, or null when they do. */
export function conditionsDeny(conditions: any, ctx: PowerContext, timezone: string): string | null {
  if (!conditions || typeof conditions !== "object") return null;
  const at = ctx.at ?? new Date();

  const hours = conditions.allowed_hours;
  if (hours?.start && hours?.end) {
    const { hhmm, day } = localParts(at, ctx.timezone ?? timezone);
    if (Array.isArray(hours.days) && hours.days.length && !hours.days.includes(day)) return "outside_allowed_days";
    if (hhmm < String(hours.start) || hhmm >= String(hours.end)) return "outside_allowed_hours";
  }

  const geo = conditions.geography;
  if (Array.isArray(geo) && geo.length && ctx.geography) {
    const wanted = ctx.geography.toLowerCase().trim();
    if (!geo.some((g: string) => String(g).toLowerCase().trim() === wanted)) return "outside_allowed_geography";
  }

  const ch = conditions.channel;
  if (Array.isArray(ch) && ch.length && ctx.channel && !ch.includes(ctx.channel)) return "channel_not_granted";

  const pu = conditions.purpose;
  if (Array.isArray(pu) && pu.length && ctx.purpose && !pu.includes(ctx.purpose)) return "purpose_not_granted";

  return null;
}

export async function checkPower(
  tenantId: string,
  subject: "voice_agent" | "hermes",
  capability: string,
  resource: string,
  amountOrCtx?: number | PowerContext
): Promise<PowerCheck> {
  const ctx: PowerContext = typeof amountOrCtx === "number" ? { amountUsd: amountOrCtx } : (amountOrCtx ?? {});
  const { data: tenant } = await supa().from("tenants").select("auth_epoch,timezone").eq("id", tenantId).single();
  const tz = ctx.timezone ?? tenant?.timezone ?? "America/Los_Angeles";
  const { data: powers, error } = await supa()
    .from("powers")
    .select("id,resource,monetary_limit,expires_at,conditions")
    .eq("tenant_id", tenantId)
    .eq("subject", subject)
    .eq("capability", capability)
    .is("revoked_at", null);
  if (error) return { granted: false, reason: `power_lookup_failed: ${error.message}` };

  const now = (ctx.at ?? new Date()).getTime();
  let lastReason = "no_grant_for_capability";
  for (const p of powers ?? []) {
    if (p.resource !== "*" && p.resource !== resource) continue;
    if (p.expires_at && new Date(p.expires_at).getTime() < now) { lastReason = "grant_expired"; continue; }
    if (ctx.amountUsd != null && p.monetary_limit != null && ctx.amountUsd > Number(p.monetary_limit)) {
      return { granted: false, powerId: p.id, reason: "monetary_limit_exceeded", authEpoch: tenant?.auth_epoch };
    }
    const denied = conditionsDeny(p.conditions, ctx, tz);
    if (denied) { lastReason = denied; continue; } // another grant may still allow it
    return { granted: true, powerId: p.id, authEpoch: tenant?.auth_epoch };
  }
  return { granted: false, reason: lastReason, authEpoch: tenant?.auth_epoch };
}

// ---------------------------------------------------------------- communication gate (plan v4 §12)
/** Normalize before hashing so the SAME person always yields the SAME hash — otherwise "+1 (949) 555-0101"
 *  and "+19495550101" would look like two people and an opt-out could be dodged by reformatting. */
export function normalizeContact(contact: string): string {
  const raw = contact.trim().toLowerCase();
  if (raw.includes("@")) return raw.replace(/\s+/g, "");            // email
  const digits = raw.replace(/\D/g, "");                             // phone: digits only
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits; // drop US country code
}

export const contactHash = (contact: string): string =>
  createHash("sha256").update(normalizeContact(contact)).digest("hex");

export interface CommGateResult {
  allowed: boolean;
  reason?: "no_grant" | "opt_out" | "frequency_cap" | "body_too_long" | "outside_allowed_hours" | string;
  powerId?: string;
}

/** Every proactive message passes here first: grant + conditions (quiet hours/channel/purpose) + opt-out +
 *  frequency cap + content limits. Denials are logged as blocked so the owner can see what was withheld. */
export async function checkCommunication(args: {
  tenantId: string; contact: string; channel: string; purpose: string; body: string;
  at?: Date; timezone?: string;
}): Promise<CommGateResult> {
  const hash = contactHash(args.contact);

  const power = await checkPower(args.tenantId, "hermes", "follow_up_message", args.channel, {
    channel: args.channel, purpose: args.purpose, at: args.at, timezone: args.timezone,
  });
  if (!power.granted) return { allowed: false, reason: power.reason === "outside_allowed_hours" ? "outside_allowed_hours" : (power.reason ?? "no_grant") };

  const { data: grant } = await supa().from("powers").select("conditions").eq("id", power.powerId!).single();
  const cond = (grant?.conditions ?? {}) as any;

  if (cond.max_body_chars && args.body.length > Number(cond.max_body_chars)) {
    return { allowed: false, reason: "body_too_long", powerId: power.powerId };
  }

  const { data: optOut } = await supa()
    .from("contact_opt_outs").select("id")
    .eq("tenant_id", args.tenantId).eq("contact_hash", hash).in("channel", ["*", args.channel]).limit(1);
  if (optOut?.length) return { allowed: false, reason: "opt_out", powerId: power.powerId };

  const freq = cond.frequency;
  if (freq?.max && freq?.per_days) {
    const since = new Date((args.at ?? new Date()).getTime() - Number(freq.per_days) * 86_400_000).toISOString();
    const { data: recent } = await supa()
      .from("communications").select("id")
      .eq("tenant_id", args.tenantId).eq("contact_hash", hash).eq("status", "sent").gte("created_at", since);
    if ((recent?.length ?? 0) >= Number(freq.max)) return { allowed: false, reason: "frequency_cap", powerId: power.powerId };
  }

  return { allowed: true, powerId: power.powerId };
}
