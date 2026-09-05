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
      "assets/optimized/hero-poster-mobile.webp",
      1080,
      1920,
    );

    harness.media.update({ width: 768, height: 1024 });
    assertMedia(
      "tabletPortrait",
      "assets/hero-loop-tablet-portrait-1080x1440.mp4",
      "assets/optimized/hero-poster-tablet-portrait-1080x1440.webp",
      1080,
      1440,
    );

    harness.media.update({ width: 1023, height: 768 });
    assertMedia(
      "tabletLandscape",
      "assets/hero-loop-tablet-landscape-1440x1080.mp4",
      "assets/optimized/hero-poster-tablet-landscape-1440x1080.webp",
      1440,
      1080,
    );

    harness.media.update({ width: 1023, height: 800 });
    assertMedia(
      "tabletLandscape",
      "assets/hero-loop-tablet-landscape-1440x1080.mp4",
      "assets/optimized/hero-poster-tablet-landscape-1440x1080.webp",
      1440,
      1080,
    );

    harness.media.update({ width: 1024, height: 800 });
    assertMedia(
      "desktop",
      "assets/hero-loop-1080p.mp4",
      "assets/optimized/hero-poster.webp",
      1920,
      1080,
    );

    for (const width of [1199, 1200, 1280, 1440, 1920]) {
      harness.media.update({ width, height: 1080 });
      assertMedia("desktop", "assets/hero-loop-1080p.mp4", "assets/optimized/hero-poster.webp", 1920, 1080);
    }

    harness.media.update({ width: 1599, height: 700 });
    assertMedia(
      "desktop",
      "assets/hero-loop-1080p.mp4",
      "assets/optimized/hero-poster.webp",
      1920,
      1080,
    );

    harness.media.update({ width: 1600, height: 800 });
    assertMedia(
      "ultrawide",
      "assets/hero-loop-ultrawide-3440x1476.mp4",
      "assets/optimized/hero-poster-ultrawide-3440x1476.webp",
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

    harness.media.update({ width: 1024, height: 800 });
    hero = harness.render(Hero);
    expect(findAll(hero, hasClass("hero4-artlayer"))).toHaveLength(1);
    expect(findAll(hero, hasClass("h4-ghostbtn"))).toHaveLength(1);
    expect(findAll(findAll(hero, hasClass("hero4-artslot"))[0], hasClass("hero4-artlayer"))).toHaveLength(0);

    harness.unmount();
    expect(harness.media.listenerCount()).toBe(0);
  });
});

describe("interactive and accessible state", () => {
  test("customer demo promises only truthful team contact", async () => {
    const harness = await createRuntimeHarness();
    const demo = harness.render(harness.bindings.CallDemo);
    const visible = textContent(demo);
    expect(visible).toContain("The team will contact you as soon as they confirm.");
    expect(visible).not.toMatch(/\b(?:sms|text message|receive a text)\b/i);
  });

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

  test("mobile report disclosure remains usable without replay controls", async () => {
    const harness = await createRuntimeHarness();
    const { CallDemo } = harness.bindings;
    const toggle = tree => findAll(tree,node=>node.props?.id==='lc-rel-toggle')[0];
    const report = tree => findAll(tree,node=>node.props?.id==='lc-relato-full');
    let demo=harness.render(CallDemo);
    expect(toggle(demo).props['aria-controls']).toBe('lc-relato-full');
    expect(report(demo)).toHaveLength(0);
    toggle(demo).props.onClick();demo=harness.render(CallDemo);
    expect(toggle(demo).props['aria-expanded']).toBe('true');
    expect(textContent(toggle(demo))).toContain('Ocultar relato');
    expect(report(demo)).toHaveLength(1);
    harness.media.update({width:390,height:844});demo=harness.render(CallDemo);
    expect(report(demo)).toHaveLength(1);
    toggle(demo).props.onClick();demo=harness.render(CallDemo);
    expect(report(demo)).toHaveLength(0);
  });

  test("demo headers retain waveforms without replay buttons at every layout", async () => {
    const harness = await createRuntimeHarness();
    for(const width of [320,919,1440]) {
      harness.media.update({width,height:900});
      const demo=harness.render(harness.bindings.CallDemo);
      expect(findAll(demo,hasClass('p7-again'))).toHaveLength(0);
      expect(findAll(demo,hasClass('lc-again'))).toHaveLength(0);
      expect(findAll(demo,hasClass('p7-wf'))).toHaveLength(1);
      expect(findAll(demo,hasClass('lc-wf'))).toHaveLength(1);
      expect(findAll(demo,hasClass('p7-i'))).toHaveLength(7);
    }
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
      "assets/optimized/hero-poster-mobile.webp",
      "assets/optimized/hero-poster-tablet-portrait-1080x1440.webp",
      "assets/optimized/hero-poster-tablet-landscape-1440x1080.webp",
      "assets/optimized/hero-poster-ultrawide-3440x1476.webp",
    ]);
  });

  test("runs the shortened intro timeline (0.9s) and hands off in one step", async () => {
    let completions = 0;
    const timeline = await createRuntimeHarness();
    const props = {
      onDone: () => {
        completions += 1;
      },
    };

    let intro = timeline.render(timeline.bindings.Intro4, props);
    expect(intro.type).toBe("button");
    expect(intro.props["aria-label"]).toBe("Pular introdução");
    expect(textContent(intro)).toContain("Ligou?");
    expect(findAll(intro, hasClass("acc"))).toHaveLength(0);

    timeline.scheduler.advanceBy(450);
    intro = timeline.render(timeline.bindings.Intro4, props);
    expect(textContent(intro)).toContain("Atendido.");
    expect(findAll(intro, hasClass("acc"))).toHaveLength(0);
    expect(intro.props.className).not.toContain("out");
    expect(completions).toBe(0);

    timeline.scheduler.advanceBy(450);
    intro = timeline.render(timeline.bindings.Intro4, props);
    expect(intro.props.className).toContain("out");
    expect(completions).toBe(1);

    timeline.scheduler.advanceBy(2000);
    expect(completions).toBe(1);
  });

  test("intro skips immediately on click, Enter, Space and Escape, and never fires twice", async () => {
    for (const trigger of ["click", "Enter", " ", "Escape"]) {
      let skippedCompletions = 0;
      const skipped = await createRuntimeHarness();
      const skippedProps = {
        onDone: () => {
          skippedCompletions += 1;
        },
      };
      let intro = skipped.render(skipped.bindings.Intro4, skippedProps);
      let prevented = false;
      if (trigger === "click") intro.props.onClick();
      else intro.props.onKeyDown({ key: trigger, preventDefault: () => { prevented = true; } });
      intro = skipped.render(skipped.bindings.Intro4, skippedProps);
      expect(intro.props.className).toContain("out");
      expect(skippedCompletions).toBe(1);
      if (trigger !== "click") expect(prevented).toBe(true);
      skipped.scheduler.advanceBy(2500);
      expect(skippedCompletions).toBe(1);
    }

    const ignored = await createRuntimeHarness();
    let ignoredCompletions = 0;
    let intro = ignored.render(ignored.bindings.Intro4, { onDone: () => { ignoredCompletions += 1; } });
    intro.props.onKeyDown({ key: "Tab", preventDefault: () => {} });
    intro = ignored.render(ignored.bindings.Intro4, { onDone: () => { ignoredCompletions += 1; } });
    expect(intro.props.className).not.toContain("out");
    expect(ignoredCompletions).toBe(0);
  });
});


test("capability scene changes only its illustrated example and preserves future limits", async () => {
  const harness = await createRuntimeHarness();
  const {Faz} = harness.bindings;
  let scene=harness.render(Faz);
  const tasks=tree=>findAll(tree,node=>node.type==='button' && node.props['aria-controls']==='capability-example');
  expect(tasks(scene)).toHaveLength(6);
  expect(tasks(scene).filter(node=>node.props['aria-pressed'])).toHaveLength(1);
  tasks(scene)[1].props.onClick();scene=harness.render(Faz);
  expect(tasks(scene)[1].props['aria-pressed']).toBe(true);
  expect(textContent(findAll(scene,node=>node.props?.id==='capability-example')[0])).toContain('Agenda quando autorizado. Nas exceções, pede sua decisão.');
  tasks(scene)[5].props.onClick();scene=harness.render(Faz);
  expect(textContent(scene)).toContain('Em desenvolvimento. Esta cena não faz ligações.');
  expect(findAll(scene,hasClass('capability-status'))).toHaveLength(2);
  expect(findAll(scene,node=>node.type==='a'||node.type==='form'||node.type==='audio')).toHaveLength(0);
  harness.media.update({width:390,height:844});scene=harness.render(Faz);
  expect(tasks(scene)[5].props['aria-pressed']).toBe(true);

});
