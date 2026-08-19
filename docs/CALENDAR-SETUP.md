# Google Calendar — robô convidado (decisão de RJ, 2026-08-19)

**Modelo escolhido:** o RJ (ou o cliente) é DONO do calendário; o Ligou entra como convidado com permissão
de alterar eventos. Respeita o `DECISAO-INFRA` (service account nunca é dona dos dados) e **nada expira** —
ao contrário do refresh token OAuth, que numa conta gmail pessoal morre a cada ~7 dias.

## Identidade do robô

```
ligou-scheduler@ligou-mvp-68036.iam.gserviceaccount.com
```

Projeto GCP `ligou-mvp-68036` (Calendar API ativa). Chave em `~/.config/ligou/google-sa.json` (600) e no
formato env em `~/.config/ligou/google.env`. Nunca no repositório.

## Passo do dono (~2 min, uma vez por tenant)

1. [calendar.google.com](https://calendar.google.com) → "Outras agendas" → **+** → **Criar agenda** →
   nome do tenant (ex.: `Rocha Plumbing`) → *Criar agenda*
2. **Configurações da agenda** → **Compartilhar com pessoas específicas** → **Adicionar pessoas**
3. Colar o e-mail do robô acima, permissão **"Fazer alterações nos eventos"** → *Enviar*

## Verificar e ativar

```bash
cd voice-controller && bun run ../scripts/calendar-check.ts     # lista o que o robô enxerga
```

Quando aparecer o calendário com `accessRole: writer`, copiar o `id` e gravar no SSM:

```bash
aws ssm put-parameter --name /ligou/GOOGLE_CALENDAR_ID --value "<id>" --type String --overwrite --region us-east-1
aws ssm put-parameter --name /ligou/GOOGLE_SA_CLIENT_EMAIL --value "<client_email>" --type String --overwrite --region us-east-1
aws ssm put-parameter --name /ligou/GOOGLE_SA_PRIVATE_KEY --value "<private_key>" --type SecureString --overwrite --region us-east-1
bash infra/deploy.sh
```

O adapter (`voice-controller/src/calendar.ts`) liga sozinho quando as três variáveis existem: assina um JWT
RS256, troca por access token, e passa a usar Google no lugar do adapter interno — insert com read-back e
freeBusy reais. **Eventos nunca levam convidados** (convidar exigiria domain-wide delegation).
