# Ligou — Higgsfield Motion e scroll scrub

**Data:** 10 de agosto de 2026

**Estado:** candidato local; nenhuma publicação autorizada

**Branch:** `codex/ligou-interactive-motion`
**Base:** Claude R2 em `codex/ligou-claude-r2`

## Resultado

A hero foi redesenhada para contar os três estados do produto com vídeo controlado
pela rolagem: `EN entra → suas regras operam → PT volta`. A mesma mídia é reutilizada
na seção “Uma ligação. Três estados”. Não há autoplay, loop, botão de play ou controle
manual no mobile: avançar e voltar o scroll avança e volta o `currentTime` do vídeo.

Os três vídeos foram gerados no Higgsfield aberto no Browser interno, com Seedance
2.5, 5 s, 3:4, 720p, bitrate High e **Unlimited mode**. Nenhuma chamada paga de API ou
MCP foi usada nesta rodada.

## Gerações aceitas

| Estado | Job / asset Higgsfield | Fonte | Entrega local | Duração | Bytes | SHA-256 |
| --- | --- | --- | --- | ---: | ---: | --- |
| Atendendo | `c3fcc859-3ef6-42e6-809d-f09313eab712` | [MP4 bruto](https://d8j0ntlcm91z4.cloudfront.net/user_2zHWFlBUJTNxdG7ciMDQnx3RlZm/hf_20260811_040613_c3fcc859-3ef6-42e6-809d-f09313eab712.mp4) | `../assets/ligou-atendendo-motion-v1.mp4` | 5,083 s | 1.367.099 | `78462ac089c5ca89a57420329df715587501bd08c4000746bddd66a0985c1f14` |
| Operando | `b356f72f-647a-4ad5-a6c1-7a31d6f14999` | [MP4 bruto](https://d8j0ntlcm91z4.cloudfront.net/user_2zHWFlBUJTNxdG7ciMDQnx3RlZm/hf_20260811_041524_b356f72f-647a-4ad5-a6c1-7a31d6f14999.mp4) | `../assets/ligou-operando-motion-v1.mp4` | 5,083 s | 1.322.696 | `c5309c90611abb4dddb1cc3bc1549d37953d35e53ddfc251a8fddc83b0c0dd7b` |
| Aprovação | `314d92f8-025b-47b5-a7c2-e5c53adfd5d8` | [MP4 bruto](https://d8j0ntlcm91z4.cloudfront.net/user_2zHWFlBUJTNxdG7ciMDQnx3RlZm/hf_20260811_042323_314d92f8-025b-47b5-a7c2-e5c53adfd5d8.mp4) | `../assets/ligou-aprovacao-motion-v1.mp4` | 5,083 s | 1.655.779 | `37ccec78a0c129ed20e9c6efb6a845e4ec303c5ad60442f5ecff78f0110c9d90` |

As entregas são H.264, 640 × 854, 24 fps, `yuv420p`, sem áudio, com faststart e
todos os quadros codificados como keyframes. Isso aumenta o tamanho em relação a um
MP4 comum, mas torna a busca reversível de `currentTime` muito mais previsível.

Cada MP4 também gerou um poster WebP a partir do frame 0. Isso evita o salto de escala
que ocorreria ao trocar uma pose histórica de corpo inteiro por um vídeo com outro
enquadramento:

| Poster | Bytes | SHA-256 |
| --- | ---: | --- |
| `../assets/ligou-atendendo-motion-poster-v1.webp` | 14.134 | `467668d905485209c2567852ed228fe78a83fde6962dbdbfad6ded3ee4955f26` |
| `../assets/ligou-operando-motion-poster-v1.webp` | 18.584 | `c86d371c9df9f7b054993ba42f5158ab533045a9c7d6896cc6f7547a335495c6` |
| `../assets/ligou-aprovacao-motion-poster-v1.webp` | 22.350 | `ac96b7f6b9a43db1279a2f7831248c423582622858b1e65f9a0bc167a4b2cdcd` |

## Tentativa rejeitada

O job `5b4fc1b9-c079-4da8-9fbd-8305dfcbd5fb` ([fonte](https://d8j0ntlcm91z4.cloudfront.net/user_2zHWFlBUJTNxdG7ciMDQnx3RlZm/hf_20260811_035826_5b4fc1b9-c079-4da8-9fbd-8305dfcbd5fb.mp4))
foi rejeitado e não entrou no site. A identidade do personagem não era o problema. O
erro foi de direção: o prompt pediu movimento “subtle”, câmera travada e retorno ao
quadro inicial, produzindo quase nenhuma coreografia; o fundo também veio bege e não
casava com a landing.

Prompt rejeitado:

> 5-second seamless website loop, one locked-off studio product shot. Use the attached
> Ligou robot as the exact identity and starting pose. Preserve the exact dark
> petrol-blue body, rounded black face screen, two mint capsule eyes, thin mint smile,
> single antenna with orange tip, integrated headset, stocky proportions, five-finger
> hands, large feet, orange telephone chest badge, materials and lighting. Only subtle
> purposeful motion: the listening hand gently adjusts the outer headset once, the
> head tilts slightly with attentive listening, the mint eyes pulse softly, then the
> robot returns exactly to the starting pose by the final frame. Solid #fbfcf8
> background. Fixed camera, no zoom, no pan, no cuts, no speech, no audio, no text, no
> extra objects, no redesign, no altered badge, no extra limbs.

## Prompts finais

### Atendendo

> 5-second premium brand hero animation designed for frame-by-frame scroll scrubbing,
> one continuous shot with a bold, readable visual idea. Use the attached Ligou robot
> as the exact character and opening pose; preserve every identity detail: dark
> petrol-blue body, rounded black face screen, two mint capsule eyes, thin mint smile,
> single antenna with orange tip, integrated headset, stocky proportions, five-finger
> hands, large feet and orange telephone chest badge. CHOREOGRAPHY: start on the exact
> listening pose. A clean mint audio waveform enters from the left and travels into
> the headset. The orange phone badge answers with two restrained concentric light
> pulses. The robot reacts clearly: presses the headset, shifts weight forward, turns
> the head about 15 degrees to follow the signal, then sweeps the free hand outward
> into a confident open-palm “go ahead, I’m listening” gesture. The mint eyes briefly
> compress in concentration and reopen. CAMERA: controlled 12% dolly-in plus a smooth
> 12-degree orbit, full robot always in frame, no cuts. End in a strong attentive
> three-quarter pose; no return and no loop. BACKGROUND: perfectly flat solid #f8f8f5
> neutral off-white seamless studio, neutral white balance, absolutely no beige,
> cream, tan, yellow or gray color cast, no horizon line. Premium crisp product
> lighting. Only the mint waveform and orange badge pulses; no text, no speech, no
> audio, no props, no extra character, no redesign, no altered badge, no extra limbs,
> no morphing.

### Operando

> 5-second premium brand hero animation designed for frame-by-frame scroll scrubbing,
> one continuous shot with a bold operational visual idea. Use the attached Ligou
> robot as the exact character and opening pose; preserve every identity detail: dark
> petrol-blue body, rounded black face screen, two mint capsule eyes, thin mint smile,
> single antenna with orange tip, stocky proportions, five-finger hands, large feet
> and orange telephone chest badge. Preserve exactly one tablet in one hand and
> exactly one wrench in the other. CHOREOGRAPHY: start on the exact reference pose.
> The robot looks down and makes one decisive tap on the tablet. From that tap, three
> thin mint light paths sweep around the torso like an organized routing diagram,
> briefly forming simple abstract calendar, memory and tool nodes with no letters or
> numbers. The orange phone badge pulses once; the robot tracks the paths with the
> eyes, turns the wrench wrist with a purposeful quarter rotation, then lifts and
> angles the tablet toward camera as the three paths converge into one clean mint
> confirmation line. CAMERA: smooth 14-degree lateral arc with a restrained 10%
> push-in, full robot always in frame, no cuts. End in a confident ready-to-act
> three-quarter pose; no return and no loop. BACKGROUND: perfectly flat solid #f8f8f5
> neutral off-white seamless studio, neutral white balance, absolutely no beige,
> cream, tan, yellow or gray cast, no horizon line. Premium crisp product lighting. No
> text, no speech, no audio, no extra props, no extra character, no redesign, no
> altered badge, no duplicated tablet or wrench, no extra limbs, no morphing.

### Aprovação

> 5-second premium brand hero animation designed for frame-by-frame scroll scrubbing,
> one continuous shot with a bold approval visual idea. Use the attached Ligou robot
> as the exact character and opening pose; preserve every identity detail: dark
> petrol-blue body, rounded black face screen, two mint capsule eyes, thin mint smile,
> single antenna with orange tip, integrated headset, stocky proportions, five-finger
> hands, large feet and orange telephone chest badge. CHOREOGRAPHY: start on the exact
> calm pose with both hands clasped below the badge. A small orange light pulse rises
> from the chest badge to the antenna tip, then traces one elegant incomplete circular
> decision loop in the air just above the hands. The robot notices it, tilts the head
> with patient curiosity, slowly separates the hands and presents one open palm
> beneath the hovering incomplete loop while the other hand stays near the chest. The
> mint eyes briefly narrow in thought and reopen. The incomplete orange loop gives one
> soft waiting pulse but never closes or confirms. CAMERA: smooth 12-degree arc toward
> a three-quarter angle with a restrained 12% push-in, full robot always in frame, no
> cuts. End holding the open-palm question pose, clearly waiting for the owner; no
> return and no loop. BACKGROUND: perfectly flat solid #f8f8f5 neutral off-white
> seamless studio, neutral white balance, absolutely no beige, cream, tan, yellow or
> gray cast, no horizon line. Premium crisp product lighting. No text, no letters, no
> question-mark glyph, no checkmark, no approval icon, no speech bubble, no speech, no
> audio, no prop, no extra character, no redesign, no altered badge, no extra limbs,
> no morphing.

## Normalização de fundo e encoding

O Seedance não respeitou literalmente o hexadecimal do prompt. Os fundos brutos foram
amostrados como `#F0E8DA` (Atendendo), `#E7DFD6` (Operando) e `#D6D1C6`
(Aprovação). Cada vídeo foi recortado por chroma key sobre uma camada sólida
`#F8F8F5`, redimensionado para 640 × 854 e recodificado com:

```text
libx264 · CRF 23 · preset slow · GOP 1 · yuv420p · faststart · sem áudio
```

O objetivo não foi esconder uma deformação de personagem; foi corrigir a diferença de
temperatura do fundo e preparar o arquivo para busca quadro a quadro.

## Implementação

- `index.html` mantém um único H1 e troca a antiga animação cíclica da hero por três
  frames de vídeo, três mensagens e um indicador de progresso.
- `script.js` converte o progresso da hero em três intervalos e mapeia cada intervalo
  para `video.currentTime`. A seção de operação usa o mesmo mecanismo e funciona nos
  dois sentidos.
- `styles.css` usa uma hero sticky alta (`320svh` desktop, `360svh` até 900 px), sem
  botões de vídeo. O enquadramento usa `contain` porque `cover` escondia justamente as
  mãos, a rota e o arco que explicam as cenas.
- O sticky da hero só é ativado a partir de 700 px de altura. Viewports largas e
  baixas recebem um layout estático natural, sem comprimir copy e mídia.
- O primeiro reveal do MP4 espera `loadeddata` ou `seeked`; o frame 0 não é exposto
  enquanto o navegador ainda busca o tempo solicitado.
- As cenas operacionais inativas não recebem `inert`: os três estados continuam
  disponíveis sequencialmente para tecnologia assistiva.
- `dev-server.mjs` fornece HTTP Range (`206 Partial Content`) no preview local. O
  `python3 -m http.server` testado respondeu `200` ao Range e congelou o scrub nesse
  navegador.
- `prefers-reduced-motion: reduce` remove as fontes dos vídeos e entrega o layout
  estático. Sem JavaScript, os posters e todo o conteúdo continuam acessíveis.

## QA local

- desktop 1280 × 720: os três estados avançam e retrocedem com o scroll;
- mobile emulado 390 × 844 e 320 × 720: sem overflow horizontal, sem controles e CTA
  automático preservado;
- viewports baixas 932 × 430 e 1366 × 600: sticky desativado, sem overlap ou overflow;
- seção de operação: terceiro estado verificado em 79,9% e 93,1% do percurso;
- MP4s: 24 fps, sem áudio, 122 keyframes para 122 quadros em cada arquivo;
- fallback sem JavaScript e modo de movimento reduzido verificados;
- nenhum deploy, push ou publicação realizado.

## Referências técnicas usadas

- [Higgsfield Motion Control](https://higgsfield.ai/create/motion-control)
- [Seedance 2.0 no Higgsfield](https://higgsfield.ai/blog/generating-with-seedance-2-0)
- [Guia oficial de prompts Seedance](https://higgsfield.ai/blog/seedance-prompting-guide)
- [Tutorial oficial de prompting](https://www.youtube.com/watch?v=PsQovs2FwqQ)
- [Modelos no CLI oficial](https://github.com/higgsfield-ai/cli/blob/main/MODELS.md)
- [HTML video — MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)
- [Video performance — web.dev](https://web.dev/learn/performance/video-performance)
