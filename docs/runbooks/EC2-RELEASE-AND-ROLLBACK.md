# Runbook futuro — EC2 release e rollback

Este documento é procedimento futuro de operador; não é evidência de EC2, Linux, systemd, `flock`, SSM ou release executado.

## Pré-condições

1. Autoridade explícita para o host e janela de manutenção; confirme tenant/ambiente e release anterior conhecido.
2. Artefato e manifesto assinados, commit esperado, imagem Hermes por digest aprovado e runtime compatível.
3. Host com diretório de deploy validado, `flock`, `systemctl`, espaço livre, service account restrita e backup anterior verificável.
4. Compatibilidade de banco: migrations são forward-only. Só é permitido rollback do app quando a versão anterior é compatível com o schema aditivo atual; nunca execute rollback destrutivo de banco automaticamente.

## Procedimento autorizado

1. Faça upload pelo canal aprovado e confira checksum/assinatura antes de extração.
2. Execute o ativador de release com `--artifact`, `--manifest` e `--commit` contra o diretório de deploy aprovado. O lock do host deve impedir uma segunda ativação concorrente.
3. O ativador deve extrair em staging, validar configuração e dependências, promover diretório imutável, trocar o link atômico e reiniciar o serviço.
4. Verifique a superfície responsável: link de release ativo, identidade no manifesto, serviço systemd e health do controller/Supabase/Hermes. Não aceite texto de shell isolado como prova.
5. Registre apenas IDs, checksums, estados e horários sanitizados.

## Limites de rollback

Falha de verificação, extração, dependência, restart, health ou identidade deve preservar/recuperar o release anterior conhecido. O rollback é concluído somente após a identidade do manifesto anterior, link ativo, restart e health voltarem a conferir. Falha do próprio rollback é terminal e requer intervenção; não repita tentativas concorrentes. Nunca substitua o rollback por mudança de migration, segredo ou imagem sem nova autorização e revisão.
