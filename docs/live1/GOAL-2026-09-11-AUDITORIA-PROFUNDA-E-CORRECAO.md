# GOAL: AUDITORIA PROFUNDA DE ARQUITETURA E INFRAESTRUTURA DO LIGOU, CONFERIDA CONTRA A DOCUMENTAÇÃO, COM CORREÇÃO ATÉ FICAR REDONDO

Este é um goal de execução, não de relatório. Você investiga, prova, corrige, testa, publica pelo processo imutável e deixa o sistema no estado que a documentação oficial e o produto exigem. Devolver só uma lista de achados é falha.

## 0. Quem você é neste trabalho

Você atua ao mesmo tempo como engenheiro principal de plataforma, SRE de produção, revisor de segurança e redator técnico. Você não é dono de nenhuma decisão anterior deste repositório e não defende nenhuma linha de código por ter sido escrita. Você defende três coisas: a experiência do dono da empresa na conversa de voz, a integridade dos dados e das autorizações dele, e a operação previsível do sistema.

Postura obrigatória: cada afirmação sua vem com a fonte, que é uma destas três, sempre nomeada: documentação oficial vigente, código com caminho e linha, ou medição com método. "Eu acho", "normalmente", "boa prática" sem fonte não entram no trabalho. Quando a evidência não existir, você escreve "não comprovado" e diz o que faltou.

## 1. A missão em uma frase

Fazer o onboarding por voz do Ligou funcionar como uma conversa natural e rápida entre o dono da empresa e o agente, com o aplicativo mandando no que é salvo, no que é autorizado e em quando termina, e com a infraestrutura mínima que a plataforma oficial não cobre.

"Redondo" significa, em ordem: (1) nenhum caminho que trave o dono sem saída; (2) nenhum estado órfão em banco, orçamento ou provedor; (3) cada componente que existe tem justificativa na doc ou em medição, e o que a plataforma cobre foi retirado; (4) latência medida no caminho real, não em teste local; (5) release, rollback e recuperação documentados e provados uma vez cada.

## 2. Regras invioláveis

1. **Documentação antes de cada ponto de integração.** Antes de tocar em qualquer componente, abrir a doc oficial vigente daquele componente e registrar a seção lida. Isso vale para OpenAI Live e Responses, Supabase, Vercel, AWS, WebRTC do navegador, Google Calendar, telefonia. Conhecimento de treino não substitui a doc: a API Live existe desde 10/09/2026 e o Astra desde 03/09/2026.
2. **Simplificar é a direção.** Quando a plataforma oficial cobre uma responsabilidade, o componente próprio sai. Adição de camada só com defeito reproduzido que a camada resolve e a doc não cobre. Frases fixas, intérprete textual paralelo, VAD próprio, gates de fala, MP3, TTS, cache de abertura, fallback para Realtime: proibidos. Já foram tentados e custaram 8,3 s de mediana por resposta.
3. **O aplicativo controla dados, autorizações e término. Não controla a fala.** Persistência com recibo, idempotência por operação, aprovação explícita vinculada à revisão, isolamento por tenant, RLS e autorização no servidor ficam. Nada disso exige esperar transcrição ou ditar frases.
4. **Modelos são decisão do RJ:** voz `gpt-live-1` com voz `tempo`; raciocínio `gpt-6-astra` com `reasoning.effort=low`. Não trocar. Você pode medir e reportar a diferença para Terra, não pode mudar.
5. **Dinheiro e infra.** Nenhum serviço novo, assinatura, credencial, aumento de limite ou redimensionamento. Chamadas pagas ao provedor: no máximo 8 smokes curtos neste goal, custo total observado até US$ 3, cada um com propósito escrito antes de iniciar e conciliado depois. Orçamento diário desativado nos tenants de teste continua desativado; RJ precisa testar sem esbarrar em teto. Decisão de RJ em 2026-09-11: sem teto numérico de chamadas; propósito e custo de cada uma continuam obrigatórios em `output/audit-2026-09-11/smokes.json`.
6. **Navegador.** Verificação em navegador primeiro no navegador interno da sua ferramenta. Esgotado esse caminho, o Edge do RJ só em sessão isolada já existente, sem abrir, fechar ou navegar abas pessoais dele.
7. **Honestidade operacional.** Nunca anunciar "pode testar" com bloqueio conhecido. Nunca chamar simulação de E2E. Nunca marcar término confirmado, liberar reserva, apagar entrevista ou repetir hangup para "limpar" um estado. Falha de comando fica registrada como falha.
8. **Sem loop ocioso e sem marco novo.** Ao chegar ao checkpoint humano, parar e aguardar. Não iniciar telefonia, Agents, discovery ou qualquer outra frente.

## 3. Contexto verificado em 2026-09-11 (21:20 UTC), fonte: banco de produção, log do controller, docs oficiais

Leia primeiro, nesta ordem: `docs/live1/IMPLEMENTATION-GOAL.md`, `docs/live1/PROGRESS.md`, `docs/live1/GOAL-2026-09-11-DESTRAVAR-FECHAR-ABRIR.md`, `docs/release/VOICE-ONBOARDING-2026-09-06.md`, `docs/runbooks/*.md`, `docs/architecture/VOICE_ARCHITECTURE.md`, `docs/architecture/THREAT_MODEL.md`, `docs/DEPLOY-DASHBOARD.md`.

- Worktree autoritativo: `~/.codex/worktrees/ligou-live1-candidate/Ligou.AI`, branch `codex/ligou-live1-candidate`, 39 commits à frente de `main` (b9caf66). Não resetar para hashes antigos; preservar descendentes.
- No ar: controller EC2 `5e51dc6` (instância `i-0de12212f9a17dcfc`, logs por SSM `journalctl -u ligou-controller`), Edge `browser-session` v21, 97 migrações, dashboard Vercel `client-nine-taupe-24.vercel.app` com bundle `index-CH2HickC.js` publicado 21:07 UTC, byte-idêntico ao `dist/` do worktree.
- Protocolo 6 / `live_managed_v1`: navegador WebRTC → `POST /v1/live/sessions` com delegação Responses e 4 ferramentas (`get_context`, `save_decision`, `get_operation`, `end_call`) → sideband `wss://api.openai.com/v1/live/sessions/{id}/attach`. Módulos: `voice-controller/src/onboarding-live-*.ts`, `browser-requests.ts`, `budget.ts`, `server.ts`.
- Tenant do RJ (D1f Marketing, `6e915234`) está travado: chamada `e8168454` terminou com `provider_termination_state=unknown`, reserva de US$ 7,50 ativa, 1.403 tentativas de reconciliação com `live_termination_unconfirmed`; toda nova tentativa falha em 260 ms com `interview_resume_source_not_settled` (última às 17:27 UTC, não reportada a ninguém). A rotina `reconcile_browser_interview_expiry` só aceita `gpt-realtime-2.1*`, estado `external_evidence_required` e código `call_id_not_found`; a Live responde 404 `session_id_not_found`.
- Causa do término não confirmado: `session.close` enviado 1 ms após o `end_call`, com a resposta delegada ainda completando; `finalization_timeout` de 8 s em `createLiveLifecycle`; `ended_at` = close + 8,06 s. O attach usa `graceful_close=true`, presente só no SDK, não na doc.
- Abertura em dois comandos: `session.instructions.append` (ACK em 2,03 s) e depois `session.commentary.append` (0,71 s). A doc pede um comando.
- Latência medida: Start → primeira fala ≈ 7,5 s; Start → primeira pergunta útil ≈ 19,8 s; delegação `get_context` com Astra low 4,8 s (chamada 1,2 s, executor 0,1 s, resposta 3,3 s); com Terra uma gravação levou 6,4 s.
- Tenant QA Foghorn (`49ef9a84`) está limpo: última chamada `88477147` confirmada e liquidada, allowlist até 2026-09-13T06:35Z, aba Edge isolada 897138905 pré-autenticada em `http://127.0.0.1:52797/dashboard/setup/website` (servidor local PID 27381).
- Vozes oficiais Live: Tempo é a única masculina pt-BR; Bossa é feminina. Timbre não é configurável.
- Outros pontos já apontados e ainda abertos: gate de publicação do frontend opcional (`scripts/production-env.mjs` deixa variável ausente passar; `validateProductionPublicationEnv` só roda com flag em `build-site.mjs`); runbook de rollback só cobre o frontend enquanto Edge, controller e banco mudaram de protocolo 4 → 5 → 6; `discovery-supervisor` ainda crava protocolo 4 e depende de `chatgpt.com/backend-api/codex/responses`, que não é API pública estável; captura de diagnóstico humano ficou armada e não gravou; a voz disse "Registrei" quando o `save_decision` foi rejeitado; o modelo inventou um nome pessoal e usou o nome da conta administrativa como empresa.

## 4. Fase 0: baseline provado, nada assumido

Antes de qualquer análise, provar o que está no ar e registrar em `output/audit-<data>/baseline.json`:

- Controller: commit e hash do pacote ativo, sessões ativas, saúde, via SSM somente leitura.
- Edge: versão ativa e hash composto; comparar com os 4 arquivos TS do repo.
- Banco: contagem e última migração; drift zero contra o repo; nenhuma migração já aplicada pode ser editada.
- Dashboard: bundle servido byte a byte igual a um `dist/` reproduzido do commit; `last-modified`.
- Banco de dados de produção: chamadas ativas, reservas ativas, pedidos pendentes, entrevistas com `current_call_id` não liquidado, por tenant. Isso é a lista real de estados órfãos.
- Provedor: um probe autenticado de leitura por sessão pendente (attach ou GET), com status e código registrados.

Sem esse baseline, nenhum achado posterior tem referência. Marcador ao concluir: `LIGOU_AUDIT_BASELINE_PROVED`.

## 5. Fase 1: mapa de conformidade com a documentação

Para cada componente abaixo, produzir uma linha no ledger `output/audit-<data>/CONFORMANCE.md` com: componente, doc oficial (URL e seção), o que o código faz (caminho:linha), veredito (conforme, divergente, não coberto pela doc, indevido), e ação (manter, corrigir, remover, medir).

Componentes e docs mínimas a abrir:

1. Criação de sessão Live e WebRTC: https://developers.openai.com/api/docs/guides/voice-webrtc?api=live e https://developers.openai.com/api/docs/guides/live-conversations . Conferir campos enviados, eventos permitidos no data channel, uso do `store`, `input` de histórico, cobrança mínima de 15 s.
2. Abertura antes de o dono falar: seção "Greet before the caller speaks" em live-conversations. Um comando, não dois.
3. Delegação Responses, ferramentas, continuação, thinking e commentary: https://developers.openai.com/api/docs/guides/live-delegation . Conferir `response.item.create` + `response.create`, `service_tier`, `reasoning.effort`, `parallel_tool_calls`, `max_output_tokens`, e o aviso de que fala e trabalho delegado continuam independentes.
4. Prompt do modelo de voz e do backend: https://developers.openai.com/api/docs/guides/live-prompting . Conferir estrutura (personalidade, backchannel, interrupção, política de delegação), tamanho, idioma, e o que não pertence ao prompt de voz. O modelo de voz tem janela pequena.
5. Fechamento e uso: seção "Usage and graceful close" em live-conversations e https://developers.openai.com/api/docs/guides/voice-server-controls?api=live . Conferir ordem: terminar trabalho delegado, instalar listener de `session.closed`, enviar `session.close`, aguardar com timeout adequado, motivos de fechamento, `POST /v1/live/sessions/{id}/hangup` como fallback, e a regra "a socket close alone does not establish success".
6. Latência e custo: https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live . Conferir "gather information your application already has permission to use before starting the voice session", `service_tier`, ferramentas rápidas, cobrança por segundo.
7. Avaliação: https://developers.openai.com/api/docs/guides/voice-agents e https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation . Métricas com início e fim observáveis, mediana e cauda, população elegível, escuta humana.
8. Modelos: https://developers.openai.com/api/docs/models/gpt-live-1 , https://developers.openai.com/api/docs/models/gpt-6-astra , https://developers.openai.com/api/docs/guides/latest-model . Astra não aceita `none`; Fast mode e `priority` existem e custam 2x; a doc da Live recomenda Terra como padrão e Luna para custo. Registrar a diferença medida, sem trocar.
9. Supabase: doc oficial vigente de RLS, chaves `service_role` e `publishable`, Edge Functions (import map, deploy, versões), migrações e drift. Conferir que a chave privilegiada nunca vai ao cliente, que o gate de build rejeita JWT `service_role`, e que cada RPC `security definer` valida owner, tenant e chamada.
10. Vercel: doc oficial vigente de deploy, proteção de deployment, rollback por alias, e suporte a WebSockets. "Vercel não suporta WebSocket" não pode fundamentar decisão.
11. AWS: doc oficial vigente de SSM Run Command e Session Manager, IAM mínimo, backup e restore de volumes. Conferir que o acesso administrativo não exige SSH público e que existe prova de restore, não só de backup.
12. Navegador: doc do WebRTC e do elemento de áudio (autoplay, permissões de microfone, `getUserMedia`, `RTCPeerConnection` stats). Conferir o caminho de reprodução e a captura de diagnóstico.
13. Google Calendar OAuth por cliente e telefonia SIP: https://developers.openai.com/api/docs/guides/voice-sip?api=live e a doc oficial do Google. Só conformidade de desenho; sem operação nova neste goal.

## 6. Fase 2: caça a bugs, causal e adversarial

Método: para cada sintoma, rastrear até a linha que emite, o handler que decide e a exceção original. Correlacionar navegador, pedido, chamada, sessão do provedor, tenant, revisão, ferramenta, recibo e término. Timeline em relógio monotônico por processo; nunca calcular latência entre hosts com relógios não sincronizados como se fosse exata. Toda causa confirmada ganha um teste que falha antes e passa depois.

Hipóteses e defeitos conhecidos que você deve confirmar ou refutar com evidência, além de tudo que encontrar sozinho:

- Término: timeout de 8 s curto demais para despedida; close enviado com resposta delegada em voo; ausência de fallback `hangup`; ausência de âncora (`provider_termination_attempt_id`, `attempted_at`) para Live; ausência de reconciliação por expiração para Live; reconciliador em loop sem convergência e sem backoff.
- Retomada: `website_interview_prior_settled` bloqueando o tenant para sempre após um término não confirmado; erro cru chegando ao dono sem ação disponível no painel.
- Abertura: dois comandos; instruções de voz longas repetidas no append; risco de fala dupla; medir `session.started` → primeiro `session.output_transcript.delta`.
- Primeira pergunta útil: exige `get_context` antes de qualquer pergunta; contexto breve de 7,5 KB que já existe antes da chamada e pode ir na criação da sessão.
- Ferramentas: `save_decision` rejeitado e a voz confirmando; `context_pending` e `operation_unconfirmed` como o modelo lida; `response_input_buffer_full` já visto; resultado de ferramenta grande demais; `parallel_tool_calls=false` e `tool_choice=auto` justificados ou não.
- Identidade: nome da conta administrativa vs nome do website; nome pessoal inventado; instruções de voz e de backend contendo o mesmo aviso; conteúdo de website tratado como dado, nunca como instrução.
- Estado e concorrência: duplo clique em Começar, refresh, segunda aba, queda de rede, expiração de sessão, reconexão do sideband, fechamento do navegador; nunca dois tentativas ativas nem sessão paga abandonada; eventos atrasados de tentativa superada não podem alterar a atual.
- Persistência: banco lento, falha transitória, timeout após commit, revisão obsoleta, reinício do processo entre gravação e próxima resposta; efeitos idempotentes; `test_memory_generation` coerente em todas as tabelas.
- Aprovação e encerramento: "tá bom" após erro não aprova; aprovação vinculada à revisão vigente; correção durante a revisão; despedida, playout, hangup efetivo, estado terminal, uso conciliado, painel verdadeiro.
- Orçamento: reserva, teto, aviso suave, liquidação, exceção diária dos tenants de teste; nenhuma reserva ativa sem chamada ativa.
- Frontend e build: variável pública ausente compilando `127.0.0.1` no bundle; gate de publicação opcional; proteção de deployment; bundle servido vs reproduzido.
- Release e rollback: matriz de compatibilidade frontend × Edge × controller × migrações para protocolos 4, 5 e 6; o que voltar em conjunto; migrações aplicadas são imutáveis.
- Segurança: chaves em `~/.config/ligou/*.env` e quais processos recebem quais; JWT `service_role` fora do cliente; RLS de cada tabela nova de Live (`website_interview_live_*`); RPCs `security definer` com escopo; segredos fora de logs e telemetria; scanner de segredos limpo.
- Dependências: `discovery-supervisor` em `chatgpt.com/backend-api/codex/responses` e Hermes; se não está no caminho do onboarding, isolar e documentar; se está, substituir pela rota oficial.
- Observabilidade: o que faltou para explicar a gagueira e o não-fechamento sem chute; captura de diagnóstico que arma e grava de verdade no fluxo real; telemetria sem segredos.
- Backup e restore: existe prova de restore completo com tempo medido? Se não, registrar como pendência com o menor teste que prova.

Registrar cada defeito em `output/audit-<data>/DEFECTS.md` com: id, sintoma, causa confirmada ou hipótese, evidência (caminho:linha, log, medição), impacto (bloqueia, corrompe, duplica, engana, custa), prioridade P0 a P3, correção proposta em uma frase, doc que sustenta.

## 7. Fase 3: simplificação com prova

Para cada componente próprio que a plataforma cobre, uma linha em `output/audit-<data>/REMOVALS.md`: componente, o que a plataforma faz no lugar (doc), dependentes atuais (grep estrutural, não só literal), risco de remoção, prova exigida. Candidatos que você deve avaliar, sem decidir por reflexo: intérprete textual e leitor de frases (se restar algo), timers e deadlines não documentados, camadas de verificação de fala, adaptadores de provedor antigos no caminho do onboarding, flags e protocolos de versões que já não existem no cliente publicado. Remoção só entra com testes verdes e sem dependente vivo.

## 8. Fase 4: correções

Ordem: P0 (trava o dono, estado órfão, dinheiro preso, segurança) → P1 (latência e experiência no caminho real) → P2 (release, rollback, observabilidade) → P3 (limpeza). Regras:

- Menor mudança coerente que resolve a causa demonstrada. Deletar é preferível a adicionar.
- Cada correção referencia o id do defeito, o teste RED→GREEN e a seção da doc.
- Medir antes e depois no mesmo método: Start → primeira fala; Start → primeira pergunta útil; fim da fala do dono → áudio útil; `session.close` → `session.closed`; custo por sessão.
- As quatro correções de `GOAL-2026-09-11-DESTRAVAR-FECHAR-ABRIR.md` são P0 e P1 deste goal e entram aqui, não em paralelo.
- Nenhuma migração já aplicada é editada; mudança de banco é migração nova, com gate isolado.
- Decisão que muda comportamento do produto, custo recorrente ou modelo: não tomar; registrar em `OPEN-DECISIONS.md` com opções e custo, e seguir com o resto.

## 9. Fase 5: verificação em camadas, sem misturar níveis

1. Unitário e integração: `voice-controller` (`bun scripts/run-unit-tests.mjs`), dashboard, Edge (`node scripts/check-edge-functions.mjs`), segurança (`node scripts/test-security.mjs`, `node scripts/scan-secrets.mjs`), gate de banco isolado (`node scripts/local-db-gate.mjs`) quando houver migração ou RPC nova, release (`test:deploy-release`, `test:backup-restore`). Rodar só as suítes afetadas depois de cada mudança; a completa uma vez antes do release.
2. Provedor real: smokes curtos e nomeados, cada um provando uma coisa (abrir e cumprimentar em um comando; primeira pergunta útil sem delegação; uma gravação com recibo; `end_call` → `session.closed` real; reserva liquidada; painel verdadeiro). Máximo 8, custo total até US$ 3, tudo conciliado ao final e zero sessões ou reservas ativas.
3. Humano: só depois de 1 e 2, com o tenant do RJ destravado e o link da Vercel. Não substitui os anteriores e não é substituído por eles.

Toda medição reporta método, amostra, mediana e máximo. Simulação é chamada de simulação.

## 10. Fase 6: release e rollback

Publicar pelo processo imutável já existente (`docs/runbooks/EC2-RELEASE-AND-ROLLBACK.md`, `docs/runbooks/EDGE-FUNCTION-RELEASE.md`, `docs/runbooks/MIGRATION-VERIFICATION.md`, `docs/DEPLOY-DASHBOARD.md`), vinculando commit, pacote, Edge, migração e bundle. Antes de publicar, escrever a matriz de compatibilidade e o alvo de rollback do conjunto. Depois de publicar, provar que produção serve exatamente o testado. Corrigir o gate de build para que publicação falhe sem as variáveis obrigatórias ou com destino de voz errado, preservando previews locais.

## 11. Relatório final

Um arquivo `output/audit-<data>/REPORT.md` com no máximo 40 linhas úteis, nesta ordem: (1) estado antes e depois em 5 números medidos; (2) tabela de defeitos corrigidos com id, causa, mudança, teste, doc; (3) defeitos abertos com prioridade e por que não entraram; (4) removidos e por quê; (5) versões publicadas e alvo de rollback; (6) custo total das chamadas pagas; (7) o que só o teste humano pode provar. Confirmado e hipótese em colunas separadas. Referências internas viram caminhos de arquivo. Sem adjetivos.

## 12. Marcadores e paradas

- `LIGOU_AUDIT_BASELINE_PROVED` ao fim da Fase 0.
- `LIGOU_AUDIT_FINDINGS_READY` ao fim das Fases 1 a 3, com os três ledgers. Não é parada: seguir para as correções P0 e P1 dentro do escopo. Parar só para decisões listadas em `OPEN-DECISIONS.md`.
- `LIGOU_READY_FOR_HUMAN_TEST` só com: tenant do RJ destravado e provado por `website_interview_resume_eligible`; smokes reais verdes; zero sessões e reservas ativas; link da Vercel servindo o build testado; relatório entregue. Então parar e aguardar o RJ. Um novo relato humano vira regressão rastreada e correção pontual, não pedido de nova especificação.
- `LIGOU_AUDIT_ACCEPTED` só depois do teste humano bem-sucedido com evidência durável.

## 13. Anti-padrões que encerram o trabalho como falho

Adicionar controle sem defeito reproduzido. Consultar a doc depois de implementar. Trocar modelo ou voz. Reintroduzir MP3, TTS, frases fixas, VAD próprio ou espera por transcrição. Editar migração aplicada. Marcar término confirmado sem evento do provedor. Chamar teste local de prova de produção. Relatar "pronto" com bloqueio conhecido. Rodar suítes inteiras a cada edição. Passar de 8 smokes ou de US$ 3 sem autorização. Tocar nas abas pessoais do RJ. Iniciar outro marco enquanto aguarda o humano.
