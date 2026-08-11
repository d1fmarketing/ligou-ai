# Ligou — restauração da demo e reconstrução do hero

**Data:** 11 de agosto de 2026

**Branch:** `codex/ligou-demo-hero`

**Base:** Higgsfield Motion no commit `ee9f685`

**Estado:** candidato local; nenhuma publicação autorizada

## Por que esta rodada existe

O hero Higgsfield Motion transformou a primeira dobra em um scrollytelling de três
vídeos e repetiu a mesma narrativa da seção operacional. A demo de voz, que era a
prova principal da Visual 1, continuou tecnicamente configurável, mas foi rebaixada
para `Ver o Ligou trabalhar / Acompanhar o fluxo` e passou a apontar silenciosamente
para a prova ilustrativa quando o telefone estava vazio.

O histórico confirma a regressão:

- Visual 1 (`56ea1d0`): CTA `Ligue para a demonstração ao vivo`, telefone visível,
  nota `Não é gravação` e navegação por `tel:` quando `demoPhoneHref` existisse;
- Visual 4 (`7279041`): o estado local passou a trocar a promessa de voz por
  `Ver o Ligou trabalhar` e `#prova`;
- Higgsfield Motion (`ee9f685`): hero com `320svh` no desktop, `360svh` no mobile e
  três MP4s buscados por `currentTime` durante o scroll.

Nenhum commit contém um número real. Esta rodada restaura a superfície e o contrato
de interação, mas não inventa telefonia ou backend.

## O que mudou

### Hero

- remove o sticky e toda a timeline de três vídeos da primeira dobra;
- retorna o hero a fluxo normal, próximo da primeira viewport;
- preserva `Ligou? Atendido.`, azul-petróleo, laranja e a leitura EN → PT;
- usa uma única pose de atendimento e uma prova visual contínua:
  `cliente EN → regra aprovada → retorno PT`;
- limita o motion a uma waveform CSS curta, desligada em movimento reduzido;
- elimina o painel de microtexto, rail de progresso e troca brusca de enquadramento.

### Demo de voz

- restaura `Falar com o Ligou` no cabeçalho, hero, encerramento e dock móvel;
- quando `demoPhoneDisplay` e `demoPhoneHref` existem, todas as ações mudam para
  `tel:` e exibem o número real;
- quando estão vazios, o clique mostra um aviso explícito de bloqueio local;
- a ligação ilustrativa permanece disponível por um link secundário;
- sem JavaScript, o CTA ainda leva à prova ilustrativa e nenhum conteúdo desaparece.

### Três vídeos

Os três MP4s não foram apagados. Eles continuam somente em `Uma ligação. Três
estados`, onde cada vídeo corresponde semanticamente a atendimento, operação e
aprovação. No desktop alto, o progresso é sticky; no mobile, cada cena é empilhada e
o respectivo vídeo responde ao scroll local. Movimento reduzido mantém apenas os
posters.

### Código e acessibilidade

- remove variáveis, listeners e funções exclusivos do hero scrollytelling;
- remove CSS legado do ciclo Claude R2 e do hero de três vídeos;
- preserva o dock móvel automático e seu `inert` somente enquanto oculto;
- mantém o CTA de voz totalmente visível em 390 × 844 e 320 × 720;
- aumenta rótulos do painel para o piso de legibilidade do projeto;
- remove a grade decorativa detectada como assinatura genérica de UI gerada.

## QA local

Executado no preview range-aware `http://127.0.0.1:4174/`:

- desktop: 1280 × 720 e 1366 × 600;
- landscape: 932 × 430;
- mobile: 390 × 844 e 320 × 720;
- zero overflow horizontal nos tamanhos acima;
- CTA local mostra aviso, sem salto silencioso para `#prova`;
- dock móvel aparece automaticamente depois do hero e permanece na zona do polegar;
- scroll operacional confirmou `attending → operating → approval` e tempo de vídeo
  diferente de zero em cada estado;
- sem JavaScript: hero, prova e três cenas continuam completos;
- movimento reduzido: hero sem waveform, operação sem sticky e nenhum MP4 carregado;
- `node --check script.js` e `git diff --check` passaram;
- `npx impeccable --json index.html` passou após os ajustes de legibilidade e
  remoção da grade decorativa.

Essa validação cobre somente o frontend local. Não comprova número, chamada real,
agente de voz, backend, checkout, produção ou capacidade prometida.

## Arquivos renderizados alterados

- `index.html`;
- `styles.css`;
- `script.js`;
- `.impeccable.md`;
- `docs/source/LIGOU-COPY-V4-WORKING.md`.

README, handoff e manifesto receberam apenas o registro desta rodada. Os blocos de
hash anteriores permanecem imutáveis.
