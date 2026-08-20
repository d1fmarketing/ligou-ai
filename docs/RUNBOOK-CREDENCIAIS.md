# Runbook — autorizações humanas e segredos de implantação

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
  copiar `~/.codex/auth.json` para `/root/.hermes/auth.json` dentro da célula. Esse caminho persiste somente no
  volume `hermes-model-auth`; nunca copiar para `/opt/data` nem para o volume cognitivo.

**Depois:** `TENANT_SLUG=... bash hermes-cell/health-state.sh` deve retornar somente
`{"ok":true,"provider":"openai-codex","auth":"ready","api":"ready"}`. O probe não imprime nem encaminha o token.

---

## 2. Google Calendar real

**Por quê:** o adapter Google usa OAuth por tenant, insert + read-back + `freeBusy`. Refresh token não entra no
Playground, chat, dashboard nem SSM em plaintext.

**Passo de operador, uma vez:** configurar o app Google (`GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, redirect exato da Edge Function) e fornecer a mesma chave AES-GCM base64 de 32
bytes como `CONNECTOR_TOKEN_ENCRYPTION_KEY` somente nos secrets da Edge Function e do controller.

**Passo do dono:** no dashboard, clicar **Conectar Google Calendar** e consentir no Google. O start autenticado
cria state curto ligado a tenant/user/redirect/nonce; o callback consome esse state uma vez e grava somente
ciphertext/IV/versão. Linha legada plaintext fica `reconnect_required` até reconexão explícita.

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
