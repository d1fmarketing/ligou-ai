# Ligou — handoff para a próxima sessão

**Atualizado:** 11 de agosto de 2026

**Estado:** Claude Design v9 exportada e integrada como checkpoint Git local; o
worktree anterior em `codex/ligou-demo-hero` continua sujo e integralmente preservado;
nenhum push, PR ou deploy foi executado ou comprovado

**Ponto de retomada visual:** fonte exata em `src/claude-v9/`, recebida no ZIP
`/Users/d1f/Downloads/Ligou 2026 animated page.zip`, SHA-256
`fef5f9d32b5d8de954e86b995dbb3c582567a892dd4ab028a11a940e2c2837fd`; projeto Claude
Design `d2f45323-f5fb-4e26-8aa8-113c31cce65d`, arquivo `Ligou 2026 v9.html`.

**Ponto de retomada local:** `main` aponta para o checkpoint Claude v9 deste documento;
o runtime usa `index.html`, fontes JSX preservadas, JavaScript pré-compilado e assets
locais. `origin/main` continua no Visual 1 porque não houve push. Higgsfield Motion,
Claude R2, V4 e Demo Hero Restore permanecem no histórico linear.

## Atualização de integração — export Claude v9

O ZIP chegou depois da primeira redação deste handoff e tornou obsoletas duas
pendências: a v9 agora está exportada, e o pacote já contém a reconstrução estrutural da
prova mobile. A integração foi feita num worktree isolado baseado em `5d57afb`; nenhuma
mudança, imagem ou frame de QA do worktree sujo original foi adicionado, descartado ou
reescrito.

Entraram somente `Ligou 2026 v9.html`, `ligou-app9.jsx`, `ligou-fx2.jsx`, o fechamento
de runtime do design system e os assets referenciados. Versões v2–v8, `uploads/`,
`.thumbnail` e duplicatas ficaram fora. A origem byte a byte, a embalagem técnica, os
hashes e o QA estão em [`CHANGELOG-CLAUDE-V9.md`](CHANGELOG-CLAUDE-V9.md).

## Atualização de continuidade — Claude Design v9

Esta é a verdade mais recente da rodada visual. Ela tem prioridade sobre descrições
anteriores deste arquivo quando o assunto for a página observada no Claude Design.

### O que RJ aprovou nesta rodada

- Hero escura, com `Ligou? Atendido.`, cena operacional conectada e o agente oficial.
- Marca corporativa baseada no símbolo **Agent Node** (opção 1 da prancha aprovada na
  conversa); o telefone laranja continua no peito do personagem como explicação do
  canal, não como logo da empresa.
- Imagem/vídeo da hero como asset real. Texto, botões e navegação continuam em HTML;
  não devem ser gravados dentro da imagem.
- Desktop com vídeo horizontal e mobile com vídeo vertical dedicado. Não reutilizar o
  vídeo desktop por meio de crop no telefone.
- Segunda dobra com `O Ligou não é configurado. Ele é contratado.` e a sequência
  `Conversa → Suas regras → Em operação`, usando exemplos da Califórnia: San Francisco,
  Bay Area, Los Angeles e San Diego. Não usar cidades brasileiras; o público é o dono
  brasileiro de empresa de serviços nos Estados Unidos.
- Dobra de prova em fundo claro, com conversa em inglês, eventos causais, regra
  consultada, ação executada e resumo em português. Usar o agente preto aprovado, não
  avatares genéricos ou recortes ruins.
- Direção de copy escolhida para a prova: tornar explícita a cadeia
  `cliente fala → Ligou responde → regra/ação acontece → dono recebe a exceção pronta`.

### Correção concluída por último

O defeito observado em aproximadamente 1118 px era um buraco de breakpoint: copy de
desktop, fluxo empilhado e vídeo 16:9 apareciam juntos, criando uma grande faixa escura
sem informação e empurrando a cena para fora da primeira tela.

A v9 agora usa três composições:

- `<= 767 px`: mobile preservado, fluxo vertical e
  `hero-loop-mobile-1080x1920.mp4`;
- `768–1199 px`: tablet/intermediário em duas colunas, aproximadamente 47% copy e 53%
  cena, vídeo vertical com `object-fit: contain`, CTAs empilhadas e hero de 680–720 px;
- `>= 1200 px`: desktop preservado com `hero-loop-1080p.mp4` horizontal.

O headline continua em duas linhas, a promessa e a CTA principal ficam visíveis junto
da cena, e o ticker claro passa a funcionar como separação da hero.

### QA efetivamente executado na v9

QA independente no Browser interno confirmou:

- 390 × 844: mobile preservado, asset vertical correto e zero overflow horizontal;
- 767 × 1024 e 768 × 1024: transição mobile/tablet correta;
- 1024 × 600: promessa, CTA principal e núcleo da cena visíveis; CTA secundária e
  garantia podem continuar abaixo da dobra sem reduzir legibilidade ou touch targets;
- 1118 × 1123: problema original corrigido; copy e operação aparecem simultaneamente,
  sem faixa morta;
- 1199 × 820 e 1200 × 820: troca correta entre vídeo vertical/tablet e
  horizontal/desktop;
- vídeos carregados: 1080 × 1920 no mobile/tablet e 1920 × 1080 no desktop;
- nenhum dos viewports testados apresentou overflow horizontal.

A matriz acima foi repetida no Browser interno contra o runtime local integrado. Ela
prova export, fechamento de assets e apresentação do frontend local; não prova
telefonia, backend, checkout, oferta, publicação ou deploy.

### Problemas ainda abertos na v9

1. **Timing mobile:** a prova agora é um único console com bubbles, eventos e drawer,
   mas o export conclui as entradas em aproximadamente 2,85 s, com passos de 0,45 s.
   Isso diverge da meta anterior de 0,8–1,1 s por passo e ciclo de 6–8 s. Não ajustar
   silenciosamente; requer nova decisão visual.
2. **Protótipo versus produto:** demo, aprovação, ajuste, Founding, Termos e Privacidade
   continuam placeholders ou ações ilustrativas. `DEMO_PHONE` é `(XXX) XXX-XXXX`.
3. **Copy e oferta:** a página reproduz a candidata v9, mas isso não congela preço,
   capacidade, inventário ou promessas de backend.
4. **Produção:** o runtime local está fechado, com React production, fontes locais,
   fallback sem JS e `noindex`; isso não autoriza push ou deploy.

### Assets produzidos/observados nesta rodada

Fontes de vídeo recebidas de RJ:

- desktop: `/Users/d1f/Downloads/hf_20260811_231429_177f7db0-2f12-4935-91a3-9c45e137a0d9.mp4`;
- mobile: `/Users/d1f/Downloads/hf_20260811_233243_4391499c-f219-4618-95af-cdd50278f571.mp4`.

Derivados preservados no worktree sujo original, ainda não rastreados naquela branch:

- `assets/hero/ligou-hero-loop-1080p.mp4` — SHA-256
  `227a4dc02d235964048154a26acf8b6a141557f678740a4b2604e4f4b342d29b`;
- `assets/hero/ligou-hero-loop-mobile-1080x1920.mp4` — SHA-256
  `f8a1cb28eefb5cde5ecf977bb071fc80fe5017808fbcd8e6c4c1c6921fbee860`;
- `assets/hero/ligou-hero-poster-mobile.png` — SHA-256
  `e253dee1710399fae65baf07415cc5757ca9f50eafa0662ac77946ecff663a99`;
- `assets/video-review/` contém frames de QA de desktop e mobile.

No checkpoint v9, os vídeos e posters curados ficam diretamente em `assets/` com os
nomes usados pelo export. Os hashes de desktop, mobile e poster mobile continuam
idênticos aos registrados acima.

Referências visuais geradas nesta conversa ficam em
`/Users/d1f/.codex/generated_images/019ff1de-4bab-70b0-a703-5757475aee8f/`.
Atalhos curados nessa pasta:

- `01-ligou-hero-approved-reference.png` — hero completa aprovada;
- `02-ligou-hero-art-desktop.png` — cena desktop sem a copy da página;
- `03-ligou-hero-art-mobile.png` — composição vertical;
- `04-ligou-logo-options-reference.png` — prancha que contém o Agent Node selecionado;
- `exec-afddd7a7-4da5-4605-b272-75a142036c39.png` — prova do produto aprovada com o
  agente correto.

Não presumir que toda geração da pasta foi aprovada; usar as decisões acima.

### Separação obrigatória de superfícies

- **Claude Design v9:** fonte visual mais recente, exportada e preservada byte a byte.
- **Git local/main:** checkpoint executável da v9, com embalagem local auditável.
- **Worktree anterior:** `codex/ligou-demo-hero` continua com mudanças não commitadas
  separadas; ele não foi convertido nem limpo.
- **Origin/produção:** nenhum push, PR ou deployment desta rodada foi executado ou
  comprovado.

Pode-se dizer que a v9 está implementada no Git local. Não dizer que está publicada,
em produção, com demo real ou sincronizada ao GitHub.

## Comece por aqui

Leia nesta ordem:

1. este handoff;
2. [`CHANGELOG-CLAUDE-V9.md`](CHANGELOG-CLAUDE-V9.md);
3. [`source/LIGOU-PRODUCT-BRIEF-WORKING.md`](source/LIGOU-PRODUCT-BRIEF-WORKING.md);
4. [`.impeccable.md`](../.impeccable.md);
5. [`CHANGELOG-DEMO-HERO-RESTORE.md`](CHANGELOG-DEMO-HERO-RESTORE.md);
6. [`CHANGELOG-HIGGSFIELD-MOTION.md`](CHANGELOG-HIGGSFIELD-MOTION.md);
7. [`CHANGELOG-CLAUDE-R2.md`](CHANGELOG-CLAUDE-R2.md);
8. [`CHANGELOG-VISUAL-4.md`](CHANGELOG-VISUAL-4.md);
9. [`source/LIGOU-COPY-V4-WORKING.md`](source/LIGOU-COPY-V4-WORKING.md);
10. [`brand/LOGO-EXPLORATION-WORKING.md`](brand/LOGO-EXPLORATION-WORKING.md);
11. [`BASELINE-MANIFEST.md`](BASELINE-MANIFEST.md), apenas como histórico append-only.

Para continuar a rodada visual, não reabra decisões de produto que não afetam a dobra
em trabalho. A próxima escolha visual concreta é o timing da prova mobile. Oferta,
idioma, vertical inicial, escopo do MVP, demo segura e autoridade dos conectores
continuam gates de publicação, não bloqueios para preservar este checkpoint.

## Estado Git e repositório verificado

- Repositório público: `https://github.com/d1fmarketing/ligou-ai`
- `main` local → checkpoint Claude v9 deste documento
- `origin/main` → `56ea1d0` (Visual 1; não recebeu push)
- Checkpoint Claude Visual 2: `checkpoint/claude-visual-2` → `dd6e014`
- Visual 3: `codex/ligou-agent-v3` → `6963098`
- Visual 4: `codex/ligou-design-v4` → `7279041`
- Claude R2: `codex/ligou-claude-r2` → `741a147`
- Higgsfield Motion: `codex/ligou-interactive-motion` → `ee9f685`
- Demo Hero Restore: `codex/ligou-demo-hero` → `5d57afb`, com trabalho posterior sujo
- A branch V4 estava sincronizada com `origin` antes desta documentação.
- Não existia pull request da V4 e nenhum PR foi criado para Claude R2.
- Nenhum deployment público foi comprovado; GitHub Pages respondia 404.
- O preview range-aware `localhost:4174` foi validado nesta rodada; não presumir que o
  processo continue ativo em outra sessão. Reiniciar com `node dev-server.mjs`.

Estado preservado no worktree anterior, separado do checkpoint v9:

```text
## codex/ligou-demo-hero
 M index.html
 M script.js
 M styles.css
?? Codex Image Aug 10, 2026, 05_14_43 PM.png
?? Codex Image Aug 11, 2026, 03_36_50 PM.png
?? assets/hero/
?? assets/video-review/
```

A imagem de 10 de agosto continua sendo duplicata byte a byte da board aprovada,
SHA-256 `11a023067474e671bf13026f2e8e5f0cf35c06fb47c2cdf54ddb21dffef071da`.
Não adicionar, apagar, descartar ou atribuir origem aos demais arquivos sem auditoria.

## O que foi preservado

- Visual 1 preservado no commit `56ea1d0` e no remoto `origin/main`;
- checkpoint separado do Claude Visual 2;
- Visual 3 com o agente operacional;
- Visual 4 com cinco seções e narrativa `Atendendo → Operando → Pedindo aprovação`;
- Claude R2 como descendente direto da V4, sem sobrescrever nenhum snapshot anterior;
- Higgsfield Motion como descendente do Claude R2, em branch própria;
- Demo Hero Restore como descendente de Higgsfield Motion, sem reescrever o checkpoint rejeitado;
- Claude v9 como descendente de Demo Hero Restore, com a fonte exportada preservada;
- copy v2.1 congelada e V3/V4 marcadas como `WORKING`;
- brand board v1 aprovada;
- retrato e três poses do personagem com masters e hashes;
- manifesto de integridade de cada snapshot.

Os hashes do bloco Visual 4 continuam válidos. Claude R2 recebeu um bloco próprio no
manifesto e não reescreve os hashes anteriores.

O checkpoint Claude R2 consolidou:

- o handoff, product brief, registro de logo e as duas pranchas de exploração;
- a nova marca vetorial `assets/logo-mark.svg` e `assets/logo-line.svg`;
- header, footer e favicon ativo com a marca **A Linha**;
- hero vertical animada de 12 s, portada do Claude para o HTML/CSS estático;
- changelog Claude R2, novo bloco de manifesto e novos pontos de entrada no README.

`script.js`, a copy V4, as seções abaixo do fold, os WebPs do agente e o OG ficaram
byte a byte iguais ao Visual 4.

Esta rodada Higgsfield Motion acrescenta:

- três MP4s Seedance 2.5 gerados no Browser interno em modo Unlimited;
- três posters derivados do frame 0, para o fallback manter o mesmo enquadramento;
- correção dos três fundos para o mesmo `#F8F8F5` da landing;
- hero sticky com narrativa `EN entra → regras operam → PT volta` ligada ao scroll;
- reutilização dos vídeos na seção de operação, também com scrub reversível;
- mobile sem botão de vídeo, autoplay ou loop: tudo responde à rolagem;
- `dev-server.mjs` com HTTP Range para o preview local;
- fallback estático sem JavaScript e remoção dos vídeos em movimento reduzido;
- fallback não-sticky em viewports com menos de 700 px de altura;
- changelog e manifesto próprios, sem reescrever hashes históricos.

A primeira geração de atendimento foi rejeitada por movimento sem criatividade e
fundo bege. Não houve diagnóstico de deformação do robô. Jobs, URLs, prompts e hashes
estão em `CHANGELOG-HIGGSFIELD-MOTION.md`.

Esta rodada Demo Hero Restore corrige a regressão sem apagar o trabalho anterior:

- remove os três vídeos e o sticky somente da hero;
- restaura `Falar com o Ligou` como ação dominante e repete a mesma ação no header;
- recupera o `tel:` configurável da V1, com bloqueio local explícito enquanto o número
  real não existe;
- usa uma única prova `cliente EN → regra → retorno PT` com uma pose de atendimento;
- preserva os três vídeos na seção operacional sincronizada ao scroll;
- mantém no mobile a CTA full-width no hero e o dock automático depois da dobra;
- registra mudanças e QA em `CHANGELOG-DEMO-HERO-RESTORE.md`.

Fonte do merge: `/Users/d1f/Downloads/Ligou Design System.zip`, 3.696.405 bytes,
SHA-256 `3e4319ddf66eaebe1bf2ea1f6ed30e402fb584c9b48e8342d30a291492374238`.
O ZIP não foi espalhado pela raiz: ele continha previews atuais junto com resíduos e
duplicatas de rodadas antigas. O mapa de inclusão/exclusão está no changelog.

## Estado do último checkpoint local — não confundir com a v9

- Este bloco descreve o checkpoint `5d57afb`, não as mudanças locais posteriores nem a
  página `Ligou 2026 v9.html` no Claude Design.
- Site estático do checkpoint: `index.html`, `styles.css` e `script.js`.
- Cinco seções: hero, operação, prova, Founding e FAQ/encerramento.
- Hero em fluxo normal, sem vídeos, com uma única prova `EN → regra → PT` e demo de
  voz como ação principal.
- As três cenas têm coreografias diferentes: sinal de voz e gesto de escuta; rotas de
  memória/agenda/ferramentas; pulso de decisão incompleta e mão aberta esperando o ok.
- Os três MP4s aparecem somente na seção “Uma ligação. Três estados”.
- Não existem botões de vídeo no mobile; o scroll é o único controlador.
- Fallback completo sem JavaScript e com movimento reduzido.
- Header, footer e favicon ativo usam a marca v2 **A Linha**.
- O OG ainda é o arquivo V4 e deve ser regenerado antes de publicar.
- O handset permanece no peito do personagem como badge provisório do canal, não como
  marca corporativa.
- `SITE_CONFIG` está vazio para:
  - `demoPhoneDisplay`;
  - `demoPhoneHref`;
  - `checkoutUrl`;
  - `termsUrl`;
  - `privacyUrl`.
- Sem número real, o CTA mostra bloqueio local explícito; a prova ilustrativa é um
  link secundário.
- Checkout e links legais permanecem deliberadamente bloqueados.

Demo Hero Restore passou por QA no Browser interno em 1280 × 720, 1366 × 600,
932 × 430, 390 × 844 e 320 × 720, incluindo clique da demo, dock móvel, três estados
operacionais, fallback sem JS, movimento reduzido e overflow. Essa validação cobre o
frontend local, não telefonia, backend, aparelho físico ou produção.

## Decisão estratégica mais recente

O problema principal da copy atual é reduzir o Ligou a “atende em inglês e entrega um
resumo”. A direção consolidada é:

> **O Ligou é um agente operacional. O idioma é a porta; o agente é o produto.**

O foco comercial continua sendo o inglês para donos brasileiros nos EUA, mas o produto
deve deixar claro que pode atender em outros idiomas. O dono conversa com o Ligou em
português. O agente constrói memória específica do negócio, consulta CRM e sistemas,
usa ferramentas autorizadas, executa dentro das regras, detecta uma lacuna, pergunta ao
dono e incorpora somente a regra aprovada.

O dono pode continuar a conversa com o agente por voz ou texto, perguntar sobre uma
ligação, corrigir uma regra e autorizar ações. App web é direção de lançamento;
iPhone/Android e ligações operacionais para clientes permanecem roadmap até prova real.

Detalhes e fronteiras estão no product brief.

## Logo: estado atual

As duas pranchas raster continuam preservadas como processo em
`docs/brand/explorations/`. Depois delas, RJ trabalhou duas vezes no Claude e confirmou
que a segunda versão do Claude era a mais recente. O merge selecionou a direção vetorial
**A Linha** presente nesse export.

Aplicação atual do candidato local:

- `assets/logo-mark.svg`: header, footer e favicon;
- `assets/logo-line.svg`: master monocromático;
- handset no peito: badge provisório do canal telefônico;
- OG: ainda V4, pendente de regeneração.

Não usar os PNGs exploratórios como logo e não declarar a identidade pública como
congelada antes de uma Brand Board V2 aprovada.

## Decisões abertas que bloqueiam nova copy

### 1. Oferta Founding

O Visual 4 implementa 25/75/100:

- primeiros 25: `$299/mês` enquanto ativos;
- próximos 75: `$299/mês` por 12 meses, depois `$499`;
- depois dos 100: `$499/mês`;
- ativação de `$499` gratuita para os 100 primeiros.

A conversa estratégica também contém propostas Founding 100 por 12 meses e uma abertura
menor Founding 10/Early 25. A estrutura atual é candidata, não congelada.

### 2. Idiomas

Confirmado: inglês é o foco comercial e qualquer idioma é a capacidade pretendida.
Pendente: a frase pública exata e a prova técnica dos idiomas suportados.

### 3. Escopo do MVP

Pendente: quais integrações, ações e canais estarão realmente disponíveis no lançamento,
e qual vertical será atendida primeiro.

### 4. Identidade

Direção aplicada: **A Linha**. Pendente: Brand Board V2, testes finais de redução e
fundos, lockups, OG v2 e aprovação definitiva da regra marca corporativa versus badge
telefônico do personagem.

### 5. Demonstração

Pendente: número, tenant isolado, ferramentas sandbox, limites de abuso, consentimento,
SMS de saída e handoff para checkout.

### 6. Arquitetura e autoridade

Pendente: confirmar se `COMANDO` continua sendo o nome do motor interno; quais
conectores de CRM/MCP/agenda existirão no dia um; quais ações são somente leitura;
quais podem escrever; e qual aprovação é exigida para cada classe de ação.

## Bloqueios absolutos de publicação

- número real da demo;
- URL real do checkout;
- Termos;
- Política de Privacidade;
- inventário Founding com fonte operacional;
- backend comprovado para as capacidades prometidas;
- estratégia de gravação, consentimento e privacidade;
- consentimento separado para o SMS e atribuição entre demo, mensagem e checkout;
- limites de duração, frequência e abuso da demo;
- testes com sotaques, interrupção, ruído, clientes irritados, perguntas desconhecidas
  e tentativa de manipulação;
- regras de cobrança para arredondamento, spam, transferência, minutos não usados e
  excedente;
- regras de retenção, processadores, exclusão e uso de gravações/transcrições;
- deploy, DNS e HTTPS públicos;
- copy aprovada e congelada;
- revisão final do logo e dos metadados, caso a identidade mude.

## Ordem recomendada para a próxima sessão

1. Ler esta atualização e `CHANGELOG-CLAUDE-V9.md`; a fonte exata já está em
   `src/claude-v9/` e não precisa ser reexportada.
2. Verificar `main`, `origin/main` e o worktree separado `codex/ligou-demo-hero`; não
   misturar nem descartar o trabalho sujo anterior.
3. Executar `bun run check` e abrir o preview local antes de editar.
4. Se a próxima tarefa continuar sendo design, decidir primeiro se o timing mobile
   atual de 0,45 s por passo deve ser preservado ou levado ao alvo anterior de 6–8 s.
   Não redesenhar a hero ou reconstruir novamente o console já integrado.
5. Repetir QA no Browser interno depois de qualquer mudança visual em 390, 430, 768,
   1024 × 600, 1118, 1199 e 1200 px.
6. Antes de qualquer publicação, fechar oferta Founding, formulação pública de idiomas,
   vertical inicial, escopo real do MVP, demo segura e matriz de autoridade.
7. Criar novo changelog/manifesto para mudanças futuras; nunca editar os hashes dos
   snapshots anteriores.

Para cada promessa, registrar qual evidência futura a promove de `planejada` para
`disponível`: chamada real, receipt de ferramenta, leitura/escrita no sistema correto,
estado persistido, autorização e resultado observável.

## Comandos de retomada

```bash
cd /Users/d1f/Desktop/Ligou.AI
git status --short --branch
git branch --show-current
git log --oneline --decorate -8
git remote -v
bun run check
node dev-server.mjs
```

Depois, abrir `http://127.0.0.1:4174/` no Browser interno e validar o estado real antes
de editar.

## Regras para não perder trabalho

- Não sobrescrever V1, V2, V3, V4, Claude R2, a copy v2.1 ou a brand board v1.
- Não promover `WORKING` a `FROZEN` sem aprovação explícita de RJ.
- Não afirmar backend, demo, CRM, MCP, app ou idioma sem prova.
- Não confundir repositório público com site publicado.
- Não adicionar a duplicata não rastreada da brand board.
- Não confundir a direção vetorial aplicada com uma Brand Board V2 pública já congelada.
- Não transformar o personagem em decoração; cada pose explica uma função.
- Não deixar o resumo voltar a parecer o produto principal.
- Não substituir o vídeo vertical mobile pelo desktop recortado.
- Não trocar o agente preto aprovado por avatar genérico.
- Não operar o browser externo quando o Browser interno atende à tarefa.
- Não enviar um prompt ao Claude Design sem incluir critérios explícitos de desktop,
  mobile, velocidade e QA nas larguras críticas.

## Prompt pronto para a próxima sessão

> Leia `docs/HANDOFF-NEXT-SESSION.md`,
> `docs/source/LIGOU-PRODUCT-BRIEF-WORKING.md`, `.impeccable.md`,
> `docs/CHANGELOG-CLAUDE-V9.md`,
> `docs/CHANGELOG-DEMO-HERO-RESTORE.md`, `docs/CHANGELOG-CLAUDE-R2.md`,
> `docs/CHANGELOG-VISUAL-4.md` e
> `docs/brand/LOGO-EXPLORATION-WORKING.md`.
> A direção visual mais recente é a Claude Design v9, exportada do projeto
> `d2f45323-f5fb-4e26-8aa8-113c31cce65d` e preservada em `src/claude-v9/`. Ela já está
> integrada ao Git local, mas não foi enviada ao GitHub nem publicada. O worktree
> `codex/ligou-demo-hero` continua sujo e separado; não edite, descarte ou misture essas
> mudanças. Preserve a hero escura, o Agent Node, o telefone no peito do agente, os
> vídeos dedicados desktop/mobile, as cidades da Califórnia e a prova clara. A prova
> mobile já é um único console com bubbles, eventos causais, agente oficial e drawer em
> português. A decisão visual aberta é o timing: o export usa passos de cerca de 0,45 s
> e termina em 2,85 s, abaixo da meta anterior de 6–8 s. Não altere esse ritmo sem
> decisão de RJ. Rode `bun run check`, faça QA nas larguras críticas e mantenha demo,
> checkout, oferta, links legais, backend, push e deploy como gates separados.
