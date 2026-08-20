import { createHash, randomBytes, randomUUID } from "node:crypto";
import { supa } from "./rules.ts";

const QUOTE_TTL_MS = 15 * 60_000;
const SLOT_TTL_MS = 10 * 60_000;

export interface BoundQuote {
  id: string;
  tenant_id: string;
  call_id: string;
  service_type: string;
  public_quote: number;
  rule_id: string;
  policy_epoch: number;
  expires_at: string;
}

export interface SlotCandidate {
  start: string;
  end: string;
  local: string;
  powerId: string;
}

export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function opaqueTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueQuote(args: {
  tenantId: string;
  callId: string;
  serviceType: string;
  publicQuote: number;
  ruleId: string;
  policyEpoch: number;
  now?: number;
}): Promise<{ quoteId: string; row: BoundQuote }> {
  const token = opaqueToken();
  const now = args.now ?? Date.now();
  const row: BoundQuote & { token_hash: string; created_at: string } = {
    id: randomUUID(),
    token_hash: opaqueTokenHash(token),
    tenant_id: args.tenantId,
    call_id: args.callId,
    service_type: args.serviceType,
    public_quote: args.publicQuote,
    rule_id: args.ruleId,
    policy_epoch: args.policyEpoch,
    expires_at: new Date(now + QUOTE_TTL_MS).toISOString(),
    created_at: new Date(now).toISOString(),
  };
  const { error } = await supa().from("booking_quotes").insert(row);
  if (error) throw new Error(`quote_issue_failed: ${error.message}`);
  return { quoteId: token, row };
}

export async function readQuote(args: {
  quoteId: string;
  tenantId: string;
  callId: string;
  serviceType: string;
  policyEpoch: number;
  now?: number;
}): Promise<BoundQuote | null> {
  if (!args.quoteId) return null;
  const { data, error } = await supa()
    .from("booking_quotes")
    .select("id,tenant_id,call_id,service_type,public_quote,rule_id,policy_epoch,expires_at")
    .eq("token_hash", opaqueTokenHash(args.quoteId))
    .maybeSingle();
  if (error || !data) return null;
  const quote = data as unknown as BoundQuote;
  if (quote.tenant_id !== args.tenantId || quote.call_id !== args.callId) return null;
  if (quote.service_type !== args.serviceType || quote.policy_epoch !== args.policyEpoch) return null;
  if (Date.parse(quote.expires_at) <= (args.now ?? Date.now())) return null;
  return quote;
}

export async function issueSlotOffers(args: {
  tenantId: string;
  callId: string;
  serviceType: string;
  geography: string;
  quote: BoundQuote;
  candidates: SlotCandidate[];
  now?: number;
}): Promise<Array<{ slot_token: string; local: string; price_usd: number }>> {
  const now = args.now ?? Date.now();
  const expiresAt = new Date(Math.min(Date.parse(args.quote.expires_at), now + SLOT_TTL_MS)).toISOString();
  const issued = args.candidates.map((candidate) => {
    const token = opaqueToken();
    return {
      token,
      row: {
        id: randomUUID(),
        token_hash: opaqueTokenHash(token),
        tenant_id: args.tenantId,
        call_id: args.callId,
        quote_id: args.quote.id,
        service_type: args.serviceType,
        slot_start: candidate.start,
        slot_end: candidate.end,
        local_display: candidate.local,
        public_quote: args.quote.public_quote,
        geography: args.geography,
        power_id: candidate.powerId,
        rule_id: args.quote.rule_id,
        policy_epoch: args.quote.policy_epoch,
        expires_at: expiresAt,
      },
    };
  });
  if (!issued.length) return [];
  const { error } = await supa().from("slot_offers").insert(issued.map(({ row }) => row));
  if (error) throw new Error(`slot_offer_issue_failed: ${error.message}`);
  return issued.map(({ token, row }) => ({
    slot_token: token,
    local: row.local_display,
    price_usd: Number(row.public_quote),
  }));
}
