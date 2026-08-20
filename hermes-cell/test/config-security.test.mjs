import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validator = path.join(repoRoot, "hermes-cell/validate-config.mjs");
const health = path.join(repoRoot, "hermes-cell/health-state.sh");

test("repository Hermes config is OAuth-only with separate cognitive and model-auth volumes", () => {
  const result = spawnSync(process.execPath, [validator, "--root", repoRoot, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    provider: "openai-codex",
    oauth_only: true,
    volumes: { cognitive: "hermes-cognitive", model_auth: "hermes-model-auth" },
    cognitive_backup_excludes_model_auth: true,
  });
});

test("config validator rejects an API-key reasoning credential", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-hermes-config-"));
  try {
    await mkdir(path.join(fixture, "hermes-cell/config"), { recursive: true });
    await mkdir(path.join(fixture, "infra"), { recursive: true });
    await writeFile(path.join(fixture, "hermes-cell/docker-compose.yml"), [
      "services:", "  hermes:", "    environment:", "      OPENAI_API_KEY: unsafe",
      "    volumes:", "      - hermes-cognitive:/opt/data", "      - hermes-model-auth:/root/.hermes",
      "volumes:", "  hermes-cognitive:", "  hermes-model-auth:",
    ].join("\n"));
    await writeFile(path.join(fixture, "hermes-cell/.env.example"), "CELL_OPENAI_API_KEY=\n");
    await writeFile(path.join(fixture, "hermes-cell/config/config.yaml"), "provider: openai-codex\n");
    await writeFile(path.join(fixture, "hermes-cell/config/cli-config.yaml"), "provider: openai-codex\n");
    await writeFile(path.join(fixture, "infra/backup.sh"), "hermes backup -o /opt/data/backup.zip\n");

    const result = spawnSync(process.execPath, [validator, "--root", fixture, "--json"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reasoning_api_key_forbidden/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("token-free health wrapper returns state only and never forwards or prints OAuth material", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-hermes-health-"));
  const bin = path.join(fixture, "bin");
  const curlLog = path.join(fixture, "curl-args");
  try {
    await mkdir(bin);
    const docker = path.join(bin, "docker");
    const curl = path.join(bin, "curl");
    await writeFile(docker, "#!/bin/sh\nprintf '%s\\n' '{\"authenticated\":true,\"access_token\":\"sensitive-oauth-token\"}'\n");
    await writeFile(curl, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(curlLog)}\nprintf '%s\\n' '{"ok":true,"model":"private-model-detail"}'\n`);
    await chmod(docker, 0o755);
    await chmod(curl, 0o755);

    const result = spawnSync("bash", [health], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, TENANT_SLUG: "test-tenant" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '{"ok":true,"provider":"openai-codex","auth":"ready","api":"ready"}');
    assert.doesNotMatch(result.stdout + result.stderr, /sensitive-oauth-token|private-model-detail/);
    assert.doesNotMatch(await readFile(curlLog, "utf8"), /authorization|bearer/i);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
