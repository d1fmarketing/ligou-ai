# Mapa de branches — 20 de agosto de 2026

Inventário local e remoto antes da consolidação V0.1. Nenhuma ref foi removida.
`ancestral` é o primeiro pai do tip; nomes repetidos no mesmo tip são aliases, não
trabalho independente. A disposição descreve o papel da ref nesta consolidação,
não uma autorização para apagar ou publicar nada.

| Família / refs | Tip | Ancestral | Conteúdo único no tip | Disposição |
| --- | --- | --- | --- | --- |
| V0.1: `codex/ligou-v0.1` | `8fb71b1` | `4bd563a4` | MVP unificado: landing + dashboard no mesmo deploy | base desta consolidação |
| MVP: `codex/ligou-mvp`, `origin/codex/ligou-mvp` | `8fb71b1` | `4bd563a4` | mesmo MVP unificado | preservar como alias da base |
| V9: `main`, `codex/frontend-test-coverage`, `codex/ligou-architecture`, `origin/main`, `origin/HEAD`, `origin/codex/frontend-test-coverage` | `161e8e8` | `08dd9bbf` | cobertura do frontend v9 | histórico de origem, já integrado ao MVP |
| Dashboard: `codex/ligou-dashboard`, `origin/codex/ligou-dashboard` | `278457f3` | `7f05e0c3` | dashboard na rota compartilhada | preservar; MVP é a integração selecionada |
| Fonte/QA Claude: `origin/claude/happy-bohr-ja1fme` | `db7d9c3` | `950fe6c` | Familjen 600/700, tokens, manifesto e QA; também apaga runtime MVP | merge com ancestry; aceitar somente fontes/tokens/manifesto/QA |
| Checkpoint: `checkpoint/claude-visual-2`, `origin/checkpoint/claude-visual-2` | `dd6e0149` | `56ea1d0` | checkpoint visual 2 | preservar |
| Agente V3: `codex/ligou-agent-v3`, `origin/codex/ligou-agent-v3` | `69630980` | `dd6e0149` | introduz o agente operacional | histórico de mensagem/design |
| Visual 4: `codex/ligou-design-v4`, `origin/codex/ligou-design-v4` | `72790417` | `69630980` | reconstrução da landing Visual 4 | antecedente visual |
| Claude R2: `codex/ligou-claude-r2` | `741a1475` | `72790417` | merge da direção Claude R2 | candidato histórico |
| Motion: `codex/ligou-interactive-motion` | `ee9f6856` | `741a1475` | motion interativo/scroll-scrub | experimento histórico |
| Demo: `codex/final`, `codex/leberarsite`, `codex/ligou-demo-hero` | `5d57afbf` | `ee9f6856` | restaura hero de voz | preservar; overlay só como fonte documental |
| Avatar: `codex/ligou-v9-avatar-fix` | `702326a3` | `bc252814` | avatar transparente | preservado na linha v9 |
| Ultrawide: `codex/ligou-v9-ultrawide` | `bc252814` | `a4b28a65` | mídia dedicada ultrawide | preservado na linha v9 |
| Desktop: `codex/ligou-v9-desktop-composition` | `a4b28a65` | `d6646cea` | composição sem crop | preservado na linha v9 |
| Tablet: `codex/ligou-v9-tablet-video` | `d6646cea` | `d7296c29` | vídeos dedicados tablet | preservado na linha v9 |
| Eyebrow: `codex/ligou-v9-eyebrow-padding` | `cda8a829` | `702326a3` | respiro acima da eyebrow | preservado na linha v9 |
| Wave: `codex/ligou-v9-desktop-wave-spacing` | `e37d85b1` | `cda8a829` | espaçamento do divisor desktop | preservado na linha v9 |
| Wave breakpoint: `codex/ligou-v9-wave-spacing-breakpoint` | `cb6293e0` | `e37d85b1` | espaçamento acima do mobile | preservado na linha v9 |
| Espanhol: `codex/ligou-v9-spanish-copy` | `4b5436cd` | `cb6293e0` | mensagem inclui espanhol | preservado na linha v9 |
| Memória: `codex/ligou-memory-copy` | `4f8f971d` | `4b5436cd` | memória permanente do negócio | preservado na linha v9 |
| CTA mobile: `codex/ligou-v9-mobile-cta` | `9f9710ed` | `4f8f971d` | remove CTA secundária mobile | preservado na linha v9 |

## Regra de leitura

Os tips v9 formam uma cadeia de intervenções de 10–14/08 que culmina em `161e8e8`;
o MVP `8fb71b1` é descendente dessa linha. A branch Claude `db7d9c3` também parte do
MVP, mas suas remoções de dashboard, builder, Supabase, controller e infraestrutura
não são adotadas. Esta V0.1 mantém as refs e registra a fusão para tornar visível a
proveniência de tipografia e QA.
