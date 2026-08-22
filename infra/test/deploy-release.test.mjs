import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localModuleClosure } from "../bootstrap-module-closure.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageTool = path.join(repoRoot, "infra/package-release.mjs");
const manifestTool = path.join(repoRoot, "infra/release-manifest.mjs");
const hostDeploy = path.join(repoRoot, "infra/deploy-host.sh");
const healthTool = path.join(repoRoot, "infra/release-health.sh");
const deployScript = path.join(repoRoot, "infra/deploy.sh");
const closureTool = path.join(repoRoot, "infra/bootstrap-module-closure.mjs");
const isolationGuard = path.join(repoRoot, "infra/test/helpers/bootstrap-isolation-guard.mjs");
const retentionScript = path.join(repoRoot, "infra/retention.sh");
const RELEASE_KEY = "Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=";
const IMAGE = "330140023537.dkr.ecr.us-east-1.amazonaws.com/ligou/hermes-agent@sha256:7ae8423fb1a64110008e746c5571864fcd8d9e167659d48f96b9b4a5a8181f33";

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

const tarPath = ["/usr/bin/tar", "/bin/tar"].find(existsSync);
if (!tarPath) throw new Error("tar_required_for_release_tests");

function runPermissionedNode(script, args, { cwd, readPaths, artifact = "/dev/null", env = {} }) {
  const allowed = [isolationGuard, ...readPaths].map((candidate) => realpathSync(candidate));
  const canonicalScript = realpathSync(script);
  return run(process.execPath, [
    "--no-warnings",
    "--permission",
    ...allowed.map((candidate) => `--allow-fs-read=${candidate}`),
    "--allow-child-process",
    `--import=${pathToFileURL(isolationGuard).href}`,
    canonicalScript,
    ...args,
  ], {
    cwd: realpathSync(cwd),
    env: {
      PATH: path.dirname(tarPath),
      LIGOU_BOOTSTRAP_ALLOWED_ARTIFACT: artifact === "/dev/null" ? artifact : realpathSync(artifact),
      LIGOU_BOOTSTRAP_TAR_COMMAND: "tar",
      ...env,
    },
  });
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
    "voice-controller/scripts/prove-onboarding-e2e.ts": "destructive live proof\n",
    "voice-controller/test/runtime.test.ts": "test-only\n",
    "hermes-cell/config/config.yaml": "model:\n  provider: openai-codex\n",
    "hermes-cell/config/cli-config.yaml": "model:\n  provider: openai-codex\n",
    "hermes-cell/docker-compose.yml": "services: {}\n",
    "hermes-cell/test/config.test.mjs": "test-only\n",
    "supabase/functions/good/index.ts": "export {};\n",
    "supabase/deno.json": "{\"imports\":{}}\n",
    "supabase/scripts/admin.ts": "admin-only\n",
    "supabase/tests/database/unsafe.sql": "test-only\n",
    "supabase/deno.lock": "fixture-deno-lock\n",
    "supabase/.temp/project-ref": "forbidden temp\n",
    "infra/good.sh": "#!/bin/sh\nexit 0\n",
    "infra/deploy-host.sh": await readFile(hostDeploy, "utf8"),
    "infra/release-manifest.mjs": await readFile(manifestTool, "utf8"),
    "infra/edge-release-identity.mjs": await readFile(path.join(repoRoot, "infra/edge-release-identity.mjs"), "utf8"),
    "infra/deploy.sh": "#!/bin/sh\necho live-deploy\n",
    "infra/pull-env.sh": "#!/bin/sh\necho live-env\n",
    "infra/package-release.mjs": "// builder-only\n",
    "infra/bootstrap-module-closure.mjs": "// builder-only closure discovery\n",
    "infra/test/proof.test.mjs": "// test-only\n",
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

async function commitVerifierGraph(repo) {
  const manifestSource = await readFile(manifestTool, "utf8");
  const edgeSource = await readFile(path.join(repoRoot, "infra/edge-release-identity.mjs"), "utf8");
  await writeTree(repo.root, {
    "infra/deploy-host.sh": await readFile(hostDeploy, "utf8"),
    "infra/release-manifest.mjs": manifestSource,
    "infra/edge-release-identity.mjs": `import "./nested-release-proof.mjs";\n${edgeSource}`,
    "infra/nested-release-proof.mjs": "export const nestedReleaseProof = true;\n",
  });
  assert.equal(run("git", ["add", "infra/deploy-host.sh", "infra/release-manifest.mjs",
    "infra/edge-release-identity.mjs", "infra/nested-release-proof.mjs"], { cwd: repo.root }).status, 0);
  assert.equal(run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "verifier graph"], { cwd: repo.root }).status, 0);
  return run("git", ["rev-parse", "HEAD"], { cwd: repo.root }).stdout.trim();
}

async function commitModuleGraph(base, files) {
  const root = path.join(base, "module-repo");
  await mkdir(root);
  await writeTree(root, files);
  assert.equal(run("git", ["init", "-q"], { cwd: root }).status, 0);
  assert.equal(run("git", ["add", "."], { cwd: root }).status, 0);
  assert.equal(run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "module graph"], { cwd: root }).status, 0);
  return { root, commit: run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim() };
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
    assert.doesNotMatch(entries.join("\n"), /prove-onboarding|\/test\/|supabase\/scripts\/|infra\/(?:deploy|pull-env|package-release|bootstrap-module-closure)[.]/);

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
        edge_functions: body.runtime.dependencies.edge_functions,
      },
      hermes: { image: IMAGE },
    });
    assert.deepEqual(Object.keys(body.runtime.dependencies.edge_functions), ["good"]);
    assert.deepEqual(body.runtime.dependencies.edge_functions.good.files.map((entry) => entry.path), [
      "supabase/deno.json",
      "supabase/deno.lock",
      "supabase/functions/good/index.ts",
    ]);
    assert.match(body.runtime.dependencies.edge_functions.good.composite_sha256, /^[a-f0-9]{64}$/);
    const verified = run(process.execPath, [manifestTool, "verify", "--artifact", artifact,
      "--manifest", manifest, "--commit", repo.commit], { env: { ...process.env, LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY } });
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("bootstrap closure lexes ESM syntax without treating comments or strings as imports", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-bootstrap-lexer-"));
  try {
    await writeTree(fixture, {
      "infra/entry.mjs": [
        "const decoy = 'import(\\\"./string-decoy.mjs\\\")';",
        "// import './line-comment-decoy.mjs';",
        "/* export { nope } from './block-comment-decoy.mjs'; */",
        "import './static-side-effect.mjs';",
        "import { from as importedFrom } from './reserved-binding.mjs';",
        "export { named } from './static-export.mjs';",
        "void import('./dynamic-string.mjs');",
        "void import(`./dynamic-template.mjs`);",
        "void import.meta.url;",
      ].join("\n"),
      "infra/static-side-effect.mjs": "export const sideEffect = true;\n",
      "infra/reserved-binding.mjs": "export const from = true;\n",
      "infra/static-export.mjs": "export const named = true;\n",
      "infra/dynamic-string.mjs": "export const dynamicString = true;\n",
      "infra/dynamic-template.mjs": "export const dynamicTemplate = true;\n",
    });

    assert.deepEqual(localModuleClosure(fixture, "infra/entry.mjs"), [
      "infra/dynamic-string.mjs",
      "infra/dynamic-template.mjs",
      "infra/entry.mjs",
      "infra/reserved-binding.mjs",
      "infra/static-export.mjs",
      "infra/static-side-effect.mjs",
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("bootstrap closure treats import object and class members as IdentifierNames", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-bootstrap-import-members-"));
  try {
    await writeTree(fixture, {
      "infra/entry.mjs": [
        "const objectMethod = { import() { return 'method'; } };",
        "class Value { import() { return 'class-method'; } }",
        "const objectProperty = { import: 1 };",
        "void objectMethod; void Value; void objectProperty;",
        "void import('./dynamic-literal.mjs');",
        "import './static-side-effect.mjs';",
      ].join("\n"),
      "infra/dynamic-literal.mjs": "export const dynamicLiteral = true;\n",
      "infra/static-side-effect.mjs": "export const staticSideEffect = true;\n",
    });

    assert.deepEqual(localModuleClosure(fixture, "infra/entry.mjs"), [
      "infra/dynamic-literal.mjs",
      "infra/entry.mjs",
      "infra/static-side-effect.mjs",
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("bootstrap closure rejects nonliteral and interpolated dynamic imports", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-bootstrap-dynamic-"));
  try {
    for (const [name, source] of Object.entries({
      variable: "const target = './dep.mjs'; void import(target);\n",
      interpolated: "const name = 'dep'; void import(`./${name}.mjs`);\n",
      concatenated: "void import('./dep-' + 'one.mjs');\n",
    })) {
      const entry = `infra/${name}.mjs`;
      await writeTree(fixture, { [entry]: source });
      assert.throws(() => localModuleClosure(fixture, entry), /bootstrap_closure_dynamic_import_nonliteral/, name);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("bootstrap closure CLI resolves the exact committed module bytes", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-bootstrap-commit-"));
  try {
    const repo = await commitModuleGraph(fixture, {
      "infra/entry.mjs": "import './committed.mjs';\n",
      "infra/committed.mjs": "export const committed = true;\n",
    });
    await writeTree(repo.root, {
      "infra/entry.mjs": "import './worktree-only.mjs';\n",
      "infra/worktree-only.mjs": "export const dirty = true;\n",
    });
    const result = run(process.execPath, [closureTool, "--root", repo.root, "--entry", "infra/entry.mjs", "--commit", repo.commit]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "infra/committed.mjs infra/entry.mjs");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("bootstrap verifier isolation denies filesystem, network including every DNS surface, and child commands", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-bootstrap-isolation-red-"));
  try {
    const bootstrap = path.join(fixture, "bootstrap");
    const outside = path.join(fixture, "outside");
    await writeTree(fixture, {
      "outside/sentinel.txt": "outside-readable\n",
      "outside/external.mjs": "export const external = true;\n",
      "bootstrap/read-external.mjs": "import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(process.argv[2], 'utf8'));\n",
      "bootstrap/import-external.mjs": "await import(process.argv[2]);\n",
      "bootstrap/network.mjs": "await fetch('data:text/plain,network-readable');\n",
      "bootstrap/net.mjs": "import net from 'node:net'; net.connect({host:'127.0.0.1',port:9});\n",
      "bootstrap/dns-callback.mjs": "import dns from 'node:dns'; dns.lookup('localhost', () => {});\n",
      "bootstrap/dns-promises-module.mjs": "import * as dnsPromises from 'node:dns/promises'; await dnsPromises.lookup('localhost');\n",
      "bootstrap/dns-default-promises.mjs": "import dns from 'node:dns'; dns.setServers(['127.0.0.1']); try { await dns.promises.reverse('127.0.0.1'); } catch (error) { if (error?.message === 'bootstrap_network_forbidden') throw error; }\n",
      "bootstrap/dns-resolver-callback.mjs": "import dns from 'node:dns'; const resolver = new dns.Resolver(); resolver.setServers(['127.0.0.1']); try { resolver.resolve4('localhost', () => {}); } catch (error) { throw error; }\n",
      "bootstrap/dns-resolver-promises.mjs": "import {Resolver} from 'node:dns/promises'; const resolver = new Resolver(); resolver.setServers(['127.0.0.1']); try { await resolver.resolveAny('localhost'); } catch (error) { if (error?.message === 'bootstrap_network_forbidden') throw error; }\n",
      "bootstrap/child.mjs": "import {spawnSync} from 'node:child_process'; const r=spawnSync(process.execPath,['-e','process.exit(0)']); process.exit(r.status ?? 1);\n",
      "bootstrap/tar-abuse.mjs": "import {spawnSync} from 'node:child_process'; spawnSync('tar',['--version']);\n",
    });
    const attempts = [
      runPermissionedNode(path.join(bootstrap, "read-external.mjs"), [path.join(outside, "sentinel.txt")], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "import-external.mjs"), [pathToFileURL(path.join(outside, "external.mjs")).href], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "network.mjs"), [], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "net.mjs"), [], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "dns-callback.mjs"), [], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "dns-promises-module.mjs"), [], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "dns-default-promises.mjs"), [], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "dns-resolver-callback.mjs"), [], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "dns-resolver-promises.mjs"), [], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "child.mjs"), [], { cwd: bootstrap, readPaths: [bootstrap] }),
      runPermissionedNode(path.join(bootstrap, "tar-abuse.mjs"), [], { cwd: bootstrap, readPaths: [bootstrap] }),
    ];
    assert.deepEqual(attempts.map((attempt) => attempt.status), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], attempts.map((attempt) => attempt.stderr).join("\n"));
    assert.match(attempts[0].stderr, /ERR_ACCESS_DENIED/);
    assert.match(attempts[1].stderr, /ERR_ACCESS_DENIED/);
    assert.match(attempts[2].stderr, /bootstrap_network_forbidden/);
    assert.match(attempts[3].stderr, /bootstrap_network_forbidden/);
    for (const attempt of attempts.slice(4, 9)) {
      assert.match(attempt.stderr, /bootstrap_network_forbidden/);
    }
    assert.match(attempts[9].stderr, /bootstrap_child_process_forbidden/);
    assert.match(attempts[10].stderr, /bootstrap_child_process_forbidden/);
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

test("SSM bootstrap runs the real verifier with its complete transitive local module closure", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-bootstrap-closure-"));
  try {
    const repo = await gitFixture(fixture);
    const commit = await commitVerifierGraph(repo);
    const bin = path.join(fixture, "bin");
    const work = path.join(fixture, "work");
    const store = path.join(fixture, "s3");
    const parametersFile = path.join(fixture, "ssm-parameters.json");
    await mkdir(bin);
    await mkdir(work);
    await mkdir(store);
    await writeFile(path.join(bin, "aws"), `#!/bin/sh
if [ "$1" = s3 ] && [ "$2" = cp ]; then
  case "$3" in
    *.manifest.json) cp "$3" "$S3_STORE/release.tar.gz.manifest.json" ;;
    *) cp "$3" "$S3_STORE/release.tar.gz" ;;
  esac
  exit 0
fi
if [ "$1" = ssm ] && [ "$2" = send-command ]; then
  capture=0
  for argument in "$@"; do
    if [ "$capture" = 1 ]; then printf '%s' "$argument" > "$SSM_PARAMETERS_FILE"; break; fi
    if [ "$argument" = --parameters ]; then capture=1; fi
  done
  printf '%s\n' cmd-test
  exit 0
fi
case "$*" in
  *StandardOutputContent*) printf '%s\n' '{"ok":true,"status":"activated"}' ;;
  *'--query Status'*) printf '%s\n' Success ;;
esac
exit 0
`);
    await writeFile(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    for (const command of ["aws", "sleep"]) await chmod(path.join(bin, command), 0o755);

    const deployed = run("bash", [deployScript], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        S3_STORE: store,
        SSM_PARAMETERS_FILE: parametersFile,
        LIGOU_AWS_REGION: "us-east-1",
        LIGOU_INSTANCE_ID: "i-0123456789abcdef0",
        LIGOU_DEPLOY_BUCKET: "unit-deploys",
        LIGOU_DEPLOY_SOURCE_ID: "builder:unit",
        LIGOU_DEPLOY_SOURCE_ROOT: repo.root,
        LIGOU_DEPLOY_WORK_DIR: work,
        LIGOU_NODE_BIN: process.execPath,
        LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY,
        LIGOU_RELEASE_MANIFEST_KEY_ID: "release-test-v1",
        HERMES_IMAGE: IMAGE,
      },
    });
    assert.equal(deployed.status, 0, deployed.stderr);

    const remoteCommand = JSON.parse(await readFile(parametersFile, "utf8")).commands[0];
    const extraction = /tar -xzf \$ART -C \$BOOT ([^;]+);/.exec(remoteCommand);
    assert.ok(extraction, remoteCommand);
    const bootstrapFiles = extraction[1].trim().split(/\s+/);
    const bootstrap = path.join(fixture, "bootstrap");
    await mkdir(bootstrap);
    const artifact = path.join(store, "release.tar.gz");
    const manifest = path.join(store, "release.tar.gz.manifest.json");
    const extracted = run("tar", ["-xzf", artifact, "-C", bootstrap, ...bootstrapFiles]);
    assert.equal(extracted.status, 0, extracted.stderr);

    const canonicalArtifact = realpathSync(artifact);
    const canonicalManifest = realpathSync(manifest);
    const isolated = runPermissionedNode(path.join(bootstrap, "infra/release-manifest.mjs"), ["verify",
      "--artifact", canonicalArtifact, "--manifest", canonicalManifest, "--commit", commit], {
      cwd: bootstrap,
      readPaths: [bootstrap, artifact, manifest],
      artifact: canonicalArtifact,
      env: { LIGOU_RELEASE_MANIFEST_KEY: RELEASE_KEY },
    });
    assert.equal(isolated.status, 0, isolated.stderr);
    await access(path.join(bootstrap, "infra/edge-release-identity.mjs"));
    await access(path.join(bootstrap, "infra/nested-release-proof.mjs"));
  } finally {
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
    "supabase/deno.json": '{"imports":{}}\n',
    "supabase/functions/fixture/index.ts": "export {};\n",
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
  const created = createReleaseManifest(artifact, manifest, commit);
  assert.equal(created.status, 0, created.stderr);
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
    await writeFile(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_LOG"\ncase "$*" in\n  *'127.0.0.1:8790/health'*) printf '%s\\n' '{"ok":true,"openai":true}' ;;\n  *'/rest/v1/rpc/release_health_state'*) printf '%s\\n' '{"ok":true,"tenant_id":"11111111-1111-4111-8111-111111111111","tenant_slug":"test-tenant","status":"active"}' ;;\n  *) printf '%s\\n' '{"ok":true}' ;;\nesac\n`);
    await writeFile(path.join(bin, "docker"), `#!/bin/sh\ncase "$*" in\n  *'inspect --format {{json .}}'*) printf '%s\\n' '{"Name":"/ligou-cell-11111111-1111-4111-8111-111111111111","Config":{"Image":"${IMAGE}"},"Image":"sha256:${"a".repeat(64)}","State":{"Running":true}}' ;;\n  *'image inspect --format {{json .RepoDigests}}'*) printf '%s\\n' '["${IMAGE}"]' ;;\n  *'auth status openai-codex'*) printf '%s\\n' '{"provider":"openai-codex","authenticated":true}' ;;\nesac\n`);
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "docker"), 0o755);
    const envFile = path.join(fixture, "env");
    await writeFile(envFile, [
      "SUPABASE_URL='https://unit.invalid'",
      "SUPABASE_SECRET_KEY='synthetic-service-secret'",
      "TENANT_SLUG='test-tenant'",
      "TENANT_ID='11111111-1111-4111-8111-111111111111'",
      "PORT='8790'",
      `HERMES_IMAGE='${IMAGE}'`,
    ].join("\n"));
    const result = run("bash", [healthTool], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`, LIGOU_ENV_FILE: envFile, CURL_LOG: curlLog, LIGOU_NODE_BIN: process.execPath,
        LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
        LIGOU_TENANT_REGISTRY: path.join(fixture, "tenant-registry.json"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '{"ok":true,"controller":"ready","supabase":"ready","hermes":"ready"}');
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-service-secret|unit[.]invalid|test-tenant/);
    const calls = await readFile(curlLog, "utf8");
    assert.match(calls, /127[.]0[.]0[.]1:8790\/health/);
    assert.match(calls, /https:\/\/unit[.]invalid\/rest\/v1\/rpc\/release_health_state/);
    assert.match(calls, /Authorization: Bearer synthetic-service-secret/);
    assert.doesNotMatch(calls, /synthetic-publishable|\/rest\/v1\/tenants/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release health rejects a controller that is up without its voice credential", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-release-controller-key-"));
  try {
    const bin = path.join(fixture, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "curl"), `#!/bin/sh\ncase "$*" in\n  *'127.0.0.1:8790/health'*) printf '%s\\n' '{"ok":true,"openai":false}' ;;\n  *'/rest/v1/rpc/release_health_state'*) printf '%s\\n' '{"ok":true,"tenant_id":"11111111-1111-4111-8111-111111111111","tenant_slug":"test-tenant","status":"active"}' ;;\n  *) printf '%s\\n' '{"ok":true}' ;;\nesac\n`);
    await writeFile(path.join(bin, "docker"), `#!/bin/sh\ncase "$*" in\n  *'inspect --format {{json .}}'*) printf '%s\\n' '{"Name":"/ligou-cell-11111111-1111-4111-8111-111111111111","Config":{"Image":"${IMAGE}"},"Image":"sha256:${"a".repeat(64)}","State":{"Running":true}}' ;;\n  *'image inspect --format {{json .RepoDigests}}'*) printf '%s\\n' '["${IMAGE}"]' ;;\n  *'auth status openai-codex'*) printf '%s\\n' '{"provider":"openai-codex","authenticated":true}' ;;\nesac\n`);
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "docker"), 0o755);
    const envFile = path.join(fixture, "env");
    await writeFile(envFile, [
      "SUPABASE_URL='https://unit.invalid'", "SUPABASE_SECRET_KEY='synthetic-service-secret'",
      "TENANT_SLUG='test-tenant'", "PORT='8790'",
      "TENANT_ID='11111111-1111-4111-8111-111111111111'",
      `HERMES_IMAGE='${IMAGE}'`,
    ].join("\n"));
    const result = run("bash", [healthTool], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`, LIGOU_ENV_FILE: envFile, LIGOU_NODE_BIN: process.execPath,
        LIGOU_TENANT_STATE_ROOT: path.join(fixture, "tenants"),
        LIGOU_TENANT_REGISTRY: path.join(fixture, "tenant-registry.json"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /"controller":"unavailable"/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("retention scheduler calls only the service-role RPC and returns sanitized counts", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-retention-scheduler-"));
  try {
    const bin = path.join(fixture, "bin");
    const curlLog = path.join(fixture, "curl.log");
    await mkdir(bin);
    await writeFile(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_LOG"\nprintf '%s\\n' '{"transcripts_redacted":1,"browser_rows_deleted":2,"phone_rows_deleted":3,"oauth_states_deleted":4,"slot_offers_deleted":5,"booking_quotes_deleted":6,"completed_at":"2026-08-21T00:00:00Z"}'\n`);
    await chmod(path.join(bin, "curl"), 0o755);
    const envFile = path.join(fixture, "env");
    await writeFile(envFile, "SUPABASE_URL='https://unit.invalid'\nSUPABASE_SECRET_KEY='synthetic-service-secret'\n");
    const result = run("bash", [retentionScript], { env: {
      PATH: `${bin}:/usr/bin:/bin`, LIGOU_ENV_FILE: envFile, LIGOU_NODE_BIN: process.execPath, CURL_LOG: curlLog,
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '{"ok":true,"transcripts":1,"transport":5,"oauth":4,"offers":5,"quotes":6}');
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-service-secret|unit[.]invalid/);
    const call = await readFile(curlLog, "utf8");
    assert.match(call, /\/rest\/v1\/rpc\/purge_ephemeral_call_data/);
    assert.match(call, /Authorization: Bearer synthetic-service-secret/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
