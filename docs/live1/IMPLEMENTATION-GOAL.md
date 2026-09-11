GOAL: MIGRAR O LIGOU PARA GPT-LIVE-1 E AGENTS API, COM OPENAI GERENCIADA COMO PADRÃO

Execute no projeto existente: implementar, testar, publicar uma candidata interna e substituir os componentes próprios que a plataforma oficial cobre. Não entregue apenas outro plano, uma troca de nome de modelo ou um agente de QA ao lado da infraestrutura antiga.

A decisão de produto é: preferimos a infraestrutura gerenciada da OpenAI mesmo quando nossa implementação tem funcionalidades semelhantes. Queremos reduzir o que precisamos operar e manter. Preserve dados, regras, aprovações e experiência; não preserve infraestrutura por investimento passado.

Este é um goal de engenharia, não o prompt de runtime dos agentes.

1. Substituição explícita das decisões anteriores

Este goal substitui, neste escopo:

Client delegation como padrão para preservar o backend próprio ou a assinatura Codex.

A obrigação de manter processamento textual pela assinatura quando isso impede usar a execução gerenciada oficial.

A limitação da Agents API a um piloto opcional de QA.

A obrigação de conservar EC2, Hermes, supervisores, workers ou orquestração própria só porque já existem.

Travas de fala, espera por eventos antigos e pré-requisitos arbitrários de teste herdados dos goals anteriores.

A migração inclui APIs pagas de voz, raciocínio e agentes, dentro do projeto e da autorização de gastos vigente. Não trate essa direção como falta de autorização arquitetural. Ela não autoriza gastos ilimitados, novas assinaturas, criação de credenciais sem aprovação ou aumento de limites da conta.

Mantenha identidade, isolamento de empresas, autorização de operações, integridade dos dados, consentimento e custos observáveis. Preserve a exceção de orçamento já autorizada para QA humano interno; não restaure o bloqueio diário removido nem transforme essa exceção em isenção para toda produção.

2. Comece pelo código atual e pela documentação, sem outra investigação interminável

Identifique o worktree autoritativo, alterações locais, versões servidas e trabalhos ativos. Use o handoff e os comprovantes existentes. Não suponha que GitHub/main contém o trabalho mais recente nem reinicie a partir de um SHA antigo.

Consulte os guias oficiais de Live e Agents antes de implementar os contratos afetados, incluindo a referência/SDK realmente instalada. Confirme acesso do projeto aos recursos usados. Um anúncio não comprova que nossa integração funciona. Não invente endpoints ou preserve adaptadores de endpoints internos quando há um caminho público suportado.

Registre uma tabela curta no handoff existente: componente atual, responsabilidade, substituto oficial, ação e condição de retirada. Classifique cada componente relevante como substituir, simplificar, manter por necessidade concreta ou retirar após migração. Isso orienta a execução; não é um novo projeto de inventário.

Preserve resultados de website, drafts, histórico, aprovações e credenciais. Não recrawle sites nem substitua resultados selecionados para testar a migração. Use tentativas internas e cópias autorizadas dos dados existentes.

3. Arquitetura alvo: dois caminhos gerenciados, uma camada pequena de negócio

Conversa: dono/navegador ou cliente/telefonia → GPT-Live-1 → Responses delegation quando necessário → ferramentas autorizadas do Ligou → dados e integrações existentes.

Trabalho assíncrono: evento ou tarefa do Ligou → sessão da Agents API → execução gerenciada → resultado → validação e persistência necessárias no Ligou.

Live cuida da interação vocal. Responses delegation fica como padrão para raciocínio e seleção de ferramentas durante a conversa. Agents API assume a execução das tarefas assíncronas e multietapas migradas. Nossa camada restante autentica, delimita acesso, executa operações de negócio e conecta resultados ao produto.

Responses delegation e Agents API são produtos distintos. Não configure um ID de agente como se fosse um modelo de Responses nem presuma uma integração automática entre ambos. Uma tarefa pode acionar a Agents API por uma ferramenta quando houver necessidade real, mas não coloque outro agente entre cada fala e resposta.

Supabase/Auth/PostgreSQL e a interface continuam enquanto cumprem funções que essas APIs não substituem. A EC2 pode inicialmente hospedar as integrações restantes; ela não precisa ser mantida depois que deixar de ter uma função necessária. Não remova armazenamento ou administração ainda utilizados para alegar que tudo ficou na OpenAI.

4. Implemente GPT-Live-1 com Responses delegation

Use o protocolo Live documentado, não uma alteração de model no handler Realtime. Configure explicitamente o modo Responses e conecte as ferramentas de negócio existentes pelo caminho suportado. Deixe a OpenAI preparar o contexto conversacional da delegação e administrar o trabalho hospedado que esse modo oferece. [S1–S3]

Não recrie o preparador de contexto de client delegation, o loop de raciocínio ou o gerenciador de conexões delegadas apenas por hábito. Forneça estado de negócio relevante e atualizado pelo mecanismo documentado, sem despejar todo o histórico em cada operação.

Escolha um modelo OpenAI suportado para o backend, considerando a recomendação atual, acesso real, qualidade, latência e custo. Astra é uma opção para trabalho complexo, não uma obrigação para cada saudação. Comece com configuração simples; não construa roteamento multimodelo especulativo.

Implemente corretamente os eventos de delegação e o ciclo de ferramentas, resultados e continuação. Use a referência atual para identificar chamadas completas, correlacionar resultados e continuar sem duplicação. Não suponha que o resultado de uma função já retoma sozinho o backend ou que um evento terminal contém todos os dados intermediários. [S1]

Client delegation passa a ser exceção. Só a proponha para uma capacidade necessária não atendida pelo modo gerenciado, identificando o requisito, a limitação documentada e a menor alternativa. Não a selecione para preservar assinatura, código antigo ou uma preferência genérica por controle. Não crie aprovação prévia de cada frase como justificativa para essa exceção.

Os resultados das ferramentas devem conter apenas informações adequadas ao interlocutor. Na ligação de um consumidor, pisos privados de negociação ficam no servidor; no onboarding autenticado do dono, as permissões são diferentes. Não exponha primeiro um dado confidencial ao contexto vocal para tentar escondê-lo depois.

Mantenha voz nativa em streaming da abertura à despedida, com escuta durante a fala. Não use MP3, TTS separado, cache de respostas vocais, leitor de roteiro ou fiscal literal de frases. O cache interno de contexto do provedor não é o cache de voz rejeitado.

Separe um prompt vocal curto de instruções de negócio para o backend. Use português brasileiro natural no onboarding e inglês no atendimento ao consumidor. Avalie uma voz PT-BR suportada com áudio real; não prometa corrigir sotaque apenas mudando um campo.

5. Adapte os contratos sem transportar os defeitos antigos

Conteúdo e evidência. Salve valores e condições concretos, não apenas “pergunta respondida”. Preserve a distinção entre interpretação e transcrição. Adapte proveniência e correlação aos eventos reais do Live; não invente IDs do provedor nem espere um evento de ASR final do Realtime que não existe nesse caminho. [S3]

A antiga exigência universal de commit antes do ASR não se aplica automaticamente ao Live com delegação. Prove uma conversa full-duplex com gravação correta e oportuna, sem construir outra cadeia obrigatória de transcrição, interpretação adicional, roteiro e síntese externa.

Operações. Derive tenant, dono, sessão e escopo no servidor. Valide alvos, permissões e revisão pelos mecanismos existentes. Um novo ID de delegação não transforma uma repetição na autorização de uma nova operação. Preserve idempotência por operação e reconcilie resultados incertos antes de repetir efeitos.

Correções e cancelamento. Interromper a fala não significa necessariamente cancelar trabalho ou desfazer um commit. Trate alterações de intenção, tarefas superadas e cancelamento explícito, impedindo resultados antigos de modificar uma revisão nova. Não deixe o modelo afirmar que desfez uma ação sem prova.

Aprovação. Preserve aprovação explícita vinculada à revisão apresentada e à resposta real do dono. Adapte a evidência ao protocolo Live, sem reduzir consentimento a um booleano escrito pelo modelo e sem preservar uma espera por evento ausente. “Sim, mas...”, silêncio, confirmações anteriores e despedidas não aprovam automaticamente a configuração. Não reconstrua autorização de reprodução para cada frase.

Encerramento. Separe concluir o onboarding de parar a ligação. Conclusão normal exige revisão breve, correções, consentimento, despedida e fechamento técnico. “Quero encerrar agora” deve parar prontamente e preservar progresso incompleto; não force revisão ou aprovação para permitir desligar.

Siga o ciclo oficial de fechamento e a evidência disponível de finalização. Não confunda conexão fechada, tarefa concluída, áudio ouvido e aprovação. Stop deve funcionar durante falhas; a limpeza posterior não pode prender o usuário. [S3]

Mantenha as regressões reais: resposta de domingo não pode ser abandonada após falha de gravação; “deixar limites indefinidos” não gera perguntas infinitas; preço precisa corresponder ao serviço identificado e ao catálogo real; fuso já resolvido não exige nova pergunta. Não use os valores de exemplos de QA como defaults de clientes.

6. Migre trabalho real para a Agents API, não apenas um demonstrador

Use a Agents API gerenciada, não apenas Agents SDK executado por nós. Transfira para o serviço a execução do agente, a continuidade da sessão, compactação e coordenação de subagentes quando a tarefa precisar. Não envolva o serviço em outro harness próprio que repita essas responsabilidades. [S4–S6]

A primeira substituição funcional será o trabalho de análise estruturada de onboarding a partir de conteúdo já coletado, preservando o contrato de saída consumido pelo produto: fatos candidatos, condições, contradições e pendências. Use uma cópia do contexto existente para provar o caminho, sem nova coleta e sem sobrescrever o resultado aprovado ou selecionado.

Se essa função já tiver sido migrada quando começar, aproveite a implementação e avance para o próximo worker real de análise pós-chamada ou QA. Não invente um serviço desnecessário só para demonstrar a API. O objetivo é substituir uma responsabilidade existente e desconectar seu executor antigo do fluxo migrado.

Depois da validação, o ponto de entrada correspondente deve usar Agents API como caminho normal para novas execuções autorizadas. Não deixe a chamada gerenciada como opcional enquanto o supervisor antigo continua realizando o mesmo trabalho. Não inicie reprocessamento em massa nem habilite Discovery globalmente.

Use um agente sem sandbox quando a tarefa só precisar de contexto e ferramentas. Quando precisar executar código ou trabalhar com arquivos, prefira sandbox hospedado pela OpenAI. Ambiente próprio precisa de necessidade comprovada, como acesso privado ou software incompatível, não da mera existência de uma EC2. [S4]

Comece com um agente. Use subagentes nativos quando houver trabalho independente que justifique isso; não crie coordenador e especialistas por decoração. Não recrie comunicação ou gerência de subagentes já oferecida pelo serviço. [S6]

Associe tarefa interna, tenant, versão de entrada e sessão do provedor. Reutilize estado de jobs para registrar lançamento, andamento, resultado, falha e cancelamento. Use eventos e webhooks documentados, com verificação e deduplicação pertinentes; não mantenha um processo acordado apenas para sustentar um loop que a OpenAI já executa. [S5, S7]

O aplicativo ainda precisa iniciar trabalhos e executar suas funções externas. Não suponha que sessão durável substitui scheduler, autenticação ou confirmação de gravação. Perder o stream não autoriza criar outra missão: reconcilie a sessão existente. Cancelar a execução não prova rollback de um efeito externo.

Preserve ferramentas e adaptadores úteis do Ligou sem duplicá-los em outra camada. Um relatório pode ser salvo automaticamente como relatório; ele não aprova regras nem altera preços. A análise assíncrona não pode ser uma condição para falar ou desligar.

A equipe privada de Renan, incluindo Atria, Kai e Clio, não é parte desta migração do produto. Não altere suas identidades, memórias ou ambientes. O padrão gerenciado fica disponível para futuras tarefas dela, sem confundi-la com os agentes de clientes.

7. Preserve dados e reduza a superfície operacional

Para o fluxo migrado, mantenha em nossa aplicação os registros de negócio, autorizações, referências de sessões/tarefas e resultados necessários. Deixe o provedor administrar seu próprio histórico de execução; não replique todo evento cognitivo no PostgreSQL apenas porque é possível.

Não compartilhe sessões, workspaces ou credenciais entre empresas. Conteúdo de website e transcrições são dados não confiáveis, não instruções administrativas. Não entregue chave privilegiada do banco, acesso de deploy ou credenciais de infraestrutura a um agente de atendimento ou análise.

Aplique a política existente de retenção também a sessões, arquivos e artefatos criados no provedor. A documentação registra retenção de estado da Agents API até exclusão; confiança no provedor não substitui decidir o que enviar e excluir. Não habilite gravação persistente do Live indiscriminadamente. [S8]

Ao concluir cada substituição, retire do fluxo ativo o loop, adaptador ou processo redundante e atualize testes/configuração que o acionavam. Preserve uma release recuperável para rollback, não dois sistemas de produção indefinidamente.

Desative um serviço antigo apenas depois de verificar tarefas pendentes e dependentes restantes. Não desligue componentes ainda usados por outro fluxo. Se a EC2 ficar sem funções necessárias, entregue a evidência e a proposta de desativação segura; não destrua instâncias, volumes ou backups como limpeza automática.

8. Custos, credenciais e capacidade

Use os SDKs, autenticação e segredos já aprovados, cumprindo as confirmações de credenciais exigidas pelo ambiente. Nunca peça chave em texto, exponha segredos ou crie uma credencial sem autorização. Se houver uma decisão pendente de credencial, peça somente essa decisão, não reinicie a discussão arquitetural.

Registre separadamente custo de voz, backend Responses, Agents, ferramentas/ambientes e operadora quando aplicável. Não reutilize estimativas de audio tokens do Realtime como se fossem a contabilização do Live e não some snapshots cumulativos como incrementos. Não apresente API como uso gratuito da assinatura Codex. [S3, S9]

Compare custo por chamada ou tarefa concluída com manutenção operacional, não só preço por token. Não prometa que será mais barato ou infalível antes de medir. Use a configuração mais simples que entregue qualidade adequada.

Preserve os limites e exceções vigentes, sem inventar um novo teto que bloqueie o teste humano e sem remover proteções gerais. Se acesso, crédito ou quota do provedor impedirem o teste, informe o bloqueio preciso e preserve o trabalho concluído. Não gaste a verba em baterias repetitivas antes de Renan poder experimentar.

9. Execute em entregas curtas, com aceitação separada

Entrega A: Live gerenciado utilizável. Implemente o caminho Responses, rode regressões essenciais e um smoke real de navegador/provedor com ferramenta autorizada, commit, correção, continuação e Stop. Publique a candidata interna e disponibilize imediatamente o diagnóstico humano. Não espere terminar a migração de Agents para liberar a voz.

Entrega B: primeira substituição real pela Agents API. Na continuação, execute uma tarefa representativa com o provedor real, preserve sua saída, demonstre recuperação da observação sem nova missão e prove que o executor antigo não foi usado. Teste os efeitos locais de retry e isolamento pelos mecanismos existentes.

Entrega C: aceite e retirada do legado substituído. Complete a entrevista real com revisão, correção, consentimento e fechamento; valide a saída do worker no caminho consumidor; retire os componentes redundantes da execução normal. Liste as responsabilidades ainda próprias com sua razão concreta.

Use os testes e o browser internos existentes. Edge é último recurso em sessão isolada, nunca nas abas pessoais de Renan. Distingua simulações, teste de integração e áudio real. ASR correto não comprova sotaque; uma amostra sonora não comprova resposta útil.

Meça startup até fala inteligível/pergunta útil, resposta útil após a fala do dono, operação delegada, término e custo observado. Feedback humano vem depois de um caminho seguro e do smoke, não depois de três entrevistas completas, dezenas de inicializações ou p95 arbitrário.

A telefonia deve ter prova própria antes de migrar roteamento comercial. Não ative número, compre serviço nem faça chamada para cliente real para demonstrar o browser. Identifique o próximo passo SIP sem permitir que ele bloqueie o teste interno.

Faça mudanças no worktree e publique pelo processo existente, com versões coerentes entre frontend, Edge, controller e schema, endpoints corretos e rollback compatível. Execute gates pertinentes ao diff; migração de banco só por necessidade concreta. Não edite EC2 manualmente nem use essa tarefa para auditar tudo outra vez.

10. Checkpoints e definição de concluído

No primeiro checkpoint, retorne LIGOU_LIVE_MANAGED_READY_FOR_HUMAN_TEST com entrada funcional, tentativa preparada, versões, modo de delegação, modelos/voz efetivos, teste real, tempos, custo e limites conhecidos. Declare separadamente o progresso de Agents. Encerre essa execução para participação humana; não continue num loop enquanto espera.

Ao receber o feedback, continue o mesmo goal. A entrega Live não substitui a entrega Agents e não marca a migração inteira concluída. Um bloqueio específico de uma API não deve paralisar trabalho independente na outra.

No checkpoint Agents, retorne LIGOU_AGENTS_MANAGED_WORKFLOW_VERIFIED apenas com tarefa real executada, resultado usado pelo fluxo correspondente, IDs e custos, isolamento e recuperação verificados e executor substituído fora do caminho normal desse trabalho.

Só declare LIGOU_MANAGED_MIGRATION_ACCEPTED depois da aceitação completa de voz, da substituição funcional pela Agents API e da retirada do legado correspondente, com relatório curto: o que a OpenAI passou a operar, o que removemos, o que continua nosso e por quê, provas reais e lacunas restantes. Não declare todos os workers, a telefonia ou a infraestrutura inteira migrados se não foram testados.

O critério final não é “adicionamos mais uma API”. É: o Ligou funciona, a OpenAI opera as responsabilidades genéricas migradas e nós temos menos infraestrutura própria para manter.

Documentação oficial para conferir os contratos afetados

[S1] Live: delegação e ferramentas
https://developers.openai.com/api/docs/guides/live-delegation

[S2] Migração para Live
https://developers.openai.com/api/docs/guides/live-migration

[S3] Live: sessões, vozes, transcrições, uso e encerramento
https://developers.openai.com/api/docs/guides/live-conversations

[S4] Agents API: arquitetura e ambientes
https://developers.openai.com/api/docs/guides/agents-api/architecture

[S5] Agents API: execução e continuação de sessões
https://developers.openai.com/api/docs/guides/agents-api/sessions

[S6] Agents API: subagentes
https://developers.openai.com/api/docs/guides/agents-api/multi-agent

[S7] Agents API: funções e webhooks
https://developers.openai.com/api/docs/guides/agents-api/tools/functions
https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks

[S8] Controles de dados
https://developers.openai.com/api/docs/guides/your-data

[S9] Disponibilidade e cobrança da Agents API
https://openai.com/index/introducing-the-agents-api/

Consulte, a partir desses guias, a referência atual de configuração, transporte e SDK necessária ao código. Não use este texto como substituto da documentação técnica.