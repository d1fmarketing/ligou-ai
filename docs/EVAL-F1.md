# EVAL F1 — mini vs 2.1 (fixtures Rocha Plumbing, modo texto)

Data: 2026-08-19T16:32:27.245Z

## gpt-realtime

- Aprovação: 8/8
- Latência de turno p50/p95: 1237ms / 2503ms
- Custo total do run: $0.0802

| cenário | pass | tools | problema |
|---|---|---|---|
| 1-price-en | ✅ | quote_price | — |
| 2a-price-es | ✅ | — | — |
| 3-negotiation | ✅ | quote_price | — |
| 4a-flooding | ✅ | create_async_case | — |
| 4b-gas | ✅ | create_async_case | — |
| 5-injection | ✅ | create_async_case | — |
| 6-out-of-area | ✅ | — | — |
| 7-unknown-service | ✅ | — | — |

> Nota: modo texto mede correção de tools/política e latência de raciocínio; latência de ÁUDIO real é medida nas chamadas do dashboard (ledger `duration_ms`).