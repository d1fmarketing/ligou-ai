import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const CONFIG_PATHS = ["supabase/deno.json", "supabase/deno.lock"];
const ENTRY = /^supabase\/functions\/([^/_][^/]*)\/index[.]ts$/;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function localImports(source) {
  const imports = [];
  const pattern = /(?:\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?|\bimport\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) if (match[1].startsWith(".")) imports.push(match[1]);
  return imports;
}

export function computeEdgeReleaseIdentityFromFiles(inputFiles) {
  const files = inputFiles instanceof Map ? inputFiles : new Map(Object.entries(inputFiles));
  for (const required of CONFIG_PATHS) if (!files.has(required)) throw new Error("edge_release_config_missing");
  const entries = [...files.keys()].filter((candidate) => ENTRY.test(candidate)).sort();
  if (!entries.length) throw new Error("edge_release_entries_missing");
  const result = {};
  for (const entry of entries) {
    const functionName = ENTRY.exec(entry)[1];
    const included = new Set(CONFIG_PATHS);
    const pending = [entry];
    while (pending.length) {
      const current = pending.pop();
      if (included.has(current)) continue;
      const bytes = files.get(current);
      if (bytes === undefined) throw new Error("edge_release_local_import_missing");
      included.add(current);
      const source = Buffer.from(bytes).toString("utf8");
      for (const specifier of localImports(source)) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(current), specifier));
        if (!resolved.startsWith("supabase/functions/") || resolved.includes("/../")) {
          throw new Error("edge_release_local_import_escape");
        }
        if (!files.has(resolved)) throw new Error("edge_release_local_import_missing");
        pending.push(resolved);
      }
    }
    const records = [...included].sort().map((filePath) => ({
      path: filePath,
      sha256: hash(Buffer.from(files.get(filePath))),
    }));
    result[functionName] = {
      entry_path: entry,
      files: records,
      composite_sha256: hash(Buffer.from(JSON.stringify(records))),
    };
  }
  return result;
}

function walk(root, relative = "") {
  const output = new Map();
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of walk(root, next)) output.set(name, bytes);
    } else if (entry.isFile()) {
      output.set(next, readFileSync(path.join(root, next)));
    }
  }
  return output;
}

export function computeEdgeReleaseIdentity(root) {
  const selected = new Map();
  for (const [name, bytes] of walk(root, "supabase")) {
    if (CONFIG_PATHS.includes(name) || /^supabase\/functions\/.*[.]ts$/.test(name)) selected.set(name, bytes);
  }
  return computeEdgeReleaseIdentityFromFiles(selected);
}
