# Ligou.AI landing page

Landing page estática em PT-BR baseada na copy congelada v2.1.

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
- `favicon.svg`: ícone da marca.
- `og-card.svg` / `og-ligou.png`: fonte editável e imagem social 1200 × 630.

## Documentação do produto

- [`docs/LANDING-PAGE-BASELINE-VISUAL-1.md`](docs/LANDING-PAGE-BASELINE-VISUAL-1.md): registro factual do que este baseline visual contém, o que foi verificado e o que ainda bloqueia publicação;
- [`docs/IMPROVEMENT-SKILLS-ROADMAP.md`](docs/IMPROVEMENT-SKILLS-ROADMAP.md): sequência recomendada de skills, referências do Mobbin e critérios para a próxima versão visual;
- [`docs/MOBBIN-REFERENCE-LOG.md`](docs/MOBBIN-REFERENCE-LOG.md): referências observadas, limites da evidência e hipóteses a testar;
- [`docs/BASELINE-MANIFEST.md`](docs/BASELINE-MANIFEST.md): hashes dos artefatos que formam o snapshot;
- [`docs/source/LIGOU-COPY-V2.1-FROZEN.md`](docs/source/LIGOU-COPY-V2.1-FROZEN.md): cópia local da fonte pública congelada.
