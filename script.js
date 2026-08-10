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
let noticeTimer;

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

function configureReveal() {
  const elements = document.querySelectorAll(".reveal");

  document.documentElement.classList.add("reveal-ready");
  document.addEventListener(
    "focusin",
    (event) => event.target.closest?.(".reveal")?.classList.add("is-visible"),
    true,
  );

  if (!("IntersectionObserver" in window)) {
    elements.forEach((element) => element.classList.add("is-visible"));
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

function updatePageChrome() {
  const scrollTop = window.scrollY;
  const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
  const progress = scrollableHeight > 0 ? Math.min(scrollTop / scrollableHeight, 1) : 0;

  header?.classList.toggle("is-scrolled", scrollTop > 20);
  document.documentElement.style.setProperty("--scroll-progress", progress.toFixed(4));
}

noticeClose?.addEventListener("click", closeNotice);
window.addEventListener("scroll", updatePageChrome, { passive: true });

configureCalls();
configureCheckout();
configureLegalLinks();
configureReveal();
configureFaq();
updatePageChrome();
