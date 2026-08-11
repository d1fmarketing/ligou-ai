const SITE_CONFIG = Object.freeze({
  demoPhoneDisplay: "",
  demoPhoneHref: "",
  checkoutUrl: "",
  termsUrl: "",
  privacyUrl: "",
});

const root = document.documentElement;
root.classList.add("enhanced");
const header = document.querySelector("[data-header]");
const notice = document.querySelector("[data-site-notice]");
const noticeText = document.querySelector("[data-notice-text]");
const noticeClose = document.querySelector("[data-notice-close]");
const callDock = document.querySelector("[data-call-dock]");
const heroSection = document.querySelector("#inicio");
const heroStage = document.querySelector("[data-hero-stage]");
const heroVideos = Array.from(document.querySelectorAll("[data-hero-video]"));
const pricingSection = document.querySelector("#preco");
const operationScroll = document.querySelector(".operation-scroll");
const operationSticky = document.querySelector("[data-operation-sticky]");
const operationScenes = Array.from(document.querySelectorAll("[data-agent-scene]"));
const sceneVideos = Array.from(document.querySelectorAll("[data-scene-video]"));
const motionVideos = [...heroVideos, ...sceneVideos];

const mobileDockMedia = window.matchMedia("(max-width: 900px)");
const storyMedia = window.matchMedia(
  "(min-width: 901px) and (min-height: 700px) and (prefers-reduced-motion: no-preference)",
);
const heroStoryMedia = window.matchMedia(
  "(min-height: 700px) and (prefers-reduced-motion: no-preference)",
);
const reducedMotionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");

let noticeTimer = 0;
let chromeFrame = 0;
let dockVisible = false;
let storyEnabled = false;
let activeScene = "attending";
let lastProgress = "";

function showNotice(message) {
  if (!notice || !noticeText) return;

  window.clearTimeout(noticeTimer);
  noticeText.textContent = message;
  notice.toggleAttribute("inert", false);
  notice.classList.add("is-visible");
  noticeTimer = window.setTimeout(closeNotice, 5200);
}

function closeNotice() {
  if (!notice) return;

  notice.classList.remove("is-visible");
  notice.toggleAttribute("inert", true);
  window.clearTimeout(noticeTimer);
}

function configureCalls() {
  const isLive = Boolean(SITE_CONFIG.demoPhoneHref && SITE_CONFIG.demoPhoneDisplay);

  document.querySelectorAll("[data-demo-label]").forEach((element) => {
    element.textContent = isLive ? "Ligue para a demonstração" : "Ver o Ligou trabalhar";
  });

  document.querySelectorAll("[data-demo-value]").forEach((element) => {
    element.textContent = isLive ? SITE_CONFIG.demoPhoneDisplay : "Acompanhar o fluxo";
    element.classList.toggle("is-live-value", isLive);
  });

  document.querySelectorAll("[data-demo-status]").forEach((element) => {
    element.textContent = "Ao vivo.";
  });

  document.querySelectorAll("[data-demo-note-text]").forEach((element) => {
    element.textContent = "Interrompa e mude de assunto.";
  });

  document.querySelectorAll("[data-demo-note]").forEach((element) => {
    element.hidden = !isLive;
  });

  document.querySelectorAll("[data-demo-kicker]").forEach((element) => {
    element.textContent = isLive ? "Ao vivo · Demonstração" : "Demonstração ilustrativa";
  });

  document.querySelectorAll("[data-demo-close-title]").forEach((element) => {
    element.textContent = isLive ? "Converse com o Ligou." : "Veja o Ligou trabalhar.";
  });

  document.querySelectorAll("[data-demo-close-copy]").forEach((element) => {
    element.textContent = isLive
      ? "Ligue como cliente. Interrompa. Faça uma pergunta inesperada."
      : "Acompanhe a ligação de exemplo e veja o que o Ligou registra.";
  });

  document.querySelectorAll("[data-demo-action]").forEach((action) => {
    if (isLive) {
      action.href = `tel:${SITE_CONFIG.demoPhoneHref}`;
      return;
    }

    action.href = "#prova";
  });
}

function configureCheckout() {
  document.querySelectorAll("[data-checkout-action]").forEach((action) => {
    if (SITE_CONFIG.checkoutUrl) {
      action.href = SITE_CONFIG.checkoutUrl;
      return;
    }

    action.addEventListener("click", (event) => {
      event.preventDefault();
      showNotice("A reserva Founding ainda não está conectada nesta versão local.");
    });
  });
}

function configureLegalLinks() {
  const urls = {
    Termos: SITE_CONFIG.termsUrl,
    Privacidade: SITE_CONFIG.privacyUrl,
  };

  document.querySelectorAll("[data-legal-link]").forEach((link) => {
    const label = link.dataset.legalLink;
    const url = urls[label];

    if (url) {
      link.href = url;
      return;
    }

    link.addEventListener("click", (event) => {
      event.preventDefault();
      showNotice(`${label} ainda não está disponível nesta versão local.`);
    });
  });
}

function configureProofTabs() {
  const tabsRoot = document.querySelector("[data-proof-tabs]");
  const tablist = tabsRoot?.querySelector(".proof-tablist");
  const tabs = Array.from(tabsRoot?.querySelectorAll("[data-proof-tab]") ?? []);
  const panels = Array.from(tabsRoot?.querySelectorAll("[data-proof-panel]") ?? []);

  if (!tabsRoot || !tablist || tabs.length === 0 || panels.length === 0) return;

  function activateTab(key, moveFocus = false) {
    tabs.forEach((tab, index) => {
      const selected = tab.dataset.proofTab === key;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && moveFocus) tab.focus();

      const panel = panels[index];
      if (panel) panel.hidden = !selected;
    });
  }

  tablist.hidden = false;
  tablist.setAttribute("role", "tablist");

  tabs.forEach((tab, index) => {
    const panel = panels[index];
    const tabId = `proof-tab-${index + 1}`;
    const panelId = `proof-panel-${index + 1}`;

    tab.id = tabId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panelId);
    panel.id = panelId;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tabId);

    tab.addEventListener("click", () => activateTab(tab.dataset.proofTab));
    tab.addEventListener("keydown", (event) => {
      const currentIndex = tabs.indexOf(tab);
      let nextIndex = currentIndex;

      if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
      if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex === currentIndex) return;

      event.preventDefault();
      activateTab(tabs[nextIndex].dataset.proofTab, true);
    });
  });

  tabsRoot.classList.add("tabs-ready");
  activateTab(tabs[0].dataset.proofTab);
}

function applyCallDockState(shouldShow) {
  if (!callDock || shouldShow === dockVisible) return;
  dockVisible = shouldShow;

  callDock.classList.toggle("is-visible", shouldShow);
  callDock.toggleAttribute("inert", !shouldShow);
  root.classList.toggle("dock-visible", shouldShow);
}

function primeSceneVideo(video) {
  if (video.getAttribute("src") || !video.dataset.src) return;

  video.src = video.dataset.src;
  video.load();
}

function resetSceneVideo(video) {
  if (video.dataset.motionActive !== "true") return;

  video.dataset.motionActive = "false";
  video.pause();
  if (Number.isFinite(video.duration)) video.currentTime = 0;
  video.classList.remove("is-ready");
}

function seekSceneVideo(video, progress) {
  if (!video || reducedMotionMedia.matches || document.hidden) return;

  const normalizedProgress = Math.min(Math.max(progress, 0), 1);
  video.dataset.motionActive = "true";
  video.dataset.pendingProgress = String(normalizedProgress);
  primeSceneVideo(video);

  if (video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) return;

  const targetTime = Math.min(video.duration - 1 / 30, video.duration * normalizedProgress);
  const needsSeek = Math.abs(video.currentTime - targetTime) > 1 / 60;
  if (needsSeek) {
    video.currentTime = targetTime;
    return;
  }

  if (video.readyState >= 2 && !video.seeking) video.classList.add("is-ready");
}

function updateOperationMotion(viewportHeight, storyRect, storyProgress) {
  if (reducedMotionMedia.matches || document.hidden) {
    sceneVideos.forEach(resetSceneVideo);
    return;
  }

  if (storyEnabled) {
    const storyVisible = Boolean(storyRect && storyRect.bottom > 0 && storyRect.top < viewportHeight);
    const ranges = {
      attending: [0, 0.28],
      operating: [0.28, 0.62],
      approval: [0.62, 1],
    };

    sceneVideos.forEach((video) => {
      const sceneKey = video.closest("[data-agent-scene]")?.dataset.agentScene;
      if (!storyVisible || sceneKey !== activeScene) {
        resetSceneVideo(video);
        return;
      }

      const [start, end] = ranges[sceneKey] || [0, 1];
      seekSceneVideo(video, (storyProgress - start) / Math.max(end - start, 0.001));
    });
    return;
  }

  operationScenes.forEach((scene) => {
    const video = scene.querySelector("[data-scene-video]");
    if (!video) return;

    const rect = scene.getBoundingClientRect();
    const inScrollRange = rect.bottom > 0 && rect.top < viewportHeight;
    if (!inScrollRange) {
      resetSceneVideo(video);
      return;
    }

    const progress = (viewportHeight - rect.top) / Math.max(viewportHeight + rect.height, 1);
    seekSceneVideo(video, progress);
  });
}

function configureSceneMotion() {
  const motionAllowed = !reducedMotionMedia.matches;

  motionVideos.forEach((video) => {
    if (video.dataset.motionReady === "true") return;
    video.dataset.motionReady = "true";

    video.addEventListener("loadedmetadata", () => {
      seekSceneVideo(video, Number(video.dataset.pendingProgress || 0));
    });
    video.addEventListener("loadeddata", () => {
      if (video.dataset.motionActive === "true" && !video.seeking) {
        video.classList.add("is-ready");
      }
    });
    video.addEventListener("seeked", () => {
      if (video.dataset.motionActive === "true") video.classList.add("is-ready");
    });
    video.addEventListener("error", () => video.classList.remove("is-ready"));
  });

  if (!motionAllowed) {
    motionVideos.forEach((video) => {
      video.dataset.motionActive = "true";
      resetSceneVideo(video);
      video.removeAttribute("src");
      video.load();
    });
  }

  schedulePageChromeUpdate();
}

function updateHeroStoryMotion(viewportHeight, heroRect) {
  const storyReady = root.classList.contains("hero-scroll-ready");
  const heroVisible = Boolean(heroRect && heroRect.bottom > 0 && heroRect.top < viewportHeight);

  if (!storyReady || !heroVisible || !heroStage) {
    heroVideos.forEach(resetSceneVideo);
    return;
  }

  const range = Math.max(heroRect.height - viewportHeight, 1);
  const progress = Math.min(Math.max(-heroRect.top / range, 0), 1);
  const sceneKey = progress < 1 / 3 ? "attending" : progress < 2 / 3 ? "operating" : "approval";
  const ranges = {
    attending: [0, 1 / 3],
    operating: [1 / 3, 2 / 3],
    approval: [2 / 3, 1],
  };
  const liveLabels = {
    attending: "Ligação em andamento",
    operating: "Regras em ação",
    approval: "Aguardando seu ok",
  };

  heroStage.dataset.activeScene = sceneKey;
  heroStage.style.setProperty("--hero-stage-progress", progress.toFixed(4));
  const liveLabel = heroStage.querySelector("[data-hero-live-label]");
  if (liveLabel) liveLabel.textContent = liveLabels[sceneKey];

  heroVideos.forEach((video) => {
    const frame = video.closest("[data-hero-frame]");
    const videoKey = frame?.dataset.heroFrame;
    if (videoKey !== sceneKey) {
      resetSceneVideo(video);
      return;
    }

    const [start, end] = ranges[sceneKey];
    const localProgress = Math.min(
      Math.max((progress - start) / Math.max(end - start, 0.001), 0),
      1,
    );
    seekSceneVideo(video, localProgress);
  });
}

function configureStoryMode() {
  storyEnabled = Boolean(operationScroll && operationSticky && storyMedia.matches);
  root.classList.toggle("story-ready", storyEnabled);

  if (!storyEnabled && operationSticky) {
    operationSticky.style.removeProperty("--scene-progress");
    operationSticky.dataset.activeScene = "attending";
    activeScene = "attending";
    lastProgress = "";
  }

  schedulePageChromeUpdate();
}

function updatePageChrome() {
  const viewportHeight = window.innerHeight;
  const scrollTop = window.scrollY;
  const heroRect = heroSection?.getBoundingClientRect();
  const pricingRect = pricingSection?.getBoundingClientRect();
  const storyRect = storyEnabled ? operationScroll?.getBoundingClientRect() : null;

  const shouldShowDock =
    Boolean(callDock && heroRect && pricingRect) &&
    mobileDockMedia.matches &&
    heroRect.bottom < 80 &&
    pricingRect.top >= viewportHeight * 0.86;

  let nextProgress = "";
  let nextScene = activeScene;
  let storyProgress = 0;

  if (storyEnabled && storyRect && storyRect.bottom > 0 && storyRect.top < viewportHeight) {
    const range = Math.max(storyRect.height - viewportHeight, 1);
    const progress = Math.min(Math.max(-storyRect.top / range, 0), 1);
    const roundedProgress = Number(progress.toFixed(3));
    storyProgress = roundedProgress;
    nextProgress = roundedProgress.toFixed(3);
    nextScene =
      roundedProgress < 0.28 ? "attending" : roundedProgress < 0.62 ? "operating" : "approval";
  }

  header?.classList.toggle("is-scrolled", scrollTop > 20);
  applyCallDockState(shouldShowDock);

  if (nextProgress && nextProgress !== lastProgress && operationSticky) {
    operationSticky.style.setProperty("--scene-progress", nextProgress);
    lastProgress = nextProgress;
  }

  if (nextScene !== activeScene && operationSticky) {
    operationSticky.dataset.activeScene = nextScene;
    activeScene = nextScene;
  }

  updateHeroStoryMotion(viewportHeight, heroRect);
  updateOperationMotion(viewportHeight, storyRect, storyProgress);
}

function schedulePageChromeUpdate() {
  if (chromeFrame) return;

  chromeFrame = window.requestAnimationFrame(() => {
    chromeFrame = 0;
    updatePageChrome();
  });
}

function configureHeroMotion() {
  const heroStoryReady =
    heroStoryMedia.matches && Boolean(heroSection && heroStage && heroVideos.length === 3);

  root.classList.toggle("hero-scroll-ready", heroStoryReady);

  if (heroStoryReady) {
    window.requestAnimationFrame(() => root.classList.add("motion-ready"));
  } else {
    root.classList.remove("motion-ready");
    heroStage?.style.removeProperty("--hero-stage-progress");
    heroVideos.forEach(resetSceneVideo);
  }

  schedulePageChromeUpdate();
}

noticeClose?.addEventListener("click", closeNotice);
window.addEventListener("scroll", schedulePageChromeUpdate, { passive: true });
window.addEventListener("resize", schedulePageChromeUpdate, { passive: true });
window.addEventListener("pageshow", schedulePageChromeUpdate);
mobileDockMedia.addEventListener("change", schedulePageChromeUpdate);
storyMedia.addEventListener("change", configureStoryMode);
heroStoryMedia.addEventListener("change", configureHeroMotion);
reducedMotionMedia.addEventListener("change", () => {
  configureSceneMotion();
  configureHeroMotion();
  configureStoryMode();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    motionVideos.forEach((video) => {
      video.dataset.motionActive = "true";
      resetSceneVideo(video);
    });
    return;
  }

  schedulePageChromeUpdate();
});

configureCalls();
configureCheckout();
configureLegalLinks();
configureProofTabs();
configureSceneMotion();
configureStoryMode();
configureHeroMotion();
schedulePageChromeUpdate();
