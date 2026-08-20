import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageTool = path.join(repoRoot, "infra/package-release.mjs");
const manifestTool = path.join(repoRoot, "infra/release-manifest.mjs");
const hostDeploy = path.join(repoRoot, "infra/deploy-host.sh");
const healthTool = path.join(repoRoot, "infra/release-health.sh");
const deployScript = path.join(repoRoot, "infra/deploy.sh");
const RELEASE_KEY = "Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=";

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

async function writeTree(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

async function gitFixture(base) {
  const root = path.join(base, "repo");
  await mkdir(root);
  await writeTree(root, {
    "voice-controller/src/good.ts": "export const good = true;\n",
    "voice-controller/package.json": '{"name":"fixture"}\n',
    "voice-controller/bun.lock": "fixture-lock\n",
    "voice-controller/node_modules/dep.js": "forbidden dependency\n",
    "voice-controller/dist/bundle.js": "forbidden build\n",
    "voice-controller/.env.production": "SECRET=forbidden\n",
    "voice-controller/._sidecar": "forbidden apple double\n",
    "voice-controller/private-backup.zip": "forbidden archive\n",
    "hermes-cell/config/config.yaml": "model:\n  provider: openai-codex\n",
    "hermes-cell/config/cli-config.yaml": "model:\n  provider: openai-codex\n",
    "hermes-cell/docker-compose.yml": "services: {}\n",
    "supabase/functions/good/index.ts": "export {};\n",
    "supabase/.temp/project-ref": "forbidden temp\n",
    "infra/good.sh": "#!/bin/sh\nexit 0\n",
    "infra/._deploy": "forbidden apple double\n",
  });
  assert.equal(run("git", ["init", "-q"], { cwd: root }).status, 0);
  assert.equal(run("git", ["add", "-f", "."], { cwd: root }).status, 0);
  assert.equal(run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root }).status, 0);
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
  return { root, commit };
}

function createReleaseManifest(artifact, manifest, commit) {
  return run(process.execPath, [manifestTool, "create", "--artifact", artifact, "--manifest", manifest,
    "--commit", commit, "--source", "builder:unit", "--created", "2026-08-20T12:00:00.000Z"], {
    env: { ...process.env, LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY, LIGOU_RELEASE_MANIFEST_KEY_ID: "release-test-v1" },
  });
}

test("packaging exact commit excludes contamination and emits a signed immutable release manifest", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-package-"));
  try {
    const repo = await gitFixture(fixture);
    const artifact = path.join(fixture, "release.tar.gz");
    const packaged = run(process.execPath, [packageTool, "--root", repo.root, "--output", artifact, "--commit", repo.commit]);
    assert.equal(packaged.status, 0, packaged.stderr);
    const entriesResult = run("tar", ["-tzf", artifact]);
    assert.equal(entriesResult.status, 0, entriesResult.stderr);
    const entries = entriesResult.stdout.split("\n").filter(Boolean);
    assert.ok(entries.includes("voice-controller/src/good.ts"));
    assert.ok(entries.includes("supabase/functions/good/index.ts"));
    assert.doesNotMatch(entries.join("\n"), /(?:^|\/)\._|(?:^|\/)\.env|node_modules|(?:^|\/)dist\/|supabase\/\.temp|private-backup[.]zip/);

    const manifest = `${artifact}.manifest.json`;
    const created = createReleaseManifest(artifact, manifest, repo.commit);
    assert.equal(created.status, 0, created.stderr);
    const body = JSON.parse(await readFile(manifest, "utf8"));
    assert.equal(body.commit_sha, repo.commit);
    assert.match(body.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(body.artifact.name, "release.tar.gz");
    assert.match(body.release_id, new RegExp(`^${repo.commit.slice(0, 12)}-[a-f0-9]{12}$`));
    assert.ok(body.exclusions.includes("**/._*"));
    assert.ok(body.exclusions.includes("supabase/.temp/**"));
    const verified = run(process.execPath, [manifestTool, "verify", "--artifact", artifact,
      "--manifest", manifest, "--commit", repo.commit], { env: { ...process.env, LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY } });
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("packaged Hermes validator accepts the intentional .env example exclusion", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-validator-"));
  try {
    await writeTree(fixture, {
      "hermes-cell/validate-config.mjs": await readFile(path.join(repoRoot, "hermes-cell/validate-config.mjs"), "utf8"),
      "hermes-cell/docker-compose.yml": await readFile(path.join(repoRoot, "hermes-cell/docker-compose.yml"), "utf8"),
      "hermes-cell/config/config.yaml": await readFile(path.join(repoRoot, "hermes-cell/config/config.yaml"), "utf8"),
      "hermes-cell/config/cli-config.yaml": await readFile(path.join(repoRoot, "hermes-cell/config/cli-config.yaml"), "utf8"),
      "infra/backup.sh": await readFile(path.join(repoRoot, "infra/backup.sh"), "utf8"),
    });
    const result = run(process.execPath, [path.join(fixture, "hermes-cell/validate-config.mjs"), "--root", fixture, "--json"]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("host rejects artifact hash mismatch before extraction or activation", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-hash-"));
  try {
    const repo = await gitFixture(fixture);
    const artifact = path.join(fixture, "release.tar.gz");
    assert.equal(run(process.execPath, [packageTool, "--root", repo.root, "--output", artifact, "--commit", repo.commit]).status, 0);
    const manifest = `${artifact}.manifest.json`;
    assert.equal(createReleaseManifest(artifact, manifest, repo.commit).status, 0);
    await writeFile(artifact, "tampered", { flag: "a" });

    const deployRoot = path.join(fixture, "host");
    const old = path.join(deployRoot, "releases/old-release");
    await mkdir(old, { recursive: true });
    await symlink(old, path.join(deployRoot, "current"));
    await symlink(old, path.join(deployRoot, "app"));
    const result = run("bash", [hostDeploy, "--artifact", artifact, "--manifest", manifest, "--commit", repo.commit], {
      env: { PATH: "/usr/bin:/bin", LIGOU_DEPLOY_ROOT: deployRoot, LIGOU_NODE_BIN: process.execPath, LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release_verification_failed/);
    assert.equal(path.resolve(deployRoot, await readlink(path.join(deployRoot, "current"))), path.resolve(old));
    assert.equal((await readdir(path.join(deployRoot, "releases"))).includes("old-release"), true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("deploy wrapper packages one clean commit, uploads artifact+manifest, and dispatches hash-bound host activation", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-deploy-wrapper-"));
  let linkedWorktree = "";
  try {
    const repo = await gitFixture(fixture);
    linkedWorktree = path.join(fixture, "linked-worktree");
    assert.equal(run("git", ["worktree", "add", "--detach", linkedWorktree, repo.commit], { cwd: repo.root }).status, 0);
    const bin = path.join(fixture, "bin");
    const awsLog = path.join(fixture, "aws.log");
    const work = path.join(fixture, "work");
    await mkdir(bin);
    await mkdir(work);
    await writeFile(path.join(bin, "aws"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$AWS_LOG"\ncase "$*" in\n  *'StandardOutputContent'*) printf '%s\\n' '{"ok":true,"status":"activated"}' ;;\n  *'--query Status'*) printf '%s\\n' 'Success' ;;\n  *'ssm send-command'*) printf '%s\\n' 'cmd-test' ;;\nesac\nexit 0\n`);
    await writeFile(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    for (const command of ["aws", "sleep"]) await chmod(path.join(bin, command), 0o755);

    const result = run("bash", [deployScript], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        AWS_LOG: awsLog,
        LIGOU_AWS_REGION: "us-east-1",
        LIGOU_INSTANCE_ID: "i-0123456789abcdef0",
        LIGOU_DEPLOY_BUCKET: "unit-deploys",
        LIGOU_DEPLOY_SOURCE_ID: "builder:unit",
        LIGOU_DEPLOY_SOURCE_ROOT: linkedWorktree,
        LIGOU_DEPLOY_WORK_DIR: work,
        LIGOU_NODE_BIN: process.execPath,
        LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY,
        LIGOU_RELEASE_MANIFEST_KEY_ID: "release-test-v1",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const log = await readFile(awsLog, "utf8");
    assert.equal(log.split("\n").filter((line) => line.startsWith("s3 cp ")).length, 2);
    assert.match(log, /release[.]tar[.]gz[.]manifest[.]json/);
    assert.match(log, /ssm send-command/);
    assert.match(log, new RegExp(repo.commit));
    assert.match(log, /[a-f0-9]{64}/);
    assert.doesNotMatch(log + result.stdout + result.stderr, /OPENAI_API_KEY|SUPABASE_SECRET|LIGOU_RELEASE_MANIFEST_KEY=/);
  } finally {
    if (linkedWorktree) run("git", ["worktree", "remove", "--force", linkedWorktree], { cwd: path.join(fixture, "repo") });
    await rm(fixture, { recursive: true, force: true });
  }
});

async function runnableArtifact(fixture, commit) {
  const payload = path.join(fixture, "payload");
  await writeTree(payload, {
    "voice-controller/package.json": '{"name":"fixture"}\n',
    "voice-controller/bun.lock": "fixture-lock\n",
    "hermes-cell/validate-config.mjs": "process.exit(0);\n",
    "infra/release-health.sh": '#!/bin/sh\nexit "${STUB_RELEASE_HEALTH_STATUS:-0}"\n',
    "infra/release-marker": "safe\n",
  });
  await chmod(path.join(payload, "infra/release-health.sh"), 0o755);
  const artifact = path.join(fixture, "runnable.tar.gz");
  const tarred = run("tar", ["-czf", artifact, "-C", payload, "."]);
  assert.equal(tarred.status, 0, tarred.stderr);
  const manifest = `${artifact}.manifest.json`;
  assert.equal(createReleaseManifest(artifact, manifest, commit).status, 0);
  return { artifact, manifest };
}

test("functional health failure atomically reactivates the previous release and logs only sanitized state", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-rollback-"));
  try {
    const commit = "a".repeat(40);
    const { artifact, manifest } = await runnableArtifact(fixture, commit);
    const deployRoot = path.join(fixture, "host");
    const old = path.join(deployRoot, "releases/old-release");
    await mkdir(old, { recursive: true });
    await symlink(old, path.join(deployRoot, "current"));
    await symlink(old, path.join(deployRoot, "app"));
    const bin = path.join(fixture, "bin");
    const systemctlLog = path.join(fixture, "systemctl.log");
    await mkdir(bin);
    await writeFile(path.join(bin, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\nexit 0\n");
    await writeFile(path.join(bin, "bun"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, "systemctl"), 0o755);
    await chmod(path.join(bin, "bun"), 0o755);

    const result = run("bash", [hostDeploy, "--artifact", artifact, "--manifest", manifest, "--commit", commit], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LIGOU_DEPLOY_ROOT: deployRoot,
        LIGOU_NODE_BIN: process.execPath,
        LIGOU_BUN_BIN: path.join(bin, "bun"),
        LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY,
        LIGOU_SERVICE_NAME: "ligou-controller",
        STUB_RELEASE_HEALTH_STATUS: "1",
        SYSTEMCTL_LOG: systemctlLog,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release_health_failed_rollback_applied/);
    assert.equal(path.resolve(deployRoot, await readlink(path.join(deployRoot, "current"))), path.resolve(old));
    assert.equal(path.resolve(deployRoot, await readlink(path.join(deployRoot, "app"))), path.resolve(old));
    assert.equal((await readFile(systemctlLog, "utf8")).split("\n").filter((line) => line.includes("restart")).length, 2);
    const results = await readFile(path.join(deployRoot, "deploy-results.jsonl"), "utf8");
    assert.match(results, /"status":"rolled_back"/);
    assert.doesNotMatch(results, /synthetic|RELEASE_KEY|secret|stdout|stderr|access[_-]?token/i);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release health performs controller, safe Supabase read, and token-free Hermes checks with state-only output", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-health-"));
  try {
    const bin = path.join(fixture, "bin");
    const curlLog = path.join(fixture, "curl.log");
    await mkdir(bin);
    await writeFile(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_LOG"\ncase "$*" in\n  *'127.0.0.1:8790/health'*) printf '%s\\n' '{"ok":true,"openai":true}' ;;\n  *'/rest/v1/tenants'*) printf '%s\\n' '[]' ;;\n  *) printf '%s\\n' '{"ok":true}' ;;\nesac\n`);
    await writeFile(path.join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' '{\"authenticated\":true}'\n");
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "docker"), 0o755);
    const envFile = path.join(fixture, "env");
    await writeFile(envFile, [
      "SUPABASE_URL='https://unit.invalid'",
      "SUPABASE_PUBLISHABLE_KEY='synthetic-publishable'",
      "TENANT_SLUG='test-tenant'",
      "PORT='8790'",
    ].join("\n"));
    const result = run("bash", [healthTool], {
      env: { PATH: `${bin}:/usr/bin:/bin`, LIGOU_ENV_FILE: envFile, CURL_LOG: curlLog },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '{"ok":true,"controller":"ready","supabase":"ready","hermes":"ready"}');
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-publishable|unit[.]invalid|test-tenant/);
    const calls = await readFile(curlLog, "utf8");
    assert.match(calls, /127[.]0[.]0[.]1:8790\/health/);
    assert.match(calls, /https:\/\/unit[.]invalid\/rest\/v1\/tenants/);
    assert.doesNotMatch(calls, /Authorization:/i);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release health rejects a controller that is up without its voice credential", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-controller-key-"));
  try {
    const bin = path.join(fixture, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "curl"), `#!/bin/sh\ncase "$*" in\n  *'127.0.0.1:8790/health'*) printf '%s\\n' '{"ok":true,"openai":false}' ;;\n  *'/rest/v1/tenants'*) printf '%s\\n' '[]' ;;\n  *) printf '%s\\n' '{"ok":true}' ;;\nesac\n`);
    await writeFile(path.join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' '{\"authenticated\":true}'\n");
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "docker"), 0o755);
    const envFile = path.join(fixture, "env");
    await writeFile(envFile, [
      "SUPABASE_URL='https://unit.invalid'", "SUPABASE_PUBLISHABLE_KEY='synthetic-publishable'",
      "TENANT_SLUG='test-tenant'", "PORT='8790'",
    ].join("\n"));
    const result = run("bash", [healthTool], { env: { PATH: `${bin}:/usr/bin:/bin`, LIGOU_ENV_FILE: envFile } });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /"controller":"unavailable"/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
