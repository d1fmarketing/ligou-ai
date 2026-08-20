import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TENANT = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const PORT_BASE = 20_000;
const PORT_BUCKETS = 20_000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function absoluteScopedPath(value, code) {
  if (!path.isAbsolute(value) || value === "/" || value === "/opt" || value === "/opt/ligou") fail(code);
  return path.resolve(value);
}

function numericSetting(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) fail("tenant_port_registry_config_invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) fail("tenant_port_registry_config_invalid");
  return value;
}

function acquireLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      return fd;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        const pid = Number(readFileSync(lockPath, "utf8").trim());
        let live = Number.isSafeInteger(pid) && pid > 1;
        if (live) {
          try { process.kill(pid, 0); } catch { live = false; }
        }
        if (!live && age > 1_000) { unlinkSync(lockPath); continue; }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  fail("tenant_port_registry_locked");
}

function releaseLock(lockPath, fd) {
  try { closeSync(fd); } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}

function loadRegistry(registryPath, portBase, portBuckets) {
  try {
    const value = JSON.parse(readFileSync(registryPath, "utf8"));
    if (value?.schema !== "ligou.tenant-runtime-registry" || value?.version !== 1
      || value.port_base !== portBase || value.port_buckets !== portBuckets
      || !value.tenants || typeof value.tenants !== "object" || Array.isArray(value.tenants)) {
      fail("tenant_port_registry_invalid");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { schema: "ligou.tenant-runtime-registry", version: 1, port_base: portBase, port_buckets: portBuckets, tenants: {} };
    }
    if (error?.code?.startsWith?.("tenant_")) throw error;
    fail("tenant_port_registry_invalid");
  }
}

function persistRegistry(registryPath, registry) {
  const temporary = `${registryPath}.next.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, registryPath);
}

function preferredPort(tenant, portBase, portBuckets) {
  const seed = createHash("sha256").update(`ligou-hermes:${tenant}`).digest().readUInt32BE(0);
  return portBase + (seed % portBuckets);
}

function allocatePort(registry, tenant, preferred, portBase, portBuckets) {
  const existing = registry.tenants[tenant];
  if (existing) {
    if (!Number.isSafeInteger(existing.host_port) || existing.host_port < portBase || existing.host_port >= portBase + portBuckets) {
      fail("tenant_port_registry_invalid");
    }
    const duplicate = Object.entries(registry.tenants).some(([slug, value]) => slug !== tenant && value?.host_port === existing.host_port);
    if (duplicate) fail("tenant_port_registry_collision");
    return { hostPort: existing.host_port, changed: false };
  }
  const used = new Set(Object.values(registry.tenants).map((value) => value?.host_port));
  const offset = preferred - portBase;
  for (let probe = 0; probe < portBuckets; probe += 1) {
    const candidate = portBase + ((offset + probe) % portBuckets);
    if (!used.has(candidate)) {
      registry.tenants[tenant] = { host_port: candidate, preferred_host_port: preferred };
      return { hostPort: candidate, changed: true };
    }
  }
  fail("tenant_port_registry_exhausted");
}

export function resolveTenantIdentity(tenant, options = {}) {
  if (!TENANT.test(tenant)) fail("tenant_invalid");
  const stateRoot = absoluteScopedPath(options.stateRoot ?? process.env.LIGOU_TENANT_STATE_ROOT ?? "/opt/ligou/tenants", "tenant_state_root_invalid");
  const registryPath = absoluteScopedPath(options.registryPath ?? process.env.LIGOU_TENANT_REGISTRY ?? "/opt/ligou/tenant-runtime-registry.json", "tenant_registry_path_invalid");
  const portBase = numericSetting("LIGOU_TENANT_PORT_BASE", PORT_BASE, 60_000);
  const portBuckets = numericSetting("LIGOU_TENANT_PORT_BUCKETS", PORT_BUCKETS, 40_000);
  if (portBase + portBuckets - 1 > 65_535) fail("tenant_port_registry_config_invalid");
  const lockPath = `${registryPath}.lock`;
  const lockFd = acquireLock(lockPath);
  let hostPort;
  const preferred = preferredPort(tenant, portBase, portBuckets);
  try {
    const registry = loadRegistry(registryPath, portBase, portBuckets);
    const allocation = allocatePort(registry, tenant, preferred, portBase, portBuckets);
    hostPort = allocation.hostPort;
    if (allocation.changed) persistRegistry(registryPath, registry);
  } finally {
    releaseLock(lockPath, lockFd);
  }
  const prefix = `ligou-${tenant}`;
  const tenantRoot = path.join(stateRoot, tenant);
  return {
    tenant,
    compose_project: prefix,
    container_name: `ligou-cell-${tenant}`,
    cognitive_volume: `${prefix}-hermes-cognitive`,
    model_auth_volume: `${prefix}-hermes-model-auth`,
    network: `${prefix}-cell`,
    host_port: hostPort,
    preferred_host_port: preferred,
    hermes_url: `http://127.0.0.1:${hostPort}`,
    tenant_root: tenantRoot,
    projected_rules_path: path.join(tenantRoot, "projected-rules"),
    backup_work_dir: path.join(tenantRoot, "backups"),
    restore_work_dir: path.join(tenantRoot, "restore"),
    archive_prefix: `hermes-${tenant}`,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = process.argv.slice(2);
    const tenantAt = args.indexOf("--tenant");
    if (tenantAt < 0 || !args[tenantAt + 1]) fail("usage: tenant-identity.mjs --tenant <slug> <--json|--field name>");
    const identity = resolveTenantIdentity(args[tenantAt + 1]);
    if (args.includes("--json") && args.length === 3) process.stdout.write(`${JSON.stringify(identity)}\n`);
    else {
      const fieldAt = args.indexOf("--field");
      if (fieldAt < 0 || !Object.hasOwn(identity, args[fieldAt + 1]) || args.length !== 4) fail("tenant_identity_field_invalid");
      process.stdout.write(`${identity[args[fieldAt + 1]]}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "tenant_identity_failed"}\n`);
    process.exit(1);
  }
}
