# Runbook — Telefone (F6)

O código do caminho de telefone JÁ ESTÁ PRONTO e deployado (Edge Function `accept-call` + listener no controller).
Zero A2P/toll-free (isso é só SMS). Zero porta de entrada em qualquer lugar. Falta só a conta.

## O que o RJ faz (10 min, uma vez)
1. Criar conta Twilio da Ligou em twilio.com/try-twilio (e-mail da Ligou) e fazer **upgrade** (cartão + crédito mínimo)
   — remove limite de trial no mesmo dia.
2. Me passar (clipboard, um por vez): `TWILIO_ACCOUNT_SID` e `TWILIO_AUTH_TOKEN`.

## O que eu faço em seguida (automatizado)
1. Comprar 1 número local US (~$1.15/mês) via API.
2. Criar Elastic SIP Trunk com Origination URI:
   `sip:proj_<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls` e apontar o número pro trunk.
3. No projeto OpenAI: registrar webhook `realtime.call.incoming` →
   `https://ixpbqquvxirvuevjhmrq.supabase.co/functions/v1/accept-call` e guardar o `whsec_` nos secrets da função:
   `supabase secrets set OPENAI_WEBHOOK_SECRET=... SERVICE_KEY=...` + `supabase functions deploy accept-call --no-verify-jwt`.
4. Teste de aceite: ligar do celular → mesmo agente do dashboard; caso fora-de-regra aparece ao vivo;
   custo da chamada no ledger (`select * from calls where channel='phone'`).

## Fluxo em produção
PSTN → Twilio SIP trunk → OpenAI Realtime → webhook → `phone_events` (Supabase) → Realtime acorda o
controller na EC2 → `accept` com a MESMA config canônica + sideband autoritativo. Budget gate ativo
(estouro = reject antes de atender).
