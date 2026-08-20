import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const unitTestFiles = [
  "test/powers.test.ts",
  "test/timezone.test.ts",
  "test/tools.test.ts",
  "test/learning.test.ts",
  "test/skills.test.ts",
  "test/unit-runner.test.ts",
];

export function createUnitTestEnvironment(parent = process.env) {
  return {
    PATH: parent.PATH,
    TMPDIR: parent.TMPDIR,
    NODE_ENV: "test",
    OPENAI_API_KEY: "synthetic-unit-test-key",
    HERMES_API_KEY: "synthetic-unit-test-key",
    SUPABASE_URL: "https://unit-test.invalid",
    SUPABASE_SECRET_KEY: "synthetic-unit-test-key",
    SUPABASE_PUBLISHABLE_KEY: "synthetic-unit-test-key",
    GOOGLE_OAUTH_CLIENT_ID: "synthetic-unit-test-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-unit-test-key",
    GOOGLE_REFRESH_TOKEN: "synthetic-unit-test-token",
  };
}

export function runUnitTests(run = execFileSync) {
  for (const file of unitTestFiles) {
    run("bun", ["test", file], {
      stdio: "inherit",
      env: createUnitTestEnvironment(),
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runUnitTests();
}
