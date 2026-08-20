# LIGOU — Infraestrutura decidida

**Data:** 18/08/2026 · **Status:** CANÔNICO após aprovação de RJ. Supersede `DECISAO-FINAL-O-FUNCIONARIO-2026-08-17.md` (parte de stack) e demove o pacote do Codex (worktree `ligou-architecture`) a **rulebook de segurança** — deixa de ser blueprint de plataforma.
**Princípio (decisão de RJ, 2026-08-17/18):** produtizar o padrão Melora/Molusco/Betano. Frota de células de agente single-tenant. Não construir plataforma antes de vender o agente.

---

## A decisão em uma tabela

| Camada | Escolha | Custo (por cliente, 400 min) | Por quê |
|---|---|---|---|
| **Modelo** | Frota de células: 1 container de agente completo e isolado por empresa | — | Padrão já provado 3× (Molusco, Melora, Betano). "Cell per tenant, host per batch" |
| **Infra** | AWS **EC2** desde o dia 1. Piloto: 1× `t3.xlarge` (4 vCPU/16 GB, ~$120/mês) hospeda 3–5 células em Docker | ~$25–40 | Decisão de RJ. Isolamento por container+volume+usuário; EC2 dedicada só como tier premium futuro |
| **Runtime da célula** | **Hermes Agent** como cérebro (decisão de RJ, 18/08) **+ VoiceEdge próprio** para o telefone (ver §2) | — | Self-improvement é o produto; Hermes não atende telefone nativamente, então a voz vive FORA da célula por arquitetura |
| **Idiomas do atendimento** | **EN + ES desde o dia 1** (decisão de RJ) — o `gpt-realtime` é nativamente multilíngue; controle por instructions com language-lock, nunca por auto-detecção solta | ~$0 | Não é limitação técnica; era só escopo de eval herdado do Codex. Casos ES entram no conjunto de testes |
| **Voz** | OpenAI **`gpt-realtime-2.1`** via SIP, atrás de adaptador trocável | ~$14–16 | GPT-Live-1 NÃO tem API (verificado 18/08); quando sair, é troca de motor, não de carro |
| **Telefonia** | **Twilio** (SIP/Media Streams inbound) — **conta própria da Ligou a criar** (a conta existente é de outro projeto, só SMS) | ~$3.40 + $1.15/número | Decisão mantida por RJ mesmo sem conta ainda. Telnyx só se Twilio falhar no piloto |
| **Calendário** | Google Calendar: 1 secondary calendar por tenant sob usuário Workspace da Ligou (`scheduler@`), OAuth padrão, mapping server-side | ~$0 | Cliente NÃO precisa logar no Google pra começar. Modelo nunca vê `calendar_id` |
| **Banco do manager** | **Supabase** (já pago): auth do dashboard, billing, lista de tenants, health, casos de aprovação | ~$0 (já pago) | Encerra a guerra Supabase×RDS: estado do AGENTE vive NA célula (SQLite+arquivos); Supabase é só a camada de gestão |
| **Estado do agente** | Dentro da célula: SQLite + workspace do runtime, em volume **EBS criptografado** | incluído | O agente É o produto; o estado dele não sai da fronteira do tenant |
| **Backup** | Snapshot EBS diário + export da célula → **S3** por tenant (restaurável individualmente) | ~$1–2 | A EC2 pode morrer; o Ligou daquele cliente volta |
| **Secrets** | AWS Secrets Manager, um namespace por tenant | ~$1 | Credencial de um cliente nunca montada na célula de outro |
| **Dashboard** | Reaproveitar o protótipo React (branch `codex/ligou-dashboard`, 5.565 linhas, 16 testes) + Supabase auth + API do manager | — | O vocabulário de aprovação (aprovar 1×, virar regra, revogar) já está desenhado e testado |
| **Manager (backend próprio)** | TypeScript/Bun, FINO: provisionar célula, update, health, backup, billing, telefone/calendário. **Sem** AgentCore próprio, sem RLS multi-tenant, sem Temporal/DBOS/Step Functions | — | Só se constrói peça própria quando o framework provar numa situação real que não faz |
| **COGS total / margem** | — | **~$45–60 → margem ~80–85% em $299** | Guardrail: se COGS medido no piloto passar de $90/cliente, revisão de preço |

## 1. O rulebook (o que sobrevive do pacote Codex — vale DENTRO de cada célula)

Estes invariantes são inegociáveis, independente do runtime:

1. **Nunca misturar tenants** — célula, volume, secrets, banco, telefone e calendário próprios. Zero montagem cruzada, zero docker socket na célula.
2. **Modelo nunca vê ID/token bruto** — `calendar_id`, refresh tokens e SIDs vivem no manager; a célula recebe capabilities (`schedule_for_tenant`).
3. **Receipt tri-estado** — `accepted` só com decisão positiva + ID concreto; `failed` só com rejeição explícita; `unknown` em todo o resto, e `unknown` NUNCA reenvia (copiar literal `delivery.ts` do BUZZ, 82 linhas).
4. **Aprovação assíncrona** — fora de regra: fala determinístico ("a equipe confirma"), cria caso, nunca segura o cliente na linha. Dashboard é a ÚNICA autoridade; SMS/WhatsApp só notificam com deep link.
5. **Exceção pontual ≠ regra permanente** — virar regra exige confirmação reforçada e versionamento.
6. **Aprendizado ≠ autoridade** — self-improvement é feature (fatos, procedimentos, preferências); preço, policy, credencial, permissão e área NUNCA mudam por fala de caller nem por aprendizado automático.
7. **Sem áudio por padrão; transcript bruto 30 dias**; resumos/receipts/audit ficam.
8. **"Agendado" só existe com receipt** — o modelo nunca anuncia sucesso de algo pendente/desconhecido.

## 2. Runtime da célula — DECIDIDO POR RJ: Hermes + VoiceEdge próprio (18/08)

**Decisão final de RJ:** o cérebro da célula é o **Hermes Agent**. Como o Hermes não atende telefone em tempo real (doc oficial verbatim), a arquitetura é a que a própria verificação apontou como o cenário viável para o Hermes: **a voz vive FORA da célula** — VoiceEdge nosso: Twilio Media Streams/SIP → `gpt-realtime-2.1` → Hermes via API server OpenAI-compatível (`/v1/chat/completions` com `X-Hermes-Session-Key` para escopo de memória por tenant). O Hermes fica com o que ele faz melhor: memória, skills, self-improvement, MCP (Google Calendar), trabalho pós-chamada.

Registro histórico da verificação (7 agentes, fonte primária, mesma data) — fica como evidência, não como veto:

- **Hermes NÃO atende telefone**: doc oficial verbatim — *"It does not turn Hermes into a real-time inbound phone gateway"*; telefonia é outbound one-shot TTS ou delegação ao Bland.ai; feature request do adaptador Twilio Media Streams (#409) fechada sem código; a própria Nous manda usar Vapi/Bland para chamada ao vivo. A voz "Herald" da v0.20 é de dispositivo (mic/CLI/Discord), não de telefone.
- **OpenClaw ENTREGA o canal nº1**: plugin first-party `@openclaw/voice-call` (in-tree), Twilio/Telnyx/Plivo, **inbound** com política (allowlist/pairing/open), realtime **full-duplex com provider OpenAI e Gemini Live bundled**, verificação de assinatura de webhook, `sessionScope per-call` recomendado na doc para "reception, booking, IVR" — o caso Ligou em uma frase. Sem rótulo experimental.
- **Cell-per-tenant é a recomendação OFICIAL do OpenClaw** ("one cell per tenant"); no Hermes é só o que sobra de um multi-tenant estruturalmente quebrado (#34352 aberto sem resposta, #30585 perfis não isolados).
- **O trunfo do Hermes (learning gates) está quebrado nas próprias issues**: `memory/skills.write_approval` com default FALSE, `/memory approve` falhando com workaround oficial de DESLIGAR o gate (#47941), não-admin desligando gate global (#55147), bypass por shell admitido em doc. O **Skill Workshop do OpenClaw** (agente propõe, humano aprova) é o encaixe mais literal do rulebook §1.6.
- **Realidade operacional**: 100% da frota de RJ em produção é OpenClaw (Molusco, Melora, Betano vivo em VPS); OpenClaw 2026.7.1 instalado e ativo neste Mac; Hermes 0.15.1 dormante desde jun/2026. Existe `openclaw migrate hermes` (memórias+skills) — a porta não se fecha.

### Condições vinculantes da escolha Hermes (riscos precificados)

1. **VoiceEdge é peça nossa e crítica (semana 1–2, bloqueante):** ponte Twilio→`gpt-realtime-2.1`→Hermes, com language-lock EN/ES nas instructions, receipt tri-estado nas tools e latência p95 de turno < ~1.5s medida em ligação real. A primeira ligação real É o teste de aceite. Risco monitorado: continuidade de sessão do API server do Hermes (issue #4507).
2. **Gates de aprovação do Hermes são conveniência, não fronteira:** `memory.write_approval` e `skills.write_approval` LIGADOS na config, mas com os bugs conhecidos (#47941 approve quebrado, #55147 não-admin desliga gate, bypass por shell admitido em doc) a garantia real é externa: preço/policy em mount read-only, credenciais fora da célula (Secrets Manager), aprovação só no dashboard do dono.
3. **Célula = container Docker single-tenant** (postura oficialmente suportada pelo Hermes: "separate agent instances"; multi-tenant intra-processo é quebrado — #34352/#30585 — e NUNCA será usado).
4. **Cadência de update:** projeto 0.x com ~3.650 commits/minor e regressões P1 — pin de versão por célula, update quinzenal testado em célula-canário antes da frota.
5. **Cérebro a preço de API OpenAI** (o VoiceEdge já é OpenAI; manter um provider primário simplifica custo e eval).
6. **Skills executam Python arbitrário no import:** skill nova criada pelo agente só ativa após revisão (staged em `pending/`), e a célula roda com filesystem mínimo e egress allowlist.

OpenClaw fica como fallback documentado do cérebro (migração `hermes→openclaw` e vice-versa existem nos dois projetos); a decisão de RJ prevalece — self-improvement é o produto, e o telefone é resolvido por arquitetura, não pelo runtime.

## 3. Sequência de execução (sem mais rodada de planejamento)

| Semana | Entrega | Prova |
|---|---|---|
| **1** | EC2 no ar + 1ª célula provisionada (runtime do §2) + backup/restore testado | Célula morre e volta com memória intacta |
| **1–2** | Telefone: número Twilio → SIP → `gpt-realtime-2.1` → conversa em inglês com tools mock | 1ª ligação real atendida ponta a ponta |
| **2–3** | Calendar real (secondary por tenant) + Action Gateway mínimo com receipt tri-estado + caso de aprovação no dashboard | Agendamento fora-de-regra → aprovação → evento no Google com receipt |
| **3–4** | Onboarding: o Ligou LIGA para o dono e o entrevista em PT (1º trabalho do funcionário) + resumo pós-chamada em PT | Piloto privado com 1 empresa real de serviços residenciais |

**Definição de pronto do piloto:** 10 ligações reais atendidas, zero ação não autorizada, zero mistura de dados, COGS medido por ligação.

## 4. O que está explicitamente FORA (não rediscutir sem evidência nova)

Demo pública por telefone (fase 2) · outbound comercial genérico · Temporal/DBOS/Step Functions · AgentCore próprio · RDS/RLS multi-tenant · Model Gateway universal · EC2 por cliente · GPT-Live-1 (até API pública) · Vapi/Retell (categoria secretária — rejeitada por RJ) · gravação de áudio por padrão.
