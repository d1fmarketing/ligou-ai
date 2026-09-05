# Responsive repair after the 919px screenshot

Baseline: `827c9e5`. Preview: http://127.0.0.1:4189/#diferenca
Comparison: http://127.0.0.1:4189/output/responsive-repair/comparacao.html

## What was missed

The previous validation covered the new capabilities scene and horizontal page overflow, but did not catch the old intermediate-width layout of “Como trabalha”. Calling that a complete responsive review was too broad.

The user’s preview tab measured 919 CSS pixels wide (DPR 2): Scene had one 640px column and two detached 10×36px orange bars. The stored baseline reproduced failures for step columns and detached connectors. The actual header CTA was inside the viewport (right 872px); no navigation defect was demonstrated, so its design was preserved.

## Correction

- At 768–1023px, preserve the three-step composition. Adjust internal spacing, portrait/waveform placement, rule rows and approval controls to fit without clipping. Keep the established dark-to-light scene and readable heading area.
- At 767px and below, use centered single-column cards capped at 480px with compact padding, a stable identity row, and no detached orange bars or floating badge.
- Keep 1024px+ existing rules unchanged.
- Add one scoped stylesheet, `assets/responsive-scene.css`, and its runtime hash. No voice, backend, offer, hero assets or main-site publication changes.

## Verification

The reusable browser fixture is `tests/browser/responsive-check.html`, served at http://127.0.0.1:4189/tests/browser/responsive-check.html. Click **Run full-page checks**. It uses one isolated iframe and does not activate sales controls. **Saved baseline** is an optional local review artifact.

All 22 widths passed: 320, 360, 390, 430, 600, 601, 673, 767, 768, 820, 900, 919, 920, 921, 1023, 1024, 1123, 1280, 1440, 1920, 2560, 3440. Height 900px. Checks cover actual iframe width; visible text bounds throughout the page; text containment inside Scene cards; header/client/pricing CTA bounds; step composition; detached connectors; capability controls/status labels; absence of external or sales requests.

At 919px: three 269.34px cards instead of one 640px card. At 390px: 331px cards. No visible text overflow or card text overflow in any tested width. Do not equate this with testing physical phones or every possible browser/zoom setting.

Visual review included Scene at 390, 768 and 919px, plus phone hero, capabilities and price. Snapshot review uses completed reveal states to compare content without animation timing obscuring it. The geometry checks inspect every section, regardless of scroll position.

`bun run check`: 62 Bun tests plus 12 Node tests passed; secret scan clean; 85 pinned runtime files and 46 references verified. Independent CSS review found no concrete cascade/containment regressions.

Detailed results, source baseline, comparisons and test log are in `output/responsive-repair/`. For later layout changes, run this whole-page check and inspect the affected sections at the nearest breakpoint on both sides, in addition to the existing tests.
