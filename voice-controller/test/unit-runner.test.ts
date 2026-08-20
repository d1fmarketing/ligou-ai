import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUnitTestEnvironment, runUnitTests, unitTestFiles } from "../scripts/run-unit-tests.mjs";

test("unit runner uses only synthetic configuration and excludes live integrations", () => {
  const environment = createUnitTestEnvironment();

  expect(environment.PATH).toBe("/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin");
  expect(environment.NODE_ENV).toBe("test");
  expect(environment.OPENAI_API_KEY).toBe("synthetic-unit-test-key");
  expect(environment.SUPABASE_SECRET_KEY).toBe("synthetic-unit-test-key");
  expect(environment.SUPABASE_PUBLISHABLE_KEY).toBe("synthetic-unit-test-key");
  expect(environment.CALENDAR_PROVIDER).toBe("fake");
  expect(unitTestFiles).not.toContain("test/booking.integration.test.ts");
  expect(unitTestFiles).toContain("test/unit-runner.test.ts");
  expect(unitTestFiles).toContain("test/oauth-security.test.ts");
});

test("unit runner starts every unit file in its own Bun process", () => {
  const runs: Array<{ command: string; args: string[]; options: { env: Record<string, string | undefined> } }> = [];
  runUnitTests((command, args, options) => runs.push({ command, args, options }));

  expect(runs).toHaveLength(unitTestFiles.length);
  expect(runs.map((run) => run.command)).toEqual(Array(unitTestFiles.length).fill(process.execPath));
  expect(runs.every((run) => path.isAbsolute(run.args[1]))).toBe(true);
  expect(runs.every((run) => run.options.env.OPENAI_API_KEY === "synthetic-unit-test-key")).toBe(true);
});

test("unit runner keeps an invoker dotenv sentinel out of the actual Bun test process", () => {
  const invoker = mkdtempSync("/tmp/ligou-unit-dotenv-");
  const probe = path.join(invoker, "dotenv-probe.test.ts");
  const marker = path.join(invoker, "probe-passed");
  try {
    writeFileSync(path.join(invoker, ".env"), "LIGOU_DOTENV_SENTINEL=must-not-reach-unit-test\n");
    writeFileSync(
      probe,
      [
        'import { expect, test } from "bun:test";',
        'import { writeFileSync } from "node:fs";',
        `test("dotenv sentinel stays out", () => { expect(process.env.LIGOU_DOTENV_SENTINEL).toBeUndefined(); writeFileSync(${JSON.stringify(marker)}, "passed"); });`,
      ].join("\n"),
    );
    const runner = fileURLToPath(new URL("../scripts/run-unit-tests.mjs", import.meta.url));
    execFileSync(process.execPath, [runner, "--file", probe], {
      cwd: invoker,
      env: createUnitTestEnvironment(),
    });

    expect(existsSync(marker)).toBe(true);
  } finally {
    rmSync(invoker, { recursive: true, force: true });
  }
});
