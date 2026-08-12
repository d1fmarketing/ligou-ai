# Claude Design v9 — fonte preservada

Os três arquivos desta pasta foram copiados byte a byte do export recebido em
`/Users/d1f/Downloads/Ligou 2026 animated page.zip`.

- ZIP SHA-256: `fef5f9d32b5d8de954e86b995dbb3c582567a892dd4ab028a11a940e2c2837fd`
- `Ligou 2026 v9.html`: `a2ee8b06f5921fe93657b08d8bcbda5fd45d0050ef4ae1f5ba5fa22e9a6bf6b8`
- `ligou-app9.jsx`: `6ed7437c6d26cdb715adc15d52a5e6bf3ed47752f8cdf17e2d7cabe9cf60b613`
- `ligou-fx2.jsx`: `0a82edda7ab80bd82ca5c2c1df13a363f9c808e6d9019422313e42dcc015f80a`

O HTML preservado usa React development e Babel por CDN porque registra exatamente a
saída da Claude. Ele não é a entrada servida na raiz. A página local usa os mesmos JSX
pré-compilados por `scripts/build-claude-v9.mjs`, React production local e os assets
curados do pacote.

Versões v2–v8, `uploads/`, `.thumbnail` e duplicatas do ZIP foram deliberadamente
excluídas do runtime e do checkpoint.
