# Runbook futuro — landing e dashboard unificados

Este documento descreve um deploy futuro. Nenhum comando de publicação, promoção para produção, domínio, sessão Vercel ou read-back público foi executado nesta fix wave.

O artefato local monta:

- `/` — landing v9;
- `/dashboard/` — painel do cliente com callback do link mágico na própria base `/dashboard/`.

## Build local isolado

O build de release não lê `.env`/`.env.local` do Vite e não herda variáveis `VITE_*` ou secrets `SUPABASE_*` do shell. Somente entradas públicas explícitas são mapeadas:

- `LIGOU_PUBLIC_SUPABASE_URL`;
- `LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY`;
- `LIGOU_PUBLIC_SUPABASE_FUNCTIONS_URL`;
- `LIGOU_PUBLIC_SESSION_URL`.

Valores permanecem em branco por padrão. A URL de Google Connect deriva de `LIGOU_PUBLIC_SUPABASE_URL` como `/functions/v1` ou usa a base exata `LIGOU_PUBLIC_SUPABASE_FUNCTIONS_URL`; ausência de ambas falha fechada.

Com valores públicos aprovados injetados pelo canal de build autorizado:

```bash
cd /caminho/para/Ligou.AI
bun run site:build
```

O resultado local fica em `dist/client`. Verifique landing, `/dashboard/`, assets, callback de sessão, login e console antes de criar um plano separado de publicação. Não trate esse build como URL publicada ou prova de voz/Google/EC2.
