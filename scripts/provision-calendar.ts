// Product principle (RJ, 2026-08-19): the owner does NOTHING manual — the Ligou provisions everything.
// This script is that principle for calendars: the robot CREATES the tenant's calendar (it is the owner,
// explicitly authorized by RJ, superseding the earlier invited-guest model), shares it with the human as a
// courtesy, and prints the id ready for SSM. Idempotent: reuses an existing calendar with the same name.
//
// Usage: bun run scripts/provision-calendar.ts [tenant-name] [share-with-email]
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const TENANT_NAME = process.argv[2] ?? "Rocha Plumbing (Ligou)";
const SHARE_WITH = process.argv[3] ?? "";
const sa = JSON.parse(readFileSync(`${process.env.HOME}/.config/ligou/google-sa.json`, "utf8"));

const b64 = (b: any) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function token(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const c = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const s = createSign("RSA-SHA256"); s.update(`${h}.${c}`);
  const jwt = `${h}.${c}.${b64(s.sign(sa.private_key))}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  if (!r.ok) throw new Error(`token_failed: ${r.status}`);
  return ((await r.json()) as any).access_token;
}

const t = await token();
const auth = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };

// idempotency: reuse if a calendar with this name already exists
const list = (await (await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", { headers: auth })).json()) as any;
let cal = (list.items ?? []).find((c: any) => c.summary === TENANT_NAME);

if (!cal) {
  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars", {
    method: "POST", headers: auth,
    body: JSON.stringify({ summary: TENANT_NAME, timeZone: "America/Los_Angeles" }),
  });
  if (!r.ok) throw new Error(`calendar_create_failed: ${r.status} ${await r.text()}`);
  cal = await r.json();
  console.log(`calendario CRIADO: ${cal.summary}`);
} else {
  console.log(`calendario ja existia (reutilizando): ${cal.summary}`);
}

if (SHARE_WITH) {
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/acl`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ role: "writer", scope: { type: "user", value: SHARE_WITH } }),
  });
  console.log(r.ok ? `compartilhado com ${SHARE_WITH} (writer)` : `ACL falhou: ${r.status} ${await r.text()}`);
}

console.log("");
console.log("GOOGLE_CALENDAR_ID:");
console.log(cal.id);
