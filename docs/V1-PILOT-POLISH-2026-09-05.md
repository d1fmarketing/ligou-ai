# Ligou V1 — polimento e conversa comercial

Estado: implementado em cópia isolada, disponível para avaliação local. A validação humana de voz e a finalização jurídica continuam pendentes. A página principal não foi publicada nem substituída.

## Onde avaliar

- Prévia: http://127.0.0.1:4189/
- Antes/depois no mesmo tamanho: http://127.0.0.1:4189/output/piloto/comparacao.html
- Área comercial autenticada: http://127.0.0.1:4189/comercial/
- Referência anterior: http://127.0.0.1:4188/
- Original restaurado: http://127.0.0.1:4177/
- Termos e Privacidade: `/termos/` e `/privacidade/`, identificados como documentos para revisão.

## Preservação

A base desta implementação é `0950eb6` (responsividade consistente), em `codex/v1-pilot-complete`. Mantidos os itens 1–6 aprovados, incluindo a revisão do preço sem o espaço vazio rejeitado.

A pasta original `/Users/d1f/Desktop/Ligou.AI` continua em `7274a99`. Seus 18 arquivos alterados foram comparados novamente, byte a byte por SHA-256, com os arquivos restaurados do backup: todos iguais. Registro em `output/piloto/original-preserved.json`.

Backup externo: `/Users/d1f/Desktop/Ligou-Backups/website-v1-20260904T195547Z`. O recibo `verification.json` registra 596 arquivos, restauração comparada, Git bundle verificado e inspeção no navegador. O arquivo `working-tree.tar.gz` tem SHA-256 `23108116af497f18179e1db465f950a794d567b1b7e302b0b03623ac8b091e7d`. As três referências locais responderam HTTP 200 na entrega.

## Os 18 itens

| Item | Resultado |
|---|---|
| 1. Sobreposição da terceira fala | Preservada a correção aprovada, com horário abaixo e separação do cartão. |
| 2. Resumo PT no desktop | Preservados tamanho de texto e painel aprovados. |
| 3. Espaçamento da prova | Preservada a aproximação aprovada. |
| 4. Contraste das faixas | Preservado o contraste corrigido. Mensagem sobre preço agora diz “Usa preços aprovados”. |
| 5. Preço futuro | Preservada a revisão compacta aprovada; valores e condições mantidos. |
| 6. Numeração duplicada | Mantidos somente os números dos três cartões. |
| 7. Estado de aprovação | “Regras prontas para sua aprovação”, inclusive sem JavaScript. |
| 8. Funcionário além do telefone | Hero e seis capacidades explicam atendimento, clientes, agenda e controle. Tarefas delegadas e ligações a pedido estão marcadas “Em desenvolvimento”. |
| 9. Repetição de texto | Enxugados subtítulo, memória e início do piloto; narrativa e ordem preservadas. |
| 10. Imagens | WebP nos posters e personagem; dimensões, arte e arquivos originais preservados; imagens inferiores carregadas sob demanda. |
| 11. Fontes | 14 faces WOFF2 das mesmas famílias/pesos; acentos PT/EN/ES, contornos e métricas conferidos. |
| 12. Animação | Pausa/retomada, preferência persistida, suspensão fora da tela e em aba oculta, movimento reduzido. Não pausa o áudio da conversa. |
| 13. CTA de voz | Quatro CTAs abrem o mesmo módulo carregado sob demanda. Painel com legendas, microfone, medidor, minimizar/retomar e desligar. Serviço real conectado; conversa humana completa ainda não validada. |
| 14. Captura e repetição | Resposta espera transcrição persistida; silêncio não dispara pedidos repetitivos. Diagnóstico e escolha de microfone. Testes automáticos passaram; resultado acústico depende de teste humano. |
| 15. Desligamento e estado pendente | Desligamento confirmado separado de estado desconhecido; sessão antiga reconciliada como expirada com evidência e limite máximo do provedor. Recuperação de recibo terminal após TTL aplicada. Custos e lead preservados. |
| 16. Controles ilustrativos | Identificação explícita antes das duas cenas; exemplos não executam ações comerciais/operacionais. |
| 17. Rodapé/metadados | Destinos legais e metadados coerentes implementados. Documentos continuam para revisão: faltam responsável, jurisdição e contato de privacidade. Indexação continua bloqueada; domínio/publicação final não alterados. |
| 18. Sem JavaScript | FAQ nativa, capacidades, início, suporte e rodapé completados. Verificado no navegador com scripts desligados. |

Também corrigida a âncora de retorno à hero para manter o título abaixo do cabeçalho fixo. O desenho desktop continua consistente a partir de 1024 px.

## O que mudou na voz

Ash e `gpt-realtime-2.1` permanecem, com fallback existente. A diferença principal está na condução comercial e no ciclo de captura/resposta: VAD semântico com baixa pressa, interrupção permitida, saudação após conexão e resposta somente depois de uma fala transcrita e persistida. Não há evidência para atribuir melhoria de timbre ao modelo ou prometer que o problema acústico foi resolvido.

Fatos são salvos com identificadores de falas reais. Contato exige leitura de volta e confirmação; autorização de retorno é uma decisão separada e revogável. Demonstrações ficam fora do lead real. Resumo é uma projeção compacta dos fatos salvos; próximo passo é registrado nas palavras do visitante. Não há novo processamento textual pago nem execução automática de mensagem, ligação, agenda, cobrança ou ativação.

Uma confirmação de gravação perdida pode ocorrer depois de um commit no banco. Nesse caso a conversa encerra conservadoramente e bloqueia novas gravações, preservando o que pode ter sido salvo. Textos longos e caracteres suplementares não produzem JSON inválido no resumo.

Limites mantidos: cinco minutos, uma chamada simultânea, três sessões por visitante por dia e controle por rede, reserva diária de US$15, teto de US$1,50 por sessão limitado também pelo teto atual configurado. Entrada comercial desativável separadamente.

## Serviço implantado

Backend em checkout separado: `/Users/d1f/.codex/worktrees/ligou-website-v2-sales/Ligou.AI`.

- Commit final: `d033e1ffd4f024cd676bf2774a84ba3befde8341`.
- Bundle: 472.556 bytes; SHA-256 `7d488b15bc8127f28e1b293e6558372f0efc841849387f479338bd52bea57095`.
- Duas compilações independentes idênticas.
- SSM `f5b4b7d0-7ab6-4537-8504-c8732a9fa9a8`: Success; `ligou-sales` ativo, PID920530, zero reinícios automáticos. Controlador original ativo no mesmo PID871573.
- Migrations aplicadas: `20260905023147_sales_provider_expiry_reconciliation.sql` e `20260905040618_sales_closed_receipt_recovery.sql`.
- Sessão antiga `21939bc2-4af1-493b-ba33-3a965ed8f2a4`: `ended/expired`. Custo observado US$0,091033 e reserva US$1,50 mantidos. Não foi tratada como encerramento com ACK do provedor.
- Recibo terminal consultado ao vivo após TTL: sem SDP, ID de provedor ou dados de lead. Registro em `output/piloto/live-closed-receipt.json`.

Nenhuma chamada estava ativa antes dos reinícios. O frontend principal não foi implantado. O dashboard existente só recebeu leitura e continua no serviço original.

## Verificação

- Landing e cliente de voz: 59 testes Bun / 193 assertions; integração comercial/proxy/build: 12 testes Node.
- Dashboard da base: 114 testes de estado/voz/interface e 6 testes do worker; build Vite passou. O log de testes contém “The build was canceled” após os subtestes, mas o runner terminou com 114 pass, zero fail/cancelled e exit0. O build separado completou normalmente. Permanece o aviso de bundle do dashboard maior que 500kB.
- Voz: runner completo dos 56 arquivos passou; suíte focada comercial final com 33 testes / 130 assertions passou.
- PostgreSQL16 descartável: 13 grupos de persistência + 10 de expiração + 12 de recibos = 35. Falha anterior reproduzida, depois correções aprovadas. Não equivale à execução de todas as migrations históricas do produto.
- Scanner de segredos e verificador de 83 arquivos fixados / 44 referências passaram.
- Build completo do site passou, incluindo comercial, páginas legais, dashboard, configuração pública e API comercial autossuficiente. Artefato local em `dist/pilot-review`; configuração privada do hosting ainda é necessária em eventual publicação. O adapter Vercel foi verificado em fixture, sem deploy Vercel ao vivo.
- Layout medido em 320, 390, 768, 1023, 1024, 1199, 1200, 1280, 1440 e 1920 px: sem overflow horizontal; números, textos de aprovação e capacidades futuras conferidos. Nenhuma simulação equivale a teste em aparelho físico.
- Navegador: pausa/retomada e suspensão de vídeo fora da tela; movimento reduzido; “Ver de novo”; FAQ com scripts desligados; painel de erro a390px; ciclo de teclado e Escape com retorno de foco.
- Microfone negado: rejeição real em iframe com política que bloqueia microfone, sem mudar permissões pessoais; mostrou orientação de permissão e tentativa novamente. Esse teste não abriu conversa com o provedor.
- Área comercial: login Google do proprietário verificado; lead/transcrição histórica real continuam visíveis. Ainda não há um novo lead completo decorrente da validação humana.

Imagens: 6.757.931 → 861.966 bytes (−87,2% somados); fontes: 1.521.744 → 323.100 bytes (−78,8%). Isso mede tamanho dos arquivos, não velocidade percebida ou Core Web Vitals. Os cinco vídeos estão byte a byte preservados. Detalhes em `output/otimizacao.md`.

## Pendências para aceite

1. RJ fazer uma conversa humana na prévia: qualificação, contato confirmado, objeção, próximo passo e desligamento; conferir o lead e autorização resultantes na área comercial. O teste foi solicitado, mas ainda não foi observado.
2. Informar responsável jurídico, estado/país e e-mail de privacidade, decidir a política de retenção e revisar/aprovar Termos e Privacidade. A implementação atual não aplica exclusão automática por prazo.
3. Aprovar visualmente a prévia. Publicar/substituir a página principal continua uma etapa posterior.

Capturas reais e comparação estão em `output/piloto/`. O estado de erro nos arquivos `qa-*` é intencional e serve apenas à verificação, sem ser apresentado como prova de voz humana.
