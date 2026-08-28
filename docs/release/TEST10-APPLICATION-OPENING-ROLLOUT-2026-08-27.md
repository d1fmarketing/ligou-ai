# Teste 10 — abertura application-owned e rollout

## Verdict

`TEST10_OPENING_FAILURE_FIXED_DEPLOYED_READY_FOR_HUMAN_RETEST`

Nenhum novo teste humano foi executado por este rollout. A evidência live final
é um smoke sintético sem voz humana, seguido de reconciliação completa até zero.

## Estado de produção antes da correção

- EC2 commit: `3ee8590a8d04d9db9a666ff021ef21b55d513966`;
- package SHA-256:
  `6d3e60fbf80d296024ec9c7e4dff0843e4e568ee1086140798c8b051e2d432ec`;
- Supabase: 58/58 migrations;
- Edge `browser-session`: v6 `ACTIVE`;
- dashboard production: `dpl_GLSXGyPHPQx4xhin27icQtHY4Dy9`;
- controller/Supabase/Hermes: ready;
- calls, budgets, requests abertas e terminations unresolved: zero;
- rollback bridge `5a64eedd…` presente no host.

## Falha humana observada

- Call ID: `38cc2275-48b9-4fa9-9690-2996aab853df`;
- OpenAI call ID: `rtc_u0_EHdCXnMcBqtS5NScMWyvY`;
- tenant: `6e915234-0cee-4d67-9eba-60c2c920dd15`;
- runtime: `3ee8590…-6d3e60…`;
- início: `2026-08-27T22:49:31.831471Z`;
- fim: `2026-08-27T22:50:00.112Z`;
- finalização: `caller_hung_up`;
- receipts/tools: 0.

Transcript sanitizado:

> Olá, eu sou a assistente virtual brasileira. Quais…

O owner interrompeu o teste imediatamente. A chamada não chegou à primeira
persistência.

## Causa comprovada

A abertura ainda era uma inferência Realtime comum:

1. a aplicação enviava `response.create` para o greeting;
2. o provider gerava o texto e o áudio;
3. WebRTC entregava esse áudio diretamente ao browser;
4. a validação de identidade acontecia somente depois do transcript/áudio;
5. portanto, um greeting inválido já tinha sido ouvido quando o retry ou block
   podia agir.

As instructions implantadas pediam a identidade correta, mas instructions não
são garantia de texto exato. Nenhuma nova blacklist ou regra redundante de
prompt foi adicionada.

O Teste 9 real anterior continua tendo a causa documentada em
`TEST9-FAILURE-FIX-ROLLOUT-2026-08-27.md`: o lifecycle bloqueou em correlação de
turno antes da fala de serviços, e nenhuma tool foi emitida. Durante este
trabalho, smokes reais do protocolo revelaram dois defeitos latentes adicionais
que reproduziam exatamente a classe “persistiu e não continuou” assim que uma
tool existisse:

- Realtime limita `item.id` a 32 caracteres;
- o output antigo `tool-output:<call_id>` tinha 33 caracteres para um call ID
  real de 21 caracteres e era rejeitado com `string_above_max_length`;
- o provider GA emite `conversation.item.added` e depois
  `conversation.item.done`; o runtime esperava apenas o evento legado
  `conversation.item.created`.

Com ID opaco de 32 caracteres, o mesmo function output foi aceito pelo provider
e ecoado em `added → done`.

## Fix causal

Commit runtime:

`8bbd171bdf5660e8edb057e8dfd1c5fd857c4112`

### Abertura

- texto server-owned:
  `Oi! Aqui é o Ligou, agente de inteligência artificial da <tenant>. Quais serviços sua empresa oferece?`;
- TTS server-side: `tts-1`, voz `ash`, MP3;
- texto e áudio possuem SHA-256 exatos;
- opening ID: `lgo-` + 28 hex, exatamente 32 caracteres;
- o browser mantém microfone desligado e provider audio mudo;
- a aplicação toca somente o MP3 validado;
- depois de `ended`, cria um assistant `output_text` exato;
- `conversation.item.added` é apenas progresso;
- `conversation.item.done` exato é o ACK GA;
- `conversation.item.created` permanece somente como compatibilidade legada;
- somente depois do item ACK e de `session.updated` com VAD ativo o browser
  libera microfone e áudio remoto;
- zero model `response.create` na abertura application-owned.

### Tool output e continuação

- output ID: `tlo-` + 28 hex, exatamente 32 caracteres;
- o ID é SHA-256 opaco e não contém o provider call ID;
- `done` exato confirma output; `added` nunca confirma;
- duplicatas são idempotentes;
- reattach recupera o item exato;
- uma batch terminal produz no máximo uma continuação.

### Startup, cancelamento e custos

- request e call são ligadas antes de qualquer provider write;
- um trigger com row lock impede call insert depois de cancelamento;
- fases `tts_inflight`, `tts_resolved` e `provider_create_inflight` são
  duráveis;
- a identidade OpenAI precisa de write + readback exatos antes de sideband;
- cancelamento application onboarding usa
  `processing|ready → cancel_requested → expired`;
- cleanup é exactly-once e recuperável após restart;
- erro/ausência/unreadable de call permanecem distintos;
- provider termination usa o ledger at-most-once existente;
- custo TTS conhecido permanece como floor;
- custo/usage malformado nunca vira zero inventado;
- customer e owner-browser provider-mode permanecem fora do protocolo novo.

## Regression e TDD

Arquivos principais:

- `voice-controller/test/budget-settlement.test.ts`;
- `voice-controller/test/session-tenancy.test.ts`;
- `voice-controller/test/sideband-continuation.test.ts`;
- `voice-controller/test/browser-session-edge.test.ts`;
- `dashboard/tests/voice-session.test.mjs`;
- `voice-controller/test/onboarding-policy.local.integration.test.ts`.

REDs reproduziram:

- greeting model-authored audível;
- ID de opening acima de 32;
- function output de 33 caracteres;
- `added → done` sem ACK;
- zero-row PostgREST tratado como cleanup;
- ready/abort sem terminação comprovada;
- crash entre provider identity e request ready;
- cleanup pré-sideband removido pelo primeiro poll;
- cancel durante budget, TTS, body HTTP 200, marker e provider POST;
- call ausente confundida com call unreadable;
- usage/custo nulo ou `not_applicable` tratado como zero resolvido.

GREEN final:

- controller canonical: 806/806;
- budget/startup focado: 31/31;
- session/tenancy/cancel focado: 33/33;
- dashboard: 89/89;
- Sites: 6/6;
- Edge + migrations: 95/95, 850 assertions.

## Review

Reviewer independente, escopo focado:

- Critical: 0;
- Important: 0;
- Minor: 0;
- verdict: `READY`.

Diff revisado SHA-256:

`a7ba9b686fac0d35675600f469590b9f7d5d29bcfbcc9ce861f856ae9cf923a3`

## Gates

- controller canonical: 806/806;
- dashboard: 89/89 + build de 6.287 módulos;
- Sites: 6/6;
- DB gate: migrations 59, SQL 29, concurrency 16, upgrade 28, app 6,
  onboarding 1, budget 2, startup 1, RLS 34, no-op confirmado;
- security containment: 8/8;
- deploy-release: 21/21;
- secret scan: clean;
- `git diff --check`: clean;
- Edge `browser-session` Deno check: clean;
- aggregate Edge: somente o baseline preexistente `TS7006` em
  `migrate-connector-tokens.ts:32`.

## Pacote e rollout

Pacote gerado duas vezes, byte-idêntico:

- commit: `8bbd171bdf5660e8edb057e8dfd1c5fd857c4112`;
- SHA-256:
  `b035ecd2c9ac31e81837390505892389ce6d46d41e0aba4aa125181f1520beeb`;
- size: 280.231 bytes;
- payload files: 141;
- tar entries: 159;
- release ID:
  `8bbd171bdf5660e8edb057e8dfd1c5fd857c4112-b035ecd2c9ac31e81837390505892389ce6d46d41e0aba4aa125181f1520beeb`.

Backup privado antes da migration:

- diretório: `/Users/d1f/.config/ligou/test10-prechange.2v6RJq`;
- schema SHA-256:
  `5e1c6a827fadb210ec03b31524385808ae5c14636f2bd2cd64a6c2f3290b6902`;
- data SHA-256:
  `c56dd47964300b5a4340883b9f48049bb465ec7745be1923a6d723a348e91b69`.

Ordem executada:

1. backup;
2. migration 59;
3. runtime final enquanto Edge/dashboard ainda eram legados;
4. prova de stale onboarding rejeitado antes de call/budget/provider;
5. Edge `browser-session` v7;
6. stale client 409 pre-insert;
7. drain de 150 segundos das invocações v6;
8. smoke sintético application-mode;
9. reconciliação até zero;
10. promoção do dashboard validado.

## Produção final

### EC2

- release: `8bbd171…-b035ecd2…`;
- current/app: release exato;
- systemd: active/running, PID `484930`;
- controller/Supabase/Hermes: ready;
- model: `gpt-realtime-2.1`;
- live sessions: 0.

### Supabase / Edge

- migrations: 59/59;
- last: `20260827231053`;
- Edge `browser-session`: v7 `ACTIVE`;
- import map: ativo;
- verify JWT: false, com validação explícita dentro da função;
- source composite:
  `564611ee1285b530b4bf1ca7d4c98134e916d7fa2a3972c335f3d023547f5128`;
- deployed bundle SHA:
  `cb01946e265f674a45e39054343ced2597b7b8e919d126eedf00d96a57720a02`.

### Dashboard

- preview validado: `dpl_4mSbe5KJJrpvPPZjGWCNvmrFVZSz`;
- production promovido: `dpl_6TX3n55QrFz7pLUrQVyjPmAUQHDK`;
- alias: `https://client-nine-taupe-24.vercel.app`;
- previous production: `dpl_GLSXGyPHPQx4xhin27icQtHY4Dy9`;
- cinco assets críticos conferidos byte a byte.

### Smoke sintético do tenant real

- Call ID: `21dd95f2-3983-48a6-b862-dba180e87fff`;
- business: `D1f Marketing`;
- opening:
  `Oi! Aqui é o Ligou, agente de inteligência artificial da D1f Marketing. Quais serviços sua empresa oferece?`;
- item: `lgo-821293b9b57f6e599f6d1c1649e3`;
- text SHA-256:
  `ea667dafe949d219089be5744b4a0f8df830b92723dfc9f1ff1aae0a3eb41a51`;
- audio SHA-256:
  `e6c4172ff6d2b8a19fe20c4ef272330567c8d4159e13d72d9c09760159c9c195`;
- TTS cost: 0.001605 USD;
- playback: started + ended;
- events: added=true, done=true, VAD=true;
- model responses before activation: 0;
- duração: 13.318 ms;
- provider termination: confirmed;
- budget reconciliado em 20 attempts.

Estado final:

- active calls: 0;
- active onboarding calls: 0;
- active budgets: 0;
- pending/processing/cancel_requested requests: 0;
- unresolved provider terminations: 0;
- provider-mode onboarding criado desde Edge v7: 0.

## Rollback

- falha durante runtime activation: rollback automático para `3ee8590`;
- dashboard: previous production ID preservado;
- DB59 é forward-only e permanece;
- rollback manual pós-promoção exige primeiro uma nova Edge com onboarding
  desabilitado, drain completo e só então um novo release imutável equivalente
  ao runtime anterior;
- não trocar symlink manualmente e não tentar reativar um release já instalado
  com `infra/deploy.sh`, que retorna `release_already_exists`.

## Handoff

Produção está idle. A próxima ação pertence a RJ + Isa: um único teste humano
novo pelo link de produção. Este rollout não executou esse teste.
