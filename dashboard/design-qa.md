# Dashboard Ligou — Design QA

## Fonte visual

- Referência aprovada: `/Users/d1f/.codex/generated_images/01a007b4-fde4-7233-94d3-60faebc66036/exec-779a40d7-b2ab-4609-ad60-bb483416347a.png`
- Dimensão original da referência: `853 × 1844`
- Estado comparado: rota `#ligou`, fixtures restauradas, duas aprovações pendentes
- Viewport de comparação: `430 × 932` CSS px
- Captura bruta da implementação: `516 × 1118` px em DPR `1.2`

## Evidências comparadas

- [Referência normalizada](qa/reference-430x932.png)
- [Implementação normalizada](qa/implementation-430x932.png)
- [Comparação completa lado a lado](qa/comparison-full-430x932.png)
- [Comparação focada na conversa](qa/comparison-conversation.png)
- [Comparação focada na aprovação](qa/comparison-approval.png)

As capturas foram abertas e julgadas juntas no mesmo tamanho. A implementação final preserva a hierarquia da referência: cabeçalho institucional, conversa operacional, cadeia causal `ligação → regra → decisão`, card de exceção, composer e navegação principal.

## Correções feitas durante a comparação

1. O primeiro passe tinha conversa e aprovação largas demais, avatar completo e pouca continuidade entre evento e decisão.
2. A implementação passou a usar o recorte canônico da cabeça do agente, larguras mobile medidas, trilho causal contínuo e o Agent Node canônico da Ligou.
3. Tipografia, posição dos balões, card de aprovação, botões contornados, composer e barra inferior foram ajustados contra a referência normalizada.
4. Os textos da cadeia causal foram reduzidos sem truncamento, mantendo os valores em até duas linhas.

## Resultado visual

- P0: nenhum.
- P1: nenhum.
- P2: nenhum.
- P3 aceito: o avatar canônico tem pequenas diferenças de renderização em relação ao robô da imagem conceitual; a implementação preserva o asset oficial em vez de criar uma imitação. A superfície web também é ligeiramente mais nítida que a arte de referência.

## QA funcional

- Navegação por hash entre Ligou, Memória e Aprovações: passou.
- Envio de mensagem e resposta determinística: passou.
- Fallback honesto do protótipo: passou.
- Painel `Voz · demo`, frases predefinidas e ausência de captura de microfone: passou.
- Aprovação somente para o caso: passou.
- Aprovação com criação de regra, escopo e duração: passou.
- Ajuste mantendo decisão pendente: passou.
- Recusa sem alterar a Memória: passou.
- Busca e filtros de Memória: passou.
- Edição com comparação antes/depois e incremento de versão: passou.
- Revogação com confirmação e recibo local: passou.
- Persistência após reload: passou.
- Reset dos fixtures: passou.
- Recuperação de armazenamento corrompido com aviso: passou.
- Diálogos com foco inicial, Escape e retorno de foco: passou.
- Preferência de movimento reduzido: passou.

## QA responsivo

- Viewports: `320 × 700`, `390 × 844`, `430 × 932`, `768 × 1024`, `1024 × 768` e `1440 × 1024`.
- Resize contínuo entre `320` e `1440` px.
- Sem overflow horizontal.
- Navegação inferior no mobile, rail compacto no tablet e sidebar + inspector no desktop.
- Conteúdo permanece alcançável em `320 × 700`, inclusive o card de aprovação acima do composer.
- Alvos interativos críticos com aproximadamente `44 × 44` px ou mais.
- Console sem erros ou warnings da aplicação.

## Gates técnicos

- Testes do gateway: `11/11` passaram.
- Build Vite: passou.
- Testes do empacotamento estático: `4/4` passaram.
- `git diff --check`: passou.

## Veredito

`final result: passed`
