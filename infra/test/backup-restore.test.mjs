import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestTool = path.join(repoRoot, "infra/backup-manifest.mjs");
const archiveTool = path.join(repoRoot, "infra/archive-safety.mjs");
const restoreScript = path.join(repoRoot, "infra/restore.sh");
const backupScript = path.join(repoRoot, "infra/backup.sh");
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const TENANT = "11111111-1111-4111-8111-111111111111";
const TENANT_SLUG = "test-tenant";
const IMAGE = "docker.io/nousresearch/hermes-agent@sha256:d597ca1f766ff23ff86437fe5e0f36a6049166ce91df917d9577d7418f0767de";

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

async function makeArchive(base, { forbidden = false, corruptSqlite = false } = {}) {
  const payload = path.join(base, "payload");
  const cognitive = path.join(payload, "cognitive");
  await mkdir(path.join(cognitive, "memory"), { recursive: true });
  await mkdir(path.join(cognitive, "skills"), { recursive: true });
  await mkdir(path.join(cognitive, "sessions"), { recursive: true });
  const database = path.join(cognitive, "state.db");
  if (corruptSqlite) await writeFile(database, "not-a-sqlite-database");
  else {
    const created = run("sqlite3", [database, "create table state (id integer primary key, value text); insert into state(value) values ('synthetic');"]);
    assert.equal(created.status, 0, created.stderr);
  }
  await writeFile(path.join(cognitive, "memory/index.json"), "[]");
  await writeFile(path.join(cognitive, "skills/index.json"), "[]");
  await writeFile(path.join(cognitive, "sessions/index.json"), "[]");
  if (forbidden) {
    await mkdir(path.join(cognitive, ".hermes"), { recursive: true });
    await writeFile(path.join(cognitive, ".hermes/auth.json"), '{"access_token":"forbidden"}');
  }
  const archive = path.join(base, "hermes-test-tenant-20260820T120000Z.zip");
  const zipped = run("zip", ["-qr", archive, "."], { cwd: payload });
  assert.equal(zipped.status, 0, zipped.stderr);
  return archive;
}

function createManifest(archive, manifest, extraEnv = {}) {
  return run(process.execPath, [manifestTool, "create", "--archive", archive, "--manifest", manifest,
    "--tenant", TENANT, "--source", "ec2:i-test", "--created", "2026-08-20T12:00:00.000Z",
    "--hermes-image", IMAGE], {
    env: { ...process.env, LIGOU_BACKUP_MANIFEST_KEY: KEY, LIGOU_BACKUP_MANIFEST_KEY_ID: "test-v1", ...extraEnv },
  });
}

test("authenticated manifest carries mandatory identity, archive proof, exclusions, and creation time", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-manifest-"));
  try {
    const archive = await makeArchive(fixture);
    const manifest = `${archive}.manifest.json`;
    const created = createManifest(archive, manifest);
    assert.equal(created.status, 0, created.stderr);
    const parsed = JSON.parse(await readFile(manifest, "utf8"));
    assert.deepEqual({ schema: parsed.schema, version: parsed.version, tenant: parsed.tenant }, {
      schema: "ligou.hermes.backup-manifest", version: 3, tenant: TENANT,
    });
    assert.equal(parsed.source.identity, "ec2:i-test");
    assert.equal(parsed.archive.name, path.basename(archive));
    assert.match(parsed.archive.sha256, /^[a-f0-9]{64}$/);
    assert.ok(parsed.archive.size_bytes > 0);
    assert.equal(parsed.archive.format, "hermes-cognitive-zip");
    assert.ok(parsed.archive.expanded_size_bytes > 0);
    assert.ok(parsed.archive.file_count >= 4);
    assert.deepEqual(parsed.limits, { max_files: 10_000, max_file_bytes: 67_108_864, max_expanded_bytes: 536_870_912 });
    assert.deepEqual(parsed.runtime, {
      application_version: "0.1.0",
      cognitive_schema_version: "v1",
      hermes_image: IMAGE,
    });
    assert.equal(parsed.archive.cognitive_root, "cognitive/");
    assert.equal(parsed.archive.id, parsed.archive.sha256);
    assert.ok(parsed.files.some((file) => file.path === "cognitive/state.db" && file.size_bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.equal(parsed.files.length, parsed.archive.file_count);
    assert.ok(parsed.exclusions.includes("**/.hermes/**"));
    assert.equal(parsed.created_at, "2026-08-20T12:00:00.000Z");
    assert.deepEqual(Object.keys(parsed.signature).sort(), ["algorithm", "key_id", "value"]);
    assert.doesNotMatch(JSON.stringify(parsed), new RegExp(KEY));

    const verified = run(process.execPath, [manifestTool, "verify", "--archive", archive,
      "--manifest", manifest, "--tenant", TENANT, "--hermes-image", IMAGE], {
      env: { ...process.env, LIGOU_BACKUP_MANIFEST_KEY: KEY },
    });
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("corrupt cognitive SQLite state is rejected before a manifest can be signed", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-corrupt-sqlite-"));
  try {
    const archive = await makeArchive(fixture, { corruptSqlite: true });
    const result = createManifest(archive, `${archive}.manifest.json`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive_sqlite_integrity_failed/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("archive with an unexpected top-level root is rejected", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-root-"));
  try {
    const database = path.join(fixture, "state.db");
    assert.equal(run("sqlite3", [database, "create table state(id integer);"]).status, 0);
    const archive = path.join(fixture, "hermes-test-tenant-20260820T120000Z.zip");
    assert.equal(run("zip", ["-q", archive, "state.db"], { cwd: fixture }).status, 0);
    const result = createManifest(archive, `${archive}.manifest.json`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive_cognitive_root_required/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("backup manifest rejects an immutable but unapproved Hermes image identity", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-image-identity-"));
  try {
    const archive = await makeArchive(fixture);
    const result = run(process.execPath, [manifestTool, "create", "--archive", archive,
      "--manifest", `${archive}.manifest.json`, "--tenant", TENANT, "--source", "ec2:i-test",
      "--created", "2026-08-20T12:00:00.000Z", "--hermes-image", `example.invalid/hermes@sha256:${"f".repeat(64)}`], {
      env: { ...process.env, LIGOU_BACKUP_MANIFEST_KEY: KEY },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hermes_image_not_approved/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("missing/tampered manifest and tampered archive are rejected before restore commands", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-tamper-"));
  try {
    const archive = await makeArchive(fixture);
    const manifest = `${archive}.manifest.json`;
    assert.equal(createManifest(archive, manifest).status, 0);

    const missing = run("bash", [restoreScript, "--archive", archive, "--manifest", `${manifest}.missing`], {
      env: {
        PATH: "/usr/bin:/bin", TENANT_ID: TENANT, TENANT_SLUG, HERMES_IMAGE: IMAGE,
        LIGOU_BACKUP_MANIFEST_KEY: KEY, LIGOU_NODE_BIN: process.execPath,
        LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
        LIGOU_TENANT_REGISTRY: path.join(fixture, "tenant-registry.json"),
      },
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /manifest_required/);

    const parsed = JSON.parse(await readFile(manifest, "utf8"));
    parsed.source.identity = "ec2:attacker";
    await writeFile(manifest, `${JSON.stringify(parsed)}\n`);
    const badSignature = run(process.execPath, [manifestTool, "verify", "--archive", archive,
      "--manifest", manifest, "--tenant", TENANT, "--hermes-image", IMAGE], { env: { ...process.env, LIGOU_BACKUP_MANIFEST_KEY: KEY } });
    assert.notEqual(badSignature.status, 0);
    assert.match(badSignature.stderr, /manifest_signature_invalid/);

    assert.equal(createManifest(archive, manifest).status, 0);
    const keyIdTamper = JSON.parse(await readFile(manifest, "utf8"));
    keyIdTamper.signature.key_id = "attacker-key";
    await writeFile(manifest, `${JSON.stringify(keyIdTamper)}\n`);
    const badKeyId = run(process.execPath, [manifestTool, "verify", "--archive", archive,
      "--manifest", manifest, "--tenant", TENANT, "--hermes-image", IMAGE], { env: { ...process.env, LIGOU_BACKUP_MANIFEST_KEY: KEY } });
    assert.notEqual(badKeyId.status, 0);
    assert.match(badKeyId.stderr, /manifest_signature_invalid/);

    assert.equal(createManifest(archive, manifest).status, 0);
    await writeFile(archive, "tamper", { flag: "a" });
    const badArchive = run(process.execPath, [manifestTool, "verify", "--archive", archive,
      "--manifest", manifest, "--tenant", TENANT, "--hermes-image", IMAGE], { env: { ...process.env, LIGOU_BACKUP_MANIFEST_KEY: KEY } });
    assert.notEqual(badArchive.status, 0);
    assert.match(badArchive.stderr, /archive_(?:size|checksum)_mismatch/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("real zip symlinks with unsafe targets are rejected as non-regular entries", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-symlink-"));
  try {
    const payload = path.join(fixture, "payload");
    await mkdir(path.join(payload, "cognitive/memory"), { recursive: true });
    assert.equal(run("sqlite3", [path.join(payload, "cognitive/state.db"), "create table state(id integer);"]).status, 0);
    await writeFile(path.join(payload, "cognitive/memory/state.json"), "{}\n");
    await symlink("../../../outside-secret", path.join(payload, "cognitive/memory/current"));
    const archive = path.join(fixture, "hermes-test-tenant-20260820T120000Z.zip");
    const zipped = run("zip", ["-qry", archive, "."], { cwd: payload });
    assert.equal(zipped.status, 0, zipped.stderr);
    const result = createManifest(archive, `${archive}.manifest.json`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive_non_regular_entry|archive_unsafe_link_target/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("real archive expanded file count is bounded before signing", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-file-limit-"));
  try {
    const payload = path.join(fixture, "payload");
    await mkdir(path.join(payload, "cognitive"), { recursive: true });
    assert.equal(run("sqlite3", [path.join(payload, "cognitive/state.db"), "create table state(id integer);"]).status, 0);
    for (let index = 0; index < 4; index += 1) await writeFile(path.join(payload, `cognitive/state-${index}.json`), "{}\n");
    const archive = path.join(fixture, "hermes-test-tenant-20260820T120000Z.zip");
    const zipped = run("zip", ["-qr", archive, "cognitive"], { cwd: payload });
    assert.equal(zipped.status, 0, zipped.stderr);
    const result = createManifest(archive, `${archive}.manifest.json`, { LIGOU_ARCHIVE_MAX_FILES: "3" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive_file_limit_exceeded/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("real archive expanded bytes are bounded before signing", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-size-limit-"));
  try {
    const payload = path.join(fixture, "payload");
    await mkdir(path.join(payload, "cognitive"), { recursive: true });
    assert.equal(run("sqlite3", [path.join(payload, "cognitive/state.db"), "create table state(id integer);"]).status, 0);
    await writeFile(path.join(payload, "cognitive/state.json"), "12345678");
    const archive = path.join(fixture, "hermes-test-tenant-20260820T120000Z.zip");
    const zipped = run("zip", ["-qr", archive, "cognitive"], { cwd: payload });
    assert.equal(zipped.status, 0, zipped.stderr);
    const result = createManifest(archive, `${archive}.manifest.json`, { LIGOU_ARCHIVE_MAX_EXPANDED_BYTES: "7" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive_expanded_size_limit_exceeded/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("real archive enforces the 64 MiB per-file containment limit", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-per-file-limit-"));
  try {
    const payload = path.join(fixture, "payload");
    await mkdir(path.join(payload, "cognitive"), { recursive: true });
    assert.equal(run("sqlite3", [path.join(payload, "cognitive/state.db"), "create table state(id integer);"]).status, 0);
    await writeFile(path.join(payload, "cognitive/oversize.bin"), "12345678");
    const archive = path.join(fixture, "hermes-test-tenant-20260820T120000Z.zip");
    assert.equal(run("zip", ["-qr", archive, "cognitive"], { cwd: payload }).status, 0);
    const result = createManifest(archive, `${archive}.manifest.json`, { LIGOU_ARCHIVE_MAX_FILE_BYTES: "7" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive_file_size_limit_exceeded/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("extracted filesystem lstat and realpath scan rejects a link escape before import", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-extracted-link-"));
  try {
    const payload = path.join(fixture, "payload");
    const bin = path.join(fixture, "bin");
    await mkdir(path.join(payload, "cognitive"), { recursive: true });
    await mkdir(bin);
    assert.equal(run("sqlite3", [path.join(payload, "cognitive/state.db"), "create table state(id integer);"]).status, 0);
    const archive = path.join(fixture, "hermes-test-tenant-20260820T120000Z.zip");
    const zipped = run("zip", ["-qr", archive, "cognitive"], { cwd: payload });
    assert.equal(zipped.status, 0, zipped.stderr);
    await writeFile(path.join(bin, "unzip"), "#!/bin/sh\n/bin/mkdir -p \"$4/cognitive\"\n/bin/ln -s /etc/hosts \"$4/cognitive/state.db\"\n");
    await chmod(path.join(bin, "unzip"), 0o755);
    const result = run(process.execPath, [archiveTool, "extract", archive, path.join(fixture, "extracted")], {
      env: { ...process.env, PATH: "/usr/bin:/bin", LIGOU_ARCHIVE_EXTRACT_BIN: path.join(bin, "unzip") },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive_extracted_(?:path_escape|entry_invalid)/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("backup creation rejects credential and model-auth paths", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-forbidden-"));
  try {
    const archive = await makeArchive(fixture, { forbidden: true });
    const result = createManifest(archive, `${archive}.manifest.json`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive_forbidden_path/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("backup script creates and uploads only the cognitive archive plus authenticated manifest", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-backup-script-"));
  try {
    const sourceArchive = await makeArchive(fixture);
    const bin = path.join(fixture, "bin");
    const legacySharedWork = path.join(fixture, "shared-work");
    const stateRoot = path.join(fixture, "tenants");
    const work = path.join(stateRoot, TENANT, "backups");
    const registry = path.join(fixture, "tenant-registry.json");
    const dockerLog = path.join(fixture, "docker.log");
    const awsLog = path.join(fixture, "aws.log");
    await mkdir(bin);
    await mkdir(legacySharedWork);
    const docker = path.join(bin, "docker");
    const aws = path.join(bin, "aws");
    await writeFile(docker, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\nif [ "$1" = inspect ]; then printf '%s\\n' true; exit 0; fi\nif [ "$1" = ps ]; then printf '%s\\n' 'ligou-cell-test-tenant'; exit 0; fi\nif [ "$1" = cp ]; then cp "$STUB_ARCHIVE" "$3"; exit 0; fi\nexit 0\n`);
    await writeFile(aws, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$AWS_LOG\"\nexit 0\n");
    await chmod(docker, 0o755);
    await chmod(aws, 0o755);

    const result = run("bash", [backupScript], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        TENANT_ID: TENANT,
        TENANT_SLUG,
        LIGOU_BACKUP_BUCKET: "unit-backups",
        LIGOU_BACKUP_SOURCE_ID: "ec2:i-test",
        LIGOU_BACKUP_MANIFEST_KEY: KEY,
        LIGOU_BACKUP_MANIFEST_KEY_ID: "test-v1",
        HERMES_IMAGE: IMAGE,
        LIGOU_BACKUP_WORK_DIR: legacySharedWork,
        LIGOU_TENANT_STATE_ROOT: stateRoot,
        LIGOU_TENANT_REGISTRY: registry,
        LIGOU_NODE_BIN: process.execPath,
        DOCKER_LOG: dockerLog,
        AWS_LOG: awsLog,
        STUB_ARCHIVE: sourceArchive,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const names = (await readdir(work)).sort();
    assert.deepEqual(await readdir(legacySharedWork), [], "legacy shared work override must not receive tenant backups");
    assert.equal(names.filter((name) => name.endsWith(".zip")).length, 1);
    assert.equal(names.filter((name) => name.endsWith(".manifest.json")).length, 1);
    assert.equal(names.some((name) => name.endsWith(".sha256")), false);
    const archive = path.join(work, names.find((name) => name.endsWith(".zip")));
    const manifest = path.join(work, names.find((name) => name.endsWith(".manifest.json")));
    const verified = run(process.execPath, [manifestTool, "verify", "--archive", archive,
      "--manifest", manifest, "--tenant", TENANT, "--hermes-image", IMAGE], { env: { ...process.env, LIGOU_BACKUP_MANIFEST_KEY: KEY } });
    assert.equal(verified.status, 0, verified.stderr);
    const uploads = await readFile(awsLog, "utf8");
    assert.equal(uploads.split("\n").filter((line) => line.includes("s3 cp")).length, 2);
    assert.match(uploads, new RegExp(`cells/${TENANT}/hermes-${TENANT}-`));
    assert.match(uploads, /[.]zip[.]manifest[.]json/);
    assert.doesNotMatch(await readFile(dockerLog, "utf8"), /model-auth|auth[.]json|[.]env/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function stubCommands(fixture) {
  const bin = path.join(fixture, "bin");
  await mkdir(bin, { recursive: true });
  const docker = path.join(bin, "docker");
  const curl = path.join(bin, "curl");
  const aws = path.join(bin, "aws");
  const sleep = path.join(bin, "sleep");
  await writeFile(docker, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\ncase "$*" in\n  *"volume inspect"*) exit 1 ;;\n  *"inspect --format"*) printf '%s\\n' 'true' ;;\n  *"auth status openai-codex"*) printf '%s\\n' '{"provider":"openai-codex","authenticated":true}' ;;\nesac\nif [ "\${FAIL_DISPOSABLE_SESSIONS:-0}" = 1 ] && echo "$*" | grep -q 'restore-' && echo "$*" | grep -q 'sessions list'; then exit 1; fi\nexit 0\n`);
  await writeFile(curl, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_LOG"\nif [ "\${CURL_MODE:-ok}" = fail ]; then printf '%s\\n' '{"ok":false}'; elif [ -n "\${CURL_FAIL_ONCE_MARKER:-}" ] && [ ! -e "$CURL_FAIL_ONCE_MARKER" ]; then : > "$CURL_FAIL_ONCE_MARKER"; printf '%s\\n' '{"ok":false}'; else printf '%s\\n' '{"ok":true}'; fi\n`);
  await writeFile(aws, "#!/bin/sh\nprintf '%s\\n' 'unexpected aws call' >&2\nexit 99\n");
  await writeFile(sleep, "#!/bin/sh\nexit 0\n");
  for (const command of [docker, curl, aws, sleep]) await chmod(command, 0o755);
  return bin;
}

function restoreEnv(fixture, bin, extra = {}) {
  return {
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: path.join(fixture, "tmp"),
    LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
    LIGOU_TENANT_REGISTRY: path.join(fixture, "tenant-registry.json"),
    TENANT_ID: TENANT,
    TENANT_SLUG,
    LIGOU_BACKUP_MANIFEST_KEY: KEY,
    LIGOU_NODE_BIN: process.execPath,
    HERMES_IMAGE: IMAGE,
    HERMES_API_KEY: "synthetic-local-key",
    DOCKER_LOG: path.join(fixture, "docker.log"),
    CURL_LOG: path.join(fixture, "curl.log"),
    ...extra,
  };
}

test("restore imports into a disposable no-network/no-auth volume and runs all smoke checks", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-restore-disposable-"));
  try {
    await mkdir(path.join(fixture, "tmp"));
    const archive = await makeArchive(fixture);
    const manifest = `${archive}.manifest.json`;
    assert.equal(createManifest(archive, manifest).status, 0);
    const bin = await stubCommands(fixture);
    const result = run("bash", [restoreScript, "--archive", archive, "--manifest", manifest], {
      env: restoreEnv(fixture, bin),
    });
    assert.equal(result.status, 0, result.stderr);
    const log = await readFile(path.join(fixture, "docker.log"), "utf8");
    assert.match(log, /--network none/);
    assert.doesNotMatch(log, /--env-file|hermes-model-auth|\/root\/\.hermes:|GOOGLE_|SUPABASE_|AWS_/);
    assert.match(log, /memory list --json/);
    assert.match(log, /skills list --json/);
    assert.match(log, /sessions list --json/);
    assert.match(log, /test ! -e \/root\/\.hermes\/auth\.json/);
    assert.match(log, new RegExp(`rm -f hermes-${TENANT}-restore-check-`));
    assert.match(log, /volume rm/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("disposable smoke failure never reaches the live cell", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-restore-smoke-fail-"));
  try {
    await mkdir(path.join(fixture, "tmp"));
    const archive = await makeArchive(fixture);
    const manifest = `${archive}.manifest.json`;
    assert.equal(createManifest(archive, manifest).status, 0);
    const bin = await stubCommands(fixture);
    const result = run("bash", [restoreScript, "--archive", archive, "--manifest", manifest, "--apply"], {
      env: restoreEnv(fixture, bin, { FAIL_DISPOSABLE_SESSIONS: "1" }),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /disposable_smoke_failed/);
    const log = await readFile(path.join(fixture, "docker.log"), "utf8");
    assert.doesNotMatch(log, new RegExp(`ligou-cell-${TENANT} hermes (?:backup|import)`));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("apply promotes a validated tenant-staged volume without importing into the live volume", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-restore-staged-apply-"));
  try {
    await mkdir(path.join(fixture, "tmp"));
    const archive = await makeArchive(fixture);
    const manifest = `${archive}.manifest.json`;
    assert.equal(createManifest(archive, manifest).status, 0);
    const archiveId = JSON.parse(await readFile(manifest, "utf8")).archive.id;
    const bin = await stubCommands(fixture);
    const env = restoreEnv(fixture, bin);
    const result = run("bash", [restoreScript, "--archive", archive, "--manifest", manifest, "--apply"], { env });
    assert.equal(result.status, 0, result.stderr);
    const log = await readFile(path.join(fixture, "docker.log"), "utf8");
    assert.doesNotMatch(log, new RegExp(`ligou-cell-${TENANT} hermes (?:backup|import)`));
    assert.match(log, new RegExp(`compose --project-name ligou-${TENANT} .* up -d --force-recreate`));
    const staged = `ligou-${TENANT}-hermes-cognitive-stage-${archiveId}`;
    assert.match(log, new RegExp(`source=${staged},target=/opt/data`));
    assert.doesNotMatch(log, new RegExp(`volume rm ${staged}`));
    const registry = JSON.parse(await readFile(env.LIGOU_TENANT_REGISTRY, "utf8"));
    assert.equal(registry.tenants[TENANT].cognitive_volume, staged);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("live health failure labels rollback applied only after recovered live smoke passes", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-restore-rollback-"));
  try {
    await mkdir(path.join(fixture, "tmp"));
    const archive = await makeArchive(fixture);
    const manifest = `${archive}.manifest.json`;
    assert.equal(createManifest(archive, manifest).status, 0);
    const bin = await stubCommands(fixture);
    const result = run("bash", [restoreScript, "--archive", archive, "--manifest", manifest, "--apply"], {
      env: restoreEnv(fixture, bin, { CURL_FAIL_ONCE_MARKER: path.join(fixture, "curl-failed-once") }),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restore_health_failed_rollback_applied/);
    const log = await readFile(path.join(fixture, "docker.log"), "utf8");
    assert.doesNotMatch(log, new RegExp(`ligou-cell-${TENANT} hermes (?:backup|import)`));
    assert.equal(log.split("\n").filter((line) => line.includes(`compose --project-name ligou-${TENANT}`)).length, 2);
    const registry = JSON.parse(await readFile(path.join(fixture, "tenant-registry.json"), "utf8"));
    assert.equal(registry.tenants[TENANT].cognitive_volume, `ligou-${TENANT}-hermes-cognitive`);
    const curlCalls = (await readFile(path.join(fixture, "curl.log"), "utf8")).trim().split("\n");
    assert.equal(curlCalls.length, 2, "new state and recovered rollback must each pass a live probe");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("failed restore recovery is labeled rollback failed, never rollback applied", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-restore-recovery-fail-"));
  try {
    await mkdir(path.join(fixture, "tmp"));
    const archive = await makeArchive(fixture);
    const manifest = `${archive}.manifest.json`;
    assert.equal(createManifest(archive, manifest).status, 0);
    const bin = await stubCommands(fixture);
    const result = run("bash", [restoreScript, "--archive", archive, "--manifest", manifest, "--apply"], {
      env: restoreEnv(fixture, bin, { CURL_MODE: "fail" }),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restore_health_failed_rollback_failed/);
    assert.doesNotMatch(result.stderr, /rollback_applied/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

for (const boundary of ["registry_promotion", "container_recreate", "live_smoke"]) {
  test(`interrupt after ${boundary} restores registry and container before stage cleanup`, async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), `ligou-restore-interrupt-${boundary}-`));
    try {
      await mkdir(path.join(fixture, "tmp"));
      const archive = await makeArchive(fixture);
      const manifest = `${archive}.manifest.json`;
      assert.equal(createManifest(archive, manifest).status, 0);
      const archiveId = JSON.parse(await readFile(manifest, "utf8")).archive.id;
      const bin = await stubCommands(fixture);
      const env = restoreEnv(fixture, bin, {
        LIGOU_RESTORE_TEST_HARNESS: "1",
        LIGOU_RESTORE_TEST_INTERRUPT_AFTER: boundary,
      });
      const result = run("bash", [restoreScript, "--archive", archive, "--manifest", manifest, "--apply"], { env });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /restore_interrupted_rollback_applied/);
      const registry = JSON.parse(await readFile(env.LIGOU_TENANT_REGISTRY, "utf8"));
      assert.equal(registry.tenants[TENANT].cognitive_volume, `ligou-${TENANT}-hermes-cognitive`);
      const log = await readFile(path.join(fixture, "docker.log"), "utf8");
      assert.match(log, new RegExp(`compose --project-name ligou-${TENANT}`));
      assert.match(log, new RegExp(`inspect --format .* ligou-cell-${TENANT}`));
      assert.match(log, new RegExp(`volume rm ligou-${TENANT}-hermes-cognitive-stage-${archiveId}`));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test("interrupt before registry CAS leaves old identity active and removes only the unused stage", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-restore-interrupt-before-cas-"));
  try {
    await mkdir(path.join(fixture, "tmp"));
    const archive = await makeArchive(fixture);
    const manifest = `${archive}.manifest.json`;
    assert.equal(createManifest(archive, manifest).status, 0);
    const archiveId = JSON.parse(await readFile(manifest, "utf8")).archive.id;
    const bin = await stubCommands(fixture);
    const env = restoreEnv(fixture, bin, { LIGOU_RESTORE_TEST_HARNESS: "1", LIGOU_RESTORE_TEST_INTERRUPT_AFTER: "before_cas" });
    const result = run("bash", [restoreScript, "--archive", archive, "--manifest", manifest, "--apply"], { env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restore_interrupted_no_promotion/);
    const registry = JSON.parse(await readFile(env.LIGOU_TENANT_REGISTRY, "utf8"));
    assert.equal(registry.tenants[TENANT].cognitive_volume, `ligou-${TENANT}-hermes-cognitive`);
    const log = await readFile(path.join(fixture, "docker.log"), "utf8");
    assert.match(log, new RegExp(`volume rm ligou-${TENANT}-hermes-cognitive-stage-${archiveId}`));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("failed promotion CAS leaves retryable old identity and never deletes an active stage", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-restore-failed-cas-"));
  try {
    await mkdir(path.join(fixture, "tmp"));
    const archive = await makeArchive(fixture);
    const manifest = `${archive}.manifest.json`;
    assert.equal(createManifest(archive, manifest).status, 0);
    const bin = await stubCommands(fixture);
    const baseEnv = restoreEnv(fixture, bin, { LIGOU_RESTORE_TEST_HARNESS: "1" });
    const failed = run("bash", [restoreScript, "--archive", archive, "--manifest", manifest, "--apply"], {
      env: { ...baseEnv, LIGOU_RESTORE_TEST_FAIL_CAS: "1" },
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /restore_stage_activation_failed/);
    let registry = JSON.parse(await readFile(baseEnv.LIGOU_TENANT_REGISTRY, "utf8"));
    assert.equal(registry.tenants[TENANT].cognitive_volume, `ligou-${TENANT}-hermes-cognitive`);
    const retry = run("bash", [restoreScript, "--archive", archive, "--manifest", manifest, "--apply"], { env: baseEnv });
    assert.equal(retry.status, 0, retry.stderr);
    registry = JSON.parse(await readFile(baseEnv.LIGOU_TENANT_REGISTRY, "utf8"));
    assert.match(registry.tenants[TENANT].cognitive_volume, /-stage-[a-f0-9]{64}$/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
