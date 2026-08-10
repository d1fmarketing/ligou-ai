# Ligou — manifesto de integridade dos snapshots visuais

**Algoritmo:** SHA-256

**Escopo:** artefatos renderizados da página, contrato de design, copy-fonte e assets de
marca necessários para reproduzir a rodada.

Os hashes identificam cada conjunto factual independentemente do histórico Git. README e
documentos de processo ficam fora porque podem evoluir sem alterar a página renderizada.

Cada rodada visual ganha o seu próprio bloco. Hashes de um snapshot anterior nunca são
reescritos — eles continuam descrevendo o que aquele snapshot era.

---

## Visual 3 — candidato local

**Data:** 10 de agosto de 2026
**O que mudou:** ver [`CHANGELOG-VISUAL-3.md`](CHANGELOG-VISUAL-3.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 43.076 | `a1c95a73e677db85e038d2bd11de70eaf29bb4a7cd51545d77a19672f0c59362` |
| `styles.css` | 65.055 | `336933ab6e971d78e367af1c2614c5dd3475b6307df45114d25248a723f67866` |
| `script.js` | 7.628 | `f136900423956c7ae542f3235396b4c03ef377be03864e1d4691a0d0346141ac` |
| `.impeccable.md` | 6.350 | `1daaf3fd6e3ea9f62ff6793f1f11487751a65c70c27d67c345ac04f3386f1735` |
| `favicon.svg` | 399 | `2543c946df078df9df4e668072825595d11c3291c7f50f75971bbb45413dc59f` |
| `og-card.svg` | 3.120 | `c55a9016eeae343d4da27236acd092bbf93929d89566053e5b103551dadea953` |
| `og-ligou.png` | 182.701 | `ea851bc9697f51ae17cd3ece006b8eff3c6f8137bfea865adb4e94e6ddec2daa` |
| `docs/source/LIGOU-COPY-V2.1-FROZEN.md` | 14.381 | `900549bf547fcd9d25270a31d4ff768d47e7e7525ed400d3904828ab52bd129f` |
| `docs/source/LIGOU-COPY-V3-WORKING.md` | 6.788 | `8d3f9d91da0d30dccb8abdf6305a44fef049809940962a0c18e3445d5c2a9d68` |
| `assets/ligou-agent-v1.webp` | 34.214 | `fb8ea8ad6a61f646a233124a847bbbce14cd1deee6aa2692c20dc32cfd344c03` |
| `docs/brand/ligou-agent-v1-source.png` | 1.151.876 | `081373ef0c7d4874a482052f2120259f4889037a50084017366f84cbc2ae2046` |
| `docs/brand/ligou-brand-board-v1-approved.png` | 1.384.413 | `11a023067474e671bf13026f2e8e5f0cf35c06fb47c2cdf54ddb21dffef071da` |
| `assets/fonts/familjen-grotesk-600.ttf` | 56.520 | `457dcae83d47907c29376aee2480531b3f33c0a3ec97f17a1983a1e8be3bcc94` |
| `assets/fonts/archivo-700.ttf` | 111.948 | `bed60488c2f5c0b24e01d931760b6f3e9a82619dcd081ed9bff643d9f4fd9e3d` |

A v2.1 continua congelada como base histórica. A fonte V3 registra a direção aprovada,
mas permanece `WORKING` até a aprovação editorial da candidata. Isso impede que um
snapshot visual seja confundido com copy final ou com prova de disponibilidade pública.

---

## Visual 2 — checkpoint histórico

**Data:** 10 de agosto de 2026
**O que mudou:** ver [`CHANGELOG-VISUAL-2.md`](CHANGELOG-VISUAL-2.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 33.808 | `38936936d607f93cc21aa6fc38e6d9b46d1a41ba43a9b486f8c6b338312205f9` |
| `styles.css` | 54.021 | `5b266c822dcbf721a461f7d19e527d051cfbefc41ac0d26526d4daa91a66222d` |
| `script.js` | 7.130 | `579a241d0fd103ce924b9b20032bf7352c70d9efcbe1d68d48623c186adda1d5` |
| `.impeccable.md` | 4.217 | `f25ddd41d30b07fd34144dec4792c296d30eb1993902d549995fedc020952a46` |
| `favicon.svg` | 399 | `2543c946df078df9df4e668072825595d11c3291c7f50f75971bbb45413dc59f` |
| `og-card.svg` | 3.706 | `581081c0d9bfa9a05d4c21546fc345b68619f3d3fc4b41f90b17cf80a5dbb32e` |
| `og-ligou.png` | 79.003 | `ab534aec960bb53b50098e97293cb245ef8959edf145073b2c716d22713c9154` |
| `docs/source/LIGOU-COPY-V2.1-FROZEN.md` | 14.381 | `900549bf547fcd9d25270a31d4ff768d47e7e7525ed400d3904828ab52bd129f` |

Favicon, card social e copy-fonte têm hash idêntico ao do visual 1: esta rodada não os tocou.

O card social `og-ligou.png` ainda reflete a tipografia do visual 1. Ele precisa ser
regerado a partir de `og-card.svg` antes de publicar, para não divergir da página.

---

## Visual 1 — superado

**Data:** 10 de agosto de 2026
**Registro:** [`LANDING-PAGE-BASELINE-VISUAL-1.md`](LANDING-PAGE-BASELINE-VISUAL-1.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 31.700 | `c55552b73b2963aa39896783bc25b5c8522f1e46e56c76c037f21041ecc65600` |
| `styles.css` | 45.515 | `89910e65add394e8843cf787d68b6c4dc38bcca32fe1c29e74835c1d3dd1e462` |
| `script.js` | 3.939 | `ae5ecbcb93b9ef5c44907a43ad713b6cc0669ce03bbbaf411fe085e6108dcd3f` |
| `favicon.svg` | 399 | `2543c946df078df9df4e668072825595d11c3291c7f50f75971bbb45413dc59f` |
| `og-card.svg` | 3.706 | `581081c0d9bfa9a05d4c21546fc345b68619f3d3fc4b41f90b17cf80a5dbb32e` |
| `og-ligou.png` | 79.003 | `ab534aec960bb53b50098e97293cb245ef8959edf145073b2c716d22713c9154` |
| `docs/source/LIGOU-COPY-V2.1-FROZEN.md` | 14.381 | `900549bf547fcd9d25270a31d4ff768d47e7e7525ed400d3904828ab52bd129f` |

## Proveniência da copy

O anexo original recebido na conversa tinha SHA-256:

`9d3bb18a8844d783a4a4c26c212622924af483d582d5243c93db8571b8d53c0c`

A cópia arquivada no projeto normaliza apenas a quebra de linha no final do arquivo;
`diff -u` não encontrou outra diferença de conteúdo.

## Como verificar

Para verificar o Visual 3, execute na raiz do projeto:

```bash
shasum -a 256 index.html styles.css script.js .impeccable.md favicon.svg og-card.svg og-ligou.png \
  docs/source/LIGOU-COPY-V2.1-FROZEN.md docs/source/LIGOU-COPY-V3-WORKING.md \
  assets/ligou-agent-v1.webp docs/brand/ligou-agent-v1-source.png \
  docs/brand/ligou-brand-board-v1-approved.png assets/fonts/familjen-grotesk-600.ttf \
  assets/fonts/archivo-700.ttf
```

Qualquer diferença indica que o arquivo já não corresponde ao bloco declarado e exige
um novo snapshot, não a edição silenciosa destes hashes.
