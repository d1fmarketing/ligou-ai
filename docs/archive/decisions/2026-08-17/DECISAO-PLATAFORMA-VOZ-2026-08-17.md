# Decisão: plataforma de voz do Ligou

**Data:** 2026-08-17 · **Status:** ~~DECIDIDO~~ **SUPERSEDIDO no mesmo dia**

> **Por que caiu:** esta decisão otimizava o produto errado. Vapi/Retell/Bland são a
> categoria "secretária eletrônica com IA" — atende, anota, resume. O Ligou é o
> **funcionário contratado** (modelo de produto no `.impeccable.md`: memória do negócio,
> ferramentas via MCP, executar trabalho, perguntar ao dono, regra aprovada, ligações
> outbound operacionais, conversa contínua com o dono). RJ rejeitou: *"O que você tá
> querendo construir é uma secretária eletrônica. Não é o que eu quero construir."*
>
> **Arquitetura vigente:** agente no centro, sobre `openai-agents-js` — aprovação de tool
> nativa dentro da chamada de voz (`needsApproval` → `tool_approval_requested` →
> `approve()/reject()`, verificado no código-fonte do `RealtimeSession`), MCP nativo,
> mesmo agente em texto (WhatsApp/web) e voz (RealtimeAgent + Twilio SIP), outbound
> incluso. O documento vigente é
> [`DECISAO-FINAL-O-FUNCIONARIO-2026-08-17.md`](DECISAO-FINAL-O-FUNCIONARIO-2026-08-17.md).
>
> **O que sobrevive deste documento:** os dossiês e vereditos (evidências JSON ao lado)
> continuam válidos como mapa da categoria; a Vapi fica como fallback exclusivamente do
> canal telefônico se o caminho SIP emperrar; a regra de custo ("nunca speech-to-speech
> dentro de plataforma") e os números de telefonia continuam corretos.

---

## 1. A escolha

**Vencedora: Vapi (vapi.ai). Runner-up: ElevenLabs Agents.**

Vapi é a única finalista com os 4 claims load-bearing confirmados em fonte primária na verificação adversarial, zero "unclear" no checklist, e dois kill-risks derrubados como exagerados: (a) o modo HIPAA em 2026 **armazena** transcrições em storage compliant — não quebra o resumo WhatsApp como o recon temia; (b) o timeout duro de 7.5s é do `assistant-request`, não dos tool calls (que têm default 20s configurável). É o caminho mais rápido até a primeira chamada real para um time de uma pessoa, alugando tudo que não queremos construir.

Nenhum veredito adversarial derrubou finalista — os três saíram "viable". A ordem se manteve pelo critério dominante: Vapi (11/12 confirmados, turnkey), ElevenLabs (11/12, mas treina nos dados por padrão no self-serve e sem caminho Realtime), Twilio ConversationRelay (mais barato e menor lock-in, mas exige construir o loop LLM — mais que "só o authority plane", e o esforço "em dias" ficou **unproven**). Retell foi eliminada por falha confirmada: não existe desligar gravação de áudio mantendo transcrição.

**Twilio ConversationRelay é o fallback estrutural** se os gates da semana 1 da Vapi falharem (ver seção 7) — já temos a conta, e o custo é o menor da mesa.

---

## 2. Custo real em 400 min/mês

| | Vapi (vencedora) | ElevenLabs (runner-up) | OpenAI Realtime SIP cru (baseline) |
|---|---|---|---|
| Plataforma | $0.05/min = $20.00 | $0.08/min = $32.00 | $0 (sem fee) |
| Modelos (STT/LLM/TTS) | BYO keys, "at cost" — soma publicada dos provedores ~$0.06–0.08/min¹ | LLM nas nossas chaves (por token, não publicado/min) | ~$0.015–0.041/min (piso, pesquisa anterior²) |
| Telefonia (nossa Twilio) | $0.0085/min in = $3.40 | $0.0085/min in = $3.40 | $0.0034/min = $1.36 |
| Número | ~$1.15/mês | ~$1.15/mês | ~$1.15/mês |
| **Total 400 min** | **~$47–52/mês (~$0.12–0.13/min)** | **~$37/mês + LLM (não fecha sem medir)** | **~$9–19/mês (~$0.02–0.05/min)** |

¹ Aritmética verificada adversarialmente com preços publicados (Deepgram Nova-3 $0.0058/min, ElevenLabs TTS $0.05–0.10/min de áudio gerado, gpt-4o-mini por token com premissa nossa de tokens/min). É composição nossa, não número all-in publicado pela Vapi.
² Baseline de pesquisa anterior; a OpenAI publica por token, não por minuto — só piloto medido confirma.

**Margem:** contra o plano de $299/mês → ~$249/mês de margem bruta (~83%) na Vapi. Contra o excedente de $0.35/min → ~$0.22/min de margem. O guardrail de $0.20/min é respeitado com folga; o cenário de morte ($0.60/min) está a 5x de distância. **Regra dura herdada da pesquisa: nunca usar modelo speech-to-speech tipo gpt-realtime dentro de plataforma** ($0.345/min só de modelo mata até o excedente).

---

## 3. O que NÃO construímos

A Vapi cobre, com fonte primária confirmada:

- **Telefonia e media path** — import dos nossos números Twilio por SID+Auth Token, sem gate (docs.vapi.ai/phone-numbers/import-twilio)
- **Números US** — 5 grátis para teste; produção com números da nossa Twilio, ilimitado
- **STT/TTS/turn-taking/barge-in** — stopSpeakingPlan/startSpeakingPlan, smart endpointing
- **Troca de idioma EN/ES na mesma chamada** — transcriber multilíngue (Deepgram Nova-3 Multi) + idiomas listados no system prompt
- **Aviso legal verbatim** — `firstMessage` é string forçada (aceita até arquivo de áudio), não output do modelo; `firstMessageInterruptionsEnabled` default false
- **Warm transfer para o celular do dono** — transferPlan sobre Twilio
- **Outbound via API** — POST /call (o mecanismo do onboarding)
- **Transcrição + extração estruturada pós-chamada** — end-of-call-report com transcript completo + `analysisPlan` (summary + structuredData com schema nosso)
- **MCP nativo** — tools de MCP servers via Streamable HTTP durante a chamada
- **Concorrência** — 10 simultâneas inclusas, +$10/linha/mês

---

## 4. O que construímos

**Só o authority plane** — um webhook em Vercel/Cloudflare + Supabase (tudo já pago):

1. **Regras por tenant** — Supabase guarda as regras aprovadas pelo dono (horários, preços, o que pode agendar)
2. **Aprovar/negar síncrono** — toda ação sensível (agendar, falar preço) chega como tool call e só executa/fala com nossa resposta
3. **Memória** — histórico de cliente final e decisões por tenant
4. **Receipts** — log auditável de cada aprovação/negação
5. **Resumo WhatsApp em PT** — recebemos o end-of-call-report (transcript + structuredData), geramos o resumo com nossa chave Anthropic/OpenAI, enviamos via nossa Twilio

**O fluxo síncrono está confirmado em fonte primária:** o campo `async` dos custom tools tem default `false` — "If sync, the assistant will wait for your server to respond" — e o assistant espera o JSON `{"results": [{"toolCallId": "X", "result": "Y"}]}` antes de continuar. Timeout configurável, default 20s (docs.vapi.ai/tools/custom-tools + docs.vapi.ai/api-reference/assistants/create). Restrição real: cada 100ms nosso é silêncio na linha somado aos ~800ms de base da Vapi — o plane precisa responder em poucas centenas de ms, p95 medido com cold starts.

---

## 5. Plano de 2 semanas até a primeira chamada real

**Semana 1 — provar os gates**

- **D1:** conta Vapi, importar 1 número da nossa Twilio, criar assistant com `firstMessage` verbatim + `artifactPlan.recordingEnabled:false` + transcriptPlan on. **Chamada de teste GATE:** confirmar que transcrição e analysisPlan sobrevivem com gravação OFF (independentes por schema, mas sem frase verbatim nas docs).
- **D2–D3:** authority plane v1: endpoint de tool-calls em Vercel/Cloudflare, regras de 1 tenant no Supabase, approve/deny para agendar e preço. Medir p95 do plane com cold start.
- **D3–D4:** multilíngue: Deepgram Nova-3 Multi, idiomas listados no prompt, chamadas de teste EN e ES. Tuning de latência (waitSeconds, transcriber, modelo). **GATE: latência ponta-a-ponta aceitável ao ouvido** (base oficial é ~800ms, não os <500ms do marketing).
- **D5:** pipeline pós-chamada: end-of-call-report → resumo PT (nossa chave) → WhatsApp via Twilio. Email ao sales da Vapi: preço do ZDR add-on e opt-out contratual da cláusula de treinamento do ToS.

**Semana 2 — onboarding e chamada real**

- **D6–D8:** onboarding outbound em PT: assistant dedicado pt-BR, POST /call para o celular do dono, roteiro de entrevista, respostas gravadas como regras no Supabase via tool calls. Testar com o próprio RJ como "dono".
- **D8–D9:** warm transfer configurado; casos de borda — tool call que falha = agente NÃO age, fala fallback seguro.
- **D10:** primeira chamada real: cliente final liga no número, agente atende em EN, troca para ES se preciso, agenda via authority plane, dono recebe resumo em PT no WhatsApp. Medir custo real/min da chamada contra a tabela da seção 2.

**Se D1 ou D4 reprovarem:** ElevenLabs (record_voice=false mantendo transcript é confirmado lá). Se o problema for estrutural nas duas, Twilio ConversationRelay com spike de 1 semana — sem insistir além disso.

---

## 6. A válvula de migração

Quando a escala pedir OpenAI Realtime cru (custo ~$0.02–0.05/min vs ~$0.12–0.13):

**Sobrevive intacto:** os números (importados da NOSSA Twilio — saem junto), o authority plane inteiro (regras, memória, receipts, resumo WhatsApp — só o formato do payload muda), o Supabase, o Stripe, o conteúdo dos prompts.

**Se reescreve:** a orquestração que hoje alugamos — transferPlan (warm transfer), analysisPlan (summary/structuredData), firstMessage/turn-taking config, formato dos webhooks, e o media path telefônico (montar Twilio Media Streams ou ConversationRelay como ponte SIP). E perdemos o disclaimer garantido: OpenAI Realtime cru não tem primitivo de fala verbatim — o aviso legal viraria aproximação por prompt, um problema real a resolver na migração.

Lock-in moderado e consciente: pagamos ~$0.05/min de plataforma pela orquestração pronta; o que é nosso (números, dados, lógica de negócio) migra.

---

## 7. O que ficou unclear/unproven

- **Transcrição com gravação OFF:** independência clara por schema, sem confirmação verbatim nas docs. Chamada de teste D1 resolve. Se falhar → ElevenLabs.
- **Latência real:** FAQ oficial diz ~800ms; marketing diz <500ms; os "900–1200ms p95" de terceiros ficaram unproven (sem medição primária). Só a chamada de teste tunada responde.
- **ToS de treinamento:** a Vapi tem direito de usar conteúdo de chamadas para melhorar features, sem opt-out geral. ZDR existe como add-on, **preço não publicado** (relato de terceiro ~$1k/mês, não confirmado). Resposta do sales muda a conta — se ZDR for caro e o opt-out contratual não existir, o argumento de privacidade pende para ElevenLabs (ZRM per-agent self-serve) ou Twilio CR (prompt nunca sai do nosso servidor).
- **Qualidade PT-BR:** nenhuma plataforma da mesa publica benchmark. O onboarding em PT é o teste (D6).
- **Custo/min:** ~$0.12–0.13 é composição nossa de preços publicados com premissa de tokens/min minha, não número all-in da Vapi. D10 mede o real.
- **Baseline OpenAI Realtime ($0.015–0.041/min):** vem de pesquisa anterior; a OpenAI publica por token, e o custo real depende do acúmulo de contexto — só piloto medido confirma a válvula.