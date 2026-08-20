import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const application = await readFile(new URL("src/runtime/ligou-app9.jsx", root), "utf8");
const fontFaces = await readFile(
  new URL("_ds/ligou-design-system-a33905fc-3bee-481b-b797-48c2b57eab4c/tokens/fonts.css", root),
  "utf8",
);
const noScript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? "";

test("the JavaScript-disabled fallback preserves the conversion proof and client route", () => {
  expect(noScript).toContain("Ligou?<span>Atendido.</span>");
  expect(noScript).toContain('href="#nojs-proof">Ver demonstração ilustrativa</a>');
  expect(noScript).toContain('class="nojs-v9__client" href="/dashboard/">Área do cliente</a>');
  expect(noScript.match(/class="nojs-v9__step"/g)).toHaveLength(4);
  expect(noScript).toContain("Cliente · Inglês");
  expect(noScript).toContain("Ligou · Inglês");
  expect(noScript).toContain("Regra e ação");
  expect(noScript).toContain("Resumo · Português");
});

test("client-area links exist in both React surfaces without claiming a bundled dashboard", () => {
  expect(application.match(/href="\/dashboard\/"/g)).toHaveLength(2);
  expect(application).toContain('className="nav4-client"');
  expect(application).toContain('className="footer-client"');
  expect(noScript.match(/href="\/dashboard\/"/g)).toHaveLength(1);
});

test("placeholder and label-cleanup boundaries stay explicit", () => {
  expect(application).toContain('<a href="#" style={a}>Termos</a>');
  expect(application).toContain('<a href="#" style={a}>Privacidade</a>');
  expect(application).not.toMatch(/<Eyebrow[^>]*>\s*A dor\s*<\/Eyebrow>/);
  expect(application).not.toMatch(/<Eyebrow[^>]*>\s*Prova do produto\s*<\/Eyebrow>/);
  expect(noScript).not.toMatch(/>\s*(?:A dor|Prova do produto)\s*</);
});

test("display typography maps its real Familjen files to their supplied weights", () => {
  expect(fontFaces).toContain("font-weight:600;font-display:swap;src:url('../../../assets/fonts/familjen-grotesk-600.ttf')");
  expect(fontFaces).toContain("font-weight:700 900;font-display:swap;src:url('../../../assets/fonts/familjen-grotesk-700.ttf')");
  expect(fontFaces).not.toContain("font-weight:400 900;font-display:swap;src:url('../../../assets/fonts/familjen-grotesk-600.ttf')");
});
