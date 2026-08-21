import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { computeEdgeReleaseIdentityFromFiles } from "./edge-release-identity.mjs";

const EXCLUSIONS = [
  "**/.env*",
  "**/._*",
  "supabase/.temp/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.hermes/**",
  "**/auth.json",
  "**/*.{zip,tar,tgz,gz,7z,rar}",
  "voice-controller/{scripts,test}/**",
  "hermes-cell/test/**",
  "supabase/{scripts,tests}/**",
  "infra/test/**",
  "infra/{bootstrap-module-closure.mjs,deploy.sh,package-release.mjs,pull-env.sh}",
];
const COMMIT = /^[a-f0-9]{40}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RELEASE_ID = /^[a-f0-9]{40}-[a-f0-9]{64}$/;
const DIGEST_IMAGE = /^[^\s@]+(?:[:][^\s@]+)?@sha256:[a-f0-9]{64}$/;
const PINNED_TOOLCHAIN = {
  node: "22.22.3",
  application_version: "0.1.0",
  bun: "1.2.13",
  deno: "2.9.4",
  supabase_cli: "2.115.0",
  hermes_image: "docker.io/nousresearch/hermes-agent@sha256:d597ca1f766ff23ff86437fe5e0f36a6049166ce91df917d9577d7418f0767de",
  dependencies: { supabase_js: "2.112.3", postgres: "3.4.9" },
};

function fail(code) {
  process.stderr.write(String(code) + "\n");
  process.exit(1);
}

function argumentsFor(values) {
  const command = values[0];
  const out = { command };
  for (let index = 1; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) fail("release_manifest_arguments_invalid");
    const key = flag.slice(2).replace(/-/g, "_");
    if (Object.hasOwn(out, key)) fail("release_manifest_argument_duplicate");
    out[key] = value;
  }
  return out;
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function keyBytes() {
  const encoded = process.env.LIGOU_RELEASE_MANIFEST_KEY ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) fail("release_manifest_key_invalid");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) fail("release_manifest_key_must_be_32_bytes");
  return key;
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function proof(artifact) {
  let bytes;
  let stat;
  try { bytes = readFileSync(artifact); stat = statSync(artifact); }
  catch { fail("release_artifact_required"); }
  if (!stat.isFile() || stat.size < 1) fail("release_artifact_invalid");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: stat.size };
}

function forbidden(candidate) {
  if (typeof candidate !== "string" || /[\u0000-\u001f\u007f]/.test(candidate) || candidate.startsWith("/") || candidate.includes("\\")) return true;
  const normalized = candidate.replace(/^(?:[.]\/)+/, "").replace(/\/$/, "");
  if (!normalized) return false;
  const segments = normalized.split("/");
  const lower = segments.map((segment) => segment.toLowerCase());
  if (!new Set(["voice-controller", "hermes-cell", "supabase", "infra"]).has(lower[0])) return true;
  if (segments.some((segment) => segment === "..")) return true;
  const basename = lower.at(-1) ?? "";
  if (normalized.startsWith("voice-controller/scripts/")
    || normalized.startsWith("voice-controller/test/")
    || normalized.startsWith("hermes-cell/test/")
    || normalized.startsWith("supabase/scripts/")
    || normalized.startsWith("supabase/tests/")
    || normalized.startsWith("infra/test/")
    || new Set(["infra/bootstrap-module-closure.mjs", "infra/deploy.sh", "infra/package-release.mjs", "infra/pull-env.sh"]).has(normalized)) return true;
  if (lower.some((segment) => ["node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache", "vendor", ".git", ".hermes", ".codex", ".ssh", "hermes-model-auth"].includes(segment))) return true;
  if (normalized.toLowerCase().startsWith("supabase/.temp/") || normalized.toLowerCase() === "supabase/.temp") return true;
  if (lower.some((segment) => segment === ".env" || segment.startsWith(".env.") || segment.startsWith("._"))) return true;
  if (["auth.json", "credentials.json", "id_rsa", "id_ed25519", "docker.sock"].includes(basename)) return true;
  if (/\.(?:zip|tar|tgz|gz|7z|rar)$/.test(basename)) return true;
  return false;
}

function inspectArtifact(artifact) {
  const result = spawnSync("tar", ["-tzf", artifact], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) fail("release_artifact_listing_failed");
  const entries = result.stdout.split("\n").filter(Boolean);
  if (!entries.length || entries.some(forbidden)) fail("release_artifact_forbidden_path");
  const seen = new Set();
  for (const entry of entries) {
    const normalized = entry.replace(/^(?:[.]\/)+/, "").replace(/\/$/, "");
    if (seen.has(normalized)) fail("release_artifact_duplicate_entry");
    seen.add(normalized);
  }
  let tar;
  try { tar = gunzipSync(readFileSync(artifact)); }
  catch { fail("release_artifact_listing_failed"); }
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const type = String.fromCharCode(header[156] || 0);
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) fail("release_artifact_listing_failed");
    if (!["\0", "0", "5", "x", "g", "L", "K"].includes(type)) fail("release_artifact_non_regular_entry");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

function artifactFile(artifact, name) {
  for (const candidate of [name, `./${name}`]) {
    const result = spawnSync("tar", ["-xOf", artifact, candidate], { encoding: null, maxBuffer: 16 * 1024 * 1024 });
    if (result.status === 0) return result.stdout;
  }
  fail("release_runtime_evidence_missing");
}

function edgeArtifactFiles(artifact) {
  const result = spawnSync("tar", ["-tzf", artifact], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) fail("release_artifact_listing_failed");
  const files = new Map();
  for (const rawName of result.stdout.split("\n")) {
    const name = rawName.replace(/^(?:[.]\/)+/, "").replace(/\/$/, "");
    if (name === "supabase/deno.json" || name === "supabase/deno.lock"
      || /^supabase\/functions\/.*[.]ts$/.test(name)) {
      files.set(name, artifactFile(artifact, name));
    }
  }
  return files;
}

function runtimeEvidence(artifact, hermesImage) {
  if (!DIGEST_IMAGE.test(hermesImage)) fail("release_hermes_image_digest_required");
  if (hermesImage !== PINNED_TOOLCHAIN.hermes_image) fail("release_hermes_image_not_approved");
  let toolchain;
  let packageJson;
  try {
    toolchain = JSON.parse(artifactFile(artifact, "infra/toolchain.json").toString("utf8"));
    packageJson = JSON.parse(artifactFile(artifact, "voice-controller/package.json").toString("utf8"));
  } catch {
    fail("release_runtime_evidence_invalid");
  }
  if (canonical(toolchain) !== canonical(PINNED_TOOLCHAIN)
    || packageJson.packageManager !== `bun@${PINNED_TOOLCHAIN.bun}`) fail("release_runtime_evidence_invalid");
  const lockfile = artifactFile(artifact, "voice-controller/bun.lock");
  const denoLock = artifactFile(artifact, "supabase/deno.lock");
  return {
    application: { version: PINNED_TOOLCHAIN.application_version },
    node: { version: PINNED_TOOLCHAIN.node },
    bun: { version: PINNED_TOOLCHAIN.bun },
    deno: { version: PINNED_TOOLCHAIN.deno },
    supabase_cli: { version: PINNED_TOOLCHAIN.supabase_cli },
    dependencies: {
      lockfile_path: "voice-controller/bun.lock",
      lockfile_sha256: createHash("sha256").update(lockfile).digest("hex"),
      evidence_scope: "lockfile-integrity-only",
      deno_lock_path: "supabase/deno.lock",
      deno_lock_sha256: createHash("sha256").update(denoLock).digest("hex"),
      supabase_js: PINNED_TOOLCHAIN.dependencies.supabase_js,
      postgres: PINNED_TOOLCHAIN.dependencies.postgres,
      edge_functions: computeEdgeReleaseIdentityFromFiles(edgeArtifactFiles(artifact)),
    },
    hermes: { image: hermesImage },
  };
}

function sign(value) {
  return createHmac("sha256", keyBytes()).update(canonical(value)).digest("base64url");
}

function create(args) {
  if (!args.artifact || !args.manifest || !args.commit || !args.source || !args.created || !args.hermes_image) fail("release_manifest_arguments_missing");
  if (!COMMIT.test(args.commit) || !IDENTITY.test(args.source)) fail("release_manifest_identity_invalid");
  if (!DIGEST_IMAGE.test(args.hermes_image)) fail("release_hermes_image_digest_required");
  try { if (new Date(args.created).toISOString() !== args.created) fail("release_manifest_created_at_invalid"); }
  catch { fail("release_manifest_created_at_invalid"); }
  inspectArtifact(args.artifact);
  const artifactProof = proof(args.artifact);
  const releaseId = args.commit + "-" + artifactProof.sha256;
  const runtime = runtimeEvidence(args.artifact, args.hermes_image);
  const body = {
    schema: "ligou.release-manifest",
    version: 2,
    release_id: releaseId,
    commit_sha: args.commit,
    source: { identity: args.source },
    artifact: {
      name: path.basename(args.artifact),
      format: "ligou-release-tar-gzip",
      sha256: artifactProof.sha256,
      size_bytes: artifactProof.size,
    },
    runtime,
    exclusions: EXCLUSIONS,
    created_at: args.created,
  };
  const metadata = { algorithm: "HMAC-SHA256", key_id: process.env.LIGOU_RELEASE_MANIFEST_KEY_ID ?? "v1" };
  const manifest = { ...body, signature: { ...metadata, value: sign({ ...body, signature: metadata }) } };
  writeFileSync(args.manifest, JSON.stringify(manifest) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: true, release_id: releaseId, commit_sha: args.commit }) + "\n");
}

function verify(args) {
  if (!args.artifact || !args.manifest || !args.commit || !COMMIT.test(args.commit)) fail("release_manifest_arguments_missing");
  let manifest;
  try { manifest = JSON.parse(readFileSync(args.manifest, "utf8")); }
  catch { fail("release_manifest_required"); }
  exactKeys(manifest, ["schema", "version", "release_id", "commit_sha", "source", "artifact", "runtime", "exclusions", "created_at", "signature"], "release_manifest_schema_invalid");
  exactKeys(manifest.signature, ["algorithm", "key_id", "value"], "release_manifest_signature_invalid");
  const { signature, ...body } = manifest;
  const metadata = { algorithm: signature.algorithm, key_id: signature.key_id };
  const expected = Buffer.from(sign({ ...body, signature: metadata }));
  const received = Buffer.from(typeof signature.value === "string" ? signature.value : "");
  if (signature.algorithm !== "HMAC-SHA256" || expected.length !== received.length || !timingSafeEqual(expected, received)) fail("release_manifest_signature_invalid");
  exactKeys(manifest.source, ["identity"], "release_manifest_schema_invalid");
  exactKeys(manifest.artifact, ["name", "format", "sha256", "size_bytes"], "release_manifest_schema_invalid");
  if (manifest.schema !== "ligou.release-manifest" || manifest.version !== 2 || manifest.commit_sha !== args.commit
    || !RELEASE_ID.test(manifest.release_id) || !IDENTITY.test(manifest.source.identity)
    || manifest.artifact.name !== path.basename(args.artifact)
    || manifest.artifact.format !== "ligou-release-tar-gzip"
    || canonical(manifest.exclusions) !== canonical(EXCLUSIONS)) fail("release_manifest_binding_invalid");
  const artifactProof = proof(args.artifact);
  if (manifest.artifact.size_bytes !== artifactProof.size) fail("release_artifact_size_mismatch");
  if (manifest.artifact.sha256 !== artifactProof.sha256) fail("release_artifact_checksum_mismatch");
  if (manifest.release_id !== args.commit + "-" + artifactProof.sha256) fail("release_manifest_binding_invalid");
  const expectedRuntime = runtimeEvidence(args.artifact, manifest?.runtime?.hermes?.image);
  if (canonical(manifest.runtime) !== canonical(expectedRuntime)) fail("release_runtime_evidence_invalid");
  inspectArtifact(args.artifact);
  process.stdout.write(JSON.stringify({ ok: true, release_id: manifest.release_id, commit_sha: manifest.commit_sha }) + "\n");
}

const args = argumentsFor(process.argv.slice(2));
if (args.command === "create") create(args);
else if (args.command === "verify") verify(args);
else fail("usage: release-manifest.mjs <create|verify> ...");
