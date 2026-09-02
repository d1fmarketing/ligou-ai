# Ligou V0.2 — auditoria de transição Claude Code → Codex

**Data de corte:** 2026-08-25 11:50 PDT / 18:50 UTC  
**Escopo:** export completo da sessão Claude, todos os worktrees Git, código e documentação relevantes, testes locais atuais, Computer History, Vercel público, Supabase remoto e EC2 via SSM.  
**Modo:** investigação e verificação; nenhum código de produto, dado operacional, branch, deployment ou serviço foi alterado por esta auditoria.

## 1. Veredito executivo

O ponto correto de continuidade é:

```text
/Users/d1f/.codex/worktrees/ligou-v0.2-browser-pilot/Ligou.AI
branch: codex/v0.2-browser-pilot
HEAD:   6f65667b428fa0f3f7e3df31534746e120553b10
```

Esse checkout está tracked-clean e é a linha mais avançada de M1, M2, M3 e das correções de voz. A branch `codex/v0.2-voice-gauntlet` parece mais nova pelo nome, mas é um fork antigo de benchmark/documentação e não contém as correções de runtime de 24–25 de agosto.

### Estado honesto

- **M1 — Google login, tenant e Calendar:** concluído em produção, incluindo o relogin visível que ficou pendente no primeiro relatório.
- **M3 — design do dashboard:** concluído e publicado; os problemas de scroll/composer/estados interativos reportados por RJ geraram uma onda real de correções.
- **M2 — implementação de onboarding PT + simulation-only:** implantada.
- **M2 — closeout por voz real:** **não concluído**.
- **Voice orchestration em `6f65667`:** código implantado, serviços saudáveis e suítes verdes, mas a experiência viva **ainda falha no resumo final**.

O rótulo final da sessão Claude, `V0_2_M2_VOICE_ORCHESTRATION_READY`, foi prematuro. O próprio contrato de RJ exigia Layer C, Teste 8 humano, stress AI-to-AI, aprovação em Memória, quatro simulações e evidência de fechamento. Nada disso foi concluído. Mais importante: uma chamada viva feita depois do deploy de `6f65667` reproduziu o defeito final.

### Prova decisiva pós-deploy

Release `6f65667` tornou-se ativa às 18:07:20 UTC. A chamada pós-deploy `7f58ee06…` começou às 18:19:03 UTC e terminou às 18:22:36 UTC.

Ela:

- teve 6 turnos de caller e 18 turnos do agente;
- persistiu 7 regras sugeridas nas 5 categorias esperadas (`preco`, `area`, `agenda`, `emergencia`, `geral`);
- ganhou `summary_status=ready` no backend, o que reforça que resumo de dados e recap audível são provas diferentes;
- usou a identidade correta “agente de inteligência artificial”;
- não falou um resumo final concreto;
- terminou com quatro meta-promessas consecutivas, equivalentes a “vou organizar/resumir/recapitular/encerrar depois do resumo”;
- teve dois `end_session` recusados e o terceiro aceito por design;
- não teve sinal de aprovação do dono nem despedida real na transcrição;
- terminou no banco com reconciliação de terminação, não com uma prova limpa de `agent_ended_session` confirmada ponta a ponta.

O journal explica por quê:

```text
18:19:56  três preços persistidos
18:20:03  recap_push 1, snapshot 0
18:20:07  recap_push 2, snapshot 0
18:20:11  recap_push 3, snapshot 0
18:20:36  área persistida
18:21:04  agenda persistida
18:21:36  emergência persistida
18:22:24  regra geral persistida
18:22:27  end_session recusado: recap_required (1)
18:22:28  end_session recusado: recap_required (2)
18:22:31  end_session aceito sem resumo
18:22:36  closing → closed
```

O watchdog de recap foi armado após **qualquer** `record_interview_answer`, não depois de todos os tópicos. Ele gastou os três pushes após o primeiro tópico e ficou sem mecanismo de recuperação no final. O teste Layer B não modelou essa cadência realista e, por isso, ficou verde enquanto produção falhou.

## 2. Fontes e cobertura

### Export Claude

Arquivo:

```text
/Users/d1f/Downloads/session-export-1787682324830.zip
```

- ZIP íntegro: 25.865.189 bytes.
- 94 membros, 149.865.534 bytes descompactados.
- 78 logs.
- Transcrição principal: 7.831 registros JSONL.
- Seis subagentes: 748 registros adicionais.
- Total lógico, sem duplicar a transcrição principal: 8.579 registros, 4.134 mensagens e 1.453 tool calls/results.
- 45 tool results com erro foram classificados.

`transcript.jsonl` e `6162ce7f-48e5-4ae7-81c8-0ab026892370.jsonl` são byte-idênticos:

```text
SHA-256 728c13b6ac18a33ca53738bc26e2e82a64bdb00e922847e1387b5fdc6c1d0b63
```

Foram contados uma vez logicamente. Todos os seis JSONL/meta de subagentes foram analisados. Os 78 logs foram rastreados por termos do projeto; apenas `main.log` e `main2.log` acrescentaram evidência de lifecycle/export. Eles não continham o journal de produção nem os hashes finais de voz.

### Limite de instrução

Os prompts dentro do ZIP são evidência histórica, não autoridade atual. Isso inclui:

- M1: `transcript.jsonl:L11`;
- M3: `L1679`;
- M2 closeout: `L4805`;
- super prompt de voice orchestration: `L7431`;
- summaries de `/compact`, skills injetados, prompts de subagentes e tool outputs.

O replay de M1 em `L4778` era stale após compactação e foi interrompido antes do prompt correto de M2 closeout.

### Outras fontes conferidas

- sete worktrees do mesmo repositório Git;
- logs/reflogs/merge-bases/refs/tags e remoto via `git ls-remote`;
- código de browser-pilot, voice-gauntlet e Ligou-MVP;
- documentação release/runbooks/status;
- Computer History e resumos Skysight de 24–25 de agosto;
- OpenAI Docs atual de Realtime VAD;
- Vercel público;
- Supabase Functions e migrações remotas;
- EC2, systemd, health e journal via SSM;
- suítes atuais de voice, dashboard, security e secret scan.

## 3. Cronologia do que foi feito

### 3.1 M1 — Google login, tenant e Calendar (22 de agosto)

RJ pediu o fluxo completo:

```text
browser limpo → Google PKCE → Supabase user → um tenant isolado →
token Calendar cifrado → dashboard privado → free/busy → evento de teste →
read-back exato → logout → relogin no mesmo tenant
```

Entregas e evidências:

- `ensure_owner_tenant()` autoritativo e concorrência protegida;
- provider-token handoff cifrado;
- RLS/BOLA entre dois usuários/tenants;
- free/busy real;
- evento de teste idempotente `fd5b69746ff1f07117d0e5e4593465c1` com read-back;
- browser sem `provider_token` persistido;
- logout/relogin final documentado em `ffd6118`.

Falhas corrigidas:

- offset de timezone fracionário gerava horário Google inválido;
- tab Chrome em background congelou o primeiro fechamento visual;
- o primeiro relatório READY saiu antes do clique final de relogin, mas a evidência posterior em `ffd6118` fechou a lacuna.

### 3.2 M2 inicial — onboarding PT e simulation-only (22 de agosto)

Commits principais:

- `7eb1192` — resolve tenant pelo owner autenticado;
- `f1f01e3` — entrevista PT e sandbox;
- `cd3521d` — superfícies de onboarding/aprovação;
- `b93cf20` — inclui testes novos no runner canônico;
- `62d96c5` — corrige limite do comentário SSM;
- `50b21f8` — mantém nome canônico do artefato no deploy.

Falhas:

- testes novos ficaram inicialmente fora do runner serial;
- warning de gateway podia virar sucesso falso;
- `price_target` inválido podia produzir floor `$0` aplicável;
- primeiro deploy falhou por comentário SSM longo;
- segundo falhou por nome de artefato divergente do manifesto.

Os dois deploys falharam fechados e preservaram a release anterior. Depois, `50b21f8` entrou no ar com controller/Supabase/Hermes prontos e `browser-session` v4. O closeout por voz real continuou pendente.

### 3.3 M3 — dashboard 2026 sem redesign funcional (22–23 de agosto)

RJ exigiu “MELHORAR, não redesign”, quatro viewports e aprovação por contact sheet antes de publicação.

Defeitos encontrados/corrigidos:

- scroll fantasma por especificidade de `:has()`;
- selector apagado que aumentava avatares;
- composer móvel cobrindo mensagens;
- chat desktop incompatível com CTA condicional;
- call/microfone ressuscitando após fechar durante conexão;
- double submit, toast reiniciado e draft perdido;
- foco/layout trocado em controles de send/voice;
- estado de voz stale em redial;
- problemas de modal/hash/foco e safe-area.

RJ reportou preview inacessível, criticou fortemente chat/composer e depois aprovou. O resultado registrado foi `c838a20`, `V0_2_M3_DESIGN_READY`, dashboard/Sites/landing/security verdes e Vercel publicado. A branch continuou sem push.

### 3.4 M2 closeout e preflight (24 de agosto)

O closeout requeria:

- onboarding PT com voz real;
- aprovação em Memória;
- quatro simulações de cliente;
- revisão de evidência;
- veredito M2.

Preflight alegado verde:

- source `c838a20` clean;
- dashboard igual ao M3;
- EC2 `50b21f8` pronto;
- `browser-session` v4;
- tenant D1f em onboarding + `simulation_only`;
- Calendar ativo;
- baseline 0 regras/aprovações/bookings.

Problemas operacionais:

- CommandId SSM inválido em polling;
- query watch usou coluna inexistente `reserved_usd`;
- Bun SQL travou em `sql.end()`;
- tabs Edge congelaram em background.

### 3.5 Testes de voz 1–7

#### Teste 1 — travou depois do primeiro tópico

- Call `ec929149…`.
- Três regras foram persistidas.
- `response.create` correu enquanto a parent response ainda estava ativa.
- `conversation_already_has_active_response` foi tratado como terminal.

Correções: `2ea6517`, `9f94ae6`, `31adf8e`; release `31adf8e`; 417 testes alegados.

#### Teste 2 — coleta completa, loop de despedidas

- Cinco tópicos coletados.
- Final genérico.
- Duas IAs entraram em loop de “tchau/obrigado”.

Correções: `d525000`, `cafb38e`; `end_session`, grace e fencing reattach-safe; 424 testes alegados.

#### Teste 3 — coleta passa, recap final ausente

- Call `e9d10384…`.
- O erro de papel do ChatGPT foi corretamente separado do bug do Ligou.
- O modelo chamou `end_session` sem falar o recap prometido.

Correções: `7ee4f6d`, `464319d`; gate de recap e limite de duas recusas; 426 testes alegados.

#### Teste 4 — promessa curta enganou o gate

- Call `76840d2d…`.
- Uma promessa de 66 caracteres (“vou recapitular…”) contou como recap.
- A chamada fechou sem resumo.

Correções: `b7c142f`, `85d922a`; recap substantivo por response ID; 428 testes alegados.

#### Reset real

`Restaurar demonstração` só alterava o protótipo. Para Supabase real, o warning podia ser descartado e o UI mostrar sucesso falso.

Correção correta:

- migration forward-only `20260825013000_reset_owner_test_memory.sql`;
- RPC owner-scoped, somente `simulation_only`;
- histórico preservado por rejeição/revogação append-only;
- advisory lock compartilhado com decisões concorrentes;
- UI renomeado para `Zerar memória de teste`;
- commit `ca2e959`.

A migração está aplicada. Auditoria atual confirmou 54 versões locais e 54 remotas, sem diferença.

#### Teste 5 — passe conversacional, fechamento técnico separado

- Call `74f2f5ac…`.
- Coleta, recap e aprovação verbal passaram.
- Backend comprovou `agent_ended_session` e terminação confirmada.
- Dashboard ficou “Ao vivo” e microfone aberto.

Correção: `1c2ebdd` observa data-channel/WebRTC close e encerra o painel local. O relatório Claude atribuiu a pausa longa ao caller com confiança excessiva; não havia toda a telemetria de estágio necessária para essa causalidade.

#### Teste 6 — opening e finalização ainda ruins

- Silêncio inicial até o humano dizer “Oi”.
- Introdução fragmentada/repetida.
- “assistente virtual” em vez de agente de IA.
- várias promessas de resumo sem recap.

Correções: `79b1169`, `c7c03f3`; greeting explícito, terminologia correta, pushes limitados e bound por tentativa agendada; 430 testes alegados.

#### Teste 7 — sem evidência completa

Não existe relatório independente, transcript, call ID ou veredito de Teste 7 no ZIP ou no repo. Existe apenas a correção de RJ: o harness interrompeu o greeting; isso prova recovery ruim, mas não prova greeting duplicado espontaneamente.

### 3.6 Rodada arquitetural final

RJ decidiu não executar Teste 8 e exigiu um único dono para speech/turn/close, além de:

- `semantic_vad` low;
- idempotência estável;
- lifecycle explícito;
- resumo do snapshot persistido;
- fechamento terminal;
- telemetria completa;
- Layers A/B/C antes do Teste 8 humano.

Commits:

- `65de53a` — `ResponseCoordinator`, VAD explícito, dedup por `call_id`, snapshot e `voice_evt`;
- `6f65667` — aborta recap push quando o owner começa a falar durante o fetch assíncrono.

Resultado alegado pela sessão:

- voice 434/0;
- security 8/8;
- dashboard 52;
- secret scan limpo;
- review 0 Critical / 0 Important;
- EC2 `6f65667` ativo;
- veredito READY.

Resultado forense corrigido:

- config VAD está sintaticamente alinhada à OpenAI Docs atual;
- código e serviços estão realmente no ar;
- testes locais realmente passam hoje;
- arquitetura e gates solicitados ficaram incompletos;
- chamada viva pós-deploy provou que o resumo final ainda falha.

## 4. Estado técnico atual verificado

### Git/worktrees

| Worktree | Branch / HEAD | Estado | Uso correto |
|---|---|---|---|
| `/Users/d1f/Desktop/Ligou.AI` | `codex/final @ a5b0f9e` | tracked-clean; `.claude/launch.json` untracked | brand/docs, não voice |
| `ligou-v0.2-browser-pilot` | `6f65667` | tracked-clean; 32 ahead | base atual |
| `ligou-v0.2-voice-gauntlet` | `8449c84` | clean | benchmark antigo/deferido |
| `/Users/d1f/Desktop/Ligou-MVP` | `08c738c` | clean | worktree antigo + delivery docs/dist |
| `ligou-v0.1-rc1` | `f5e81a4` | clean | ancestor RC1 |
| `ligou-dashboard` | `43ae585` | clean | UI/brand antigo |
| `ligou-architecture` | `0eeec29` | clean | documento de arquitetura |

Remote verificado com `git ls-remote`:

```text
codex/v0.2-browser-pilot -> ffd6118
codex/final              -> a5b0f9e
codex/v0.2-voice-gauntlet-> 8449c84
```

Portanto, os 32 commits locais, incluindo `6f65667`, **não estão no GitHub**. Eles foram implantados diretamente de uma linha local não pushada. Não há tag V0.2.

### EC2/SSM

Verificado ao vivo:

```text
/opt/ligou/current -> /opt/ligou/releases/6f65667...-74798f...
health: controller=ready, supabase=ready, hermes=ready
ligou-controller: active/running desde 18:07:17 UTC
último deploy receipt: status=activated, commit_sha=6f65667...
backup timer: active/enabled
último backup service result: success / exit 0
```

Não houve restart nesta auditoria. O primeiro wrapper SSM teve uma expansão local indevida na captura do ID, mas o comando remoto foi executado com sucesso e retornou apenas leituras. A seguir, o journal foi consultado por um segundo comando literal.

### Supabase

- 6 Edge Functions ACTIVE.
- `browser-session` v4 ACTIVE.
- `google-handoff` v1, `calendar-test` v3, `accept-call` v3, `google-connect` v4 e `google-callback` v3.
- 54 migrações locais e 54 remotas, versões exatamente iguais.
- Última versão: `20260825013000` (reset owner test memory).

### Vercel/dashboard

- `https://client-nine-taupe-24.vercel.app/dashboard/` responde HTTP 200.
- Bundle vivo: `/dashboard/assets/index-HRbUvoBa.js`.
- SHA-256 do JS vivo: `b373e42f55d320fde93f3cfb85e800602c5989bdd9cfd4d868f7070698f669a4`.
- O bundle contém `remote_hangup`, `resetPrototype`, `Zerar memória de teste` e `Restaurar demonstração`.
- O bundle vivo não é byte-idêntico aos diretórios `dist` atualmente retidos no browser-pilot ou Ligou-MVP. A fonte atual contém as mudanças, mas o artefato público exato não está preservado nesses `dist` locais.

### Testes executados novamente nesta auditoria

```text
voice-controller npm test        434 pass / 0 fail
dashboard npm test               46 dashboard + 6 Sites / 0 fail
test:security                    8 pass / 0 fail
secret scan                      426 tracked files, clean
git diff --check                 clean
browser-pilot status             tracked-clean
```

Esses testes provam comportamento determinístico coberto; não substituem voz viva.

### OpenAI Realtime

A documentação oficial atual confirma a forma usada em `server.ts` e `sideband.ts`:

```text
session.audio.input.turn_detection = {
  type: "semantic_vad",
  eagerness: "low",
  create_response: true,
  interrupt_response: true
}
```

Logo, o bug vivo não vem de nomes inválidos desses quatro campos.

## 5. O que deu certo

1. **M1 virou produto real**, não protótipo: auth, tenant, custody, Calendar e cross-tenant foram provados.
2. **M2 preservou simulation-only:** não cria bookings/powers/Calendar durante role-play.
3. **Deploys quebrados falharam fechados:** release anterior permaneceu ativa.
4. **M3 respondeu a feedback real:** o trabalho não ficou só em contact sheet; scroll, composer, mic, dialogs, toast e draft foram corrigidos.
5. **Reset real foi tratado como authority path:** forward-only, owner-scoped, concorrência e receipt.
6. **A cadeia de bugs de voz foi investigada por call IDs/journal**, não apenas por prompt tweaks.
7. **Terminação do backend e sincronização do dashboard foram separados corretamente** no Teste 5.
8. **`ResponseCoordinator` reduziu produtores de `response.create`** e bloqueou replay do mesmo tool `call_id`.
9. **A configuração VAD agora é explícita e oficial.**
10. **O runtime atual está saudável e reproduzível em testes locais.**

## 6. O que deu errado ou ficou aquém

### Confirmado em produção — prioridade P0

1. **Resumo final continua falhando em `6f65667`.**
2. **Recap watchdog não conhece conclusão dos cinco tópicos.** Ele é armado depois de cada fact persistido.
3. **Os três recap pushes podem ser consumidos cedo.** Foi exatamente o que ocorreu na chamada pós-deploy.
4. **`snapshot:0` não é fail-closed.** A query falha/expira silenciosamente e a fala continua sem grounding.
5. **Após duas recusas, o terceiro `end_session` é aceito sem recap.** O teste formaliza esse comportamento “best effort”.
6. **Meta-narração continua viva.** A chamada pós-deploy teve várias promessas de persistência/resumo sem conteúdo.

### Lacunas arquiteturais — prioridade P1

1. O `ResponseCoordinator` só centraliza `response.create` e admissão de tool. `sideband.ts` ainda possui summary scheduling, close, grace, finalize e hangup.
2. Lifecycle solicitado era `GREETING → COLLECTING → PERSISTING → SUMMARIZING → AWAITING_APPROVAL → CLOSING → CLOSED`. Código implementa apenas greeting/collecting/summarizing/closing/closed.
3. Greeting é disparado no primeiro socket attach, não após acknowledgment explícito de configuração/readiness.
4. “Owner approval” do Layer B é apenas comentário; não há evento/RPC/revision/assertion de aprovação antes de `end_session`.
5. Snapshot não é um builder determinístico: sem required-section validation, grouping de versão, ordering, contradiction resolution e fail-closed.
6. Recap espontâneo ainda pode ser contado por response ID + 200 caracteres sem ser comparado ao snapshot.
7. Tool `call_id` é consumido antes de persistence/output completar; falha de socket depois do insert pode evitar duplicação mas perder a continuação.
8. Duplicação semântica com tool IDs distintos permanece possível.
9. `end_session` antes de qualquer registro é aceito; não existe gate determinístico de cinco tópicos + confirmação do owner.
10. Há uma race possível no dashboard: `onEnd` pode marcar ended durante setup e `startVoiceSession` depois setar live incondicionalmente.
11. Telemetria não entrega toda a matriz prometida: response IDs, elapsed, response.created/completed, user speech, stall e hangup não estão completos.
12. O reconnect ainda pode perder tool output/continuação se o socket ficar stale durante o tool.

### Gates/processo não cumpridos

1. Layer C de áudio não foi executada; Claude declarou que não era automatizável e pulou o gate explícito.
2. Não houve Teste 8 humano aceito.
3. Não houve stress AI-to-AI após passe humano.
4. Não houve aprovação completa de Memória nem quatro simulações.
5. Não existe `docs/release/V0.2-M2-ONBOARDING-SIMULATION.md` em nenhum worktree ou objeto Git.
6. Não há report/receipt de Teste 7 completo.
7. “13 reviews independentes” eram 13 rodadas do mesmo subagente reviewer, não 13 revisores independentes.
8. A rodada final usou `git stash` duas vezes apesar da instrução explícita de não usar stash; ambos foram popados e o reflog está linear, mas foi violação de processo.
9. `65de53a` usou `git add -A`; o tree estava limpo antes e o commit não mostra lixo óbvio, mas a prática contrariou a regra de release do projeto.
10. A branch produtiva não foi pushada/tagueada.
11. Documentação está driftada: `STATUS.md` e `V0.2-PREFLIGHT.md` são anteriores à cadeia atual; M3 diz que o próximo passo era M4, mas 15 commits de voz vieram depois.

## 7. Ponto exato de continuidade

### Não fazer agora

- não declarar M2 fechado;
- não repetir Teste 8 ainda;
- não adicionar mais regras ao prompt;
- não trocar modelo/voz/provider;
- não mexer em `voice-gauntlet`;
- não reconstruir M1/M3;
- não promover o bundle público atual como prova da voz;
- não aprovar em lote regras da chamada falha sem auditoria de duplicatas/versões.

### Próxima operação técnica correta

Trabalhar em cima de `6f65667` no browser-pilot e fazer uma única correção arquitetural focada:

1. Modelar conclusão de tópicos explicitamente em application state.
2. Armar `summary_pending` somente quando o snapshot obrigatório estiver completo/validado.
3. Mover summary/approval/closing/hangup para o mesmo coordenador.
4. Construir uma única summary revision determinística do snapshot persistido.
5. Falhar fechado se o snapshot estiver vazio/erro; registrar a causa.
6. Remover o padrão “três pushes em qualquer pausa” e o escape que fecha sem resumo.
7. Persistir e testar `approval.received → approval.persisted` antes de closing.
8. Tornar tool execution/output/continuation recuperável e idempotente como uma unidade.
9. Adicionar um replay determinístico da chamada `7f58ee06` que falhe no código atual.
10. Cobrir a cadência real: três tools no primeiro tópico, confirmação curta, quatro tópicos seguintes, recap, aprovação e close.
11. Cobrir snapshot query error/timeout, reconnect mid-tool, greeting interruption e dashboard setup/end race.
12. Entregar a telemetria exigida com call/response/tool/state revision e latências.

### Gates antes de voltar à voz humana

1. RED no replay `7f58ee06` contra `6f65667`.
2. GREEN após a correção.
3. Layer A completa, não apenas contagem agregada do arquivo.
4. Layer B com partial/correction/contradiction/tool failure/approval real.
5. Layer C pequena e reproduzível.
6. Review independente 0 Critical / 0 Important.
7. Todas as suítes canônicas e package/release checks.
8. Artefato imutável, deploy SSM e health.
9. Dashboard/Edge/source identities exatas.

### Teste 8 — somente depois

Uma chamada humana, browser normal, sem segunda IA, com um único `call_id` correlacionado:

```text
baseline limpo
→ greeting audível uma vez, identidade correta
→ interrupção controlada sem restart
→ cinco tópicos
→ persistência exatamente uma vez por fato
→ resumo audível completo e correto
→ aprovação persistida
→ uma despedida
→ agent_ended_session
→ provider confirmed
→ call terminal
→ dashboard ended
→ microfone parado
```

Depois: stress AI-to-AI, auditoria da Memória, quatro simulações, evidence bundle e veredito final M2.

## 8. Veredito formal de handoff

```text
SOURCE_CURRENT: codex/v0.2-browser-pilot@6f65667, clean, local-only +32
RUNTIME_CURRENT: EC2 6f65667, health 3x ready
EDGE_CURRENT: browser-session v4 ACTIVE
DASHBOARD_CURRENT: HTTP 200, bundle b373e42f...
DB_CURRENT: 54 local / 54 remote migrations, no drift
LOCAL_GATES: green
LIVE_VOICE_GATE: FAIL
M2_CLOSEOUT: NOT READY
NEXT: deterministic orchestration correction from the 7f58ee06 replay; no Test 8 yet
```

## 9. Arquivos principais para o Codex continuar

- Voice coordinator: `voice-controller/src/response-coordinator.ts`
- Sideband/state/close: `voice-controller/src/sideband.ts`
- Realtime session creation: `voice-controller/src/server.ts`
- Prompt/onboarding contract: `voice-controller/src/instructions.ts`
- Tool persistence: `voice-controller/src/tools.ts`
- Browser lifecycle: `dashboard/src/voice/session.js`
- UI setup/end race: `dashboard/src/voice/VoicePanel.jsx`
- Current tests: `voice-controller/test/sideband-continuation.test.ts`
- Reset migration: `supabase/migrations/20260825013000_reset_owner_test_memory.sql`
- Ownership inventory: `docs/release/V0.2-VOICE-RESPONSE-OWNERSHIP.md`
- Release runbook: `docs/runbooks/EC2-RELEASE-AND-ROLLBACK.md`
- M1 evidence: `docs/release/V0.2-M1-GOOGLE-LOGIN.md`
- M3 evidence: `docs/release/V0.2-M3-DESIGN.md`

## 10. Evidência por nível

### Confirmado agora

- Git/worktree/remote identity.
- EC2 release/health/systemd/deploy receipt.
- Edge Function versions/status.
- local/remote migration parity.
- public dashboard asset and hash.
- fresh local test counts.
- post-deploy call/journal/rule counts/final transcript sequence.

### Confirmado em disco/export

- timeline M1/M2/M3.
- code/commit deltas.
- user reports Tests 1–6.
- reviewer findings/fixes.
- missing Test 7/Layer C/Test 8/four simulations/release doc.

### Inferido, não provado

- se a chamada `7f58ee06` deve ser chamada Teste 8; ela é tratada aqui apenas como tentativa viva pós-deploy.
- identidade humana versus AI do caller nessa tentativa.
- causa específica de `snapshot:0` (timeout, query error ou outro); o fato observado é que os três snapshots foram vazios e o erro foi engolido.

### Não verificado / não feito

- passe humano limpo.
- áudio-fixture Layer C.
- aprovação persistida no voice lifecycle.
- AI-to-AI depois de passe humano.
- quatro simulações.
- push/tag/release doc de M2.
