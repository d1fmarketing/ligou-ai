import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = path.join(root, "supabase/deno.json");
const lock = path.join(root, "supabase/deno.lock");
const toolchain = JSON.parse(readFileSync(path.join(root, "infra/toolchain.json"), "utf8"));
const deno = process.env.LIGOU_DENO_BIN ?? "deno";
const functionsRoot = path.join(root, "supabase/functions");
const entries = readdirSync(functionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
  .map((entry) => path.join(functionsRoot, entry.name, "index.ts"))
  .sort();
const additional = [path.join(root, "supabase/scripts/migrate-connector-tokens.ts")];
if (!entries.length) {
  process.stderr.write("edge_functions_missing\n");
  process.exit(1);
}

const scratch = mkdtempSync(path.join(os.tmpdir(), "ligou-edge-check."));
const cleanEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  DENO_DIR: process.env.LIGOU_DENO_DIR ?? path.join(os.tmpdir(), `ligou-deno-${toolchain.deno}`),
};
if (process.env.LIGOU_DENO_TEST_LOG) cleanEnv.DENO_TEST_LOG = process.env.LIGOU_DENO_TEST_LOG;
try {
  const version = spawnSync(deno, ["--version"], { encoding: "utf8", env: cleanEnv, cwd: scratch });
  if (version.status !== 0 || !version.stdout.startsWith(`deno ${toolchain.deno} (`)) {
    process.stderr.write("deno_version_mismatch\n");
    process.exit(1);
  }
  const checked = spawnSync(deno, [
    "check", "--frozen", "--config", config, "--lock", lock, ...entries, ...additional,
  ], { encoding: "utf8", env: cleanEnv, cwd: scratch, maxBuffer: 16 * 1024 * 1024 });
  if (checked.status !== 0) {
    process.stderr.write(checked.stderr || "edge_function_check_failed\n");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, deno: toolchain.deno, functions: entries.length, additional: additional.length, frozen: true })}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
