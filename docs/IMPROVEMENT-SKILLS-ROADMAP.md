# Ligou — roadmap de skills para melhorar a landing page

## Recomendação curta

Para este projeto, a sequência de maior retorno é:

1. `impeccable` para registrar o contexto de design;
2. `critique` + captura inicial de `audit` e `optimize` para diagnosticar e medir o baseline sem editá-lo;
3. `frontend-design` para explorar no máximo duas direções em 390 px e 1440 px;
4. escolha explícita de RJ antes de qualquer CSS de produção;
5. `layout` e depois `typeset` para implementar a intervenção indicada pela crítica;
6. `adapt` para intervalos, contextos e casos extremos;
7. `harden` e depois `optimize` para robustez e performance;
8. `polish` para acabamento;
9. `audit` final para corrigir P0/P1 e revalidar a versão candidata.

O Mobbin entra inicialmente em `critique` e `layout`. Os screenshots exemplificam composição; não comprovam conversão, tipografia, performance ou comportamento responsivo.

## 1. Skills prioritárias

| Fase | Skill | Como ajuda o Ligou | Entregável esperado |
| --- | --- | --- | --- |
| 0 — contexto | `impeccable` | Evita inferir personalidade ou qualidade desejada a partir da implementação atual | `.impeccable.md` explícito e aprovado por RJ |
| 1 — crítica | `critique` | Avalia hierarquia, clareza, carga cognitiva, confiança e diferenciação sem editar | manter, mudar, remover e experimentar, com prioridades |
| 1 — baseline técnico | `audit` | Registra a condição acessível e responsiva antes das mudanças | relatório local P0–P3 do baseline |
| 1 — baseline de performance | `optimize` | Mede antes de presumir que um site estático já é rápido | métricas e orçamento inicial de performance |
| 2 — direções | `frontend-design` | Explora linguagem própria ligada a atendimento e serviços residenciais | até duas direções em 390 px e 1440 px, sem CSS de produção |
| 3 — composição | `layout` | Implementa a direção escolhida com ritmo, primeira dobra e largura de leitura coerentes | estrutura responsiva da intervenção aprovada |
| 3 — leitura | `typeset` | Faz a copy longa ganhar hierarquia sem escondê-la em mais cards | escala, medida de linha, pesos e pares tipográficos validados em PT-BR |
| 4 — adaptação | `adapt` | Trata intervalos, uso com uma mão, touch targets, textos longos e casos extremos | comportamento contextual entre breakpoints |
| 5 — robustez | `harden` | Testa configuração ausente, integração falha, conteúdo extremo e estados reais | interface resistente a cenários de produção |
| 5 — performance | `optimize` | Ajusta ativos e execução depois das mudanças estruturais | orçamento atingido ou desvios documentados |
| 6 — acabamento | `polish` | Corrige alinhamento, espaçamento e consistência quando estrutura e ativos já estão estáveis | passe final de qualidade visual |
| 7 — reauditoria | `audit` | Compara a candidata com o baseline e procura regressões | P0/P1 corrigidos e relatório final local/staging |

### Apoio contínuo

`browser:control-in-app-browser` é a superfície de validação durante todo o processo: desktop, mobile, teclado, zoom e estados reais. Ela permite verificar decisões, mas não substitui contexto nem crítica.

### Skills condicionais

- `colorize`: usar somente se a crítica encontrar um problema concreto na hierarquia entre ação, sinal e aprovação.
- `delight`: usar somente depois de confiança, conversão, robustez e performance; microinterações não podem competir com a demo.
- `product-design:audit`: usar quando existir o fluxo completo demo → SMS → checkout → onboarding. Para a landing isolada, ainda é prematura.

## 2. Contexto obrigatório antes do redesign

O `impeccable` exige contexto explícito antes do trabalho visual. Já sabemos:

- público: donos brasileiros de serviços residenciais nos EUA;
- caso principal: atender clientes em inglês e devolver controle em português;
- ação principal: ligar para a demo;
- ação secundária: contratar;
- limite de confiança: nenhuma atividade, prova ou cliente fabricado.

Ainda precisamos registrar com RJ:

1. três palavras de personalidade e a emoção que o Ligou deve provocar;
2. referências e anti-referências, com o motivo de cada escolha;
3. contexto mobile real — onde, quando e com qual urgência o dono acessa a página;
4. restrições de acessibilidade e qualidade que não podem regredir;
5. o que deve permanecer, pode mudar ou deve desaparecer do baseline;
6. ativos de marca existentes e limitações técnicas ou comerciais.

Mobbin e a estética atual não preencherão essas decisões por inferência. As respostas devem ser registradas em `.impeccable.md` e confirmadas por RJ.

## 3. Como o Mobbin entra

O primeiro levantamento está documentado em [`MOBBIN-REFERENCE-LOG.md`](MOBBIN-REFERENCE-LOG.md). Cada entrada separa:

- o que foi realmente observado;
- o que pode ser transferido como padrão composicional;
- o que o screenshot não prova;
- qual hipótese ainda precisa ser testada no Ligou.

O levantamento atual não sustenta decisões de `typeset` ou `adapt`: não há evidência de fonte/licença/glifos PT-BR, performance ou pares equivalentes desktop/mobile. Depois do contexto de marca, devemos pesquisar referências adicionais de click-to-call, telefonia/voz, serviços de campo e conversão mobile.

## 4. Sequência prática

### Sessão 1 — ensinar o contexto

Responder às perguntas acima e criar `.impeccable.md`. Nenhum CSS muda.

### Sessão 2 — diagnosticar e medir o baseline

Executar `critique`, registrar auditoria técnica e capturar métricas de performance no preview ou staging equivalente. Entregável: problemas priorizados, qualidades a preservar e orçamento mensurável. Nenhum redesign é implementado.

### Sessão 3 — explorar e escolher

Usar `frontend-design` para produzir no máximo duas direções em wireframes/tokens, ambas vistas em 390 px e 1440 px. RJ escolhe explicitamente uma direção antes de produção.

### Sessão 4 — implementar a intervenção aprovada

Usar `layout` e depois `typeset`. A copy v2.1 permanece congelada; reconstrução total só acontece se a crítica demonstrar que ela é necessária.

### Sessão 5 — adaptar, endurecer e otimizar

Usar `adapt`, `harden` e `optimize`. Verificar intervalos entre 320 e 1440 px, uso por teclado, zoom, configuração incompleta, falhas de destino e rede móvel.

### Sessão 6 — acabamento e gate

Usar `polish` e então repetir `audit`. Corrigir P0/P1, comparar com o baseline e validar preview/staging equivalente. Inserir destinos reais somente quando disponíveis. Produção continua sujeita a autorização separada.

## 5. Critério de sucesso

A próxima versão visual será melhor se:

- a demo for inequivocamente a ação principal;
- “inglês entra → resumo em português sai → dono aprova” for entendido em segundos;
- a página parecer feita para esse dono, não uma landing genérica de AI;
- a leitura longa ganhar ritmo sem esconder informação relevante;
- mensalidade, ativação, minutos e excedente forem entendidos sem surpresa;
- 390 px e 1440 px já nascerem da mesma direção, e os intervalos forem deliberadamente adaptados;
- toda evidência for real, autorizada e verificável;
- o orçamento de performance definido no baseline for atingido ou tiver desvio explícito;
- não restarem problemas P0/P1 na reauditoria;
- a copy pública continuar fiel à v2.1.
