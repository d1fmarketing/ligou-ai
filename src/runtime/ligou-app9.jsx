const DS = window.LigouDesignSystem_a33905;
const {Button, Badge, Tag, Card, Eyebrow, StepBadge, CalloutCapsule} = DS;
const {useState, useEffect, useRef} = React;

function Container({style, className = '', children}) {
  return <div className={'ct ' + className} style={{maxWidth: 'var(--container)', margin: '0 auto', padding: '0 32px', ...style}}>{children}</div>;
}

function SectionHead({eyebrow, title, lede, center}) {
  return <div style={{display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 44, alignItems: center ? 'center' : 'flex-start', textAlign: center ? 'center' : 'left'}}>
    <Reveal><Eyebrow className={eyebrow ? undefined : 'eyebrow-mark'} aria-hidden={eyebrow ? undefined : true}>{eyebrow}</Eyebrow></Reveal>
    <Reveal delay={90}><h2 style={{fontSize: 'var(--t-h2-quiet)', fontWeight: 'var(--weight-black)', letterSpacing: 'var(--track-display)', lineHeight: 'var(--leading-display)'}}>{title}</h2></Reveal>
    {lede && <Reveal delay={170}><p style={{margin: 0, fontSize: 'var(--t-lede)', color: 'var(--text-secondary)', maxWidth: 620}}>{lede}</p></Reveal>}
  </div>;
}

const INTRO_SEEN_KEY = 'ligou-intro';
function readIntroSeen() {
  try { return window.sessionStorage.getItem(INTRO_SEEN_KEY) === '1'; } catch (e) { return false; }
}
function markIntroSeen() {
  try { window.sessionStorage.setItem(INTRO_SEEN_KEY, '1'); } catch (e) {}
}
function replayDemo() {
  try { window.dispatchEvent(new CustomEvent('ligou:replay')); } catch (e) {}
}

function Intro4({onDone}) {
  const [txt, setTxt] = useState(0);
  const [out, setOut] = useState(false);
  const [seen] = useState(readIntroSeen);
  const doneRef = useRef(false);
  const fire = () => { if (!doneRef.current) { doneRef.current = true; onDone(); } };
  const skip = () => { setOut(true); fire(); };
  useEffect(() => {
    if (LGFX_REDUCED || seen) { fire(); return; }
    markIntroSeen();
    const t1 = setTimeout(() => setTxt(1), 450);
    const t2 = setTimeout(skip, 900);
    const canListen = typeof window.addEventListener === 'function';
    if (canListen) {
      window.addEventListener('wheel', skip, {passive: true});
      window.addEventListener('touchmove', skip, {passive: true});
    }
    return () => {
      clearTimeout(t1); clearTimeout(t2);
      if (canListen) { window.removeEventListener('wheel', skip); window.removeEventListener('touchmove', skip); }
    };
  }, []);
  if (LGFX_REDUCED || seen) return null;
  const onKey = e => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); skip(); } };
  return <button type="button" className={'intro intro4 ' + (out ? 'out' : '')} onClick={skip} onKeyDown={onKey} aria-label="Pular introdução" autoFocus>
    <div className="intro__veil"></div>
    <div className="intro__panel">
      <div className="intro4__mark"><AgentNodeMark size={86}/></div>
      {txt === 0 ? <div className="intro__t" key="a">Ligou?</div> : <div className="intro__t" key="b">Atendido.</div>}
      <span className="intro__cap">ligou.ai · agente operacional de inteligência artificial</span>
      <div className="intro__bar"></div>
    </div>
  </button>;
}

function AgentNodeMark({size = 34}) {
  return <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M24 9v6" stroke="#ff5a36" strokeWidth="2.6" strokeLinecap="round"></path>
    <circle cx="24" cy="6.5" r="4" fill="#ff5a36"></circle>
    <path d="M18.5 30.5 14.8 36M29.5 30.5 33.2 36M24 33v6" stroke="#46c2af" strokeWidth="2.4" strokeLinecap="round"></path>
    <circle cx="13.5" cy="38.5" r="3.1" fill="#46c2af"></circle>
    <circle cx="24" cy="41" r="3.1" fill="#46c2af"></circle>
    <circle cx="34.5" cy="38.5" r="3.1" fill="#46c2af"></circle>
    <circle cx="24" cy="23.5" r="9.8" fill="#0d2b3f" stroke="rgba(251,252,248,.3)" strokeWidth="1.2"></circle>
    <ellipse cx="20.7" cy="23.5" rx="1.7" ry="2.7" fill="#46c2af"></ellipse>
    <ellipse cx="27.3" cy="23.5" rx="1.7" ry="2.7" fill="#46c2af"></ellipse>
  </svg>;
}

function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [sec, setSec] = useState('');
  useEffect(() => {
    const f = () => setScrolled(window.scrollY > 12);
    f(); window.addEventListener('scroll', f, {passive: true});
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) setSec(e.target.id); }), {rootMargin: '-30% 0px -60% 0px'});
    ['diferenca', 'faq', 'prova', 'preco'].forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => { window.removeEventListener('scroll', f); io.disconnect(); };
  }, []);
  const L = ({id, children}) => <a href={'#' + id} className={'nav-link ' + (sec === id ? 'on' : '')}><i></i>{children}</a>;
  return <header className={'nav nav4 ' + (scrolled ? 'scrolled' : '')}>
    <Container style={{display: 'flex', alignItems: 'center', gap: 28, height: 68, maxWidth: 1500}}>
      <a href="#top" className="nav4-logo"><AgentNodeMark/><span>Ligou</span></a>
      <nav className="nav-links" style={{display: 'flex', gap: 24, marginLeft: 'auto'}}>
        <L id="prova">Demo</L><L id="diferenca">Como trabalha</L><L id="faq">Controle</L><L id="preco">Preço</L>
      </nav>
      <div className="nav4-actions">
        <a className="nav4-client" href="/dashboard/" aria-label="Área do cliente">
          <span className="nav4-client-long">Área do cliente</span>
          <span className="nav4-client-short" aria-hidden="true">Área</span>
        </a>
        <span className="nav4-cta"><Button size="sm" variant="accent" href="#prova" onClick={replayDemo} style={{whiteSpace: 'nowrap'}}>Falar com o Ligou</Button></span>
      </div>
    </Container>
  </header>;
}

const HERO_MEDIA = {
  ultrawide: {
    src: 'assets/hero-loop-ultrawide-3440x1476.mp4',
    poster: 'assets/hero-poster-ultrawide-3440x1476.webp',
    width: 3440,
    height: 1476
  },
  desktop: {
    src: 'assets/hero-loop-1080p.mp4',
    poster: 'assets/hero-poster.png',
    width: 1920,
    height: 1080
  },
  tabletLandscape: {
    src: 'assets/hero-loop-tablet-landscape-1440x1080.mp4',
    poster: 'assets/hero-poster-tablet-landscape-1440x1080.png',
    width: 1440,
    height: 1080
  },
  tabletPortrait: {
    src: 'assets/hero-loop-tablet-portrait-1080x1440.mp4',
    poster: 'assets/hero-poster-tablet-portrait-1080x1440.png',
    width: 1080,
    height: 1440
  },
  mobile: {
    src: 'assets/hero-loop-mobile-1080x1920.mp4',
    poster: 'assets/hero-poster-mobile.png',
    width: 1080,
    height: 1920
  }
};

const HERO_ULTRAWIDE_QUERY = '(min-width: 1600px) and (min-aspect-ratio: 2/1)';

function getHeroMediaKey() {
  if (window.matchMedia('(max-width: 767px)').matches) return 'mobile';
  if (window.matchMedia('(max-width: 1199px)').matches) {
    return window.matchMedia('(orientation: portrait)').matches ? 'tabletPortrait' : 'tabletLandscape';
  }
  if (window.matchMedia(HERO_ULTRAWIDE_QUERY).matches) return 'ultrawide';
  return 'desktop';
}

function useHeroMedia() {
  const [key, setKey] = React.useState(getHeroMediaKey);
  React.useEffect(() => {
    const queries = [
      window.matchMedia('(max-width: 767px)'),
      window.matchMedia('(max-width: 1199px)'),
      window.matchMedia('(orientation: portrait)'),
      window.matchMedia(HERO_ULTRAWIDE_QUERY)
    ];
    const refresh = () => setKey(getHeroMediaKey());
    queries.forEach(query => query.addEventListener ? query.addEventListener('change', refresh) : query.addListener(refresh));
    return () => queries.forEach(query => query.removeEventListener ? query.removeEventListener('change', refresh) : query.removeListener(refresh));
  }, []);
  return [key, HERO_MEDIA[key]];
}

function HeroVideo() {
  const [mediaKey, media] = useHeroMedia();
  return <video data-hero-media={mediaKey} key={media.src} src={media.src} poster={media.poster} width={media.width} height={media.height} autoPlay muted loop playsInline preload="metadata" aria-hidden="true" tabIndex={-1} ref={el => { if (el) { el.muted = true; const p = el.play(); if (p && p.catch) p.catch(() => {}); } }}></video>;
}

function useHeroBand() {
  const get = () => window.matchMedia('(max-width: 767px)').matches ? 'mobile' : window.matchMedia('(max-width: 1199px)').matches ? 'mid' : 'desktop';
  const [band, setBand] = React.useState(get);
  React.useEffect(() => {
    const qs = [window.matchMedia('(max-width: 767px)'), window.matchMedia('(max-width: 1199px)')];
    const f = () => setBand(get());
    qs.forEach(q => q.addEventListener ? q.addEventListener('change', f) : q.addListener(f));
    return () => qs.forEach(q => q.removeEventListener ? q.removeEventListener('change', f) : q.removeListener(f));
  }, []);
  return band;
}

function Hero() {
  const band = useHeroBand();
  const art = <div className="hero4-artlayer" aria-hidden="true">
      {LGFX_REDUCED ?
      <picture>
        <source media="(max-width:767px)" srcSet="assets/hero-poster-mobile.png" width="1080" height="1920"></source>
        <source media="(min-width:768px) and (max-width:1199px) and (orientation:portrait)" srcSet="assets/hero-poster-tablet-portrait-1080x1440.png" width="1080" height="1440"></source>
        <source media="(min-width:768px) and (max-width:1199px)" srcSet="assets/hero-poster-tablet-landscape-1440x1080.png" width="1440" height="1080"></source>
        <source media={HERO_ULTRAWIDE_QUERY} srcSet="assets/hero-poster-ultrawide-3440x1476.webp" width="3440" height="1476"></source>
        <img src="assets/hero-poster.png" width="1920" height="1080" fetchpriority="high" alt=""/>
      </picture> :
      <HeroVideo/>}
    </div>;
  return <section id="top" data-screen-label="Hero" className="hero4">
    {band !== 'mid' ? art : null}
    <Container className="hero4-grid" style={{maxWidth: 1500}}>
      <div className="hero4-copy hd" style={{'--d': '0ms'}}>
        <div className="hd" style={{'--d': '60ms'}}><span className="h4-eyebrow">Agente operacional de inteligência artificial</span></div>
        <h1>
          <span className="lmask"><span className="ln" style={{'--d': '160ms'}}>Ligou?</span></span>
          <span className="lmask"><span className="ln" style={{'--d': '260ms'}}><span className="acc">Atendido.</span></span></span>
        </h1>
        <svg className="hero-wave h4-wave" viewBox="0 0 200 16" fill="none" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M0 8c12-9 25-9 37 0s25 9 37 0 25-9 37 0 25 9 37 0 25-9 37 0" stroke="currentColor" strokeWidth="3" strokeLinecap="round"></path></svg>
        <p className="hd h4-lede" style={{'--d': '380ms'}}>Seu cliente liga. O Ligou consulta suas regras, agenda o trabalho e só te chama quando precisa de aprovação.</p>
        <div className="hd h4-ctas" style={{'--d': '480ms'}}>
          <Button variant="accent" size="lg" href="#prova" onClick={replayDemo}>Falar com o Ligou</Button>
          {band !== 'mobile' && <a className="h4-ghostbtn" href="#diferenca">Ver uma operação completa</a>}
        </div>
        <p className="hd h4-trust" style={{'--d': '560ms'}}>Você ensina em português · Ele atende em inglês, espanhol e português</p>
      </div>
      <div className="hero4-artslot">{band === 'mid' ? art : null}</div>
    </Container>
  </section>;
}

function Scene() {
  const rows = [
    ['brief', 'Serviços', 'Instalação, manutenção e reparos.'],
    ['pin', 'Cidades atendidas', 'San Francisco, Los Angeles, San Diego e região.'],
    ['bell', 'Emergências', '24h para vazamentos e falta de água.']
  ];
  const icons = {
    brief: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.5"></rect><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12h18"></path></svg>),
    pin: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>),
    bell: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 20a2 2 0 0 1-3.4 0"></path></svg>)
  };
  return <section id="diferenca" data-screen-label="A diferença" className="iv">
    <Container style={{maxWidth: 1500}}>
      <div className="iv-head">
        <Reveal><span className="h4-eyebrow eyebrow-mark" aria-hidden="true"></span></Reveal>
        <Reveal delay={80}><h2>O Ligou não é configurado.<br/>Ele é contratado.</h2></Reveal>
        <Reveal delay={150}><p className="iv-sub">Você conversa. O Ligou transforma suas respostas em atendimento.</p></Reveal>
        <Reveal delay={220}><div className="iv-word">Em português.</div></Reveal>
      </div>
      <div className="iv-steps">
        <Reveal className="iv-col iv-col--1" delay={0}>
          <div className="iv-lab"><b>01</b><span>Conversa</span></div>
          <p className="iv-line">Ele te liga primeiro.</p>
          <div className="iv-card iv-card--dark">
            <div className="iv-idrow">
              <span className="iv-avatar"><img className="ligou-avatar" src="assets/ligou-avatar-v1.png" alt=""/></span>
              <span className="iv-id"><b>Ligou</b><i>Agente operacional</i></span>
              <Waveform playing={true}/>
            </div>
            <div className="iv-q">Quais serviços vocês oferecem?</div>
            <div className="iv-callbar"><span className="iv-hang" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-3.6 0-6.9 1.1-9.4 3a2 2 0 0 0-.5 2.6l1 1.7a1.6 1.6 0 0 0 2 .6l2.6-1.1c.6-.3 1-.9 1-1.6v-1.4c2.1-.6 4.5-.6 6.6 0v1.4c0 .7.4 1.3 1 1.6l2.6 1.1a1.6 1.6 0 0 0 2-.6l1-1.7a2 2 0 0 0-.5-2.6C18.9 10.1 15.6 9 12 9Z"></path></svg></span></div>
          </div>
        </Reveal>
        <Reveal className="iv-col iv-col--2" delay={130}>
          <div className="iv-lab"><b>02</b><span>Suas regras</span></div>
          <p className="iv-line">Suas respostas viram regras de operação.</p>
          <div className="iv-card iv-card--light">
            <span className="iv-node" aria-hidden="true"><AgentNodeMark size={40}/></span>
            <div className="iv-rows">
              {rows.map(([ic, t, d]) => <div key={t} className="iv-row"><span className="iv-ric">{icons[ic]}</span><span><b>{t}</b><p>{d}</p></span></div>)}
            </div>
          </div>
        </Reveal>
        <Reveal className="iv-col iv-col--3" delay={260}>
          <div className="iv-lab"><b>03</b><span>Em operação</span></div>
          <p className="iv-line">Ele atende com suas regras.</p>
          <div className="iv-card iv-card--light">
            <div className="iv-readyhead">
              <span className="iv-avatar iv-avatar--ring"><img className="ligou-avatar" src="assets/ligou-avatar-v1.png" alt=""/></span>
              <span>
                <b className="iv-readytitle">Pronto para atender</b>
                <span className="wf-teal"><Waveform playing={true}/></span>
              </span>
            </div>
            <span className="iv-pill">Regras ativas e validadas <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.5 2.5 4.5-5"></path></svg></span>
            <div className="iv-divider"></div>
            <b className="iv-apr">Aprovação para ativar</b>
            <div className="iv-owner">
              <span className="iv-rav">R</span>
              <span className="iv-own"><b>Roberto Almeida</b><i>Proprietário</i></span>
              <span className="iv-approve">Aprovar e ativar <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path></svg></span>
            </div>
          </div>
        </Reveal>
      </div>
      <Reveal delay={150}><div className="iv-rail">
        <span className="iv-railitem"><b>01</b>Ele te liga primeiro</span><span className="iv-dots" aria-hidden="true"></span>
        <span className="iv-railitem"><b>02</b>Ele atende com suas regras</span><span className="iv-dots" aria-hidden="true"></span>
        <span className="iv-railitem"><b>03</b>Ele pergunta antes de aprender</span>
      </div></Reveal>
      <Reveal delay={220}><aside className="iv-memory" aria-label="Memória operacional do Ligou">
        <div className="iv-memory__lead">
          <span className="iv-memory__label">Memória permanente do seu negócio</span>
          <h3>A cada ligação, ele conhece melhor a sua operação.</h3>
        </div>
        <div className="iv-memory__copy">
          <span className="iv-memory__approval">Aprovação de nova regra</span>
          <p><strong>Não é uma secretária eletrônica.</strong> É um agente de inteligência artificial com memória operacional permanente.</p>
          <p>Cada atendimento amplia o histórico do Ligou. Quando aparece uma situação nova, ele pergunta; depois que você aprova, a resposta vira uma regra permanente do seu negócio — até você decidir alterar ou apagar.</p>
        </div>
      </aside></Reveal>
    </Container>
  </section>;
}

function CallDemo() {
  const [mrun, setMrun] = React.useState(0);
  const [mrel, setMrel] = React.useState(false);
  const [boardRef, boardOn] = useInView({threshold: .35});
  const [shellRef, shellOn] = useInView({threshold: .3});
  const replay = () => { setMrel(false); setMrun(m => m + 1); };
  React.useEffect(() => {
    if (typeof window.addEventListener !== 'function') return;
    window.addEventListener('ligou:replay', replay);
    return () => window.removeEventListener('ligou:replay', replay);
  }, []);
  return <section id="prova" data-screen-label="Prova do produto" className="p7">
    <Container style={{maxWidth: 1500}}>
      <Eyebrow className="eyebrow-mark" aria-hidden="true"/>
      <h2 className="p7-title">Quando a regra exige decisão, <br/>ele traz a exceção pronta.</h2>
      <p className="p7-sub p7-bridge">Quando a regra permite, ele resolve sozinho. Quando não permite, traz o caso pronto para você decidir.</p>
      <p className="p7-langnote">Este exemplo está em inglês. O Ligou também atende em espanhol.</p>
      <div className="p7-cq" ref={boardRef}><div className={'p7-board' + (boardOn ? ' on' : '')} key={mrun}>
        <div className="p7-bar">
          <span className="p7-dot"></span>
          <span className="p7-blab">Chamada · Exemplo</span>
          <span className="p7-en">EN</span>
          <svg className="p7-wf" width="210" height="26" viewBox="0 0 210 26" aria-hidden="true"><rect x="0" y="10" width="3.4" height="6" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="7" y="8" width="3.4" height="10" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="14" y="5.5" width="3.4" height="15" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="21" y="8.5" width="3.4" height="9" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="28" y="4" width="3.4" height="18" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="35" y="7" width="3.4" height="12" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="42" y="3" width="3.4" height="20" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="49" y="9" width="3.4" height="8" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="56" y="6" width="3.4" height="14" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="63" y="4.5" width="3.4" height="17" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="70" y="9.5" width="3.4" height="7" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="77" y="7" width="3.4" height="12" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="84" y="3.5" width="3.4" height="19" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="91" y="8" width="3.4" height="10" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="98" y="10" width="3.4" height="6" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="105" y="5.5" width="3.4" height="15" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="112" y="7.5" width="3.4" height="11" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="119" y="4" width="3.4" height="18" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="126" y="9" width="3.4" height="8" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="133" y="6.5" width="3.4" height="13" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="140" y="5" width="3.4" height="16" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="147" y="10" width="3.4" height="6" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="154" y="8" width="3.4" height="10" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="161" y="6" width="3.4" height="14" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="168" y="9.5" width="3.4" height="7" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="175" y="7.5" width="3.4" height="11" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="182" y="4.5" width="3.4" height="17" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="189" y="8.5" width="3.4" height="9" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="196" y="6.5" width="3.4" height="13" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="203" y="10" width="3.4" height="6" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect></svg>
          <span className="p7-lead" aria-hidden="true"></span>
          <span className="p7-time">00:12</span>
          <button className="p7-again" type="button" onClick={replay}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"></path></svg> Ver de novo</button>
        </div>
        <svg className="p7-trail" viewBox="0 0 1360 660" preserveAspectRatio="none" aria-hidden="true">
          <path d="M279 168 C 325 168, 352 162, 374 154" stroke="#c9d4cb" strokeWidth="2" strokeDasharray="3 7" fill="none"></path>
          <path d="M279 452 C 318 462, 342 490, 356 516" stroke="#c9d4cb" strokeWidth="2" strokeDasharray="3 7" fill="none"></path>
          <path d="M652 480 C 690 480, 715 478, 744 476" stroke="#c9d4cb" strokeWidth="2" strokeDasharray="3 7" fill="none"></path>
          <path pathLength="1" d="M381 153 C 452 185, 468 224, 453 286 C 438 348, 384 420, 374 470 C 369 498, 370 522, 372 545" stroke="#7fd0c2" strokeWidth="3" fill="none"></path>
          <circle cx="381" cy="153" r="11" fill="#fff" stroke="#0b655a" strokeWidth="3"></circle><circle cx="381" cy="153" r="4" fill="#0b655a"></circle>
          <circle cx="453" cy="286" r="11" fill="#fff" stroke="#0b655a" strokeWidth="3"></circle><circle cx="453" cy="286" r="4" fill="#0b655a"></circle>
          <circle cx="372" cy="551" r="44" fill="none" stroke="#e8efe7" strokeWidth="10"></circle>
          <circle cx="372" cy="551" r="26" fill="#fff" stroke="#dcebe3" strokeWidth="2"></circle>
        </svg>
        <span className="p7-check" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5.5 12.5 4 4 9-9.5"></path></svg></span>
        <div className="p7-agent" aria-hidden="true"><img src="assets/agent-ligou.png" alt=""/></div>
        <div className="p7-card p7-c1 p7-i" style={{'--lcd': '.45s'}}>
          <span className="p7-clabel"><i className="p7-cd p7-cd--coral"></i>Urgência identificada</span>
          <p className="p7-crule">Possível vazamento ativo</p>
          <div className="p7-cdiv"></div>
          <span className="p7-cmuted">Local</span>
          <p className="p7-cval">San Rafael, CA</p>
        </div>
        <div className="p7-card p7-c2 p7-i" style={{'--lcd': '1.35s'}}>
          <span className="p7-clabel"><i className="p7-cd p7-cd--mint"></i>Regra consultada</span>
          <p className="p7-crule">Atendimento no mesmo dia exige aprovação</p>
          <div className="p7-cdiv"></div>
          <span className="p7-cmuted">Fonte</span>
          <p className="p7-cval">Política de Atendimento · v2.4</p>
        </div>
        <div className="p7-card p7-c3 p7-i" style={{'--lcd': '2.25s'}}>
          <span className="p7-clabel"><i className="p7-cd p7-cd--coral"></i>Responsável avisado</span>
          <p className="p7-crule">Pedido urgente enviado</p>
          <div className="p7-cdiv"></div>
          <div className="p7-strow"><span className="p7-cmuted">Status</span><span className="p7-bang"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5M12 16.4v.2"></path></svg></span></div>
          <p className="p7-crule" style={{margin: '4px 0 0'}}>Aguardando decisão</p>
        </div>
        <div className="p7-brow p7-b1 p7-i" style={{'--lcd': '0s'}}><span className="p7-bub p7-bub--mint"><span className="p7-blbl">Cliente · Inglês</span><span lang="en-US">Hi, water is coming in near the chimney in San Rafael.<br/>Is there any chance someone can come today?</span></span><span className="p7-ts">00:02</span></div>
        <div className="p7-brow p7-b2 p7-i" style={{'--lcd': '.9s'}}><span className="p7-bub"><span className="p7-blbl">Ligou · Inglês</span><span lang="en-US">I can help. Same-day visits need team approval,<br/>so I’ll check availability now.</span></span><span className="p7-ts">00:06</span></div>
        <div className="p7-brow p7-b3 p7-i" style={{'--lcd': '1.8s'}}><span className="p7-bub"><span className="p7-blbl">Ligou · Inglês</span><span lang="en-US">I’ve sent your request to the team.<br/>The team will contact you as soon as they confirm.</span></span><span className="p7-ts">00:10</span></div>
        <aside className="p7-drawer p7-i" style={{'--lcd': '2.7s'}} aria-label="Resumo em português">
          <span className="p7-tab" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 5 7 7-7 7"></path></svg></span>
          <div className="p7-dhead"><span className="p7-dot"></span>Resumo em português</div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4.5 20c1.6-3.2 4.3-5 7.5-5s5.9 1.8 7.5 5"></path></svg></span><span><b className="p7-dname">John Miller</b><span className="p7-dval p7-dval--nw">(415) XXX-XXXX</span></span></div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg></span><span><span className="p7-dlab">Local</span><span className="p7-dval p7-dval--nw">San Rafael, CA</span></span></div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5"></rect><path d="M8 3v4M16 3v4M3.5 10.5h17"></path></svg></span><span><span className="p7-dlab">Pedido</span><span className="p7-dval p7-dval--nw">Atendimento hoje</span></span></div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 5 5.8v5.4c0 4.6 3 8 7 9.8 4-1.8 7-5.2 7-9.8V5.8L12 3Z"></path><path d="m9 11.5 2.2 2.2 3.8-4.2"></path></svg></span><span><span className="p7-dlab">Regra aplicada</span><span className="p7-dval">Encaixe no mesmo dia exige aprovação.</span></span></div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l4 4v14H7V3Z"></path><path d="M14 3v4h4M10 12h5M10 15.5h5"></path></svg></span><span><span className="p7-dlab">Relato do cliente</span><span className="p7-dval p7-dval--sm">Água entrando próxima à chaminé após a chuva. O cliente pediu atendimento hoje. Nenhum horário nem preço foi prometido.</span></span></div>
          <div className="p7-ddiv"></div>
          <span className="p7-decision">Decisão de exceção</span>
          <p className="p7-darrow">→ Aguardando sua decisão.</p>
          <div className="p7-dbtns"><span className="p7-apr">Aprovar encaixe</span><span className="p7-adj">Ajustar resposta</span></div>
        </aside>
      </div></div>
      <div className="p7m" ref={shellRef}>
        <div className={'lc-shell' + (shellOn ? ' on' : '')} key={mrun}>
          <div className="lc-head lc-i" style={{'--lcd': '0s'}}>
            <span className="lc-avatar lc-avatar--head"><img className="ligou-avatar" src="assets/ligou-avatar-v1.png" alt=""/></span>
            <span className="lc-id"><b>Ligou em chamada</b><span className="lc-idsub"><i className="lc-en">EN</i><i className="lc-en lc-ex">Chamada · Exemplo</i><svg className="lc-wf" width="120" height="22" viewBox="0 0 120 22" aria-hidden="true"><rect x="0" y="8.5" width="3" height="5" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="6" y="6.5" width="3" height="9" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="12" y="4.5" width="3" height="13" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="18" y="7.5" width="3" height="7" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="24" y="3.5" width="3" height="15" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="30" y="6" width="3" height="10" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="36" y="3" width="3" height="16" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="42" y="8" width="3" height="6" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="48" y="5" width="3" height="12" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="54" y="4" width="3" height="14" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="60" y="8" width="3" height="6" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="66" y="6" width="3" height="10" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="72" y="3.5" width="3" height="15" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="78" y="7" width="3" height="8" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="84" y="8.5" width="3" height="5" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="90" y="5" width="3" height="12" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="96" y="6.5" width="3" height="9" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="102" y="4" width="3" height="14" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="108" y="7.5" width="3" height="7" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="114" y="5.5" width="3" height="11" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect></svg></span></span>
            <span className="lc-htime">00:12</span>
            <button className="lc-again" type="button" onClick={replay}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"></path></svg><span>Ver de novo</span></button>
          </div>
          <div className="lc-convo">
            <div className="lc-row lc-row--cust lc-i" style={{'--lcd': '.1s'}}>
              <div className="lc-msg">
                <span className="lc-who">Cliente · Inglês<i className="lc-ts">00:02</i></span>
                <div className="lc-bub lc-bub--cust" lang="en-US">Hi, water is coming in near the chimney in San Rafael. Is there any chance someone can come today?</div>
              </div>
              <span className="lc-face lc-face--jm">JM</span>
            </div>
            <div className="lc-ev lc-i" style={{'--lcd': '.55s'}}><span className="lc-evline" aria-hidden="true"></span><i className="lc-evdot" style={{background: 'var(--lg-orange-500)'}}></i><span><b>Urgência identificada</b><em>Possível vazamento ativo · San Rafael, CA</em></span></div>
            <div className="lc-row lc-i" style={{'--lcd': '1s'}}>
              <span className="lc-face lc-face--lg"><img className="ligou-avatar" src="assets/ligou-avatar-v1.png" alt=""/></span>
              <div className="lc-msg">
                <span className="lc-who">Ligou · Inglês<i className="lc-ts">00:06</i></span>
                <div className="lc-bub" lang="en-US">I can help. Same-day visits need team approval, so I’ll check availability now.</div>
              </div>
            </div>
            <div className="lc-ev lc-i" style={{'--lcd': '1.45s'}}><span className="lc-evline" aria-hidden="true"></span><i className="lc-evdot" style={{background: 'var(--lg-teal-400)'}}></i><span><b>Regra consultada</b><em>Mesmo dia exige aprovação · Política v2.4</em></span></div>
            <div className="lc-row lc-i" style={{'--lcd': '1.9s'}}>
              <span className="lc-face lc-face--lg"><img className="ligou-avatar" src="assets/ligou-avatar-v1.png" alt=""/></span>
              <div className="lc-msg">
                <span className="lc-who">Ligou · Inglês<i className="lc-ts">00:10</i></span>
                <div className="lc-bub" lang="en-US">I’ve sent your request to the team. The team will contact you as soon as they confirm.</div>
              </div>
            </div>
            <div className="lc-ev lc-i" style={{'--lcd': '2.35s'}}><span className="lc-evline" aria-hidden="true"></span><i className="lc-evdot" style={{background: 'var(--lg-orange-500)'}}></i><span><b>Responsável avisado</b><em>Pedido urgente enviado · Aguardando decisão</em></span></div>
          </div>
          <aside className="lc-sheet lc-i" style={{'--lcd': '2.85s'}} aria-label="Resumo em português">
            <div className="lc-dhead"><span className="lc-ddot"></span>Resumo em português</div>
            <div className="lc-drow"><span className="lc-dic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4.5 20c1.6-3.2 4.3-5 7.5-5s5.9 1.8 7.5 5"></path></svg></span><p><b>John Miller</b> · (415) XXX-XXXX</p></div>
            <div className="lc-drow"><span className="lc-dic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg></span><p>San Rafael, CA</p></div>
            <div className="lc-drow"><span className="lc-dic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5"></rect><path d="M8 3v4M16 3v4M3.5 10.5h17"></path></svg></span><p>Atendimento hoje</p></div>
            <div className="lc-drow"><span className="lc-dic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 5 5.8v5.4c0 4.6 3 8 7 9.8 4-1.8 7-5.2 7-9.8V5.8L12 3Z"></path><path d="m9 11.5 2.2 2.2 3.8-4.2"></path></svg></span><p>Regra: encaixe no mesmo dia exige aprovação</p></div>
            <button className="lc-rel" type="button" id="lc-rel-toggle" aria-expanded={mrel ? 'true' : 'false'} aria-controls="lc-relato-full" onClick={() => setMrel(r => !r)}>{mrel ? 'Ocultar relato' : 'Ver relato completo'}</button>
            {mrel && <p className="lc-relato" id="lc-relato-full">Água entrando próxima à chaminé após a chuva. O cliente pediu atendimento hoje. Nenhum horário nem preço foi prometido.</p>}
            <span className="p7-decision">Decisão de exceção</span>
            <p className="lc-darrow">→ Aguardando sua decisão</p>
            <div className="lc-btns"><span className="lc-apr">Aprovar encaixe</span><span className="lc-adj">Ajustar resposta</span></div>
          </aside>
        </div>
      </div>
    </Container>
  </section>;
}

function Dor() {
  return <section className="dor-section" data-screen-label="A dor" style={{background: 'var(--surface-sunken)', borderBottom: '1px solid var(--border-soft)'}}>
    <Container className="dor-ct" style={{padding: '64px 32px 88px', display: 'flex', flexDirection: 'column', gap: 26}}>
      <Reveal><Eyebrow className="eyebrow-mark" aria-hidden="true"/></Reveal>
      <Reveal delay={80}><h2 className="dorbig">A ligação que você não atende <span className="acc">não fica esperando.</span></h2></Reveal>
      <Reveal delay={140}><p style={{margin: 0, fontSize: 'var(--t-lede)', color: 'var(--text-secondary)', maxWidth: 680}}>Para o brasileiro que toca uma empresa de serviços nos EUA, atender nem sempre cabe no meio do trabalho. Você está no telhado, dirigindo ou com outro cliente — e a ligação cai na caixa postal.</p></Reveal>
      <Reveal delay={200}><p style={{margin: 0, fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--t-h3)', letterSpacing: 'var(--track-tight)', maxWidth: 680}}>Para quem ligou, a próxima empresa está a um toque de distância. Em inglês ou espanhol, essa oportunidade fica ainda mais difícil de disputar.</p></Reveal>
    </Container>
  </section>;
}

function Faz() {
  const mobile = useHeroBand() === 'mobile';
  const items = ['Entende o que o cliente precisa e coleta nome, endereço e detalhes importantes', 'Aplica as regras que você definiu sem prometer o que não está autorizado', 'Verifica disponibilidade e agenda dentro das suas regras', 'Transfere urgências ou envia um aviso, conforme você definiu', 'Envia um resumo em português e registra a ligação para você revisar'];
  const item = t => <div className="checkitem"><b>→</b>{t}</div>;
  return <section data-screen-label="O que ele faz" style={{marginTop: 116}}>
    <Container>
      <SectionHead title="O que ele faz quando o telefone toca."/>
      {mobile ? <Reveal><div className="checklist">{items.map(t => <React.Fragment key={t}>{item(t)}</React.Fragment>)}</div></Reveal> : <div className="checklist">{items.map((t, i) => <Reveal key={t} delay={(i % 2) * 70}>{item(t)}</Reveal>)}</div>}
    </Container>
  </section>;
}

function Comecar() {
  const mobile = useHeroBand() === 'mobile';
  const steps = [
    ['01', 'Fale com o Ligou', 'Comece pela demonstração.'],
    ['02', 'Contrate o Ligou', 'Plano mês a mês, sem fidelidade.'],
    ['03', 'Ensine sua operação', 'Em uma conversa curta, ele te entrevista em português e cria a primeira versão do atendimento.'],
    ['04', 'Teste e aprove', 'Ajuste o que quiser e só aprove quando estiver satisfeito.'],
    ['05', 'Coloque no ar', 'Use o número do Ligou ou redirecione o seu para começar a atender.']
  ];
  const card = ([n, t, d]) => <div className="startcard"><span className="sn">{n}</span><b>{t}</b><p>{d}</p></div>;
  return <section id="comecar" data-screen-label="Como começar" style={{marginTop: 116}}>
    <Container>
      <SectionHead eyebrow="Como começar" title="Conheça o Ligou. Ensine sua operação. Só coloque no ar depois de aprovar."/>
      {mobile ? <Reveal><div className="startgrid">{steps.map(step => <React.Fragment key={step[0]}>{card(step)}</React.Fragment>)}</div></Reveal> : <div className="startgrid">{steps.map((step, i) => <Reveal key={step[0]} delay={i * 70}>{card(step)}</Reveal>)}</div>}
    </Container>
  </section>;
}

function Faq() {
  const [open, setOpen] = useState(0);
  const mobile = useHeroBand() === 'mobile';
  const qs = [
    ['Ele pode inventar um preço ou uma resposta?', 'Não. O Ligou só informa preços, condições e políticas que você aprovou. Quando não tem uma resposta autorizada, coleta as informações, avisa que a equipe confirma e pergunta para você. A resposta só vira regra depois da sua aprovação.'],
    ['E se o cliente quiser falar comigo?', 'Você escolhe: quando transferir na hora, quando só receber aviso, e quando deixar o Ligou concluir sozinho.'],
    ['Ele fala que é inteligência artificial?', <React.Fragment>Sim. Ele se apresenta como o agente de inteligência artificial da sua empresa: "<span lang="en-US">Hi, you’ve reached [Your Business]. I’m their AI assistant — how can I help?</span>" A conversa é natural, e a confiança do seu cliente não depende de fingir que existe uma pessoa do outro lado.</React.Fragment>],
    ['Preciso falar inglês ou espanhol para ensinar o Ligou?', 'Não. A entrevista, os ajustes e a aprovação são em português. O Ligou atende em inglês, espanhol ou português e envia o resumo para você em português.'],
    ['E se eu quiser cancelar?', 'Você cancela pelo painel, sem multa e sem precisar falar com vendedor.']
  ];
  const item = ([q, a], i) => <div className={`faq-item ${open === i ? 'open' : ''}`}>
    <button className="faq-q" onClick={() => setOpen(open === i ? -1 : i)} aria-expanded={open === i}>{q}<span className="pm">+</span></button>
    <div className="faq-a" aria-hidden={open === i ? undefined : true}><p>{a}</p></div>
  </div>;
  return <section id="faq" data-screen-label="FAQ" style={{marginTop: 116}}>
    <Container style={{maxWidth: 880}}>
      <SectionHead title="O que todo dono pergunta."/>
      {mobile ? <Reveal><div>{qs.map((qa, i) => <React.Fragment key={qa[0]}>{item(qa, i)}</React.Fragment>)}</div></Reveal> : <div>{qs.map((qa, i) => <Reveal key={qa[0]} delay={i * 50}>{item(qa, i)}</Reveal>)}</div>}
    </Container>
  </section>;
}

function Pricing() {
  const label = {fontSize: 'var(--t-label)', fontWeight: 'var(--t-label-weight)', letterSpacing: 'var(--t-label-track)', textTransform: 'uppercase'};
  const inc = ['Uma empresa e uma localização', 'Número do Ligou ou redirecionamento do seu', 'Atendimento em inglês, espanhol e português', 'Onboarding, regras e aprovação em português', 'Integração de agenda, resumos e histórico das ligações', '400 minutos/mês · excedente $0.35/min'];
  return <section id="preco" data-screen-label="Preço" style={{marginTop: 110, background: 'var(--surface-inverse)', color: 'var(--text-inverse)'}}>
    <Container className="price-ct" style={{padding: '92px 32px 100px'}}>
      <Reveal><span className="pt-cap__label">Preço</span></Reveal>
      <Reveal delay={90}><h2 style={{margin: '18px 0 0', fontSize: 'var(--t-h2-price)', fontWeight: 'var(--weight-black)', letterSpacing: 'var(--track-display)', lineHeight: 'var(--leading-display)'}}>Contrate até 31 de dezembro de 2026 por $299/mês.</h2></Reveal>
      <div className="pricegrid">
        <Reveal delay={120}><Card style={{padding: '36px 36px 40px', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start', height: '100%', boxSizing: 'border-box', color: 'var(--text-body)'}}>
          <Badge variant="orange">Oferta por tempo limitado</Badge>
          <div style={{display: 'flex', alignItems: 'baseline', gap: 6, color: 'var(--lg-ink-950)', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'clamp(56px,6vw,80px)', letterSpacing: 'var(--track-display)', lineHeight: 1, margin: '4px 0 0'}}>
            <span style={{fontVariantNumeric: 'tabular-nums'}}>$299</span><span style={{fontSize: '0.28em', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: 'var(--track-tight)'}}>/mês</span>
          </div>
          <p style={{margin: 0, color: 'var(--text-secondary)', fontSize: 15}}>Ativação isenta. Quem contratar até 31 de dezembro de 2026 mantém o valor base de $299/mês enquanto a assinatura permanecer ativa.</p>
          <div className="inclist">
            {inc.map(t => <div key={t} className="incitem"><b>→</b>{t}</div>)}
          </div>
          <p className="price-mobile-normal">Para novas assinaturas após a oferta: $499/mês + ativação de $499.</p>
          <Button variant="accent" href="#prova" onClick={replayDemo} style={{marginTop: 8}}>Quero aproveitar a oferta</Button>
        </Card></Reveal>
        <Reveal className="price-regular-reveal" delay={220}><div className="pricecard--ghost" style={{display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'flex-start', justifyContent: 'center', height: '100%', boxSizing: 'border-box'}}>
          <span style={{...label, color: 'var(--text-inverse-secondary)'}}>Depois da oferta</span>
          <div style={{display: 'flex', alignItems: 'baseline', gap: 6, fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'clamp(40px,4vw,52px)', letterSpacing: 'var(--track-display)', lineHeight: 1, color: 'var(--text-inverse)'}}>$499<span style={{fontSize: '0.42em', fontWeight: 700, color: 'var(--text-inverse-secondary)'}}>/mês</span></div>
          <p style={{margin: 0, color: 'var(--text-inverse-secondary)', fontSize: 15}}>Para novas assinaturas, com ativação de $499.</p>
        </div></Reveal>
      </div>
      <Reveal delay={140}><p style={{margin: '34px 0 0', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--t-h3)', letterSpacing: 'var(--track-tight)', maxWidth: 640}}>Se uma única ligação recuperada vale mais de $499 para o seu negócio, o Ligou pode se pagar com um único trabalho.</p></Reveal>
      <Reveal delay={200}><p style={{margin: '10px 0 0', color: 'var(--text-inverse-secondary)', fontSize: 'var(--t-small)'}}>Plano mês a mês. Sem fidelidade.</p></Reveal>
    </Container>
  </section>;
}

function Cta() {
  const [ref, on] = useInView({threshold: .3});
  return <section ref={ref} className="cta" data-screen-label="CTA final">
    <Container style={{position: 'relative', zIndex: 1}}>
      <Reveal><p style={{margin: '0 0 26px', color: 'var(--lg-teal-400)', fontSize: 'var(--t-label)', fontWeight: 'var(--t-label-weight)', letterSpacing: 'var(--t-label-track)', textTransform: 'uppercase'}}>Seu negócio pode atender em inglês e espanhol — mesmo que você fale só português</p></Reveal>
      <h2 className={on ? 'wr-on' : ''} style={{maxWidth: '72%'}}>
        <span className="lmask"><span className="ln" style={{'--d': '60ms'}}>Ligou?</span></span>
        <span className="lmask"><span className="ln acc" style={{'--d': '220ms'}}>Atendido.</span></span>
      </h2>
      <Reveal delay={380}><div style={{display: 'flex', gap: 12, marginTop: 34, flexWrap: 'wrap'}}>
        <Button variant="accent" size="lg" href="#prova" onClick={replayDemo}>Falar com o Ligou agora</Button>
      </div></Reveal>
    </Container>
    <img className="cta-robot floaty" src="assets/crop-robot.png" alt=""/>
  </section>;
}

function Footer() {
  const a = {color: 'var(--text-inverse-secondary)', textDecoration: 'none'};
  return <footer data-screen-label="Footer" style={{background: 'var(--surface-inverse-deep)', color: 'var(--text-inverse)', borderTop: '1px solid rgba(251,252,248,.1)', overflow: 'hidden'}}>
    <Container style={{padding: '56px 32px 0'}}>
      <div className="footer-row" style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'}}>
        <img src="assets/crop-logo-mark.png" alt="" style={{height: 34, borderRadius: '50%'}}/>
        <span style={{fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '-0.02em'}}>Ligou</span>
        <a className="footer-client" href="/dashboard/">Área do cliente</a>
        <span className="footer-links" style={{display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 'var(--t-small)', alignItems: 'center'}}>
          <a href="https://ligou.ai" style={a}>ligou.ai</a><span style={{opacity: .4}}>·</span>
          <a href="mailto:suporte@ligou.ai" style={a}>suporte@ligou.ai</a><span style={{opacity: .4}}>·</span>
          <span style={a}>Termos</span><span style={{opacity: .4}}>·</span>
          <span style={a}>Privacidade</span>
        </span>
      </div>
      <p style={{margin: '16px 0 0', maxWidth: 440, color: 'var(--text-inverse-secondary)', fontSize: 15}}>Feito por um brasileiro nos EUA que cansou de ver conterrâneo perdendo venda no telefone.</p>
    </Container>
    <div className="bigword" aria-hidden="true">Ligou</div>
  </footer>;
}

function App() {
  const [ready, setReady] = useState(false);
  return <React.Fragment>
    <Intro4 onDone={() => setReady(true)}/>
    <ScrollProgress/>
    <Nav/>
    <main className={ready ? 'play' : ''}>
      <Hero/>
      <div className="mqwrap" aria-hidden="true">
        <Marquee rev items={['Limpeza', 'Pintura', 'Roofing', 'Landscaping', 'HVAC', 'Junk removal', 'Pavers', 'Piscinas', 'Remodeling', 'Elétrica', 'Encanamento']}/>
        <div className="mq-claims"><Marquee small items={['Atende em inglês, espanhol e português', 'Você ensina em português', 'Agenda dentro das suas regras', 'Não inventa preço', 'Resume em português', 'Pergunta antes de aprender']}/></div>
      </div>
      <Dor/>
      <CallDemo/>
      <WaveDraw style={{maxWidth: 'var(--container)', margin: '0 auto', padding: '0 32px'}}/>
      <Scene/>
      <Faz/>
      <Comecar/>
      <Faq/>
      <Pricing/>
      <Cta/>
    </main>
    <Footer/>
  </React.Fragment>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
