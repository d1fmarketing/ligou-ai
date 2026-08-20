import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARD_MAX_FILES = 10_000;
const HARD_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function configuredLimit(name, hardMaximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return hardMaximum;
  if (!/^[1-9][0-9]*$/.test(raw)) fail("archive_limit_invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > hardMaximum) fail("archive_limit_invalid");
  return value;
}

function forbiddenEntry(entry) {
  if (!entry || /[\u0000-\u001f\u007f]/.test(entry) || entry.startsWith("/") || entry.includes("\\")) return true;
  const segments = entry.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment === ".")) return true;
  const lower = segments.map((segment) => segment.toLowerCase());
  const basename = lower.at(-1) ?? "";
  if (lower.some((segment) => [".hermes", ".codex", ".ssh", "hermes-model-auth", "model-auth", "credentials", "secrets", "tokens"].includes(segment))) return true;
  if (lower.some((segment) => segment === ".env" || segment.startsWith(".env."))) return true;
  if (["auth.json", "credentials.json", "id_rsa", "id_ed25519", "docker.sock"].includes(basename)) return true;
  if (lower.some((segment) => /credential|secret|access[_-]?token|refresh[_-]?token/.test(segment))) return true;
  if (/\.(?:zip|tar|tgz|gz|7z|rar)$/.test(basename)) return true;
  return false;
}

function endOfCentralDirectory(bytes) {
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  fail("archive_directory_invalid");
}

function classifyEntry(versionMadeBy, externalAttributes, name) {
  const host = versionMadeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & 0o170000;
  if (host === 3 && unixType !== 0) {
    if (unixType === 0o100000) return "file";
    if (unixType === 0o040000) return "directory";
    if (unixType === 0o120000) return "symlink";
    return "other";
  }
  if (name.endsWith("/") || (externalAttributes & 0x10) !== 0) return "directory";
  return "file";
}

export function inspectArchive(archive) {
  let bytes;
  try {
    if (!statSync(archive).isFile()) fail("archive_invalid");
    bytes = readFileSync(archive);
  } catch (error) {
    if (error?.code?.startsWith?.("archive_")) throw error;
    fail("archive_required");
  }
  const maxFiles = configuredLimit("LIGOU_ARCHIVE_MAX_FILES", HARD_MAX_FILES);
  const maxExpandedBytes = configuredLimit("LIGOU_ARCHIVE_MAX_EXPANDED_BYTES", HARD_MAX_EXPANDED_BYTES);
  const eocd = endOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0
    || entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff
    || centralOffset + centralSize > eocd) fail("archive_directory_invalid");

  let offset = centralOffset;
  let files = 0;
  let expanded = 0;
  const names = new Set();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) fail("archive_directory_invalid");
    const versionMadeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length || (flags & 1) !== 0) fail("archive_directory_invalid");
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name.includes("\ufffd") || forbiddenEntry(name)) fail("archive_forbidden_path");
    const normalized = name.replace(/\/$/, "");
    if (names.has(normalized)) fail("archive_duplicate_entry");
    names.add(normalized);
    const type = classifyEntry(versionMadeBy, externalAttributes, name);
    if (type === "symlink") {
      const target = spawnSync("unzip", ["-p", archive, name], { encoding: "utf8", maxBuffer: 4096 });
      if (target.status !== 0 || !target.stdout || path.isAbsolute(target.stdout)
        || path.resolve("/archive", path.dirname(name), target.stdout).startsWith("/archive/") === false) {
        fail("archive_unsafe_link_target");
      }
      fail("archive_non_regular_entry");
    }
    if (type !== "file" && type !== "directory") fail("archive_non_regular_entry");
    if (type === "file") {
      files += 1;
      expanded += uncompressedSize;
      if (files > maxFiles) fail("archive_file_limit_exceeded");
      if (expanded > maxExpandedBytes) fail("archive_expanded_size_limit_exceeded");
    }
    offset = end;
  }
  if (offset !== centralOffset + centralSize || files === 0) fail("archive_directory_invalid");
  return {
    file_count: files,
    expanded_size_bytes: expanded,
    limits: { max_files: maxFiles, max_expanded_bytes: maxExpandedBytes },
  };
}

export function extractAndScan(archive, destination) {
  const expected = inspectArchive(archive);
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const extracted = spawnSync("unzip", ["-qq", archive, "-d", destination], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (extracted.status !== 0) fail("archive_extraction_failed");
  const root = realpathSync(destination);
  let files = 0;
  let expanded = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = lstatSync(absolute);
      const resolved = realpathSync(absolute);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) fail("archive_extracted_path_escape");
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) fail("archive_extracted_entry_invalid");
      if (stat.isDirectory()) walk(absolute);
      else {
        files += 1;
        expanded += stat.size;
        if (files > expected.limits.max_files) fail("archive_file_limit_exceeded");
        if (expanded > expected.limits.max_expanded_bytes) fail("archive_expanded_size_limit_exceeded");
      }
    }
  };
  walk(root);
  if (files !== expected.file_count || expanded !== expected.expanded_size_bytes) fail("archive_extracted_content_mismatch");
  return expected;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const [command, archive, destination] = process.argv.slice(2);
    const result = command === "inspect" && archive && !destination
      ? inspectArchive(archive)
      : command === "extract" && archive && destination
        ? extractAndScan(archive, destination)
        : fail("usage: archive-safety.mjs <inspect archive|extract archive destination>");
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "archive_validation_failed"}\n`);
    process.exit(1);
  }
}
