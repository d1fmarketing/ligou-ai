# LIGOU — Proposta de construção: o funcionário

**Data:** 17/08/2026 · **Status:** **PROPOSTA — aguardando aprovação de RJ.** Nenhum documento desta pasta é canônico sem aprovação explícita dele.
Substitui `DECISAO-CONSTRUCAO-2026-08-17.md` e `DECISAO-PLATAFORMA-VOZ-2026-08-17.md` como candidato único. Incorpora a revisão externa de 17/08 (sessão Codex), que corrigiu o padrão de aprovação, o papel do MCP, a superfície do dono no piloto e a definição de pronto.
**Fonte de direção do produto** (direção registrada, não contrato aprovado — o brief diz "MVP ainda não aprovado"): `.impeccable.md`, `LIGOU-PRODUCT-BRIEF-WORKING.md`, site v9 no ar. O que RJ confirmou em conversa: funcionário operacional, não secretária; onboarding conduzido pelo próprio agente.
**Regra deste documento:** afirmação técnica só com fonte primária ou código-fonte desta sessão; o que não foi verificado está na seção 8 — e só lá.

---

## 0. A decisão em cinco linhas

1. **O que o Ligou é:** um funcionário de IA contratado por empresa de serviços residenciais — memória do negócio, regras aprovadas pelo dono, trabalhos, ferramentas via MCP, ligações outbound. Atender telefone é o canal nº 1, não o produto.
2. **Runtime:** `openai-agents-js` (MIT), com o Realtime como **adaptador provisório de voz, não cérebro do produto**. `RealtimeAgent` é implementação especializada (identidade compartilhada com o agente textual; sessão e capacidades, não). O gate `needsApproval` (verificado no código-fonte) serve ao **authority engine automático** — checagem de regra em milissegundos, dentro da chamada. **Aprovação do dono é sempre assíncrona:** fora de regra, o agente não promete — fala determinístico que a equipe confirma, cria caso pendente, e a decisão vem depois. A chamada **nunca** espera o dono. (A landing sempre disse isso: *"Coleta as informações, explica que a equipe retorna, e pergunta para você."*)
3. **Construímos UMA coisa:** a identidade do funcionário — memória por empresa, regras versionadas, máquina de aprovação, receipts, trabalhos — sobre **Supabase**, que já está pago.
4. **Custo de voz:** piso ~$0.015–0.041/min + telefonia (~$0.003–0.009/min). Nos 400 min do plano de $299: **~$7–20/mês de COGS → margem ~93–98%**. O número real sai do piloto de 10 chamadas, não de estimativa.
5. **Prazo:** 4 semanas até a primeira chamada real ponta a ponta. O funcionário nasce pelo primeiro trabalho dele: **ligar para o dono e se apresentar** (a entrevista de onboarding em português que o site promete).

---

## 1. O produto — contrato congelado, nada aqui é novo

Do `.impeccable.md` e do site no ar:

- **Fluxo do agente (8 passos):** entrevista o dono em PT → constrói memória operacional daquele negócio → consulta sistemas conectados → executa dentro das regras → percebe o que falta → pergunta ao dono com contexto → incorpora só a regra aprovada → melhora sempre, sem misturar memórias entre empresas.
- **Canais:** telefone inbound EN/ES (cliente final); conversa contínua com o dono em PT (WhatsApp texto/áudio agora, app web no lançamento, iPhone/Android depois); **outbound** ("o dono define objetivo e limites, o Ligou liga e volta com o resultado").
- **Preço no ar** (`ligou-app9.jsx:471–488`, travado por testes): $299/mês até 31/12/2026, ativação isenta, valor travado enquanto ativa; 400 min inclusos; excedente $0.35/min. $499/mês + $499 só pós-oferta.
- **Onboarding é o agente:** *"Em uma conversa curta, ele te entrevista em português e cria a primeira versão do atendimento"* (`ligou-app9.jsx:430`).

---

## 2. Arquitetura — o agente no centro

```
                O AGENTE LIGOU  (um por empresa · openai-agents-js)
                memória operacional · regras versionadas · trabalhos
                          │
   ┌──────────────┬───────┴────────┬────────────────┬──────────────┐
 CANAL 1        CANAL 2         TRABALHOS        FERRAMENTAS    APROVAÇÃO
 Telefone       WhatsApp        outbound:        via MCP:       needsApproval
 cliente EN/ES  com o dono      1) entrevista    agenda, CRM,   pausa a tool
 RealtimeAgent  PT, texto+áudio de onboarding    o que vier     NA chamada →
 + Twilio SIP   (o "app" antes  2) ligações      (MCPServers    dono decide →
                do app)         operacionais     nativo)        vira regra
                          │
              AUTHORITY PLANE (nosso — o fosso)
     prepared → pending_approval → authorized → committed → verified
                          │
              SUPABASE: Postgres + RLS + auth
              memória por tenant · regras · receipts · kill switch
```

**Invariantes — valem mais que qualquer linha de código:**

1. **Commitment gate em dois caminhos:** dentro de regra aprovada → o authority engine autoriza automaticamente via `needsApproval` (milissegundos) e o agente executa e fala. Fora de regra → **nunca** segura o cliente na linha: fala determinística ("a equipe confirma"), caso pendente criado, decisão do dono assíncrona — e a resposta aprovada vira regra para a próxima situação equivalente. Nenhuma frase com compromisso sai antes de `authorized`, e nenhum cliente espera por causa disso.
2. **Assimetria de segurança:** `kill`, desligar, transferir e escalar para o dono **nunca** são bloqueados pelos gates que bloqueiam criar compromisso. Desfazer sempre passa.
3. **Receipt tri-estado:** `accepted` só com decisão positiva + ID concreto; `failed` só com rejeição explícita; `unknown` em todo o resto — e `unknown` **nunca reenvia**, exige reconciliação. É o que impede agendar o mesmo cliente duas vezes.
4. **Memória só promove pós-aprovação.** E RLS protege o banco, **não o prompt**: a montagem de contexto tem gate próprio com teste próprio — nenhum fragmento do tenant B entra no prompt do tenant A.
5. **Capabilities negociadas, não assumidas:** o adaptador de voz expõe o que o modelo do momento sabe fazer (truncar fala? dono do turno?). É o hedge contra o GPT‑Live sem escrever contra um protocolo imaginado.

---

## 3. Stack

### Adotar agora (tudo verificado nesta sessão)

| Componente | Papel | Verificação |
|---|---|---|
| `openai-agents-js` (MIT) | runtime do agente: voz + texto + MCP + aprovação nativa | `needsApproval`/`approve()` no código-fonte; `MCPServers` nas docs; exemplo oficial `realtime-twilio-sip` |
| `gpt-realtime-2.1-mini` (padrão) / `2.1` (escalonamento) | modelo de voz | preços por token verificados dígito a dígito, fonte oficial |
| Twilio — **subconta dedicada ao Ligou** | SIP inbound/outbound, WhatsApp, A2P fallback | nunca compartilhar fronteira de compliance ou numeração com outra operação |
| Supabase | Postgres + RLS + auth + storage | a disciplina RLS (FORCE, role não-owner, `set_config(...,true)`) é nossa de configurar |
| Drizzle ORM | schema tipado + `pgPolicy`/RLS | verificado no pacote |
| `ScriptedRealtimeTransport` | testes offline do agente, custo zero por execução | confirmado no tarball npm |
| `openai-cookbook/realtime_evals` | replay determinístico G.711 μ-law 8 kHz | confirmado em código; portar para `2.1` (default do repo é legacy) |
| WhatsApp Business via Twilio | **no piloto: só notificação + deep-link para o dashboard**; conversa completa depois dos vettings | template aprovado obrigatório fora da janela de 24h; $0.005/msg sempre |

**MCP é protocolo, não integração pronta:** OAuth por tenant, allowlist de ferramentas, validação, idempotência e receipts continuam sendo nossos — e alguns sistemas vão exigir adaptador próprio. O que o MCP dá é a tomada, não o eletrodoméstico.

### Entra depois, quando a necessidade provar

DBOS Transact (espera durável complexa — Fase 2 usa linhas de estado no Postgres e retomada própria); Langfuse self-hosted; Presidio + spaCy PT (modelo é CC BY-SA — atenção); promptfoo (corpus sintético apenas); app web do dono (religar o protótipo de dashboard de 5.565 linhas ao Supabase real, com login).

### Evitar (motivos verificados, não repetir a discussão)

Plataformas de atendimento como runtime (Vapi/Retell/Bland — categoria secretária eletrônica; Retell nem desliga gravação mantendo transcrição); speech-to-speech dentro de plataforma alugada ($0.345/min só de modelo); Twilio Media Streams como caminho primário (3,8× o custo); Inngest (SSPL); Temporal/Hatchet (escala errada: $500/mês ou 6 containers); Prisma no authority plane (exemplo RLS oficial diz "not intended for production"); HumanLayer e clones (líder deprecado, resto <1k stars/AGPL — **essa camada é nossa, e é o fosso**); SMS toll-free como atalho de A2P (bloqueado desde 2024); repos Realtime pré-`2.1`.

### Fallbacks nomeados

- **Canal telefônico só:** Vapi (dossiê completo no doc supersedido — ToS treina em chamadas, ZDR sem preço público).
- **Media path próprio:** LiveKit Agents (pesos do turn-detector têm licença proprietária — flag conhecida).
- **Loop próprio barato:** Twilio ConversationRelay.

---

## 4. Economia — piso verificado, real a medir

Conversão oficial: 1 token/100ms de áudio ouvido, 1 token/50ms falado. Preços/1M tokens: `2.1` $32 in · $0.40 cached · $64 out; `mini` $10 · $0.30 · $20.

| Chamada de 4 min (agente fala 1,6) | mini | 2.1 |
|---|---|---|
| Piso por chamada | ~$0.060 | ~$0.163 |
| Piso por minuto | **~$0.015** | **~$0.041** |
| COGS nos 400 min/mês | ~$6 | ~$16 |
| Margem no plano $299 | ~98% | ~94% |
| Margem no excedente $0.35/min | folga larga | ~88% |

**A variável que decide a margem é higiene de cache (fator ~6×), não a escolha do modelo (~3×).** Regra de arquitetura: prefixo estável = identidade do tenant + ferramentas + memória aprovada; **tudo dinâmico entra depois do prefixo**. Cache quebrado leva o flagship de ~$0.04 para ~$0.25/min.

O custo de input cresce por turno (a conversa inteira é reenviada a cada resposta — doc oficial). Por isso piso ≠ teto: **o número real sai das 10 chamadas medidas da Fase 2, e nenhuma decisão de preço muda antes disso.**

Onboarding: a entrevista custa ~$1–3 de voz + $1.15/mês de número. Ativação isenta custa dólares.

---

## 5. Legal mínimo de engenharia (não é copy, é requisito)

- **Aviso de gravação/transcrição em toda chamada.** CIPA §631 alcança transcrição e quem "aids"; §637.2 dá $5.000/violação sem exigir dano. O aviso precisa ser **verbatim e garantido** — string fixa, nunca output do modelo.
  - **Default:** tocar o aviso no lado Twilio antes de conectar o áudio ao modelo (Programmable Voice `<Play>` → `<Dial><Sip>`; telefonia ~$0.0085/min em vez de $0.0034 — ~$2/mês por cliente de seguro).
  - **A validar na semana 1:** esse encadeamento contra o conector SIP da OpenAI. Fallback: ESIPT direto com primeira fala instruída — garantia mais fraca, registrar o risco.
- **Tracing da OpenAI é server-side e liga por default.** A env var de dados sensíveis **não** cobre áudio; o desligamento correto é `tracing_disabled: true` no `RealtimeRunConfig`. Item mais perigoso das refutações — checklist errado marca "resolvido" com o vazamento aberto.
- **Não gravar áudio por padrão.** O produto entrega o resumo, não o WAV.

---

## 6. Fases — cada uma com saída verificável

**Fase 0 — hoje, antes de código (preservar o que existe):**
preservar refs, checkouts e artefatos não publicados em arquivo privado; verificar os
backups Git do Ligou; preparar uma subconta dedicada de telefonia.
*Saída:* evidência privada de backup verificável e fronteira dedicada para o Ligou.

**Fase 1 — semana 1, paralelo, zero código (relógios que correm sem nós):**
Twilio Business PCP (sem ele: 2 chamadas simultâneas no total) · A2P 10DLC Standard Brand da Ligou ($46+$15+$10/mês, um só) · Meta business verification + template WhatsApp ("several weeks", palavra da Twilio).
*Saída:* os três aprovados nos consoles.

**Fase 2 — semanas 1–4, o funcionário nasce:**
- *2a* — esqueleto do agente + authority plane: `needsApproval` ligado às regras no Supabase, máquina de 5 estados, receipts, testes offline com `ScriptedRealtimeTransport`.
- *2b* — **primeiro trabalho: a entrevista.** Outbound em PT para o dono; as respostas sobre os cinco tópicos da página (serviços, cidades, preços autorizados, agenda, emergências) viram a memória operacional inicial **e a lista de classes de risco**. Testar com RJ como "dono".
- *2c* — superfície do dono: o dashboard existente ganha login e backend real (aprovar, ajustar, revogar); WhatsApp só notifica e leva por deep-link.
- *2d* — inbound EN/ES com aviso verbatim; primeira chamada real. **Dentro de regra: agenda exatamente uma vez, com receipt. Fora de regra: não promete, cria caso pendente.**

*Saída — o que se prova é o CICLO do funcionário, não uma chamada:* (1) entrevista outbound em PT gera memória como rascunho; (2) dono aprova/ajusta pelo dashboard; (3) cliente liga em EN, agente qualifica e consulta disponibilidade; (4) dentro de regra → agendado exatamente uma vez, receipt concreto; (5) fora de regra → sem promessa, caso pendente para o dono; (6) **a correção aprovada pelo dono muda o comportamento na próxima situação equivalente — provado em teste**; (7) `kill` <2s; caso pendente sobrevive a `kill -9` e retoma com hash revalidado; (8) **10 chamadas com `usage` real registrado** — o número que substitui a seção 4; (9) teste automatizado: compromisso não é falado antes de `authorized`.

**Fase 3 — semanas 5–7, segundo tenant:**
pgTAP em CI: leitura cross-tenant = zero linhas com role não-owner · teste do gate de contexto (prompt, não banco) · lint proibindo `set_config(..., false)` · kill switch por tenant e global, duráveis em banco.

**Fase 4 — semanas 6–9, evals e CI (paralelo):**
`walk_harness` portado para `2.1` · corpus com ruído de rua/obra, endereços e telefones US, 8 kHz μ-law · gate offline no CI com custo zero · `verify-claude-v9.mjs` + as 4 suítes do site em GitHub Actions.

**Fase 5 — mês 3+:**
App web do dono (protótipo do dashboard religado ao Supabase real, com login) · health check diário de redirecionamento (o modo de falha nº 1: telefone toca, ninguém atende, nenhum log) · segunda operadora com runbook escrito antes do incidente · ligações operacionais outbound genéricas.

---

## 7. O que já existe e entra de graça

| Ativo | Estado | Uso |
|---|---|---|
| Landing v9 (`origin/main = 161e8e8`) | produção, 29 testes, build determinístico, verificador de hashes | continua; ligar número real quando existir (o v9 perdeu o `SITE_CONFIG` — restaurar o contrato na Fase 2d) |
| Dashboard protótipo (5.565 linhas) | localStorage, sem backend | vira o app web do dono na Fase 5; o `model.js` (aprovação "só este caso" vs "virar regra", versionamento, revogação) é o melhor vocabulário escrito do passo 7 |
| Receipts tri-estado, aprovação de uso único e ledger de memória/autorização | proveniência técnica restrita | **padrões**, extraídos limpos — não importar serviços nem arrastar código de fork |
| Inventário de provedores | dossiê privado | não reproduzir contas, credenciais ou estado comercial nesta branch de organização |

---

## 8. Não verificado — o único lugar onde é permitido dizer "talvez"

- **Forma da API do GPT‑Live:** nada publicado (transporte, eventos, preço, SIP). Hedge: capabilities negociadas + commitment gate — política que sobrevive a qualquer forma.
- **Custo real por minuto e taxa de acerto do cache:** medidos só na Fase 2 (saída 4).
- **Limite de chamadas SIP simultâneas da OpenAI por tier:** não publicado. Somado ao PCP, é o furo de capacidade mais perigoso.
- **Codec do endpoint SIP (G.711 vs Opus):** impacto direto em ASR com sotaque e ruído de obra.
- **`<Play>` + `<Dial><Sip>` contra o conector OpenAI:** default da seção 5, teste da semana 1.
- **Códigos de encaminhamento por operadora (\*72 etc.):** só fórum; testar com chip real antes de escrever o roteiro de onboarding.
- **Lei californiana de disclosure de bot para voz:** perguntar a advogado; não presumir nem a obrigação nem a ausência.
- **Qualidade PT-BR de guardrails/PII prontos:** zero evidência; o corpus da Fase 4 responde.

---

**Uma linha:** o funcionário nasce em 4 semanas ligando para o chefe; tudo que não é a identidade dele — voz, telefonia, MCP, banco, auth, cobrança — já existe pronto e pago; e o único lugar do mundo onde o Ligou não pode ser substituído é exatamente o único lugar onde nós escrevemos código.
