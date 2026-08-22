import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERMES_ACTIONS = Object.freeze([
  "continue_standard_flow",
  "open_team_case",
  "confirm_schedule_later",
  "offer_language_choice",
  "offer_accessibility_support",
]);

export function parseHermesActionContent(value) {
  if (typeof value !== "string" || value.length > 160) return null;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "action") return null;
  const action = parsed.action;
  return typeof action === "string" && HERMES_ACTIONS.includes(action) ? action : null;
}

export function parseHermesActionResponse(value) {
  return parseHermesActionContent(value?.choices?.[0]?.message?.content);
}

const isMain = (() => {
  // Production invokes these tools through the /opt/ligou/current symlink while Node
  // resolves the main module by realpath, so compare realpaths or the CLI no-ops.
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  if (process.argv.length !== 4 || process.argv[2] !== "--response") process.exit(2);
  let action = null;
  try { action = parseHermesActionResponse(JSON.parse(readFileSync(process.argv[3], "utf8"))); } catch {}
  if (!action) process.exit(1);
  process.stdout.write(`${action}\n`);
}
