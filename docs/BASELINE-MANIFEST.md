# Ligou — manifesto de integridade dos snapshots visuais

**Algoritmo:** SHA-256

**Escopo:** artefatos renderizados da página, o contrato de design e a copy-fonte congelada.

Os hashes identificam cada conjunto factual independentemente do histórico Git. README e
documentos de processo ficam fora porque podem evoluir sem alterar a página renderizada.

Cada rodada visual ganha o seu próprio bloco. Hashes de um snapshot anterior nunca são
reescritos — eles continuam descrevendo o que aquele snapshot era.

---

## Visual 2 — atual

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

Execute na raiz do projeto:

```bash
shasum -a 256 index.html styles.css script.js .impeccable.md favicon.svg og-card.svg og-ligou.png docs/source/LIGOU-COPY-V2.1-FROZEN.md
```

Qualquer diferença indica que o arquivo já não corresponde ao snapshot atual e exige um
novo bloco neste manifesto, não a edição silenciosa destes hashes.
