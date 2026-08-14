# Ligou v9.1 — Hero responsiva por orientação

**Data:** 13 de agosto de 2026

## Alteração

- desktop continua usando o vídeo 16:9 e agora preenche a hero com `cover`, sem revelar o azul da página nas bordas;
- tablet entre 768 e 1199 px usa animação 4:3 em paisagem e 3:4 em retrato;
- celular até 767 px continua usando a animação 9:16 já aprovada;
- troca de largura ou orientação atualiza vídeo, poster e dimensões intrínsecas juntos;
- movimento reduzido recebe o poster correspondente à mesma faixa responsiva.

## Novos masters entregues

| Uso | Master recebido | Entrega web |
| --- | --- | --- |
| Tablet paisagem | `hf_20260814_012733_3befdb7a-418f-4675-ac4c-4951d670f393.mp4` | H.264, 1440 × 1080, 24 fps, 5,04 s, sem áudio |
| Tablet retrato | `hf_20260814_013521_3497b447-58f4-482a-8bfb-ccfa86e64e5a.mp4` | H.264, 1080 × 1440, 24 fps, 5,04 s, sem áudio |

Os MP4 entregues pelo gerador eram HEVC Main 10 com áudio. A conversão usa H.264 High,
`yuv420p` e `faststart` para compatibilidade ampla e início progressivo no navegador.

## Proveniência

Os três arquivos originais de Claude Design em `src/claude-v9/` permanecem byte a byte
iguais ao checkpoint v9. A adaptação executável vive em `src/runtime/ligou-app9.jsx` e é
compilada por `bun run build`, mantendo separadas a fonte recebida e a implementação da
correção responsiva.

## Correção v9.2 — composição desktop

O preenchimento desktop por `cover` foi removido porque cortava a zona vazia intencional
do master 16:9 e deslocava o robô para baixo da copy em janelas altas. O desktop agora
mantém sempre 100% da largura do vídeo, centraliza a mídia verticalmente e limita qualquer
corte às bordas superior e inferior. As faixas residuais usam as cores amostradas do próprio
master (`#021523`, `#061b2a`, `#0c1e2d`) com fade nas bordas. Em telas largas, a copy
agora para no mesmo eixo esquerdo aprovado para 1920 px, em vez de continuar se aproximando
do robô conforme o container centralizado cresce. As regras de tablet e celular não mudaram.
