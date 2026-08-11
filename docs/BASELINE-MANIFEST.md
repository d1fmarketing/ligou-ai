# Ligou — manifesto de integridade dos snapshots visuais

**Algoritmo:** SHA-256

**Escopo:** artefatos renderizados da página, contrato de design, copy-fonte e assets de
marca necessários para reproduzir a rodada.

Os hashes identificam cada conjunto factual independentemente do histórico Git. README e
documentos de processo ficam fora porque podem evoluir sem alterar a página renderizada.

Cada rodada visual ganha o seu próprio bloco. Hashes de um snapshot anterior nunca são
reescritos — eles continuam descrevendo o que aquele snapshot era.

---

## Demo Hero Restore — candidato local

**Data:** 11 de agosto de 2026

**Base Git:** Higgsfield Motion no commit `ee9f685`

**O que mudou:** ver [`CHANGELOG-DEMO-HERO-RESTORE.md`](CHANGELOG-DEMO-HERO-RESTORE.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 22.410 | `9345bc119cc181e3fe3185174f071a43192436c960a75d1ca5a50674f0c3f959` |
| `styles.css` | 38.895 | `cabd2ad3d419ce5b6681b357b84d56914d62e68a83a8df8e4190a7ac24e945fe` |
| `script.js` | 13.936 | `bff483c7237b0dfcd95a472a06929f269ebe29078671be402c8cc39b7125970d` |
| `.impeccable.md` | 8.096 | `f2ccc1aac700539af3c2b16d4aea78ea9cdedcff283d2019fb2751342862745c` |
| `docs/source/LIGOU-COPY-V4-WORKING.md` | 7.857 | `6ae42b42c6774865f09b25537b4cdc3e4c4b121c55d51f5ba58b503955bd5891` |

Os MP4s, posters, logos, fontes e WebPs não foram alterados; continuam identificados
nos blocos Higgsfield Motion, Claude R2 e Visual 4. Esta rodada remove os vídeos apenas
da hero, preserva os três na operação e recupera o contrato de demo configurável da
V1 sem inventar um número ou backend.

O snapshot descreve um frontend local verificado, não um deploy. Telefone, checkout,
Termos, Privacidade, inventário Founding e backend continuam como gates absolutos.

---

## Higgsfield Motion — candidato local

**Data:** 10 de agosto de 2026

**Base Git:** Claude R2 no commit `741a147`

**O que mudou:** ver [`CHANGELOG-HIGGSFIELD-MOTION.md`](CHANGELOG-HIGGSFIELD-MOTION.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 22.688 | `7f6d0f7010cd8102288bec869e15c141ea5c1d3d95248fa3c23b00f5ef371d47` |
| `styles.css` | 48.498 | `e559242c078b606f7017170ab93f1e91b672bc5d0d5ae59ff549cb291bbebbd0` |
| `script.js` | 15.616 | `b03a09a8a6b1f4b9a5644cef957dea9f4e145bd2b8700ecdd3c4dc34b48693c1` |
| `dev-server.mjs` | 2.655 | `11b4946750153b61eeaf523de0d7f37b215bf1bd3ab0a48991869a1a8a793c53` |
| `assets/ligou-atendendo-motion-v1.mp4` | 1.367.099 | `78462ac089c5ca89a57420329df715587501bd08c4000746bddd66a0985c1f14` |
| `assets/ligou-operando-motion-v1.mp4` | 1.322.696 | `c5309c90611abb4dddb1cc3bc1549d37953d35e53ddfc251a8fddc83b0c0dd7b` |
| `assets/ligou-aprovacao-motion-v1.mp4` | 1.655.779 | `37ccec78a0c129ed20e9c6efb6a845e4ec303c5ad60442f5ecff78f0110c9d90` |
| `assets/ligou-atendendo-motion-poster-v1.webp` | 14.134 | `467668d905485209c2567852ed228fe78a83fde6962dbdbfad6ded3ee4955f26` |
| `assets/ligou-operando-motion-poster-v1.webp` | 18.584 | `c86d371c9df9f7b054993ba42f5158ab533045a9c7d6896cc6f7547a335495c6` |
| `assets/ligou-aprovacao-motion-poster-v1.webp` | 22.350 | `ac96b7f6b9a43db1279a2f7831248c423582622858b1e65f9a0bc167a4b2cdcd` |

Os arquivos de marca, OG, copy e WebPs permanecem identificados no bloco Claude R2
ou Visual 4. Esta rodada substitui apenas a composição da hero, acrescenta a camada de
scrub às três cenas operacionais e inclui os derivados de vídeo. Nenhum hash histórico
foi reescrito.

O snapshot descreve um frontend local verificado, não um deploy. Telefone, checkout,
Termos, Privacidade, inventário Founding e backend continuam como gates absolutos.

---

## Claude R2 — candidato local integrado

**Data:** 10 de agosto de 2026

**Base Git:** Visual 4 no commit `7279041`

**O que mudou:** ver [`CHANGELOG-CLAUDE-R2.md`](CHANGELOG-CLAUDE-R2.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 20.895 | `ac8bc7f563ef13339eed5e2bb5facd016c250fe79f8d38fad4b19b63c1dfecf9` |
| `styles.css` | 38.489 | `7f575ecf43f647272263862ec879f847a21cca2ee7748ff3fee631d34a0c8f41` |
| `script.js` | 9.533 | `85ec7e55bdd89412939bb50eded460953933150cd1824fb6d4173aca20a9845d` |
| `.impeccable.md` | 7.854 | `33e76f455adafdde630004ed4b01982e20d6f2a80312cef3ed4ae9cf153bedc3` |
| `assets/logo-mark.svg` | 423 | `7cce8b971bd56d261ef853d3caa77c94e9ec7024d36d01c7788afe8d53d11e71` |
| `assets/logo-line.svg` | 368 | `7a1a424afd3f7379e46dea5e59875f5f67d766b504e55cf76361690cb92c6331` |
| `og-card.svg` | 2.881 | `7c86447906209d9c7be8619ffd0db13e9b4002b0b8bbe36a45812d421e2676af` |
| `og-ligou.png` | 152.576 | `5b7d8aacbd5a8f94d5bee5d5467ba1e52613ff5fafd2f6c553c13604b0ab2987` |
| `docs/source/LIGOU-COPY-V4-WORKING.md` | 7.719 | `c8800c60a188e19fa043a2411d1c18c155d12273ed8476526489f07978811005` |
| `assets/ligou-atendendo-v1.webp` | 29.646 | `8190db2ca191acacf052461522c9fc6b6710a55232eca4b1b1344a8e3db9e336` |
| `assets/ligou-operando-v1.webp` | 30.684 | `8f9b6661a6fd5837b07b867afb0ca7a58c348293702b8bf8790c5ed9d1d0343e` |

`script.js`, `.impeccable.md`, OG, copy e poses mantêm os hashes do Visual 4. A nova
execução modifica somente a composição da hero, a marca ativa e os respectivos
estilos. Os demais assets necessários para reproduzir as seções abaixo do fold
continuam identificados no bloco Visual 4.

O recibo externo da fonte Claude R2 é
`/Users/d1f/Downloads/Ligou Design System.zip`, 3.696.405 bytes, SHA-256
`3e4319ddf66eaebe1bf2ea1f6ed30e402fb584c9b48e8342d30a291492374238`.
O ZIP não foi copiado para a raiz porque contém duplicatas e resíduos de rodadas
anteriores; o changelog registra exatamente o que foi portado e rejeitado.

---

## Visual 4 — candidato local

**Data:** 10 de agosto de 2026
**O que mudou:** ver [`CHANGELOG-VISUAL-4.md`](CHANGELOG-VISUAL-4.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 20.832 | `053d054b6a4bc6235bd8e2af7bb104ceb389d81b3773b1615e77c03c426358f4` |
| `styles.css` | 38.647 | `dc0bab151ad6902f066dcad31e9ec9f1c985fd12c14a9a937423ae49cabb6dea` |
| `script.js` | 9.533 | `85ec7e55bdd89412939bb50eded460953933150cd1824fb6d4173aca20a9845d` |
| `.impeccable.md` | 7.854 | `33e76f455adafdde630004ed4b01982e20d6f2a80312cef3ed4ae9cf153bedc3` |
| `favicon.svg` | 399 | `2543c946df078df9df4e668072825595d11c3291c7f50f75971bbb45413dc59f` |
| `og-card.svg` | 2.881 | `7c86447906209d9c7be8619ffd0db13e9b4002b0b8bbe36a45812d421e2676af` |
| `og-ligou.png` | 152.576 | `5b7d8aacbd5a8f94d5bee5d5467ba1e52613ff5fafd2f6c553c13604b0ab2987` |
| `docs/source/LIGOU-COPY-V2.1-FROZEN.md` | 14.381 | `900549bf547fcd9d25270a31d4ff768d47e7e7525ed400d3904828ab52bd129f` |
| `docs/source/LIGOU-COPY-V3-WORKING.md` | 6.788 | `8d3f9d91da0d30dccb8abdf6305a44fef049809940962a0c18e3445d5c2a9d68` |
| `docs/source/LIGOU-COPY-V4-WORKING.md` | 7.719 | `c8800c60a188e19fa043a2411d1c18c155d12273ed8476526489f07978811005` |
| `assets/ligou-agent-v1.webp` | 34.214 | `fb8ea8ad6a61f646a233124a847bbbce14cd1deee6aa2692c20dc32cfd344c03` |
| `docs/brand/ligou-agent-v1-source.png` | 1.151.876 | `081373ef0c7d4874a482052f2120259f4889037a50084017366f84cbc2ae2046` |
| `docs/brand/ligou-brand-board-v1-approved.png` | 1.384.413 | `11a023067474e671bf13026f2e8e5f0cf35c06fb47c2cdf54ddb21dffef071da` |
| `assets/ligou-atendendo-v1.webp` | 29.646 | `8190db2ca191acacf052461522c9fc6b6710a55232eca4b1b1344a8e3db9e336` |
| `assets/ligou-operando-v1.webp` | 30.684 | `8f9b6661a6fd5837b07b867afb0ca7a58c348293702b8bf8790c5ed9d1d0343e` |
| `assets/ligou-aprovacao-v1.webp` | 28.412 | `b1a284345e4f6a42abcf8a908d78e5b621397fbc4dd27467ffadf321244a4387` |
| `docs/brand/masters/ligou-atendendo-v1-master.webp` | 389.006 | `dfdad409b9653449898c0a2b1300caf46ecd58180db90181b133dc9167c8ae92` |
| `docs/brand/masters/ligou-operando-v1-master.webp` | 417.022 | `6b9bfbd8a6ef3e628264ed5f5a729e8153f8d11c72f1935e3072ead5a1234e51` |
| `docs/brand/masters/ligou-aprovacao-v1-master.webp` | 380.930 | `0bb5e49bd0f77a94d7e30d86be628a27ffbf0356856f66358fddc76ecac73b34` |
| `assets/fonts/familjen-grotesk-600.ttf` | 56.520 | `457dcae83d47907c29376aee2480531b3f33c0a3ec97f17a1983a1e8be3bcc94` |
| `assets/fonts/archivo-700.ttf` | 111.948 | `bed60488c2f5c0b24e01d931760b6f3e9a82619dcd081ed9bff643d9f4fd9e3d` |

A v2.1 continua congelada como fonte pública histórica. V3 e V4 permanecem
`WORKING`; o snapshot congela a execução visual, não promove a copy candidata a texto
final. A board aprovada, o retrato anterior e os três masters V4 preservam a linhagem
visual; os WebPs de 640 × 857 são as entregas efetivamente carregadas pela página.

O gate final registrou Brief 10,0, System 9,2 e Craft 9,1, com `critique` 36,5/40 e
zero P0/P1. Publicação continua bloqueada até telefone, checkout, Termos, Privacidade,
inventário Founding, backend e infraestrutura pública serem reais.

---

## Visual 3 — candidato local

**Data:** 10 de agosto de 2026
**O que mudou:** ver [`CHANGELOG-VISUAL-3.md`](CHANGELOG-VISUAL-3.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 43.076 | `a1c95a73e677db85e038d2bd11de70eaf29bb4a7cd51545d77a19672f0c59362` |
| `styles.css` | 65.055 | `336933ab6e971d78e367af1c2614c5dd3475b6307df45114d25248a723f67866` |
| `script.js` | 7.628 | `f136900423956c7ae542f3235396b4c03ef377be03864e1d4691a0d0346141ac` |
| `.impeccable.md` | 6.350 | `1daaf3fd6e3ea9f62ff6793f1f11487751a65c70c27d67c345ac04f3386f1735` |
| `favicon.svg` | 399 | `2543c946df078df9df4e668072825595d11c3291c7f50f75971bbb45413dc59f` |
| `og-card.svg` | 3.120 | `c55a9016eeae343d4da27236acd092bbf93929d89566053e5b103551dadea953` |
| `og-ligou.png` | 182.701 | `ea851bc9697f51ae17cd3ece006b8eff3c6f8137bfea865adb4e94e6ddec2daa` |
| `docs/source/LIGOU-COPY-V2.1-FROZEN.md` | 14.381 | `900549bf547fcd9d25270a31d4ff768d47e7e7525ed400d3904828ab52bd129f` |
| `docs/source/LIGOU-COPY-V3-WORKING.md` | 6.788 | `8d3f9d91da0d30dccb8abdf6305a44fef049809940962a0c18e3445d5c2a9d68` |
| `assets/ligou-agent-v1.webp` | 34.214 | `fb8ea8ad6a61f646a233124a847bbbce14cd1deee6aa2692c20dc32cfd344c03` |
| `docs/brand/ligou-agent-v1-source.png` | 1.151.876 | `081373ef0c7d4874a482052f2120259f4889037a50084017366f84cbc2ae2046` |
| `docs/brand/ligou-brand-board-v1-approved.png` | 1.384.413 | `11a023067474e671bf13026f2e8e5f0cf35c06fb47c2cdf54ddb21dffef071da` |
| `assets/fonts/familjen-grotesk-600.ttf` | 56.520 | `457dcae83d47907c29376aee2480531b3f33c0a3ec97f17a1983a1e8be3bcc94` |
| `assets/fonts/archivo-700.ttf` | 111.948 | `bed60488c2f5c0b24e01d931760b6f3e9a82619dcd081ed9bff643d9f4fd9e3d` |

A v2.1 continua congelada como base histórica. A fonte V3 registra a direção aprovada,
mas permanece `WORKING` até a aprovação editorial da candidata. Isso impede que um
snapshot visual seja confundido com copy final ou com prova de disponibilidade pública.

---

## Visual 2 — checkpoint histórico

**Data:** 10 de agosto de 2026
**O que mudou:** ver [`CHANGELOG-VISUAL-2.md`](CHANGELOG-VISUAL-2.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 33.808 | `38936936d607f93cc21aa6fc38e6d9b46d1a41ba43a9b486f8c6b338312205f9` |
| `styles.css` | 54.021 | `5b266c822dcbf721a461f7d19e527d051cfbefc41ac0d26526d4daa91a66222d` |
| `script.js` | 7.130 | `579a241d0fd103ce924b9b20032bf7352c70d9efcbe1d68d48623c186adda1d5` |
| `.impeccable.md` | 4.217 | `f25ddd41d30b07fd34144dec4792c296d30eb1993902d549995fedc020952a46` |
| `favicon.svg` | 399 | `2543c946df078df9df4e668072825595d11c3291c7f50f75971bbb45413dc59f` |
| `og-card.svg` | 3.706 | `581081c0d9bfa9a05d4c21546fc345b68619f3d3fc4b41f90b17cf80a5dbb32e` |
| `og-ligou.png` | 79.003 | `ab534aec960bb53b50098e97293cb245ef8959edf145073b2c716d22713c9154` |
| `docs/source/LIGOU-COPY-V2.1-FROZEN.md` | 14.381 | `900549bf547fcd9d25270a31d4ff768d47e7e7525ed400d3904828ab52bd129f` |

Favicon, card social e copy-fonte têm hash idêntico ao do visual 1: esta rodada não os tocou.

O card social `og-ligou.png` ainda reflete a tipografia do visual 1. Ele precisa ser
regerado a partir de `og-card.svg` antes de publicar, para não divergir da página.

---

## Visual 1 — superado

**Data:** 10 de agosto de 2026
**Registro:** [`LANDING-PAGE-BASELINE-VISUAL-1.md`](LANDING-PAGE-BASELINE-VISUAL-1.md)

| Arquivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 31.700 | `c55552b73b2963aa39896783bc25b5c8522f1e46e56c76c037f21041ecc65600` |
| `styles.css` | 45.515 | `89910e65add394e8843cf787d68b6c4dc38bcca32fe1c29e74835c1d3dd1e462` |
| `script.js` | 3.939 | `ae5ecbcb93b9ef5c44907a43ad713b6cc0669ce03bbbaf411fe085e6108dcd3f` |
| `favicon.svg` | 399 | `2543c946df078df9df4e668072825595d11c3291c7f50f75971bbb45413dc59f` |
| `og-card.svg` | 3.706 | `581081c0d9bfa9a05d4c21546fc345b68619f3d3fc4b41f90b17cf80a5dbb32e` |
| `og-ligou.png` | 79.003 | `ab534aec960bb53b50098e97293cb245ef8959edf145073b2c716d22713c9154` |
| `docs/source/LIGOU-COPY-V2.1-FROZEN.md` | 14.381 | `900549bf547fcd9d25270a31d4ff768d47e7e7525ed400d3904828ab52bd129f` |

## Proveniência da copy

O anexo original recebido na conversa tinha SHA-256:

`9d3bb18a8844d783a4a4c26c212622924af483d582d5243c93db8571b8d53c0c`

A cópia arquivada no projeto normaliza apenas a quebra de linha no final do arquivo;
`diff -u` não encontrou outra diferença de conteúdo.

## Como verificar

Para verificar o Claude R2, execute na raiz do projeto:

```bash
shasum -a 256 index.html styles.css script.js .impeccable.md \
  assets/logo-mark.svg assets/logo-line.svg og-card.svg og-ligou.png \
  docs/source/LIGOU-COPY-V4-WORKING.md \
  assets/ligou-atendendo-v1.webp assets/ligou-operando-v1.webp
```

Para verificar o Visual 4 histórico, abra um checkout ou worktree isolado do commit
`7279041` e só então execute o bloco abaixo. No worktree Claude R2, `index.html` e
`styles.css` são deliberadamente diferentes.

```bash
shasum -a 256 index.html styles.css script.js .impeccable.md favicon.svg og-card.svg og-ligou.png \
  docs/source/LIGOU-COPY-V2.1-FROZEN.md docs/source/LIGOU-COPY-V3-WORKING.md \
  docs/source/LIGOU-COPY-V4-WORKING.md \
  assets/ligou-agent-v1.webp docs/brand/ligou-agent-v1-source.png \
  docs/brand/ligou-brand-board-v1-approved.png assets/ligou-atendendo-v1.webp \
  assets/ligou-operando-v1.webp assets/ligou-aprovacao-v1.webp \
  docs/brand/masters/ligou-atendendo-v1-master.webp \
  docs/brand/masters/ligou-operando-v1-master.webp \
  docs/brand/masters/ligou-aprovacao-v1-master.webp \
  assets/fonts/familjen-grotesk-600.ttf \
  assets/fonts/archivo-700.ttf
```

Qualquer diferença indica que o arquivo já não corresponde ao bloco declarado e exige
um novo snapshot, não a edição silenciosa destes hashes.
