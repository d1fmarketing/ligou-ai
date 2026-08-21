# Runbook futuro — retenção de dados transitórios

Este artefato descreve uma instalação futura. O timer não foi copiado, habilitado ou executado em EC2, staging ou produção nesta release candidate.

O script `infra/retention.sh` chama somente a RPC service-role `purge_ephemeral_call_data`. O padrão preserva recibos, regras, decisões, resumos e auditoria; remove transcrições já resumidas conforme o cutoff e linhas transitórias expiradas de browser, telefone, OAuth, ofertas de horário e cotações sem oferta referenciando-as.

Para um ensaio autorizado em host descartável:

1. confira o commit, o arquivo de ambiente host-only e os cutoffs `LIGOU_TRANSCRIPT_RETENTION_DAYS` e `LIGOU_TRANSIENT_RETENTION_HOURS`;
2. copie `infra/systemd/ligou-retention.service` e `infra/systemd/ligou-retention.timer` para a área de staging do systemd, sem habilitar;
3. rode `systemd-analyze verify` nos dois arquivos e execute o service uma vez contra banco descartável;
4. valide os contadores sanitizados e confirme por leitura que somente linhas elegíveis sumiram;
5. habilite o timer apenas com autorização separada e registre o read-back de `systemctl list-timers`.

Falha da RPC, resposta malformada ou ausência da chave server-side termina com erro. Não substitua a chave service-role por chave anon/publishable e não imprima valores de credencial.
