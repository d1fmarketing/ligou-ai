# Ligou.AI landing page

Landing page estática em PT-BR. A V3 preserva a base da copy v2.1 e apresenta o
Ligou como agente operacional bilíngue com memória, ferramentas e aprovação do dono.

## Visualizar localmente

```bash
python3 -m http.server 4173
```

Depois, abra `http://127.0.0.1:4173/`.

## Configuração obrigatória antes de publicar

Edite `SITE_CONFIG` no início de `script.js`:

- `demoPhoneDisplay`: número formatado mostrado na página;
- `demoPhoneHref`: número E.164 usado pelo link `tel:`;
- `checkoutUrl`: URL real do checkout;
- `termsUrl`: URL dos Termos;
- `privacyUrl`: URL da Política de Privacidade.

Enquanto esses campos estiverem vazios, os respectivos controles mostram um aviso de bloqueio em vez de fingir que a integração existe.

## Estrutura

- `index.html`: conteúdo e metadados SEO;
- `styles.css`: direção visual, responsividade e acessibilidade;
- `script.js`: configuração dos links, FAQ, revelações e estados de navegação;
- `assets/ligou-agent-v1.webp`: personagem otimizado usado na página;
- `assets/fonts/`: fontes e licenças usadas para regenerar o card social;
- `favicon.svg`: ícone da marca;
- `og-card.svg` / `og-ligou.png`: fonte editável e imagem social 1200 × 630.

## Documentação do produto

- [`.impeccable.md`](.impeccable.md): contrato de design do projeto — público, personalidade, o que está congelado e os sete princípios que valem para qualquer rodada visual;
- [`docs/CHANGELOG-VISUAL-3.md`](docs/CHANGELOG-VISUAL-3.md): mudanças, verificações e bloqueios da rodada do agente;
- [`docs/CHANGELOG-VISUAL-2.md`](docs/CHANGELOG-VISUAL-2.md): checkpoint histórico da rodada do Claude;
- [`docs/source/LIGOU-COPY-V3-WORKING.md`](docs/source/LIGOU-COPY-V3-WORKING.md): nova direção de produto e copy ainda não congelada;
- [`docs/brand/README.md`](docs/brand/README.md): proveniência, hashes e regras de uso do agente aprovado;
- [`docs/LANDING-PAGE-BASELINE-VISUAL-1.md`](docs/LANDING-PAGE-BASELINE-VISUAL-1.md): registro factual do baseline anterior, o que foi verificado e o que ainda bloqueia publicação;
- [`docs/IMPROVEMENT-SKILLS-ROADMAP.md`](docs/IMPROVEMENT-SKILLS-ROADMAP.md): sequência recomendada de skills, referências do Mobbin e critérios para a próxima versão visual;
- [`docs/MOBBIN-REFERENCE-LOG.md`](docs/MOBBIN-REFERENCE-LOG.md): referências observadas, limites da evidência e hipóteses a testar;
- [`docs/BASELINE-MANIFEST.md`](docs/BASELINE-MANIFEST.md): hashes dos artefatos que formam o snapshot;
- [`docs/source/LIGOU-COPY-V2.1-FROZEN.md`](docs/source/LIGOU-COPY-V2.1-FROZEN.md): cópia local da fonte pública congelada.
