# Ligou — Visual 3: o agente operacional

**Data:** 10 de agosto de 2026

**Status:** candidato local para revisão de RJ; copy V3 ainda não congelada

**Base preservada:** commit `dd6e014` na branch `checkpoint/claude-visual-2`

## Por que esta rodada existe

O Visual 2 explicava bem o atendimento telefônico, mas deixava o diferencial central
implícito. O Visual 3 apresenta o Ligou como agente operacional: ele constrói memória
específica do negócio, consulta sistemas conectados, usa ferramentas autorizadas,
reconhece conhecimento ausente, pergunta ao dono e só incorpora a regra aprovada.

O hero `Ligou? Atendido.`, o visual EN → PT, a barra física da demo e a paleta
azul-petróleo + laranja foram preservados.

## O que mudou

- Categoria `Agente operacional bilíngue` e relação direta entre dono, Ligou e cliente
  adicionadas ao hero.
- Nova apresentação do personagem aprovado, com três modos: atender, operar e pedir
  aprovação.
- Ciclo operacional visível em sete passos, da entrevista à regra incorporada.
- A prova do produto agora separa `REGRA USADA` de `AÇÃO REALIZADA`.
- Nova seção de contato direto pelo app web, com voz/texto, contexto e autorização.
- iPhone e Android aparecem somente como etapa seguinte.
- A ligação de onboarding para o dono permanece no lançamento; ligações operacionais
  para clientes aparecem somente como próxima etapa e não foram adicionadas ao plano
  ou ao preço.
- Timeline de chamada ampliada para mostrar memória, sistemas e ferramentas nos
  bastidores.
- FAQ recebeu respostas sobre contato direto, ligações operacionais e separação da memória.
- Card Open Graph atualizado com o personagem e as fontes da marca.

## Assets e proveniência

- `docs/brand/ligou-brand-board-v1-approved.png`: board aprovada por RJ.
- `docs/brand/ligou-agent-v1-source.png`: retrato mestre em fundo paper.
- `assets/ligou-agent-v1.webp`: derivado web de 768 × 1152.
- `assets/fonts/`: duas fontes locais, com licenças OFL, usadas apenas para regenerar
  o card social de forma determinística.

Hashes e proveniência detalhados ficam em [`brand/README.md`](brand/README.md) e no
bloco Visual 3 de [`BASELINE-MANIFEST.md`](BASELINE-MANIFEST.md).

## Correções técnicas da rodada

- O CTA do cabeçalho fica `inert` e fora da árvore de acessibilidade quando a dock
  móvel ocupa seu lugar.
- A dock reage corretamente ao breakpoint de 900 px, inclusive ao redimensionar a
  janela com a página já rolada.
- O aviso temporário fica `inert` quando está invisível.
- Scroll, progresso, dock e revelação compartilham um único agendamento por frame; as
  leituras de layout acontecem antes das escritas.
- Sombras laranja que reapareciam apenas no mobile foram substituídas por elevações
  neutras.
- O conteúdo continua visível sem JavaScript; reveals são aprimoramento progressivo.

## Verificações locais concluídas

- `git diff --check`.
- `node --check script.js`.
- HTML verificado com `tidy` (sem erros; apenas avisos conhecidos sobre elementos
  decorativos vazios e atributos HTML modernos).
- SVGs verificados com `xmllint`.
- Card social confirmado em 1200 × 630, sRGB e sem canal alpha.
- Preview e assets principais respondendo HTTP 200.
- Console do Browser sem erros ou warnings.
- Inspeção responsiva em 320 × 568, 390 × 844, 768 × 1024, 1060 × 900 e 1440 × 900.
- Nenhum overflow horizontal detectado fora dos traços SVG decorativos intencionais.
- Header CTA com área mínima de 44 px; dock e estado `inert` verificados antes e depois
  do breakpoint de 900 px.

Esta rodada não declara “zero violações axe”: não há runner local fixado no projeto. A
verificação no Browser é uma inspeção local pontual, não prova de produção.

## Bloqueios de publicação que permanecem

- número real da demo;
- URL real do checkout;
- URLs de Termos e Privacidade;
- copy V3 ainda precisa de aprovação editorial para ser congelada;
- deploy, DNS e respostas HTTPS públicas não foram verificados;
- a landing page não prova backend de telefonia, app web, integrações, checkout ou
  ligações operacionais para clientes em produção.
