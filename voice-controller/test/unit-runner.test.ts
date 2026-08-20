import { expect, test } from "bun:test";
import { createUnitTestEnvironment, runUnitTests, unitTestFiles } from "../scripts/run-unit-tests.mjs";

test("unit runner uses only synthetic configuration and excludes live integrations", () => {
  const environment = createUnitTestEnvironment({
    PATH: "/usr/bin:/bin",
    OPENAI_API_KEY: "not-a-real-parent-value",
    SUPABASE_SECRET_KEY: "not-a-real-parent-value",
  });

  expect(environment.PATH).toBe("/usr/bin:/bin");
  expect(environment.NODE_ENV).toBe("test");
  expect(environment.OPENAI_API_KEY).toBe("synthetic-unit-test-key");
  expect(environment.SUPABASE_SECRET_KEY).toBe("synthetic-unit-test-key");
  expect(environment.SUPABASE_PUBLISHABLE_KEY).toBe("synthetic-unit-test-key");
  expect(unitTestFiles).not.toContain("test/booking.integration.test.ts");
  expect(unitTestFiles).toContain("test/unit-runner.test.ts");
});

test("unit runner starts every unit file in its own Bun process", () => {
  const runs: Array<{ command: string; args: string[]; options: { env: Record<string, string | undefined> } }> = [];
  runUnitTests((command, args, options) => runs.push({ command, args, options }));

  expect(runs).toHaveLength(unitTestFiles.length);
  expect(runs.map((run) => run.command)).toEqual(Array(unitTestFiles.length).fill("bun"));
  expect(runs.map((run) => run.args)).toEqual(unitTestFiles.map((file) => ["test", file]));
  expect(runs.every((run) => run.options.env.OPENAI_API_KEY === "synthetic-unit-test-key")).toBe(true);
});
