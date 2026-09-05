# Ligou V1 — revisão dos comentários visuais

Base preservada: `049eade9f6402a557142d865889895e747207ec9`. Implementação na mesma cópia isolada em `codex/v1-pilot-complete`; sem publicação ou alteração do backend/voz.

## Entrega

- Prévia: http://127.0.0.1:4189/#trabalhos
- Comparação com a base comentada: http://127.0.0.1:4189/output/comentarios-setembro/comparacao.html
- Evidências: `output/comentarios-setembro/` (baseline, capturas nativas, medições e log de testes).

## Comentários atendidos

1. **Linha laranja:** mantém curva e largura; deslocamento de 32 px para cima dentro do espaço existente, deixando 32 px abaixo antes da seção escura. Altura total do intervalo preservada em desktop e mobile. Overflow do SVG liberado para preservar pontas e espessura do traço.
2. **Gráfico no cabeçalho da prova:** 30 barras existentes animadas em sete fases com scaleY discreto. O rótulo de exemplo e o timer ilustrativo 00:12 são mantidos. Animação só após entrada do quadro; pausa fora da tela, em aba oculta, com pausa manual ou movimento reduzido.
3. **Velocidade da prova desktop:** sequência de 2,9 s para 2,03 s (30% menos duração). Preservados ordem, textos, posições, replay e ritmo mobile. Trilha de 2,2 s para 1,54 s.
4. **Um funcionário. Vários trabalhos:** direção escolhida por RJ — Ligou central com tarefas ao redor. Seis seletores nativos destacam conexões e mudam um exemplo de pedido/ação/resultado. Sem troca automática de tarefas. Desktop mantém a mesma composição; no telefone, personagem acima de seletores compactos. Duas capacidades futuras identificadas no seletor e no exemplo. Nenhuma seleção executa ação operacional.
5. **Barra de navegação:** mantida após análise. Recomendação: conservar logo, navegação horizontal e CTA; uma redução de sombra pode ser avaliada separadamente. Não foi aplicada reformulação ou menu flutuante.

## Referências para a resposta sobre 2026

- [Webflow — tendências 2026](https://webflow.com/blog/web-design-trends-2026): identidade visual própria, animação com assinatura da marca e orientação durante scroll.
- [Framer — navegação de websites](https://www.framer.com/blog/website-navigation/): padrões familiares, logo à esquerda, navegação clara e CTA em destaque.

A recomendação para Ligou é julgamento de design aplicado ao site atual; não uma afirmação de que existe um único estilo obrigatório em 2026.

## Verificação

- `bun run check`: 62 testes Bun / 224 assertions + 12 testes Node; scanner de segredos limpo; 84 arquivos fixados e 45 referências verificadas.
- Navegador em 320, 390, 768, 1024, 1123, 1440 e 1920 px: seis tarefas, uma selecionada, dois avisos de desenvolvimento, sem overflow horizontal ou rótulos cortados. Intervalo abaixo da onda medido em 32 px em todas as larguras.
- Seleção de agenda e chamadas futuras muda corretamente o exemplo; Enter funciona e o estado permanece após resize.
- Animação real do gráfico observada por matriz scaleY; fora da tela seu estado passa a paused. Movimento reduzido remove animação das barras e da troca de exemplo, mantendo falas visíveis.
- Replay: delays computados até 1,89 s + 0,14 s. Timer ilustrativo permanece 00:12.
- Revisão independente sem findings concretos nos arquivos alterados.

A comparação oferece “Cena completa, sem animação” para manter os mesmos estados e pontos de referência. Desmarcar permite observar o movimento; a voz real deve ser avaliada na prévia completa.
