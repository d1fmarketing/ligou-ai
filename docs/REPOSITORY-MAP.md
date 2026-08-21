# Mapa do repositório

| Caminho | Responsabilidade | Estado de evidência |
|---|---|---|
| `/` e `assets/` | Landing estática, vídeo e comportamento responsivo | Estático e unit-testado localmente. |
| `/dashboard/` | Interface do dono, build e testes do dashboard | Unit-testado e buildado localmente. |
| `voice-controller/` | Sessões Realtime, orçamento, reservas, booking e fronteiras de provedor | Unit-testado; integrações externas não verificadas. |
| `supabase/` | Migrações, RLS, RPCs e quatro Edge Functions | Contratos e gate de banco isolado; não implantado. |
| `hermes-cell/` | Célula tenant-scoped, OAuth do modelo separado e contrato estruturado | Configuração unit-testada; runtime host não exercitado. |
| `infra/` | Pacote assinado, release imutável, health, backup e restore | Testes locais; procedimentos de operador ainda futuros. |
| `tests/`, `dashboard/*test*`, `voice-controller/test/`, `infra/test/` | Contratos e regressões | Evidência local somente. |
| `docs/` | Escopo, status, runbooks e proveniência | Documentação da fronteira de evidências. |

Rotas públicas de interface: landing em `/` e dashboard em `/dashboard/`. O controlador de voz é serviço separado; a autoridade é mantida no Supabase; Hermes não decide autoridade. Veja [SECURITY-RULEBOOK.md](SECURITY-RULEBOOK.md) para as relações de segurança.
