import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTenantIdentity } from "./tenant-identity.mjs";

const DIGEST_IMAGE = /^[^\s@]+(?:[:][^\s@]+)?@sha256:[a-f0-9]{64}$/;
const PRIVATE_ECR_IMAGE = /^(?<registry>[0-9]{12}[.]dkr[.]ecr[.](?<region>[a-z0-9-]+)[.]amazonaws[.]com)\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const approvedImage = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../infra/toolchain.json"), "utf8")).hermes_image;

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

export function tenantRuntime(tenantId, tenantSlug, image = "") {
  return {
    ...resolveTenantIdentity(tenantId, tenantSlug),
    image,
  };
}

function imageExists(image) {
  return spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0;
}

function ensureImageAvailable(image) {
  if (imageExists(image)) return;
  const ecr = image.match(PRIVATE_ECR_IMAGE);
  if (!ecr?.groups?.registry || !ecr?.groups?.region) fail("hermes_image_unavailable");
  const password = spawnSync("aws", ["ecr", "get-login-password", "--region", ecr.groups.region], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 1024 * 1024,
  });
  if (password.status !== 0 || !password.stdout?.trim()) fail("hermes_ecr_login_failed");
  const login = spawnSync("docker", ["login", "--username", "AWS", "--password-stdin", ecr.groups.registry], {
    input: password.stdout,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"],
  });
  if (login.status !== 0) fail("hermes_ecr_login_failed");
  const pull = spawnSync("docker", ["pull", image], { stdio: "inherit" });
  const verified = pull.status === 0 && imageExists(image);
  spawnSync("docker", ["logout", ecr.groups.registry], { stdio: "ignore" });
  if (!verified) fail("hermes_image_pull_failed");
}

const isMain = (() => {
  // Production invokes these tools through the /opt/ligou/current symlink while Node
  // resolves the main module by realpath, so compare realpaths or the CLI no-ops.
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  const tenantId = process.env.TENANT_ID ?? "";
  const tenantSlug = process.env.TENANT_SLUG ?? "";
  let runtime;
  try { runtime = tenantRuntime(tenantId, tenantSlug, process.env.HERMES_IMAGE ?? ""); }
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
  ensureImageAvailable(runtime.image);
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
