import { describe, expect, test } from "bun:test";

import {
  createRuntimeHarness,
  findAll,
  textContent,
} from "./helpers/runtime-harness.mjs";

const hasClass = (className) => (node) =>
  String(node.props?.className ?? "")
    .split(/\s+/)
    .includes(className);

describe("responsive hero behavior", () => {
  test("selects every responsive video through continuous viewport changes", async () => {
    const harness = await createRuntimeHarness({ width: 767, height: 900 });
    const { HeroVideo } = harness.bindings;

    const assertMedia = (key, source, poster, width, height) => {
      const video = harness.render(HeroVideo);
      expect(video.type).toBe("video");
      expect(video.props["data-hero-media"]).toBe(key);
      expect(video.props.src).toBe(source);
      expect(video.props.poster).toBe(poster);
      expect(video.props.width).toBe(width);
      expect(video.props.height).toBe(height);
    };

    assertMedia(
      "mobile",
      "assets/hero-loop-mobile-1080x1920.mp4",
      "assets/hero-poster-mobile.png",
      1080,
      1920,
    );

    harness.media.update({ width: 768, height: 1024 });
    assertMedia(
      "tabletPortrait",
      "assets/hero-loop-tablet-portrait-1080x1440.mp4",
      "assets/hero-poster-tablet-portrait-1080x1440.png",
      1080,
      1440,
    );

    harness.media.update({ width: 1024, height: 768 });
    assertMedia(
      "tabletLandscape",
      "assets/hero-loop-tablet-landscape-1440x1080.mp4",
      "assets/hero-poster-tablet-landscape-1440x1080.png",
      1440,
      1080,
    );

    harness.media.update({ width: 1199, height: 800 });
    assertMedia(
      "tabletLandscape",
      "assets/hero-loop-tablet-landscape-1440x1080.mp4",
      "assets/hero-poster-tablet-landscape-1440x1080.png",
      1440,
      1080,
    );

    harness.media.update({ width: 1200, height: 800 });
    assertMedia(
      "desktop",
      "assets/hero-loop-1080p.mp4",
      "assets/hero-poster.png",
      1920,
      1080,
    );

    harness.media.update({ width: 1599, height: 700 });
    assertMedia(
      "desktop",
      "assets/hero-loop-1080p.mp4",
      "assets/hero-poster.png",
      1920,
      1080,
    );

    harness.media.update({ width: 1600, height: 800 });
    assertMedia(
      "ultrawide",
      "assets/hero-loop-ultrawide-3440x1476.mp4",
      "assets/hero-poster-ultrawide-3440x1476.webp",
      3440,
      1476,
    );

    expect(harness.media.listenerCount()).toBe(4);
    harness.unmount();
    expect(harness.media.listenerCount()).toBe(0);
  });

  test("keeps one art layer, moves it only for tablet, and hides the secondary CTA only on mobile", async () => {
    const harness = await createRuntimeHarness({ width: 767, height: 900 });
    const { Hero } = harness.bindings;

    let hero = harness.render(Hero);
    expect(findAll(hero, hasClass("hero4-artlayer"))).toHaveLength(1);
    expect(findAll(hero, hasClass("h4-ghostbtn"))).toHaveLength(0);
    expect(findAll(findAll(hero, hasClass("hero4-artslot"))[0], hasClass("hero4-artlayer"))).toHaveLength(0);

    harness.media.update({ width: 768, height: 1024 });
    hero = harness.render(Hero);
    expect(findAll(hero, hasClass("hero4-artlayer"))).toHaveLength(1);
    expect(findAll(hero, hasClass("h4-ghostbtn"))).toHaveLength(1);
    expect(findAll(findAll(hero, hasClass("hero4-artslot"))[0], hasClass("hero4-artlayer"))).toHaveLength(1);

    harness.media.update({ width: 1200, height: 800 });
    hero = harness.render(Hero);
    expect(findAll(hero, hasClass("hero4-artlayer"))).toHaveLength(1);
    expect(findAll(hero, hasClass("h4-ghostbtn"))).toHaveLength(1);
    expect(findAll(findAll(hero, hasClass("hero4-artslot"))[0], hasClass("hero4-artlayer"))).toHaveLength(0);

    harness.unmount();
    expect(harness.media.listenerCount()).toBe(0);
  });
});

describe("interactive and accessible state", () => {
  test("opens one FAQ item at a time and preserves the choice across the mobile breakpoint", async () => {
    const harness = await createRuntimeHarness({ width: 1200, height: 800 });
    const { Faq } = harness.bindings;
    const faqButtons = (tree) => findAll(tree, hasClass("faq-q"));

    let faq = harness.render(Faq);
    expect(faqButtons(faq)).toHaveLength(5);
    expect(faqButtons(faq).map((button) => button.props["aria-expanded"])).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);

    faqButtons(faq)[0].props.onClick();
    faq = harness.render(Faq);
    expect(faqButtons(faq).every((button) => button.props["aria-expanded"] === false)).toBe(true);

    faqButtons(faq)[2].props.onClick();
    faq = harness.render(Faq);
    expect(faqButtons(faq).map((button) => button.props["aria-expanded"])).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);

    harness.media.update({ width: 767, height: 900 });
    faq = harness.render(Faq);
    expect(faqButtons(faq)).toHaveLength(5);
    expect(faqButtons(faq)[2].props["aria-expanded"]).toBe(true);

    harness.unmount();
    expect(harness.media.listenerCount()).toBe(0);
  });

  test("toggles the full mobile report and replay resets the disclosure", async () => {
    const harness = await createRuntimeHarness();
    const { CallDemo } = harness.bindings;
    const reportToggle = (tree) =>
      findAll(tree, (node) => node.props?.id === "lc-rel-toggle")[0];
    const report = (tree) => findAll(tree, (node) => node.props?.id === "lc-relato-full");
    const replay = (tree) => findAll(tree, hasClass("lc-again"))[0];
    const mobileDemo = (tree) => findAll(tree, hasClass("p7m"))[0];

    let demo = harness.render(CallDemo);
    expect(reportToggle(demo).props["aria-controls"]).toBe("lc-relato-full");
    expect(reportToggle(demo).props["aria-expanded"]).toBe("false");
    expect(textContent(reportToggle(demo))).toContain("Ver relato completo");
    expect(report(demo)).toHaveLength(0);
    expect(mobileDemo(demo).props.key).toBe(0);

    reportToggle(demo).props.onClick();
    demo = harness.render(CallDemo);
    expect(reportToggle(demo).props["aria-expanded"]).toBe("true");
    expect(textContent(reportToggle(demo))).toContain("Ocultar relato");
    expect(report(demo)).toHaveLength(1);

    replay(demo).props.onClick();
    demo = harness.render(CallDemo);
    expect(reportToggle(demo).props["aria-expanded"]).toBe("false");
    expect(report(demo)).toHaveLength(0);
    expect(mobileDemo(demo).props.key).toBe(1);
  });
});

describe("intro and reduced-motion fallbacks", () => {
  test("reduced motion skips the intro and renders responsive poster sources", async () => {
    let completions = 0;
    const introHarness = await createRuntimeHarness({ reducedMotion: true });
    const intro = introHarness.render(introHarness.bindings.Intro4, {
      onDone: () => {
        completions += 1;
      },
    });
    expect(intro).toBeNull();
    expect(completions).toBe(1);

    const heroHarness = await createRuntimeHarness({ reducedMotion: true });
    const hero = heroHarness.render(heroHarness.bindings.Hero);
    expect(findAll(hero, (node) => node.type === "picture")).toHaveLength(1);
    expect(findAll(hero, (node) => node.type === heroHarness.bindings.HeroVideo)).toHaveLength(0);
    expect(
      findAll(hero, (node) => node.type === "source").map((source) => source.props.srcSet),
    ).toEqual([
      "assets/hero-poster-mobile.png",
      "assets/hero-poster-tablet-portrait-1080x1440.png",
      "assets/hero-poster-tablet-landscape-1440x1080.png",
      "assets/hero-poster-ultrawide-3440x1476.webp",
    ]);
  });

  test("runs the normal intro timeline and supports an early skip", async () => {
    let completions = 0;
    const timeline = await createRuntimeHarness();
    const props = {
      onDone: () => {
        completions += 1;
      },
    };

    let intro = timeline.render(timeline.bindings.Intro4, props);
    expect(textContent(intro)).toContain("Ligou?");

    timeline.scheduler.advanceBy(900);
    intro = timeline.render(timeline.bindings.Intro4, props);
    expect(textContent(intro)).toContain("Atendido.");

    timeline.scheduler.advanceBy(850);
    intro = timeline.render(timeline.bindings.Intro4, props);
    expect(intro.props.className).toContain("out");

    timeline.scheduler.advanceBy(700);
    expect(completions).toBe(1);

    let skippedCompletions = 0;
    const skipped = await createRuntimeHarness();
    const skippedProps = {
      onDone: () => {
        skippedCompletions += 1;
      },
    };
    intro = skipped.render(skipped.bindings.Intro4, skippedProps);
    intro.props.onClick();
    intro = skipped.render(skipped.bindings.Intro4, skippedProps);
    expect(intro.props.className).toContain("out");
    skipped.scheduler.advanceBy(300);
    expect(skippedCompletions).toBe(1);
    skipped.scheduler.advanceBy(2200);
    expect(skippedCompletions).toBe(1);
  });
});
