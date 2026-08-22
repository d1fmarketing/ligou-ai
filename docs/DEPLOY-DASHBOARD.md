# Deploy — landing + dashboard unificados (Vercel)

**URL:** https://client-nine-taupe-24.vercel.app · **Projeto Vercel:** `client` (`prj_lWeapZCZqtv32BlfHAuylDzqO20g`, team `team_Kt6PAU2cglJsc1PmybP6F5Oh`) · **Conta:** `d1fdmarketing-8096`

Um deploy só serve os dois:

- `/` — landing v9 (fonte `src/runtime/ligou-app9.jsx` → `bun run build` → `assets/js/ligou-app9.js`);
- `/dashboard/` — painel do cliente em modo remoto (login Supabase; sessões de voz via Edge Function `browser-session`, EC2 sem porta de entrada).

**A fonte de tudo é o branch `main` deste repositório** (desde 2026-09-01; antes estava dividida entre `codex/ligou-dashboard`, `codex/ligou-mvp` e `codex/v0.2-browser-pilot`, o que fez a copy aprovada em 22/08 não ir ao ar).

## Republicar

```bash
cd /Users/d1f/Desktop/Ligou.AI            # worktree do main
export LIGOU_PUBLIC_SUPABASE_URL=...        # valores públicos; ver dashboard/.env.local (fora do git)
export LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
bun run site:build                          # bun run check + build do dashboard + montagem em dist/client
cd dist/client && vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```

- `site:build` **não lê** `.env`/`.env.local` do Vite nem herda `VITE_*`/`SUPABASE_*` do shell (`scripts/production-env.mjs`). Só as quatro entradas públicas `LIGOU_PUBLIC_*` são mapeadas para `VITE_*`. Ausência de URL de funções falha fechada.
- `site:build` apaga e recria `dist/client/`, levando o `.vercel/project.json`. O relink funciona pelo nome da pasta `client`; para não haver ambiguidade recrie antes do deploy:
  `{"projectId":"prj_lWeapZCZqtv32BlfHAuylDzqO20g","orgId":"team_Kt6PAU2cglJsc1PmybP6F5Oh","projectName":"client"}`.
- Passe sempre `--token` (lido de `~/Library/Application Support/com.vercel.cli/auth.json`, campo `token`; confira `expiresAt`). Com token explícito o CLI nunca abre navegador. Se expirou, renove via `POST https://api.vercel.com/login/oauth/token` com `grant_type=refresh_token`, `client_id=cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp` e o `refreshToken` do mesmo arquivo.
- O projeto `client` **não tem git link**: push no GitHub nunca publica. Só este comando publica.
- Depois de editar `index.html`, `src/runtime/ligou-app9.jsx` ou qualquer arquivo pinado: `bun run build` e regenerar `docs/CLAUDE-V9-RUNTIME.sha256` (mesmos paths, hashes novos), senão `bun run check` quebra. `scripts/verify-claude-v9.mjs` também trava a premissa de marca (eyebrow "Agente operacional de inteligência artificial"; rótulo "assistente virtual" proibido).

## Prova de que foi ao ar

1. `curl -sI https://client-nine-taupe-24.vercel.app/dashboard/assets/index-<hash>.js` → `last-modified` recente;
2. o mesmo `index-<hash>.js` existe byte a byte em `dist/client/dashboard/assets/`;
3. `grep -c 'Agente operacional de inteligência artificial' <(curl -s https://client-nine-taupe-24.vercel.app/)` → 1.

## Notas

- `VITE_SESSION_URL` só é necessário se o botão de voz precisar apontar para outra base; hoje deriva da URL do Supabase.
- Cosmético conhecido: em produção o app dispara `POST http://127.0.0.1:8795/claim` (handshake do modo local, fire-and-forget) que o navegador bloqueia com `ERR_BLOCKED_BY_CLIENT`. Não afeta login nem voz.
- Domínio próprio depois: `vercel domains add <dominio>` e alias no projeto.
- Mapa do repositório: `docs/REPO-MAPA-2026-09-01.md`.
