# Ligou — product brief em trabalho

**Status:** direção de produto; não é copy pública nem prova de implementação

**Data de consolidação:** 10 de agosto de 2026

**Responsável pela decisão final:** RJ

**Candidato visual atual:** Claude R2 sobre Visual 4, branch `codex/ligou-claude-r2`

Este documento registra a tese atual do Ligou sem promover intenção a funcionalidade
entregue. Ele complementa a copy V4, que continua `WORKING`, e não altera os snapshots
imutáveis do manifesto.

## Tese em uma frase

O Ligou é um **agente operacional para donos brasileiros de negócios nos Estados
Unidos**: o dono conversa e governa em português; o Ligou atende principalmente a dor
do inglês, consulta a memória daquele negócio e os sistemas conectados, usa ferramentas
autorizadas, executa dentro das regras e pede aprovação quando encontra uma decisão que
ainda não existe.

## O produto não é

- uma secretária eletrônica;
- um tradutor de ligações;
- uma ferramenta de resumo;
- um chatbot genérico;
- um robô que aprende tudo automaticamente;
- uma promessa de autonomia irrestrita.

Atendimento, tradução e resumo podem fazer parte da experiência, mas são resultados de
um agente que trabalha. **O idioma é a porta; o agente é o produto.**

## Público inicial

Dono brasileiro de empresa de serviços nos EUA, especialmente serviços residenciais e
equipes em campo. Ele trabalha com as mãos ocupadas, dirige entre clientes e recebe
ligações valiosas enquanto não pode atender. Controla o negócio em português e precisa
que a empresa opere profissionalmente com clientes americanos.

A visão pode servir a várias verticais. A primeira vertical ou o primeiro par de
verticais ainda não foi escolhido e deve ser tratado como decisão de MVP, não como fato.

## Estratégia de idiomas

- **Foco comercial inicial:** inglês, porque é a barreira mais clara para o público
  brasileiro nos EUA.
- **Capacidade pretendida:** atender em qualquer idioma suportado pela infraestrutura,
  inclusive espanhol e outros idiomas frequentes no mercado.
- **Interface do dono:** português para onboarding, perguntas, aprovações, revisão e
  novas instruções.
- **Regra de comunicação:** não diluir o foco do inglês numa promessa vaga de
  “multilíngue”, mas também não limitar o produto à expressão “agente bilíngue”.

Uma formulação pública definitiva ainda precisa ser aprovada. A intenção é comunicar
“inglês como prioridade, outros idiomas quando necessário” sem transformar idioma no
diferencial principal.

## Ciclo operacional

1. **Entrevista o dono** em português para compreender serviços, prioridades, limites,
   exceções e forma de trabalhar.
2. **Constrói memória operacional** específica daquele negócio.
3. **Consulta sistemas conectados**, como agenda e CRM, e usa somente ferramentas
   autorizadas. MCP faz parte da direção técnica de conexão, possivelmente ao lado de
   adaptadores próprios; não é uma promessa que a copy precisa explicar antes de os
   conectores existirem.
4. **Toma decisões e executa ações** dentro das regras e dos limites concedidos.
5. **Percebe conhecimento ausente** ou uma decisão que não pode tomar sozinho.
6. **Pergunta ao dono** em português, levando o contexto necessário.
7. **Aguarda aprovação**; uma resposta isolada não vira política silenciosamente.
8. **Incorpora a regra aprovada** à memória daquele negócio.
9. **Melhora continuamente** sem misturar memória, clientes ou regras entre empresas.

O sistema de memória precisa distinguir, no mínimo, fato da empresa, exceção de um
cliente, regra temporária, política por localização, sugestão pendente, regra aprovada
e regra revogada.

## Relação com o dono

O dono não recebe apenas uma notificação ou um resumo. Ele mantém contato direto com o
Ligou para:

- perguntar o que aconteceu numa ligação;
- entender por que uma decisão foi tomada;
- corrigir ou manter uma regra;
- dar novas instruções;
- autorizar uma ação;
- conversar por texto ou voz.

O app web faz parte da direção de lançamento. Apps nativos para iPhone e Android são
etapa posterior. Esses estados ainda exigem prova de produto antes de aparecerem como
disponibilidade pública.

## Ligações e ações

O telefone é o primeiro canal, não o limite do produto.

- **Entrada principal:** o Ligou recebe ligações, entende o pedido e opera dentro das
  regras.
- **Onboarding:** a direção prevê que o Ligou ligue para o dono e conduza a entrevista
  em português, reduzindo a sensação de configurar software.
- **Saída operacional:** o dono poderá pedir que o Ligou ligue para clientes com um
  objetivo e limites definidos, por exemplo para remarcar um serviço. Isso permanece
  roadmap até originação, custos, consentimento e controles estarem comprovados.
- **Sistemas:** agenda, CRM e outras ferramentas só podem ser descritos como usados
  quando estiverem realmente conectados e autorizados para aquele cliente.

## MVP recomendado, ainda não aprovado

Uma primeira versão estreita deve executar muito bem:

1. consultar regras aprovadas;
2. captar e qualificar o lead;
3. verificar disponibilidade;
4. agendar ou registrar pedido de retorno;
5. resumir, registrar e escalar quando necessário;
6. registrar a lacuna, perguntar ao dono e publicar somente a regra aprovada.

Autonomia ampla, CRM universal, múltiplos agentes especializados, follow-up complexo e
muitas integrações não devem entrar no MVP apenas para sustentar uma copy ambiciosa.

## Demonstração e aquisição

A demonstração telefônica é a prova central do produto:

`anúncio → ligação → conversa real → SMS autorizado → configuração/pagamento`

O visitante deve poder interromper, mudar de assunto e fazer uma pergunta inesperada.
A demo precisa usar tenant isolado, ferramentas sandbox, limites de duração/frequência
e memória separada. Esses controles são requisitos de lançamento; não estão comprovados
pelo frontend atual.

A v2.1 especificou como ponto de partida aproximadamente cinco minutos por chamada,
três chamadas por número a cada 24 horas e memória zerada entre sessões. Esses números
são uma proposta histórica de proteção, não configuração verificada.

O fluxo de ativação previsto é:

`reserva/pagamento → ligação de onboarding em português → conhecimento sugerido → revisão e aprovação → conexão de agenda/ferramentas → testes → aprovação do dono → entrada no ar`

O Visual 4 resume essa sequência como `Reserve → Converse → Aprove e coloque no ar`.

## Transparência e controle

- O Ligou se identifica como assistente virtual da empresa; não depende de fingir que é
  humano.
- Não inventa preço, política, disponibilidade ou ação executada.
- Uma integração desconectada nunca aparece como concluída.
- O dono define quando transferir, avisar, pedir aprovação ou concluir.
- Dados e memória de uma empresa nunca treinam silenciosamente o atendimento de outra.
- Gravação, consentimento, privacidade e ligações de saída exigem revisão jurídica e
  operacional antes do lançamento.

## Marca e linguagem

Elementos preservados:

- nome `Ligou`;
- headline `Ligou? Atendido.`;
- personagem Ligou como personificação do agente;
- petróleo, laranja de ação, verde de aprovação e fundo claro;
- português direto, sem jargão técnico na promessa principal;
- demonstração como CTA primário.

A página precisa explicar a consequência para o dono antes da arquitetura. Memória,
CRM, MCP e ferramentas entram como evidência de que o agente trabalha — não como uma
lista de buzzwords.

## Oferta comercial: estado atual e conflito aberto

O candidato Visual 4 mostra:

- preço oficial de `$499/mês`;
- primeiros 25 a `$299/mês` enquanto ativos;
- próximos 75 a `$299/mês` por 12 meses, depois `$499`;
- ativação de `$499` gratuita para os primeiros 100;
- 400 minutos mensais e `$0.35/min` excedente;
- mês a mês, sem fidelidade.

A conversa estratégica também propôs alternativas: Founding 100 a `$299` por 12
meses, ou uma abertura menor com Founding 10 e Early 25. RJ ainda não resolveu esse
conflito depois de ele ser explicitado. Portanto:

> **A estrutura 25/75/100 é o candidato implementado, não uma oferta congelada.**

Não publicar, criar inventário ou alterar a copy de preço sem uma decisão explícita.

## O que existe versus o que é direção

| Item | Estado em 10/08/2026 |
| --- | --- |
| Landing estática Claude R2 | V4 preservada com marca e hero do Claude; não publicada |
| Personagem e três poses | Assets aprovados no candidato V4 |
| Novo logo | A Linha aplicada ao candidato local; Brand Board V2 ainda não congelada |
| Número de demonstração | Não configurado |
| Checkout | Não configurado |
| Termos e Privacidade | Não configurados |
| Inventário Founding | Sem fonte operacional |
| Telefonia real | Não comprovada neste repositório |
| Memória operacional | Direção de produto; backend não comprovado |
| CRM, MCP e ferramentas | Condicionais à conexão; implementação não comprovada |
| App web por voz/texto | Direção de lançamento; não comprovado |
| iPhone e Android | Roadmap |
| Ligações operacionais de saída | Roadmap e dependente de controles |
| Atendimento em qualquer idioma | Direção; suporte real precisa ser validado |

Historicamente, `Ligou` foi tratado como produto público e `COMANDO` como motor por
trás dele. A documentação V4 não confirma se o nome `COMANDO` continua fazendo parte
da arquitetura. Não o reintroduzir em copy, código ou diagrama sem decisão de RJ.

## Decisões necessárias antes da próxima copy

1. Escolher a estrutura Founding e a capacidade real de onboarding.
2. Definir a primeira vertical ou manter uma validação explicitamente multivertical.
3. Confirmar quais capacidades existem no MVP e quais permanecem roadmap.
4. Aprovar a formulação “inglês primeiro, qualquer idioma” para a página.
5. Aprovar definitivamente a regra provisória: A Linha como marca corporativa e o
   emblema telefônico como badge do canal no personagem.
6. Definir o que a demo real pode executar com segurança.
7. Confirmar se `COMANDO` ainda é o nome do motor interno.
8. Definir quais conectores existem no dia um e quais ações são somente leitura ou
   podem escrever nos sistemas do cliente.
9. Só então criar e congelar a próxima fonte de copy.

## Fontes internas desta consolidação

- `.impeccable.md`;
- `docs/source/LIGOU-COPY-V2.1-FROZEN.md`;
- `docs/source/LIGOU-COPY-V3-WORKING.md`;
- `docs/source/LIGOU-COPY-V4-WORKING.md`;
- `docs/CHANGELOG-CLAUDE-R2.md`;
- `docs/CHANGELOG-VISUAL-4.md`;
- conversa ChatGPT `Landing Page Ligou`, id
  `6a7a0ab7-0450-83e8-b24e-99c8b7b8c2ae`;
- decisões posteriores de RJ registradas na sessão de 10 de agosto de 2026.
