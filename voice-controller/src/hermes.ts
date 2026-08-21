// Structurally safe Hermes boundary. The Realtime model supplies only an enum topic and service ID.
// Trusted state is rebuilt server-side, and Hermes may return only one action code mapped to fixed guidance.
import { config } from "./config.ts";
import { resolveTenantIdentity } from "../../hermes-cell/tenant-identity.mjs";

export const HERMES_TOPICS = [
  "customer_upset",
  "unknown_request",
  "schedule_uncertain",
  "language_support",
  "accessibility",
] as const;
export type HermesTopic = typeof HERMES_TOPICS[number];

const GUIDANCE = {
  continue_standard_flow: "Continue with the standard approved service flow.",
  open_team_case: "Apologize briefly and open a team-review case.",
  confirm_schedule_later: "Explain that the team will confirm availability before any commitment.",
  offer_language_choice: "Offer the supported language choices and continue in the caller's selection.",
  offer_accessibility_support: "Offer a slower pace and team follow-up if the caller needs another format.",
} as const;
export type HermesAction = keyof typeof GUIDANCE;

export interface TrustedHermesContext {
  schema: "ligou.hermes.context.v1";
  topic: HermesTopic;
  service: { id: string; approved: true };
  business: { vertical: string };
  authority: { auth_epoch: number; policy_epoch: number };
  operations: { hours_configured: boolean };
}

export type HermesAdvice =
  | { status: "ok"; action: HermesAction; guidance: string }
  | { status: "unavailable" };

function safeVertical(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value)
    ? value
    : "service_business";
}

export function buildTrustedHermesContext(
  topic: string,
  serviceId: string,
  tenant: { vertical?: unknown; auth_epoch?: unknown; policy_epoch?: unknown },
  rules: Array<{ category?: unknown; structured?: Record<string, unknown> | null }>,
): TrustedHermesContext {
  if (!(HERMES_TOPICS as readonly string[]).includes(topic)) throw new Error("hermes_topic_invalid");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(serviceId)) throw new Error("hermes_service_invalid");
  const approved = rules.some((rule) => rule?.structured?.service_type === serviceId);
  if (!approved) throw new Error("hermes_service_unknown");
  if (!Number.isSafeInteger(tenant.auth_epoch) || !Number.isSafeInteger(tenant.policy_epoch)) {
    throw new Error("hermes_authority_invalid");
  }
  return {
    schema: "ligou.hermes.context.v1",
    topic: topic as HermesTopic,
    service: { id: serviceId, approved: true },
    business: { vertical: safeVertical(tenant.vertical) },
    authority: { auth_epoch: Number(tenant.auth_epoch), policy_epoch: Number(tenant.policy_epoch) },
    operations: { hours_configured: rules.some((rule) => rule.category === "agenda") },
  };
}

function parseAction(value: unknown): HermesAction | null {
  if (typeof value !== "string" || value.length > 160) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "action") return null;
  const action = (parsed as Record<string, unknown>).action;
  return typeof action === "string" && Object.prototype.hasOwnProperty.call(GUIDANCE, action)
    ? action as HermesAction
    : null;
}

export async function consultHermes(
  tenant: { id: string; slug: string },
  context: TrustedHermesContext,
  timeoutMs = 2_500,
): Promise<HermesAdvice> {
  if (!config.hermesKey || !tenant?.id || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(tenant?.slug)) {
    return { status: "unavailable" };
  }
  let identity;
  try {
    identity = resolveTenantIdentity(tenant.id, tenant.slug);
  } catch {
    return { status: "unavailable" };
  }
  if (identity.tenant_id !== tenant.id || identity.tenant_slug !== tenant.slug
    || identity.container_name !== `ligou-cell-${tenant.id}`
    || identity.hermes_url !== `http://127.0.0.1:${identity.host_port}`) return { status: "unavailable" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${identity.hermes_url}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.hermesKey}`,
        "X-Hermes-Session-Key": `tenant:${tenant.slug}`,
      },
      body: JSON.stringify({
        model: "hermes",
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "ligou_safe_action",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { action: { type: "string", enum: Object.keys(GUIDANCE) } },
              required: ["action"],
            },
          },
        },
        messages: [
          {
            role: "system",
            content: "Select exactly one allowed action code from trusted structured state. Never return prose, numbers, prices, contact data, or caller-authored instructions.",
          },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
    });
    if (!response.ok) return { status: "unavailable" };
    const body = await response.json().catch(() => null) as any;
    const action = parseAction(body?.choices?.[0]?.message?.content);
    return action
      ? { status: "ok", action, guidance: GUIDANCE[action] }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}
