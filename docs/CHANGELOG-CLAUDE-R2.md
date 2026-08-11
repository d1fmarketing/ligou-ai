# Ligou — Claude R2: A Linha

**Data:** 10 de agosto de 2026

**Status:** candidato local integrado; sem publicação autorizada

**Branch:** `codex/ligou-claude-r2`

**Base preservada:** Visual 4 no commit `7279041`

## Origem e linhagem

RJ partiu da V4 do Git e fez duas rodadas adicionais no Claude Design. A segunda
rodada é a fonte visual mais recente. O export recebido foi:

- arquivo: `/Users/d1f/Downloads/Ligou Design System.zip`;
- tamanho: 3.696.405 bytes;
- SHA-256: `3e4319ddf66eaebe1bf2ea1f6ed30e402fb584c9b48e8342d30a291492374238`;
- conteúdo: 133 arquivos, com teste de integridade aprovado.

O pacote mistura componentes atuais com thumbnails, screenshots e documentação de
rodadas anteriores. Por isso ele não foi descompactado sobre o repositório. A fonte
executável mais recente — `ui_kits/landing/Header.jsx`, `Hero.jsx` e `kit.css` — foi
comparada com a V4 e portada seletivamente para a página estática.

## Delta integrado

O delta real da segunda rodada do Claude é deliberadamente pequeno:

- nova marca corporativa v2, **A Linha**: entrada, loop e ponto de conclusão;
- marca aplicada no header, footer e favicon ativo;
- hero reorganizada em uma linha vertical sempre legível:
  `EN → regra encontrada → resumo em PT`;
- as duas poses do agente alternam entre atendendo e operando;
- um ciclo de 12 segundos transfere a ênfase entre entrada, regra e resultado;
- o ciclo pausa fora da viewport e tem estado estático completo sem JavaScript ou
  com `prefers-reduced-motion: reduce`;
- fallback de uma coluna evita sobreposição em telas estreitas.

Todo o restante continua vindo da V4: copy, cinco seções, `SITE_CONFIG`, prova com
progressive enhancement e teclado, história sticky, CTA/dock móvel, bloqueios de
checkout e links legais. `script.js` permaneceu byte a byte idêntico ao Visual 4.

## Assets da marca

| Asset | Uso | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `assets/logo-mark.svg` | símbolo sobre disco laranja; header, footer e favicon | 423 | `7cce8b971bd56d261ef853d3caa77c94e9ec7024d36d01c7788afe8d53d11e71` |
| `assets/logo-line.svg` | master monocromático da linha | 368 | `7a1a424afd3f7379e46dea5e59875f5f67d766b504e55cf76361690cb92c6331` |

O `favicon.svg` histórico não foi sobrescrito porque pertence aos snapshots V1–V4.
O HTML atual aponta diretamente para `assets/logo-mark.svg`.

O handset no peito do personagem permanece nas imagens geradas da V4. Nesta rodada,
ele funciona como badge do canal telefônico e não como marca corporativa. Alterá-lo
exigiria editar ou regenerar a família de poses e ficou fora deste merge.

`og-card.svg` e `og-ligou.png` também permaneceram byte a byte idênticos à V4 porque
o export do Claude continha o mesmo PNG. O card social deve ser atualizado para a
marca v2 antes de publicar.

## O que não entrou

- runtime React, ReactDOM, Babel ou dependências CDN do preview;
- componentes JSX que simplificavam ou removiam comportamentos da V4;
- `styles.css` da raiz do ZIP, que era apenas um wrapper de tokens;
- favicon v1 aposentado, thumbnails e screenshots antigos;
- WebPs, fontes, OG e brand board duplicados;
- `_ds_bundle.js`, prompts, declarations, uploads e arquivos gerados do design system.

## Verificações locais

- ZIP íntegro, sem path traversal, symlink, executável, segredo ou SVG com script;
- `node --check script.js` e `git diff --check` aprovados;
- `script.js` confirmado byte a byte igual ao commit-base;
- todos os dez caminhos locais usados por `index.html` existem;
- IDs únicos, uma única `h1` e todas as imagens com atributo `alt`;
- preview HTTP aprovado em `127.0.0.1:4173`;
- revisão visual no Browser interno em desktop, 768 × 1024, 390 × 844 e 320 × 720;
- zero overflow horizontal e zero erro/aviso de console nos viewports testados;
- ciclo confirmado em três fases: EN, regra e resultado;
- sem JavaScript: 4.719 caracteres visíveis, duas provas presentes e hero completa;
- movimento reduzido: sem classe de motion, pose B oculta e pacote desativado.

Esses testes comprovam somente o frontend local. Não comprovam telefonia, backend,
CRM/MCP, checkout, aparelho físico, deploy, DNS ou produção.

## Bloqueios de publicação

Continuam valendo os bloqueios do Visual 4 e do handoff: número real da demo, checkout,
Termos, Privacidade, inventário Founding, backend comprovado, consentimento e
privacidade, testes operacionais, deploy/DNS/HTTPS e copy congelada. Soma-se a eles a
regeneração do OG com a marca v2 e a revisão final da regra marca corporativa versus
badge telefônico do personagem.
