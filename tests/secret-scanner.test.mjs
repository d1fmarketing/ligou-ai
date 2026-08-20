import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanRepositoryFiles } from "../scripts/scan-secrets.mjs";

async function withFixture(files, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ligou-secret-scan-"));
  try {
    await Promise.all(
      Object.entries(files).map(async ([name, contents]) => {
        const target = path.join(root, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
      }),
    );
    return await run(root, Object.keys(files));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("scanner reports a masked finding for a credential-shaped tracked file", async () => {
  const findings = await withFixture(
    { ".env": "OPENAI_API_KEY=unit-test-token-not-a-real-secret\n" },
    (root, files) => scanRepositoryFiles(root, files),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, ".env");
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].category, "named-secret-assignment");
  assert.match(findings[0].fingerprint, /^sha256:[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(findings), /unit-test-token-not-a-real-secret/);
});

test("scanner permits variable names, placeholders, and ordinary repository content", async () => {
  const findings = await withFixture(
    {
      ".env.example": "OPENAI_API_KEY=\nSUPABASE_SECRET_KEY=${SUPABASE_SECRET_KEY}\n",
      "src/config.ts": "const name = process.env.OPENAI_API_KEY;\n",
    },
    (root, files) => scanRepositoryFiles(root, files),
  );

  assert.deepEqual(findings, []);
});
