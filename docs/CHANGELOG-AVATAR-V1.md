# Ligou v9.4 — avatar responsivo

**Data:** 13 de agosto de 2026

## Correção

As cinco aparições pequenas do agente agora usam um único avatar quadrado com
transparência real. O novo enquadramento elimina as áreas claras do recorte
retangular antigo e permanece consistente entre 34 e 68 px no desktop, tablet e
celular.

## Asset

- referência aprovada: `assets/agent-full.png`;
- geração dirigida por referência, preservando identidade, materiais, rosto,
  antena e emblema do Ligou;
- entrega web: `assets/ligou-avatar-v1.png`, PNG RGBA, 512 × 512;
- SHA-256: `6b8d21997420acefa03f5f810c3a531f249b12010290bcfde7e742984d9beddb`.

O export original de Claude em `src/claude-v9/` continua intacto. A troca vive
somente na adaptação executável `src/runtime/ligou-app9.jsx`.
