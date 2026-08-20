import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanRepositoryFiles, validateEnvExamples } from "../scripts/scan-secrets.mjs";

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

test("scanner permits variable names, quoted blanks, and quoted placeholders without exposing a finding", async () => {
  const findings = await withFixture(
    {
      ".env.example": "OPENAI_API_KEY=\nSUPABASE_SECRET_KEY=\"\"\nGITHUB_TOKEN='${GITHUB_TOKEN}'\n",
      "src/config.ts": "const name = process.env.OPENAI_API_KEY;\n",
    },
    (root, files) => scanRepositoryFiles(root, files),
  );

  assert.deepEqual(findings, []);
});

test("scanner recognizes stack-relevant secret formats without printing their values", async () => {
  const githubToken = `gh${"p_"}${"g".repeat(36)}`;
  const supabaseSecret = ["sb", "secret", "s".repeat(28)].join("_");
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ1bml0LXRlc3QifQ", "signature-for-unit-test-only"].join(".");
  const pem = ["-----BEGIN ", "PRIVATE KEY-----\n", "A".repeat(64), "\n-----END PRIVATE KEY-----"].join("");
  const structuredSecret = `unit-${"value-marker"}`;

  const findings = await withFixture(
    {
      ".env": [
        "DATABASE_URL=postgres://unit:unit@database.test/unit",
        `GITHUB_TOKEN=${githubToken}`,
        `SUPABASE_SECRET_KEY=${supabaseSecret}`,
        `SUPABASE_JWT=${jwt}`,
      ].join("\n"),
      "config.yaml": `client_secret: ${structuredSecret}\nservice_role_key: ${structuredSecret}\n`,
      "config.json": JSON.stringify({ client_secret: structuredSecret, private_key: structuredSecret }),
      "service.pem": pem,
    },
    (root, files) => scanRepositoryFiles(root, files),
  );

  assert.ok(findings.some((finding) => finding.category === "named-secret-assignment"));
  assert.ok(findings.some((finding) => finding.category === "structured-secret-value"));
  assert.ok(findings.some((finding) => finding.path === "config.json"));
  assert.ok(findings.some((finding) => finding.category === "credential-shaped-token"));
  assert.ok(findings.some((finding) => finding.category === "private-key-material"));
  const serialized = JSON.stringify(findings);
  assert.doesNotMatch(serialized, /value-marker/);
  assert.doesNotMatch(serialized, /postgres:\/\/unit/);
  assert.doesNotMatch(serialized, /PRIVATE KEY/);
});

test("scanner skips tracked symlinks instead of reading external targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ligou-secret-scan-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "ligou-secret-scan-outside-"));
  try {
    const externalSecret = path.join(outside, "secret.txt");
    await writeFile(externalSecret, "OPENAI_API_KEY=unit-test-external-value\n");
    const externalDirectory = path.join(outside, "directory");
    await mkdir(externalDirectory);
    await symlink(externalSecret, path.join(root, "tracked-secret-link"));
    await symlink(externalDirectory, path.join(root, "tracked-directory-link"));

    const findings = await scanRepositoryFiles(root, ["tracked-secret-link", "tracked-directory-link"]);

    assert.deepEqual(findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("env examples require blank values and reject placeholders after quote normalization", async () => {
  const findings = await withFixture(
    {
      ".env.example": "OPENAI_API_KEY=\nSUPABASE_SECRET_KEY=\"\"\n# comment only\n",
      "dashboard/.env.example": "VITE_SUPABASE_URL=\nVITE_SUPABASE_PUBLISHABLE_KEY=\n",
    },
    (root, files) => validateEnvExamples(root, files),
  );
  assert.deepEqual(findings, []);

  const invalid = await withFixture(
    { ".env.example": "OPENAI_API_KEY=\"${OPENAI_API_KEY}\"\n" },
    (root, files) => validateEnvExamples(root, files),
  );
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].category, "env-example-nonblank-value");
  assert.doesNotMatch(JSON.stringify(invalid), /OPENAI_API_KEY}/);
});
