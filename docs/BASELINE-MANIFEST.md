# Ligou — manifesto de integridade do baseline visual 1

**Data:** 10 de agosto de 2026

**Algoritmo:** SHA-256

**Escopo:** artefatos que compõem a página e a copy-fonte congelada

Os hashes abaixo identificam o conjunto factual independentemente do histórico Git. Isso permite confirmar quais artefatos formavam o baseline mesmo depois de novos commits. README e documentos de processo ficam fora do manifesto porque podem evoluir sem alterar a página renderizada.

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

O anexo original recebido nesta conversa tinha SHA-256:

`9d3bb18a8844d783a4a4c26c212622924af483d582d5243c93db8571b8d53c0c`

A cópia arquivada no projeto normaliza apenas a quebra de linha no final do arquivo; `diff -u` não encontrou outra diferença de conteúdo.

## Como verificar

Execute na raiz do projeto:

```bash
shasum -a 256 index.html styles.css script.js favicon.svg og-card.svg og-ligou.png docs/source/LIGOU-COPY-V2.1-FROZEN.md
```

Qualquer diferença indica que o arquivo já não corresponde a este baseline e exige um novo manifesto, não a edição silenciosa destes hashes.
