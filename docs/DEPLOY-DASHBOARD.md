# Site unificado publicado — Vercel (domínio temporário)

**URL:** use o domínio configurado para o projeto Vercel.
**Conta:** use a sessão Vercel autorizada para o ambiente alvo.

Um deploy só serve os dois (2026-08-19):

- `/` — landing v9, display em **Familjen Grotesk** (contrato `.impeccable.md`)
- `/dashboard/` — painel do cliente em **modo remoto**: login Supabase e sessões de voz servidas
  pela EC2 através da Edge Function pública `browser-session` — a EC2 continua sem porta de entrada.

O acesso ao painel usa o link mágico padrão do Supabase. Não use fragmentos de URL,
senhas ou variáveis de build para contornar a autenticação.

## Republicar após mudanças

```bash
cd /caminho/para/Ligou.AI
bun run site:build          # check da landing + build do dashboard + montagem em dist/client
cd dist/${LIGOU_SITE_OUTPUT_DIR:-client} && vercel deploy --prod --yes
```

## Notas

- O build do dashboard usa o base padrão `/dashboard/` — `scripts/build-site.mjs` fixa `LIGOU_BASE`
  para nenhum override vazar do shell.
- `VITE_SESSION_URL` (em `dashboard/.env.local`) aponta para a Edge Function; é o que faz o botão de
  voz falar com a EC2 em vez de `localhost`.
- `LIGOU_SITE_OUTPUT_DIR` escolhe o diretório de artefato; mantenha `client` enquanto o projeto Vercel
  existente estiver configurado para esse caminho.
- Cosmético conhecido (pré-existente): em produção o app dispara `POST http://127.0.0.1:8795/claim`
  (aperto de mão do modo local, fire-and-forget) que o navegador bloqueia com
  `ERR_BLOCKED_BY_CLIENT`. Não afeta login nem voz.
- Domínio próprio depois: `vercel domains add <dominio>` e alias no projeto.
