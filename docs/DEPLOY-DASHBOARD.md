# Site unificado publicado — Vercel (domínio temporário)

**URL:** https://client-nine-taupe-24.vercel.app
**Conta:** `d1fdmarketing-8096` (Vercel CLI já autenticado neste Mac)

Um deploy só serve os dois (2026-08-19):

- `/` — landing v9, display em **Familjen Grotesk** (contrato `.impeccable.md`)
- `/dashboard/` — painel do cliente em **modo remoto**: login Supabase e sessões de voz servidas
  pela EC2 através da Edge Function pública `browser-session` — a EC2 continua sem porta de entrada.

Links de teste antigos `https://client-nine-taupe-24.vercel.app/#k=…` continuam valendo: a landing
redireciona `#k=` para `/dashboard/#k=…` no carregamento da página.

## Republicar após mudanças

```bash
cd /Users/d1f/Desktop/Ligou-MVP
bun run site:build          # check da landing + build do dashboard + montagem em dist/client
cd dist/client && vercel deploy --prod --yes
```

## Notas

- O build do dashboard usa o base padrão `/dashboard/` — `scripts/build-site.mjs` fixa `LIGOU_BASE`
  para nenhum override vazar do shell.
- `VITE_SESSION_URL` (em `dashboard/.env.local`) aponta para a Edge Function; é o que faz o botão de
  voz falar com a EC2 em vez de `localhost`.
- A pasta de deploy precisa se chamar `client`: é o name-matching que religa ao projeto Vercel
  existente (e mantém o domínio estável).
- Cosmético conhecido (pré-existente): em produção o app dispara `POST http://127.0.0.1:8795/claim`
  (aperto de mão do modo local, fire-and-forget) que o navegador bloqueia com
  `ERR_BLOCKED_BY_CLIENT`. Não afeta login nem voz.
- Domínio próprio depois: `vercel domains add <dominio>` e alias no projeto.
