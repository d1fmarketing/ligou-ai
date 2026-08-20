import { readFileSync } from "node:fs";
import path from "node:path";

function fail(code) {
  process.stderr.write(String(code) + "\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
if (rootIndex < 0 || !args[rootIndex + 1] || !args.includes("--json")) {
  fail("usage: validate-config.mjs --root <repo> --json");
}
const root = path.resolve(args[rootIndex + 1]);
const read = (relative) => {
  try { return readFileSync(path.join(root, relative), "utf8"); }
  catch { fail("required_config_missing:" + relative); }
};
const readOptional = (relative) => {
  try { return readFileSync(path.join(root, relative), "utf8"); }
  catch { return ""; }
};

const compose = read("hermes-cell/docker-compose.yml");
const environmentExample = readOptional("hermes-cell/.env.example");
const runtimeConfig = read("hermes-cell/config/config.yaml");
const cliConfig = read("hermes-cell/config/cli-config.yaml");
const backup = read("infra/backup.sh");
const toolchain = JSON.parse(read("infra/toolchain.json"));
const image = process.env.HERMES_IMAGE ?? "";

if (/\b(?:CELL_)?OPENAI_API_KEY\b/.test(compose + "\n" + environmentExample)) {
  fail("reasoning_api_key_forbidden");
}
if (![runtimeConfig, cliConfig].every((value) => /provider:\s*["']?openai-codex["']?/i.test(value))) {
  fail("oauth_provider_required");
}
if (!/^[^\s@]+(?:[:][^\s@]+)?@sha256:[a-f0-9]{64}$/.test(image)) {
  fail("hermes_image_digest_required");
}
if (image !== toolchain.hermes_image) fail("hermes_image_not_approved");
for (const required of [
  "LIGOU_COMPOSE_PROJECT", "HERMES_CONTAINER_NAME", "HERMES_COGNITIVE_VOLUME",
  "HERMES_MODEL_AUTH_VOLUME", "HERMES_NETWORK", "HERMES_HOST_PORT",
]) {
  if (!compose.includes("${" + required + ":?")) fail("tenant_isolation_required");
}
if (!compose.includes("image: ${HERMES_IMAGE:?")) fail("hermes_image_digest_required");

const cognitive = compose.match(/^\s*-\s*([a-z0-9_-]+):\/opt\/data\b/im)?.[1];
const modelAuth = compose.match(/^\s*-\s*([a-z0-9_-]+):\/root\/\.hermes\b/im)?.[1];
if (!cognitive || !modelAuth || cognitive === modelAuth) fail("state_auth_volume_separation_required");
if (new RegExp("(?:" + modelAuth + "|/root/\\.hermes|auth\\.json)", "i").test(backup)) {
  fail("backup_includes_model_auth");
}

process.stdout.write(JSON.stringify({
  ok: true,
  provider: "openai-codex",
  oauth_only: true,
  tenant_isolation: true,
  image,
  image_immutable: true,
  volumes: { cognitive: "HERMES_COGNITIVE_VOLUME", model_auth: "HERMES_MODEL_AUTH_VOLUME" },
  cognitive_backup_excludes_model_auth: true,
}) + "\n");
