# Agenda do cliente — contrato local V0.1

O único caminho de calendário do runtime é o conector OAuth cifrado do tenant.

1. O dono autenticado escolhe um tenant UUID explícito no painel.
2. O início OAuth vincula state, nonce, usuário, redirect e tenant.
3. O callback consome o state uma vez e cifra o refresh token com AES-GCM, usando
   tenant/provedor/conta/versão como AAD.
4. O controller lê somente ciphertext, IV, versão e referência de conta daquela linha de tenant.

Não existe fallback por calendário fake, calendário gerenciado, service account ou refresh token no ambiente
do processo. Ausência, erro, revogação, configuração incompleta ou falha de decriptação não autorizam escrita.

Os testes locais cobrem isolamento, decriptação, free/busy, idempotência e read-back. Este branch não foi
implantado, o fluxo não foi verificado ao vivo com Google e as migrations não foram aplicadas em Postgres real.
