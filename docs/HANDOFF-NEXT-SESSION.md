# Ligou — handoff para a próxima sessão

**Atualizado:** 10 de agosto de 2026

**Estado:** candidato local Claude R2 integrado; nenhuma publicação autorizada

**Ponto de retomada:** branch `codex/ligou-claude-r2`, checkpoint deste handoff em
`HEAD`; base V4 imutável no commit `7279041`

## Comece por aqui

Leia nesta ordem:

1. este handoff;
2. [`source/LIGOU-PRODUCT-BRIEF-WORKING.md`](source/LIGOU-PRODUCT-BRIEF-WORKING.md);
3. [`.impeccable.md`](../.impeccable.md);
4. [`CHANGELOG-CLAUDE-R2.md`](CHANGELOG-CLAUDE-R2.md);
5. [`CHANGELOG-VISUAL-4.md`](CHANGELOG-VISUAL-4.md);
6. [`source/LIGOU-COPY-V4-WORKING.md`](source/LIGOU-COPY-V4-WORKING.md);
7. [`brand/LOGO-EXPLORATION-WORKING.md`](brand/LOGO-EXPLORATION-WORKING.md).

Não comece reescrevendo a página. Primeiro confirme o estado Git e resolva com RJ as
decisões abertas de oferta, idioma, vertical inicial, escopo do MVP, demo segura e
autoridade dos conectores.

## Estado Git e repositório verificado

- Repositório público: `https://github.com/d1fmarketing/ligou-ai`
- Branch padrão: `main` → `56ea1d0` (Visual 1)
- Checkpoint Claude Visual 2: `checkpoint/claude-visual-2` → `dd6e014`
- Visual 3: `codex/ligou-agent-v3` → `6963098`
- Visual 4: `codex/ligou-design-v4` → `7279041`
- Claude R2: `codex/ligou-claude-r2` → checkpoint atual em `HEAD`
- A branch V4 estava sincronizada com `origin` antes desta documentação.
- Não existia pull request da V4 e nenhum PR foi criado para Claude R2.
- Nenhum deployment público foi comprovado; GitHub Pages respondia 404.
- O preview `localhost:4173` foi validado durante o merge; não presumir que o processo
  continue ativo em outra sessão.

Depois do checkpoint, a única sobra deliberada deve ser
`Codex Image Aug 10, 2026, 05_14_43 PM.png`, duplicata não rastreada e byte a byte da
board aprovada, SHA-256
`11a023067474e671bf13026f2e8e5f0cf35c06fb47c2cdf54ddb21dffef071da`.
Não adicionar essa duplicata ao Git e não apagá-la sem autorização de RJ.

## O que foi preservado

- Visual 1 em `main`;
- checkpoint separado do Claude Visual 2;
- Visual 3 com o agente operacional;
- Visual 4 com cinco seções e narrativa `Atendendo → Operando → Pedindo aprovação`;
- Claude R2 como descendente direto da V4, sem sobrescrever nenhum snapshot anterior;
- copy v2.1 congelada e V3/V4 marcadas como `WORKING`;
- brand board v1 aprovada;
- retrato e três poses do personagem com masters e hashes;
- manifesto de integridade de cada snapshot.

Os hashes do bloco Visual 4 continuam válidos. Claude R2 recebeu um bloco próprio no
manifesto e não reescreve os hashes anteriores.

Esta sessão consolidou e commitou:

- o handoff, product brief, registro de logo e as duas pranchas de exploração;
- a nova marca vetorial `assets/logo-mark.svg` e `assets/logo-line.svg`;
- header, footer e favicon ativo com a marca **A Linha**;
- hero vertical animada de 12 s, portada do Claude para o HTML/CSS estático;
- changelog Claude R2, novo bloco de manifesto e novos pontos de entrada no README.

`script.js`, a copy V4, as seções abaixo do fold, os WebPs do agente e o OG ficaram
byte a byte iguais ao Visual 4.

Fonte do merge: `/Users/d1f/Downloads/Ligou Design System.zip`, 3.696.405 bytes,
SHA-256 `3e4319ddf66eaebe1bf2ea1f6ed30e402fb584c9b48e8342d30a291492374238`.
O ZIP não foi espalhado pela raiz: ele continha previews atuais junto com resíduos e
duplicatas de rodadas antigas. O mapa de inclusão/exclusão está no changelog.

## Estado atual da página

- Site estático: `index.html`, `styles.css` e `script.js`.
- Cinco seções: hero, operação, prova, Founding e FAQ/encerramento.
- Hero próximo de uma viewport no desktop, com linha vertical, três estados sempre
  presentes e ênfase animada `EN → regra → PT`.
- Duas poses do agente alternam entre atendimento e operação; o pacote percorre a
  linha no ciclo de 12 s.
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
- Sem número real, o CTA abre a prova ilustrativa.
- Checkout e links legais permanecem deliberadamente bloqueados.

Claude R2 passou por QA responsivo no Browser interno, fallback sem JS, movimento
reduzido, console, links e integridade. Essa validação cobre o frontend local, não
telefonia, backend, aparelho físico ou produção.

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

1. Verificar branch, status, remotos e os arquivos deste handoff.
2. Confirmar que `HEAD` contém o checkpoint Claude R2 e que somente a duplicata da
   brand board permanece fora do Git.
3. Fechar com RJ, em formato curto, oferta Founding, formulação pública de idiomas e
   vertical inicial.
4. Definir o MVP real: canais, memória, CRM/MCP/agenda, ferramentas e quais integrações
   estarão disponíveis no dia um.
5. Desenhar a demo segura: tenant isolado, sandbox, consentimento, abuso, SMS e handoff
   para checkout.
6. Confirmar se `COMANDO` continua sendo o motor interno e montar a matriz de autoridade:
   conector, leitura, escrita, aprovação, persistência e receipt observável.
7. Fechar Brand Board V2, regra do badge do personagem e OG com A Linha.
8. Só então criar uma nova fonte de copy `WORKING` que apresente o agente operacional
   sem voltar a uma landing longa.
9. Preservar a arquitetura de cinco seções, salvo nova decisão explícita de RJ.
10. Atualizar frontend, changelog e manifesto em novo checkpoint; nunca editar os
    hashes V4 ou Claude R2.
11. Rodar QA responsivo, sem JS, movimento reduzido, teclado, contraste, performance,
    favicon e OG antes de qualquer integração ou deploy.

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
node --check script.js
python3 -m http.server 4173
```

Depois, abrir `http://127.0.0.1:4173/` no Browser interno e validar o estado real antes
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

## Prompt pronto para a próxima sessão

> Leia `docs/HANDOFF-NEXT-SESSION.md`,
> `docs/source/LIGOU-PRODUCT-BRIEF-WORKING.md`, `.impeccable.md`,
> `docs/CHANGELOG-CLAUDE-R2.md`, `docs/CHANGELOG-VISUAL-4.md` e
> `docs/brand/LOGO-EXPLORATION-WORKING.md`.
> Verifique Git e o preview antes de editar. Preserve todos os snapshots anteriores.
> Primeiro consolide com RJ oferta Founding, formulação de idiomas, vertical inicial,
> escopo real do MVP e demo segura. Confirme também `COMANDO`, conectores do dia um,
> leitura versus escrita, aprovação, persistência e receipts. Feche Brand Board V2,
> relação marca/badge e OG. Só depois proponha a próxima copy sem reduzir o Ligou a
> secretária, tradução ou resumo. Não publique nada.
