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
assert(html.includes("object-fit:contain;object-position:center right"), "desktop source composition must stay uncropped");
assert(html.includes("position:absolute;top:50%;right:0;width:100%;height:auto;aspect-ratio:16/9"), "desktop hero must use width-fit geometry");
assert(html.includes("#021523 0%,#021523 38%"), "desktop edge-matched background missing");
assert(html.includes("padding-left:clamp(32px,calc(50vw - 788px),172px)!important"), "wide desktop copy anchor missing");
assert(html.includes("font-size:clamp(76px,5.4vw,104px)"), "compact desktop headline guard missing");
assert(html.includes(".hero4-copy .h4-eyebrow{padding-top:8px}"), "hero eyebrow top spacing missing");
assert(html.includes("@media (min-width:768px){.wavedraw{margin-top:32px!important}}"), "non-mobile proof-divider spacing missing");
assert(html.includes("inglês, espanhol ou português"), "multilingual metadata and no-JS copy missing");
assert(html.includes("(min-width:1600px) and (min-aspect-ratio:2/1)"), "ultrawide media query missing");
assert(html.includes("aspect-ratio:3440/1476"), "ultrawide source geometry missing");
assert(html.includes("aspect-ratio:4/3"), "landscape tablet frame missing");
assert(html.includes("aspect-ratio:3/4"), "portrait tablet frame missing");

const runtimeReferences = new Set();
const addMatches = (contents, pattern) => {
  for (const match of contents.matchAll(pattern)) runtimeReferences.add(match[1]);
};

addMatches(html, /(?:src|href)="((?:assets|_ds)\/[^"#?]+)"/g);
const applicationSource = await readFile(
  path.join(root, "src/runtime/ligou-app9.jsx"),
  "utf8",
);
assert(applicationSource.includes("Agente operacional de inteligência artificial para negócios de serviços"), "AI category descriptor missing from hero eyebrow (brand guide p.12: premissa não reabrir)");
assert(applicationSource.includes("agente de inteligência artificial da sua empresa"), "transparent AI self-identification missing (brand guide p.19/24)");
assert(!applicationSource.includes("virtual assistant") && !applicationSource.includes("assistente virtual"), "softened 'virtual assistant' label must not return");
assert(html.includes("Agente operacional de inteligência artificial para negócios de serviços"), "AI category descriptor missing from no-JS hero");
assert(applicationSource.includes("Você ensina em português · Ele atende em inglês, espanhol e português"), "owner-taught multilingual hero claim missing");
assert(applicationSource.includes("Preciso falar inglês ou espanhol para ensinar o Ligou?"), "owner-taught multilingual FAQ missing");
assert(applicationSource.includes("Memória permanente do seu negócio"), "permanent business memory message missing");
assert(applicationSource.includes("depois que você aprova, a resposta vira uma regra permanente"), "owner-approved learning message missing");
assert(applicationSource.includes("Quando a regra permite, ele resolve sozinho. Quando não permite, traz o caso pronto para você decidir."), "autonomy and exception bridge missing");
assert(applicationSource.includes("Contrate até 31 de dezembro de 2026 por $299/mês."), "dated launch offer missing");
assert(applicationSource.includes("mantém o valor base de $299/mês enquanto a assinatura permanecer ativa"), "active-subscription base price promise missing");
assert(applicationSource.includes("Para novas assinaturas após a oferta: $499/mês + ativação de $499."), "post-offer pricing qualifier missing");
assert(!applicationSource.includes("uns 15 minutos"), "unvalidated onboarding duration must not return");
assert(!applicationSource.includes("Founding Partners") && !applicationSource.includes("25 vagas"), "retired Founding scarcity copy must not return");
const painPosition = applicationSource.lastIndexOf("<Dor/>");
const proofPosition = applicationSource.lastIndexOf("<CallDemo/>");
const differencePosition = applicationSource.lastIndexOf("<Scene/>");
assert(painPosition !== -1 && painPosition < proofPosition && proofPosition < differencePosition, "conversion narrative must stay pain -> proof -> difference");
assert(
  applicationSource.includes("band !== 'mobile' && <a className=\"h4-ghostbtn\""),
  "secondary hero CTA must not render on mobile",
);
addMatches(applicationSource, /["'](assets\/[^"']+)["']/g);
for (const expectedMedia of [
  "hero-loop-ultrawide-3440x1476.mp4",
  "hero-loop-1080p.mp4",
  "hero-loop-tablet-landscape-1440x1080.mp4",
  "hero-loop-tablet-portrait-1080x1440.mp4",
  "hero-loop-mobile-1080x1920.mp4",
]) {
  assert(applicationSource.includes(expectedMedia), `missing responsive hero media: ${expectedMedia}`);
}

assert.equal(
  [...applicationSource.matchAll(/assets\/ligou-avatar-v1\.png/g)].length,
  5,
  "all five compact Ligou appearances must use the transparent avatar",
);
assert(
  !applicationSource.includes("iv-av-d") && !applicationSource.includes("iv-av-m"),
  "legacy breakpoint-specific avatar crops must not return",
);
assert(
  html.includes(".ligou-avatar{width:100%;height:100%;object-fit:cover;object-position:center;display:block}"),
  "transparent avatar framing is missing",
);

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
