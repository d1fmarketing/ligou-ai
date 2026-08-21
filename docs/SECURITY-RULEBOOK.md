# Regra de segurança V0.1

## Autoridade e isolamento

- A autoridade é determinística e avaliada pelo servidor/banco antes de efeitos. UUID imutável define o tenant; dados, container, volumes, regras, backup e restore são tenant-scoped.
- RLS, grants explícitos e RPCs de serviço limitam a autoridade. Leitura desconhecida não autoriza escrita; incerteza de provedor permanece em reconciliação ou revisão manual.
- Regras e poderes efetivos usam epochs; booking revalida a autoridade no limite do efeito.
- Reservas e liquidação de budget são atômicas/idempotentes e preservam receipts exatos.

## Conectores, histórico e modelo

- Tokens de conector são criptografados com binding tenant/provedor; a rota de texto claro é recusada e requer migração explícita.
- O histórico de contato usa HMAC e falha fechado quando a chave, formato ou prova não é válido.
- Hermes só recebe contexto estruturado construído pelo servidor e só devolve ações JSON fechadas. Não há resposta livre, preço privado, transcrição, contato ou instrução do caller atravessando essa fronteira.
- OAuth do modelo fica em volume separado do estado cognitivo e nunca entra no artefato de backup cognitivo.

## Integridade operacional

- Backups exigem manifesto autenticado, hash de arquivo, identidade de tenant e validação integral antes de extrair/aplicar. O modo padrão é verificar; apply promove apenas após checks descartáveis.
- Releases usam pacote e manifesto assinados, imagem Hermes por digest, diretórios imutáveis, ativação atômica e lock de host. Migrações são somente forward; rollback do app depende de compatibilidade com schema aditivo e não desfaz banco automaticamente.
- O scanner de segredos opera em arquivos rastreados e mascara achados. Nomes de secret podem constar em documentação; valores, URLs privadas, IDs operacionais e credenciais não.

Esta regra descreve código implementado e testes locais/isolados. Não confirma configuração remota, deploy ou rotação de segredo.
