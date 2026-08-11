# Ligou.AI landing page

Landing page estática em PT-BR. A base V4 organiza o produto em cinco seções e
apresenta o Ligou em uma narrativa única: atender, operar e pedir aprovação ao dono.
A segunda rodada do Claude acrescenta a marca **A Linha**. A rodada Higgsfield Motion
preserva três vídeos controlados pelo scroll na seção operacional. O candidato atual
restaura a conversão da V1: hero curto, uma única prova `cliente EN → regra → retorno
PT` e a demo de voz como ação dominante.

**Estado:** candidato local na branch `codex/ligou-demo-hero`. Não publicar
enquanto número da demo, checkout, Termos, Privacidade e inventário Founding forem
placeholders.

## Visualizar localmente

```bash
node dev-server.mjs
```

Depois, abra `http://127.0.0.1:4174/`.

Esse servidor mínimo responde a pedidos HTTP Range com `206 Partial Content`. Isso é
necessário para o scrub confiável dos MP4s; o `python3 -m http.server` testado retornou
o arquivo inteiro e deixou o `currentTime` congelado no Browser usado no QA.

## Configuração obrigatória antes de publicar

Edite `SITE_CONFIG` no início de `script.js`:

- `demoPhoneDisplay`: número formatado mostrado na página;
- `demoPhoneHref`: número E.164 usado pelo link `tel:`;
- `checkoutUrl`: URL real do checkout;
- `termsUrl`: URL dos Termos;
- `privacyUrl`: URL da Política de Privacidade.

Enquanto o telefone estiver vazio, o CTA de voz continua visível e mostra um aviso
explícito de bloqueio local. Um link secundário abre a ligação de exemplo. Quando os
dois campos recebem valores reais, todas as ações da demo mudam automaticamente para
`tel:`. Checkout e links legais sem destino também mostram um aviso, em vez de
fingirem que a integração existe.

## Estrutura

- `index.html`: conteúdo e metadados SEO;
- `styles.css`: direção visual, responsividade e acessibilidade;
- `script.js`: configuração dos destinos, abas progressivas, dock móvel e storytelling operacional por scroll;
- `dev-server.mjs`: preview local estático com suporte a byte ranges para vídeo;
- `assets/ligou-agent-v1.webp`: retrato V3 preservado como fallback histórico;
- `assets/ligou-*-v1.webp`: três poses V4 geradas por referência no Higgsfield;
- `assets/ligou-*-motion-v1.mp4`: três coreografias Seedance 2.5 normalizadas para scrub;
- `assets/ligou-*-motion-poster-v1.webp`: frame 0 de cada MP4, sem salto de enquadramento;
- `assets/logo-mark.svg`: marca v2 ativa em header, footer e favicon;
- `assets/logo-line.svg`: master monocromático da marca v2;
- `assets/fonts/`: fontes e licenças usadas para regenerar o card social;
- `favicon.svg`: favicon v1 preservado para os snapshots históricos;
- `og-card.svg` / `og-ligou.png`: fonte editável e imagem social 1200 × 630.

## Documentação do produto

- [`docs/HANDOFF-NEXT-SESSION.md`](docs/HANDOFF-NEXT-SESSION.md): ponto de entrada da próxima sessão, com estado Git, decisões recentes, conflitos abertos, bloqueios e ordem segura de retomada;
- [`docs/CHANGELOG-DEMO-HERO-RESTORE.md`](docs/CHANGELOG-DEMO-HERO-RESTORE.md): regressão da V1, reconstrução do hero, comportamento da demo e QA desta rodada;
- [`docs/CHANGELOG-HIGGSFIELD-MOTION.md`](docs/CHANGELOG-HIGGSFIELD-MOTION.md): jobs, prompts, geração rejeitada, normalização, implementação e QA do motion sincronizado ao scroll;
- [`docs/source/LIGOU-PRODUCT-BRIEF-WORKING.md`](docs/source/LIGOU-PRODUCT-BRIEF-WORKING.md): tese atual do produto — agente operacional, memória por negócio, sistemas, ferramentas, aprovação e estratégia de idiomas;
- [`docs/brand/LOGO-EXPLORATION-WORKING.md`](docs/brand/LOGO-EXPLORATION-WORKING.md): explorações raster, convergência no Claude R2, hashes da marca A Linha e gates restantes;
- [`.impeccable.md`](.impeccable.md): contrato de design do projeto — público, personalidade, o que está congelado e os sete princípios que valem para qualquer rodada visual;
- [`docs/CHANGELOG-CLAUDE-R2.md`](docs/CHANGELOG-CLAUDE-R2.md): fonte Claude, delta integrado, assets da marca, QA e exclusões deliberadas;
- [`docs/CHANGELOG-VISUAL-4.md`](docs/CHANGELOG-VISUAL-4.md): arquitetura, motion, assets, QA e bloqueios da base V4 preservada;
- [`docs/CHANGELOG-VISUAL-3.md`](docs/CHANGELOG-VISUAL-3.md): mudanças, verificações e bloqueios da rodada do agente;
- [`docs/CHANGELOG-VISUAL-2.md`](docs/CHANGELOG-VISUAL-2.md): checkpoint histórico da rodada do Claude;
- [`docs/source/LIGOU-COPY-V4-WORKING.md`](docs/source/LIGOU-COPY-V4-WORKING.md): copy do candidato atual, status de promessas e bloqueios locais;
- [`docs/source/LIGOU-COPY-V3-WORKING.md`](docs/source/LIGOU-COPY-V3-WORKING.md): direção anterior preservada como histórico;
- [`docs/brand/README.md`](docs/brand/README.md): proveniência, hashes e regras de uso do agente aprovado;
- [`docs/LANDING-PAGE-BASELINE-VISUAL-1.md`](docs/LANDING-PAGE-BASELINE-VISUAL-1.md): registro factual do baseline anterior, o que foi verificado e o que ainda bloqueia publicação;
- [`docs/IMPROVEMENT-SKILLS-ROADMAP.md`](docs/IMPROVEMENT-SKILLS-ROADMAP.md): sequência recomendada de skills, referências do Mobbin e critérios para a próxima versão visual;
- [`docs/MOBBIN-REFERENCE-LOG.md`](docs/MOBBIN-REFERENCE-LOG.md): referências observadas, limites da evidência e hipóteses a testar;
- [`docs/BASELINE-MANIFEST.md`](docs/BASELINE-MANIFEST.md): hashes dos artefatos que formam o snapshot;
- [`docs/source/LIGOU-COPY-V2.1-FROZEN.md`](docs/source/LIGOU-COPY-V2.1-FROZEN.md): cópia local da fonte pública congelada.
