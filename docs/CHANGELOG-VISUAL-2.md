# Ligou — visual 2

**Data:** 10 de agosto de 2026
**Mandato de RJ:** *"Eu quero manter a base que já está e melhorar. Eu não quero refazer."*
**Contrato de design:** [`../.impeccable.md`](../.impeccable.md)

Esta rodada é cirúrgica sobre o visual 1. Nada foi reconstruído do zero.

## Congelado por decisão de RJ

- A dobra `Ligou? Atendido.` com a barra física do telefone.
- O visual EN → PT.
- A paleta azul-petróleo + laranja.
- A copy pública v2.1. Texto novo não foi escrito; houve apenas reuso de copy já aprovada.

## O que mudou

### 1. Robustez — conteúdo não depende mais de callback

O visual 1 mantinha 26 blocos em `opacity: 0` esperando o `IntersectionObserver`. Como o
observer não dispara com a aba oculta ou suspensa, a página podia ficar **em branco** — o
que foi observado em QA, não deduzido.

O sistema agora tem três caminhos independentes, e qualquer um basta:

| Caminho | Cobre |
| --- | --- |
| `IntersectionObserver` | rolagem normal, com o efeito escalonado |
| Varredura por rolagem, limitada a um quadro | teclado e qualquer rolagem, sem depender de evento de foco |
| Varredura na carga, por tempo, em `visibilitychange` e `pageshow` | aba suspensa, retorno por bfcache |

Resultado: a animação só pode **adiar** o conteúdo, nunca escondê-lo.

### 2. Barra de ação fixa no celular

A página continua longa por decisão de produto. O preço dessa decisão é que a demo
precisa estar sempre a um toque. A dock aparece quando o hero sai da tela e se retira
quando o bloco de preço entra, para não competir com o checkout. Fora da tela ela é
`inert`, então não entra na ordem de tabulação. O CTA do topo se apaga enquanto a dock
está visível — o mesmo botão duas vezes na mesma tela é ruído, não reforço.

### 3. Disciplina de cor

O laranja aparecia em cerca de 25 pontos, incluindo cinco headlines gigantes, um cartão
de 400 px e três sombras de 10–14 px. Acento só funciona porque é raro.

- **Manchas grandes de laranja:** três, todas de ação — a assinatura do hero, o botão da
  demo e o checkout. Mais a dock, que é a mesma ação.
- **Ênfase de headline:** por tom, não por acento. A primeira oração recua, a segunda fica cheia.
- **Sombra dura:** continua sendo a assinatura estrutural da página. O que saiu foi a cor
  dela — agora é sempre neutra.
- **Verde ganhou significado:** garantia. `Ele não inventa.` virou banda verde-escura, e os
  dois passos travados por regra do dono são marcados em verde na linha do tempo.

### 4. Tipografia

| Papel | Antes | Agora | Por quê |
| --- | --- | --- | --- |
| Display | Familjen Grotesk | Familjen Grotesk | assinatura preservada |
| Corpo | Instrument Sans | **Archivo** | grotesca funcional para texto denso; a anterior é default de modelo |
| Dado | IBM Plex Mono | **Martian Mono** | idem, e a nova tem cor melhor em número curto |

A mudança maior não foi trocar a mono — foi **reduzir o uso dela**. Monoespaçado como
atalho para "parece técnico" é ruído. Agora ela vive só onde há dado de máquina: telefone,
duração da chamada e índices. Rótulo editorial virou caixa-alta em Archivo com tracking.

### 5. Composição

- **`O que ele faz numa ligação`:** a grade 2×4 de itens idênticos com ✓ virou linha do
  tempo vertical. Os oito itens sempre foram a ligação em ordem cronológica; grade não tem
  direção, e por isso escondia isso. Resolve o celular de graça, porque timeline já nasce
  em coluna única.
- **`Ele não inventa`:** saiu de coluna lateral fixa para banda horizontal de três partes,
  quebrando o padrão "texto à esquerda, objeto à direita" que se repetia em toda seção.
- **Ritmo vertical:** as seções tinham todas ~130 px de respiro. Agora alternam entre
  `--band-open` (argumento) e `--band-tight` (mecânica).

### 6. Honestidade de interface

O mockup de notificação ganhou rótulo **visível** `EXEMPLO DE LIGAÇÃO`, no mesmo padrão do
hero. O `aria-label` que já existia serve leitor de tela, mas não resolve a ambiguidade
para quem enxerga a tela.

### 7. Anti-padrões removidos

Três `border-left` coloridos com mais de 1 px — o tell visual mais reconhecível de
interface gerada por IA. Substituídos por estruturas diferentes, não por variações do
mesmo truque: fios acima e abaixo na citação, bloco com fundo na fala em inglês, e
simplesmente nada na legenda da demo.

## Verificações desta rodada

Feitas no preview local, em `1440`, `1024`, `768`, `390` e `320` px:

- **Contraste:** 208 elementos de texto medidos com composição alfa correta — zero falhas AA.
- **Overflow horizontal:** zero em todas as larguras.
- **Alvos de toque:** nenhum abaixo de 44 px.
- **Semântica:** um `h1`, nenhum id duplicado, nenhum `aria-labelledby` órfão, nenhum
  controle sem rótulo acessível.
- **Sem JavaScript:** os 27 blocos aparecem normalmente.
- **Rede de segurança da revelação:** reproduzida a falha original e confirmada a
  recuperação por `visibilitychange` e por varredura de rolagem.
- **Dock:** oculta no topo, presente no miolo, recolhida no preço e no rodapé; número não
  trunca a 320 px.
- **Copy v2.1:** conferida linha a linha contra a fonte congelada.

### O que esta rodada NÃO verificou

- **Caminho de foco por teclado real.** O painel de navegador usado não tem foco do
  sistema (`document.hasFocus() === false`), então o navegador não dispara `focusin` nem
  rola no foco. A varredura por rolagem foi adicionada justamente para que esse caminho
  não dependa de evento — mas ele precisa ser testado com Tab de verdade.
- **`prefers-reduced-motion`.** A regra existe no CSS e desliga a revelação por completo,
  porém não foi exercitada com a preferência ligada no sistema.
- **Core Web Vitals e peso em rede móvel.** Duas famílias tipográficas mudaram; o efeito
  em carregamento precisa ser medido em ambiente publicado.
- **Qualquer coisa em ambiente público.** Tudo aqui é preview local.

## Bloqueios de publicação — inalterados

Continuam pendentes: número real da demo, URL de checkout, Termos, Privacidade, DNS,
hosting e deploy. Todos os quatro primeiros seguem centralizados em `SITE_CONFIG`, e cada
controle avisa em vez de fingir que a integração existe.

Novo item: `og-ligou.png` foi gerado com a tipografia do visual 1 e precisa ser regerado a
partir de `og-card.svg` antes de publicar.
