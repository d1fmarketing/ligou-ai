import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyCodexAuthStore } from "../auth-local-state.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validator = path.join(repoRoot, "hermes-cell/validate-config.mjs");
const health = path.join(repoRoot, "hermes-cell/health-state.sh");
const tenantCompose = path.join(repoRoot, "hermes-cell/tenant-compose.mjs");
const tenantIdentity = path.join(repoRoot, "hermes-cell/tenant-identity.mjs");
const authPatch = path.join(repoRoot, "hermes-cell/image/patch-auth-home.py");
const imageDockerfile = path.join(repoRoot, "hermes-cell/image/Dockerfile");
const cognitiveCopy = path.join(repoRoot, "hermes-cell/copy-cognitive-state.py");
const IMAGE = "330140023537.dkr.ecr.us-east-1.amazonaws.com/ligou/hermes-agent@sha256:7ae8423fb1a64110008e746c5571864fcd8d9e167659d48f96b9b4a5a8181f33";
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const TENANT_C = "33333333-3333-4333-8333-333333333333";

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

test("production compose routes every Hermes auth write outside cognitive state", async () => {
  const compose = await readFile(path.join(repoRoot, "hermes-cell/docker-compose.yml"), "utf8");
  assert.match(compose, /HERMES_AUTH_HOME:\s*\/opt\/model-auth/);
  assert.match(compose, /hermes-cognitive:\/opt\/data(?:\s|$)/m);
  assert.match(compose, /hermes-model-auth:\/opt\/model-auth(?:\s|$)/m);
  assert.doesNotMatch(compose, /hermes-model-auth:\/root\/\.hermes/);
});

test("derived Hermes image patches active auth, locks, fallback, login, and refresh to HERMES_AUTH_HOME", async () => {
  const [dockerfile, patcher] = await Promise.all([
    readFile(imageDockerfile, "utf8"),
    readFile(authPatch, "utf8"),
  ]);
  assert.match(dockerfile, /^ARG HERMES_BASE_IMAGE\nFROM \$\{HERMES_BASE_IMAGE\}/m);
  assert.match(dockerfile, /patch-auth-home\.py/);
  assert.match(patcher, /HERMES_AUTH_HOME/);
  assert.match(patcher, /def _auth_file_path\(\)/);
  assert.match(patcher, /global_auth_fallback/);
  assert.match(patcher, /auth_home_must_be_absolute/);
  assert.match(patcher, /auth_home_must_not_equal_hermes_home/);
});

test("local auth classifier rejects dead, exhausted, terminal, and expired Codex credentials", () => {
  const now = 1_787_360_000;
  const jwt = (exp) => `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
  const row = (overrides = {}) => ({
    auth_type: "oauth",
    access_token: jwt(now + 3600),
    refresh_token: "synthetic-refresh-token",
    last_status: "ok",
    ...overrides,
  });
  const provider = {
    tokens: { access_token: jwt(now + 3600), refresh_token: "synthetic-refresh-token" },
  };
  const store = (rows, providerState = provider) => ({
    providers: { "openai-codex": providerState },
    credential_pool: { "openai-codex": rows },
  });

  assert.equal(classifyCodexAuthStore(store([row()]), now).authenticated, true);
  assert.equal(classifyCodexAuthStore(store([row({ last_status: "dead" })]), now).authenticated, false,
    "a preserved singleton must not override a DEAD pool row");
  assert.equal(classifyCodexAuthStore(store([row({ last_status: "exhausted", last_error_code: 401 })]), now).authenticated, false);
  assert.equal(classifyCodexAuthStore(store([row({ access_token: jwt(now - 1) })]), now).authenticated, false);
  assert.equal(classifyCodexAuthStore(store([], {
    ...provider,
    last_auth_error: { relogin_required: true },
  }), now).authenticated, false);
  assert.equal(classifyCodexAuthStore(store([], provider), now).authenticated, true,
    "an unexpired singleton is allowed only when the pool is absent");
  assert.equal(classifyCodexAuthStore({}, now).authenticated, false);
});

test("legacy cognitive copy is hash-verified and excludes auth, snapshots, backups, caches, and links", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-cognitive-copy-"));
  const source = path.join(fixture, "source");
  const destination = path.join(fixture, "destination");
  try {
    for (const relative of ["memories", "skills/demo", "sessions", "state-snapshots/old", "home/.cache/wheels", "backups"]) {
      await mkdir(path.join(source, relative), { recursive: true });
    }
    await mkdir(destination);
    await writeFile(path.join(source, "memories/MEMORY.md"), "memory\n");
    await writeFile(path.join(source, "skills/demo/SKILL.md"), "skill\n");
    await writeFile(path.join(source, "sessions/session.json"), "{}\n");
    await writeFile(path.join(source, "state.db"), "synthetic-state\n");
    await writeFile(path.join(source, "auth.json"), '{"refresh_token":"forbidden"}\n');
    await writeFile(path.join(source, "state-snapshots/old/auth.json"), "forbidden\n");
    await writeFile(path.join(source, "backups/old.zip"), "forbidden\n");
    await symlink("../../memories", path.join(source, "home/.cache/wheels/cached"));
    await writeFile(path.join(destination, "stale.txt"), "remove\n");
    const result = spawnSync("python3", [cognitiveCopy, "--source", source, "--destination", destination], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.ok, true);
    assert.deepEqual(proof.required, { memories: 1, sessions: 1, skills: 1 });
    assert.equal(await readFile(path.join(destination, "memories/MEMORY.md"), "utf8"), "memory\n");
    await assert.rejects(readFile(path.join(destination, "auth.json"), "utf8"));
    await assert.rejects(readFile(path.join(destination, "stale.txt"), "utf8"));
    await assert.rejects(readFile(path.join(destination, "state-snapshots/old/auth.json"), "utf8"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("normal tenant launcher gives two tenants isolated project, volumes, paths, backup identity, and route", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-tenant-compose-"));
  const launch = (tenantId, tenantSlug) => {
    const result = spawnSync(process.execPath, [tenantCompose, "--print-runtime"], {
      encoding: "utf8",
      env: {
        ...process.env,
        TENANT_ID: tenantId,
        TENANT_SLUG: tenantSlug,
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
    const alpha = launch(TENANT_A, "alpha-plumbing");
    const beta = launch(TENANT_B, "beta-plumbing");
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
  const resolve = (tenantId, tenantSlug) => new Promise((resolveResult) => {
    const child = spawn(process.execPath, [tenantIdentity, "--tenant-id", tenantId, "--tenant-slug", tenantSlug, "--json"], {
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
    const [alphaResult, betaResult] = await Promise.all([resolve(TENANT_A, "alpha-plumbing"), resolve(TENANT_C, "gamma-plumbing")]);
    assert.equal(alphaResult.status, 0, alphaResult.stderr);
    assert.equal(betaResult.status, 0, betaResult.stderr);
    const alpha = JSON.parse(alphaResult.stdout);
    const beta = JSON.parse(betaResult.stdout);
    assert.equal(alpha.preferred_host_port, beta.preferred_host_port, "fixture tenants must exercise collision resolution");
    assert.notEqual(alpha.host_port, beta.host_port);
    const alphaAgain = await resolve(TENANT_A, "alpha-plumbing");
    assert.equal(alphaAgain.status, 0, alphaAgain.stderr);
    assert.equal(JSON.parse(alphaAgain.stdout).host_port, alpha.host_port, "assignment must persist across resolver processes");
    const stored = JSON.parse(await readFile(registry, "utf8"));
    assert.deepEqual(Object.keys(stored.tenants).sort(), [TENANT_A, TENANT_C]);
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
  const resolve = (tenantId, tenantSlug) => spawnSync(process.execPath, [tenantIdentity,
    "--tenant-id", tenantId, "--tenant-slug", tenantSlug, "--json"], { encoding: "utf8", env });
  try {
    const alphaBefore = JSON.parse(resolve(TENANT_A, "alpha-plumbing").stdout);
    const betaBefore = JSON.parse(resolve(TENANT_B, "beta-plumbing").stdout);
    const staged = `${alphaBefore.cognitive_volume}-stage-${"a".repeat(64)}`;
    const activated = spawnSync(process.execPath, [tenantIdentity, "--tenant-id", TENANT_A, "--tenant-slug", "alpha-plumbing",
      "--activate-cognitive", staged, "--expected", alphaBefore.cognitive_volume, "--json"], { encoding: "utf8", env });
    assert.equal(activated.status, 0, activated.stderr);
    assert.equal(JSON.parse(activated.stdout).cognitive_volume, staged);
    assert.equal(JSON.parse(resolve(TENANT_A, "alpha-plumbing").stdout).cognitive_volume, staged);
    assert.equal(JSON.parse(resolve(TENANT_B, "beta-plumbing").stdout).cognitive_volume, betaBefore.cognitive_volume);

    const stale = spawnSync(process.execPath, [tenantIdentity, "--tenant-id", TENANT_A, "--tenant-slug", "alpha-plumbing",
      "--activate-cognitive", `${alphaBefore.cognitive_volume}-stage-${"b".repeat(64)}`,
      "--expected", alphaBefore.cognitive_volume, "--json"], { encoding: "utf8", env });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /tenant_cognitive_compare_failed/);
    assert.equal(JSON.parse(resolve(TENANT_A, "alpha-plumbing").stdout).cognitive_volume, staged);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("immutable tenant UUID owns every resource while display slug must match exactly", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-tenant-uuid-"));
  const env = {
    ...process.env,
    LIGOU_TENANT_REGISTRY: path.join(fixture, "registry.json"),
    LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
  };
  const resolve = (id, slug) => spawnSync(process.execPath, [tenantIdentity,
    "--tenant-id", id, "--tenant-slug", slug, "--json"], { encoding: "utf8", env });
  try {
    const valid = resolve(TENANT_A, "shared-slug");
    assert.equal(valid.status, 0, valid.stderr);
    const identity = JSON.parse(valid.stdout);
    assert.equal(identity.tenant_id, TENANT_A);
    assert.equal(identity.tenant_slug, "shared-slug");
    for (const field of [
      "compose_project", "container_name", "cognitive_volume", "model_auth_volume", "network",
      "tenant_root", "projected_rules_path", "backup_work_dir", "restore_work_dir", "archive_prefix",
    ]) {
      assert.match(identity[field], new RegExp(TENANT_A));
      assert.doesNotMatch(identity[field], /shared-slug/);
    }

    const reusedSlug = resolve(TENANT_B, "shared-slug");
    assert.notEqual(reusedSlug.status, 0);
    assert.match(reusedSlug.stderr, /tenant_slug_reused/);
    const changedSlug = resolve(TENANT_A, "changed-slug");
    assert.notEqual(changedSlug.status, 0);
    assert.match(changedSlug.stderr, /tenant_slug_mismatch/);
    const stored = JSON.parse(await readFile(env.LIGOU_TENANT_REGISTRY, "utf8"));
    assert.deepEqual(Object.keys(stored.tenants), [TENANT_A]);
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
        TENANT_ID: TENANT_A,
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

test("tenant launcher pulls a missing private ECR digest with ephemeral IAM login and logs out", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-tenant-ecr-"));
  const bin = path.join(fixture, "bin");
  const commandLog = path.join(fixture, "commands.log");
  const pulled = path.join(fixture, "pulled");
  try {
    await mkdir(bin);
    await writeFile(path.join(bin, "aws"), "#!/bin/sh\nprintf '%s\\n' 'synthetic-ecr-password-never-log'\n");
    await writeFile(path.join(bin, "docker"), `#!/bin/sh
printf '%s\n' "$*" >> "$COMMAND_LOG"
case "$1 $2" in
  'image inspect') [ -e "$PULLED_MARKER" ] ;;
  'login --username') IFS= read -r secret; [ -n "$secret" ]; printf '%s\n' 'login_input_present=true' >> "$COMMAND_LOG" ;;
  'pull ${IMAGE}') : > "$PULLED_MARKER" ;;
  'logout 330140023537.dkr.ecr.us-east-1.amazonaws.com') : ;;
  'compose --project-name') : ;;
  *) exit 91 ;;
esac
`);
    await chmod(path.join(bin, "aws"), 0o755);
    await chmod(path.join(bin, "docker"), 0o755);
    const result = spawnSync(process.execPath, [tenantCompose, "config"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        TENANT_ID: TENANT_A,
        TENANT_SLUG: "ecr-test",
        HERMES_API_KEY: "synthetic-local-key",
        HERMES_IMAGE: IMAGE,
        LIGOU_TENANT_REGISTRY: path.join(fixture, "registry.json"),
        LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
        COMMAND_LOG: commandLog,
        PULLED_MARKER: pulled,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const log = await readFile(commandLog, "utf8");
    assert.match(log, /image inspect .*@sha256:/);
    assert.match(log, /login --username AWS --password-stdin 330140023537\.dkr\.ecr\.us-east-1\.amazonaws\.com/);
    assert.match(log, /login_input_present=true/);
    assert.match(log, /pull 330140023537\.dkr\.ecr\.us-east-1\.amazonaws\.com\/ligou\/hermes-agent@sha256:/);
    assert.match(log, /logout 330140023537\.dkr\.ecr\.us-east-1\.amazonaws\.com/);
    assert.doesNotMatch(result.stdout + result.stderr + log, /synthetic-ecr-password-never-log/);
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
  const healthSource = await readFile(health, "utf8");
  assert.match(healthSource, /ligou_auth_local_state/);
  assert.match(healthSource, /auth-local-state\.mjs/);
  assert.doesNotMatch(healthSource, /hermes auth status openai-codex --json/);
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-hermes-health-"));
  const bin = path.join(fixture, "bin");
  const curlLog = path.join(fixture, "curl-args");
  try {
    await mkdir(bin);
    const docker = path.join(bin, "docker");
    const curl = path.join(bin, "curl");
    await writeFile(docker, `#!/bin/sh\ncase "$*" in\n  *'inspect --format {{json .}}'*) printf '%s\\n' '{"Name":"/ligou-cell-${TENANT_A}","Config":{"Image":"${IMAGE}"},"Image":"sha256:${"a".repeat(64)}","State":{"Running":true}}' ;;\n  *'image inspect --format {{json .RepoDigests}}'*) printf '%s\\n' '["${IMAGE}"]' ;;\n  *'auth status openai-codex'*) printf '%s\\n' "\${AUTH_PAYLOAD:-{\\\"provider\\\":\\\"openai-codex\\\",\\\"authenticated\\\":true,\\\"access_token\\\":\\\"sensitive-oauth-token\\\"}}" ;;\nesac\n`);
    await writeFile(curl, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(curlLog)}\nprintf '%s\\n' '{"ok":true,"model":"private-model-detail"}'\n`);
    await chmod(docker, 0o755);
    await chmod(curl, 0o755);

    const result = spawnSync("bash", [health], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        TENANT_SLUG: "test-tenant", TENANT_ID: TENANT_A,
        HERMES_IMAGE: IMAGE,
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
    await writeFile(path.join(bin, "docker"), `#!/bin/sh\ncase "$*" in\n  *'inspect --format {{json .}}'*) printf '%s\\n' '{"Name":"/ligou-cell-${TENANT_A}","Config":{"Image":"${IMAGE}"},"Image":"sha256:${"a".repeat(64)}","State":{"Running":true}}' ;;\n  *'image inspect --format {{json .RepoDigests}}'*) printf '%s\\n' '["${IMAGE}"]' ;;\n  *'auth status openai-codex'*) printf '%s\\n' "$AUTH_PAYLOAD" ;;\nesac\n`);
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
          PATH: `${bin}:/usr/bin:/bin`, TENANT_ID: TENANT_A, TENANT_SLUG: "test-tenant", AUTH_PAYLOAD: payload,
          HERMES_IMAGE: IMAGE, LIGOU_NODE_BIN: process.execPath,
          LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
          LIGOU_TENANT_REGISTRY: path.join(fixture, "tenant-registry.json"),
        },
      });
      assert.notEqual(result.status, 0, payload);
      assert.match(result.stdout, /"auth":"unavailable"/);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("tenant health rejects route overrides, nested success text, and running image mismatches", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-hermes-health-binding-"));
  const bin = path.join(fixture, "bin");
  const curlLog = path.join(fixture, "curl.log");
  try {
    await mkdir(bin);
    const writeDocker = async (repoDigest) => {
      await writeFile(path.join(bin, "docker"), `#!/bin/sh\ncase "$*" in\n  *'inspect --format {{json .}}'*) printf '%s\\n' '{"Name":"/ligou-cell-${TENANT_A}","Config":{"Image":"${IMAGE}"},"Image":"sha256:${"a".repeat(64)}","State":{"Running":true}}' ;;\n  *'image inspect --format {{json .RepoDigests}}'*) printf '%s\\n' '["${repoDigest}"]' ;;\n  *'auth status openai-codex'*) printf '%s\\n' '{"provider":"openai-codex","authenticated":true}' ;;\nesac\n`);
      await chmod(path.join(bin, "docker"), 0o755);
    };
    await writeDocker(IMAGE);
    await writeFile(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_LOG"\nprintf '%s\\n' "$API_PAYLOAD"\n`);
    await chmod(path.join(bin, "curl"), 0o755);
    const identity = {
      PATH: `${bin}:/usr/bin:/bin`, TENANT_ID: TENANT_A, TENANT_SLUG: "test-tenant",
      HERMES_IMAGE: IMAGE, LIGOU_NODE_BIN: process.execPath,
      LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
      LIGOU_TENANT_REGISTRY: path.join(fixture, "tenant-registry.json"),
      CURL_LOG: curlLog,
      API_PAYLOAD: JSON.stringify({ ok: true }),
    };

    const override = spawnSync("bash", [health], {
      encoding: "utf8", env: { ...identity, HERMES_HEALTH_URL: "https://attacker.invalid/health" },
    });
    assert.notEqual(override.status, 0);
    assert.match(override.stdout + override.stderr, /health_route_mismatch/);

    const nested = spawnSync("bash", [health], {
      encoding: "utf8", env: { ...identity, API_PAYLOAD: JSON.stringify({ nested: { ok: true } }) },
    });
    assert.notEqual(nested.status, 0);
    assert.match(nested.stdout, /"api":"unavailable"/);

    await writeDocker(`example.invalid/hermes@sha256:${"f".repeat(64)}`);
    const mismatch = spawnSync("bash", [health], { encoding: "utf8", env: identity });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stdout + mismatch.stderr, /running_image_mismatch/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
