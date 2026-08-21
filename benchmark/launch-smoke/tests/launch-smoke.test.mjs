import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const smokeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suitePath = path.join(smokeRoot, "suite.json");
const reportPath = path.join(smokeRoot, "report-template.json");
const validatorUrl = pathToFileURL(path.join(smokeRoot, "validate.mjs")).href;
const controllerConfigPath = path.resolve(smokeRoot, "../../voice-controller/src/config.ts");
const businessFixturePath = path.resolve(smokeRoot, "../../docs/fixtures/rocha-plumbing.md");

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

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

test("launch smoke suite is the exact twelve launch-critical scenarios", async () => {
  const suite = await readJson(suitePath);
  assert.equal(suite.schema, "ligou.launch-smoke.v1");
  assert.deepEqual(suite.scenarios.map((scenario) => scenario.id), EXPECTED_IDS);
  assert.equal(suite.scenarios.length, 12);
  assert.deepEqual(suite.primary_candidate, {
    provider: "OpenAI",
    model: "gpt-realtime-2.1",
    voice: "ash",
    transport: "OpenAI Realtime call with authoritative WebSocket sideband",
  });
  assert.equal(suite.secondary_candidate, null);
});

test("launch smoke identity follows the current controller defaults", async () => {
  const configSource = await readFile(controllerConfigPath, "utf8");
  const suite = await readJson(suitePath);
  assert.match(configSource, /model:\s*process\.env\.LIGOU_MODEL\s*\?\?\s*"gpt-realtime-2\.1"/);
  assert.match(configSource, /voice:\s*process\.env\.LIGOU_VOICE\s*\?\?\s*"ash"/);
  assert.equal(suite.primary_candidate.model, "gpt-realtime-2.1");
  assert.equal(suite.primary_candidate.voice, "ash");
});

test("price and negotiation cases follow the canonical Rocha fixture", async () => {
  const fixture = await readFile(businessFixturePath, "utf8");
  const suite = await readJson(suitePath);
  const byId = new Map(suite.scenarios.map((scenario) => [scenario.id, scenario]));
  assert.match(fixture, /\| `drain_cleaning` \|[^\n]+\| \$149 \| \$225 \|/);
  assert.deepEqual(byId.get("LS-05-approved-price-quote").critical_entities, ["drain_cleaning", "$225"]);
  assert.match(byId.get("LS-06-negotiation-within-band").caller_script.join(" "), /\b180\b/);
  assert.match(byId.get("LS-07-below-floor-request").caller_script.join(" "), /\b80\b/);
});

test("each smoke scenario carries business truth and only launch-gate measurements", async () => {
  const suite = await readJson(suitePath);
  for (const scenario of suite.scenarios) {
    assert.ok(scenario.title);
    assert.ok(scenario.objective);
    assert.ok(Array.isArray(scenario.caller_script) && scenario.caller_script.length > 0);
    assert.ok(Array.isArray(scenario.critical_entities));
    assert.ok(Array.isArray(scenario.expected_tools));
    assert.ok(scenario.expected_outcome);
    assert.ok(Array.isArray(scenario.pass_conditions) && scenario.pass_conditions.length > 0);
    assert.ok(Array.isArray(scenario.hard_disqualifications));
    assert.deepEqual(Object.keys(scenario.measurements).sort(), [
      "approximate_cost_usd",
      "hard_disqualifications",
      "latency_ms",
      "pass_fail",
      "tool_correctness",
    ]);
    assert.equal("score" in scenario, false);
    assert.equal("weight" in scenario, false);
  }
});

test("validator rejects expansion, wrong production identity, and generalized scoring", async () => {
  const { validateLaunchSmokeSuite } = await import(validatorUrl);
  const suite = await readJson(suitePath);
  assert.equal(validateLaunchSmokeSuite(suite).scenarios, 12);

  assert.throws(
    () => validateLaunchSmokeSuite({ ...suite, scenarios: suite.scenarios.slice(0, 11) }),
    /launch_smoke_scenario_ids_invalid/,
  );
  assert.throws(
    () => validateLaunchSmokeSuite({ ...suite, primary_candidate: { ...suite.primary_candidate, voice: "marin" } }),
    /launch_smoke_primary_candidate_invalid/,
  );
  const scored = structuredClone(suite);
  scored.scenarios[0].score = 100;
  assert.throws(() => validateLaunchSmokeSuite(scored), /launch_smoke_generalized_scoring_forbidden/);
});

test("report template is honest, empty, and limited to launch decisions", async () => {
  const { validateLaunchSmokeReport } = await import(validatorUrl);
  const report = await readJson(reportPath);
  const result = validateLaunchSmokeReport(report);
  assert.deepEqual(result, { scenarios: 12, live_results: false });
  assert.equal(report.status, "NO_LIVE_RESULTS_YET");
  assert.deepEqual(report.results.map((entry) => entry.scenario_id), EXPECTED_IDS);
  for (const entry of report.results) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "approximate_cost_usd",
      "hard_disqualifications",
      "latency_ms",
      "scenario_id",
      "status",
      "tool_correctness",
    ]);
    assert.equal(entry.status, "NOT_RUN");
    assert.equal(entry.approximate_cost_usd, null);
    assert.deepEqual(entry.hard_disqualifications, []);
  }
});
