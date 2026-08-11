# Ligou — identidade do agente

## Arquivos aprovados e derivados

| Arquivo | Uso | Dimensões | SHA-256 |
| --- | --- | ---: | --- |
| `ligou-brand-board-v1-approved.png` | referência visual aprovada por RJ | 1672 × 941 | `11a023067474e671bf13026f2e8e5f0cf35c06fb47c2cdf54ddb21dffef071da` |
| `ligou-agent-v1-source.png` | retrato mestre do personagem | 1024 × 1536 | `081373ef0c7d4874a482052f2120259f4889037a50084017366f84cbc2ae2046` |
| `../../assets/ligou-agent-v1.webp` | entrega otimizada da landing | 768 × 1152 | `fb8ea8ad6a61f646a233124a847bbbce14cd1deee6aa2692c20dc32cfd344c03` |

O retrato foi derivado da board aprovada com identidade preservada e fundo claro
compatível com `--paper`. A tentativa de transparência real foi recusada porque o
gerador entregou RGB com xadrez embutido; o site usa a versão de fundo sólido, validada
visualmente, em vez de fingir que existe alpha.

## Claude R2 — marca corporativa A Linha

RJ trabalhou duas rodadas no Claude Design sobre a V4 e autorizou o merge da segunda,
mais recente. O candidato local usa agora:

| Arquivo | Uso | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `../../assets/logo-mark.svg` | disco laranja; header, footer e favicon | 423 | `7cce8b971bd56d261ef853d3caa77c94e9ec7024d36d01c7788afe8d53d11e71` |
| `../../assets/logo-line.svg` | master monocromático | 368 | `7a1a424afd3f7379e46dea5e59875f5f67d766b504e55cf76361690cb92c6331` |

Fonte: `/Users/d1f/Downloads/Ligou Design System.zip`, SHA-256
`3e4319ddf66eaebe1bf2ea1f6ed30e402fb584c9b48e8342d30a291492374238`.

A Linha é a marca corporativa do candidato. O handset no peito das poses V4 permanece
como badge provisório do canal telefônico. O OG ainda é V4; Brand Board V2, lockups e
regra final do badge continuam pendentes antes de publicação.

## Regras de uso

- o personagem representa um agente operacional, não um humano;
- a expressão é calma e competente;
- laranja identifica telefonia e ação; verde identifica regra aprovada;
- nenhuma aparição do robô deve ser decorativa: ela precisa explicar atendimento,
  operação ou pedido de aprovação;
- a brand board não deve ser enviada como imagem principal da landing.

## Visual 4 — poses Higgsfield

**Data:** 10 de agosto de 2026

**Ferramenta:** Higgsfield MCP

**Geração final:** `generate_image_batch`, modelo `nano_banana_pro`, runtime
`nano_banana_2`

**Recorte:** `remove_background`, também pelo Higgsfield

A geração inicial com Soul 2.0 foi rejeitada porque reconstruiu a board como layout,
em vez de entregar um personagem isolado. A única rodada de correção recebeu uma
referência limpa de identidade e uma referência separada de pose para cada estado.
Nenhum outro gerador foi usado nessa correção.

### Prompt-base da correção

> Create exactly ONE isolated, complete full-body 3D render of the Ligou robot on a
> clean solid #fbfcf8 background. Reference image 1 is the mandatory identity
> reference; reference image 2 is the mandatory pose reference. Copy the identity
> from reference 1 exactly and copy only the pose/action from reference 2. Preserve
> the exact friendly rounded rectangular dark face screen, two vertical mint-green
> capsule eyes, thin mint-green curved smile, rounded head, exactly ONE centered thin
> antenna with orange tip, integrated round side headset earcups, compact stocky
> humanoid proportions, joint shapes, five-finger robot hands, large rounded feet,
> dark petrol-blue #082F3D satin/semi-gloss materials, mint light accents, restrained
> orange details, and the exact circular orange chest badge containing the dark
> telephone handset glyph. The chest badge must remain fully visible and must not
> become a wordmark, white sticker, generic logo, or different icon. Preserve the
> same premium soft 3D lighting and material realism. Centered studio product view,
> comfortable margins, no crop. Absolutely no text, letters, labels, caption,
> infographic, board, layout panels, decorative graphics, UI, speech bubble,
> checkmark, scene, furniture, extra character, duplicate robot, or additional logo.
> Do not redesign or stylize.

### Sufixos de estado

**Atendendo**

> ATENDENDO — Action: listening to a call. One hand gently touches the outer headset
> earcup, attentive slight head tilt, calm competent expression, other arm relaxed
> naturally beside the torso. No handheld object and no tool.

**Operando**

> OPERANDO — Action: operating. Hold exactly ONE small simple dark tablet in one hand
> and exactly ONE simple matte dark-gray wrench in the other, following pose reference
> 2. No other object, tool, accessory, or icon.

**Aprovação**

> APROVAÇÃO — Action: waiting for approval. Both hands gently clasped together at
> mid-torso just below the orange chest badge, patient calm posture, following pose
> reference 2. No handheld object, no tool, no approval icon, no checkmark, no bubble.

### Entregas e rastreabilidade

| Estado | URL Higgsfield | PNG de geração | SHA-256 PNG | WebP da página | Dimensão / bytes | SHA-256 WebP |
| --- | --- | --- | --- | --- | ---: | --- |
| Atendendo | [fonte](https://d8j0ntlcm91z4.cloudfront.net/user_2zHWFlBUJTNxdG7ciMDQnx3RlZm/hf_20260810_225138_334f5fa7-d234-46ce-9174-1914b09638b3.png) | `ligou-atendendo.png` · 3584 × 4800 · alpha | `51f0184f916bfcdaaa98661f2f1c716c8f5f13b89793de57958940dcd8dc11ed` | `../../assets/ligou-atendendo-v1.webp` | 640 × 857 / 29.646 | `8190db2ca191acacf052461522c9fc6b6710a55232eca4b1b1344a8e3db9e336` |
| Operando | [fonte](https://d8j0ntlcm91z4.cloudfront.net/user_2zHWFlBUJTNxdG7ciMDQnx3RlZm/hf_20260810_225140_8226012c-0f00-4366-9a88-82dcd64d71c1.png) | `ligou-operando.png` · 3584 × 4800 · alpha | `500fc2fbd9ac239a3fd8ff88320232083cfb615719e0c0a602b352034c44596c` | `../../assets/ligou-operando-v1.webp` | 640 × 857 / 30.684 | `8f9b6661a6fd5837b07b867afb0ca7a58c348293702b8bf8790c5ed9d1d0343e` |
| Aprovação | [fonte](https://d8j0ntlcm91z4.cloudfront.net/user_2zHWFlBUJTNxdG7ciMDQnx3RlZm/hf_20260810_225139_f8534a89-0fde-4ff5-8205-2995bf842d06.png) | `ligou-aprovacao.png` · 3584 × 4800 · alpha | `ce092536dd9471f73e9358ef4c4173eb15bb4ccde36674c249260f346bf093fc` | `../../assets/ligou-aprovacao-v1.webp` | 640 × 857 / 28.412 | `b1a284345e4f6a42abcf8a908d78e5b621397fbc4dd27467ffadf321244a4387` |

Os PNGs de geração são rastreados pelas URLs e hashes acima; não entram no repositório
para evitar 45 MB de arquivos de origem. Em vez de depender somente das URLs, o
repositório preserva derivados master em resolução integral, com alpha e WebP quality
90. Eles mantêm margem para novos recortes sem inflar o snapshot com os PNGs originais:

| Master local | Dimensão / bytes | SHA-256 |
| --- | ---: | --- |
| `masters/ligou-atendendo-v1-master.webp` | 3584 × 4800 / 389.006 | `dfdad409b9653449898c0a2b1300caf46ecd58180db90181b133dc9167c8ae92` |
| `masters/ligou-operando-v1-master.webp` | 3584 × 4800 / 417.022 | `6b9bfbd8a6ef3e628264ed5f5a729e8153f8d11c72f1935e3072ead5a1234e51` |
| `masters/ligou-aprovacao-v1-master.webp` | 3584 × 4800 / 380.930 | `0bb5e49bd0f77a94d7e30d86be628a27ffbf0356856f66358fddc76ecac73b34` |

Os WebPs de entrega foram redimensionados e comprimidos separadamente para a página,
sem redesenhar o personagem.

## Motion — Seedance 2.5 no Browser

**Data:** 10 de agosto de 2026

**Ferramenta:** Higgsfield aberto no Browser interno, modo Unlimited

**Configuração:** Seedance 2.5, 5 s, 3:4, 720p, bitrate High

As poses V4 foram usadas como referências individuais para três coreografias. A
primeira tentativa de atendimento foi rejeitada por movimento tímido e fundo bege —
não por deformação de identidade. As gerações aceitas usam ação legível e não retornam
ao quadro inicial, porque o site controla o tempo diretamente pela rolagem.

| Estado | Job Higgsfield | Entrega | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| Atendendo | `c3fcc859-3ef6-42e6-809d-f09313eab712` | `../../assets/ligou-atendendo-motion-v1.mp4` | 1.367.099 | `78462ac089c5ca89a57420329df715587501bd08c4000746bddd66a0985c1f14` |
| Operando | `b356f72f-647a-4ad5-a6c1-7a31d6f14999` | `../../assets/ligou-operando-motion-v1.mp4` | 1.322.696 | `c5309c90611abb4dddb1cc3bc1549d37953d35e53ddfc251a8fddc83b0c0dd7b` |
| Aprovação | `314d92f8-025b-47b5-a7c2-e5c53adfd5d8` | `../../assets/ligou-aprovacao-motion-v1.mp4` | 1.655.779 | `37ccec78a0c129ed20e9c6efb6a845e4ec303c5ad60442f5ecff78f0110c9d90` |

Os posters ativos são extrações do frame 0 dos próprios MP4s: Atendendo
`467668d905485209c2567852ed228fe78a83fde6962dbdbfad6ded3ee4955f26`, Operando
`c86d371c9df9f7b054993ba42f5158ab533045a9c7d6896cc6f7547a335495c6` e Aprovação
`ac96b7f6b9a43db1279a2f7831248c423582622858b1e65f9a0bc167a4b2cdcd`.
Eles substituem somente o fallback renderizado da rodada motion; os WebPs V4 continuam
preservados e com hashes históricos intactos.

O Seedance entregou fundos com casts diferentes apesar do prompt `#f8f8f5`. Os três
arquivos finais foram normalizados sobre `#F8F8F5`, recodificados em H.264 `yuv420p`,
24 fps, sem áudio e com GOP 1 para permitir scrub reversível. URLs de origem, prompts
completos, tentativa rejeitada, procedimento e QA estão em
[`../CHANGELOG-HIGGSFIELD-MOTION.md`](../CHANGELOG-HIGGSFIELD-MOTION.md).
