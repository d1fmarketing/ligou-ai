# GOAL: DESTRAVAR O TENANT DO RJ, FECHAR CHAMADAS LIVE DE VERDADE E ABRIR EM UM COMANDO

Goal de execução no projeto existente, worktree `codex/ligou-live1-candidate`. Investigar, corrigir, testar, publicar pelo processo imutável e provar. Não devolver só auditoria ou plano. Pesquisar a documentação oficial ANTES de cada ponto de integração, como já é regra.

Escopo fechado: quatro correções abaixo e nada mais. Nenhuma delas é nova arquitetura. Não voltar a Realtime, MP3, TTS, frases fixas, VAD próprio ou gates de fala. Não mexer em infra, orçamento, modelo (GPT-6 Astra low fica, decisão do RJ) ou voz (Tempo fica). Sem novos frameworks, sem nova camada de controle.

## Fatos verificados hoje (2026-09-11, 21:20 UTC), fonte: banco de produção e log do controller

- A tentativa `e7a291b1` do tenant D1f Marketing (17:27 UTC, Vercel) falhou em 260 ms com `interview_resume_source_not_settled`. O RJ vai bater nessa mesma parede em qualquer clique em "Começar entrevista" com o login dele.
- Causa: `website_interview_prior_settled` exige `provider_termination_state='confirmed'` ou recibo em `browser_interview_expiry_receipts`. A chamada anterior `e8168454` está `ended`, término `unknown`, uso `unknown`, `provider_termination_attempt_id` nulo, reserva de orçamento `active` (US$ 7,50), `reconcile_attempts` 1403 com `live_termination_unconfirmed`.
- A rotina documentada de expiração (`reconcile_browser_interview_expiry`, migração 20260907022111) NÃO aceita Live: só `gpt-realtime-2.1`/`-mini`, só estado `external_evidence_required`, só código `call_id_not_found`. A Live responde 404 `session_id_not_found` / `invalid_request_error` (probe autenticado de leitura às 21:16:30 UTC no attach da sessão `live_u1_EMyrK3HFqooIj5h7r54yC`).
- Por que o `session.closed` nunca chegou: o `end_call` foi executado 16:59:07.951, o `session.close` saiu 1 ms depois, enquanto a resposta delegada ainda completava (16:59:08.154). O `ended_at` da chamada é 16:59:16.009, exatamente 8,06 s depois do close: é o `finalization_timeout` de 8 s do `createLiveLifecycle`, não uma falha do provedor. O sideband está anexado com `graceful_close=true`, que só existe no SDK (`resources/live/sideband`), não na doc.
- Abertura: o runtime manda `session.instructions.append` e, depois do ACK (2,03 s), uma `session.commentary.append` (0,71 s). A doc pede UM comando.
- Delegação com Astra low no teste humano: `get_context` inteiro em 4,8 s (chamada da ferramenta 1,2 s, nosso executor 0,1 s, resposta 3,3 s). A primeira pergunta útil depende dessa ida e volta.

## 1. Destravar o tenant D1f (sem reescrever nada)

Implementar o equivalente Live da reconciliação por expiração, com a mesma disciplina da migração 20260907022111: identidade exata (call, tenant, owner, generation, `openai_call_id`), chamada terminal, pedido `ready` com `answer_sdp`, e evidência fresca do provedor. Diferenças que a Live impõe e que a doc confirma:

- Modelo `gpt-live-1`; código de erro `session_id_not_found` com tipo `invalid_request_error`.
- Estado de partida `unknown` (é o que o runtime grava quando o close não confirma). Registrar também, para Live, `provider_termination_attempt_id` e `provider_termination_attempted_at` no momento em que `session.close` é enviado, para servir de âncora.
- Prazo: usar o `expires_at` da sessão que o runtime já captura (`expiresAt` em `session.started`/`session.closed`) e persistir esse valor. Só aceitar o recibo depois de `expires_at`. Se a doc oficial fixar um lifetime máximo de sessão Live, citar; não inventar 60 minutos por analogia com Realtime.
- Liquidar a reserva de orçamento com o custo observado (US$ 0,14330983), sem marcar término `confirmed`, sem inventar `session.closed`. Parar o loop de 1403 tentativas: reconciliação de Live sem sessão no provedor tem que convergir, não repetir a cada 10 s para sempre.

Prova: `website_interview_resume_eligible` verdadeiro para o owner do D1f; zero reservas ativas; fingerprints de call/interview/draft iguais antes e depois, exceto os campos de liquidação.

## 2. Fechar de verdade (causa raiz)

Doc "Usage and graceful close" (https://developers.openai.com/api/docs/guides/live-conversations): terminar o trabalho delegado, instalar o listener de `session.closed` antes de enviar `session.close`, parar de submeter trabalho, e só considerar finalizado com `session.closed` (reasons `close_requested`, `expired`, `content`, `remote_hangup`, `connection_lost`). "A socket close alone does not establish success."

- No `end_call`: deixar a resposta delegada completar e a despedida tocar antes de enviar `session.close`. O timeout de finalização deve cobrir a despedida; 8 s não cobre. Medir a despedida real e definir o limite pela medição, não por palpite.
- Se `session.closed` não vier no prazo: fallback documentado `POST /v1/live/sessions/{id}/hangup` (existe no SDK `resources/live/sessions`), e então registrar a tentativa com âncora. Nunca deixar uma chamada em `unknown` sem caminho de reconciliação.
- Confirmar na doc o que `graceful_close` faz no attach; se não estiver documentado, não depender dele.

Prova: 1 smoke curto pago (abrir, 1 gravação, `end_call`) termina com `session.closed` real, reserva liquidada, zero chamadas ativas. Regressão: o cenário "close enviado com resposta delegada em voo" passa.

## 3. Abertura em um comando

Doc "Greet before the caller speaks": depois de `session.started`, UM `session.instructions.append` com `delegation_id: null`, contendo saudação, idioma e instrução explícita de cumprimentar imediatamente sem esperar o dono, depois pausar e escutar. Esperar o `session.instructions.appended` correspondente. Remover a `session.commentary.append` de segundo passo. Medir `session.started` até o primeiro `session.output_transcript.delta` antes e depois.

## 4. Primeira pergunta útil sem ida e volta

Doc "Cost optimization" (https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live): "Gather information your application already has permission to use before starting the voice session." A visão breve que o `get_context` devolve (cerca de 7,5 KB: identidade candidata, próximas pendências, índice de assuntos, decisões salvas) já existe antes da chamada. Colocar essa visão nas `backendInstructions` ou no `input` de criação da sessão, para que a primeira pergunta de negócio não precise de delegação. `get_context` continua para detalhe e revisão; `save_decision` continua no servidor, nada de gravação sem recibo.

Prova: primeira pergunta útil após a saudação sem `session.delegation.created` antes dela; tempo Start até primeira pergunta útil medido no mesmo método do checkpoint anterior (19,80 s).

## Voz (só registro, sem trabalho)

Tabela oficial (https://developers.openai.com/api/docs/guides/live-conversations#voice-options): Tempo é a única voz masculina em português brasileiro (Natural); Bossa é feminina. "Regional influence describes a voice's speaking style, not a guarantee of accent fidelity." Timbre grave não é configurável; voz custom só via sales. Não trocar. Se a qualidade continuar ruim no teste humano, o caminho é a captura de diagnóstico do navegador, que falhou de armar no último teste: corrigir e provar que arma no fluxo real antes do próximo teste, não depois.

## Entrega

Publicar controller, Edge e migração pelo processo imutável, com rollback registrado. Relatório de no máximo 20 linhas: causa, mudança, prova, versões, custo do smoke. Depois disso, e só depois, `LIGOU_LIVE_READY_FOR_HUMAN_TEST` com o link da Vercel e o tenant D1f destravado. Aguardar o teste humano; não iniciar outros marcos.
