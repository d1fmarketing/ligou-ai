import { readFile } from "node:fs/promises";
import vm from "node:vm";

const applicationUrl = new URL("../../src/runtime/ligou-app9.jsx", import.meta.url);

function createMediaEnvironment(initialViewport) {
  let viewport = { ...initialViewport };
  const queries = new Map();

  const evaluate = (query) => {
    if (query === "(max-width: 767px)") return viewport.width <= 767;
    if (query === "(max-width: 1199px)") return viewport.width <= 1199;
    if (query === "(orientation: portrait)") return viewport.height >= viewport.width;
    if (query === "(min-width: 1600px) and (min-aspect-ratio: 2/1)") {
      return viewport.width >= 1600 && viewport.width / viewport.height >= 2;
    }

    throw new Error(`Unsupported media query in test harness: ${query}`);
  };

  const matchMedia = (query) => {
    if (!queries.has(query)) {
      const listeners = new Set();
      const mediaQueryList = {
        media: query,
        matches: evaluate(query),
        addEventListener(type, listener) {
          if (type === "change") listeners.add(listener);
        },
        removeEventListener(type, listener) {
          if (type === "change") listeners.delete(listener);
        },
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
        dispatch() {
          const nextMatches = evaluate(query);
          if (nextMatches === mediaQueryList.matches) return;
          mediaQueryList.matches = nextMatches;
          for (const listener of [...listeners]) {
            listener({ matches: nextMatches, media: query });
          }
        },
        listenerCount() {
          return listeners.size;
        },
      };
      queries.set(query, mediaQueryList);
    }

    return queries.get(query);
  };

  return {
    matchMedia,
    update(nextViewport) {
      viewport = { ...viewport, ...nextViewport };
      for (const query of queries.values()) query.dispatch();
    },
    listenerCount() {
      return [...queries.values()].reduce((total, query) => total + query.listenerCount(), 0);
    },
  };
}

function createScheduler() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();

  return {
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      tasks.set(id, { callback, at: now + Number(delay) });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    advanceBy(milliseconds) {
      const target = now + milliseconds;

      while (true) {
        const nextTask = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!nextTask) break;

        const [id, task] = nextTask;
        tasks.delete(id);
        now = task.at;
        task.callback();
      }

      now = target;
    },
  };
}

function createHookRuntime() {
  const slots = [];
  let cursor = 0;

  const dependenciesChanged = (previous, next) => {
    if (!previous || !next || previous.length !== next.length) return true;
    return next.some((value, index) => !Object.is(value, previous[index]));
  };

  return {
    useState(initialValue) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = {
          kind: "state",
          value: typeof initialValue === "function" ? initialValue() : initialValue,
        };
      }

      const setValue = (nextValue) => {
        slots[index].value =
          typeof nextValue === "function" ? nextValue(slots[index].value) : nextValue;
      };
      return [slots[index].value, setValue];
    },
    useRef(initialValue) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { kind: "ref", value: { current: initialValue } };
      return slots[index].value;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && !dependenciesChanged(previous.dependencies, dependencies)) return;

      previous?.cleanup?.();
      const cleanup = effect();
      slots[index] = {
        kind: "effect",
        dependencies: dependencies ? [...dependencies] : undefined,
        cleanup: typeof cleanup === "function" ? cleanup : undefined,
      };
    },
    render(component, props = {}) {
      cursor = 0;
      return component(props);
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
      slots.length = 0;
      cursor = 0;
    },
  };
}

function createElement(type, props, ...children) {
  const normalizedChildren = children.length <= 1 ? children[0] : children;
  return {
    type,
    props: {
      ...(props ?? {}),
      ...(children.length > 0 ? { children: normalizedChildren } : {}),
    },
  };
}

export function findAll(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, matches);
    return matches;
  }
  if (!node || typeof node !== "object" || !("type" in node)) return matches;

  if (predicate(node)) matches.push(node);
  findAll(node.props?.children, predicate, matches);
  return matches;
}

export function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object" && "type" in node) return textContent(node.props?.children);
  return "";
}

export async function createRuntimeHarness({
  width = 1200,
  height = 800,
  reducedMotion = false,
} = {}) {
  const media = createMediaEnvironment({ width, height });
  const scheduler = createScheduler();
  const hooks = createHookRuntime();
  const passthrough = ({ children }) => children ?? null;
  const designSystem = Object.fromEntries(
    ["Button", "Badge", "Tag", "Card", "Eyebrow", "StepBadge", "CalloutCapsule"].map(
      (name) => [name, function DesignSystemComponent() {}],
    ),
  );
  const React = {
    Fragment: Symbol("Fragment"),
    createElement,
    useState: hooks.useState,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
  };
  const window = {
    LigouDesignSystem_a33905: designSystem,
    matchMedia: media.matchMedia,
  };
  const context = {
    React,
    ReactDOM: {
      createRoot() {
        return { render() {} };
      },
    },
    window,
    document: { getElementById: () => ({}) },
    console,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    LGFX_REDUCED: reducedMotion,
    Reveal: passthrough,
    ScrollProgress: passthrough,
    Marquee: passthrough,
    WaveDraw: passthrough,
    useInView: () => [null, false],
    IntersectionObserver: class IntersectionObserver {
      observe() {}
      disconnect() {}
    },
  };
  context.globalThis = context;

  const source = await readFile(applicationUrl, "utf8");
  const exports = [
    "HERO_MEDIA",
    "HERO_ULTRAWIDE_QUERY",
    "getHeroMediaKey",
    "HeroVideo",
    "Hero",
    "Intro4",
    "CallDemo",
    "Faq",
  ];
  const instrumentedSource = `${source}\nglobalThis.__LIGOU_RUNTIME_TESTS__ = { ${exports.join(", ")} };`;
  const transpiler = new Bun.Transpiler({
    loader: "jsx",
    target: "browser",
    tsconfig: { compilerOptions: { jsx: "react" } },
  });
  const compiled = transpiler.transformSync(instrumentedSource);

  vm.runInNewContext(compiled, context, {
    filename: "src/runtime/ligou-app9.jsx",
  });

  return {
    bindings: context.__LIGOU_RUNTIME_TESTS__,
    media,
    scheduler,
    render: hooks.render,
    unmount: hooks.unmount,
  };
}
