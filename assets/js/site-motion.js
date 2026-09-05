export function createSiteMotion({window: win, document: doc, IntersectionObserver: IO, MutationObserver: MO}) {
  const media = win.matchMedia('(prefers-reduced-motion: reduce)');
  const videos = new Map(), sections = new Set();
  const paused = () => media.matches;
  const inViewport = element => {
    const r = element.getBoundingClientRect();
    return r.bottom > 0 && r.top < win.innerHeight && r.right > 0 && r.left < win.innerWidth;
  };
  function syncVideo(video) {
    if (paused() || doc.hidden || videos.get(video) === false) video.pause();
    else video.play()?.catch?.(() => {});
  }
  function sync() {
    doc.documentElement.dataset.ligouMotion = paused() ? 'paused' : 'playing';
    doc.documentElement.dataset.ligouVisibility = doc.hidden ? 'hidden' : 'visible';
    for (const video of videos.keys()) syncVideo(video);
  }
  const observer = IO ? new IO(entries => {
    for (const entry of entries) {
      if (videos.has(entry.target)) { videos.set(entry.target, entry.isIntersecting); syncVideo(entry.target); }
      else entry.target.classList.toggle('motion-outside', !entry.isIntersecting);
    }
  }, {threshold: .01}) : null;
  function refresh() {
    for (const video of videos.keys()) if (!video.isConnected) { observer?.unobserve(video); videos.delete(video); }
    for (const section of sections) if (!section.isConnected) { observer?.unobserve(section); sections.delete(section); }
    for (const video of doc.querySelectorAll('.hero4 video')) if (!videos.has(video)) {
      videos.set(video, inViewport(video)); observer?.observe(video);
    }
    for (const section of doc.querySelectorAll('.mqwrap,.p7,.iv,.cta,.wavedraw,.capabilities,.p7-wf,.lc-wf')) if (!sections.has(section)) {
      sections.add(section);
      if (observer) {
        section.classList.toggle('motion-outside', !inViewport(section));
        observer.observe(section);
      }
    }
    sync();
  }
  doc.addEventListener('visibilitychange', sync);
  media.addEventListener?.('change', sync);
  const mutations = MO ? new MO(refresh) : null;
  mutations?.observe(doc.querySelector?.('#root') || doc.body, {childList: true, subtree: true});
  refresh();
  return {refresh, isPaused: paused, destroy() {
    observer?.disconnect(); mutations?.disconnect();
    doc.removeEventListener('visibilitychange', sync);
    media.removeEventListener?.('change', sync);
  }};
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => createSiteMotion({window, document, IntersectionObserver: window.IntersectionObserver, MutationObserver: window.MutationObserver});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
}
