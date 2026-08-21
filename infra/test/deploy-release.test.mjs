import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
const IMAGE = "docker.io/nousresearch/hermes-agent@sha256:d597ca1f766ff23ff86437fe5e0f36a6049166ce91df917d9577d7418f0767de";

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
    "voice-controller/package.json": '{"name":"fixture","packageManager":"bun@1.2.13"}\n',
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
    "supabase/deno.lock": "fixture-deno-lock\n",
    "supabase/.temp/project-ref": "forbidden temp\n",
    "infra/good.sh": "#!/bin/sh\nexit 0\n",
    "infra/toolchain.json": JSON.stringify({
      node: "22.22.3", application_version: "0.1.0", bun: "1.2.13", deno: "2.9.4", supabase_cli: "2.115.0", hermes_image: IMAGE,
      dependencies: { supabase_js: "2.112.3", postgres: "3.4.9" },
    }) + "\n",
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
    "--commit", commit, "--source", "builder:unit", "--created", "2026-08-20T12:00:00.000Z",
    "--hermes-image", IMAGE], {
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
    assert.equal(body.release_id, `${repo.commit}-${body.artifact.sha256}`);
    assert.ok(body.exclusions.includes("**/._*"));
    assert.ok(body.exclusions.includes("supabase/.temp/**"));
    assert.deepEqual(body.runtime, {
      application: { version: "0.1.0" },
      node: { version: "22.22.3" },
      bun: { version: "1.2.13" },
      deno: { version: "2.9.4" },
      supabase_cli: { version: "2.115.0" },
      dependencies: {
        lockfile_path: "voice-controller/bun.lock",
        lockfile_sha256: "b636fb14b47b7d83c9f26513d1341f630f18c8960192897a73e885e4303162dc",
        evidence_scope: "lockfile-integrity-only",
        deno_lock_path: "supabase/deno.lock",
        deno_lock_sha256: "a6bdca4284f70d2bbcb73089ab1431aba2c1b94dc3b48fb6b5b3134517cb606e",
        supabase_js: "2.112.3",
        postgres: "3.4.9",
      },
      hermes: { image: IMAGE },
    });
    const verified = run(process.execPath, [manifestTool, "verify", "--artifact", artifact,
      "--manifest", manifest, "--commit", repo.commit], { env: { ...process.env, LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY } });
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release manifest fails closed when immutable Hermes image input is absent or tag-only", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-image-input-"));
  try {
    const repo = await gitFixture(fixture);
    const artifact = path.join(fixture, "release.tar.gz");
    assert.equal(run(process.execPath, [packageTool, "--root", repo.root, "--output", artifact, "--commit", repo.commit]).status, 0);
    for (const image of [undefined, "nousresearch/hermes-agent:v2026.8.18"]) {
      const args = [manifestTool, "create", "--artifact", artifact, "--manifest", `${artifact}.manifest.json`,
        "--commit", repo.commit, "--source", "builder:unit", "--created", "2026-08-20T12:00:00.000Z"];
      if (image) args.push("--hermes-image", image);
      const result = run(process.execPath, args, { env: { ...process.env, LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /release_(?:manifest_arguments_missing|hermes_image_digest_required)/);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release manifest rejects symlink, hardlink, device-like, and duplicate tar entries", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-tar-types-"));
  try {
    for (const kind of ["symlink", "hardlink", "fifo", "duplicate"]) {
      const base = path.join(fixture, kind);
      const payload = path.join(base, "payload");
      await writeTree(payload, {
        "voice-controller/package.json": '{"name":"fixture","packageManager":"bun@1.2.13"}\n',
        "voice-controller/bun.lock": "fixture-lock\n",
        "supabase/deno.lock": "fixture-deno-lock\n",
        "infra/toolchain.json": JSON.stringify({
          node: "22.22.3", application_version: "0.1.0", bun: "1.2.13", deno: "2.9.4",
          supabase_cli: "2.115.0", hermes_image: IMAGE,
          dependencies: { supabase_js: "2.112.3", postgres: "3.4.9" },
        }) + "\n",
      });
      const target = path.join(payload, "infra/toolchain.json");
      if (kind === "symlink") await symlink("toolchain.json", path.join(payload, "infra/toolchain-link"));
      if (kind === "hardlink") await link(target, path.join(payload, "infra/toolchain-hardlink"));
      if (kind === "fifo") assert.equal(run("mkfifo", [path.join(payload, "infra/device-pipe")]).status, 0);
      const artifact = path.join(base, "release.tar.gz");
      const tarArgs = kind === "duplicate"
        ? ["-czf", artifact, "-C", payload, ".", "-C", payload, "."]
        : ["-czf", artifact, "-C", payload, "."];
      assert.equal(run("tar", tarArgs).status, 0);
      const result = createReleaseManifest(artifact, `${artifact}.manifest.json`, "f".repeat(40));
      assert.notEqual(result.status, 0, kind);
      assert.match(result.stderr, /release_artifact_(?:non_regular_entry|duplicate_entry)/, kind);
    }
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
      "infra/toolchain.json": await readFile(path.join(repoRoot, "infra/toolchain.json"), "utf8"),
    });
    const result = run(process.execPath, [path.join(fixture, "hermes-cell/validate-config.mjs"), "--root", fixture, "--json"], {
      env: { ...process.env, HERMES_IMAGE: IMAGE },
    });
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
    await symlink(path.join(deployRoot, "current"), path.join(deployRoot, "app"));
    const bin = path.join(fixture, "bin");
    await mkdir(bin);
    const result = run("bash", [hostDeploy, "--artifact", artifact, "--manifest", manifest, "--commit", repo.commit], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`, LIGOU_DEPLOY_ROOT: deployRoot, LIGOU_NODE_BIN: process.execPath,
        LIGOU_DEPLOY_TEST_HARNESS: "1", LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY, HERMES_IMAGE: IMAGE,
      },
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
        HERMES_IMAGE: IMAGE,
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

async function runnableArtifact(fixture, commit, { healthScript = '#!/bin/sh\nexit "${STUB_RELEASE_HEALTH_STATUS:-0}"\n' } = {}) {
  const payload = path.join(fixture, "payload");
  await writeTree(payload, {
    "voice-controller/package.json": '{"name":"fixture","packageManager":"bun@1.2.13"}\n',
    "voice-controller/bun.lock": "fixture-lock\n",
    "hermes-cell/validate-config.mjs": "process.exit(0);\n",
    "infra/release-health.sh": healthScript,
    "infra/release-marker": "safe\n",
    "supabase/deno.lock": "fixture-deno-lock\n",
    "infra/toolchain.json": JSON.stringify({
      node: "22.22.3", application_version: "0.1.0", bun: "1.2.13", deno: "2.9.4", supabase_cli: "2.115.0", hermes_image: IMAGE,
      dependencies: { supabase_js: "2.112.3", postgres: "3.4.9" },
    }) + "\n",
  });
  await chmod(path.join(payload, "infra/release-health.sh"), 0o755);
  const artifact = path.join(fixture, "runnable.tar.gz");
  const tarred = run("tar", ["-czf", artifact, "-C", payload, "."]);
  assert.equal(tarred.status, 0, tarred.stderr);
  const manifest = `${artifact}.manifest.json`;
  assert.equal(createReleaseManifest(artifact, manifest, commit).status, 0);
  return { artifact, manifest };
}

async function prepareOldRelease(deployRoot, { healthStatus = 0 } = {}) {
  const old = path.join(deployRoot, "releases/old-release");
  await mkdir(path.join(old, "infra"), { recursive: true });
  await writeFile(path.join(old, "infra/release-health.sh"), `#!/bin/sh\nexit ${healthStatus}\n`);
  await chmod(path.join(old, "infra/release-health.sh"), 0o755);
  await writeFile(path.join(old, ".ligou-release-manifest.json"), '{"release_id":"old-release"}\n');
  await symlink(old, path.join(deployRoot, "current"));
  await symlink(path.join(deployRoot, "current"), path.join(deployRoot, "app"));
  return old;
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(file); return; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error(`timed out waiting for ${file}`);
}

test("functional health failure atomically reactivates the previous release and logs only sanitized state", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-rollback-"));
  try {
    const commit = "a".repeat(40);
    const { artifact, manifest } = await runnableArtifact(fixture, commit);
    const deployRoot = path.join(fixture, "host");
    const old = await prepareOldRelease(deployRoot);
    const bin = path.join(fixture, "bin");
    const systemctlLog = path.join(fixture, "systemctl.log");
    await mkdir(bin);
    await writeFile(path.join(bin, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\nexit 0\n");
    await writeFile(path.join(bin, "bun"), "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '%s\\n' 1.2.13; fi\nexit 0\n");
    await chmod(path.join(bin, "systemctl"), 0o755);
    await chmod(path.join(bin, "bun"), 0o755);

    const result = run("bash", [hostDeploy, "--artifact", artifact, "--manifest", manifest, "--commit", commit], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LIGOU_DEPLOY_ROOT: deployRoot,
        LIGOU_NODE_BIN: process.execPath,
        LIGOU_BUN_BIN: path.join(bin, "bun"),
        LIGOU_DEPLOY_TEST_HARNESS: "1",
        LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY,
        HERMES_IMAGE: IMAGE,
        LIGOU_SERVICE_NAME: "ligou-controller",
        STUB_RELEASE_HEALTH_STATUS: "1",
        SYSTEMCTL_LOG: systemctlLog,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release_health_failed_rollback_applied/);
    assert.equal(path.resolve(deployRoot, await readlink(path.join(deployRoot, "current"))), path.resolve(old));
    assert.equal(path.resolve(deployRoot, await readlink(path.join(deployRoot, "app"))), path.join(deployRoot, "current"));
    assert.equal((await readFile(systemctlLog, "utf8")).split("\n").filter((line) => line.includes("restart")).length, 2);
    const results = await readFile(path.join(deployRoot, "deploy-results.jsonl"), "utf8");
    assert.match(results, /"status":"rolled_back"/);
    assert.doesNotMatch(results, /synthetic|RELEASE_KEY|secret|stdout|stderr|access[_-]?token/i);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("failed rollback health is terminal rollback_failed and is never labeled rolled_back", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-rollback-failed-"));
  try {
    const commit = "b".repeat(40);
    const { artifact, manifest } = await runnableArtifact(fixture, commit);
    const deployRoot = path.join(fixture, "host");
    await prepareOldRelease(deployRoot, { healthStatus: 1 });
    const bin = path.join(fixture, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
    await writeFile(path.join(bin, "bun"), "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.2.13; fi\nexit 0\n");
    for (const command of ["systemctl", "bun"]) await chmod(path.join(bin, command), 0o755);
    const result = run("bash", [hostDeploy, "--artifact", artifact, "--manifest", manifest, "--commit", commit], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`, LIGOU_DEPLOY_ROOT: deployRoot, LIGOU_NODE_BIN: process.execPath,
        LIGOU_BUN_BIN: path.join(bin, "bun"), LIGOU_DEPLOY_TEST_HARNESS: "1", LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY,
        HERMES_IMAGE: IMAGE, STUB_RELEASE_HEALTH_STATUS: "1",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release_health_failed_rollback_failed/);
    assert.doesNotMatch(result.stderr, /rollback_applied/);
    const results = await readFile(path.join(deployRoot, "deploy-results.jsonl"), "utf8");
    assert.match(results, /"status":"rollback_failed"/);
    assert.doesNotMatch(results, /"status":"rolled_back"/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("host activation rejects a Bun version that differs from signed runtime evidence before mutation", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-bun-version-"));
  try {
    const commit = "c".repeat(40);
    const { artifact, manifest } = await runnableArtifact(fixture, commit);
    const deployRoot = path.join(fixture, "host");
    const old = await prepareOldRelease(deployRoot);
    const bin = path.join(fixture, "bin");
    const systemctlLog = path.join(fixture, "systemctl.log");
    await mkdir(bin);
    await writeFile(path.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "$SYSTEMCTL_LOG"\nexit 0\n`);
    await writeFile(path.join(bin, "bun"), "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.2.12; fi\nexit 0\n");
    for (const command of ["systemctl", "bun"]) await chmod(path.join(bin, command), 0o755);
    const result = run("bash", [hostDeploy, "--artifact", artifact, "--manifest", manifest, "--commit", commit], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`, LIGOU_DEPLOY_ROOT: deployRoot, LIGOU_NODE_BIN: process.execPath,
        LIGOU_BUN_BIN: path.join(bin, "bun"), LIGOU_DEPLOY_TEST_HARNESS: "1", LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY,
        HERMES_IMAGE: IMAGE, SYSTEMCTL_LOG: systemctlLog,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bun_runtime_mismatch/);
    assert.equal(path.resolve(deployRoot, await readlink(path.join(deployRoot, "current"))), path.resolve(old));
    await assert.rejects(readFile(systemctlLog, "utf8"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("host flock prevents a concurrent second activation from entering the mutation window", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-concurrent-"));
  const gate = path.join(fixture, "release-gate");
  let first;
  try {
    const firstDir = path.join(fixture, "first");
    const secondDir = path.join(fixture, "second");
    const marker = path.join(fixture, "health-entered");
    const waitingHealth = `#!/bin/sh\n: > "$HOLD_MARKER"\nwhile [ ! -e "$RELEASE_GATE" ]; do /bin/sleep 0.02; done\nexit 0\n`;
    const firstRelease = await runnableArtifact(firstDir, "d".repeat(40), { healthScript: waitingHealth });
    const secondRelease = await runnableArtifact(secondDir, "e".repeat(40));
    const firstId = JSON.parse(await readFile(firstRelease.manifest, "utf8")).release_id;
    const secondId = JSON.parse(await readFile(secondRelease.manifest, "utf8")).release_id;
    const deployRoot = path.join(fixture, "host");
    await prepareOldRelease(deployRoot);
    const bin = path.join(fixture, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
    await writeFile(path.join(bin, "bun"), "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.2.13; fi\nexit 0\n");
    for (const command of ["systemctl", "bun"]) await chmod(path.join(bin, command), 0o755);
    const env = {
      ...process.env, PATH: `${bin}:/usr/bin:/bin`, LIGOU_DEPLOY_ROOT: deployRoot,
      LIGOU_NODE_BIN: process.execPath, LIGOU_BUN_BIN: path.join(bin, "bun"),
      LIGOU_DEPLOY_TEST_HARNESS: "1",
      LIGOU_DEPLOY_LOCK_HELD: "1", LIGOU_DEPLOY_LOCK_FILE: path.join(fixture, "attacker-one.lock"),
      LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY, HERMES_IMAGE: IMAGE, HOLD_MARKER: marker, RELEASE_GATE: gate,
    };
    first = spawn("bash", [hostDeploy, "--artifact", firstRelease.artifact, "--manifest", firstRelease.manifest, "--commit", "d".repeat(40)], {
      env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let firstStdout = "";
    let firstStderr = "";
    first.stdout.on("data", (chunk) => { firstStdout += chunk; });
    first.stderr.on("data", (chunk) => { firstStderr += chunk; });
    await waitForFile(marker);

    const second = run("bash", [hostDeploy, "--artifact", secondRelease.artifact, "--manifest", secondRelease.manifest, "--commit", "e".repeat(40)], {
      env: { ...env, LIGOU_DEPLOY_LOCK_HELD: "different", LIGOU_DEPLOY_LOCK_FILE: path.join(fixture, "attacker-two.lock") },
    });
    assert.equal(second.status, 75);
    assert.match(second.stderr, /release_activation_locked/);
    assert.equal(path.resolve(deployRoot, await readlink(path.join(deployRoot, "current"))), path.join(deployRoot, "releases", firstId));
    assert.equal((await readdir(path.join(deployRoot, "releases"))).includes(secondId), false);

    await writeFile(gate, "continue\n");
    const firstStatus = await new Promise((resolve) => first.once("close", resolve));
    assert.equal(firstStatus, 0, firstStderr + firstStdout);
    assert.equal(
      await readFile(path.join(deployRoot, "releases", firstId, ".ligou-release-manifest.json"), "utf8"),
      await readFile(firstRelease.manifest, "utf8"),
    );
    assert.equal(path.resolve(deployRoot, await readlink(path.join(deployRoot, "app"))), path.join(deployRoot, "current"));
  } finally {
    await writeFile(gate, "continue\n").catch(() => {});
    if (first && first.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => first.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    if (first && first.exitCode === null) {
      try { process.kill(-first.pid, "SIGTERM"); } catch {}
    }
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
    await writeFile(path.join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' '{\"provider\":\"openai-codex\",\"authenticated\":true}'\n");
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "docker"), 0o755);
    const envFile = path.join(fixture, "env");
    await writeFile(envFile, [
      "SUPABASE_URL='https://unit.invalid'",
      "SUPABASE_PUBLISHABLE_KEY='synthetic-publishable'",
      "TENANT_SLUG='test-tenant'",
      "PORT='8790'",
      "HERMES_HEALTH_URL='http://127.0.0.1:28642/health'",
    ].join("\n"));
    const result = run("bash", [healthTool], {
      env: { PATH: `${bin}:/usr/bin:/bin`, LIGOU_ENV_FILE: envFile, CURL_LOG: curlLog, LIGOU_NODE_BIN: process.execPath },
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
    await writeFile(path.join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' '{\"provider\":\"openai-codex\",\"authenticated\":true}'\n");
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "docker"), 0o755);
    const envFile = path.join(fixture, "env");
    await writeFile(envFile, [
      "SUPABASE_URL='https://unit.invalid'", "SUPABASE_PUBLISHABLE_KEY='synthetic-publishable'",
      "TENANT_SLUG='test-tenant'", "PORT='8790'",
      "HERMES_HEALTH_URL='http://127.0.0.1:28642/health'",
    ].join("\n"));
    const result = run("bash", [healthTool], { env: { PATH: `${bin}:/usr/bin:/bin`, LIGOU_ENV_FILE: envFile, LIGOU_NODE_BIN: process.execPath } });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /"controller":"unavailable"/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
