# Ligou — preparação do Brand Identity Guide

**Status:** organização e roteiro editorial, sem páginas desenhadas, sem imagens novas e sem PDF.

Esta pasta reúne os arquivos que servirão de base para o futuro Brand Identity Guide do Ligou, um **agente operacional de inteligência artificial para negócios de serviços**. O material foi auditado contra o `origin/main` em `161e8e84cbc3c675869e7018f1bf2a3b11cbae99`, que contém a versão mais recente do site no momento desta preparação.

## Premissa central já definida

O Ligou é um **agente de inteligência artificial**. “Agente operacional” descreve seu diferencial dentro da categoria de IA; não substitui nem oculta a categoria. Nas apresentações em que o público ainda não conhece o produto, a definição completa deve aparecer explicitamente. Em inglês: **operational AI agent for service businesses**.

## O que existe nesta etapa

- [`01-ROTEIRO-PAGINA-A-PAGINA.md`](01-ROTEIRO-PAGINA-A-PAGINA.md): proposta editorial completa para aprovação antes de qualquer design.
- [`02-INVENTARIO-DE-ATIVOS.md`](02-INVENTARIO-DE-ATIVOS.md): fontes, cores, logos, agente e cenas selecionadas, com status e proveniência.
- [`03-DECISOES-PARA-APROVACAO.md`](03-DECISOES-PARA-APROVACAO.md): conflitos reais encontrados no material atual que precisam de decisão.
- `SHA256SUMS.txt`: manifesto verificável dos arquivos Markdown deste guia; ele não tenta
  duplicar nem inventariar assets do produto.
- [`REVIEW-STATUS.md`](REVIEW-STATUS.md): limites da curadoria e localização das fontes
  canônicas.

Os assets citados pelo inventário vivem em seus caminhos canônicos no repositório. Para
verificar este pacote, a partir desta pasta execute:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

## Regra de trabalho

1. Aprovar o roteiro página por página.
2. Resolver as decisões de identidade abertas, uma de cada vez.
3. Só então produzir uma página visual por vez, usando os caminhos canônicos do
   repositório como referência.
4. Revisar cada página antes de avançar.
5. Montar e exportar o PDF somente depois da aprovação de todas as páginas.

## O que não foi feito

- Nenhuma página do guia foi desenhada.
- Nenhuma imagem foi gerada, editada ou reinterpretada.
- Nenhum logo foi escolhido ou redesenhado.
- Nenhuma fonte, cor ou logo foi aprovado como sistema de marca final. A tipografia do
  candidato V0.1 está implementada, mas aprovação de brand é uma decisão separada.
- Nenhum arquivo existente do projeto foi removido, sobrescrito ou movido.
