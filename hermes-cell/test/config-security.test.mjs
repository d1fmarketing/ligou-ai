import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validator = path.join(repoRoot, "hermes-cell/validate-config.mjs");
const health = path.join(repoRoot, "hermes-cell/health-state.sh");
const tenantCompose = path.join(repoRoot, "hermes-cell/tenant-compose.mjs");
const tenantIdentity = path.join(repoRoot, "hermes-cell/tenant-identity.mjs");
const IMAGE = "docker.io/nousresearch/hermes-agent@sha256:d597ca1f766ff23ff86437fe5e0f36a6049166ce91df917d9577d7418f0767de";

test("repository Hermes config is OAuth-only with separate cognitive and model-auth volumes", () => {
  const result = spawnSync(process.execPath, [validator, "--root", repoRoot, "--json"], {
    encoding: "utf8",
    env: { ...process.env, HERMES_IMAGE: IMAGE },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    provider: "openai-codex",
    oauth_only: true,
    tenant_isolation: true,
    image: IMAGE,
    image_immutable: true,
    volumes: { cognitive: "HERMES_COGNITIVE_VOLUME", model_auth: "HERMES_MODEL_AUTH_VOLUME" },
    cognitive_backup_excludes_model_auth: true,
  });
});

test("normal tenant launcher gives two tenants isolated project, volumes, paths, backup identity, and route", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-tenant-compose-"));
  const launch = (tenant) => {
    const result = spawnSync(process.execPath, [tenantCompose, "--print-runtime"], {
      encoding: "utf8",
      env: {
        ...process.env,
        TENANT_SLUG: tenant,
        HERMES_API_KEY: "synthetic-local-key",
        HERMES_IMAGE: IMAGE,
        LIGOU_TENANT_REGISTRY: path.join(fixture, "registry.json"),
        LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const alpha = launch("alpha-plumbing");
    const beta = launch("beta-plumbing");
    for (const field of [
      "compose_project", "container_name", "cognitive_volume", "model_auth_volume", "network", "host_port",
      "hermes_url", "projected_rules_path", "backup_work_dir", "restore_work_dir", "archive_prefix",
    ]) {
      assert.notEqual(alpha[field], beta[field], `${field} must not be shared`);
    }
    assert.equal(alpha.image, IMAGE);
    assert.equal(beta.image, IMAGE);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("locked persistent registry resolves a forced preferred-port collision without sharing", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-tenant-registry-"));
  const registry = path.join(fixture, "registry.json");
  const stateRoot = path.join(fixture, "tenants");
  const resolve = (tenant) => new Promise((resolveResult) => {
    const child = spawn(process.execPath, [tenantIdentity, "--tenant", tenant, "--json"], {
      env: {
        ...process.env,
        LIGOU_TENANT_REGISTRY: registry,
        LIGOU_TENANT_STATE_ROOT: stateRoot,
        LIGOU_TENANT_PORT_BUCKETS: "4",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (status) => resolveResult({ status, stdout, stderr }));
  });
  try {
    const [alphaResult, betaResult] = await Promise.all([resolve("alpha-plumbing"), resolve("beta-plumbing")]);
    assert.equal(alphaResult.status, 0, alphaResult.stderr);
    assert.equal(betaResult.status, 0, betaResult.stderr);
    const alpha = JSON.parse(alphaResult.stdout);
    const beta = JSON.parse(betaResult.stdout);
    assert.equal(alpha.preferred_host_port, beta.preferred_host_port, "fixture tenants must exercise collision resolution");
    assert.notEqual(alpha.host_port, beta.host_port);
    const alphaAgain = await resolve("alpha-plumbing");
    assert.equal(alphaAgain.status, 0, alphaAgain.stderr);
    assert.equal(JSON.parse(alphaAgain.stdout).host_port, alpha.host_port, "assignment must persist across resolver processes");
    const stored = JSON.parse(await readFile(registry, "utf8"));
    assert.deepEqual(Object.keys(stored.tenants).sort(), ["alpha-plumbing", "beta-plumbing"]);
    await assert.rejects(readFile(`${registry}.lock`, "utf8"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("locked registry atomically activates one tenant staged cognitive volume with compare-and-swap", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-tenant-cognitive-"));
  const registry = path.join(fixture, "registry.json");
  const env = {
    ...process.env,
    LIGOU_TENANT_REGISTRY: registry,
    LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
  };
  const resolve = (tenant) => spawnSync(process.execPath, [tenantIdentity, "--tenant", tenant, "--json"], { encoding: "utf8", env });
  try {
    const alphaBefore = JSON.parse(resolve("alpha-plumbing").stdout);
    const betaBefore = JSON.parse(resolve("beta-plumbing").stdout);
    const staged = `${alphaBefore.cognitive_volume}-stage-${"a".repeat(64)}`;
    const activated = spawnSync(process.execPath, [tenantIdentity, "--tenant", "alpha-plumbing",
      "--activate-cognitive", staged, "--expected", alphaBefore.cognitive_volume, "--json"], { encoding: "utf8", env });
    assert.equal(activated.status, 0, activated.stderr);
    assert.equal(JSON.parse(activated.stdout).cognitive_volume, staged);
    assert.equal(JSON.parse(resolve("alpha-plumbing").stdout).cognitive_volume, staged);
    assert.equal(JSON.parse(resolve("beta-plumbing").stdout).cognitive_volume, betaBefore.cognitive_volume);

    const stale = spawnSync(process.execPath, [tenantIdentity, "--tenant", "alpha-plumbing",
      "--activate-cognitive", `${alphaBefore.cognitive_volume}-stage-${"b".repeat(64)}`,
      "--expected", alphaBefore.cognitive_volume, "--json"], { encoding: "utf8", env });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /tenant_cognitive_compare_failed/);
    assert.equal(JSON.parse(resolve("alpha-plumbing").stdout).cognitive_volume, staged);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("config validator rejects missing and tag-only Hermes image release inputs", () => {
  for (const image of ["", "nousresearch/hermes-agent:v2026.8.18"]) {
    const result = spawnSync(process.execPath, [validator, "--root", repoRoot, "--json"], {
      encoding: "utf8",
      env: { ...process.env, HERMES_IMAGE: image },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hermes_image_digest_required/);
  }
});

test("config validator rejects a digest that is immutable but not the approved release identity", () => {
  const result = spawnSync(process.execPath, [validator, "--root", repoRoot, "--json"], {
    encoding: "utf8",
    env: { ...process.env, HERMES_IMAGE: "example.invalid/hermes@sha256:" + "f".repeat(64) },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hermes_image_not_approved/);
});

test("normal tenant launcher rejects an unapproved immutable image before Docker", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-tenant-image-"));
  try {
    const result = spawnSync(process.execPath, [tenantCompose, "--print-runtime"], {
      encoding: "utf8",
      env: {
        ...process.env,
        TENANT_SLUG: "test-tenant",
        HERMES_API_KEY: "synthetic-local-key",
        HERMES_IMAGE: "example.invalid/hermes@sha256:" + "f".repeat(64),
        LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
        LIGOU_TENANT_REGISTRY: path.join(fixture, "tenant-registry.json"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hermes_image_not_approved/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
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
    await writeFile(path.join(fixture, "infra/toolchain.json"), JSON.stringify({ hermes_image: IMAGE }));

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
    await writeFile(docker, "#!/bin/sh\nprintf '%s\\n' \"${AUTH_PAYLOAD:-{\\\"provider\\\":\\\"openai-codex\\\",\\\"authenticated\\\":true,\\\"access_token\\\":\\\"sensitive-oauth-token\\\"}}\"\n");
    await writeFile(curl, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(curlLog)}\nprintf '%s\\n' '{"ok":true,"model":"private-model-detail"}'\n`);
    await chmod(docker, 0o755);
    await chmod(curl, 0o755);

    const result = spawnSync("bash", [health], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        TENANT_SLUG: "test-tenant",
        LIGOU_NODE_BIN: process.execPath,
        LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
        LIGOU_TENANT_REGISTRY: path.join(fixture, "tenant-registry.json"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '{"ok":true,"provider":"openai-codex","auth":"ready","api":"ready"}');
    assert.doesNotMatch(result.stdout + result.stderr, /sensitive-oauth-token|private-model-detail/);
    assert.doesNotMatch(await readFile(curlLog, "utf8"), /authorization|bearer/i);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("token-free health rejects negative and malformed auth prose", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-hermes-auth-negative-"));
  const bin = path.join(fixture, "bin");
  try {
    await mkdir(bin);
    await writeFile(path.join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' \"$AUTH_PAYLOAD\"\n");
    await writeFile(path.join(bin, "curl"), "#!/bin/sh\nprintf '%s\\n' '{\"ok\":true}'\n");
    await chmod(path.join(bin, "docker"), 0o755);
    await chmod(path.join(bin, "curl"), 0o755);
    for (const payload of [
      "not logged in",
      "logged in",
      '{"provider":"openai-codex","authenticated":false}',
      '{"provider":"other","authenticated":true}',
      '{"authenticated":true}',
      '{malformed',
    ]) {
      const result = spawnSync("bash", [health], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:/usr/bin:/bin`, TENANT_SLUG: "test-tenant", AUTH_PAYLOAD: payload,
          HERMES_HEALTH_URL: "http://127.0.0.1:28642/health", LIGOU_NODE_BIN: process.execPath,
        },
      });
      assert.notEqual(result.status, 0, payload);
      assert.match(result.stdout, /"auth":"unavailable"/);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
