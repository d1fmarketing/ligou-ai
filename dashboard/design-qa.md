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
