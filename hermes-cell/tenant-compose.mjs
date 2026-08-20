import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTenantIdentity } from "./tenant-identity.mjs";

const TENANT = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const DIGEST_IMAGE = /^[^\s@]+(?:[:][^\s@]+)?@sha256:[a-f0-9]{64}$/;
const approvedImage = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../infra/toolchain.json"), "utf8")).hermes_image;

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

export function tenantRuntime(tenant, image = "") {
  return {
    ...resolveTenantIdentity(tenant),
    image,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const tenant = process.env.TENANT_SLUG ?? "";
  let runtime;
  try { runtime = tenantRuntime(tenant, process.env.HERMES_IMAGE ?? ""); }
  catch (error) { fail(error instanceof Error ? error.message : "tenant_invalid"); }
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--field") {
    if (!Object.hasOwn(runtime, args[1])) fail("runtime_field_invalid");
    process.stdout.write(`${runtime[args[1]]}\n`);
    process.exit(0);
  }
  if (args.length === 1 && args[0] === "--print-runtime") {
    if (!DIGEST_IMAGE.test(runtime.image)) fail("hermes_image_digest_required");
    if (runtime.image !== approvedImage) fail("hermes_image_not_approved");
    process.stdout.write(`${JSON.stringify(runtime)}\n`);
    process.exit(0);
  }
  if (!args.length) fail("usage: tenant-compose.mjs <compose arguments> | --print-runtime");
  if (!DIGEST_IMAGE.test(runtime.image)) fail("hermes_image_digest_required");
  if (runtime.image !== approvedImage) fail("hermes_image_not_approved");
  if (!process.env.HERMES_API_KEY) fail("hermes_api_key_required");
  const composeFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "docker-compose.yml");
  const result = spawnSync("docker", ["compose", "--project-name", runtime.compose_project, "--file", composeFile, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      LIGOU_COMPOSE_PROJECT: runtime.compose_project,
      HERMES_CONTAINER_NAME: runtime.container_name,
      HERMES_COGNITIVE_VOLUME: runtime.cognitive_volume,
      HERMES_MODEL_AUTH_VOLUME: runtime.model_auth_volume,
      HERMES_NETWORK: runtime.network,
      HERMES_HOST_PORT: String(runtime.host_port),
      HERMES_PROJECTED_RULES_PATH: runtime.projected_rules_path,
    },
  });
  process.exit(result.status ?? 1);
}
