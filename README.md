# Ligou.AI — V0.1 RC1

Ligou é um agente operacional de IA para negócios de serviços. Este repositório reúne a landing em `/`, o dashboard em `/dashboard/`, a autoridade no Supabase, o controlador de voz, a célula Hermes e a infraestrutura de suporte.

## Estado honesto

RC1 é um candidato local com código implementado, testes unitários e contratos locais, além de um gate de integração isolado para banco. Não foi implantado, não foi validado em staging ou produção e não comprova provedores externos.

## Comece aqui

- [Escopo V0.1](docs/V0.1-SCOPE.md)
- [Status e limites de evidência](docs/STATUS.md)
- [Notas de RC1](docs/release/V0.1-RC1.md)
- [Mapa do repositório](docs/REPOSITORY-MAP.md)
- [Regra de segurança](docs/SECURITY-RULEBOOK.md)
- [Verificação local e gate de banco](docs/VERIFICATION.md) e [runbook de migrações](docs/runbooks/MIGRATION-VERIFICATION.md)
- [Proveniência do replay](docs/release/V0.1-HARDENING-REPLAY-MAP.md)
- [QA visual estático](docs/release/V0.1-VISUAL-QA.md)

## Verificação local

```sh
bun run check
bun run test:security
bun run test:hermes-config
bun run test:backup-restore
bun run test:deploy-release
bun run test:edge-functions
node scripts/local-db-gate.mjs
```

O gate de banco gerencia exclusivamente sua pilha descartável e não lê arquivos `.env` do projeto. Consulte os runbooks antes de qualquer operação futura de Edge, host ou backup/restore.
