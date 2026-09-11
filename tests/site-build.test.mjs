import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPublicationBuildEnv, buildSite, composeSite } from "../scripts/build-site.mjs";
import { publicSiteConfig } from "../scripts/public-site-config.mjs";
import * as productionEnv from "../scripts/production-env.mjs";
import { handleSalesSession } from "../src/server/vercel-sales-session.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicUrl = "https://fixture-project.supabase.co";
const publicKey = "sb_publishable_local_fixture_only";
const buildEnv = { PATH: process.env.PATH || "/usr/bin:/bin", NODE_ENV: "production" };
const jwt = role => ["header", Buffer.from(JSON.stringify({ role })).toString("base64url"), "signature"].join(".");
const publicationEnv = { LIGOU_PUBLIC_SUPABASE_URL: publicUrl, LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
  LIGOU_PUBLIC_SUPABASE_FUNCTIONS_URL: `${publicUrl}/functions/v1`, LIGOU_PUBLIC_SESSION_URL: `${publicUrl}/functions/v1/browser-session` };

test('publication requires the four public inputs while ordinary offline build environments remain usable', () => {
  assert.equal(typeof productionEnv.validateProductionPublicationEnv, 'function');
  assert.doesNotThrow(() => productionEnv.validateProductionPublicationEnv(publicationEnv));
  for (const key of Object.keys(publicationEnv)) for (const value of [undefined, '', '   ']) {
    assert.throws(() => productionEnv.validateProductionPublicationEnv({ ...publicationEnv, [key]: value }), /production_public_env_required/);
  }
  assert.equal(productionEnv.productionBuildEnv({}).VITE_SESSION_URL, undefined);
  assert.equal(productionEnv.productionBuildEnv({ LIGOU_PUBLIC_SESSION_URL: 'http://127.0.0.1:8790/session' }).VITE_SESSION_URL, 'http://127.0.0.1:8790/session');
});

test('publication endpoint validation rejects loopback, wrong project/path and secret-bearing URLs', () => {
  for (const endpoint of ['http://localhost:8790/session', 'https://127.0.0.1/session', 'https://[::1]/session',
    'https://other-project.supabase.co/functions/v1/browser-session', `${publicUrl}/functions/v1/accept-call`,
    `${publicUrl}/functions/v1/browser-session?token=must-not-print`, `${publicUrl}/functions/v1/browser-session#fragment`]) {
    assert.throws(() => productionEnv.validateProductionPublicationEnv({ ...publicationEnv, LIGOU_PUBLIC_SESSION_URL: endpoint }),
      reason => /production_voice_endpoint_invalid/.test(reason.message) && !reason.message.includes('must-not-print'));
  }
  assert.throws(() => productionEnv.validateProductionPublicationEnv({ ...publicationEnv, LIGOU_PUBLIC_SUPABASE_FUNCTIONS_URL: 'https://other-project.supabase.co/functions/v1' }), /production_functions_endpoint_invalid/);
  assert.throws(() => productionEnv.validateProductionPublicationEnv({ ...publicationEnv, LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt('service_role') }), /public_supabase_key_invalid/);
});

test('explicit publication build rejects incomplete configuration before invoking any bundler', () => {
  assert.throws(() => buildSite({ ...publicationEnv, PATH: '/nonexistent', LIGOU_PUBLIC_SESSION_URL: '' }, { publication: true }), /production_public_env_required/);
  const run = () => execFileSync(process.execPath, [path.join(root, 'scripts/build-site.mjs'), '--production'],
    { cwd: os.tmpdir(), env: { PATH: '/nonexistent' }, encoding: 'utf8', stdio: 'pipe' });
  assert.throws(run, reason => String(reason.stderr).includes('production_public_env_required') && !String(reason.stderr).includes('spawnSync npm'));
});

test('bare CLI build validates publication env by default; --preview is the only opt-out', () => {
  const cli = (args, env) => () => execFileSync(process.execPath, [path.join(root, 'scripts/build-site.mjs'), ...args], { cwd: os.tmpdir(), env, encoding: 'utf8', stdio: 'pipe' });
  assert.throws(cli([], { PATH: '/nonexistent' }), reason => String(reason.stderr).includes('production_public_env_required') && !String(reason.stderr).includes('spawnSync npm'));
  assert.throws(cli(['--preview'], { PATH: '/nonexistent' }), reason => String(reason.stderr).includes('spawnSync npm') && !String(reason.stderr).includes('production_public_env_required'));
  assert.throws(cli(['--production', '--preview'], { PATH: '/nonexistent' }), reason => String(reason.stderr).includes('usage: build-site.mjs'));
  assert.throws(() => buildSite({ PATH: '/nonexistent' }), /production_public_env_required/);
  assert.throws(() => assertPublicationBuildEnv({ VITE_SUPABASE_URL: publicUrl }), /production_build_env_incomplete:VITE_SESSION_URL/);
  assert.doesNotThrow(() => assertPublicationBuildEnv(productionEnv.productionBuildEnv(publicationEnv)));
});

test("public config admits only public keys and rejects invalid input before a build can start", () => {
  assert.deepEqual(publicSiteConfig(), {});
  for (const key of [publicKey, jwt("anon")]) {
    assert.deepEqual(publicSiteConfig({ LIGOU_PUBLIC_SUPABASE_URL: publicUrl, LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key }), { supabaseUrl: publicUrl, supabaseKey: key });
    assert.deepEqual(publicSiteConfig({ LIGOU_PUBLIC_SUPABASE_URL: publicUrl, LIGOU_PUBLIC_SUPABASE_KEY: key }), { supabaseUrl: publicUrl, supabaseKey: key });
  }
  for (const key of ["sb_secret_private_fixture", jwt("service_role"), jwt("authenticated"), "not-a-key", "sb_publishable_", "sb_publishable_x\nsecret"]) {
    assert.throws(() => buildSite({ LIGOU_PUBLIC_SUPABASE_URL: publicUrl, LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key }, { publication: false }), /public_supabase_key_invalid/);
  }
  for (const url of ["https://attacker.example", "http://fixture.supabase.co", "https://user:pass@fixture.supabase.co", "https://fixture.supabase.co/?secret=x"]) {
    assert.throws(() => publicSiteConfig({ LIGOU_PUBLIC_SUPABASE_URL: url, LIGOU_PUBLIC_SUPABASE_KEY: publicKey }), /public_supabase_url_invalid/);
  }
  assert.throws(() => publicSiteConfig({ LIGOU_PUBLIC_SUPABASE_URL: publicUrl }), /public_supabase_config_incomplete/);
  assert.throws(() => publicSiteConfig({ LIGOU_PUBLIC_SUPABASE_URL: publicUrl, LIGOU_PUBLIC_SUPABASE_KEY: publicKey, LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt("anon") }), /public_supabase_key_conflict/);
  assert.throws(() => composeSite({ outputDir: "../../unsafe" }), /simple directory name/);
});

async function artifactText(directory) {
  let text = "";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    const entryPath = path.join(directory, entry.name);
    text += entry.isDirectory() ? await artifactText(entryPath) : await readFile(entryPath, "utf8");
  }
  return text;
}

test("prepared fixture composes original pages, dashboard, public config and a self-contained server API", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-site-build-"));
  try {
    for (const directory of ["assets", "_ds", "comercial", "termos", "privacidade", "dashboard/dist/client/assets", "src/server"]) {
      await mkdir(path.join(fixture, directory), { recursive: true });
    }
    for (const file of ["index.html", "favicon.svg", "og-card.svg", "og-ligou.png", "comercial/index.html", "comercial/app.js", "termos/index.html", "privacidade/index.html", "dashboard/dist/client/index.html", "dashboard/dist/client/assets/dashboard.js"]) {
      await writeFile(path.join(fixture, file), `fixture:${file}\n`);
    }
    await writeFile(path.join(fixture, ".env"), "LIGOU_SALES_PROXY_SECRET=dotenv-private-sentinel\n");
    for (const file of ["vercel-sales-session.mjs", "sales-proxy.mjs"]) {
      await cp(path.join(root, "src/server", file), path.join(fixture, "src/server", file));
    }
    const env = { ...buildEnv, LIGOU_PUBLIC_SUPABASE_URL: publicUrl, LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
      LIGOU_SALES_PROXY_SECRET: "private-proxy-sentinel", SUPABASE_SERVICE_ROLE_KEY: "private-service-sentinel",
      LIGOU_SALES_EDGE_URL: "https://private-edge-sentinel.supabase.co/functions/v1/sales-session" };
    const result = composeSite({ rootDir: fixture, env });
    assert.equal(result.commercialLoginConfigured, true);
    for (const route of ["index.html", "comercial/index.html", "comercial/app.js", "termos/index.html", "privacidade/index.html", "dashboard/index.html", "dashboard/assets/dashboard.js", "api/sales-session.mjs", "public-config.js"]) {
      assert.ok((await lstat(path.join(result.out, route))).isFile(), route);
    }
    assert.equal(await readFile(path.join(result.out, "dashboard/index.html"), "utf8"), "fixture:dashboard/dist/client/index.html\n");
    assert.equal(await readFile(path.join(result.out, "public-config.js"), "utf8"), `window.LIGOU_PUBLIC_CONFIG=Object.freeze(${JSON.stringify({ supabaseUrl: publicUrl, supabaseKey: publicKey })});\n`);
    const vercel = JSON.parse(await readFile(path.join(result.out, "vercel.json"), "utf8"));
    assert.equal(vercel.functions["api/sales-session.mjs"].maxDuration, 15);
    assert.deepEqual(vercel.rewrites.find(route => route.source.startsWith("/dashboard/")), { source: "/dashboard/((?!assets/|fonts/|.*\\.).*)", destination: "/dashboard/index.html" });
    for (const route of ["comercial", "termos", "privacidade"]) {
      assert.ok(vercel.rewrites.some(rewrite => rewrite.source === `/${route}/` && rewrite.destination === `/${route}/index.html`));
    }
    assert.ok(vercel.headers.some(entry => entry.source === "/dashboard/assets/(.*)" && entry.headers[0].value.includes("immutable")));
    const shipped = await artifactText(result.out);
    assert.doesNotMatch(shipped, /private-proxy-sentinel|private-service-sentinel|private-edge-sentinel|dotenv-private-sentinel|ligou-website-v2|\/Users\//);
    await assert.rejects(lstat(path.join(result.out, "src")), { code: "ENOENT" });
    const api = await import(pathToFileURL(path.join(result.out, "api/sales-session.mjs")));
    assert.equal(typeof api.default, "function");
    assert.equal(typeof api.handleSalesSession, "function");
    const unavailable = await invoke(api.handleSalesSession, request(), { VERCEL: "1", VERCEL_URL: "fixture.example" });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(unavailable.body, { error: "network_unavailable" });

    // The actual commercial source resolves from its own pinned installation; no UI artifact is overwritten.
    execFileSync("bun", ["build", path.join(root, "src/commercial/commercial.jsx"), "--target=browser", "--format=esm", "--minify", "--outfile", path.join(fixture, "commercial-check.mjs")], { env: buildEnv, stdio: "pipe" });
    assert.ok((await readFile(path.join(fixture, "commercial-check.mjs"))).byteLength > 1000);
    assert.equal((await lstat(path.join(root, "src/commercial/node_modules"))).isSymbolicLink(), false);
    assert.equal((await lstat(path.join(root, "src/commercial/node_modules/@supabase/supabase-js"))).isSymbolicLink(), false);
    const lock = JSON.parse(await readFile(path.join(root, "src/commercial/package-lock.json"), "utf8"));
    assert.equal(lock.packages["node_modules/@supabase/supabase-js"].version, "2.112.3");
    for (const [name, dependency] of Object.entries(lock.packages)) {
      if (!name) continue;
      assert.ok(name.startsWith("node_modules/"));
      assert.equal(dependency.link, undefined);
      assert.match(dependency.resolved, /^https:\/\/registry\.npmjs\.org\//);
      assert.ok(dependency.integrity);
    }

    const noConfig = composeSite({ rootDir: fixture, outputDir: "without-config", env: buildEnv });
    assert.equal(noConfig.commercialLoginConfigured, false);
    assert.equal(await readFile(path.join(noConfig.out, "public-config.js"), "utf8"), "window.LIGOU_PUBLIC_CONFIG=Object.freeze({});\n");
    await writeFile(path.join(fixture, "assets/.env"), "must-not-ship");
    assert.throws(() => composeSite({ rootDir: fixture, outputDir: "rejected-private-file", env: buildEnv }), /private_configuration_or_symlink/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

const runtimeEnv = { VERCEL: "1", VERCEL_URL: "fixture.example", LIGOU_SALES_EDGE_URL: "https://fixture.supabase.co/functions/v1/sales-session", LIGOU_SALES_PROXY_SECRET: "runtime-private-secret" };
function request(headers = {}, body = { action: "status", session_id: "fixture" }) {
  return { method: "POST", headers: { origin: "https://fixture.example", "content-type": "application/json", "x-vercel-forwarded-for": "192.0.2.24", ...headers }, body };
}
async function invoke(handler, req, env, fetcher = () => { throw new Error("unexpected_network_attempt"); }) {
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.value = value; } };
  await handler(req, response, env, fetcher);
  return { status: response.statusCode, headers: response.headers, body: JSON.parse(response.value) };
}

test("hosting adapter uses runtime-only secrets and trusted Vercel IP while projecting public output", async () => {
  let captured;
  const result = await invoke(handleSalesSession, request({ "x-forwarded-for": "198.51.100.99", "x-sales-network-ip": "198.51.100.99", "x-sales-proxy-secret": "forged" }), runtimeEnv, async (url, options) => {
    captured = { url, options };
    return Response.json({ session_id: "fixture", status: "ended", provider_termination_state: "confirmed", provider_call_id: "private-provider", lead: "private-lead", token_hash: "private-token" });
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { session_id: "fixture", status: "ended", provider_termination_state: "confirmed" });
  assert.equal(captured.options.headers["x-sales-network-ip"], "192.0.2.24");
  assert.equal(captured.options.headers["x-sales-proxy-secret"], runtimeEnv.LIGOU_SALES_PROXY_SECRET);
  assert.equal(captured.options.headers["x-forwarded-for"], undefined);
  assert.equal(captured.options.redirect, "error");
  assert.deepEqual(JSON.parse(Buffer.from(captured.options.body).toString()), { action: "status", session_id: "fixture" });
  assert.equal(result.headers["cache-control"], "no-store");
});

test("hosting adapter rejects missing provenance, disallowed origins and invalid bodies without network", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({}); };
  for (const [req, env, status] of [
    [request(), { ...runtimeEnv, VERCEL: "0" }, 503],
    [request({ "x-vercel-forwarded-for": undefined, "x-forwarded-for": "192.0.2.1" }), runtimeEnv, 503],
    [request({ "x-vercel-forwarded-for": ["192.0.2.1", "192.0.2.2"] }), runtimeEnv, 503],
    [request(), { ...runtimeEnv, LIGOU_SALES_PROXY_SECRET: "" }, 503],
    [request({ origin: "https://attacker.example" }), runtimeEnv, 403],
    [request({ "content-type": "text/plain" }), runtimeEnv, 415],
    [request({}, "x".repeat(100000)), runtimeEnv, 413],
    [{ ...request(), method: "GET" }, runtimeEnv, 405],
  ]) {
    assert.equal((await invoke(handleSalesSession, req, env, fetcher)).status, status);
  }
  assert.equal(calls, 0);
});
