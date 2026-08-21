import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_IDS = [
  "LS-01-normal-service-inquiry",
  "LS-02-accented-noisy-english",
  "LS-03-phone-number-correction",
  "LS-04-address-spelling",
  "LS-05-approved-price-quote",
  "LS-06-negotiation-within-band",
  "LS-07-below-floor-request",
  "LS-08-calendar-availability",
  "LS-09-authoritative-booking",
  "LS-10-barge-in",
  "LS-11-active-gas-emergency",
  "LS-12-prompt-tool-manipulation",
];

const PRIMARY = {
  provider: "OpenAI",
  model: "gpt-realtime-2.1",
  voice: "ash",
  transport: "OpenAI Realtime call with authoritative WebSocket sideband",
};

const MEASUREMENT_KEYS = [
  "approximate_cost_usd",
  "hard_disqualifications",
  "latency_ms",
  "pass_fail",
  "tool_correctness",
];

const RESULT_KEYS = [
  "approximate_cost_usd",
  "hard_disqualifications",
  "latency_ms",
  "scenario_id",
  "status",
  "tool_correctness",
];

function sameKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === expected.join("\u0000");
}

function fail(code) {
  throw new Error(code);
}

export function validateLaunchSmokeSuite(suite) {
  if (!suite || suite.schema !== "ligou.launch-smoke.v1" || suite.suite_version !== "1.0.0") {
    fail("launch_smoke_schema_invalid");
  }
  if (JSON.stringify(suite.primary_candidate) !== JSON.stringify(PRIMARY) || suite.secondary_candidate !== null) {
    fail("launch_smoke_primary_candidate_invalid");
  }
  if (!Array.isArray(suite.scenarios)
    || JSON.stringify(suite.scenarios.map((scenario) => scenario?.id)) !== JSON.stringify(EXPECTED_IDS)) {
    fail("launch_smoke_scenario_ids_invalid");
  }
  for (const scenario of suite.scenarios) {
    if (Object.hasOwn(scenario, "score") || Object.hasOwn(scenario, "weight")) {
      fail("launch_smoke_generalized_scoring_forbidden");
    }
    if (!scenario.title || !scenario.objective
      || !Array.isArray(scenario.caller_script) || scenario.caller_script.length < 1
      || !Array.isArray(scenario.critical_entities)
      || !Array.isArray(scenario.expected_tools)
      || !scenario.expected_outcome
      || !Array.isArray(scenario.pass_conditions) || scenario.pass_conditions.length < 1
      || !Array.isArray(scenario.hard_disqualifications)
      || !sameKeys(scenario.measurements, MEASUREMENT_KEYS)) {
      fail("launch_smoke_scenario_invalid");
    }
  }
  return { scenarios: suite.scenarios.length, primary_candidate: "OpenAI:gpt-realtime-2.1:ash" };
}

export function validateLaunchSmokeReport(report) {
  if (!report || report.schema !== "ligou.launch-smoke.report.v1"
    || report.status !== "NO_LIVE_RESULTS_YET"
    || report.primary_candidate !== "OpenAI:gpt-realtime-2.1:ash"
    || !Array.isArray(report.results)
    || JSON.stringify(report.results.map((entry) => entry?.scenario_id)) !== JSON.stringify(EXPECTED_IDS)) {
    fail("launch_smoke_report_invalid");
  }
  for (const entry of report.results) {
    if (!sameKeys(entry, RESULT_KEYS) || entry.status !== "NOT_RUN"
      || entry.tool_correctness !== null || entry.latency_ms !== null
      || entry.approximate_cost_usd !== null
      || !Array.isArray(entry.hard_disqualifications) || entry.hard_disqualifications.length !== 0) {
      fail("launch_smoke_report_result_invalid");
    }
  }
  return { scenarios: report.results.length, live_results: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const suite = JSON.parse(readFileSync(path.join(root, "suite.json"), "utf8"));
  const report = JSON.parse(readFileSync(path.join(root, "report-template.json"), "utf8"));
  process.stdout.write(JSON.stringify({
    status: "READY_FOR_CONTROLLED_LAUNCH_SMOKE",
    ...validateLaunchSmokeSuite(suite),
    report: validateLaunchSmokeReport(report),
  }) + "\n");
}
