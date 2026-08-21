# Runbook futuro — Telefone (F6)

Este documento descreve uma implantação futura. A release candidate contém contratos locais para ingestão `accept-call`, listener do controller, budget gate e reconciliação, mas não prova Edge Function implantada, número comprado, SIP trunk, webhook, chamada real, carrier delivery ou execução em produção.

## Pré-condições externas ainda não verificadas

1. Conta de telefonia aprovada e financiada, com autorização explícita para compra/configuração.
2. Projeto OpenAI e endpoint Edge do ambiente-alvo confirmados na superfície responsável.
3. Secrets server-side configurados por nome, sem copiar valores para Git ou logs: `OPENAI_WEBHOOK_SECRET`, `SERVICE_KEY` e `CONTACT_HASH_KEY`.
4. Migrations verificadas primeiro em staging/ambiente descartável; a situação remota de `0008` continua desconhecida.
5. Budget, provider-termination reconciliation e observabilidade ativos antes de receber tráfego.

## Sequência futura autorizada

1. Adquirir um número local e configurar o SIP trunk na conta autorizada.
2. Registrar o webhook `realtime.call.incoming` usando a URL resolvida do projeto-alvo; este repositório não contém URL operacional fixa.
3. Publicar `accept-call` conforme [EDGE-FUNCTION-RELEASE.md](runbooks/EDGE-FUNCTION-RELEASE.md), sem reutilizar credenciais de browser.
4. Verificar uma chamada sintética autorizada: persistência do evento antes do 2xx, budget reservation igual ao teto de sessão, sideband contínuo e rejeição/hangup reconciliável.
5. Só registrar confirmação depois do read-back do provedor, ledger e estado final do carrier.

O fluxo pretendido é PSTN → SIP → OpenAI Realtime → Edge `accept-call` → evento durável → controller outbound → sideband autoritativo. Isso é arquitetura implementada/localmente testada, não evidência de implantação.
