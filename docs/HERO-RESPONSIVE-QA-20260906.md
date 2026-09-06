# Hero responsive correction — 2026-09-06

## Cause and change

The reported preview was 4188 (the older responsive-consistency worktree), at 816 × 791 CSS pixels with device-pixel-ratio 2. The same defect existed in the newer 4189 preview. Between 768 and 1023px, the old 47%/53% columns shrank the landscape video to 366 × 275px while a fixed minimum kept the hero 720px tall. Percent-based columns also allocated the gap outside their combined 100% width.

The corrected compact layout uses 37fr/63fr after gap allocation, content-driven height, and wrapping buttons. At the reported viewport the frame is now 459 × 344px inside a 610px hero. Its width increases 25%, and its share of hero height increases from 38% to 56%. The same two-column composition is retained.

Visual inspection also exposed excessive vertical cropping above 1600px: at 3440 × 1440, the original video was 1470px high inside an 840px hero. A shared frame-width variable now bounds and centers the wide text/art composition according to hero height and the selected asset aspect ratio. The full wide video fits in the frame.

Only hero CSS and the corresponding HTML hash change in the runtime. Five original videos/posters, branding, slogan, runtime behavior, voice and backend are preserved. The hero patch is applied to both local previews. No production publishing occurred.

## Verification

- Red reproduction: 816 × 791 failed the added hero-scale behavior check before the CSS change.
- Current 4189 page: **3,521/3,521** individual CSS widths from 320 through 3840 at 900px height passed.
- Current 4189 page: **312/312** additional width/height/orientation cases passed: 44 widths at six heights (360, 600, 791, 900, 1080, 1440), plus portrait/landscape and 2:1 boundary cases.
- Checks cover exact viewport, whole-page text bounds, scene card contents, navigation/price CTA bounds, scene columns/connectors, capability selection/labels, correct responsive video, compact hero prominence, and wide video containment. No sales requests or third-party resources were observed in the QA iframe.
- Visual review included 390 × 844, 816 × 791, 820 × 1180, 1024 × 768, 1440 × 900 and the complete scaled 3440 × 1440 layout.
- Reduced motion: all five media families select the corresponding poster with no hero video. No-JavaScript mobile fallback remains readable.
- Nine task-selection interactions and three FAQ keyboard-open checks passed at 390, 816 and 1280px. Console review showed no errors.
- Current landing `bun run check`: **90 tests passed**, secret scanner clean, original export and 85 pinned runtime files verified.
- Legacy 4188: **312/312** hero/media/navigation cases passed; this is not a whole-page revalidation of its older sections.
- Ten extra geometry checks covered common phone/tablet shapes, 3840 × 2160, and 4096px-wide layouts. The browser capped requested 5120px widths at 4096px; no 5120px coverage is claimed.
- Legacy 4188 landing `bun run check`: **15 tests passed**, secret scanner clean, 53 pinned runtime files verified. Its excluded brand-guide files were restored from Git to allow the existing scanner to run; their contents were not modified.

These are Chromium browser/emulated viewport checks, not tests on every physical device or Safari/Firefox. An exhaustive width sweep does not cover every possible height, browser zoom, OS or interaction state. Visual checks and scale checks complement bounds checks; the earlier bounds-only QA missed this defect.

## Review and repeat

- Current visual comparison: `http://127.0.0.1:4189/output/hero-qa-20260906/review.html`
- Reusable current whole-page QA: `http://127.0.0.1:4189/tests/browser/hero-responsive-qa.html`
- Reported older preview comparison: `http://127.0.0.1:4188/output/hero-qa-20260906/review.html`
- Legacy QA page is explicitly scoped to hero/media/navigation, not the older page's superseded sections.

Select **Check reported 816 × 791**, **Run full-page checks** (the 312-case matrix), or **Sweep every width 320–3840**. The QA page pauses video and completes reveal states for deterministic geometry checks; verify real playback separately. It never enables microphone or starts a sales session.

Sanitized JSON results, before/after screenshots, original HTML and test logs are in `output/hero-qa-20260906/` in each worktree. The current worktree's `matrix.json` and `sweep.json` are the final full-page results; `sweep-before-wide-guard.json` is an incomplete intermediate run and is not completion evidence. Saved original HTML uses a root base URL; media assets are shared unchanged.
