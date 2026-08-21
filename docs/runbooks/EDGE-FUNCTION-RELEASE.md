# Runbook futuro — release de Edge Functions

## Escopo e pré-condições

Este é um procedimento de operador futuro; não registra deploy executado. Só prossiga com autoridade explícita, projeto-alvo confirmado, revisão do commit/manifesto e janela de rollback. Nunca cole valores de segredo em terminal gravado, tickets ou Git.

As funções são `browser-session`, `google-connect`, `google-callback` e `accept-call`. Hashes SHA-256 dos fontes `index.ts`, calculados no momento desta documentação:

| Função | SHA-256 |
|---|---|
| `browser-session` | `5f60609859b7444cd2f083c4995006930b1f0473895077c1c3679d62111ef581` |
| `google-connect` | `bbf964b376a5eacc489d2e6922ee3f42027a5b39350ebb12f25ccb0793c0d916` |
| `google-callback` | `05c6ea840a689e5daf570c888e6d31a787774174fe8bfdae92d7f748d9170737` |
| `accept-call` | `f151e406ed282ea84f50395f02bcf93b993b2361af08cfe1216f0b38768d9cf2` |

Secret names only: `SERVICE_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT`, `CONNECTOR_TOKEN_ENCRYPTION_KEY`, `OPENAI_WEBHOOK_SECRET`, `CONTACT_HASH_KEY`, `LIGOU_TENANT`, `LIGOU_DASHBOARD_URL`. A plataforma injeta `SUPABASE_URL`; confirme sua presença sem exibir valor.

## Ordem de execução autorizada

1. Confirme branch/commit, hashes acima ou hashes atualizados aprovados, migrations forward-only compatíveis e ambiente-alvo.
2. Rode a verificação local limpa: `bun run test:edge-functions` e `bun run test:security`. Falha bloqueia a mudança.
3. Configure/valide os secret names no cofre/superfície autorizada, sem imprimir valores. Defina primeiro dependências compartilhadas; mantenha o callback indisponível se a criptografia de conector estiver incompleta.
4. Faça deploy de `browser-session`, depois `google-connect`, `google-callback` e por último `accept-call`. Preserve a configuração de verificação de JWT prevista no código, sem substituir as verificações explícitas de autoridade/assinatura.
5. Verifique na superfície responsável: versão/função esperada, health/observabilidade disponível, invocação sintética autorizada e ausência de logs contendo token, segredo ou PII desnecessária.
6. Registre commit, hashes efetivos, nomes de secrets, operador, hora, resultado e qualquer rollback — sem valores.

## Falha, rollback e forward-fix

Pare se deploy, tipo, assinatura, autoridade ou verificação falhar. Não use dados reais como teste de recuperação. Se a plataforma permitir versão anterior conhecida e compatível, reverta somente a função afetada e revalide a superfície responsável. Se migrations forward-only ou schema já tornarem a versão anterior incompatível, não force rollback: faça forward-fix revisado. Em qualquer caso, preserve logs sanitizados e mantenha a função de escrita desabilitada até a reconciliação.
