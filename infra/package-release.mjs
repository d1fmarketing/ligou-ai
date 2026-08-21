import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ALLOWED_ROOTS = new Set(["voice-controller", "hermes-cell", "supabase", "infra"]);
const BUILD_OR_DEPENDENCY = new Set(["node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache", "vendor"]);
const ARCHIVE = /\.(?:zip|tar|tgz|gz|7z|rar)$/i;
const BUILDER_ONLY = new Set([
  "infra/deploy.sh",
  "infra/package-release.mjs",
  "infra/pull-env.sh",
]);

function fail(code) {
  process.stderr.write(String(code) + "\n");
  process.exit(1);
}

function argumentsFor(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) fail("package_arguments_invalid");
    const key = flag.slice(2);
    if (!new Set(["root", "output", "commit"]).has(key) || Object.hasOwn(out, key)) fail("package_arguments_invalid");
    out[key] = value;
  }
  if (!out.root || !out.output || !out.commit) fail("package_arguments_missing");
  return out;
}

export function excludedReleasePath(candidate) {
  if (typeof candidate !== "string" || !candidate || candidate.startsWith("/") || candidate.includes("\\") || /[\u0000-\u001f\u007f]/.test(candidate)) return true;
  const segments = candidate.replace(/\/$/, "").split("/");
  if (!ALLOWED_ROOTS.has(segments[0]) || segments.some((segment) => segment === "..")) return true;
  const lower = segments.map((segment) => segment.toLowerCase());
  const basename = lower.at(-1) ?? "";
  const normalized = candidate.replace(/\/$/, "");
  if (normalized.startsWith("voice-controller/scripts/")
    || normalized.startsWith("voice-controller/test/")
    || normalized.startsWith("hermes-cell/test/")
    || normalized.startsWith("supabase/scripts/")
    || normalized.startsWith("supabase/tests/")
    || normalized.startsWith("infra/test/")
    || BUILDER_ONLY.has(normalized)) return true;
  if (lower.some((segment) => BUILD_OR_DEPENDENCY.has(segment))) return true;
  if (candidate.toLowerCase().startsWith("supabase/.temp/") || candidate.toLowerCase() === "supabase/.temp") return true;
  if (lower.some((segment) => segment === ".env" || segment.startsWith(".env."))) return true;
  if (lower.some((segment) => segment.startsWith("._"))) return true;
  if (lower.some((segment) => [".git", ".hermes", ".codex", ".ssh", "hermes-model-auth", "credentials", "secrets"].includes(segment))) return true;
  if (["auth.json", "credentials.json", "id_rsa", "id_ed25519", "docker.sock"].includes(basename)) return true;
  if (ARCHIVE.test(basename)) return true;
  return false;
}

const args = argumentsFor(process.argv.slice(2));
const root = path.resolve(args.root);
const output = path.resolve(args.output);
if (!/^[a-f0-9]{40}$/.test(args.commit)) fail("package_commit_invalid");
const resolved = spawnSync("git", ["rev-parse", args.commit + "^{commit}"], { cwd: root, encoding: "utf8" });
if (resolved.status !== 0 || resolved.stdout.trim() !== args.commit) fail("package_commit_unavailable");
const listed = spawnSync("git", ["ls-tree", "-r", "-z", "--name-only", args.commit, "--", ...ALLOWED_ROOTS], {
  cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
if (listed.status !== 0) fail("package_tree_unavailable");
const files = listed.stdout.split("\0").filter(Boolean).filter((candidate) => !excludedReleasePath(candidate));
if (!files.length) fail("package_empty");
const archived = spawnSync("git", ["archive", "--format=tar.gz", "--output", output, args.commit, ...files], {
  cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
if (archived.status !== 0) fail("package_archive_failed");
const inspected = spawnSync("tar", ["-tzf", output], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (inspected.status !== 0) fail("package_archive_invalid");
const entries = inspected.stdout.split("\n").filter(Boolean);
if (!entries.length || entries.some(excludedReleasePath)) fail("package_forbidden_entry");
const bytes = readFileSync(output);
const stat = statSync(output);
process.stdout.write(JSON.stringify({
  ok: true,
  commit_sha: args.commit,
  artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
  size_bytes: stat.size,
  file_count: files.length,
}) + "\n");
