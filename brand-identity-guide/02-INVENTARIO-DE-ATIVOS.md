# Inventário de ativos — Ligou

**Data da auditoria:** 18 de agosto de 2026  
**Fonte principal:** `origin/main` em `161e8e84cbc3c675869e7018f1bf2a3b11cbae99`  
**Objetivo:** registrar o que o site realmente usa e separar isso de propostas históricas ou decisões pendentes.

## Status usados

- **ATIVO NO SITE:** referenciado pela v9 executável do `main`.
- **REFERÊNCIA APROVADA:** material explicitamente aprovado em uma rodada anterior e útil para preservar identidade.
- **CANDIDATO:** direção existente, mas ainda não congelada como sistema final.
- **HISTÓRICO:** preservado para contexto, sem autorização automática de uso.
- **PENDENTE:** precisa de decisão antes de entrar como regra do Brand Guide.

## Categoria verbal obrigatória

O Ligou é um **agente operacional de inteligência artificial para negócios de serviços**. Essa definição é uma premissa da marca, não uma opção editorial pendente.

- **Categoria:** agente de inteligência artificial.
- **Categoria em inglês:** operational AI agent.
- **Diferenciação:** operacional — atende, consulta regras, executa dentro da autorização e pede aprovação quando necessário.
- **Forma curta depois que a categoria já estiver estabelecida:** agente operacional.
- **Erro a evitar:** usar apenas “agente operacional” na primeira apresentação e fazer o público adivinhar que o produto é IA.

## Tipografia encontrada

### O que o site atual realmente usa

O site v9 usa **Archivo** tanto para display quanto para corpo. Os tokens ativos são:

```css
--font-display: 'Archivo', system-ui, sans-serif;
--font-body: 'Archivo', system-ui, sans-serif;
```

Pesos declarados: 400, 500, 600, 700, 800 e 900, com os seis itálicos correspondentes. A interface usa principalmente 600, 700 e 800; o token de texto regular está definido como 440 e cai entre os arquivos 400 e 500 disponíveis.

Arquivos copiados: [`assets/fonts/archivo/`](assets/fonts/archivo/). A licença SIL Open Font License acompanha a família.

### Proposta histórica que não está ativa na v9

Uma brand board e o contrato visual anterior propõem:

- **Familjen Grotesk** para display;
- **Archivo** para corpo;
- **Martian Mono** para dados reais de máquina.

No `main` atual, Familjen Grotesk não é carregada pela página e Martian Mono não possui arquivo local. A única Familjen local, peso 600, foi preservada em [`assets/fonts/historical-proposal/familjen-grotesk/`](assets/fonts/historical-proposal/familjen-grotesk/) como proposta histórica, não como fonte ativa.

## Cores do sistema ativo

### Núcleo recomendado para a discussão do guia

| Papel atual | Nome técnico | Hex | Uso observado |
| --- | --- | --- | --- |
| Base escura | Ink 950 | `#041D27` | texto principal, superfícies profundas e contraste |
| Azul-petróleo | Ink 900 | `#082F3D` | seções inversas e material visual do agente |
| Ação | Orange 500 | `#FF5A36` | CTAs, linhas, pontos e telefonia |
| Sinal vivo | Teal 400 | `#46C2AF` | olhos do agente, estados ativos, foco e conexão |
| Confirmação | Teal 500 | `#3EAEA0` | estados positivos e regras aprovadas |
| Papel | Paper | `#FBFCF8` | fundo claro principal |

### Escalas preservadas no site

- **Ink:** `#041D27`, `#082F3D`, `#0C3A4A`, `#223D4B`, `#48656E`, `#9DB3B8`, `#C9D6D7`, `#E3ECEA`, `#EDF3F1`.
- **Teal:** `#0B655A`, `#29786E`, `#3EAEA0`, `#46C2AF`, `#85DCC4`, `#D2F0E6`, `#EAF7F2`.
- **Orange:** `#B83216`, `#E04525`, `#FF5A36`, `#FFE0D6`, `#FFF1EC`.
- **Neutros:** `#FBFCF8`, `#F3F5EE`, `#FFFFFF`.
- **Semântico adicional:** caution `#D9932B`.

O arquivo exato está em [`assets/tokens/ligou-colors-current-site.css`](assets/tokens/ligou-colors-current-site.css).

### Contraste das combinações principais

| Combinação | Razão | Leitura |
| --- | ---: | --- |
| `#041D27` sobre `#FBFCF8` | 16.84:1 | excelente |
| `#FF5A36` sobre `#041D27` | 5.59:1 | atende AA para texto normal |
| `#FF5A36` sobre `#FBFCF8` | 3.01:1 | não usar em texto normal pequeno |
| `#0B655A` sobre `#FBFCF8` | 6.74:1 | atende AA |
| `#46C2AF` sobre `#041D27` | 7.93:1 | atende AAA |
| `#B83216` sobre `#FBFCF8` | 5.81:1 | alternativa escura para texto de acento |

### Divergências que não devem ser escondidas

- A brand board v1 mostra teal `#1A7F72`, enquanto o sistema ativo usa principalmente `#46C2AF` e `#3EAEA0`.
- A hero v9 também usa tons de cena como `#04182A` e `#0D2B3F`; eles são cores de composição, não tokens centrais congelados.
- O laranja `#FF5A36` funciona muito bem como superfície ou detalhe, mas não tem contraste suficiente como texto pequeno sobre o papel claro.

## Logo e símbolos

### Agent Node — PENDENTE / presente na v9

O header e a introdução da v9 renderizam o **Agent Node** diretamente dentro do componente `AgentNodeMark`; não existe ainda um master SVG independente no repositório. A opção selecionada aparece na prancha [`assets/logos/pending-agent-node/ligou-agent-node-options-reference.png`](assets/logos/pending-agent-node/ligou-agent-node-options-reference.png).

Antes de produzir a página de logo, será necessário aprovar o Agent Node como marca corporativa e então exportar seu master vetorial sem redesenhá-lo.

### A Linha — CANDIDATO anterior

- [`ligou-a-linha-mark.svg`](assets/logos/candidate-a-linha/ligou-a-linha-mark.svg)
- [`ligou-a-linha-line.svg`](assets/logos/candidate-a-linha/ligou-a-linha-line.svg)

Esses SVGs são a direção Claude R2 chamada **A Linha**. Ela foi aplicada em uma rodada anterior, mas a v9 mais recente migrou visualmente para o Agent Node. Os arquivos permanecem como candidato, não como logo final presumido.

### Handset — badge de canal

[`assets/logos/channel-badge/ligou-phone-channel-badge.png`](assets/logos/channel-badge/ligou-phone-channel-badge.png) é o disco laranja com telefone. Ele aparece no peito do agente e ainda é usado como favicon/footer raster. A documentação mais recente o trata como sinal do canal telefônico, não como a marca corporativa definitiva.

## Agente Ligou

### Ativos atuais do site

| Arquivo | Dimensões | Papel |
| --- | ---: | --- |
| [`ligou-agent-current-site.png`](assets/agent/current-site/ligou-agent-current-site.png) | 1254 × 1254 | agente usado na prova operacional da v9 |
| [`ligou-agent-avatar-current.png`](assets/agent/current-site/ligou-agent-avatar-current.png) | 512 × 512, alpha | avatar pequeno usado em cards e conversas |
| [`ligou-agent-cta-crop.png`](assets/agent/current-site/ligou-agent-cta-crop.png) | 455 × 462 | recorte usado no CTA final |

### Masters e referências aprovadas

| Arquivo | Dimensões | Papel |
| --- | ---: | --- |
| [`ligou-agent-full-body-master.png`](assets/agent/master-references/ligou-agent-full-body-master.png) | 1024 × 1536 | retrato mestre de corpo inteiro |
| [`ligou-agent-atendendo-master.webp`](assets/agent/action-poses/ligou-agent-atendendo-master.webp) | 3584 × 4800 | pose atendendo |
| [`ligou-agent-operando-master.webp`](assets/agent/action-poses/ligou-agent-operando-master.webp) | 3584 × 4800 | pose operando |
| [`ligou-agent-aprovacao-master.webp`](assets/agent/action-poses/ligou-agent-aprovacao-master.webp) | 3584 × 4800 | pose pedindo aprovação |
| [`ligou-brand-board-v1-approved.png`](assets/brand-board/ligou-brand-board-v1-approved.png) | 1672 × 941 | board v1 aprovada, usada para preservar identidade |

### Características que se repetem e devem ser preservadas

- robô claramente não humano;
- face retangular arredondada em azul-petróleo muito escuro;
- dois olhos verticais mint e sorriso curvo mint;
- uma única antena central com ponta laranja;
- fones laterais integrados;
- corpo compacto, materiais 3D premium, acabamento acetinado;
- laranja restrito a sinais de ação e ao badge telefônico;
- expressão calma, competente e acolhedora;
- nenhuma aparição puramente decorativa: o agente atende, opera ou pede aprovação.

## Cenas e referências do site

| Arquivo | Dimensões | Status / finalidade |
| --- | ---: | --- |
| [`ligou-hero-approved-reference.png`](assets/site-scenes/ligou-hero-approved-reference.png) | 1672 × 941 | referência aprovada da composição completa da hero |
| [`ligou-hero-art-desktop.png`](assets/site-scenes/ligou-hero-art-desktop.png) | 1672 × 941 | arte limpa da operação para desktop |
| [`ligou-hero-art-mobile.png`](assets/site-scenes/ligou-hero-art-mobile.png) | 941 × 1672 | composição vertical da mesma operação |
| [`ligou-product-proof-approved-reference.png`](assets/site-scenes/ligou-product-proof-approved-reference.png) | 1536 × 1024 | referência aprovada da cadeia causal e resumo em português |

## Arquivos deliberadamente não duplicados

- `assets/agent-ligou.png`: byte a byte igual a `assets/agent-full.png`; apenas uma cópia foi mantida.
- `assets/hero-poster.png`: byte a byte igual a `assets/hero-art-desktop.png`; apenas uma cópia foi mantida.
- vídeos da hero e das poses: continuam no projeto original; o guia usa stills de referência e não precisa duplicar os MP4s nesta fase.
- posters responsivos de tablet/ultrawide: variantes de enquadramento, não novas decisões de identidade.
- explorações de logo anteriores: preservadas no repositório original, mas fora do pacote de trabalho para não competir com Agent Node e A Linha.
- `og-ligou.png` e sua fonte editável: material histórico anterior à v9 e não referenciado pela página atual.

## Integridade

Esta pasta contém cópias dos ativos. Os hashes de todos os arquivos selecionados estão em [`SHA256SUMS.txt`](SHA256SUMS.txt).
