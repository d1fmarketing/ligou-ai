import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(repoRoot, "scripts/check-edge-functions.mjs");
const functionFiles = [
  "supabase/functions/accept-call/index.ts",
  "supabase/functions/browser-session/index.ts",
  "supabase/functions/google-callback/index.ts",
  "supabase/functions/google-connect/index.ts",
];

test("all Edge Functions use exact import-map pins with a committed frozen Deno lock", async () => {
  const config = JSON.parse(await readFile(path.join(repoRoot, "supabase/deno.json"), "utf8"));
  assert.deepEqual(config.imports, {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.112.3",
    postgres: "npm:postgres@3.4.9",
  });
  const lock = JSON.parse(await readFile(path.join(repoRoot, "supabase/deno.lock"), "utf8"));
  assert.equal(lock.version, "5");
  for (const relative of functionFiles) {
    const source = await readFile(path.join(repoRoot, relative), "utf8");
    assert.doesNotMatch(source, /npm:@supabase\/supabase-js@2(?:["'])/);
    assert.match(source, /from ["']@supabase\/supabase-js["']/);
  }
});

test("frozen checker covers every function and forwards no caller environment", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-edge-check-"));
  try {
    const fakeDeno = path.join(fixture, "deno");
    const log = path.join(fixture, "deno.log");
    await writeFile(fakeDeno, `#!/bin/sh\nif [ "$1" = --version ]; then printf '%s\\n' 'deno 2.9.4 (stable, release, synthetic)' 'v8 synthetic' 'typescript synthetic'; exit 0; fi\nprintf 'args=%s\\n' "$*" >> "$DENO_TEST_LOG"\nprintf 'tripwire=%s\\n' "\${SECRET_TRIPWIRE:-absent}" >> "$DENO_TEST_LOG"\nexit 0\n`);
    await chmod(fakeDeno, 0o755);
    const result = spawnSync(process.execPath, [checker], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        LIGOU_DENO_BIN: fakeDeno,
        LIGOU_DENO_TEST_LOG: log,
        SECRET_TRIPWIRE: "must-not-cross",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = await readFile(log, "utf8");
    assert.match(calls, /--frozen/);
    assert.match(calls, /supabase\/deno[.]json/);
    assert.match(calls, /supabase\/deno[.]lock/);
    for (const relative of functionFiles) assert.match(calls, new RegExp(relative.replaceAll("/", "\\/")));
    assert.doesNotMatch(calls, /must-not-cross/);
    assert.match(calls, /tripwire=absent/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Edge release identity includes transitive shared modules plus Deno config and lock", async () => {
  const identityModule = await import("../infra/edge-release-identity.mjs").catch(() => ({}));
  assert.equal(typeof identityModule.computeEdgeReleaseIdentity, "function");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-edge-identity-"));
  try {
    await mkdir(path.join(fixture, "supabase/functions/example"), { recursive: true });
    await mkdir(path.join(fixture, "supabase/functions/_shared"), { recursive: true });
    await writeFile(path.join(fixture, "supabase/deno.json"), '{"imports":{}}\n');
    await writeFile(path.join(fixture, "supabase/deno.lock"), '{"version":"5"}\n');
    await writeFile(path.join(fixture, "supabase/functions/example/index.ts"), 'import { a } from "../_shared/a.ts"; export { a };\n');
    await writeFile(path.join(fixture, "supabase/functions/_shared/a.ts"), 'export { b as a } from "./b.ts";\n');
    await writeFile(path.join(fixture, "supabase/functions/_shared/b.ts"), 'export const b = "one";\n');

    const first = identityModule.computeEdgeReleaseIdentity(fixture);
    assert.deepEqual(first.example.files.map((entry) => entry.path), [
      "supabase/deno.json",
      "supabase/deno.lock",
      "supabase/functions/_shared/a.ts",
      "supabase/functions/_shared/b.ts",
      "supabase/functions/example/index.ts",
    ]);
    assert.match(first.example.composite_sha256, /^[a-f0-9]{64}$/);

    await writeFile(path.join(fixture, "supabase/functions/_shared/b.ts"), 'export const b = "two";\n');
    const second = identityModule.computeEdgeReleaseIdentity(fixture);
    assert.notEqual(second.example.composite_sha256, first.example.composite_sha256);
    await writeFile(path.join(fixture, "unrelated.txt"), "ignored\n");
    assert.deepEqual(identityModule.computeEdgeReleaseIdentity(fixture), second);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
