// Powers check — the grant ledger is the authority; colors are just product language derived from grants.
// Plan v4 §3: a grant carries conditions (geography, allowed_hours, channel, purpose...). Those conditions are
// ENFORCED here — a grant that says "mon-sat 08:00-18:00" must not authorize an action at 3am.
import { supa } from "./rules.ts";
import { canonicalContact, hashCanonicalContact } from "../../supabase/functions/_shared/privacy.ts";

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
  city?: string;
  channel?: string;
  purpose?: string;
  /** current evaluation instant (expiry / communications) */
  at?: Date;
  /** appointment instant for a future scheduled action */
  appointmentAt?: Date;
  timezone?: string;
  /** epoch carried by an already-issued capability */
  expectedAuthEpoch?: number;
  priorConsent?: boolean;
  body?: string;
  contactHash?: string;
  recentCommunicationCount?: number;
}

export type PowerDay = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export interface PowerConditions {
  geography?: string[];
  allowed_hours?: { days: PowerDay[]; start: string; end: string };
  channel?: string[];
  purpose?: string[];
  frequency?: { max: number; per_days: number };
  max_body_chars?: number;
  quiet_hours_respect?: boolean;
  requires_prior_consent?: boolean;
}

const DAY_KEYS: PowerDay[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);

export function normalizeGeography(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

function parseConditions(value: unknown): PowerConditions | null {
  if (!isRecord(value)) return null;
  const allowedKeys = new Set([
    "geography", "allowed_hours", "channel", "purpose", "frequency", "max_body_chars",
    "quiet_hours_respect", "requires_prior_consent",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (value.geography !== undefined && !stringList(value.geography)) return null;
  if (value.channel !== undefined && !stringList(value.channel)) return null;
  if (value.purpose !== undefined && !stringList(value.purpose)) return null;
  if (value.allowed_hours !== undefined) {
    if (!isRecord(value.allowed_hours)) return null;
    if (Object.keys(value.allowed_hours).some((key) => !new Set(["days", "start", "end"]).has(key))) return null;
    const { days, start, end } = value.allowed_hours;
    if (!Array.isArray(days) || !days.length || !days.every((day) => DAY_KEYS.includes(day as PowerDay))) return null;
    if (typeof start !== "string" || typeof end !== "string" || !HHMM.test(start) || !HHMM.test(end) || start >= end) return null;
  }
  if (value.frequency !== undefined) {
    if (!isRecord(value.frequency)) return null;
    if (Object.keys(value.frequency).some((key) => !new Set(["max", "per_days"]).has(key))) return null;
    const { max, per_days: perDays } = value.frequency;
    if (!Number.isInteger(max) || Number(max) <= 0 || !Number.isInteger(perDays) || Number(perDays) <= 0) return null;
  }
  if (value.max_body_chars !== undefined && (!Number.isInteger(value.max_body_chars) || Number(value.max_body_chars) <= 0)) return null;
  if (value.quiet_hours_respect !== undefined && typeof value.quiet_hours_respect !== "boolean") return null;
  if (value.requires_prior_consent !== undefined && typeof value.requires_prior_consent !== "boolean") return null;
  if (value.quiet_hours_respect === true && value.allowed_hours === undefined) return null;
  return value as PowerConditions;
}

/** Local wall-clock "HH:MM" and weekday key for a tenant timezone. */
function localParts(at: Date, timezone: string): { hhmm: string; day: string } {
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(at).toLowerCase();
  return { hhmm, day: DAY_KEYS.includes(wd) ? wd : wd.slice(0, 3) };
}

/** Returns a denial reason when the grant's conditions do not allow this action, or null when they do. */
export function conditionsDeny(conditions: any, ctx: PowerContext, timezone: string): string | null {
  const parsed = parseConditions(conditions);
  if (!parsed) return "malformed_conditions";

  const hours = parsed.allowed_hours;
  if (hours) {
    const at = ctx.appointmentAt ?? ctx.at ?? new Date();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) return "appointment_time_invalid";
    let local;
    try { local = localParts(at, ctx.timezone ?? timezone); }
    catch { return "timezone_invalid"; }
    if (!hours.days.includes(local.day as PowerDay)) return "outside_allowed_days";
    if (local.hhmm < hours.start || local.hhmm >= hours.end) return "outside_allowed_hours";
  }

  const geo = parsed.geography;
  if (geo?.length) {
    const contextGeography = ctx.geography ?? ctx.city;
    if (!contextGeography?.trim()) return "geography_required";
    const wanted = normalizeGeography(contextGeography);
    if (!geo.some((value) => normalizeGeography(value) === wanted)) return "outside_allowed_geography";
  }

  const channel = parsed.channel;
  if (channel?.length) {
    if (!ctx.channel?.trim()) return "channel_required";
    const wanted = ctx.channel.toLowerCase().trim();
    if (!channel.some((value) => value.toLowerCase().trim() === wanted)) return "channel_not_granted";
  }

  const purpose = parsed.purpose;
  if (purpose?.length) {
    if (!ctx.purpose?.trim()) return "purpose_required";
    const wanted = ctx.purpose.toLowerCase().trim();
    if (!purpose.some((value) => value.toLowerCase().trim() === wanted)) return "purpose_not_granted";
  }

  if (parsed.requires_prior_consent) {
    if (ctx.priorConsent === undefined) return "prior_consent_required";
    if (!ctx.priorConsent) return "prior_consent_not_granted";
  }

  if (parsed.max_body_chars !== undefined) {
    if (ctx.body === undefined) return "body_context_required";
    if (ctx.body.length > parsed.max_body_chars) return "body_too_long";
  }

  if (parsed.frequency) {
    if (ctx.recentCommunicationCount === undefined) return "frequency_context_required";
    if (ctx.recentCommunicationCount >= parsed.frequency.max) return "frequency_cap";
  }

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
  const { data: tenant, error: tenantError } = await supa().from("tenants").select("auth_epoch,timezone").eq("id", tenantId).single();
  if (tenantError || !tenant || !Number.isInteger(tenant.auth_epoch)) {
    return { granted: false, reason: `tenant_authority_lookup_failed: ${tenantError?.message ?? "invalid_epoch"}` };
  }
  const tz = ctx.timezone ?? tenant?.timezone ?? "America/Los_Angeles";
  const authEpoch = Number(tenant?.auth_epoch);
  if (ctx.expectedAuthEpoch != null && ctx.expectedAuthEpoch !== authEpoch) {
    return { granted: false, reason: "authorization_epoch_stale", authEpoch };
  }
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
      lastReason = "monetary_limit_exceeded";
      continue;
    }
    const parsed = parseConditions(p.conditions);
    if (!parsed) { lastReason = "malformed_conditions"; continue; }
    const structuralContext = parsed.frequency ? { ...ctx, recentCommunicationCount: 0 } : ctx;
    const structuralDenial = conditionsDeny(parsed, structuralContext, tz);
    if (structuralDenial) { lastReason = structuralDenial; continue; }
    let grantContext = ctx;
    if (parsed.frequency) {
      if (!ctx.contactHash) { lastReason = "contact_context_required"; continue; }
      const since = new Date((ctx.at ?? new Date()).getTime() - parsed.frequency.per_days * 86_400_000).toISOString();
      const { data: recent, error: conditionError } = await supa()
        .from("communications").select("id")
        .eq("tenant_id", tenantId).eq("contact_hash", ctx.contactHash).eq("status", "sent").gte("created_at", since);
      if (conditionError) {
        lastReason = `condition_lookup_failed: ${conditionError.message}`;
        continue;
      }
      grantContext = { ...ctx, recentCommunicationCount: recent?.length ?? 0 };
    }
    const denied = conditionsDeny(parsed, grantContext, tz);
    if (denied) { lastReason = denied; continue; } // another grant may still allow it
    return { granted: true, powerId: p.id, authEpoch };
  }
  return { granted: false, reason: lastReason, authEpoch };
}

// ---------------------------------------------------------------- communication gate (plan v4 §12)
/** Normalize before hashing so the SAME person always yields the SAME hash — otherwise "+1 (949) 555-0101"
 *  and "+19495550101" would look like two people and an opt-out could be dodged by reformatting. */
export const normalizeContact = canonicalContact;
export const contactHash = hashCanonicalContact;

export interface CommGateResult {
  allowed: boolean;
  reason?: "no_grant" | "opt_out" | "frequency_cap" | "body_too_long" | "outside_allowed_hours" | string;
  powerId?: string;
}

/** Every proactive message passes here first: grant + conditions (quiet hours/channel/purpose) + opt-out +
 *  frequency cap + content limits. Denials are logged as blocked so the owner can see what was withheld. */
export async function checkCommunication(args: {
  tenantId: string; contact: string; channel: string; purpose: string; body: string;
  at?: Date; timezone?: string; priorConsent?: boolean;
}): Promise<CommGateResult> {
  const hash = await contactHash(args.contact);

  const power = await checkPower(args.tenantId, "hermes", "follow_up_message", args.channel, {
    channel: args.channel, purpose: args.purpose, at: args.at, timezone: args.timezone,
    priorConsent: args.priorConsent, body: args.body, contactHash: hash,
  });
  if (!power.granted) return { allowed: false, reason: power.reason === "outside_allowed_hours" ? "outside_allowed_hours" : (power.reason ?? "no_grant") };

  const { data: optOut, error: optOutError } = await supa()
    .from("contact_opt_outs").select("id")
    .eq("tenant_id", args.tenantId).eq("contact_hash", hash).in("channel", ["*", args.channel]).limit(1);
  if (optOutError) return { allowed: false, reason: `condition_lookup_failed: ${optOutError.message}`, powerId: power.powerId };
  if (optOut?.length) return { allowed: false, reason: "opt_out", powerId: power.powerId };

  return { allowed: true, powerId: power.powerId };
}
