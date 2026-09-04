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
  // Termos/Privacidade have no pages yet: they must stay visible but must not be dead links (L24).
  expect(application).toContain('<span style={a}>Termos</span>');
  expect(application).toContain('<span style={a}>Privacidade</span>');
  expect(application).not.toContain('href="#"');
  expect(application).not.toMatch(/<Eyebrow[^>]*>\s*A dor\s*<\/Eyebrow>/);
  expect(application).not.toMatch(/<Eyebrow[^>]*>\s*Prova do produto\s*<\/Eyebrow>/);
  expect(noScript).not.toMatch(/>\s*(?:A dor|Prova do produto)\s*</);
});

test("share metadata points at the existing 1200x630 card with an absolute URL", () => {
  expect(html).toContain('<meta property="og:image" content="https://client-nine-taupe-24.vercel.app/og-ligou.png">');
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  expect(html).toContain('<meta property="og:title" content="Ligou? Atendido. — Agente operacional de inteligência artificial">');
});

test("mockup controls carry no false affordance and the pricing primary routes to the proof", () => {
  expect(application).not.toMatch(/<button className="(?:iv-approve|p7-apr|p7-adj|lc-apr|lc-adj)"/);
  expect(application).toContain('<span className="lc-apr">Aprovar encaixe</span>');
  expect(application).toContain('<button className="p7-again" type="button" onClick={replay}>');
  expect(application).toContain('href="#prova" onClick={replayDemo} style={{marginTop: 8}}>Quero aproveitar a oferta</Button>');
  expect(application).not.toContain('href="#preco"');
});

test("display typography maps static Familjen files to their exact weights", () => {
  expect(fontFaces).toContain("font-weight:600;font-display:swap;src:url('../../../assets/fonts/familjen-grotesk-600.ttf')");
  expect(fontFaces).toContain("font-weight:700;font-display:swap;src:url('../../../assets/fonts/familjen-grotesk-700.ttf')");
  expect(fontFaces).not.toContain("font-weight:400 900;font-display:swap;src:url('../../../assets/fonts/familjen-grotesk-600.ttf')");
  expect(fontFaces).not.toContain("font-weight:700 900;font-display:swap;src:url('../../../assets/fonts/familjen-grotesk-700.ttf')");
});
