import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

test("production site excludes the retired fragment/password auto-login path", {
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
  assert.doesNotMatch(productionOutput, /ligou\.test\.k/);
  assert.doesNotMatch(productionOutput, /#k=/);
  assert.match(productionOutput, /signInWithOtp/);
});
