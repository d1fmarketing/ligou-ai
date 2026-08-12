const LGFX_REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function useInView({threshold = .3, once = true, rootMargin = '0px'} = {}) {
  const ref = React.useRef(null);
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setInView(true); if (once) io.disconnect(); }
      else if (!once) setInView(false);
    }, {threshold, rootMargin});
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, LGFX_REDUCED ? true : inView];
}

function Reveal({delay = 0, className = '', style, children, ...rest}) {
  const [ref, on] = useInView({threshold: .18});
  return <div ref={ref} className={`rv ${on ? 'on' : ''} ${className}`} style={{'--d': delay + 'ms', ...style}} {...rest}>{children}</div>;
}

function ScrollProgress() {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const f = () => {
      const h = document.documentElement;
      const p = h.scrollHeight > h.clientHeight ? h.scrollTop / (h.scrollHeight - h.clientHeight) : 0;
      if (ref.current) ref.current.style.width = (p * 100).toFixed(2) + '%';
    };
    f();
    window.addEventListener('scroll', f, {passive: true});
    return () => window.removeEventListener('scroll', f);
  }, []);
  return <div ref={ref} className="prog"></div>;
}

function usePinnedProgress() {
  const ref = React.useRef(null);
  const [p, setP] = React.useState(0);
  React.useEffect(() => {
    if (LGFX_REDUCED) return;
    const el = ref.current;
    if (!el) return;
    let raf = null;
    const f = () => {
      raf = null;
      const r = el.getBoundingClientRect();
      const total = el.offsetHeight - window.innerHeight;
      if (total <= 0) return;
      setP(Math.min(1, Math.max(0, -r.top / total)));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(f); };
    f();
    window.addEventListener('scroll', onScroll, {passive: true});
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);
  return [ref, p];
}

function CountUp({from, to, play, dur = 1200, prefix = ''}) {
  const [v, setV] = React.useState(from);
  React.useEffect(() => {
    if (!play) return;
    if (LGFX_REDUCED) { setV(to); return; }
    let raf; const t0 = performance.now();
    const tick = t => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setV(Math.round(from + (to - from) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play]);
  return <span style={{fontVariantNumeric: 'tabular-nums'}}>{prefix}{v}</span>;
}

function WaveDraw({style}) {
  const [ref, on] = useInView({threshold: .6});
  return <div ref={ref} className={`wavedraw ${on ? 'on' : ''}`} style={style} aria-hidden="true">
    <svg className="lg-wave" viewBox="0 0 1200 22" fill="none" preserveAspectRatio="none"><path pathLength="1" d="M0 11c75-14 150-14 225 0s150 14 225 0 150-14 225 0 150 14 225 0 150-14 225 0 75 7 75 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round"></path></svg>
  </div>;
}

function Marquee({items, rev, small}) {
  const row = items.concat(items);
  return <div className={`mq ${rev ? 'mq--rev' : ''} ${small ? 'mq--sm' : ''}`} aria-hidden="true"><div className="mq__track">
    {row.map((w, i) => <React.Fragment key={i}><b>{w}</b><span className="mq__dot">•</span></React.Fragment>)}
  </div></div>;
}

function Waveform({playing}) {
  return <span className={`wf ${playing ? '' : 'wf--off'}`} aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map(i => <i key={i} style={{animationDelay: (i * .12) + 's'}}></i>)}</span>;
}

function Intro({onDone}) {
  const [txt, setTxt] = React.useState(0);
  const [out, setOut] = React.useState(false);
  const doneRef = React.useRef(false);
  const fire = () => { if (!doneRef.current) { doneRef.current = true; onDone(); } };
  React.useEffect(() => {
    if (LGFX_REDUCED) { fire(); return; }
    const t1 = setTimeout(() => setTxt(1), 900);
    const t2 = setTimeout(() => setOut(true), 1750);
    const t3 = setTimeout(fire, 2450);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);
  if (LGFX_REDUCED) return null;
  const skip = () => { setOut(true); setTimeout(fire, 300); };
  return <div className={`intro ${out ? 'out' : ''}`} onClick={skip} role="presentation">
    <div className="intro__veil"></div>
    <div className="intro__panel">
      <div className="intro__rings"><i></i><i></i><img src="assets/crop-logo-mark.png" alt=""/></div>
      {txt === 0 ? <div className="intro__t" key="a">Ligou?</div> : <div className="intro__t" key="b"><span className="acc">Atendido.</span></div>}
      <span className="intro__cap">ligou.ai · agente operacional bilíngue</span>
      <div className="intro__bar"></div>
    </div>
  </div>;
}

Object.assign(window, {LGFX_REDUCED, useInView, Reveal, ScrollProgress, usePinnedProgress, CountUp, WaveDraw, Marquee, Waveform, Intro});
