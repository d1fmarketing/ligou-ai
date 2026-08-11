# Ligou — Visual 4: Ligou em cena

**Data:** 10 de agosto de 2026
**Status:** candidato local; copy V4 ainda não congelada
**Branch:** `codex/ligou-design-v4`
**Base preservada:** Visual 3 no commit `6963098`

## Decisão central

O Visual 4 deixa de tratar o personagem como uma seção adicional. O Ligou passa a
conduzir a página inteira: atende, opera e pede aprovação. A arquitetura caiu de 12
para cinco seções e de uma narrativa explicativa longa para 665–700 palavras visíveis,
conforme viewport e aprimoramento progressivo.

Continuam preservados o headline `Ligou? Atendido.`, a leitura EN → PT, a paleta
azul-petróleo + laranja, a tipografia e a demonstração como ação primária.

## O que mudou

- Hero de aproximadamente uma viewport, com o Ligou atravessado pela linha telefônica,
  estado de regra encontrada e resumo em português.
- Strip curto de setores dentro do hero, sem criar uma sexta seção.
- Storytelling operacional em três estados: `Atendendo → Operando → Pedindo aprovação`.
- No desktop, a história usa uma superfície sticky de aproximadamente 300vh sem
  prender o scroll. Mobile, ausência de JS e movimento reduzido exibem as três cenas
  completas em sequência.
- Uma única superfície escura reúne a ligação recebida e a conversa com o Ligou. As
  abas têm teclado e ARIA; sem JavaScript, as duas provas permanecem visíveis.
- O preço virou cartaz editorial: oficial de $499/mês, condição Founding de $299 e
  progressão explícita 25/75/100, sem contador de vagas.
- A ativação gratuita está vinculada explicitamente aos 100 primeiros, não apenas ao
  primeiro grupo de 25.
- Inclusões condensadas em seis grupos; ativação reduzida a três passos.
- FAQ reduzido às seis objeções decisivas e fechamento direto com a demo.
- Enquanto o número real não existe, o CTA abre a prova ilustrativa que já funciona
  na página. Telefone e a frase `Ao vivo` só aparecem quando `demoPhoneHref` e
  `demoPhoneDisplay` recebem valores reais.
- Hero e metadados qualificam as capacidades como `no lançamento`; a prova é marcada
  visivelmente como demonstração ilustrativa.
- Removidos: progress bar global, reveal genérico, timer, grids decorativos, side
  stripes, cards repetidos, microtexto abaixo de 11 px e animações sem função.

## Motion

O hero entra em uma sequência única de 0–1.320 ms. Depois, um ciclo discreto de 5,6 s
move apenas o pacote da ligação. O storytelling atualiza `--scene-progress` em um
único `requestAnimationFrame`, muda de estado em 28% e 62% e pausa quando sai da
viewport. A implementação usa somente `transform` e `opacity` para motion visual.

Não há scroll hijacking, áudio automático, partículas, bounce, robô respirando,
WebGL ou biblioteca de animação.

## Assets V4

As três poses foram geradas por referência no Higgsfield a partir da board aprovada.
A primeira geração foi rejeitada por reconstruir uma board; a única rodada de
correção recebeu recortes separados de identidade e pose. O fundo foi removido pelo
próprio Higgsfield e os WebPs finais foram otimizados localmente para 640 × 857:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `assets/ligou-atendendo-v1.webp` | 29.646 | `8190db2ca191acacf052461522c9fc6b6710a55232eca4b1b1344a8e3db9e336` |
| `assets/ligou-operando-v1.webp` | 30.684 | `8f9b6661a6fd5837b07b867afb0ca7a58c348293702b8bf8790c5ed9d1d0343e` |
| `assets/ligou-aprovacao-v1.webp` | 28.412 | `b1a284345e4f6a42abcf8a908d78e5b621397fbc4dd27467ffadf321244a4387` |

Prompt, URLs de geração, dimensões originais e hashes ficam no registro de
proveniência em [`brand/README.md`](brand/README.md).

Três derivados master de 3584 × 4800, com alpha, também ficam em
`docs/brand/masters/`. Assim, novas exportações não dependem da permanência das URLs
remotas e os PNGs originais de 45 MB não inflam o repositório.

## Verificações locais

- cinco seções em `main`; 665–668 palavras com JavaScript e 700 no fallback sem JS;
- zero overflow em 320, 390, 768, 1060 e 1440 px;
- 9.563 px de altura em 390 × 844 e 10.150 px em 320 × 568;
- fonte mínima de 12 px e nenhum controle visível abaixo de 44 × 44 px;
- experiência completa sem JavaScript e com `prefers-reduced-motion: reduce`;
- sem JavaScript, a demo navega até a prova ilustrativa; reserva e links legais seguem
  até o bloqueio local visível, em vez de virarem botões silenciosos;
- thresholds do storytelling confirmados exatamente em 28% e 62%, inclusive ao
  voltar o scroll;
- abas confirmadas com `ArrowLeft`, `ArrowRight`, `Home` e `End`;
- auditoria local axe-core 4.11.4: zero violações WCAG A/AA selecionadas;
- `impeccable`: zero alertas de tiny text, contraste, side stripe, pulsing dot,
  nested cards ou padding;
- amostra de fluidez com CPU 4×: p95 de 9,2 ms e nenhum frame acima de 9,4 ms na
  hero ou no sticky do Chrome headless local;
- `node --check script.js` e `git diff --check`.

Essas verificações descrevem o preview local; não provam produção, backend ou rede de
um aparelho físico.

## Gauntlet Loop

A rubrica foi congelada antes da execução: briefing, board aprovada, cinco seções,
Founding 25/75, status presente versus próxima etapa, 650–750 palavras, limites de
altura, motion, acessibilidade e performance.

- **Rodada 1:** Brief 8,2; System 8,5; Craft 7,0. Foram corrigidos claims sem status,
  uso do retrato antigo na hero, enquadramento e composição.
- **Rodada 2:** Brief 9,6 e System 9,1. Duas leituras intermediárias de Craft foram
  descartadas antes do gate: uma recebeu um screenshot enquanto ele era sobrescrito;
  outra recebeu um montage deslocado por coordenada relativa e não mostrou o estado
  03. Eram defeitos da evidência, não resultados de release.
- **Rodada 3 / gate final:** Brief 10,0; System 9,2; Craft 9,1; `critique` 36,5/40;
  zero P0, zero P1 e zero falha de carga cognitiva.

O P2 remanescente de Craft é a legibilidade do texto auxiliar quando os três frames
de 1440 × 900 são reduzidos para um único panorama de 1440 × 300; os frames individuais
mantêm a escala original. System registrou como polimento futuro a ambiguidade do
check laranja em `Operando` e a densidade da base da hero móvel. Nenhum deles bloqueia
o snapshot local.

## Bloqueios de publicação

- número real da demo;
- URL real do checkout;
- URLs reais de Termos e Privacidade;
- fonte operacional para inventário Founding;
- copy V4 ainda não congelada;
- prova de backend para telefonia, app web, memória, agenda e ferramentas;
- deploy, DNS e HTTPS públicos.

A V4 permanece local até esses itens serem reais.
