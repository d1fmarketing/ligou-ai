import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syntheticPath = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";

export const unitTestFiles = [
  "test/onboarding-live-protocol.test.ts",
  "test/onboarding-live-context.test.ts",
  "test/onboarding-live-responses.test.ts",
  "test/onboarding-live-runtime.test.ts",
  "test/onboarding-live-usage.test.ts",
  "test/onboarding-live-business.test.ts",
  "test/onboarding-live-routing.test.ts",
  "test/onboarding-live-probe.test.ts",
  "test/sales-provider.test.ts",
  "test/sales-sideband.test.ts",
  "test/sales-socket.test.ts",
  "test/sales-worker.test.ts",
  "test/ownership.test.ts",
  "test/migrations.test.ts",
  "test/company-discovery-migration.test.ts",
  "test/browser-session-edge.test.ts",
  "test/rules.test.ts",
  "test/booking-offers.test.ts",
  "test/booking-authority.test.ts",
  "test/booking-delivery-authority.test.ts",
  "test/budget-settlement.test.ts",
  "test/budget-sql-fixture.test.ts",
  "test/budget-reconciliation.test.ts",
  "test/sideband-settlement.test.ts",
  "test/sideband-continuation.test.ts",
  "test/phone-budget.test.ts",
  "test/phone-webhook.test.ts",
  "test/calendar-authority.test.ts",
  "test/worker-authority.test.ts",
  "test/summary-subscription.test.ts",
  "test/powers.test.ts",
  "test/timezone.test.ts",
  "test/tools.test.ts",
  "test/session-tenancy.test.ts",
  "test/simulation-flow.test.ts",
  "test/hermes-privacy.test.ts",
  "test/oauth-security.test.ts",
  "test/handoff-custody.test.ts",
  "test/calendar-test-proof.test.ts",
  "test/privacy.test.ts",
  "test/accept-call-edge.test.ts",
  "test/learning.test.ts",
  "test/skills.test.ts",
  "test/onboarding-coverage.test.ts",
  "test/company-discovery-prefill.test.ts",
  "test/onboarding-materialization.test.ts",
  "test/onboarding-store.test.ts",
  "test/onboarding-coordinator.test.ts",
  "test/onboarding-agenda.test.ts",
  "test/onboarding-agenda-seed.test.ts",
  "test/onboarding-timezone-context.test.ts",
  "test/onboarding-agenda-store.test.ts",
  "test/onboarding-interview-evidence-store.test.ts",
  "test/onboarding-agenda-coordinator.test.ts",
  "test/onboarding-speech.test.ts",
  "test/onboarding-website-bootstrap.test.ts",
  "test/onboarding-website-runtime.test.ts",
  "test/onboarding-native-session.test.ts",
  "test/onboarding-native-trace.test.ts",
  "test/onboarding-native-runtime.test.ts",
  "test/website-native-bootstrap.test.ts",
  "test/onboarding-stream.test.ts",
  "test/onboarding-website-stream-runtime.test.ts",
  "test/onboarding-website-facts.test.ts",
  "test/onboarding-website-applicability.test.ts",
  "test/onboarding-website-guidance.test.ts",
  "test/onboarding-website-summary.test.ts",
  "test/website-protocol3-bootstrap.test.ts",
  "test/website-sideband-wiring.test.ts",
  "test/website-budget-completion.test.ts",
  "test/website-foghorn-full-interview.test.ts",
  "test/unit-runner.test.ts",
];

export function createUnitTestEnvironment() {
  return {
    PATH: syntheticPath,
    TMPDIR: "/tmp",
    NODE_ENV: "test",
    OPENAI_API_KEY: "synthetic-unit-test-key",
    HERMES_API_KEY: "synthetic-unit-test-key",
    SUPABASE_URL: "https://unit-test.invalid",
    SUPABASE_SECRET_KEY: "synthetic-unit-test-key",
    SUPABASE_PUBLISHABLE_KEY: "synthetic-unit-test-key",
    GOOGLE_OAUTH_CLIENT_ID: "synthetic-unit-test-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-unit-test-key",
    CONTACT_HASH_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    CALENDAR_PROVIDER: "fake",
    LIGOU_SYNTHETIC_TEST_CALENDAR: "1",
  };
}

function absoluteTestPath(file) {
  return path.isAbsolute(file) ? file : path.join(projectRoot, file);
}

export function runUnitTests(run = execFileSync, files = unitTestFiles) {
  const isolatedCwd = mkdtempSync("/tmp/ligou-unit-test-");
  try {
    for (const file of files) {
      run(process.execPath, ["test", absoluteTestPath(file)], {
        cwd: isolatedCwd,
        stdio: "inherit",
        env: {
          ...createUnitTestEnvironment(),
          TMPDIR: isolatedCwd,
          LIGOU_TENANT_STATE_ROOT: path.join(isolatedCwd, "tenants"),
          LIGOU_TENANT_REGISTRY: path.join(isolatedCwd, "tenant-registry.json"),
        },
      });
    }
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

function cliFiles(arguments_) {
  if (arguments_.length === 0) return unitTestFiles;
  if (arguments_.length === 2 && arguments_[0] === "--file" && path.isAbsolute(arguments_[1])) {
    return [arguments_[1]];
  }
  throw new Error("usage: bun scripts/run-unit-tests.mjs [--file /absolute/path/to/test.ts]");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runUnitTests(execFileSync, cliFiles(process.argv.slice(2)));
}
