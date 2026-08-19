# Dashboard publicado — Vercel (domínio temporário)

**URL:** https://client-nine-taupe-24.vercel.app
**Conta:** `d1fdmarketing-8096` (Vercel CLI já autenticado neste Mac)

O dashboard publicado é o **modo remoto**: login por link mágico (Supabase Auth) e sessões de voz
servidas pela EC2 através da Edge Function pública `browser-session` — a EC2 continua sem porta de entrada.

## Republicar após mudanças

```bash
cd /Users/d1f/Desktop/Ligou-MVP/dashboard
LIGOU_BASE=/ npm run build          # base na raiz do domínio
cp vercel.json dist/client/          # SPA rewrite + cache dos assets
cd dist/client && vercel deploy --prod --yes
```

## Notas

- `LIGOU_BASE=/` é obrigatório: o build padrão usa `/dashboard/` (para o site em OpenAI Sites) e
  quebraria os assets na raiz do Vercel.
- `VITE_SESSION_URL` (em `dashboard/.env.local`) aponta para a Edge Function; é o que faz o botão de
  voz falar com a EC2 em vez de `localhost`.
- Domínio próprio depois: `vercel domains add <dominio>` e alias no projeto.
