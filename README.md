# Ligou.AI landing page

Checkpoint local da **Claude Design v9** em PT-BR. A página apresenta o Ligou como
agente operacional para donos brasileiros de negócios de serviços nos Estados Unidos:
hero `Ligou? Atendido.`, entrevista em português, operação multilíngue
em inglês, espanhol e português, além da prova causal
`cliente → regra → ação → decisão do dono`.

**Estado:** integrada ao histórico Git local como direção visual. Não houve push, PR ou
deploy. Não publicar enquanto número da demo, checkout, Termos, Privacidade, oferta,
inventário Founding e capacidades do backend não forem reais e aprovados.

## Verificar e visualizar

```bash
bun test
bun run check
node dev-server.mjs
```

Depois, abra `http://127.0.0.1:4174/`.

O servidor responde a pedidos HTTP Range com `206 Partial Content`, necessário para os
MP4s. `bun test` cobre transições responsivas, estado interativo, acessibilidade e os
fallbacks de movimento reduzido e JavaScript desativado. `bun run check` recompila os
JSX preservados, executa esses testes e verifica sintaxe, hashes da fonte e todas as
referências locais do runtime.

## Estrutura atual

- `index.html`: embalagem executável da v9, CSS específico e fallback sem JavaScript;
- `src/claude-v9/`: HTML e JSX originais do ZIP, preservados byte a byte;
- `scripts/build-claude-v9.mjs`: transpila os JSX com o runtime embutido do Bun;
- `scripts/verify-claude-v9.mjs`: fixa proveniência e fecha referências do runtime;
- `tests/`: contratos do artefato e comportamento do JSX com um harness determinístico;
- `assets/js/`: JavaScript gerado; não editar manualmente;
- `assets/vendor/`: React/ReactDOM production locais e licença;
- `_ds/ligou-design-system-*/`: tokens, componentes e bundle usados pela v9;
- `assets/hero-*`: vídeos e posters dedicados a desktop e mobile/tablet;
- `assets/agent-*.png` e `assets/crop-*.png`: agente oficial, marca e recortes do export;
- `dev-server.mjs`: preview estático com byte ranges para vídeo.

`styles.css` e `script.js` pertencem aos snapshots anteriores e foram removidos desta
rodada porque a v9 não os usa. Eles continuam integralmente recuperáveis no histórico.

## Limites deste checkpoint

- `DEMO_PHONE` é placeholder e os CTAs não comprovam telefonia ou checkout;
- Termos e Privacidade ainda apontam para `#`;
- botões de aprovação/ajuste são ilustrativos;
- oferta e copy continuam candidatas, não congeladas;
- `robots=noindex,nofollow` permanece ativo;
- fonte, runtime e assets estão locais, mas isso não transforma o protótipo em produto
  ou publicação.

## Documentação

- [`docs/HANDOFF-NEXT-SESSION.md`](docs/HANDOFF-NEXT-SESSION.md): verdade operacional e ordem segura de retomada;
- [`docs/CHANGELOG-CLAUDE-V9.md`](docs/CHANGELOG-CLAUDE-V9.md): fonte, inclusão/exclusão, embalagem, QA e bloqueios desta rodada;
- [`docs/CLAUDE-V9-RUNTIME.sha256`](docs/CLAUDE-V9-RUNTIME.sha256): inventário verificável dos 42 arquivos do fechamento v9;
- [`docs/BASELINE-MANIFEST.md`](docs/BASELINE-MANIFEST.md): hashes append-only dos snapshots;
- [`docs/source/LIGOU-PRODUCT-BRIEF-WORKING.md`](docs/source/LIGOU-PRODUCT-BRIEF-WORKING.md): tese e fronteiras do produto;
- [`.impeccable.md`](.impeccable.md): contrato de design e prova/claim discipline;
- [`docs/CHANGELOG-DEMO-HERO-RESTORE.md`](docs/CHANGELOG-DEMO-HERO-RESTORE.md): checkpoint anterior e recuperação da demo;
- [`docs/CHANGELOG-HIGGSFIELD-MOTION.md`](docs/CHANGELOG-HIGGSFIELD-MOTION.md): rodada anterior de motion;
- [`docs/CHANGELOG-CLAUDE-R2.md`](docs/CHANGELOG-CLAUDE-R2.md): integração Claude anterior;
- [`docs/CHANGELOG-VISUAL-4.md`](docs/CHANGELOG-VISUAL-4.md): base Visual 4 preservada.
