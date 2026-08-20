import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
];
const COMMIT = /^[a-f0-9]{40}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RELEASE_ID = /^[a-f0-9]{12}-[a-f0-9]{12}$/;

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
}

function sign(value) {
  return createHmac("sha256", keyBytes()).update(canonical(value)).digest("base64url");
}

function create(args) {
  if (!args.artifact || !args.manifest || !args.commit || !args.source || !args.created) fail("release_manifest_arguments_missing");
  if (!COMMIT.test(args.commit) || !IDENTITY.test(args.source)) fail("release_manifest_identity_invalid");
  try { if (new Date(args.created).toISOString() !== args.created) fail("release_manifest_created_at_invalid"); }
  catch { fail("release_manifest_created_at_invalid"); }
  inspectArtifact(args.artifact);
  const artifactProof = proof(args.artifact);
  const releaseId = args.commit.slice(0, 12) + "-" + artifactProof.sha256.slice(0, 12);
  const body = {
    schema: "ligou.release-manifest",
    version: 1,
    release_id: releaseId,
    commit_sha: args.commit,
    source: { identity: args.source },
    artifact: {
      name: path.basename(args.artifact),
      format: "ligou-release-tar-gzip",
      sha256: artifactProof.sha256,
      size_bytes: artifactProof.size,
    },
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
  exactKeys(manifest, ["schema", "version", "release_id", "commit_sha", "source", "artifact", "exclusions", "created_at", "signature"], "release_manifest_schema_invalid");
  exactKeys(manifest.signature, ["algorithm", "key_id", "value"], "release_manifest_signature_invalid");
  const { signature, ...body } = manifest;
  const metadata = { algorithm: signature.algorithm, key_id: signature.key_id };
  const expected = Buffer.from(sign({ ...body, signature: metadata }));
  const received = Buffer.from(typeof signature.value === "string" ? signature.value : "");
  if (signature.algorithm !== "HMAC-SHA256" || expected.length !== received.length || !timingSafeEqual(expected, received)) fail("release_manifest_signature_invalid");
  exactKeys(manifest.source, ["identity"], "release_manifest_schema_invalid");
  exactKeys(manifest.artifact, ["name", "format", "sha256", "size_bytes"], "release_manifest_schema_invalid");
  if (manifest.schema !== "ligou.release-manifest" || manifest.version !== 1 || manifest.commit_sha !== args.commit
    || !RELEASE_ID.test(manifest.release_id) || !IDENTITY.test(manifest.source.identity)
    || manifest.artifact.name !== path.basename(args.artifact)
    || manifest.artifact.format !== "ligou-release-tar-gzip"
    || canonical(manifest.exclusions) !== canonical(EXCLUSIONS)) fail("release_manifest_binding_invalid");
  const artifactProof = proof(args.artifact);
  if (manifest.artifact.size_bytes !== artifactProof.size) fail("release_artifact_size_mismatch");
  if (manifest.artifact.sha256 !== artifactProof.sha256) fail("release_artifact_checksum_mismatch");
  if (manifest.release_id !== args.commit.slice(0, 12) + "-" + artifactProof.sha256.slice(0, 12)) fail("release_manifest_binding_invalid");
  inspectArtifact(args.artifact);
  process.stdout.write(JSON.stringify({ ok: true, release_id: manifest.release_id, commit_sha: manifest.commit_sha }) + "\n");
}

const args = argumentsFor(process.argv.slice(2));
if (args.command === "create") create(args);
else if (args.command === "verify") verify(args);
else fail("usage: release-manifest.mjs <create|verify> ...");
