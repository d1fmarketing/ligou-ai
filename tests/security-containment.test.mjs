import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const binaryExtensions = new Set([
  ".avif", ".gif", ".ico", ".jpeg", ".jpg", ".mp4", ".png", ".ttf", ".webp", ".woff", ".woff2",
]);

async function readTextAssets(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const assets = [];
  for (const entry of entries) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      assets.push(...await readTextAssets(directory, entryRelative));
      continue;
    }
    if (!entry.isFile() || binaryExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const contents = await readFile(path.join(directory, entryRelative));
    if (contents.includes(0)) continue;
    assets.push({ path: entryRelative, text: contents.toString("utf8") });
  }
  return assets;
}

test("production site ships Google-only login: no password, magic-link, code, or #k path", {
  skip: process.env.LIGOU_SITE_OUTPUT_DIR !== "security-containment",
}, async () => {
  const outputDir = process.env.LIGOU_SITE_OUTPUT_DIR;
  assert.equal(outputDir, "security-containment", "the test must inspect its own rebuilt output tree");
  const siteRoot = path.resolve(new URL("../dist/", import.meta.url).pathname, outputDir);
  const assets = await readTextAssets(siteRoot);
  const productionOutput = assets.map((asset) => `/* ${asset.path} */\n${asset.text}`).join("\n");

  assert.ok(assets.some((asset) => asset.path === "index.html"));
  assert.ok(assets.some((asset) => asset.path.endsWith(".js")));
  assert.doesNotMatch(productionOutput, /VITE_TEST_AUTOLOGIN/);
  assert.doesNotMatch(productionOutput, /signInWithPassword/);
  assert.doesNotMatch(productionOutput, /signInWithOtp/);
  assert.doesNotMatch(productionOutput, /verifyOtp/);
  assert.doesNotMatch(productionOutput, /ligou\.test\.k/);
  assert.doesNotMatch(productionOutput, /#k=/);
  assert.match(productionOutput, /signInWithOAuth/);
  assert.match(productionOutput, /Continuar com Google/);

  // The client construction is env-gated and dead-code-eliminated in env-less
  // builds, so the PKCE and custody-storage wiring is pinned at source level.
  const clientSource = await readFile(new URL("../dashboard/src/lib/supabase.js", import.meta.url), "utf8");
  assert.match(clientSource, /flowType:\s*"pkce"/);
  assert.match(clientSource, /storage:\s*browserCustodyStorage\(\)/);
  assert.match(clientSource, /detectSessionInUrl:\s*true/);
});

test("production Vite config ignores hostile dotenv files", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ligou-vite-env-isolation-"));
  try {
    await mkdir(path.join(fixture, "src"));
    await writeFile(path.join(fixture, "index.html"), '<div id="root"></div><script type="module" src="/src/main.jsx"></script>\n');
    await writeFile(path.join(fixture, "src/main.jsx"), 'document.querySelector("#root").textContent = import.meta.env.VITE_HOSTILE_DOTENV_SENTINEL || "clean";\n');
    await writeFile(path.join(fixture, ".env"), "VITE_HOSTILE_DOTENV_SENTINEL=must-not-enter-production-bundle\n");
    await writeFile(path.join(fixture, ".env.local"), "VITE_HOSTILE_LOCAL_SENTINEL=must-not-enter-production-bundle-either\n");
    const vite = path.resolve(new URL("../dashboard/node_modules/.bin/vite", import.meta.url).pathname);
    await chmod(vite, 0o755);
    const result = spawnSync(vite, ["build", "--config", path.resolve(new URL("../dashboard/vite.config.mjs", import.meta.url).pathname)], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: fixture,
        VITE_HOSTILE_CALLER_SENTINEL: "must-not-enter-from-caller",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const assets = await readTextAssets(path.join(fixture, "dist/client"));
    const output = assets.map((asset) => asset.text).join("\n");
    assert.doesNotMatch(output, /must-not-enter-production-bundle|must-not-enter-from-caller/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release build environment maps only explicit public build inputs", async () => {
  const module = await import("../scripts/production-env.mjs").catch(() => ({}));
  assert.equal(typeof module.productionBuildEnv, "function");
  const env = module.productionBuildEnv({
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    VITE_SUPABASE_URL: "https://caller.invalid",
    SUPABASE_SECRET_KEY: "must-not-cross",
    LIGOU_PUBLIC_SUPABASE_URL: "https://public.supabase.invalid",
    LIGOU_PUBLIC_SUPABASE_FUNCTIONS_URL: "https://public.supabase.invalid/functions/v1",
  }, "security-containment");
  assert.equal(env.VITE_SUPABASE_URL, "https://public.supabase.invalid");
  assert.equal(env.VITE_SUPABASE_FUNCTIONS_URL, "https://public.supabase.invalid/functions/v1");
  assert.equal(env.VITE_SUPABASE_PUBLISHABLE_KEY, undefined);
  assert.equal(env.SUPABASE_SECRET_KEY, undefined);
  assert.equal(env.VITE_HOSTILE_CALLER_SENTINEL, undefined);
  assert.equal(env.LIGOU_SITE_OUTPUT_DIR, "security-containment");
});
