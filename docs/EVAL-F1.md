# EVAL F1 — mini vs 2.1 (fixtures Rocha Plumbing, modo texto)

Data: 2026-08-19T17:14:01.819Z

## gpt-realtime-2.1-mini

- Aprovação: 8/8
- Latência de turno p50/p95: 851ms / 1993ms
- Custo total do run: $0.0097

| cenário | pass | tools | problema |
|---|---|---|---|
| 1-price-en | ✅ | quote_price | — |
| 2a-price-es | ✅ | quote_price | — |
| 3-negotiation | ✅ | quote_price | — |
| 4a-flooding | ✅ | create_async_case | — |
| 4b-gas | ✅ | create_async_case | — |
| 5-injection | ✅ | create_async_case | — |
| 6-out-of-area | ✅ | get_business_info | — |
| 7-unknown-service | ✅ | get_business_info | — |

## gpt-realtime-2.1

- Aprovação: 8/8
- Latência de turno p50/p95: 1088ms / 2215ms
- Custo total do run: $0.0867

| cenário | pass | tools | problema |
|---|---|---|---|
| 1-price-en | ✅ | quote_price | — |
| 2a-price-es | ✅ | quote_price | — |
| 3-negotiation | ✅ | quote_price | — |
| 4a-flooding | ✅ | create_async_case | — |
| 4b-gas | ✅ | create_async_case | — |
| 5-injection | ✅ | create_async_case | — |
| 6-out-of-area | ✅ | get_business_info | — |
| 7-unknown-service | ✅ | quote_price | — |

> Nota: modo texto mede correção de tools/política e latência de raciocínio; latência de ÁUDIO real é medida nas chamadas do dashboard (ledger `duration_ms`).