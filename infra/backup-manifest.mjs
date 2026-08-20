import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectArchive } from "./archive-safety.mjs";

const EXCLUSIONS = [
  "**/.env*",
  "**/auth.json",
  "**/.hermes/**",
  "**/.codex/**",
  "**/*credential*",
  "**/*secret*",
  "**/*token*",
  "hermes-model-auth/**",
];
const TENANT = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_IMAGE = /^[^\s@]+(?:[:][^\s@]+)?@sha256:[a-f0-9]{64}$/;

function fail(code) {
  process.stderr.write(String(code) + "\n");
  process.exit(1);
}

function parseArguments(values) {
  const command = values[0];
  const parsed = { command };
  for (let index = 1; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) fail("manifest_arguments_invalid");
    const key = flag.slice(2).replace(/-/g, "_");
    if (Object.hasOwn(parsed, key)) fail("manifest_argument_duplicate");
    parsed[key] = value;
  }
  return parsed;
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) fail(code);
}

function decodeKey() {
  const encoded = process.env.LIGOU_BACKUP_MANIFEST_KEY ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) fail("manifest_key_invalid");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) fail("manifest_key_must_be_32_bytes");
  return key;
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function archiveProof(archive) {
  let bytes;
  let stat;
  try { bytes = readFileSync(archive); stat = statSync(archive); }
  catch { fail("archive_required"); }
  if (!stat.isFile() || stat.size < 1) fail("archive_invalid");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: stat.size };
}

function sign(body, key) {
  return createHmac("sha256", key).update(canonical(body)).digest("base64url");
}

function createManifest(args) {
  if (!args.archive || !args.manifest || !args.tenant || !args.source || !args.created || !args.hermes_image) fail("manifest_arguments_missing");
  if (!TENANT.test(args.tenant) || !IDENTITY.test(args.source) || !DIGEST_IMAGE.test(args.hermes_image)) fail("manifest_identity_invalid");
  if (new Date(args.created).toISOString() !== args.created) fail("manifest_created_at_invalid");
  let inspection;
  try { inspection = inspectArchive(args.archive); }
  catch (error) { fail(error instanceof Error ? error.message : "archive_validation_failed"); }
  const proof = archiveProof(args.archive);
  const body = {
    schema: "ligou.hermes.backup-manifest",
    version: 2,
    tenant: args.tenant,
    source: { identity: args.source },
    archive: {
      name: path.basename(args.archive),
      format: "hermes-cognitive-zip",
      sha256: proof.sha256,
      size_bytes: proof.size,
      expanded_size_bytes: inspection.expanded_size_bytes,
      file_count: inspection.file_count,
    },
    limits: inspection.limits,
    runtime: { hermes_image: args.hermes_image },
    exclusions: EXCLUSIONS,
    created_at: args.created,
  };
  const key = decodeKey();
  const signatureMetadata = {
    algorithm: "HMAC-SHA256",
    key_id: process.env.LIGOU_BACKUP_MANIFEST_KEY_ID ?? "v1",
  };
  const manifest = {
    ...body,
    signature: {
      ...signatureMetadata,
      value: sign({ ...body, signature: signatureMetadata }, key),
    },
  };
  writeFileSync(args.manifest, JSON.stringify(manifest) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: true, tenant: args.tenant, archive: body.archive.name }) + "\n");
}

function verifyManifest(args) {
  if (!args.archive || !args.manifest || !args.tenant || !args.hermes_image) fail("manifest_arguments_missing");
  if (!TENANT.test(args.tenant) || !DIGEST_IMAGE.test(args.hermes_image)) fail("manifest_identity_invalid");
  let manifest;
  try { manifest = JSON.parse(readFileSync(args.manifest, "utf8")); }
  catch { fail("manifest_required"); }
  exactKeys(manifest, ["schema", "version", "tenant", "source", "archive", "limits", "runtime", "exclusions", "created_at", "signature"], "manifest_schema_invalid");
  exactKeys(manifest.signature, ["algorithm", "key_id", "value"], "manifest_signature_invalid");
  const { signature, ...body } = manifest;
  const signatureMetadata = { algorithm: signature.algorithm, key_id: signature.key_id };
  const expected = Buffer.from(sign({ ...body, signature: signatureMetadata }, decodeKey()));
  const received = Buffer.from(typeof signature.value === "string" ? signature.value : "");
  if (signature.algorithm !== "HMAC-SHA256" || expected.length !== received.length || !timingSafeEqual(expected, received)) {
    fail("manifest_signature_invalid");
  }
  exactKeys(manifest.source, ["identity"], "manifest_schema_invalid");
  exactKeys(manifest.archive, ["name", "format", "sha256", "size_bytes", "expanded_size_bytes", "file_count"], "manifest_schema_invalid");
  exactKeys(manifest.limits, ["max_files", "max_expanded_bytes"], "manifest_schema_invalid");
  exactKeys(manifest.runtime, ["hermes_image"], "manifest_schema_invalid");
  if (manifest.schema !== "ligou.hermes.backup-manifest" || manifest.version !== 2
    || manifest.tenant !== args.tenant || !IDENTITY.test(manifest.source.identity)
    || manifest.archive.name !== path.basename(args.archive)
    || manifest.archive.format !== "hermes-cognitive-zip"
    || manifest.runtime.hermes_image !== args.hermes_image
    || new Date(manifest.created_at).toISOString() !== manifest.created_at
    || canonical(manifest.exclusions) !== canonical(EXCLUSIONS)) {
    fail("manifest_binding_invalid");
  }
  const proof = archiveProof(args.archive);
  if (manifest.archive.size_bytes !== proof.size) fail("archive_size_mismatch");
  if (manifest.archive.sha256 !== proof.sha256) fail("archive_checksum_mismatch");
  let inspection;
  try { inspection = inspectArchive(args.archive); }
  catch (error) { fail(error instanceof Error ? error.message : "archive_validation_failed"); }
  if (manifest.archive.expanded_size_bytes !== inspection.expanded_size_bytes
    || manifest.archive.file_count !== inspection.file_count
    || canonical(manifest.limits) !== canonical(inspection.limits)) fail("archive_limits_mismatch");
  process.stdout.write(JSON.stringify({ ok: true, tenant: args.tenant, archive: manifest.archive.name }) + "\n");
}

const args = parseArguments(process.argv.slice(2));
if (args.command === "create") createManifest(args);
else if (args.command === "verify") verifyManifest(args);
else fail("usage: backup-manifest.mjs <create|verify> ...");
