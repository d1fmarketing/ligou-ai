# Ligou — Claude Design v9

**Data:** 11 de agosto de 2026

**Status:** export curado e integrado como checkpoint local; sem push, PR ou deploy

**Base Git:** Demo Hero Restore no commit `5d57afb`

## Fonte e proveniência

RJ entregou o export exato desta rodada em:

- arquivo: `/Users/d1f/Downloads/Ligou 2026 animated page.zip`;
- tamanho: 38.242.747 bytes;
- SHA-256: `fef5f9d32b5d8de954e86b995dbb3c582567a892dd4ab028a11a940e2c2837fd`;
- integridade: 71 entradas verificadas por `unzip -t`, sem erro.

O pacote contém as versões v2–v9, uploads, referências e duplicatas. A integração não
descompacta o arquivo inteiro sobre o repositório. Os três arquivos-fonte da versão
exata ficam preservados byte a byte em `src/claude-v9/`:

| Fonte | Bytes | SHA-256 |
| --- | ---: | --- |
| `Ligou 2026 v9.html` | 43.231 | `a2ee8b06f5921fe93657b08d8bcbda5fd45d0050ef4ae1f5ba5fa22e9a6bf6b8` |
| `ligou-app9.jsx` | 45.594 | `6ed7437c6d26cdb715adc15d52a5e6bf3ed47752f8cdf17e2d7cabe9cf60b613` |
| `ligou-fx2.jsx` | 5.257 | `0a82edda7ab80bd82ca5c2c1df13a363f9c808e6d9019422313e42dcc015f80a` |

## O que entrou

- hero escura `Ligou? Atendido.` com Agent Node, vídeo horizontal dedicado no desktop
  e vídeo vertical dedicado no mobile/tablet;
- composição intermediária em duas colunas entre 768 e 1199 px;
- sequência `Conversa → Suas regras → Em operação` com cidades da Califórnia;
- prova desktop em fundo claro com conversa, regra, ação e resumo conectado;
- prova mobile reconstruída num único console: bubbles alternados, eventos causais,
  agente preto oficial, drawer em português, replay e relato expansível;
- design system empacotado, nove assets de mídia referenciados pelo runtime, dois
  `hero-art` preservados como proveniência do export e fontes Archivo locais;
- fontes v9 preservadas e build determinístico por `bun run build`;
- React 18.3.1 production local e JSX pré-compilado, sem Babel ou React development no
  navegador;
- fallback editorial sem JavaScript e estado estático em movimento reduzido;
- `robots=noindex,nofollow`, porque este checkpoint continua sendo protótipo visual.

## O que ficou fora

- HTML/JSX v2–v8, `.thumbnail`, `uploads/` e referências duplicadas;
- os 86 MB de frames de revisão presentes apenas no worktree original;
- a implementação local anterior de job ticket, que não equivalia à v9;
- qualquer backend, telefonia, checkout, Termos, Privacidade ou inventário Founding;
- push, PR, publicação, DNS ou deploy.

## Embalagem técnica

O export original compilava JSX no browser com Babel e carregava React development e
Google Fonts por CDN. O checkpoint mantém os fontes exatos como recibo, mas serve uma
embalagem local:

1. `scripts/build-claude-v9.mjs` transpila os dois JSX sem alterar sua fonte;
2. `assets/js/` guarda o resultado executável com o hash da origem no banner;
3. React/ReactDOM production e Archivo são servidos pelo próprio repositório;
4. `scripts/verify-claude-v9.mjs` fixa os hashes da fonte e verifica todas as
   referências locais;
5. `dev-server.mjs` continua respondendo aos MP4s com HTTP Range `206`.

## QA local executado

O Browser interno validou a página servida em `http://127.0.0.1:4189/`:

| Viewport | Resultado |
| --- | --- |
| 390 × 844 | vídeo 1080 × 1920, hero íntegra, console mobile único, zero overflow |
| 430 × 932 | composição mobile e prova reconstruída preservadas |
| 767 × 1024 | último estado mobile, prova `lc-shell`, vídeo vertical |
| 768 × 1024 | primeiro estado intermediário, duas colunas, vídeo vertical |
| 1024 × 600 | headline, promessa, CTA principal e cena simultaneamente visíveis |
| 1118 × 1123 | copy e operação juntas, sem faixa morta |
| 1199 × 820 | último estado intermediário, mídia 1080 × 1920 |
| 1200 × 820 | primeiro estado desktop, mídia 1920 × 1080 |

Também passaram:

- zero imagens quebradas, zero erro de console e zero overflow horizontal;
- todos os assets principais com HTTP 200 e ambos os vídeos com Range HTTP 206;
- replay reinicia a sequência e o drawer abre/fecha com `aria-expanded` correto;
- `prefers-reduced-motion: reduce` remove vídeo/intro e mostra o estado completo;
- JavaScript desativado mantém headline, promessa e cadeia causal desde o topo;
- `bun run check` e `git diff --check`.

## Limites ainda abertos

O ciclo mobile exportado conclui suas entradas em aproximadamente 2,85 s, com passos de
cerca de 0,45 s. Isso diverge da meta anterior de 0,8–1,1 s por passo e ciclo de 6–8 s.
O checkpoint preserva o timing recebido; uma nova decisão visual é necessária para
alterá-lo.

`DEMO_PHONE` continua `(XXX) XXX-XXXX`; demo, aprovação, ajuste, Founding, Termos e
Privacidade são elementos ilustrativos ou âncoras. A copy comercial e as capacidades
também não constituem prova de produto. Por isso esta versão pode ser commitada como
direção visual, mas não pode ser tratada como pronta para push/deploy.
