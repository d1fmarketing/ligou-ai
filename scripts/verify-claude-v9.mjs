import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedSourceHashes = new Map([
  ["src/claude-v9/Ligou 2026 v9.html", "a2ee8b06f5921fe93657b08d8bcbda5fd45d0050ef4ae1f5ba5fa22e9a6bf6b8"],
  ["src/claude-v9/ligou-app9.jsx", "6ed7437c6d26cdb715adc15d52a5e6bf3ed47752f8cdf17e2d7cabe9cf60b613"],
  ["src/claude-v9/ligou-fx2.jsx", "0a82edda7ab80bd82ca5c2c1df13a363f9c808e6d9019422313e42dcc015f80a"],
]);

for (const [relativePath, expectedHash] of expectedSourceHashes) {
  const contents = await readFile(path.join(root, relativePath));
  const actualHash = createHash("sha256").update(contents).digest("hex");
  assert.equal(actualHash, expectedHash, `${relativePath} diverged from the v9 export`);
}

const html = await readFile(path.join(root, "index.html"), "utf8");
assert(!html.includes("babel.min.js"), "production preview must not compile JSX in the browser");
assert(!html.includes("react.development.js"), "production preview must not load React development");
assert(!html.includes("react-dom.development.js"), "production preview must not load ReactDOM development");
assert(html.includes('name="robots" content="noindex, nofollow"'), "prototype must stay noindex");
assert(html.includes("assets/vendor/react-18.3.1.production.min.js"), "local React runtime missing");
assert(html.includes("assets/js/ligou-app9.js"), "compiled v9 application missing");

const runtimeReferences = new Set();
const addMatches = (contents, pattern) => {
  for (const match of contents.matchAll(pattern)) runtimeReferences.add(match[1]);
};

addMatches(html, /(?:src|href)="((?:assets|_ds)\/[^"#?]+)"/g);
const applicationSource = await readFile(
  path.join(root, "src/claude-v9/ligou-app9.jsx"),
  "utf8",
);
addMatches(applicationSource, /["'](assets\/[^"']+)["']/g);

const visitedStylesheets = new Set();
const collectStylesheetReferences = async (relativePath) => {
  if (visitedStylesheets.has(relativePath)) return;
  visitedStylesheets.add(relativePath);
  const contents = await readFile(path.join(root, relativePath), "utf8");
  const directory = path.posix.dirname(relativePath);

  for (const match of contents.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g)) {
    if (/^(?:data:|https?:)/.test(match[1])) continue;
    const importedPath = path.posix.normalize(path.posix.join(directory, match[1]));
    runtimeReferences.add(importedPath);
    await collectStylesheetReferences(importedPath);
  }

  for (const match of contents.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
    if (/^(?:data:|https?:)/.test(match[1])) continue;
    runtimeReferences.add(path.posix.normalize(path.posix.join(directory, match[1])));
  }
};

for (const stylesheet of [...runtimeReferences].filter((reference) => reference.endsWith(".css"))) {
  await collectStylesheetReferences(stylesheet);
}

for (const relativePath of runtimeReferences) {
  await access(path.join(root, relativePath));
}

const pinnedRuntime = await readFile(
  path.join(root, "docs/CLAUDE-V9-RUNTIME.sha256"),
  "utf8",
);
let pinnedFileCount = 0;
for (const line of pinnedRuntime.trim().split("\n")) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  assert(match, `invalid runtime manifest line: ${line}`);
  const [, expectedHash, relativePath] = match;
  const contents = await readFile(path.join(root, relativePath));
  const actualHash = createHash("sha256").update(contents).digest("hex");
  assert.equal(actualHash, expectedHash, `${relativePath} diverged from the v9 checkpoint`);
  pinnedFileCount += 1;
}

console.log(`Claude v9 verification passed (${expectedSourceHashes.size} export sources, ${pinnedFileCount} pinned files, ${runtimeReferences.size} runtime references).`);
