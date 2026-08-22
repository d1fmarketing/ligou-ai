# Runbook futuro — release de Edge Functions

## Escopo e pré-condições

Este é um procedimento de operador futuro; não registra deploy executado. Só prossiga com autoridade explícita, projeto-alvo confirmado, revisão do commit/manifesto e janela de rollback. Nunca cole valores de segredo em terminal gravado, tickets ou Git.

As funções são `browser-session`, `google-connect`, `google-callback`, `accept-call` e, desde o V0.2 M1, `google-handoff` e `calendar-test`. A identidade de release é composta: inclui o `index.ts`, dependências locais transitivas sob `_shared`, `supabase/deno.json` e `supabase/deno.lock`.

| Função | SHA-256 composto |
|---|---|
| `browser-session` | `28ca1ef41f4386b08221d36cbf8ab31cb11f340ad04304dfd398ad1847974b59` |
| `google-connect` | `51d2d2f5dfd161afca4a498aa4d0878fe5a41531a132fa52780feee417200afa` |
| `google-callback` | `a88b25b51fd2fb3918a20c5a9619150b9e693e8ebc16d6cf22e05b63031650b1` |
| `accept-call` | `49301741f474acc64a53e810678993128309c67cb3402748e5584b1364267253` |
| `google-handoff` | `5a03d52f35c672b6b8e15ba806a5f0e6f910b89247c79819d2f74b5caa63f70c` |
| `calendar-test` | `b7c1c862e9adc28f6474a54761ea3a56a1db8b01cf7b3f018b2ffcc8da093dc8` |

`google-handoff` e `calendar-test` importam apenas `_shared/handoff-core.ts`, `_shared/calendar-test-core.ts`, `_shared/tenant-ownership-id.ts` e `_shared/connector-crypto.ts` — o fechamento das quatro funções legadas permaneceu intocado no M1. No V0.2 M2, `browser-session` passou a importar `_shared/owned-tenant.ts` (resolução do tenant do próprio dono com fallback ao slug legado), o que muda apenas a identidade dela; `google-connect`, `google-callback` e `accept-call` seguem intocadas.

Recalcule pelo código, sem editar a tabela manualmente:

```sh
node -e 'import("./infra/edge-release-identity.mjs").then(m => console.log(JSON.stringify(m.computeEdgeReleaseIdentity(process.cwd()), null, 2)))'
```

Secret names only: `SERVICE_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT`, `CONNECTOR_TOKEN_ENCRYPTION_KEY`, `OPENAI_WEBHOOK_SECRET`, `CONTACT_HASH_KEY`, `LIGOU_TENANT`, `LIGOU_DASHBOARD_URL`. A plataforma injeta `SUPABASE_URL`; confirme sua presença sem exibir valor.

## Ordem de execução autorizada

1. Confirme branch/commit, hashes compostos acima ou identidades recalculadas aprovadas, migrations forward-only compatíveis e ambiente-alvo.
2. Rode a verificação local limpa: `bun run test:edge-functions` e `bun run test:security`. Falha bloqueia a mudança.
3. Configure/valide os secret names no cofre/superfície autorizada, sem imprimir valores. Defina primeiro dependências compartilhadas; mantenha o callback indisponível se a criptografia de conector estiver incompleta.
4. Faça deploy de `browser-session`, depois `google-connect`, `google-callback` e por último `accept-call`. Preserve a configuração de verificação de JWT prevista no código, sem substituir as verificações explícitas de autoridade/assinatura.
5. Verifique na superfície responsável: versão/função esperada, health/observabilidade disponível, invocação sintética autorizada e ausência de logs contendo token, segredo ou PII desnecessária.
6. Registre commit, hashes efetivos, nomes de secrets, operador, hora, resultado e qualquer rollback — sem valores.

## Falha, rollback e forward-fix

Pare se deploy, tipo, assinatura, autoridade ou verificação falhar. Não use dados reais como teste de recuperação. Se a plataforma permitir versão anterior conhecida e compatível, reverta somente a função afetada e revalide a superfície responsável. Se migrations forward-only ou schema já tornarem a versão anterior incompatível, não force rollback: faça forward-fix revisado. Em qualquer caso, preserve logs sanitizados e mantenha a função de escrita desabilitada até a reconciliação.
