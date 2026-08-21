# Runbook local — identidades e credenciais

Este documento descreve contratos implementados e testados localmente. Não é prova de EC2, deploy ou login ativo.

## Tenant/Hermes

Toda operação exige `TENANT_ID` (UUID imutável) e `TENANT_SLUG` (rótulo vinculado). O registro travado usa o
UUID como chave. O slug não nomeia container, volumes, rede, regras, backup ou restore.

```bash
TENANT_ID=11111111-1111-4111-8111-111111111111 \
TENANT_SLUG=empresa-exemplo \
node hermes-cell/tenant-compose.mjs --print-runtime
```

Reutilizar o slug com outro UUID ou mudar o slug do UUID existente falha fechado. OAuth de modelo fica somente
no volume de auth daquele UUID e nunca entra no backup cognitivo.

## Calendar

Configure apenas o cliente OAuth da aplicação e a chave AES-GCM do conector nos gestores de segredo aprovados.
Não configure refresh token, service account, calendário gerenciado ou fallback fake no ambiente do controller.
O dono conecta a própria agenda pelo fluxo autenticado do painel.

Nenhum comando deste documento foi executado contra produção nesta fase.
