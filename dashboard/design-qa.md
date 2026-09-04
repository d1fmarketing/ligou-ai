# Dashboard Ligou — Design QA

## Fonte visual

- Referência aprovada: `/Users/d1f/.codex/generated_images/01a007b4-fde4-7233-94d3-60faebc66036/exec-779a40d7-b2ab-4609-ad60-bb483416347a.png`
- Dimensão original da referência: `853 × 1844`
- Estado comparado: rota `#ligou`, fixtures restauradas, duas aprovações pendentes
- Viewport principal de comparação: `430 × 932` CSS px
- Navegador usado: Browser interno do Codex

## Evidências atuais

- [Referência normalizada](qa/reference-430x932.png)
- [Resultado mobile final](qa/final-mobile-430x932.png)
- [Referência e resultado lado a lado](qa/final-comparison-430x932.png)
- [Menor telefone — topo](qa/final-mobile-320x700.png)
- [Menor telefone — ações alcançáveis](qa/final-mobile-320x700-bottom.png)
- [Tablet](qa/final-tablet-768x1024.png)
- [Viewport grande real do Browser](qa/final-large-969x1332.png)
- [Memória no mobile](qa/final-memory-430x932.png)
- [Aprovações no mobile](qa/final-approvals-430x932.png)

As capturas finais foram abertas e julgadas. A referência e o resultado mobile também foram inspecionados juntos, no mesmo tamanho. A implementação preserva a hierarquia aprovada: cabeçalho institucional, conversa operacional, cadeia causal `ligação → regra → decisão`, card de exceção, composer e navegação principal.

## Correções desta rodada

1. O QA anterior foi invalidado depois que o resize revelou uma diferença estrutural: o trilho era formado por pseudo-elementos presos aos balões e era desligado a partir de `768px`.
2. A conversa agora usa uma única timeline em grid, com trilho, avatares, contexto e aprovação no mesmo componente. O trilho permanece em todos os breakpoints e passa atrás de uma máscara opaca, nunca sobre o rosto do Ligou.
3. Mensagem de Rafael, resposta do agente e pergunta operacional compartilham o mesmo token tipográfico em cada viewport. Título, corpo e chat crescem de forma fluida, sem saltos artificiais de fonte no resize.
4. A faixa causal adapta ícones e texto entre `360` e `430px`; medições em `360`, `390` e `430px` confirmaram zero truncamento de rótulos ou valores.
5. O card de aprovação fica inteiramente alcançável acima do composer em `320 × 700`, com `50px` de folga no fim do scroll.
6. A transição desktop passou a ampliar o sidebar de modo fluido entre `1200` e `1358px`; a coluna central e o inspector não saltam quando os rótulos completos aparecem.
7. O handoff desktop distingue corretamente `Exceção pronta` de `Decisão registrada`; foi testado após concluir as duas aprovações e depois restaurar os fixtures.
8. Mensagens agora incluem a identidade do falante para leitura assistiva, mesmo quando o avatar é decorativo.
9. Os filtros de Memória quebram em linhas completas no mobile; nenhum botão fica parcialmente cortado.

## Resultado visual

- P0: nenhum.
- P1: nenhum.
- P2: nenhum.
- P3 aceito: o avatar canônico tem pequenas diferenças em relação ao robô da arte conceitual; o frontend preserva o asset oficial em vez de criar uma imitação.

## QA funcional

- Navegação por hash entre Ligou, Memória e Aprovações: passou.
- Envio de mensagem e resposta determinística: passou.
- Fallback honesto do protótipo: passou.
- Painel `Voz · demo`, frases predefinidas e ausência de captura de microfone: passou.
- Aprovação somente para o caso: passou.
- Aprovação com criação de regra, escopo e duração: passou.
- Ajuste mantendo decisão pendente: passou.
- Recusa sem alterar a Memória: passou.
- Busca e filtros de Memória: passou.
- Edição com comparação antes/depois e incremento de versão: passou.
- Revogação com confirmação e recibo local: passou.
- Persistência após reload: passou.
- Reset dos fixtures: passou.
- Recuperação de armazenamento corrompido com aviso: passou.
- Diálogos com foco inicial, Escape e retorno de foco: passou.
- Preferência de movimento reduzido: passou.
- Estado desktop sem aprovações pendentes e restauração dos fixtures: passou.

## QA responsivo

- Inspeção visual: `320 × 700`, `430 × 932`, `768 × 1024` e viewport real grande de `969 × 1332`.
- Verificação estrutural durante resize: `320`, `359`, `360`, `390`, `399`, `400`, `430`, `767`, `768`, `1024`, `1199`, `1200`, `1240`, `1280`, `1320`, `1358`, `1359`, `1360` e `1440px`.
- Alturas `820` e `821px` foram comparadas em `768px`; a antiga mudança abrupta de `68px` não existe mais.
- Sem overflow horizontal.
- Trilho operacional visível em todos os tamanhos.
- Navegação inferior no mobile, rail compacto no tablet e sidebar + inspector no desktop.
- Conteúdo permanece alcançável em `320 × 700`, inclusive legenda e ações do card acima do composer.
- Alvos interativos críticos têm aproximadamente `44 × 44px` ou mais; diferenças subpixel medidas pelo Browser ficaram abaixo de `0.01px`.
- Inputs mantêm `16px` no mobile.
- Console sem erros ou warnings da aplicação após reload.

## Gates técnicos

- Testes do gateway: `11/11` passaram.
- Build Vite: passou.
- Testes do empacotamento estático: `4/4` passaram.
- `git diff --check`: passou.

## Veredito

`final result: passed`

## 2026-09-01 — Correções da crítica de design (`#ligou`, F01–F22)

Fonte: `docs/DESIGN-CRITIQUE-2026-09-01.md`, seção "Dashboard — `#ligou` view". Copy congelada; só espaçamento, tokens, bindings, atributos e modificadores de estado. Navegador: Browser pane interno (Chrome 148 emulado, aba em primeiro plano — em segundo plano as transições congelam e a medição de F13 sai errada), fixtures restauradas (`localStorage.clear()` + reload), `scrollY 0`, safe-area 0.

### Gate F01 (obrigatório): linha de ações acima do composer na primeira tela

| Viewport | `.mobile-approval .approval-actions` (top–bottom) | `.composer` top | Folga (≥ 6px) | Resultado |
|---|---|---|---|---|
| 390 × 844 | 659.9 – 710.9 | 720 | **+9.1** | passou (legenda 728.9–742.9 acima do composer; nav 774–844; docH 939) |
| 375 × 667 | 667.6 – 768.6 na primeira tela (−225.6) → após tocar a célula "Aguardando" (`.causal-jump` → `#approval-card`): 337.6 – 438.6 | 543 | **+104.4** | passou pelo salto (scrollY 330 = máximo; foco em `#approval-card`; hash inalterado `#ligou`) |
| 320 × 700 | 2 colunas (Aprovar em linha própria), botões sem overflow, ícones 16px | 576 | — | alcançável por scroll/salto; scrollWidth 320 |

Safe-area 34px não pôde ser emulada no pane (sem `env()` override); pela aritmética o composer sobe 34px junto com o nav (`bottom: calc(max(70px, 48px + 34px) + 4px)` = 86px → top 704 em 390×844) e a folga cai para −7px — em produção sem o badge de protótipo (−26px de cabeçalho) volta a +19px. Registrar como pendência de medição em aparelho real.

### Orçamento vertical (390 × 844) — por que os números da crítica não fecharam sozinhos

Com os valores exatos da crítica (header 56, nav 70, composer 50, heading 4/8-4/6, conversa gap 12 / pad 8, row-gap 10, card 14/6/10-8) a linha de ações ficou em **−67.2px** porque a própria crítica somou +43px na faixa causal (F04) e +33px no corpo do chat (F05) depois de fechar o orçamento de F01 (27px). Fechou com, além do especificado:

- resumo do agente na largura da coluna (`max-width: min(100%, 300px)`, 5 → 4 linhas em 13px) e hora do resumo/pergunta na mesma linha do texto (`float: right`);
- faixa causal em 2 colunas por áreas nomeadas (`data-cell="call|rule|status"`): regra na coluna direita inteira, ligação + status empilhados à esquerda → 76px (a variante "Aguardando" atravessando embaixo dava 99px);
- `.conversation` gap 10 / padding-top 4, `--timeline-row-gap: 8px`, `.timeline-content--context { margin-top: -8px }`;
- card mobile 12/12/10, facts gap 5, ações 8/6 (`.mobile-approval` apenas — inspector intacto);
- heading: badge 4px, h1 6/3, régua 5/5; composer padding 2px (altura 50).

### Medições por achado

| ID | Viewport | Métrica | Valor |
|---|---|---|---|
| F02 | 390, 1440 | Aprovar John → linha 4 do timeline | `.system-message` "Você aprovou o pedido de John Miller…" (uma vez, não repetida abaixo); nenhum `.approval-card` no timeline; "Maria Alvarez" ausente na conversa; badge Aprovações 2 → 1; inspector (1440) mostra Maria **sem** kicker; `causal-icon--done` teal (`rgb(11,101,90)` sobre `rgb(234,247,242)`); nó de aprovação segue laranja enquanto Maria pende; "Nenhuma decisão pendente" nunca aparece com caso pendente |
| F03 | 390 | Aprovar `color`/`background` | `rgb(4,29,39)` sobre `rgb(255,90,54)` = **5.59:1** (13px/700); badge do nav idem 5.59:1 |
| F15 | 390 | `::placeholder` | `rgb(72,101,110)` sobre branco = **6.25:1** |
| F04 | 390 / 768 / 1440 / 320 | `.causal-strip small` / `strong` | 9 / 11px · 9.87 / 12.05 · 10 / 13 · 9 / 11; scrollWidth ≤ clientWidth e scrollHeight ≤ clientHeight em todas as células; 3 colunas a partir de 768 (tops iguais 317.5), 1 coluna em 320 |
| F05 | 390 | corpo do chat / fatos / botões / legenda / data | 13.0px (`--type-chat`); rótulos 11px; lead 15px; subtítulo 20px; conjunto visível em 390: 9 · 10 (badge) · 11 · 12 (linha do proprietário no header) · 13 · 16 (input) · 20 · 24.7 |
| F06 | 390 / 375 / 320 / 768 / 1440 | largura dos svg em Aprovar/Ajustar/Recusar | 16 / 16 / 16 / 17 / 17px; scrollWidth = clientWidth em todos os botões |
| F07 | 390, 1440 | `document.activeElement` após "Confirmar aprovação" com Aprovar focado | `.system-message` da confirmação (mobile e desktop); após Escape no mesmo caso → volta ao Aprovar (`data-approval-id` = `approval-john-urgent`) |
| F08 | 390 | Tab de Recusar → `#chat-input` | `.composer` border `rgb(11,101,90)` + box-shadow `0 0 0 3px rgb(11,101,90)`; input `outline: none` (anel na pílula, não duplicado) |
| F09 | 390 | folha de aprovação | descrição 13px, opção 15px/700, ajuda 13px, título 20px |
| F10 | 390 | eco na folha | `Solicitação` / `Regra consultada` / `Nova proposta` com `request · note`, `rule`, `proposedAction`; folha 673px (cap 743) |
| F11 | 390 | foco ao abrir | `role="dialog"` (painel), sem anel; Shift+Tab do painel → "Confirmar aprovação" (não vaza) |
| F12 | — | regras `:active` | 4 regras fora de media query (button/approval/composer/icon/profile/toast/nav) + hover em `(hover: hover)`; `color-mix` suportado |
| F13 | 390 | "Salvar como regra" | gap opções → botões 18px fechado (era 36 com o wrapper como linha própria do grid); `.rule-options-reveal` 41 → 88 → 126 → 140 → 146px em 16/50/100/150/260ms (transição, não salto); `inert` true fechado / false aberto; elemento sob o dedo após abrir: `.choice-block` (não um `<select>`) |
| F14 | 1440 | `.toast` após aprovar | 1040–1416 × 810–876 (navy vazio sob o card do inspector, card termina em 668), `animation-name: toast-in-up`; mobile segue no topo com `toast-in`; sucesso 3.2s / aviso 4.2s |
| F16 | 1440 | kicker / regra no inspector | 11px / 15px (`--leading-compact`) |
| F17 | 390, 1440 | chrome | header proprietário 12px; menu do perfil 13px; sidebar link 15px; "Restaurar demonstração" 15px; kicker "Agora" 11px; parágrafo do inspector 15px, `max-width: 40ch` |
| F18 | 390 | `.sending-status` | 12px/600, min-height 28, `status-in` com delay 120ms + `status-breathe` no ícone; no protótipo monta e desmonta no mesmo frame (MutationObserver viu o nó; nada pisca) |
| F19 | 390 | resolvido | ícone "Aguardando" teal com `decisão registrada`; `.timeline-approval-node.is-resolved` teal só com nada pendente (teste SSR); transições 240ms |
| F20 | 1440 | `.inspector-content` | grid `align-content: center`, 423px de largura (cap 428), card 375px; bloco centrado (card 358–669 na coluna de 900) |
| F21 | 1440 | handoff | `<button>` 520 × 44, `cursor: pointer`; clique foca o Aprovar do inspector; resolvido continua `<div role="status">` |
| F22 | 390 / 768 / 1440 / 320 | fim do cotovelo × borda do card | 62 = 62 · 164 = 164 · 328 = 328 (handoff) · 52 = 52 |

### Fluxos exercitados

- Aprovar → folha → Escape → foco volta ao Aprovar do mesmo caso: passou.
- Aprovar → "Salvar como regra" → transição sem salto → Confirmar → confirmação no lugar do card, badge 2 → 1, inspector com Maria: passou (390 e 1440).
- Ajustar → textarea pré-preenchida com a proposta → Cancelar: passou. Recusar → Voltar: passou.
- Voltar do navegador com a folha aberta (`#memoria` → `#ligou` → folha → back): folha fecha, rota troca: passou.
- Digitar no composer (largura do input 183.08px antes e depois da troca voz → enviar) → enviar → rascunho limpo, foco no input, resposta determinística: passou.
- Tab de Recusar → input com anel; Shift+Tab a partir do painel do diálogo → último controle: passou.
- Console sem erros nas quatro larguras.

### Gates técnicos

- `npm run test:dashboard`: 114/114 (inclui 4 testes novos de F02 em `chat-view.test.mjs` e 1 do mapper em `gateway-supabase-memory.test.mjs`).
- `npm run build`: passou.
