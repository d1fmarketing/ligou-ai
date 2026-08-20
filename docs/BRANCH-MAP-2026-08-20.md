# Mapa de branches — 20 de agosto de 2026

Inventário das famílias locais/remotas que fundamentaram a consolidação V0.1.
Nenhuma ref Git foi removida. `ancestral` é o primeiro pai do tip; nomes repetidos no
mesmo tip são aliases, não trabalho independente. A disposição descreve o papel da
ref nesta consolidação, não uma autorização para apagar ou publicar nada.

## Âncora e tip ativo

- **Base-fonte do MVP:** `8fb71b1`.
- **Consolidação sanitizada:** a branch ativa é um único merge limpo cujos pais são
  `8fb71b1` (MVP) e `db7d9c3` (QA/tipografia Claude). O tip é identificado
  simbolicamente para não registrar um SHA autocontraditório dentro dele próprio.
- **Integração ativa:** `codex/ligou-v0.1` é identificada simbolicamente como a branch
  atual e o commit que contém este documento. `git rev-parse codex/ligou-v0.1` é o
  tip vivo; não se fixa aqui um SHA autocontraditório que ficará obsoleto ao próximo
  commit da própria integração.
- **Exclusão explícita:** `codex/ligou-v0.1-hardening-wip@b69e5df` não integra esta
  consolidação e não é candidato a merge nesta rodada.

| Família / refs | Tip | Ancestral | Conteúdo único no tip | Disposição |
| --- | --- | --- | --- | --- |
| V0.1: `codex/ligou-v0.1` | tip vivo: `git rev-parse codex/ligou-v0.1` | primeiro pai `8fb71b1`; segunda fonte `db7d9c3` | integração ativa da landing + dashboard unificados e da consolidação | branch atual; preservar e avançar por commits |
| MVP: `codex/ligou-mvp`, `origin/codex/ligou-mvp` | `8fb71b1` | `4bd563a4` | mesmo MVP unificado | preservar como alias da base |
| V9 local: `main` | `08dd9bbf` | anterior a `161e8e8` | estado local anterior à cobertura mais recente | preservar como histórico local; não confundir com `origin/main` |
| V9 remoto: `origin/main`, `origin/HEAD`, `origin/codex/frontend-test-coverage`, `codex/frontend-test-coverage`, `codex/ligou-architecture` | `161e8e8` | `08dd9bbf` | cobertura do frontend v9 | histórico de origem, já integrado ao MVP |
| Dashboard: `codex/ligou-dashboard`, `origin/codex/ligou-dashboard` | `278457f3` | `7f05e0c3` | dashboard na rota compartilhada | preservar; MVP é a integração selecionada |
| Fonte/QA Claude: `origin/claude/happy-bohr-ja1fme` | `db7d9c3` | merge-base `161e8e8` | somente tipografia Familjen (incluindo 700), tokens, manifesto e QA | divergente de `origin/main`; incorporar apenas QA/tipografia, nunca remoções de runtime |
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
| Hardening WIP: `codex/ligou-v0.1-hardening-wip` | `b69e5df` | `678730a` | trabalho posterior de hardening | preservar isolado; excluído desta consolidação |

## Regra de leitura

Os tips v9 formam uma cadeia de intervenções de 10–14/08 que culmina em `161e8e8`;
o MVP `8fb71b1` é descendente dessa linha. A branch Claude `db7d9c3` diverge de
`origin/main` no merge-base `161e8e8` e contém somente a revisão de QA/tipografia
identificada acima. Esta V0.1 mantém as refs e registra a proveniência de tipografia e
QA sem incorporar `codex/ligou-v0.1-hardening-wip`.
