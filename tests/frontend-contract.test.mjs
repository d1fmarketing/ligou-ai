import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const application = await readFile(new URL("src/runtime/ligou-app9.jsx", root), "utf8");
const fontFaces = await readFile(
  new URL("assets/fonts-optimized.css", root),
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

test("legal destinations and label-cleanup boundaries stay explicit", () => {
  // The preview now has real reviewable legal destinations.
  expect(application).toContain('<a href="/termos/" style={a}>Termos</a>');
  expect(application).toContain('<a href="/privacidade/" style={a}>Privacidade</a>');
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

test("mockup controls carry no false affordance and the pricing primary starts the shared voice conversation", () => {
  expect(application).not.toMatch(/<button className="(?:iv-approve|p7-apr|p7-adj|lc-apr|lc-adj)"/);
  expect(application).toContain('<span className="lc-apr">Aprovar encaixe</span>');
  expect(application).toContain('<button className="p7-again" type="button" onClick={replay}>');
  expect(application).toContain('href="#prova" onClick={openSalesConversation} style={{marginTop: 8}}>Quero aproveitar a oferta</Button>');
  expect(application).not.toContain('href="#preco"');
});

test("display typography maps static Familjen files to their exact weights", () => {
  expect(fontFaces).toContain("font-weight:600;font-display:swap;src:url('fonts/familjen-grotesk-600.woff2')");
  expect(fontFaces).toContain("font-weight:700;font-display:swap;src:url('fonts/familjen-grotesk-700.woff2')");
  expect(fontFaces).not.toContain("font-weight:400 900;font-display:swap;src:url('fonts/familjen-grotesk-600.woff2')");
  expect(fontFaces).not.toContain("font-weight:700 900;font-display:swap;src:url('fonts/familjen-grotesk-700.woff2')");
});

test("fallback includes native FAQ, onboarding and support without a conversion form", () => {
  expect((noScript.match(/<details>/g) || []).length).toBe(5);
  expect(noScript).toContain('id="nojs-comecar"');
  expect(noScript).toContain('id="nojs-capacidades"');
  expect(noScript).toContain('suporte@ligou.ai');
  expect(noScript).not.toContain('<form');
});
