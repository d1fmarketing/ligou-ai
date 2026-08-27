# Teste 9 — análise causal, correção e rollout

## Verdict

`TEST9_FAILURE_FIXED_DEPLOYED_READY_FOR_TEST10`

O Teste 10 não foi executado. Este documento prova a correção e o deploy; não
é evidência de que um novo teste humano passou.

## Identidade de produção antes da investigação

Não houve drift:

- EC2 commit: `38e75ecad698004609a58b7860f396f332dfc980`;
- tree: `b57eec3fc9a9e6686f7f9c28ce2d9cd35f400b6e`;
- package SHA-256:
  `2361170968ad2dbb5a429127a36e8327ce00ca7dd997526ae9edc20ea578b28f`;
- Supabase: 58 migrations locais e 58 remotas;
- Edge `browser-session`: v6, `ACTIVE`, import map ativo e `verify_jwt=false`;
- dashboard: `dpl_GLSXGyPHPQx4xhin27icQtHY4Dy9`, `READY`, production;
- controller, Supabase e Hermes: `ready`; zero live sessions;
- rollback bridge `5a64eedd…-4f6fb…` presente.

## Teste 9 real

- Call ID: `60a63731-2003-454c-8b39-80c5186f9784`;
- OpenAI call ID: `rtc_u0_EHbdT4N6EI1LzgaLRBlmd`;
- browser request: `f8f5bcb9-a362-4504-9223-e5b45179579c`;
- tenant: `6e915234-0cee-4d67-9eba-60c2c920dd15`;
- Edge request: `01a0450e-2e07-7f24-8376-ad57819d61a3`;
- Edge execution: `4dc53f2a-2aef-46a5-9ca0-03754e77d6b2`;
- início: `2026-08-27T21:09:14.360146Z`;
- fim: `2026-08-27T21:10:21.369Z`;
- finalização: `caller_hung_up`.

O transcript durável confirma a pergunta de serviços, “desentupimento,
conserto…” e a frase “Beleza, vou registrar…”. Ele termina a fala do owner em
“conserto”; “de vazamento” e “diagnóstico hidráulico” vieram da observação
humana, não do transcript persistido. Não existe gravação ou arquivo de eventos
Realtime bruto para completar esse trecho.

### Timeline causal

1. `21:09:16.318997Z` — sideband aberto.
2. `21:09:16.328455Z` — coverage revision 0; greeting enfileirado.
3. `21:09:16.329812Z` — único `response.requested` da aplicação enviado.
4. `21:09:16.413349Z` — greeting ACK em
   `resp_EHbdULsnuhr8cDIvArnTX`.
5. `21:09:18.507Z` — primeiro greeting falou “Olá, eu sou a ChatGPT, sua
   assistente virtual”.
6. `21:09:18.509894Z` — resposta terminal e retry único do greeting
   enfileirado.
7. `21:09:22.869510Z` — resposta imediatamente anterior ao erro terminou em
   `resp_EHbdaVjxxJX6azNFBEZxf`.
8. `21:09:23.087925Z` — `transcription.completed` provocou
   `caller_turn_correlation_mismatch`; lifecycle revision 53 passou a
   `blocked`.
9. Todos os eventos seguintes foram ignorados enquanto bloqueado.
10. `21:09:33.250Z` — o provider ainda falou o greeting correto e a pergunta.
11. `21:09:54.896Z` — chegou a resposta parcial do owner, já bloqueada.
12. `21:09:55.619Z` — o provider falou “vou registrar…”, já bloqueado.
13. `21:09:55.654083Z` — `resp_EHbe0sF2nuhAOUesjvOBC` terminou como
    `blocked_bookkeeping_only`; nenhuma tool ou continuação existia.

Último evento imediato antes do silêncio: o terminal bookkeeping de
`resp_EHbe0sF2nuhAOUesjvOBC`. Último evento causal: o mismatch de correlação às
`21:09:23.087925Z`.

### Classificação

Categoria `I — Outro`.

A persistência nunca começou, mas a causa comprovada não foi uma falha de RPC
ou de coverage. A sessão já estava bloqueada por correlação de turnos durante o
greeting, cerca de 32 segundos antes da resposta de serviços.

Os logs antigos não retêm `item_id`, `response.status` nem `status_details`.
Eles provam que o erro ocorreu em `transcription.completed`, mas não permitem
distinguir entre:

- transcript sem `item_id` diante de mais de um turno pendente; ou
- `item_id` explícito ausente do registro pendente.

O patch cobre ambos sem afirmar que `turn_detected` foi a causa remota exata.

## Prompt e identidade

Os hashes implantados de `instructions.ts`, `sideband.ts`,
`onboarding-coordinator.ts` e `response-coordinator.ts` eram byte-idênticos ao
commit `38e75ec`.

O prompt reconstruído deterministicamente tinha SHA-256
`d3db87e37599e61e14f84e0539d732fc0ae76db728a8e321ef13cadd38572640`,
5.092 bytes, zero regras operacionais carregadas e exigia:

- identidade Ligou / agente de inteligência artificial;
- persistência silenciosa;
- próxima pergunta somente de `next_action.question_pt`.

“Vou registrar isso direitinho” não existe no prompt ou source implantado. A
fala foi model-authored, não evidência de prompt legacy ou stale. Nenhuma regra
de blacklist foi adicionada.

## Persistência real e próxima ação esperada

No Teste 9:

- receipts: 0;
- onboarding coverage/event/approval receipts: 0;
- rules/materializations relacionadas: 0;
- RPC `record_onboarding_answer`: 0;
- tool calls: 0;
- revision: `0 → 0`;
- `next_action` real: inexistente.

Um replay determinístico da fala humana completa como três
`service.name_synonyms` mais `service.catalog_closure=true` produz revision 4 e
esta próxima ação reconstruída, não persistida no Teste 9:

- field: `service.price_mode`;
- subject: `desentupimento`;
- pergunta: “O preço deste serviço é fixo, a partir de, estimativa ou exige
  revisão do dono? (desentupimento)”.

## Regression e TDD

Arquivos principais:

- `voice-controller/test/sideband-continuation.test.ts`;
- `voice-controller/test/onboarding-coordinator.test.ts`.

RED inicial no runtime implantado:

- sideband: 67 pass / 4 fail, exit 1;
- Teste 9 esperava quatro persistências e obteve zero;
- recovery speech-only esperava uma resposta e obteve zero;
- correlação ausente/desconhecida terminava em `blocked`.

REDs adicionais provaram:

- mismatch enquanto response estava ativa deixava recovery queued para sempre;
- transcript tardio de turno interrompido podia virar aprovação/correção;
- falha de persistência tentava recovery antes do `function_call_output`/ACK;
- crosstalk durante greeting podia consumir o lifecycle;
- recovery ainda podia chamar outra tool.

GREEN final:

- sideband: 77/77, 642 assertions;
- coordinator: 67/67, 819 assertions;
- full voice canonical: 734 pass, 0 fail, 33 blocos isolados.

Invariant protegido:

> Depois de um primeiro turno válido, a aplicação chega a exatamente uma
> próxima pergunta ou a exatamente uma recuperação verdadeira. Nunca permanece
> aberta sem response ativa/pendente, tool pendente, próxima pergunta ou erro
> terminal.

As fixtures também cobrem um serviço, três serviços, resposta incompleta,
falha determinística/indeterminada, duplicate event, lost ACK, barge-in,
reattach e no-process-narration.

## Fix

Commit runtime:
`3ee8590a8d04d9db9a666ff021ef21b55d513966`.

Tree: `985204952d059204acb622c7c9c1f629f837afd2`.

Arquivos:

- `voice-controller/src/sideband.ts`;
- `voice-controller/src/onboarding-coordinator.ts`;
- `voice-controller/src/response-coordinator.ts`.

Mudanças causais:

- turns aposentados recebem tombstone bounded e nunca recuperam autoridade;
- transcript sem correlação é fail-closed para autoridade, mas não bloqueia o
  greeting/retry inteiro;
- response terminal sempre drena uma recovery válida que ficou queued;
- response owner sem tool e em idle gera `invariant.violation` + uma recovery;
- falha de persistência envia um único `function_call_output`, espera ACK exato
  de todo o batch e só então gera uma recovery;
- falha indeterminada manda encerrar o teste, sem pedir repetição;
- recovery usa `tool_choice: none`;
- todo `response.create` continua saindo exclusivamente do
  `ResponseCoordinator`.

## Review

Um reviewer independente, escopo focado:

- Critical: 0;
- Important: 0;
- Minor: 0;
- verdict: `READY`.

Diff revisado SHA-256:
`d8d452ace87774dfe1f920290e1fdc1fa5badfd5cef7a521fd1b4c2e131d362f`.

## Gates

- Teste 9/sideband: 77/77;
- coordinator: 67/67;
- store: 40/40;
- tools: 61/61;
- simulation: 12/12;
- sideband settlement: 28/28;
- budget reconciliation: 19/19;
- budget settlement: 13/13;
- phone budget: 18/18;
- full voice: 734/734;
- security containment: 8/8;
- deploy-release: 21/21;
- secret scan: 446 arquivos tracked, clean;
- `git diff --check`: clean;
- Bun server bundle: exit 0.

O security harness construiu landing/dashboard internamente, mas nenhuma source
de dashboard mudou e nenhuma publicação foi feita. Como não houve SQL,
migration ou mudança no contrato de store, o DB gate completo não foi rodado.

## Pacote e deploy

Pacote gerado duas vezes, byte-idêntico:

- commit: `3ee8590a8d04d9db9a666ff021ef21b55d513966`;
- SHA-256:
  `6d3e60fbf80d296024ec9c7e4dff0843e4e568ee1086140798c8b051e2d432ec`;
- size: 263.291 bytes;
- payload files: 138;
- tar entries: 156;
- manifest version: 2;
- release ID:
  `3ee8590a8d04d9db9a666ff021ef21b55d513966-6d3e60fbf80d296024ec9c7e4dff0843e4e568ee1086140798c8b051e2d432ec`;
- artifact privado:
  `/Users/d1f/.config/ligou/releases/3ee8590a8d04d9db9a666ff021ef21b55d513966.V2G1Gc`;
- artifact/manifest mode: `0600`.

Ativação EC2:

- `2026-08-27T22:37:11Z`;
- current/app apontam para o release novo;
- systemd active/running, PID `476283`, start `22:37:09Z`;
- controller, Supabase e Hermes: `ready`;
- model: `gpt-realtime-2.1`;
- live sessions: 0;
- release anterior `38e75ec` e rollback bridge `5a64eedd` preservados.

Surfaces não alteradas/reimplantadas:

- Supabase: 58/58, last `20260826161435`;
- Edge `browser-session`: v6 `ACTIVE`, SHA
  `24cbf87560e824fefb4e5e9416cb1e2e5ceb44e24daa3486a61b8fd2f406b4e5`;
- dashboard: `dpl_GLSXGyPHPQx4xhin27icQtHY4Dy9`, `READY`, production.

Estado final:

- active calls: 0;
- active onboarding calls: 0;
- active budget reservations: 0;
- pending/processing browser requests: 0;
- terminal provider terminations unresolved: 0.

## Handoff

O runtime corrigido está implantado e idle. RJ + Isa possuem a próxima ação:
um único Teste 10 humano por voz. Este rollout não iniciou o Teste 10.
