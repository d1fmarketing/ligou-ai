# Inventário de ativos — Brand Identity Guide v0.1

Este inventário não contém cópias de assets. Cada caminho abaixo aponta para o arquivo
canônico já presente neste checkout. Links para materiais restritos permanecem fora do
Git; referências PNG de revisão não fazem parte deste pacote.

## Convenções de status

- **IMPLEMENTADO V0.1:** arquivo ou token usado pelo candidato atual.
- **CURADO:** fonte de referência mantida em `docs/brand/`, sem promoção automática a
  sistema final.
- **HISTÓRICO:** registro de uma versão anterior; não é instrução de runtime.
- **PENDENTE:** requer decisão explícita de brand.

## Tipografia implementada

O candidato V0.1 usa **Familjen Grotesk 600/700 para display** e **Archivo para corpo**.
Os tokens ativos estão no design system:

- [`typography.css`](../../../../_ds/ligou-design-system-a33905fc-3bee-481b-b797-48c2b57eab4c/tokens/typography.css)
- [`fonts.css`](../../../../_ds/ligou-design-system-a33905fc-3bee-481b-b797-48c2b57eab4c/tokens/fonts.css)

| Arquivos canônicos | Status | Uso |
| --- | --- | --- |
| [`familjen-grotesk-600.ttf`](../../../../assets/fonts/familjen-grotesk-600.ttf), [`familjen-grotesk-700.ttf`](../../../../assets/fonts/familjen-grotesk-700.ttf) | IMPLEMENTADO V0.1 | display |
| [`archivo-v25-400.ttf`](../../../../assets/fonts/archivo-v25-400.ttf) até `archivo-v25-900.ttf` | IMPLEMENTADO V0.1 | corpo, controles e leitura |
| [`OFL-Familjen-Grotesk.txt`](../../../../assets/fonts/OFL-Familjen-Grotesk.txt), [`OFL-Archivo.txt`](../../../../assets/fonts/OFL-Archivo.txt) | IMPLEMENTADO V0.1 | licenças |

Familjen e Archivo estão implementadas neste candidato; isso não equivale à aprovação
do sistema de marca. Martian Mono não é um asset local nem uma dependência do runtime.

## Tokens e cores

Os tokens executáveis são canônicos no design system, incluindo
[`colors.css`](../../../../_ds/ligou-design-system-a33905fc-3bee-481b-b797-48c2b57eab4c/tokens/colors.css),
[`spacing.css`](../../../../_ds/ligou-design-system-a33905fc-3bee-481b-b797-48c2b57eab4c/tokens/spacing.css)
e [`effects.css`](../../../../_ds/ligou-design-system-a33905fc-3bee-481b-b797-48c2b57eab4c/tokens/effects.css).

O núcleo observado é Ink `#041D27`/`#082F3D`, Orange `#FF5A36`, Teal `#46C2AF`/
`#3EAEA0` e Paper `#FBFCF8`. O teal e a paleta final continuam pendentes de aprovação
de brand.

## Marca e agente

| Arquivo canônico | Status | Papel |
| --- | --- | --- |
| [`logo-mark.svg`](../../../../assets/logo-mark.svg), [`logo-line.svg`](../../../../assets/logo-line.svg) | IMPLEMENTADO V0.1 | marca aplicada no candidato |
| [`ligou-agent-v1.webp`](../../../../assets/ligou-agent-v1.webp) | IMPLEMENTADO V0.1 | agente otimizado da landing |
| [`agent-full.png`](../../../../assets/agent-full.png) | IMPLEMENTADO V0.1 | fonte de imagem do agente no produto |
| [`ligou-agent-v1-source.png`](../../ligou-agent-v1-source.png) | CURADO | retrato fonte preservado para referência de identidade |
| [`ligou-brand-board-v1-approved.png`](../../ligou-brand-board-v1-approved.png) | CURADO | board V1 histórica; não substitui a aprovação atual |
| [`ligou-atendendo-v1-master.webp`](../../masters/ligou-atendendo-v1-master.webp), [`ligou-operando-v1-master.webp`](../../masters/ligou-operando-v1-master.webp), [`ligou-aprovacao-v1-master.webp`](../../masters/ligou-aprovacao-v1-master.webp) | CURADO | masters preservados das poses |

O Agent Node, A Linha e a regra definitiva do badge de telefonia continuam decisões de
brand. Não há prancha PNG versionada nesta pasta que deva ser tratada como master ou
asset promovido.

## Cenas do produto

| Arquivo canônico | Status | Papel |
| --- | --- | --- |
| [`hero-art-desktop.png`](../../../../assets/hero-art-desktop.png), [`hero-art-mobile.png`](../../../../assets/hero-art-mobile.png) | IMPLEMENTADO V0.1 | arte da hero |
| [`hero-poster.png`](../../../../assets/hero-poster.png), [`hero-poster-mobile.png`](../../../../assets/hero-poster-mobile.png) | IMPLEMENTADO V0.1 | posters de fallback |
| [`hero-loop-1080p.mp4`](../../../../assets/hero-loop-1080p.mp4) | IMPLEMENTADO V0.1 | movimento principal da hero |

Variantes tablet e ultrawide são enquadramentos de produto, não novas decisões de
identidade.

## Integridade do pacote editorial

[`SHA256SUMS.txt`](SHA256SUMS.txt) cobre os cinco arquivos Markdown deste guia e exclui
o próprio manifesto. Para verificar, execute `shasum -a 256 -c SHA256SUMS.txt` a partir
desta pasta. Assets de produto são verificados pelos mecanismos do runtime, não por um
manifesto duplicado de brand.
