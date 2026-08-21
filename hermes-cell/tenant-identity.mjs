import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const PORT_BASE = 20_000;
const PORT_BUCKETS = 20_000;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function absoluteScopedPath(value, code) {
  if (!path.isAbsolute(value) || ["/", "/opt", "/opt/ligou"].includes(value)) fail(code);
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
        if (live) try { process.kill(pid, 0); } catch { live = false; }
        if (!live && age > 1_000) { unlinkSync(lockPath); continue; }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  fail("tenant_port_registry_locked");
}
function releaseLock(lockPath, fd) { try { closeSync(fd); } finally { try { unlinkSync(lockPath); } catch {} } }
function loadRegistry(registryPath, portBase, portBuckets) {
  try {
    const value = JSON.parse(readFileSync(registryPath, "utf8"));
    if (value?.schema !== "ligou.tenant-runtime-registry" || value?.version !== 2
      || value.port_base !== portBase || value.port_buckets !== portBuckets
      || !value.tenants || typeof value.tenants !== "object" || Array.isArray(value.tenants)) fail("tenant_port_registry_invalid");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {
      schema: "ligou.tenant-runtime-registry", version: 2,
      port_base: portBase, port_buckets: portBuckets, tenants: {},
    };
    if (error?.code?.startsWith?.("tenant_")) throw error;
    fail("tenant_port_registry_invalid");
  }
}
function persistRegistry(registryPath, registry) {
  const temporary = `${registryPath}.next.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, registryPath);
}
function preferredPort(tenantId, portBase, portBuckets) {
  const seed = createHash("sha256").update(`ligou-hermes:${tenantId}`).digest().readUInt32BE(0);
  return portBase + (seed % portBuckets);
}
function validateBinding(registry, tenantId, tenantSlug) {
  const existing = registry.tenants[tenantId];
  if (existing && existing.slug !== tenantSlug) fail("tenant_slug_mismatch");
  if (Object.entries(registry.tenants).some(([id, value]) => id !== tenantId && value?.slug === tenantSlug)) fail("tenant_slug_reused");
}
function allocate(registry, tenantId, tenantSlug, preferred, portBase, portBuckets) {
  validateBinding(registry, tenantId, tenantSlug);
  const existing = registry.tenants[tenantId];
  if (existing) {
    if (!Number.isSafeInteger(existing.host_port) || existing.host_port < portBase || existing.host_port >= portBase + portBuckets) fail("tenant_port_registry_invalid");
    if (Object.entries(registry.tenants).some(([id, value]) => id !== tenantId && value?.host_port === existing.host_port)) fail("tenant_port_registry_collision");
    return { record: existing, changed: false };
  }
  const used = new Set(Object.values(registry.tenants).map((value) => value?.host_port));
  const offset = preferred - portBase;
  for (let probe = 0; probe < portBuckets; probe += 1) {
    const candidate = portBase + ((offset + probe) % portBuckets);
    if (!used.has(candidate)) {
      const record = { slug: tenantSlug, host_port: candidate, preferred_host_port: preferred,
        cognitive_volume: `ligou-${tenantId}-hermes-cognitive` };
      registry.tenants[tenantId] = record;
      return { record, changed: true };
    }
  }
  fail("tenant_port_registry_exhausted");
}
function settings(options = {}) {
  const stateRoot = absoluteScopedPath(options.stateRoot ?? process.env.LIGOU_TENANT_STATE_ROOT ?? "/opt/ligou/tenants", "tenant_state_root_invalid");
  const registryPath = absoluteScopedPath(options.registryPath ?? process.env.LIGOU_TENANT_REGISTRY ?? "/opt/ligou/tenant-runtime-registry.json", "tenant_registry_path_invalid");
  const portBase = numericSetting("LIGOU_TENANT_PORT_BASE", PORT_BASE, 60_000);
  const portBuckets = numericSetting("LIGOU_TENANT_PORT_BUCKETS", PORT_BUCKETS, 40_000);
  if (portBase + portBuckets - 1 > 65_535) fail("tenant_port_registry_config_invalid");
  return { stateRoot, registryPath, portBase, portBuckets };
}

export function resolveTenantIdentity(tenantId, tenantSlug, options = {}) {
  if (!UUID.test(tenantId)) fail("tenant_id_invalid");
  if (!SLUG.test(tenantSlug)) fail("tenant_slug_invalid");
  const { stateRoot, registryPath, portBase, portBuckets } = settings(options);
  const lockPath = `${registryPath}.lock`, lockFd = acquireLock(lockPath);
  let record;
  const preferred = preferredPort(tenantId, portBase, portBuckets);
  try {
    const registry = loadRegistry(registryPath, portBase, portBuckets);
    const allocation = allocate(registry, tenantId, tenantSlug, preferred, portBase, portBuckets);
    record = allocation.record;
    const allowed = new RegExp(`^ligou-${tenantId}-hermes-cognitive(?:-stage-[a-f0-9]{64})?$`);
    if (!allowed.test(record.cognitive_volume)) fail("tenant_cognitive_volume_invalid");
    if (allocation.changed) persistRegistry(registryPath, registry);
  } finally { releaseLock(lockPath, lockFd); }
  const prefix = `ligou-${tenantId}`, tenantRoot = path.join(stateRoot, tenantId);
  return {
    tenant_id: tenantId, tenant_slug: tenantSlug,
    compose_project: prefix, container_name: `ligou-cell-${tenantId}`,
    cognitive_volume: record.cognitive_volume, model_auth_volume: `${prefix}-hermes-model-auth`,
    network: `${prefix}-cell`, host_port: record.host_port, preferred_host_port: preferred,
    hermes_url: `http://127.0.0.1:${record.host_port}`, tenant_root: tenantRoot,
    projected_rules_path: path.join(tenantRoot, "projected-rules"), backup_work_dir: path.join(tenantRoot, "backups"),
    restore_work_dir: path.join(tenantRoot, "restore"), archive_prefix: `hermes-${tenantId}`,
  };
}

export function activateTenantCognitiveVolume(tenantId, tenantSlug, nextVolume, expectedVolume, options = {}) {
  if (!UUID.test(tenantId) || !SLUG.test(tenantSlug)) fail("tenant_identity_invalid");
  const allowed = new RegExp(`^ligou-${tenantId}-hermes-cognitive(?:-stage-[a-f0-9]{64})?$`);
  if (!allowed.test(nextVolume) || !allowed.test(expectedVolume)) fail("tenant_cognitive_volume_invalid");
  const { registryPath, portBase, portBuckets } = settings(options);
  const lockPath = `${registryPath}.lock`, lockFd = acquireLock(lockPath);
  try {
    const registry = loadRegistry(registryPath, portBase, portBuckets);
    validateBinding(registry, tenantId, tenantSlug);
    const record = registry.tenants[tenantId];
    if (!record || record.cognitive_volume !== expectedVolume) fail("tenant_cognitive_compare_failed");
    record.cognitive_volume = nextVolume;
    persistRegistry(registryPath, registry);
  } finally { releaseLock(lockPath, lockFd); }
  return resolveTenantIdentity(tenantId, tenantSlug, options);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = process.argv.slice(2), idAt = args.indexOf("--tenant-id"), slugAt = args.indexOf("--tenant-slug");
    if (idAt !== 0 || slugAt !== 2 || !args[1] || !args[3]) fail("tenant_identity_arguments_invalid");
    const tenantId = args[1], tenantSlug = args[3], activateAt = args.indexOf("--activate-cognitive");
    let identity;
    if (activateAt >= 0) {
      const expectedAt = args.indexOf("--expected");
      if (activateAt !== 4 || expectedAt !== 6 || !args[5] || !args[7] || args[8] !== "--json" || args.length !== 9) fail("tenant_cognitive_arguments_invalid");
      resolveTenantIdentity(tenantId, tenantSlug);
      identity = activateTenantCognitiveVolume(tenantId, tenantSlug, args[5], args[7]);
      process.stdout.write(`${JSON.stringify(identity)}\n`);
    } else {
      identity = resolveTenantIdentity(tenantId, tenantSlug);
      if (args[4] === "--json" && args.length === 5) process.stdout.write(`${JSON.stringify(identity)}\n`);
      else if (args[4] === "--field" && args[5] && args.length === 6 && Object.hasOwn(identity, args[5])) process.stdout.write(`${identity[args[5]]}\n`);
      else fail("tenant_identity_field_invalid");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "tenant_identity_failed"}\n`);
    process.exit(1);
  }
}
