# Célula Hermes — runbook

Uma célula por empresa. A célula não recebe credenciais de Google, Supabase, Twilio ou AWS. O único
credencial de raciocínio é o OAuth do provedor `openai-codex`, vinculado à assinatura ChatGPT. Não existe
`OPENAI_API_KEY` na configuração do Hermes. `HERMES_API_KEY` autentica apenas o tráfego local
controller→API server; não é credencial de modelo.

## Subir e autenticar

```bash
cd hermes-cell
cp .env.example .env  # TENANT_SLUG + HERMES_API_KEY interno
docker compose up -d
docker exec -it "ligou-cell-$TENANT_SLUG" hermes auth add openai-codex --type oauth --no-browser
TENANT_SLUG="$TENANT_SLUG" bash health-state.sh
```

O estado cognitivo fica em `hermes-cognitive:/opt/data`. O OAuth fica separadamente em
`hermes-model-auth:/root/.hermes`; nunca copie `auth.json` para `/opt/data` e nunca inclua o volume de auth
num backup cognitivo. `health-state.sh` consome o status bruto localmente e retorna somente estados
`ready/unavailable`, sem token, identidade ou detalhe do modelo.

Antes de subir ou empacotar:

```bash
node validate-config.mjs --root .. --json
```

Após o primeiro pull, fixe o digest imutável da imagem no Compose. O tag documentado é apenas o ponto de
partida para descobrir esse digest.

## Fronteira da consulta ao vivo

`consult_ligou_brain` não é uma ponte de texto livre. Realtime fornece somente um `topic` enumerado e um
`service_id` validado. O controller reconstrói contexto estruturado das regras efetivas, sem contato,
transcript, endereço, instruções do caller ou piso privado. Hermes devolve apenas um pequeno código de ação
JSON; o controller converte o código em orientação fixa. Prosa, campos extras, números e valores monetários
falham como `unavailable`.

## Backup/restore

Use `infra/backup.sh` e `infra/restore.sh`. O artefato cognitivo inclui memória, skills e sessões sob
`/opt/data`, mas exclui OAuth/model-auth e credenciais de negócio. Restore sempre valida o manifesto assinado,
checksum e conteúdo numa célula descartável antes de qualquer aplicação ao volume ativo.
