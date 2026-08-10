const SITE_CONFIG = Object.freeze({
  demoPhoneDisplay: "(XXX) XXX-XXXX",
  demoPhoneHref: "",
  checkoutUrl: "",
  termsUrl: "",
  privacyUrl: "",
});

const header = document.querySelector("[data-header]");
const headerCta = document.querySelector(".header-cta");
const notice = document.querySelector("[data-site-notice]");
const noticeText = document.querySelector("[data-notice-text]");
const noticeClose = document.querySelector("[data-notice-close]");
const callDock = document.querySelector("[data-call-dock]");
const heroSection = document.querySelector("#inicio");
const pricingSection = document.querySelector("#preco");
const root = document.documentElement;
const mobileDockMedia = window.matchMedia("(max-width: 900px)");
let noticeTimer;
let dockVisible = false;
let chromeFrame = 0;
let collectVisibleReveals = () => [];

function showNotice(message) {
  window.clearTimeout(noticeTimer);
  notice.toggleAttribute("inert", false);
  noticeText.textContent = message;
  notice.classList.add("is-visible");
  noticeTimer = window.setTimeout(closeNotice, 5200);
}

function closeNotice() {
  notice.classList.remove("is-visible");
  notice.toggleAttribute("inert", true);
  window.clearTimeout(noticeTimer);
}

function configureCalls() {
  document.querySelectorAll("[data-demo-phone]").forEach((element) => {
    element.textContent = SITE_CONFIG.demoPhoneDisplay;
  });

  document.querySelectorAll("[data-demo-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (SITE_CONFIG.demoPhoneHref) {
        window.location.href = `tel:${SITE_CONFIG.demoPhoneHref}`;
        return;
      }

      showNotice("Número da demonstração pendente. Preencha SITE_CONFIG.demoPhoneHref antes de publicar.");
    });
  });
}

function configureCheckout() {
  document.querySelectorAll("[data-checkout-action]").forEach((checkoutButton) => {
    checkoutButton.addEventListener("click", () => {
      if (SITE_CONFIG.checkoutUrl) {
        window.location.assign(SITE_CONFIG.checkoutUrl);
        return;
      }

      showNotice("Checkout pendente. Preencha SITE_CONFIG.checkoutUrl antes de publicar.");
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
      showNotice(`${label} pendente. Conecte a URL antes de publicar.`);
    });
  });
}

/*
 * Revelação de entrada.
 *
 * O IntersectionObserver não dispara enquanto a aba está oculta ou suspensa.
 * Como o CSS mantém os elementos em opacity 0 até o callback chegar, confiar
 * apenas nele produz tela em branco — comportamento observado em QA.
 *
 * Por isso a animação só pode ADIAR o conteúdo, nunca escondê-lo: há varredura
 * síncrona na carga, rede de segurança por tempo e nova varredura sempre que a
 * página volta a ficar visível.
 */
function configureReveal() {
  const elements = Array.from(document.querySelectorAll(".reveal"));

  const revealAll = () => elements.forEach((element) => element.classList.add("is-visible"));

  collectVisibleReveals = () => {
    const limit = window.innerHeight * 1.15;
    return elements
      .filter((element) => !element.classList.contains("is-visible"))
      .filter((element) => element.getBoundingClientRect().top < limit);
  };

  const revealWithinViewport = () => {
    collectVisibleReveals().forEach((element) => element.classList.add("is-visible"));
  };

  document.documentElement.classList.add("reveal-ready");
  document.addEventListener(
    "focusin",
    (event) => event.target.closest?.(".reveal")?.classList.add("is-visible"),
    true,
  );

  if (!("IntersectionObserver" in window)) {
    revealAll();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8%", threshold: 0.08 },
  );

  elements.forEach((element) => observer.observe(element));

  // Tudo que já está na primeira dobra aparece sem esperar o observer.
  revealWithinViewport();

  // Rede de segurança: observer suspenso não pode deixar texto invisível.
  window.setTimeout(revealWithinViewport, 1200);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") revealWithinViewport();
  });

  // Retorno pelo cache de navegação (bfcache) não reexecuta o script.
  window.addEventListener("pageshow", revealWithinViewport);
}

function configureFaq() {
  const items = document.querySelectorAll(".faq-list details");

  items.forEach((item) => {
    item.addEventListener("toggle", () => {
      if (!item.open) return;
      items.forEach((otherItem) => {
        if (otherItem !== item) otherItem.open = false;
      });
    });
  });
}

/*
 * Barra de ação fixa no celular.
 *
 * A página é longa por decisão de produto, então a demo precisa continuar a um
 * toque de distância depois que o hero sai da tela. Ela se retira quando o bloco
 * de preço entra em cena para não disputar atenção com o checkout.
 *
 * A posição é calculada no mesmo handler de scroll em vez de um observer
 * próprio: menos peças, e imune à suspensão de callback que causava tela branca.
 */
function applyCallDockState(shouldShow) {
  if (shouldShow === dockVisible) return;
  dockVisible = shouldShow;

  callDock.classList.toggle("is-visible", shouldShow);
  callDock.toggleAttribute("inert", !shouldShow);
  root.classList.toggle("dock-visible", shouldShow);

  headerCta?.toggleAttribute("inert", shouldShow);
  if (shouldShow) {
    headerCta?.setAttribute("aria-hidden", "true");
  } else {
    headerCta?.removeAttribute("aria-hidden");
  }
}

function updatePageChrome() {
  const scrollTop = window.scrollY;
  const viewportHeight = window.innerHeight;
  const scrollableHeight = root.scrollHeight - viewportHeight;
  const progress = scrollableHeight > 0 ? Math.min(scrollTop / scrollableHeight, 1) : 0;
  const heroBottom = heroSection?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY;
  const pricingTop = pricingSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
  const revealsToShow = collectVisibleReveals();
  const shouldShowDock =
    Boolean(callDock && heroSection) &&
    mobileDockMedia.matches &&
    heroBottom < 80 &&
    pricingTop >= viewportHeight * 0.85;

  header?.classList.toggle("is-scrolled", scrollTop > 20);
  root.style.setProperty("--scroll-progress", progress.toFixed(4));
  applyCallDockState(shouldShowDock);
  revealsToShow.forEach((element) => element.classList.add("is-visible"));
}

function schedulePageChromeUpdate() {
  if (chromeFrame) return;

  chromeFrame = window.requestAnimationFrame(() => {
    chromeFrame = 0;
    updatePageChrome();
  });
}

noticeClose?.addEventListener("click", closeNotice);
window.addEventListener("scroll", schedulePageChromeUpdate, { passive: true });
window.addEventListener("resize", schedulePageChromeUpdate, { passive: true });
window.addEventListener("pageshow", schedulePageChromeUpdate);
mobileDockMedia.addEventListener("change", schedulePageChromeUpdate);

configureCalls();
configureCheckout();
configureLegalLinks();
configureReveal();
configureFaq();
schedulePageChromeUpdate();
