# Ligou — baseline visual 1 da landing page

**Status:** RJ disse que gostou desta primeira implementação como ponto de partida; ela ainda não está pronta para publicação

**Data do snapshot:** 10 de agosto de 2026

**Fonte de copy:** [`source/LIGOU-COPY-V2.1-FROZEN.md`](source/LIGOU-COPY-V2.1-FROZEN.md). A v1 do texto é somente histórico e foi substituída.

Os arquivos que compõem este snapshot e seus hashes estão registrados em [`BASELINE-MANIFEST.md`](BASELINE-MANIFEST.md). Isso permite verificar o baseline independentemente de commits futuros.

## 1. Objetivo desta versão

Esta versão transforma a copy pública congelada do Ligou em uma landing page estática em PT-BR. O público é o dono brasileiro de uma empresa de serviços residenciais nos Estados Unidos que recebe ligações de clientes em inglês.

A página explica uma transformação simples:

> o cliente fala em inglês → o Ligou atende dentro das regras → o dono recebe o resumo em português

A prova principal pretendida é a ligação para a demo ao vivo. O checkout é uma conversão secundária, depois que o visitante entende e testa o produto.

## 2. O que foi implementado

### Estrutura pública

A ordem da página segue a v2.1 congelada:

1. Hero
2. A diferença
3. Prova do produto
4. A dor
5. O que o Ligou faz numa ligação
6. Para quem é
7. Como começar
8. FAQ
9. Preço
10. Footer

Os apêndices operacionais da v2.1 não foram publicados como conteúdo da landing page.

### Experiência visual

- Direção de “linha telefônica operacional”, ligada ao universo de serviços residenciais.
- Hero com a promessa `Ligou? Atendido.`, acesso à demo e visual de chamada em inglês virando resumo em português.
- Fluxo de aprendizado apresentado como sugestão, aprovação do dono e somente então regra permanente.
- Resumo de chamada identificado semanticamente como exemplo por `aria-label`; o rótulo visível ainda diz `Ligou agora` e merece correção na próxima rodada.
- Visual estático de chamada em `02:47`; não há timer ou atividade “ao vivo” fabricada.
- Uma única oferta de preço, com mensalidade, ativação, minutos incluídos, excedente e condições de fundador.
- FAQ em acordeão e navegação por âncoras.

### Sistema visual atual

| Elemento | Decisão atual |
| --- | --- |
| Cor-base | azul-petróleo profundo |
| Sinal/ação | laranja |
| Aprovação | verde |
| Superfícies | branco-papel e névoa azulada |
| Display | Familjen Grotesk |
| Corpo | Instrument Sans |
| Dados/estados | IBM Plex Mono |
| Forma | cantos amplos, linhas operacionais e sombras rígidas |

Esse sistema é parte do baseline, não uma identidade de marca definitivamente aprovada.

### Comportamento e segurança de interface

- `SITE_CONFIG`, no início de `script.js`, concentra telefone, checkout, Termos e Privacidade.
- Enquanto um destino real não existe, o controle mostra um aviso claro em vez de simular navegação.
- FAQ funciona com teclado e sem dependência de um framework.
- Animações de entrada respeitam `prefers-reduced-motion`.
- O conteúdo continua visível caso o JavaScript falhe.
- O visual de chamada não usa timer dinâmico; a falta de um rótulo visível de exemplo está registrada como pendência.

### SEO e compartilhamento

- `title` e description seguem a v2.1 no HTML local.
- Canonical, Open Graph e Twitter Card estão configurados no HTML local.
- Há uma imagem social local de 1200 × 630 em `og-ligou.png` e uma fonte editável em `og-card.svg`.
- O favicon está em `favicon.svg`.

Isso não comprova resolução de DNS, hosting ou resposta HTTP pública. Esses pontos continuam bloqueios de lançamento.

## 3. Arquivos do projeto

### Artefatos renderizados do snapshot

| Arquivo | Responsabilidade |
| --- | --- |
| `index.html` | conteúdo, semântica e metadados |
| `styles.css` | tokens visuais, layout, responsividade, estados e movimento |
| `script.js` | configuração dos destinos, avisos e comportamento da interface |
| `favicon.svg` | ícone da marca |
| `og-card.svg` | fonte editável do card social |
| `og-ligou.png` | card social 1200 × 630 |

Esses arquivos, junto da copy-fonte congelada, compõem o manifesto de integridade.

### Documentação de apoio

| Arquivo | Responsabilidade |
| --- | --- |
| `README.md` | instrução de preview, configuração e índice dos documentos |
| `docs/LANDING-PAGE-BASELINE-VISUAL-1.md` | estado factual desta implementação |
| `docs/IMPROVEMENT-SKILLS-ROADMAP.md` | ordem de skills e gate da próxima fase |
| `docs/MOBBIN-REFERENCE-LOG.md` | observações e hipóteses das referências |
| `docs/BASELINE-MANIFEST.md` | hashes do snapshot renderizado e da copy-fonte |

O projeto é deliberadamente simples: HTML, CSS e JavaScript, sem framework ou etapa de build.

## 4. Verificações concluídas neste snapshot

- Sem violações WCAG A/AA detectadas pelo axe no desktop e no mobile.
- Sem overflow horizontal entre 320 px e 1440 px.
- Navegação por teclado, foco, FAQ, avisos e redução de movimento verificados.
- Fallback sem JavaScript verificado.
- HTML e JavaScript válidos e sem erros no console durante a QA.
- Ordem, claims e preço comparados com a copy v2.1.
- Metadados e imagem social verificados localmente.

Essas verificações valem para este snapshot local. Devem ser repetidas depois de qualquer redesign relevante e no ambiente publicado.

## 5. Bloqueios antes da publicação

| Bloqueio | Onde configurar | Estado atual |
| --- | --- | --- |
| Número real da demo | `SITE_CONFIG.demoPhoneDisplay` e `demoPhoneHref` | placeholder |
| URL real do checkout | `SITE_CONFIG.checkoutUrl` | ausente |
| URL de Termos | `SITE_CONFIG.termsUrl` | ausente |
| URL de Privacidade | `SITE_CONFIG.privacyUrl` | ausente |
| DNS do domínio | provedor de DNS | não verificado como público |
| Hosting e deploy | ambiente de publicação | não configurados neste projeto |
| Respostas HTTP públicas | homepage, OG image e destinos legais | pendentes de validação após deploy |

Além dos quatro destinos de frontend, uma demo real depende da infraestrutura operacional descrita nos apêndices da v2.1: atendimento, consentimento, gravação/transcrição, SMS, regras aprovadas e onboarding. A landing page não prova que essa infraestrutura existe.

## 6. O que não foi construído

- DNS, hosting, deploy ou publicação em `ligou.ai`.
- Backend, banco de dados ou autenticação.
- Atendimento telefônico real.
- Consentimento, gravação, transcrição ou envio de SMS.
- Onboarding real do cliente.
- Checkout e cobrança.
- Analytics e eventos de conversão.
- Dashboard do cliente.
- Depoimentos, logos ou métricas de clientes.

O preview local em `http://127.0.0.1:4173/` demonstra somente a interface.

## 7. O que merece melhorar na próxima fase

### Direção de marca

A estética atual é coerente, mas ainda não foi validada contra um contexto de marca explícito. Antes de redesenhar, precisamos registrar:

- três palavras que o Ligou deve transmitir;
- referências e anti-referências visuais;
- o nível desejado entre humano, operacional, premium e tecnológico;
- quais elementos deste baseline visual devem permanecer reconhecíveis.

### Hierarquia de conversão

A demo deve se tornar ainda mais claramente a ação principal do hero. O número real, quando existir, pode funcionar como o próprio objeto visual e funcional da primeira dobra. O checkout deve continuar secundário até a prova do produto.

### Ritmo editorial

A copy é longa e necessária. A próxima melhoria deve usar tipografia, largura de leitura, contraste de escala e respiro para criar ritmo; esconder o conteúdo em mais cards não resolve o problema.

### Sistema e manutenção

O CSS atual tem cerca de 2.750 linhas para uma página estática. A complexidade ainda é administrável, mas a consolidação de tokens, padrões de seção e breakpoints deve acontecer depois que a nova direção for escolhida — antes disso, uma refatoração criaria retrabalho.

### Evidência e confiança

A página não deve ganhar prova social fictícia. O melhor próximo ativo de confiança é o produto real funcionando: número de demo, consentimento correto e resumo verificável. Casos, áudio, métricas ou logos só entram com autorização separada.

O resumo ilustrativo também precisa de um rótulo visível como `Exemplo de ligação`; o `aria-label` atual ajuda tecnologia assistiva, mas não resolve a ambiguidade para quem olha a tela.

### Desempenho real

O peso, Core Web Vitals e comportamento em rede móvel ainda precisam ser medidos em um ambiente publicado ou equivalente. A ausência de framework ajuda, mas não substitui medição.

## 8. Decisões que permanecem congeladas

- A v2.1 é a única fonte de copy pública.
- O Ligou é apresentado como assistente virtual, sem fingir que é humano.
- O aprendizado é controlado por aprovação do dono.
- A demo é a prova principal; checkout é conversão secundária.
- Preço público: `$499/mês`, ativação de `$499`, 400 minutos e `$0.35/min` de excedente.
- A oferta de fundador não usa urgência artificial.
- Não publicar dados de clientes, gravações, métricas ou prova social sem autorização.
- Preview local, infraestrutura real e publicação são estados distintos.

## 9. Protocolo para a próxima versão visual

1. Registrar o contexto de design em `.impeccable.md`.
2. Capturar crítica, auditoria e métricas de performance do baseline.
3. Explorar no máximo duas direções em 390 px e 1440 px, sem CSS de produção.
4. Registrar a escolha explícita de RJ.
5. Implementar a intervenção indicada pela crítica, começando por layout e tipografia.
6. Adaptar intervalos, contextos de uso e casos extremos.
7. Endurecer estados reais e otimizar ativos/execução.
8. Refinar detalhes somente depois da estrutura e da performance.
9. Repetir QA, acessibilidade, performance e verificação da copy.
