#!/usr/bin/env node
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function capture(source, destination, missingCode) {
  let sourceFd = -1;
  let destinationFd = -1;
  try {
    const before = lstatSync(source, { bigint: true });
    if (before.isSymbolicLink()) fail("restore_input_symlink_forbidden");
    if (!before.isFile() || before.nlink !== 1n) fail("restore_input_regular_file_required");
    sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(sourceFd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) fail("restore_input_identity_changed");
    destinationFd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let written = 0;
      while (written < count) written += writeSync(destinationFd, buffer, written, count - written);
    }
    fsyncSync(destinationFd);
    const after = fstatSync(sourceFd, { bigint: true });
    if (!sameIdentity(opened, after)) fail("restore_input_identity_changed");
    chmodSync(destination, 0o600);
  } catch (error) {
    try { unlinkSync(destination); } catch {}
    if (error?.code === "ENOENT") fail(missingCode);
    if (error?.code === "ELOOP") fail("restore_input_symlink_forbidden");
    throw error;
  } finally {
    if (sourceFd >= 0) closeSync(sourceFd);
    if (destinationFd >= 0) closeSync(destinationFd);
  }
}

export function captureRestoreInputs(archive, manifest, scratch) {
  if (![archive, manifest, scratch].every((value) => typeof value === "string" && path.isAbsolute(value))) {
    fail("restore_capture_arguments_invalid");
  }
  const scratchStat = lstatSync(scratch);
  if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) {
    fail("restore_capture_scratch_invalid");
  }
  const ownedScratch = realpathSync(scratch);
  const ownedArchive = path.join(ownedScratch, "input.zip");
  const ownedManifest = path.join(ownedScratch, "manifest.json");
  capture(archive, ownedArchive, "archive_required");
  try { capture(manifest, ownedManifest, "manifest_required"); }
  catch (error) { try { unlinkSync(ownedArchive); } catch {} throw error; }
  return { archive: ownedArchive, manifest: ownedManifest };
}

const isMain = (() => {
  // Production invokes these tools through the /opt/ligou/current symlink while Node
  // resolves the main module by realpath, so compare realpaths or the CLI no-ops.
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== "--archive" || args[2] !== "--manifest" || args[4] !== "--scratch") {
      fail("restore_capture_arguments_invalid");
    }
    process.stdout.write(`${JSON.stringify(captureRestoreInputs(args[1], args[3], args[5]))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "restore_capture_failed"}\n`);
    process.exit(1);
  }
}
