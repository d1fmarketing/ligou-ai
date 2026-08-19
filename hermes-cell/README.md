# Célula Hermes — runbook

Uma célula por empresa. Contida: zero credenciais de negócio; única credencial externa = chave OpenAI própria
(projeto separado com teto de gasto). Autoridade real vive no Supabase + controller.

## Subir (local ou EC2)

```bash
cd hermes-cell
cp .env.example .env   # preencha HERMES_API_KEY (gere: openssl rand -hex 24) e CELL_OPENAI_API_KEY
docker compose up -d
curl -s -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:8642/v1/models   # sanity
```

Após o primeiro pull, PINE O DIGEST no compose:
`docker inspect --format='{{index .RepoDigests 0}}' nousresearch/hermes-agent:v2026.8.18`

## Verificações obrigatórias no primeiro boot (config keys podem divergir entre releases)
1. Gates ativos: `/memory pending` responde; escrita direta fica staged.
2. Terminal/browser/web DESLIGADOS: pedir ao agente para rodar um comando deve falhar.
3. `X-Hermes-Session-Key: tenant:<slug>` isola memória entre chaves diferentes (testar com 2 chaves).
4. Nenhum volume compartilhado com outro container; porta 8642 só em loopback.

## Backup/restore (consistente com SQLite — plano §4)
```bash
docker exec ligou-cell-<slug> hermes backup /opt/data/backup.tar.gz   # ou sqlite3 .backup se o CLI não expuser
docker cp ligou-cell-<slug>:/opt/data/backup.tar.gz ./backups/<slug>-$(date +%F).tar.gz
sha256sum backups/<slug>-*.tar.gz > backups/checksums.txt
aws s3 cp backups/ s3://ligou-backups/<slug>/ --recursive   # bucket criptografado por tenant
```
Restore prova: memória + skills + sessões voltam num volume NOVO, sem restaurar credenciais antigas
(`.env` nunca entra no backup).
