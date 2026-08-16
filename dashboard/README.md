# Dashboard Ligou

Protótipo frontend responsivo do painel de cliente da Ligou, construído a partir da composição mobile aprovada. O projeto contém três áreas conectadas por estado local:

- `#ligou`: conversa operacional, contexto da ligação e decisão de exceções;
- `#memoria`: busca, filtros, edição versionada e revogação de regras;
- `#aprovacoes`: análise, ajuste, aprovação por caso ou criação de regra e recusa.

Todos os dados são fictícios e persistem somente no navegador pela chave `ligou.dashboard.demo.v1`. Não há autenticação, microfone, telefonia, API ou backend conectados.

## Executar

```bash
npm install
npm run dev
```

## Verificar

```bash
npm test
git diff --check
```

`npm test` executa os testes de estado, o build de produção e os testes do empacotamento estático.
