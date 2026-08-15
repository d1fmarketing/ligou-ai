/*
 * Generated from src/runtime/ligou-app9.jsx
 * Source SHA-256: 0806269e2e6ddc6b740de5639d1ddef69b6803edf630e02a8ce48caecc4f2f53
 * Rebuild with: bun run build
 */
const DS = window.LigouDesignSystem_a33905;
const { Button, Badge, Tag, Card, Eyebrow, StepBadge, CalloutCapsule } = DS;
const { useState, useEffect, useRef } = React;
function Container({ style, className = "", children }) {
  return React.createElement("div", {
    className: "ct " + className,
    style: { maxWidth: "var(--container)", margin: "0 auto", padding: "0 32px", ...style }
  }, children);
}
function SectionHead({ eyebrow, title, lede, center }) {
  return React.createElement("div", {
    style: { display: "flex", flexDirection: "column", gap: 14, marginBottom: 44, alignItems: center ? "center" : "flex-start", textAlign: center ? "center" : "left" }
  }, React.createElement(Reveal, null, React.createElement(Eyebrow, null, eyebrow)), React.createElement(Reveal, {
    delay: 90
  }, React.createElement("h2", {
    style: { fontSize: "var(--size-display)", fontWeight: "var(--weight-black)", letterSpacing: "var(--track-display)", lineHeight: "var(--leading-display)" }
  }, title)), lede && React.createElement(Reveal, {
    delay: 170
  }, React.createElement("p", {
    style: { margin: 0, fontSize: "var(--size-body-lg)", color: "var(--text-secondary)", maxWidth: 620 }
  }, lede)));
}
function Intro4({ onDone }) {
  const [txt, setTxt] = useState(0);
  const [out, setOut] = useState(false);
  const doneRef = useRef(false);
  const fire = () => {
    if (!doneRef.current) {
      doneRef.current = true;
      onDone();
    }
  };
  useEffect(() => {
    if (LGFX_REDUCED) {
      fire();
      return;
    }
    const t1 = setTimeout(() => setTxt(1), 900);
    const t2 = setTimeout(() => setOut(true), 1750);
    const t3 = setTimeout(fire, 2450);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);
  if (LGFX_REDUCED)
    return null;
  const skip = () => {
    setOut(true);
    setTimeout(fire, 300);
  };
  return React.createElement("div", {
    className: "intro intro4 " + (out ? "out" : ""),
    onClick: skip,
    role: "presentation"
  }, React.createElement("div", {
    className: "intro__veil"
  }), React.createElement("div", {
    className: "intro__panel"
  }, React.createElement("div", {
    className: "intro4__mark"
  }, React.createElement(AgentNodeMark, {
    size: 86
  })), txt === 0 ? React.createElement("div", {
    className: "intro__t",
    key: "a"
  }, "Ligou?") : React.createElement("div", {
    className: "intro__t",
    key: "b"
  }, React.createElement("span", {
    className: "acc"
  }, "Atendido.")), React.createElement("span", {
    className: "intro__cap"
  }, "ligou.ai · agente operacional"), React.createElement("div", {
    className: "intro__bar"
  })));
}
function AgentNodeMark({ size = 34 }) {
  return React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 48 48",
    fill: "none",
    "aria-hidden": "true"
  }, React.createElement("path", {
    d: "M24 9v6",
    stroke: "#ff5a36",
    strokeWidth: "2.6",
    strokeLinecap: "round"
  }), React.createElement("circle", {
    cx: "24",
    cy: "6.5",
    r: "4",
    fill: "#ff5a36"
  }), React.createElement("path", {
    d: "M18.5 30.5 14.8 36M29.5 30.5 33.2 36M24 33v6",
    stroke: "#46c2af",
    strokeWidth: "2.4",
    strokeLinecap: "round"
  }), React.createElement("circle", {
    cx: "13.5",
    cy: "38.5",
    r: "3.1",
    fill: "#46c2af"
  }), React.createElement("circle", {
    cx: "24",
    cy: "41",
    r: "3.1",
    fill: "#46c2af"
  }), React.createElement("circle", {
    cx: "34.5",
    cy: "38.5",
    r: "3.1",
    fill: "#46c2af"
  }), React.createElement("circle", {
    cx: "24",
    cy: "23.5",
    r: "9.8",
    fill: "#0d2b3f",
    stroke: "rgba(251,252,248,.3)",
    strokeWidth: "1.2"
  }), React.createElement("ellipse", {
    cx: "20.7",
    cy: "23.5",
    rx: "1.7",
    ry: "2.7",
    fill: "#46c2af"
  }), React.createElement("ellipse", {
    cx: "27.3",
    cy: "23.5",
    rx: "1.7",
    ry: "2.7",
    fill: "#46c2af"
  }));
}
function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [sec, setSec] = useState("");
  useEffect(() => {
    const f = () => setScrolled(window.scrollY > 12);
    f();
    window.addEventListener("scroll", f, { passive: true });
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting)
        setSec(e.target.id);
    }), { rootMargin: "-30% 0px -60% 0px" });
    ["diferenca", "faq", "prova", "preco"].forEach((id) => {
      const el = document.getElementById(id);
      if (el)
        io.observe(el);
    });
    return () => {
      window.removeEventListener("scroll", f);
      io.disconnect();
    };
  }, []);
  const L = ({ id, children }) => React.createElement("a", {
    href: "#" + id,
    className: "nav-link " + (sec === id ? "on" : "")
  }, React.createElement("i", null), children);
  return React.createElement("header", {
    className: "nav nav4 " + (scrolled ? "scrolled" : "")
  }, React.createElement(Container, {
    style: { display: "flex", alignItems: "center", gap: 28, height: 68, maxWidth: 1500 }
  }, React.createElement("a", {
    href: "#top",
    className: "nav4-logo"
  }, React.createElement(AgentNodeMark, null), React.createElement("span", null, "Ligou")), React.createElement("nav", {
    className: "nav-links",
    style: { display: "flex", gap: 24, marginLeft: "auto" }
  }, React.createElement(L, {
    id: "prova"
  }, "Demo"), React.createElement(L, {
    id: "diferenca"
  }, "Como trabalha"), React.createElement(L, {
    id: "faq"
  }, "Controle"), React.createElement(L, {
    id: "preco"
  }, "Preço")), React.createElement("span", {
    style: { marginLeft: "auto" },
    className: "nav4-cta"
  }, React.createElement(Button, {
    size: "sm",
    variant: "accent",
    href: "#prova",
    style: { whiteSpace: "nowrap" }
  }, "Falar com o Ligou"))));
}
const HERO_MEDIA = {
  ultrawide: {
    src: "assets/hero-loop-ultrawide-3440x1476.mp4",
    poster: "assets/hero-poster-ultrawide-3440x1476.webp",
    width: 3440,
    height: 1476
  },
  desktop: {
    src: "assets/hero-loop-1080p.mp4",
    poster: "assets/hero-poster.png",
    width: 1920,
    height: 1080
  },
  tabletLandscape: {
    src: "assets/hero-loop-tablet-landscape-1440x1080.mp4",
    poster: "assets/hero-poster-tablet-landscape-1440x1080.png",
    width: 1440,
    height: 1080
  },
  tabletPortrait: {
    src: "assets/hero-loop-tablet-portrait-1080x1440.mp4",
    poster: "assets/hero-poster-tablet-portrait-1080x1440.png",
    width: 1080,
    height: 1440
  },
  mobile: {
    src: "assets/hero-loop-mobile-1080x1920.mp4",
    poster: "assets/hero-poster-mobile.png",
    width: 1080,
    height: 1920
  }
};
const HERO_ULTRAWIDE_QUERY = "(min-width: 1600px) and (min-aspect-ratio: 2/1)";
function getHeroMediaKey() {
  if (window.matchMedia("(max-width: 767px)").matches)
    return "mobile";
  if (window.matchMedia("(max-width: 1199px)").matches) {
    return window.matchMedia("(orientation: portrait)").matches ? "tabletPortrait" : "tabletLandscape";
  }
  if (window.matchMedia(HERO_ULTRAWIDE_QUERY).matches)
    return "ultrawide";
  return "desktop";
}
function useHeroMedia() {
  const [key, setKey] = React.useState(getHeroMediaKey);
  React.useEffect(() => {
    const queries = [
      window.matchMedia("(max-width: 767px)"),
      window.matchMedia("(max-width: 1199px)"),
      window.matchMedia("(orientation: portrait)"),
      window.matchMedia(HERO_ULTRAWIDE_QUERY)
    ];
    const refresh = () => setKey(getHeroMediaKey());
    queries.forEach((query) => query.addEventListener ? query.addEventListener("change", refresh) : query.addListener(refresh));
    return () => queries.forEach((query) => query.removeEventListener ? query.removeEventListener("change", refresh) : query.removeListener(refresh));
  }, []);
  return [key, HERO_MEDIA[key]];
}
function HeroVideo() {
  const [mediaKey, media] = useHeroMedia();
  return React.createElement("video", {
    "data-hero-media": mediaKey,
    key: media.src,
    src: media.src,
    poster: media.poster,
    width: media.width,
    height: media.height,
    autoPlay: true,
    muted: true,
    loop: true,
    playsInline: true,
    preload: "metadata",
    "aria-hidden": "true",
    tabIndex: -1,
    ref: (el) => {
      if (el) {
        el.muted = true;
        const p = el.play();
        if (p && p.catch)
          p.catch(() => {});
      }
    }
  });
}
function useHeroBand() {
  const get = () => window.matchMedia("(max-width: 767px)").matches ? "mobile" : window.matchMedia("(max-width: 1199px)").matches ? "mid" : "desktop";
  const [band, setBand] = React.useState(get);
  React.useEffect(() => {
    const qs = [window.matchMedia("(max-width: 767px)"), window.matchMedia("(max-width: 1199px)")];
    const f = () => setBand(get());
    qs.forEach((q) => q.addEventListener ? q.addEventListener("change", f) : q.addListener(f));
    return () => qs.forEach((q) => q.removeEventListener ? q.removeEventListener("change", f) : q.removeListener(f));
  }, []);
  return band;
}
function Hero() {
  const band = useHeroBand();
  const art = React.createElement("div", {
    className: "hero4-artlayer",
    "aria-hidden": "true"
  }, LGFX_REDUCED ? React.createElement("picture", null, React.createElement("source", {
    media: "(max-width:767px)",
    srcSet: "assets/hero-poster-mobile.png",
    width: "1080",
    height: "1920"
  }), React.createElement("source", {
    media: "(min-width:768px) and (max-width:1199px) and (orientation:portrait)",
    srcSet: "assets/hero-poster-tablet-portrait-1080x1440.png",
    width: "1080",
    height: "1440"
  }), React.createElement("source", {
    media: "(min-width:768px) and (max-width:1199px)",
    srcSet: "assets/hero-poster-tablet-landscape-1440x1080.png",
    width: "1440",
    height: "1080"
  }), React.createElement("source", {
    media: HERO_ULTRAWIDE_QUERY,
    srcSet: "assets/hero-poster-ultrawide-3440x1476.webp",
    width: "3440",
    height: "1476"
  }), React.createElement("img", {
    src: "assets/hero-poster.png",
    width: "1920",
    height: "1080",
    fetchpriority: "high",
    alt: ""
  })) : React.createElement(HeroVideo, null));
  return React.createElement("section", {
    id: "top",
    "data-screen-label": "Hero",
    className: "hero4"
  }, band !== "mid" ? art : null, React.createElement(Container, {
    className: "hero4-grid",
    style: { maxWidth: 1500 }
  }, React.createElement("div", {
    className: "hero4-copy hd",
    style: { "--d": "40ms" }
  }, React.createElement("div", {
    className: "hd",
    style: { "--d": "60ms" }
  }, React.createElement("span", {
    className: "h4-eyebrow"
  }, "Agente operacional para negócios de serviços")), React.createElement("h1", null, React.createElement("span", {
    className: "lmask"
  }, React.createElement("span", {
    className: "ln",
    style: { "--d": "160ms" }
  }, "Ligou?")), React.createElement("span", {
    className: "lmask"
  }, React.createElement("span", {
    className: "ln",
    style: { "--d": "290ms" }
  }, React.createElement("span", {
    className: "acc"
  }, "Atendido.")))), React.createElement("svg", {
    className: "hero-wave h4-wave",
    viewBox: "0 0 200 16",
    fill: "none",
    preserveAspectRatio: "none",
    "aria-hidden": "true"
  }, React.createElement("path", {
    pathLength: "1",
    d: "M0 8c12-9 25-9 37 0s25 9 37 0 25-9 37 0 25 9 37 0 25-9 37 0",
    stroke: "currentColor",
    strokeWidth: "3",
    strokeLinecap: "round"
  })), React.createElement("p", {
    className: "hd h4-lede",
    style: { "--d": "440ms" }
  }, "Seu cliente liga. O Ligou consulta suas regras, agenda o trabalho e só te chama quando precisa de aprovação."), React.createElement("div", {
    className: "hd h4-ctas",
    style: { "--d": "560ms" }
  }, React.createElement(Button, {
    variant: "accent",
    size: "lg",
    href: "#prova"
  }, "Falar com o Ligou"), band !== "mobile" && React.createElement("a", {
    className: "h4-ghostbtn",
    href: "#diferenca"
  }, "Ver uma operação completa")), React.createElement("p", {
    className: "hd h4-trust",
    style: { "--d": "680ms" }
  }, "Você ensina em português · Ele atende em inglês, espanhol e português")), React.createElement("div", {
    className: "hero4-artslot"
  }, band === "mid" ? art : null)));
}
function Scene() {
  const rows = [
    ["brief", "Serviços", "Instalação, manutenção e reparos."],
    ["pin", "Cidades atendidas", "San Francisco, Los Angeles, San Diego e região."],
    ["bell", "Emergências", "24h para vazamentos e falta de água."]
  ];
  const icons = {
    brief: React.createElement("svg", {
      width: "20",
      height: "20",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, React.createElement("rect", {
      x: "3",
      y: "7",
      width: "18",
      height: "13",
      rx: "2.5"
    }), React.createElement("path", {
      d: "M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12h18"
    })),
    pin: React.createElement("svg", {
      width: "20",
      height: "20",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, React.createElement("path", {
      d: "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"
    }), React.createElement("circle", {
      cx: "12",
      cy: "10",
      r: "3"
    })),
    bell: React.createElement("svg", {
      width: "20",
      height: "20",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, React.createElement("path", {
      d: "M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 20a2 2 0 0 1-3.4 0"
    }))
  };
  return React.createElement("section", {
    id: "diferenca",
    "data-screen-label": "A diferença",
    className: "iv"
  }, React.createElement(Container, {
    style: { maxWidth: 1500 }
  }, React.createElement("div", {
    className: "iv-head"
  }, React.createElement(Reveal, null, React.createElement("span", {
    className: "h4-eyebrow"
  }, "A diferença")), React.createElement(Reveal, {
    delay: 80
  }, React.createElement("h2", null, "O Ligou não é configurado.", React.createElement("br", null), "Ele é contratado.")), React.createElement(Reveal, {
    delay: 150
  }, React.createElement("p", {
    className: "iv-sub"
  }, "Você conversa. O Ligou transforma suas respostas em atendimento.")), React.createElement(Reveal, {
    delay: 220
  }, React.createElement("div", {
    className: "iv-word"
  }, "Em português."))), React.createElement("div", {
    className: "iv-steps"
  }, React.createElement(Reveal, {
    className: "iv-col iv-col--1",
    delay: 0
  }, React.createElement("div", {
    className: "iv-lab"
  }, React.createElement("b", null, "01"), React.createElement("span", null, "Conversa")), React.createElement("p", {
    className: "iv-line"
  }, "Ele te liga primeiro."), React.createElement("div", {
    className: "iv-card iv-card--dark"
  }, React.createElement("div", {
    className: "iv-idrow"
  }, React.createElement("span", {
    className: "iv-avatar"
  }, React.createElement("img", {
    className: "ligou-avatar",
    src: "assets/ligou-avatar-v1.png",
    alt: ""
  })), React.createElement("span", {
    className: "iv-id"
  }, React.createElement("b", null, "Ligou"), React.createElement("i", null, "Agente operacional")), React.createElement(Waveform, {
    playing: true
  })), React.createElement("div", {
    className: "iv-q"
  }, "Quais serviços vocês oferecem?"), React.createElement("div", {
    className: "iv-callbar"
  }, React.createElement("span", {
    className: "iv-hang",
    "aria-hidden": "true"
  }, React.createElement("svg", {
    width: "20",
    height: "20",
    viewBox: "0 0 24 24",
    fill: "currentColor"
  }, React.createElement("path", {
    d: "M12 9c-3.6 0-6.9 1.1-9.4 3a2 2 0 0 0-.5 2.6l1 1.7a1.6 1.6 0 0 0 2 .6l2.6-1.1c.6-.3 1-.9 1-1.6v-1.4c2.1-.6 4.5-.6 6.6 0v1.4c0 .7.4 1.3 1 1.6l2.6 1.1a1.6 1.6 0 0 0 2-.6l1-1.7a2 2 0 0 0-.5-2.6C18.9 10.1 15.6 9 12 9Z"
  })))))), React.createElement(Reveal, {
    className: "iv-col iv-col--2",
    delay: 130
  }, React.createElement("div", {
    className: "iv-lab"
  }, React.createElement("b", null, "02"), React.createElement("span", null, "Suas regras")), React.createElement("p", {
    className: "iv-line"
  }, "Suas respostas viram regras de operação."), React.createElement("div", {
    className: "iv-card iv-card--light"
  }, React.createElement("span", {
    className: "iv-node",
    "aria-hidden": "true"
  }, React.createElement(AgentNodeMark, {
    size: 40
  })), React.createElement("div", {
    className: "iv-rows"
  }, rows.map(([ic, t, d]) => React.createElement("div", {
    key: t,
    className: "iv-row"
  }, React.createElement("span", {
    className: "iv-ric"
  }, icons[ic]), React.createElement("span", null, React.createElement("b", null, t), React.createElement("p", null, d))))))), React.createElement(Reveal, {
    className: "iv-col iv-col--3",
    delay: 260
  }, React.createElement("div", {
    className: "iv-lab"
  }, React.createElement("b", null, "03"), React.createElement("span", null, "Em operação")), React.createElement("p", {
    className: "iv-line"
  }, "Ele atende com suas regras."), React.createElement("div", {
    className: "iv-card iv-card--light"
  }, React.createElement("div", {
    className: "iv-readyhead"
  }, React.createElement("span", {
    className: "iv-avatar iv-avatar--ring"
  }, React.createElement("img", {
    className: "ligou-avatar",
    src: "assets/ligou-avatar-v1.png",
    alt: ""
  })), React.createElement("span", null, React.createElement("b", {
    className: "iv-readytitle"
  }, "Pronto para atender"), React.createElement("span", {
    className: "wf-teal"
  }, React.createElement(Waveform, {
    playing: true
  })))), React.createElement("span", {
    className: "iv-pill"
  }, "Regras ativas e validadas ", React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "9"
  }), React.createElement("path", {
    d: "m8.5 12 2.5 2.5 4.5-5"
  }))), React.createElement("div", {
    className: "iv-divider"
  }), React.createElement("b", {
    className: "iv-apr"
  }, "Aprovação para ativar"), React.createElement("div", {
    className: "iv-owner"
  }, React.createElement("span", {
    className: "iv-rav"
  }, "R"), React.createElement("span", {
    className: "iv-own"
  }, React.createElement("b", null, "Roberto Almeida"), React.createElement("i", null, "Proprietário")), React.createElement("button", {
    className: "iv-approve",
    type: "button"
  }, "Aprovar e ativar ", React.createElement("svg", {
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("rect", {
    x: "4.5",
    y: "10.5",
    width: "15",
    height: "10",
    rx: "2.5"
  }), React.createElement("path", {
    d: "M8 10.5V7a4 4 0 0 1 8 0v3.5"
  }))))))), React.createElement(Reveal, {
    delay: 150
  }, React.createElement("div", {
    className: "iv-rail"
  }, React.createElement("span", {
    className: "iv-railitem"
  }, React.createElement("b", null, "01"), "Ele te liga primeiro"), React.createElement("span", {
    className: "iv-dots",
    "aria-hidden": "true"
  }), React.createElement("span", {
    className: "iv-railitem"
  }, React.createElement("b", null, "02"), "Ele atende com suas regras"), React.createElement("span", {
    className: "iv-dots",
    "aria-hidden": "true"
  }), React.createElement("span", {
    className: "iv-railitem"
  }, React.createElement("b", null, "03"), "Ele pergunta antes de aprender"))), React.createElement(Reveal, {
    delay: 220
  }, React.createElement("aside", {
    className: "iv-memory",
    "aria-label": "Memória operacional do Ligou"
  }, React.createElement("div", {
    className: "iv-memory__lead"
  }, React.createElement("span", {
    className: "iv-memory__label"
  }, "Memória permanente do seu negócio"), React.createElement("h3", null, "A cada ligação, ele conhece melhor a sua operação.")), React.createElement("div", {
    className: "iv-memory__copy"
  }, React.createElement("span", {
    className: "iv-memory__approval"
  }, "Aprovação de nova regra"), React.createElement("p", null, React.createElement("strong", null, "Não é uma secretária eletrônica."), " É um agente com memória operacional permanente."), React.createElement("p", null, "Cada atendimento amplia o histórico do Ligou. Quando aparece uma situação nova, ele pergunta; depois que você aprova, a resposta vira uma regra permanente do seu negócio — até você decidir alterar ou apagar."))))));
}
function CallDemo() {
  const [mrun, setMrun] = React.useState(0);
  const [mrel, setMrel] = React.useState(false);
  return React.createElement("section", {
    id: "prova",
    "data-screen-label": "Prova do produto",
    className: "p7"
  }, React.createElement(Container, {
    style: { maxWidth: 1500 }
  }, React.createElement(Eyebrow, null, "Prova do produto"), React.createElement("h2", {
    className: "p7-title"
  }, "Quando a regra exige decisão,", React.createElement("br", null), "ele traz a exceção pronta."), React.createElement("p", {
    className: "p7-sub p7-bridge"
  }, "Quando a regra permite, ele resolve sozinho. Quando não permite, traz o caso pronto para você decidir."), React.createElement("p", {
    className: "p7-langnote"
  }, "Este exemplo está em inglês. O Ligou também atende em espanhol."), React.createElement("div", {
    className: "p7-cq"
  }, React.createElement("div", {
    className: "p7-board"
  }, React.createElement("div", {
    className: "p7-bar"
  }, React.createElement("span", {
    className: "p7-dot"
  }), React.createElement("span", {
    className: "p7-blab"
  }, "Chamada · Exemplo"), React.createElement("span", {
    className: "p7-en"
  }, "EN"), React.createElement("svg", {
    className: "p7-wf",
    width: "210",
    height: "26",
    viewBox: "0 0 210 26",
    "aria-hidden": "true"
  }, React.createElement("rect", {
    x: "0",
    y: "10",
    width: "3.4",
    height: "6",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "7",
    y: "8",
    width: "3.4",
    height: "10",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "14",
    y: "5.5",
    width: "3.4",
    height: "15",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "21",
    y: "8.5",
    width: "3.4",
    height: "9",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "28",
    y: "4",
    width: "3.4",
    height: "18",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "35",
    y: "7",
    width: "3.4",
    height: "12",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "42",
    y: "3",
    width: "3.4",
    height: "20",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "49",
    y: "9",
    width: "3.4",
    height: "8",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "56",
    y: "6",
    width: "3.4",
    height: "14",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "63",
    y: "4.5",
    width: "3.4",
    height: "17",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "70",
    y: "9.5",
    width: "3.4",
    height: "7",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "77",
    y: "7",
    width: "3.4",
    height: "12",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "84",
    y: "3.5",
    width: "3.4",
    height: "19",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "91",
    y: "8",
    width: "3.4",
    height: "10",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "98",
    y: "10",
    width: "3.4",
    height: "6",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "105",
    y: "5.5",
    width: "3.4",
    height: "15",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "112",
    y: "7.5",
    width: "3.4",
    height: "11",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "119",
    y: "4",
    width: "3.4",
    height: "18",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "126",
    y: "9",
    width: "3.4",
    height: "8",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "133",
    y: "6.5",
    width: "3.4",
    height: "13",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "140",
    y: "5",
    width: "3.4",
    height: "16",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "147",
    y: "10",
    width: "3.4",
    height: "6",
    rx: "1.7",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "154",
    y: "8",
    width: "3.4",
    height: "10",
    rx: "1.7",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "161",
    y: "6",
    width: "3.4",
    height: "14",
    rx: "1.7",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "168",
    y: "9.5",
    width: "3.4",
    height: "7",
    rx: "1.7",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "175",
    y: "7.5",
    width: "3.4",
    height: "11",
    rx: "1.7",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "182",
    y: "4.5",
    width: "3.4",
    height: "17",
    rx: "1.7",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "189",
    y: "8.5",
    width: "3.4",
    height: "9",
    rx: "1.7",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "196",
    y: "6.5",
    width: "3.4",
    height: "13",
    rx: "1.7",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "203",
    y: "10",
    width: "3.4",
    height: "6",
    rx: "1.7",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  })), React.createElement("span", {
    className: "p7-lead",
    "aria-hidden": "true"
  }), React.createElement("span", {
    className: "p7-time"
  }, "00:12"), React.createElement("span", {
    className: "p7-again"
  }, React.createElement("svg", {
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("path", {
    d: "M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"
  })), " Ver de novo")), React.createElement("svg", {
    className: "p7-trail",
    viewBox: "0 0 1360 660",
    preserveAspectRatio: "none",
    "aria-hidden": "true"
  }, React.createElement("path", {
    d: "M279 168 C 325 168, 352 162, 374 154",
    stroke: "#c9d4cb",
    strokeWidth: "2",
    strokeDasharray: "3 7",
    fill: "none"
  }), React.createElement("path", {
    d: "M279 452 C 318 462, 342 490, 356 516",
    stroke: "#c9d4cb",
    strokeWidth: "2",
    strokeDasharray: "3 7",
    fill: "none"
  }), React.createElement("path", {
    d: "M652 480 C 690 480, 715 478, 744 476",
    stroke: "#c9d4cb",
    strokeWidth: "2",
    strokeDasharray: "3 7",
    fill: "none"
  }), React.createElement("path", {
    d: "M381 153 C 452 185, 468 224, 453 286 C 438 348, 384 420, 374 470 C 369 498, 370 522, 372 545",
    stroke: "#7fd0c2",
    strokeWidth: "3",
    fill: "none"
  }), React.createElement("circle", {
    cx: "381",
    cy: "153",
    r: "11",
    fill: "#fff",
    stroke: "#0b655a",
    strokeWidth: "3"
  }), React.createElement("circle", {
    cx: "381",
    cy: "153",
    r: "4",
    fill: "#0b655a"
  }), React.createElement("circle", {
    cx: "453",
    cy: "286",
    r: "11",
    fill: "#fff",
    stroke: "#0b655a",
    strokeWidth: "3"
  }), React.createElement("circle", {
    cx: "453",
    cy: "286",
    r: "4",
    fill: "#0b655a"
  }), React.createElement("circle", {
    cx: "372",
    cy: "551",
    r: "44",
    fill: "none",
    stroke: "#e8efe7",
    strokeWidth: "10"
  }), React.createElement("circle", {
    cx: "372",
    cy: "551",
    r: "26",
    fill: "#fff",
    stroke: "#dcebe3",
    strokeWidth: "2"
  })), React.createElement("span", {
    className: "p7-check",
    "aria-hidden": "true"
  }, React.createElement("svg", {
    width: "22",
    height: "22",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.6",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("path", {
    d: "m5.5 12.5 4 4 9-9.5"
  }))), React.createElement("div", {
    className: "p7-agent",
    "aria-hidden": "true"
  }, React.createElement("img", {
    src: "assets/agent-ligou.png",
    alt: ""
  })), React.createElement("div", {
    className: "p7-card p7-c1"
  }, React.createElement("span", {
    className: "p7-clabel"
  }, React.createElement("i", {
    className: "p7-cd p7-cd--coral"
  }), "Urgência identificada"), React.createElement("p", {
    className: "p7-crule"
  }, "Possível vazamento ativo"), React.createElement("div", {
    className: "p7-cdiv"
  }), React.createElement("span", {
    className: "p7-cmuted"
  }, "Local"), React.createElement("p", {
    className: "p7-cval"
  }, "San Rafael, CA")), React.createElement("div", {
    className: "p7-card p7-c2"
  }, React.createElement("span", {
    className: "p7-clabel"
  }, React.createElement("i", {
    className: "p7-cd p7-cd--mint"
  }), "Regra consultada"), React.createElement("p", {
    className: "p7-crule"
  }, "Atendimento no mesmo dia exige aprovação"), React.createElement("div", {
    className: "p7-cdiv"
  }), React.createElement("span", {
    className: "p7-cmuted"
  }, "Fonte"), React.createElement("p", {
    className: "p7-cval"
  }, "Política de Atendimento · v2.4")), React.createElement("div", {
    className: "p7-card p7-c3"
  }, React.createElement("span", {
    className: "p7-clabel"
  }, React.createElement("i", {
    className: "p7-cd p7-cd--coral"
  }), "Responsável avisado"), React.createElement("p", {
    className: "p7-crule"
  }, "Pedido urgente enviado"), React.createElement("div", {
    className: "p7-cdiv"
  }), React.createElement("div", {
    className: "p7-strow"
  }, React.createElement("span", {
    className: "p7-cmuted"
  }, "Status"), React.createElement("span", {
    className: "p7-bang"
  }, React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round"
  }, React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "9"
  }), React.createElement("path", {
    d: "M12 7.5v5.5M12 16.4v.2"
  })))), React.createElement("p", {
    className: "p7-crule",
    style: { margin: "4px 0 0" }
  }, "Aguardando decisão")), React.createElement("div", {
    className: "p7-brow p7-b1"
  }, React.createElement("span", {
    className: "p7-bub p7-bub--mint"
  }, React.createElement("span", {
    className: "p7-blbl"
  }, "Cliente · Inglês"), "Hi, water is coming in near the chimney in San Rafael.", React.createElement("br", null), "Is there any chance someone can come today?"), React.createElement("span", {
    className: "p7-ts"
  }, "00:02")), React.createElement("div", {
    className: "p7-brow p7-b2"
  }, React.createElement("span", {
    className: "p7-bub"
  }, React.createElement("span", {
    className: "p7-blbl"
  }, "Ligou · Inglês"), "I can help. Same-day visits need team approval,", React.createElement("br", null), "so I’ll check availability now."), React.createElement("span", {
    className: "p7-ts"
  }, "00:06")), React.createElement("div", {
    className: "p7-brow p7-b3"
  }, React.createElement("span", {
    className: "p7-bub"
  }, React.createElement("span", {
    className: "p7-blbl"
  }, "Ligou · Inglês"), "I’ve sent your request to the team.", React.createElement("br", null), "You’ll receive a text as soon as they confirm."), React.createElement("span", {
    className: "p7-ts"
  }, "00:10")), React.createElement("aside", {
    className: "p7-drawer"
  }, React.createElement("span", {
    className: "p7-tab",
    "aria-hidden": "true"
  }, React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("path", {
    d: "m9 5 7 7-7 7"
  }))), React.createElement("div", {
    className: "p7-dhead"
  }, React.createElement("span", {
    className: "p7-dot"
  }), "Resumo em português"), React.createElement("div", {
    className: "p7-drow"
  }, React.createElement("span", {
    className: "p7-dic"
  }, React.createElement("svg", {
    width: "20",
    height: "20",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("circle", {
    cx: "12",
    cy: "8",
    r: "4"
  }), React.createElement("path", {
    d: "M4.5 20c1.6-3.2 4.3-5 7.5-5s5.9 1.8 7.5 5"
  }))), React.createElement("span", null, React.createElement("b", {
    className: "p7-dname"
  }, "John Miller"), React.createElement("span", {
    className: "p7-dval p7-dval--nw"
  }, "(415) XXX-XXXX"))), React.createElement("div", {
    className: "p7-drow"
  }, React.createElement("span", {
    className: "p7-dic"
  }, React.createElement("svg", {
    width: "20",
    height: "20",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("path", {
    d: "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"
  }), React.createElement("circle", {
    cx: "12",
    cy: "10",
    r: "3"
  }))), React.createElement("span", null, React.createElement("span", {
    className: "p7-dlab"
  }, "Local"), React.createElement("span", {
    className: "p7-dval p7-dval--nw"
  }, "San Rafael, CA"))), React.createElement("div", {
    className: "p7-drow"
  }, React.createElement("span", {
    className: "p7-dic"
  }, React.createElement("svg", {
    width: "20",
    height: "20",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("rect", {
    x: "3.5",
    y: "5",
    width: "17",
    height: "16",
    rx: "2.5"
  }), React.createElement("path", {
    d: "M8 3v4M16 3v4M3.5 10.5h17"
  }))), React.createElement("span", null, React.createElement("span", {
    className: "p7-dlab"
  }, "Pedido"), React.createElement("span", {
    className: "p7-dval p7-dval--nw"
  }, "Atendimento hoje"))), React.createElement("div", {
    className: "p7-drow"
  }, React.createElement("span", {
    className: "p7-dic"
  }, React.createElement("svg", {
    width: "20",
    height: "20",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("path", {
    d: "M12 3 5 5.8v5.4c0 4.6 3 8 7 9.8 4-1.8 7-5.2 7-9.8V5.8L12 3Z"
  }), React.createElement("path", {
    d: "m9 11.5 2.2 2.2 3.8-4.2"
  }))), React.createElement("span", null, React.createElement("span", {
    className: "p7-dlab"
  }, "Regra aplicada"), React.createElement("span", {
    className: "p7-dval"
  }, "Encaixe no mesmo dia exige aprovação."))), React.createElement("div", {
    className: "p7-drow"
  }, React.createElement("span", {
    className: "p7-dic"
  }, React.createElement("svg", {
    width: "20",
    height: "20",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("path", {
    d: "M7 3h7l4 4v14H7V3Z"
  }), React.createElement("path", {
    d: "M14 3v4h4M10 12h5M10 15.5h5"
  }))), React.createElement("span", null, React.createElement("span", {
    className: "p7-dlab"
  }, "Relato do cliente"), React.createElement("span", {
    className: "p7-dval p7-dval--sm"
  }, "Água entrando próxima à chaminé após a chuva. O cliente pediu atendimento hoje. Nenhum horário nem preço foi prometido."))), React.createElement("div", {
    className: "p7-ddiv"
  }), React.createElement("span", {
    className: "p7-decision"
  }, "Decisão de exceção"), React.createElement("p", {
    className: "p7-darrow"
  }, "→ Aguardando sua decisão."), React.createElement("div", {
    className: "p7-dbtns"
  }, React.createElement("button", {
    className: "p7-apr",
    type: "button"
  }, "Aprovar encaixe"), React.createElement("button", {
    className: "p7-adj",
    type: "button"
  }, "Ajustar resposta"))))), React.createElement("div", {
    className: "p7m",
    key: mrun
  }, React.createElement("div", {
    className: "lc-shell"
  }, React.createElement("div", {
    className: "lc-head lc-i",
    style: { "--lcd": "0s" }
  }, React.createElement("span", {
    className: "lc-avatar lc-avatar--head"
  }, React.createElement("img", {
    className: "ligou-avatar",
    src: "assets/ligou-avatar-v1.png",
    alt: ""
  })), React.createElement("span", {
    className: "lc-id"
  }, React.createElement("b", null, "Ligou em chamada"), React.createElement("span", {
    className: "lc-idsub"
  }, React.createElement("i", {
    className: "lc-en"
  }, "EN"), React.createElement("svg", {
    className: "lc-wf",
    width: "120",
    height: "22",
    viewBox: "0 0 120 22",
    "aria-hidden": "true"
  }, React.createElement("rect", {
    x: "0",
    y: "8.5",
    width: "3",
    height: "5",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "6",
    y: "6.5",
    width: "3",
    height: "9",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "12",
    y: "4.5",
    width: "3",
    height: "13",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "18",
    y: "7.5",
    width: "3",
    height: "7",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "24",
    y: "3.5",
    width: "3",
    height: "15",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "30",
    y: "6",
    width: "3",
    height: "10",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "36",
    y: "3",
    width: "3",
    height: "16",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "42",
    y: "8",
    width: "3",
    height: "6",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "48",
    y: "5",
    width: "3",
    height: "12",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "54",
    y: "4",
    width: "3",
    height: "14",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "60",
    y: "8",
    width: "3",
    height: "6",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "66",
    y: "6",
    width: "3",
    height: "10",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "72",
    y: "3.5",
    width: "3",
    height: "15",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "78",
    y: "7",
    width: "3",
    height: "8",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "84",
    y: "8.5",
    width: "3",
    height: "5",
    rx: "1.5",
    fill: "var(--lg-teal-500)"
  }), React.createElement("rect", {
    x: "90",
    y: "5",
    width: "3",
    height: "12",
    rx: "1.5",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "96",
    y: "6.5",
    width: "3",
    height: "9",
    rx: "1.5",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "102",
    y: "4",
    width: "3",
    height: "14",
    rx: "1.5",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "108",
    y: "7.5",
    width: "3",
    height: "7",
    rx: "1.5",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  }), React.createElement("rect", {
    x: "114",
    y: "5.5",
    width: "3",
    height: "11",
    rx: "1.5",
    fill: "var(--lg-teal-500)",
    opacity: ".45"
  })))), React.createElement("span", {
    className: "lc-htime"
  }, "00:12"), React.createElement("button", {
    className: "lc-again",
    type: "button",
    onClick: () => {
      setMrel(false);
      setMrun((m) => m + 1);
    },
    "aria-label": "Ver de novo"
  }, React.createElement("svg", {
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("path", {
    d: "M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"
  })))), React.createElement("div", {
    className: "lc-convo"
  }, React.createElement("div", {
    className: "lc-row lc-row--cust lc-i",
    style: { "--lcd": ".1s" }
  }, React.createElement("div", {
    className: "lc-msg"
  }, React.createElement("span", {
    className: "lc-who"
  }, "Cliente · Inglês", React.createElement("i", {
    className: "lc-ts"
  }, "00:02")), React.createElement("div", {
    className: "lc-bub lc-bub--cust"
  }, "Hi, water is coming in near the chimney in San Rafael. Is there any chance someone can come today?")), React.createElement("span", {
    className: "lc-face lc-face--jm"
  }, "JM")), React.createElement("div", {
    className: "lc-ev lc-i",
    style: { "--lcd": ".55s" }
  }, React.createElement("span", {
    className: "lc-evline",
    "aria-hidden": "true"
  }), React.createElement("i", {
    className: "lc-evdot",
    style: { background: "var(--lg-orange-500)" }
  }), React.createElement("span", null, React.createElement("b", null, "Urgência identificada"), React.createElement("em", null, "Possível vazamento ativo · San Rafael, CA"))), React.createElement("div", {
    className: "lc-row lc-i",
    style: { "--lcd": "1s" }
  }, React.createElement("span", {
    className: "lc-face lc-face--lg"
  }, React.createElement("img", {
    className: "ligou-avatar",
    src: "assets/ligou-avatar-v1.png",
    alt: ""
  })), React.createElement("div", {
    className: "lc-msg"
  }, React.createElement("span", {
    className: "lc-who"
  }, "Ligou · Inglês", React.createElement("i", {
    className: "lc-ts"
  }, "00:06")), React.createElement("div", {
    className: "lc-bub"
  }, "I can help. Same-day visits need team approval, so I’ll check availability now."))), React.createElement("div", {
    className: "lc-ev lc-i",
    style: { "--lcd": "1.45s" }
  }, React.createElement("span", {
    className: "lc-evline",
    "aria-hidden": "true"
  }), React.createElement("i", {
    className: "lc-evdot",
    style: { background: "var(--lg-teal-400)" }
  }), React.createElement("span", null, React.createElement("b", null, "Regra consultada"), React.createElement("em", null, "Mesmo dia exige aprovação · Política v2.4"))), React.createElement("div", {
    className: "lc-row lc-i",
    style: { "--lcd": "1.9s" }
  }, React.createElement("span", {
    className: "lc-face lc-face--lg"
  }, React.createElement("img", {
    className: "ligou-avatar",
    src: "assets/ligou-avatar-v1.png",
    alt: ""
  })), React.createElement("div", {
    className: "lc-msg"
  }, React.createElement("span", {
    className: "lc-who"
  }, "Ligou · Inglês", React.createElement("i", {
    className: "lc-ts"
  }, "00:10")), React.createElement("div", {
    className: "lc-bub"
  }, "I’ve sent your request to the team. You’ll receive a text as soon as they confirm."))), React.createElement("div", {
    className: "lc-ev lc-i",
    style: { "--lcd": "2.35s" }
  }, React.createElement("span", {
    className: "lc-evline",
    "aria-hidden": "true"
  }), React.createElement("i", {
    className: "lc-evdot",
    style: { background: "var(--lg-orange-500)" }
  }), React.createElement("span", null, React.createElement("b", null, "Responsável avisado"), React.createElement("em", null, "Pedido urgente enviado · Aguardando decisão")))), React.createElement("aside", {
    className: "lc-sheet lc-i",
    style: { "--lcd": "2.85s" }
  }, React.createElement("div", {
    className: "lc-dhead"
  }, React.createElement("span", {
    className: "lc-ddot"
  }), "Resumo em português"), React.createElement("div", {
    className: "lc-drow"
  }, React.createElement("span", {
    className: "lc-dic"
  }, React.createElement("svg", {
    width: "17",
    height: "17",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("circle", {
    cx: "12",
    cy: "8",
    r: "4"
  }), React.createElement("path", {
    d: "M4.5 20c1.6-3.2 4.3-5 7.5-5s5.9 1.8 7.5 5"
  }))), React.createElement("p", null, React.createElement("b", null, "John Miller"), " · (415) XXX-XXXX")), React.createElement("div", {
    className: "lc-drow"
  }, React.createElement("span", {
    className: "lc-dic"
  }, React.createElement("svg", {
    width: "17",
    height: "17",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("path", {
    d: "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"
  }), React.createElement("circle", {
    cx: "12",
    cy: "10",
    r: "3"
  }))), React.createElement("p", null, "San Rafael, CA")), React.createElement("div", {
    className: "lc-drow"
  }, React.createElement("span", {
    className: "lc-dic"
  }, React.createElement("svg", {
    width: "17",
    height: "17",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("rect", {
    x: "3.5",
    y: "5",
    width: "17",
    height: "16",
    rx: "2.5"
  }), React.createElement("path", {
    d: "M8 3v4M16 3v4M3.5 10.5h17"
  }))), React.createElement("p", null, "Atendimento hoje")), React.createElement("div", {
    className: "lc-drow"
  }, React.createElement("span", {
    className: "lc-dic"
  }, React.createElement("svg", {
    width: "17",
    height: "17",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("path", {
    d: "M12 3 5 5.8v5.4c0 4.6 3 8 7 9.8 4-1.8 7-5.2 7-9.8V5.8L12 3Z"
  }), React.createElement("path", {
    d: "m9 11.5 2.2 2.2 3.8-4.2"
  }))), React.createElement("p", null, "Regra: encaixe no mesmo dia exige aprovação")), React.createElement("button", {
    className: "lc-rel",
    type: "button",
    id: "lc-rel-toggle",
    "aria-expanded": mrel ? "true" : "false",
    "aria-controls": "lc-relato-full",
    onClick: () => setMrel((r) => !r)
  }, mrel ? "Ocultar relato" : "Ver relato completo"), mrel && React.createElement("p", {
    className: "lc-relato",
    id: "lc-relato-full"
  }, "Água entrando próxima à chaminé após a chuva. O cliente pediu atendimento hoje. Nenhum horário nem preço foi prometido."), React.createElement("span", {
    className: "p7-decision"
  }, "Decisão de exceção"), React.createElement("p", {
    className: "lc-darrow"
  }, "→ Aguardando sua decisão"), React.createElement("div", {
    className: "lc-btns"
  }, React.createElement("button", {
    className: "lc-apr",
    type: "button"
  }, "Aprovar encaixe"), React.createElement("button", {
    className: "lc-adj",
    type: "button"
  }, "Ajustar resposta")))))));
}
function Dor() {
  return React.createElement("section", {
    className: "dor-section",
    "data-screen-label": "A dor",
    style: { background: "var(--surface-sunken)", borderBottom: "1px solid var(--border-soft)" }
  }, React.createElement(Container, {
    className: "dor-ct",
    style: { padding: "64px 32px 88px", display: "flex", flexDirection: "column", gap: 26 }
  }, React.createElement(Reveal, null, React.createElement(Eyebrow, null, "A dor")), React.createElement(Reveal, {
    delay: 80
  }, React.createElement("h2", {
    className: "dorbig"
  }, "A ligação que você não atende ", React.createElement("span", {
    className: "acc"
  }, "não fica esperando."))), React.createElement(Reveal, {
    delay: 140
  }, React.createElement("p", {
    style: { margin: 0, fontSize: "var(--size-body-lg)", color: "var(--text-secondary)", maxWidth: 680 }
  }, "Para o brasileiro que toca uma empresa de serviços nos EUA, atender nem sempre cabe no meio do trabalho. Você está no telhado, dirigindo ou com outro cliente — e a ligação cai na caixa postal.")), React.createElement(Reveal, {
    delay: 200
  }, React.createElement("p", {
    style: { margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--size-h3)", letterSpacing: "var(--track-tight)", maxWidth: 680 }
  }, "Para quem ligou, a próxima empresa está a um toque de distância. Em inglês ou espanhol, essa oportunidade fica ainda mais difícil de disputar."))));
}
function Faz() {
  const mobile = useHeroBand() === "mobile";
  const items = ["Entende o que o cliente precisa e coleta nome, endereço e detalhes importantes", "Aplica as regras que você definiu sem prometer o que não está autorizado", "Verifica disponibilidade e agenda dentro das suas regras", "Transfere urgências ou envia um aviso, conforme você definiu", "Envia um resumo em português e registra a ligação para você revisar"];
  const item = (t) => React.createElement("div", {
    className: "checkitem"
  }, React.createElement("b", null, "→"), t);
  return React.createElement("section", {
    "data-screen-label": "O que ele faz",
    style: { marginTop: 116 }
  }, React.createElement(Container, null, React.createElement(SectionHead, {
    eyebrow: "Numa ligação",
    title: "O que ele faz quando o telefone toca."
  }), mobile ? React.createElement(Reveal, null, React.createElement("div", {
    className: "checklist"
  }, items.map((t) => React.createElement(React.Fragment, {
    key: t
  }, item(t))))) : React.createElement("div", {
    className: "checklist"
  }, items.map((t, i) => React.createElement(Reveal, {
    key: t,
    delay: i % 2 * 70
  }, item(t))))));
}
function Comecar() {
  const mobile = useHeroBand() === "mobile";
  const steps = [
    ["01", "Fale com o Ligou", "Comece pela demonstração."],
    ["02", "Contrate o Ligou", "Plano mês a mês, sem fidelidade."],
    ["03", "Ensine sua operação", "Em uma conversa curta, ele te entrevista em português e cria a primeira versão do atendimento."],
    ["04", "Teste e aprove", "Ajuste o que quiser e só aprove quando estiver satisfeito."],
    ["05", "Coloque no ar", "Use o número do Ligou ou redirecione o seu para começar a atender."]
  ];
  const card = ([n, t, d]) => React.createElement("div", {
    className: "startcard"
  }, React.createElement("span", {
    className: "sn"
  }, n), React.createElement("b", null, t), React.createElement("p", null, d));
  return React.createElement("section", {
    id: "comecar",
    "data-screen-label": "Como começar",
    style: { marginTop: 116 }
  }, React.createElement(Container, null, React.createElement(SectionHead, {
    eyebrow: "Como começar",
    title: "Conheça o Ligou. Ensine sua operação. Só coloque no ar depois de aprovar."
  }), mobile ? React.createElement(Reveal, null, React.createElement("div", {
    className: "startgrid"
  }, steps.map((step) => React.createElement(React.Fragment, {
    key: step[0]
  }, card(step))))) : React.createElement("div", {
    className: "startgrid"
  }, steps.map((step, i) => React.createElement(Reveal, {
    key: step[0],
    delay: i * 70
  }, card(step))))));
}
function Faq() {
  const [open, setOpen] = useState(0);
  const mobile = useHeroBand() === "mobile";
  const qs = [
    ["Ele pode inventar um preço ou uma resposta?", "Não. O Ligou só informa preços, condições e políticas que você aprovou. Quando não tem uma resposta autorizada, coleta as informações, avisa que a equipe confirma e pergunta para você. A resposta só vira regra depois da sua aprovação."],
    ["E se o cliente quiser falar comigo?", "Você escolhe: quando transferir na hora, quando só receber aviso, e quando deixar o Ligou concluir sozinho."],
    ["Ele fala que é inteligência artificial?", 'Ele se apresenta como assistente virtual da sua empresa: "Hi, you’ve reached [Your Business]. I’m their virtual assistant — how can I help?" A conversa é natural, mas a confiança do seu cliente não depende de fingir que existe uma pessoa do outro lado.'],
    ["Preciso falar inglês ou espanhol para ensinar o Ligou?", "Não. A entrevista, os ajustes e a aprovação são em português. O Ligou atende em inglês, espanhol ou português e envia o resumo para você em português."],
    ["E se eu quiser cancelar?", "Você cancela pelo painel, sem multa e sem precisar falar com vendedor."]
  ];
  const item = ([q, a], i) => React.createElement("div", {
    className: `faq-item ${open === i ? "open" : ""}`
  }, React.createElement("button", {
    className: "faq-q",
    onClick: () => setOpen(open === i ? -1 : i),
    "aria-expanded": open === i
  }, q, React.createElement("span", {
    className: "pm"
  }, "+")), React.createElement("div", {
    className: "faq-a"
  }, React.createElement("p", null, a)));
  return React.createElement("section", {
    id: "faq",
    "data-screen-label": "FAQ",
    style: { marginTop: 116 }
  }, React.createElement(Container, {
    style: { maxWidth: 880 }
  }, React.createElement(SectionHead, {
    eyebrow: "Perguntas diretas",
    title: "O que todo dono pergunta."
  }), mobile ? React.createElement(Reveal, null, React.createElement("div", null, qs.map((qa, i) => React.createElement(React.Fragment, {
    key: qa[0]
  }, item(qa, i))))) : React.createElement("div", null, qs.map((qa, i) => React.createElement(Reveal, {
    key: qa[0],
    delay: i * 50
  }, item(qa, i))))));
}
function Pricing() {
  const label = { fontSize: 11, fontWeight: 700, letterSpacing: ".16em", textTransform: "uppercase" };
  const inc = ["Uma empresa e uma localização", "Número do Ligou ou redirecionamento do seu", "Atendimento em inglês, espanhol e português", "Onboarding, regras e aprovação em português", "Integração de agenda, resumos e histórico das ligações", "400 minutos/mês · excedente $0.35/min"];
  return React.createElement("section", {
    id: "preco",
    "data-screen-label": "Preço",
    style: { marginTop: 110, background: "var(--surface-inverse)", color: "var(--text-inverse)" }
  }, React.createElement(Container, {
    className: "price-ct",
    style: { padding: "92px 32px 100px" }
  }, React.createElement(Reveal, null, React.createElement("span", {
    className: "pt-cap__label"
  }, "Preço")), React.createElement(Reveal, {
    delay: 90
  }, React.createElement("h2", {
    style: { margin: "18px 0 0", fontSize: "var(--size-display)", fontWeight: "var(--weight-black)", letterSpacing: "var(--track-display)", lineHeight: "var(--leading-display)" }
  }, "Contrate até 31 de dezembro de 2026 por $299/mês.")), React.createElement("div", {
    className: "pricegrid"
  }, React.createElement(Reveal, {
    delay: 120
  }, React.createElement(Card, {
    style: { padding: "36px 36px 40px", display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start", height: "100%", boxSizing: "border-box", color: "var(--text-body)" }
  }, React.createElement(Badge, {
    variant: "orange"
  }, "Oferta por tempo limitado"), React.createElement("div", {
    style: { display: "flex", alignItems: "baseline", gap: 6, color: "var(--lg-ink-950)", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "clamp(56px,6vw,80px)", letterSpacing: "var(--track-display)", lineHeight: 1, margin: "4px 0 0" }
  }, React.createElement("span", {
    style: { fontVariantNumeric: "tabular-nums" }
  }, "$299"), React.createElement("span", {
    style: { fontSize: "0.28em", fontWeight: 700, color: "var(--text-secondary)", letterSpacing: "var(--track-tight)" }
  }, "/mês")), React.createElement("p", {
    style: { margin: 0, color: "var(--text-secondary)", fontSize: 15 }
  }, "Ativação isenta. Quem contratar até 31 de dezembro de 2026 mantém o valor base de $299/mês enquanto a assinatura permanecer ativa."), React.createElement("div", {
    className: "inclist"
  }, inc.map((t) => React.createElement("div", {
    key: t,
    className: "incitem"
  }, React.createElement("b", null, "→"), t))), React.createElement("p", {
    className: "price-mobile-normal"
  }, "Para novas assinaturas após a oferta: $499/mês + ativação de $499."), React.createElement(Button, {
    variant: "accent",
    href: "#preco",
    style: { marginTop: 8 }
  }, "Quero aproveitar a oferta"))), React.createElement(Reveal, {
    className: "price-regular-reveal",
    delay: 220
  }, React.createElement("div", {
    className: "pricecard--ghost",
    style: { display: "flex", flexDirection: "column", gap: 18, alignItems: "flex-start", justifyContent: "center", height: "100%", boxSizing: "border-box" }
  }, React.createElement("span", {
    style: { ...label, color: "var(--text-inverse-secondary)" }
  }, "Depois da oferta"), React.createElement("div", {
    style: { display: "flex", alignItems: "baseline", gap: 6, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "clamp(40px,4vw,52px)", letterSpacing: "var(--track-display)", lineHeight: 1, color: "var(--text-inverse)" }
  }, "$499", React.createElement("span", {
    style: { fontSize: "0.42em", fontWeight: 700, color: "var(--text-inverse-secondary)" }
  }, "/mês")), React.createElement("p", {
    style: { margin: 0, color: "var(--text-inverse-secondary)", fontSize: 15 }
  }, "Para novas assinaturas, com ativação de $499.")))), React.createElement(Reveal, {
    delay: 140
  }, React.createElement("p", {
    style: { margin: "34px 0 0", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--size-h3)", letterSpacing: "var(--track-tight)", maxWidth: 640 }
  }, "Se uma única ligação recuperada vale mais de $499 para o seu negócio, o Ligou pode se pagar com um único trabalho.")), React.createElement(Reveal, {
    delay: 200
  }, React.createElement("p", {
    style: { margin: "10px 0 0", color: "var(--text-inverse-secondary)", fontSize: 14 }
  }, "Plano mês a mês. Sem fidelidade."))));
}
function Cta() {
  const [ref, on] = useInView({ threshold: 0.3 });
  return React.createElement("section", {
    ref,
    className: "cta",
    "data-screen-label": "CTA final"
  }, React.createElement(Container, {
    style: { position: "relative", zIndex: 1 }
  }, React.createElement(Reveal, null, React.createElement("p", {
    style: { margin: "0 0 26px", color: "var(--lg-teal-400)", fontSize: 12, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase" }
  }, "Seu negócio pode atender em inglês e espanhol — mesmo que você fale só português")), React.createElement("h2", {
    className: on ? "wr-on" : "",
    style: { maxWidth: "72%" }
  }, React.createElement("span", {
    className: "lmask"
  }, React.createElement("span", {
    className: "ln",
    style: { "--d": "60ms" }
  }, "Ligou?")), React.createElement("span", {
    className: "lmask"
  }, React.createElement("span", {
    className: "ln acc",
    style: { "--d": "220ms" }
  }, "Atendido."))), React.createElement(Reveal, {
    delay: 380
  }, React.createElement("div", {
    style: { display: "flex", gap: 12, marginTop: 34, flexWrap: "wrap" }
  }, React.createElement(Button, {
    variant: "accent",
    size: "lg",
    href: "#prova"
  }, "Falar com o Ligou agora")))), React.createElement("img", {
    className: "cta-robot floaty",
    src: "assets/crop-robot.png",
    alt: ""
  }));
}
function Footer() {
  const a = { color: "var(--text-inverse-secondary)", textDecoration: "none" };
  return React.createElement("footer", {
    "data-screen-label": "Footer",
    style: { background: "var(--surface-inverse-deep)", color: "var(--text-inverse)", borderTop: "1px solid rgba(251,252,248,.1)", overflow: "hidden" }
  }, React.createElement(Container, {
    style: { padding: "56px 32px 0" }
  }, React.createElement("div", {
    className: "footer-row",
    style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }
  }, React.createElement("img", {
    src: "assets/crop-logo-mark.png",
    alt: "",
    style: { height: 34, borderRadius: "50%" }
  }), React.createElement("span", {
    style: { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 24, letterSpacing: "-0.02em" }
  }, "Ligou"), React.createElement("span", {
    className: "footer-links",
    style: { display: "flex", gap: 10, flexWrap: "wrap", marginLeft: "auto", fontSize: 14, alignItems: "center" }
  }, React.createElement("a", {
    href: "https://ligou.ai",
    style: a
  }, "ligou.ai"), React.createElement("span", {
    style: { opacity: 0.4 }
  }, "·"), React.createElement("a", {
    href: "mailto:suporte@ligou.ai",
    style: a
  }, "suporte@ligou.ai"), React.createElement("span", {
    style: { opacity: 0.4 }
  }, "·"), React.createElement("a", {
    href: "#",
    style: a
  }, "Termos"), React.createElement("span", {
    style: { opacity: 0.4 }
  }, "·"), React.createElement("a", {
    href: "#",
    style: a
  }, "Privacidade"))), React.createElement("p", {
    style: { margin: "16px 0 0", maxWidth: 440, color: "var(--text-inverse-secondary)", fontSize: 15 }
  }, "Feito por um brasileiro nos EUA que cansou de ver conterrâneo perdendo venda no telefone.")), React.createElement("div", {
    className: "bigword",
    "aria-hidden": "true"
  }, "Ligou"));
}
function App() {
  const [ready, setReady] = useState(false);
  return React.createElement(React.Fragment, null, React.createElement(Intro4, {
    onDone: () => setReady(true)
  }), React.createElement(ScrollProgress, null), React.createElement(Nav, null), React.createElement("main", {
    className: ready ? "play" : ""
  }, React.createElement(Hero, null), React.createElement("div", {
    className: "mqwrap",
    "aria-hidden": "true"
  }, React.createElement(Marquee, {
    rev: true,
    items: ["Limpeza", "Pintura", "Roofing", "Landscaping", "HVAC", "Junk removal", "Pavers", "Piscinas", "Remodeling", "Elétrica", "Encanamento"]
  }), React.createElement("div", {
    className: "mq-claims"
  }, React.createElement(Marquee, {
    small: true,
    items: ["Atende em inglês, espanhol e português", "Você ensina em português", "Agenda dentro das suas regras", "Não inventa preço", "Resume em português", "Pergunta antes de aprender"]
  }))), React.createElement(Dor, null), React.createElement(CallDemo, null), React.createElement(WaveDraw, {
    style: { maxWidth: "var(--container)", margin: "0 auto", padding: "0 32px" }
  }), React.createElement(Scene, null), React.createElement(Faz, null), React.createElement(Comecar, null), React.createElement(Faq, null), React.createElement(Pricing, null), React.createElement(Cta, null)), React.createElement(Footer, null));
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App, null));
