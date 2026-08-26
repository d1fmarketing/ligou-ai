// Structurally safe Hermes boundary. The Realtime model supplies only an enum topic and service ID.
// Trusted state is rebuilt server-side, and Hermes may return only one action code mapped to fixed guidance.
import { readFileSync } from "node:fs";
import { config } from "./config.ts";
import { HERMES_ACTIONS, parseHermesActionContent } from "../../hermes-cell/action-contract.mjs";
import { resolveTenantIdentity } from "../../hermes-cell/tenant-identity.mjs";
import {
  hasV2DomainRule,
  operationalRuleByMaterializationKey,
  servicePolicies,
  type Rule,
} from "./rules.ts";

const HERMES_ACTION_SYSTEM_PROMPT = readFileSync(
  new URL("../../hermes-cell/config/action-system-prompt.txt", import.meta.url),
  "utf8",
).trim();

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
  rules: Rule[],
): TrustedHermesContext {
  if (!(HERMES_TOPICS as readonly string[]).includes(topic)) throw new Error("hermes_topic_invalid");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(serviceId)) throw new Error("hermes_service_invalid");
  const approved = servicePolicies(rules).some(
    (policy) => policy.service_type === serviceId,
  );
  if (!approved) throw new Error("hermes_service_unknown");
  if (!Number.isSafeInteger(tenant.auth_epoch) || !Number.isSafeInteger(tenant.policy_epoch)) {
    throw new Error("hermes_authority_invalid");
  }
  const hasV2Schedule = hasV2DomainRule(rules, "domain:schedule");
  const resolvedSchedule = operationalRuleByMaterializationKey(
    rules,
    "domain:schedule",
    "agenda",
  );
  const hoursConfigured = hasV2Schedule
    ? resolvedSchedule?.structured?.schema === "ligou.rule.schedule.v2"
    : rules.some((rule) =>
        rule.category === "agenda" &&
        typeof rule.text === "string" &&
        rule.text.trim().length > 0 &&
        rule.structured?.schema !== "ligou.rule.schedule.v2"
      );
  return {
    schema: "ligou.hermes.context.v1",
    topic: topic as HermesTopic,
    service: { id: serviceId, approved: true },
    business: { vertical: safeVertical(tenant.vertical) },
    authority: { auth_epoch: Number(tenant.auth_epoch), policy_epoch: Number(tenant.policy_epoch) },
    operations: { hours_configured: hoursConfigured },
  };
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
              properties: { action: { type: "string", enum: HERMES_ACTIONS } },
              required: ["action"],
            },
          },
        },
        messages: [
          {
            role: "system",
            content: HERMES_ACTION_SYSTEM_PROMPT,
          },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
    });
    if (!response.ok) return { status: "unavailable" };
    const body = await response.json().catch(() => null) as any;
    const parsedAction = parseHermesActionContent(body?.choices?.[0]?.message?.content);
    const action = parsedAction && Object.prototype.hasOwnProperty.call(GUIDANCE, parsedAction)
      ? parsedAction as HermesAction
      : null;
    return action
      ? { status: "ok", action, guidance: GUIDANCE[action] }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}
