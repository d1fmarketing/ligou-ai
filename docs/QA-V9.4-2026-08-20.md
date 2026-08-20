# QA v9.4 — 20 de agosto de 2026

**Commit auditado:** `161e8e8` (`test: cover v9 frontend behavior`, head de `main`)
**Ambiente:** Chromium headless 1194 via Playwright, contra `dev-server.mjs` local
(`http://127.0.0.1:4174/`). Sessão remota Claude Code; não é o Browser interno do Mac.
**Escopo provado:** apresentação do frontend local. Este QA **não** prova telefonia,
backend, checkout, oferta, publicação, deploy nem o link `/dashboard/` (a Área do
cliente aponta para uma rota que não existe neste runtime estático).

## Pipeline

`bun run check` completo verde antes do QA: build, `node --check` nos dois runtimes JS,
9 testes (101 asserts) e verificação Claude v9 (3 fontes de export, 50 arquivos
pinados, 39 referências de runtime).

## Matriz de viewports

Critérios por viewport: overflow horizontal, vídeo de hero efetivamente selecionado,
headline e CTA primária na primeira tela, erros de console e requests falhados.
Screenshots capturados após o assentamento das animações de entrada (~3,5 s).

| Viewport | Overflow | Vídeo carregado | H1 na 1ª tela | Erros |
| --- | --- | --- | --- | --- |
| 320 × 720 | 0 px | `hero-loop-mobile-1080x1920.mp4` | sim | 0 |
| 390 × 844 | 0 px | `hero-loop-mobile-1080x1920.mp4` | sim | 0 |
| 430 × 932 | 0 px | `hero-loop-mobile-1080x1920.mp4` | sim | 0 |
| 767 × 1024 | 0 px | `hero-loop-mobile-1080x1920.mp4` | sim | 0 |
| 768 × 1024 | 0 px | `hero-loop-tablet-portrait-1080x1440.mp4` | sim | 0 |
| 1024 × 600 | 0 px | `hero-loop-tablet-landscape-1440x1080.mp4` | sim | 0 |
| 1118 × 1123 | 0 px | `hero-loop-tablet-portrait-1080x1440.mp4` | sim | 0 |
| 1199 × 820 | 0 px | `hero-loop-tablet-landscape-1440x1080.mp4` | sim | 0 |
| 1200 × 820 | 0 px | `hero-loop-1080p.mp4` | sim | 0 |
| 1440 × 900 | 0 px | `hero-loop-1080p.mp4` | sim | 0 |

As trocas de composição acontecem exatamente nas fronteiras esperadas: 767→768
(mobile → tablet portrait) e 1199→1200 (tablet landscape → desktop). Os quatro assets
de vídeo dedicados respondem 200 com Range no dev server; nenhum request falhou em
nenhum viewport.

## Fallbacks

- **Sem JavaScript (390 × 844):** página íntegra com 13 seções/nós `nojs`, headline
  `Ligou? Atendido.`, 739 caracteres de texto visível, zero overflow. O conteúdo não
  depende de JS para existir.
- **Movimento reduzido (390 × 844):** zero vídeos montados, zero animações ativas,
  headline visível, zero overflow — conforme a regra de remoção de vídeos em
  `prefers-reduced-motion`.

## Comportamento observado (não é defeito)

A hero entra com fade: o wrapper fica em `opacity: 0` até ~0,5 s e chega a ~1 em
~2 s. Screenshot capturado antes disso mostra a primeira dobra vazia; é coreografia
de entrada, não regressão. Registrado para que futuros QAs automatizados esperem o
assentamento antes de capturar.

## Divergência aberta — tipografia display/dado

O contrato em `.impeccable.md` define Familjen Grotesk como display e Martian Mono
como fonte de dado. O runtime v9 usa `--font-display:'Archivo'` — herdado byte a byte
do export (`src/claude-v9/Ligou 2026 v9.html` já referencia o mesmo design system) —
e não contém nenhuma ocorrência de Martian Mono. Consequências verificadas:

- todo texto display renderiza em Archivo (confirmado no estilo computado do H1);
- `assets/fonts/familjen-grotesk-600.ttf` e sua licença OFL viajam no repo sem nenhum
  `@font-face` que os use — asset morto.

Não é perda de empacotamento deste repo: o export v9 já veio assim. Pela regra de
override visual, a v9 prevalece em conflito estritamente visual, mas a decisão não
foi registrada como deliberada em nenhum changelog. **Decisão pendente de RJ:**
(a) confirmar Archivo como display e atualizar `.impeccable.md` + remover o TTF
morto, ou (b) aplicar Familjen Grotesk ao token `--font-display`. Nenhuma das duas
foi executada; nada foi alterado silenciosamente.

## O que este QA promove

As mudanças visuais de 13–17/08 (vídeos dedicados de tablet, hero ultrawide,
correções de crop do avatar, espaçamentos, fluxo de conversão mobile) passam de
`commitadas` para `verificadas no frontend local` na matriz acima. Nada além disso:
publicação continua atrás dos gates registrados em `HANDOFF-NEXT-SESSION.md`.
