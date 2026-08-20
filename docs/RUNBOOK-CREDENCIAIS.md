# Runbook — as 3 credenciais que faltam

Tudo do MVP está construído, testado e rodando na EC2. O que falta são **três autenticações que só o RJ pode
fazer** (conta pessoal / login humano). Cada uma leva ~2 minutos. Depois de cada uma, a Isa executa o resto.

Estado atual sem elas: a **voz funciona de verdade** (gpt-realtime, EC2, sem porta aberta). O cérebro responde
com fallback, o calendário usa o adapter fake (persistido, com read-back e busy real), e o dashboard roda no
preview local.

---

## 1. Cérebro do Hermes — assinatura ChatGPT (o mais importante)

**Por quê:** a célula precisa de um token Codex OAuth para raciocinar com `gpt-5.6-sol`. Regra do RJ:
**LLM usa assinatura, nunca API key.** Hoje `hermes auth status openai-codex` diz *"logged out"*.

**Decisão do RJ (escolher uma):**

- **(a) Login próprio da célula** — recomendado. Gera um token só da célula, sem tocar na conta pessoal do Mac.
  A instância **não tem chave SSH** (acesso é por SSM, mais seguro) — `ssh ligou` NÃO funciona. Use SSM:
  ```bash
  aws ssm start-session --target "$LIGOU_INSTANCE_ID" --region "$LIGOU_AWS_REGION"
  ```
  e, dentro do shell da EC2:
  ```bash
  sudo docker exec -it "ligou-cell-$TENANT_SLUG" hermes auth add openai-codex --type oauth --no-browser
  ```
  Ele imprime uma URL (`auth.openai.com/codex/device`) + código; abrir no browser e autorizar.
  **Ou peça à Isa** — ela dispara o fluxo pelo SSM e te entrega o link/código prontos.

- **(b) Reusar o token do Mac** — mais rápido, porém copia a credencial pessoal do RJ para o servidor:
  copiar `~/.codex/auth.json` → `/opt/ligou/hermes-auth/auth.json` na EC2 e montar no container.

**Depois:** `hermes auth status openai-codex` deve dizer *logged in*; a Isa reinicia a célula e roda a prova de
raciocínio (resumo PT + propostas) com o modelo real.

---

## 2. Google Calendar real

**Por quê:** o adapter do Google **já está escrito** (`voice-controller/src/calendar.ts`: insert + read-back +
freeBusy). Ele liga sozinho quando as 4 variáveis existirem — nenhum código novo é necessário.

**Passo (OAuth Playground, ~2 min):**
1. Abrir <https://developers.google.com/oauthplayground>
2. Engrenagem (canto sup. dir.) → marcar *Use your own OAuth credentials* → colar Client ID e Secret de um
   projeto Google Cloud com a **Calendar API** ativada
3. Selecionar o scope `https://www.googleapis.com/auth/calendar` → *Authorize APIs* → logar com a conta dona da
   agenda → *Exchange authorization code for tokens*
4. Copiar o **refresh token**

**Entregar à Isa:** Client ID, Client Secret, refresh token e o `calendar_id` (ex.: `primary` ou o ID de um
calendário secundário criado pra Rocha Plumbing). Ela grava no SSM (`/ligou/GOOGLE_*`), redeploya e roda o teste
de agendamento real com read-back + prova de não-duplicação.

---

## 3. Dashboard no site público

**Por quê:** o build está pronto e testado (Sites 4/4, commit `dc10d48` em `Ligou.AI-Sites`), apontando para a
Edge Function pública — só falta publicar. O pipeline é Cloudflare Workers e exige login humano.

**Passo:**
```bash
cd "/Users/d1f/Desktop/Ligou.AI-Sites" && npx wrangler login
```

**Depois:** a Isa publica e devolve a URL pública do dashboard.

---

## Ordem sugerida

**1 → 3 → 2.** O cérebro é o que muda o produto de verdade; publicar o dashboard é um comando; o calendário é o
que exige mais cliques (projeto no Google Cloud) e o fake já prova toda a lógica de agendamento enquanto isso.
