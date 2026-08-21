import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const SAFE_ARCHIVE_PATH = /^[A-Za-z0-9._/-]+$/;

function fail(code) {
  throw new Error(code);
}

function argumentsFor(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) fail("bootstrap_closure_arguments_invalid");
    const key = flag.slice(2);
    if (!new Set(["root", "entry"]).has(key) || Object.hasOwn(out, key)) fail("bootstrap_closure_arguments_invalid");
    out[key] = value;
  }
  if (!out.root || !out.entry) fail("bootstrap_closure_arguments_missing");
  return out;
}

function localRelativeSpecifiers(source) {
  const specifiers = [];
  const pattern = /\b(?:import|export)\s*(?:\(\s*)?(?:[^"'();]*?\s+from\s*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1].startsWith(".")) specifiers.push(match[1]);
  }
  return specifiers;
}

function containedRelativePath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("bootstrap_closure_import_escape");
  }
  const archivePath = relative.split(path.sep).join("/");
  if (!SAFE_ARCHIVE_PATH.test(archivePath)) fail("bootstrap_closure_path_unsafe");
  return archivePath;
}

export function localModuleClosure(rootInput, entryInput) {
  const root = realpathSync(path.resolve(rootInput));
  if (path.isAbsolute(entryInput) || entryInput.includes("\\")) fail("bootstrap_closure_entry_invalid");
  const entry = path.resolve(root, entryInput);
  containedRelativePath(root, entry);
  const pending = [entry];
  const included = new Map();

  while (pending.length) {
    const current = pending.pop();
    const archivePath = containedRelativePath(root, current);
    if (included.has(archivePath)) continue;
    let stat;
    try { stat = lstatSync(current); }
    catch { fail("bootstrap_closure_module_missing"); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail("bootstrap_closure_module_invalid");
    const resolved = realpathSync(current);
    containedRelativePath(root, resolved);
    included.set(archivePath, true);
    const source = readFileSync(current, "utf8");
    for (const specifier of localRelativeSpecifiers(source)) {
      if (specifier.includes("\\") || specifier.includes("?") || specifier.includes("#")) {
        fail("bootstrap_closure_import_invalid");
      }
      pending.push(path.resolve(path.dirname(current), specifier));
    }
  }

  return [...included.keys()].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = argumentsFor(process.argv.slice(2));
    process.stdout.write(localModuleClosure(args.root, args.entry).join(" ") + "\n");
  } catch (error) {
    process.stderr.write(`${error?.message ?? "bootstrap_closure_failed"}\n`);
    process.exit(1);
  }
}
