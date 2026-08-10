const SITE_CONFIG = Object.freeze({
  demoPhoneDisplay: "(XXX) XXX-XXXX",
  demoPhoneHref: "",
  checkoutUrl: "",
  termsUrl: "",
  privacyUrl: "",
});

const header = document.querySelector("[data-header]");
const notice = document.querySelector("[data-site-notice]");
const noticeText = document.querySelector("[data-notice-text]");
const noticeClose = document.querySelector("[data-notice-close]");
const callDock = document.querySelector("[data-call-dock]");
const heroSection = document.querySelector("#inicio");
const pricingSection = document.querySelector("#preco");
let noticeTimer;
let dockVisible = false;

function showNotice(message) {
  window.clearTimeout(noticeTimer);
  noticeText.textContent = message;
  notice.classList.add("is-visible");
  noticeTimer = window.setTimeout(() => {
    notice.classList.remove("is-visible");
  }, 5200);
}

function closeNotice() {
  notice.classList.remove("is-visible");
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

  const revealWithinViewport = () => {
    const limit = window.innerHeight * 1.15;
    elements.forEach((element) => {
      if (element.classList.contains("is-visible")) return;
      if (element.getBoundingClientRect().top < limit) element.classList.add("is-visible");
    });
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

  /*
   * Varredura por rolagem, limitada a um quadro.
   *
   * Cobre o caminho do teclado sem depender de evento: ao tabular para um bloco
   * fora da tela, o navegador rola até ele, e a rolagem fixa a revelação. Sem
   * isso, um bloco aberto por :focus-within voltaria a sumir no blur caso o
   * observer ainda não tivesse disparado.
   */
  let sweepQueued = false;
  window.addEventListener(
    "scroll",
    () => {
      if (sweepQueued) return;
      sweepQueued = true;
      window.requestAnimationFrame(() => {
        sweepQueued = false;
        revealWithinViewport();
      });
    },
    { passive: true },
  );
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
function updateCallDock() {
  if (!callDock || !heroSection) return;

  const heroPassed = heroSection.getBoundingClientRect().bottom < 80;
  const pricingInView = pricingSection
    ? pricingSection.getBoundingClientRect().top < window.innerHeight * 0.85
    : false;
  const shouldShow = heroPassed && !pricingInView;

  if (shouldShow === dockVisible) return;
  dockVisible = shouldShow;

  callDock.classList.toggle("is-visible", shouldShow);
  callDock.toggleAttribute("inert", !shouldShow);
}

function updatePageChrome() {
  const scrollTop = window.scrollY;
  const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
  const progress = scrollableHeight > 0 ? Math.min(scrollTop / scrollableHeight, 1) : 0;

  header?.classList.toggle("is-scrolled", scrollTop > 20);
  document.documentElement.style.setProperty("--scroll-progress", progress.toFixed(4));
  updateCallDock();
}

noticeClose?.addEventListener("click", closeNotice);
window.addEventListener("scroll", updatePageChrome, { passive: true });
window.addEventListener("resize", updatePageChrome, { passive: true });

configureCalls();
configureCheckout();
configureLegalLinks();
configureReveal();
configureFaq();
updatePageChrome();
