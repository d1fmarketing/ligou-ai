import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TENANT = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const DIGEST_IMAGE = /^[^\s@]+(?:[:][^\s@]+)?@sha256:[a-f0-9]{64}$/;

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

export function tenantRuntime(tenant, image = "") {
  if (!TENANT.test(tenant)) throw new Error("tenant_invalid");
  const portSeed = createHash("sha256").update(`ligou-hermes:${tenant}`).digest().readUInt32BE(0);
  const prefix = `ligou-${tenant}`;
  return {
    tenant,
    compose_project: prefix,
    container_name: `ligou-cell-${tenant}`,
    cognitive_volume: `${prefix}-hermes-cognitive`,
    model_auth_volume: `${prefix}-hermes-model-auth`,
    network: `${prefix}-cell`,
    host_port: 20_000 + (portSeed % 20_000),
    hermes_url: `http://127.0.0.1:${20_000 + (portSeed % 20_000)}`,
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
    process.stdout.write(`${JSON.stringify(runtime)}\n`);
    process.exit(0);
  }
  if (!args.length) fail("usage: tenant-compose.mjs <compose arguments> | --print-runtime");
  if (!DIGEST_IMAGE.test(runtime.image)) fail("hermes_image_digest_required");
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
    },
  });
  process.exit(result.status ?? 1);
}
