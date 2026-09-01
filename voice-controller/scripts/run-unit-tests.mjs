import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syntheticPath = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";

export const unitTestFiles = [
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
  "test/onboarding-materialization.test.ts",
  "test/onboarding-store.test.ts",
  "test/onboarding-coordinator.test.ts",
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
