# Ligou.AI — candidato V0.1

Ligou é um agente operacional de IA para negócios de serviços. Este checkout reúne o
candidato V0.1: a landing em `/`, o dashboard em `/dashboard/`, a camada de autoridade
no Supabase, o controlador de voz, a célula Hermes e a infraestrutura que sustenta esses
componentes.

## Estado desta branch

`codex/ligou-v0.1` é uma consolidação **somente local**. Não houve merge, push ou deploy
autorizado desta branch. O código permanece candidato até que a validação operacional e
as decisões de produto/brand sejam aprovadas separadamente. Não trate CTAs, dados de
demonstração ou cópia visual como prova de uma capacidade publicada.

## Componentes

- `/`: landing estática e seus assets locais;
- `/dashboard/`: aplicação de operação e autoridade do dono;
- `dashboard/`: build, testes e integração do dashboard;
- `supabase/`: esquema, migrações e políticas de autoridade;
- `voice-controller/`: superfícies do controlador de voz;
- `hermes-cell/`: célula de raciocínio sob a autoridade definida pelo produto;
- `infra/`: definição de infraestrutura e procedimentos de operação.

## Build e validação local

Na raiz:

```bash
bun run check
bun run site:build
```

No dashboard:

```bash
cd dashboard
npm test
```

Para o preview local da landing, use `node dev-server.mjs` e abra a porta informada pelo
processo. O servidor preserva suporte a HTTP Range para os vídeos locais.

## Documentação

- [`docs/HANDOFF-NEXT-SESSION.md`](docs/HANDOFF-NEXT-SESSION.md): contexto operacional e retomada segura;
- [`docs/source/LIGOU-PRODUCT-BRIEF-WORKING.md`](docs/source/LIGOU-PRODUCT-BRIEF-WORKING.md): premissa e limites do produto;
- [`docs/BRANCH-MAP-2026-08-20.md`](docs/BRANCH-MAP-2026-08-20.md): proveniência, disposições e exclusões desta consolidação;
- [`docs/brand/identity-guide/v0.1/README.md`](docs/brand/identity-guide/v0.1/README.md): roteiro editorial de brand; não é aprovação de identidade.
