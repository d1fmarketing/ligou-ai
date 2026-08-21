# Runbook futuro — verificação de backup e restore

Este é um procedimento futuro. Não registra backup real, restore Docker/Hermes, armazenamento de substituição ou volume de produção exercitados.

## Pré-condições

- Autoridade explícita, tenant UUID confirmado e janela de manutenção quando `--apply` for considerado.
- Imagem Hermes por digest aprovado, chave de manifesto disponível apenas no canal seguro e destino de backup tenant-scoped.
- Volume/auth do modelo separado do volume cognitivo. OAuth/model-auth e credenciais de negócio não podem entrar no artefato cognitivo.
- Destino descartável/replacement aprovado para teste; não use volume ativo para validar arquivo.

## Verificar backup

1. Gere ou receba arquivo e manifesto pelo canal aprovado; registre nomes e hashes, nunca valores de chave.
2. Verifique assinatura/autenticação do manifesto, hash do archive, tenant, source, imagem, versão/schema, tempo e lista de arquivos.
3. Rejeite antes de extração: path absoluto ou traversal, symlink/hard link/device, duplicata, path de auth proibido, raiz inesperada, manifesto ausente/modificado, limites de arquivo/tamanho e SQLite corrompido.
4. Importe somente em volume/célula descartável e isolado. Rode checks de memória, skills, sessões e health. Falha mantém o destino ativo intocado.

## Promoção controlada e recuperação

O padrão é verify-only. `--apply` só pode ocorrer após todas as validações descartáveis e lock por UUID do tenant. A promoção deve usar compare-and-swap/estado esperado para não sobrescrever restore concorrente. Se qualquer etapa falhar ou for interrompida, mantenha/restaure o volume cognitivo anterior, remova staging próprio e registre estado sanitizado. Se a recuperação falhar, trate como condição terminal, interrompa novas tentativas e escale com evidência sem segredo.

Após autorização para um exercício real, valide no destino substituto a identidade de tenant, integridade, ausência de auth no archive e health funcional; só então registre a evidência como integração externa. Não alegue recuperação de dados sem esse read-back.
