const DS = window.LigouDesignSystem_a33905;
const {Button, Badge, Tag, Card, Eyebrow, StepBadge, CalloutCapsule} = DS;
const {useState, useEffect, useRef} = React;
const DEMO_PHONE = '(XXX) XXX-XXXX';

function Container({style, className = '', children}) {
  return <div className={'ct ' + className} style={{maxWidth: 'var(--container)', margin: '0 auto', padding: '0 32px', ...style}}>{children}</div>;
}

function SectionHead({eyebrow, title, lede, center}) {
  return <div style={{display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 44, alignItems: center ? 'center' : 'flex-start', textAlign: center ? 'center' : 'left'}}>
    <Reveal><Eyebrow>{eyebrow}</Eyebrow></Reveal>
    <Reveal delay={90}><h2 style={{fontSize: 'var(--size-display)', fontWeight: 'var(--weight-black)', letterSpacing: 'var(--track-display)', lineHeight: 'var(--leading-display)'}}>{title}</h2></Reveal>
    {lede && <Reveal delay={170}><p style={{margin: 0, fontSize: 'var(--size-body-lg)', color: 'var(--text-secondary)', maxWidth: 620}}>{lede}</p></Reveal>}
  </div>;
}

function Intro4({onDone}) {
  const [txt, setTxt] = useState(0);
  const [out, setOut] = useState(false);
  const doneRef = useRef(false);
  const fire = () => { if (!doneRef.current) { doneRef.current = true; onDone(); } };
  useEffect(() => {
    if (LGFX_REDUCED) { fire(); return; }
    const t1 = setTimeout(() => setTxt(1), 900);
    const t2 = setTimeout(() => setOut(true), 1750);
    const t3 = setTimeout(fire, 2450);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);
  if (LGFX_REDUCED) return null;
  const skip = () => { setOut(true); setTimeout(fire, 300); };
  return <div className={'intro intro4 ' + (out ? 'out' : '')} onClick={skip} role="presentation">
    <div className="intro__veil"></div>
    <div className="intro__panel">
      <div className="intro4__mark"><AgentNodeMark size={86}/></div>
      {txt === 0 ? <div className="intro__t" key="a">Ligou?</div> : <div className="intro__t" key="b"><span className="acc">Atendido.</span></div>}
      <span className="intro__cap">ligou.ai · agente operacional</span>
      <div className="intro__bar"></div>
    </div>
  </div>;
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
        <L id="diferenca">Como trabalha</L><L id="faq">Controle</L><L id="prova">Demo</L><L id="preco">Preço</L>
      </nav>
      <span style={{marginLeft: 'auto'}} className="nav4-cta"><Button size="sm" variant="accent" href="#prova" style={{whiteSpace: 'nowrap'}}>Quero testar</Button></span>
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
      <div className="hero4-copy hd" style={{'--d': '40ms'}}>
        <div className="hd" style={{'--d': '60ms'}}><span className="h4-eyebrow">Agente operacional para negócios de serviços</span></div>
        <h1>
          <span className="lmask"><span className="ln" style={{'--d': '160ms'}}>Ligou?</span></span>
          <span className="lmask"><span className="ln" style={{'--d': '290ms'}}><span className="acc">Atendido.</span></span></span>
        </h1>
        <svg className="hero-wave h4-wave" viewBox="0 0 200 16" fill="none" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M0 8c12-9 25-9 37 0s25 9 37 0 25-9 37 0 25 9 37 0 25-9 37 0" stroke="currentColor" strokeWidth="3" strokeLinecap="round"></path></svg>
        <p className="hd h4-lede" style={{'--d': '440ms'}}>Seu cliente liga. O Ligou consulta suas regras, agenda o trabalho e só te chama quando precisa de aprovação.</p>
        <div className="hd h4-ctas" style={{'--d': '560ms'}}>
          <Button variant="accent" size="lg" href="#prova">Falar com o Ligou</Button>
          <a className="h4-ghostbtn" href="#diferenca">Ver uma operação completa</a>
        </div>
        <p className="hd h4-trust" style={{'--d': '680ms'}}>Configurado em português · Opera em inglês e português</p>
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
        <Reveal><span className="h4-eyebrow">A diferença</span></Reveal>
        <Reveal delay={80}><h2>O Ligou não é configurado.<br/>Ele é contratado.</h2></Reveal>
        <Reveal delay={150}><p className="iv-sub">Você conversa. O Ligou transforma suas respostas em atendimento.</p></Reveal>
        <Reveal delay={220}><div className="iv-word">Entrevista.</div></Reveal>
      </div>
      <div className="iv-steps">
        <Reveal className="iv-col iv-col--1" delay={0}>
          <div className="iv-lab"><b>01</b><span>Conversa</span></div>
          <p className="iv-line">Ele te liga primeiro.</p>
          <div className="iv-card iv-card--dark">
            <div className="iv-idrow">
              <span className="iv-avatar"><img className="iv-av-d" src="assets/crop-robot-head.png" alt=""/><img className="iv-av-m" src="assets/agent-full.png" alt=""/></span>
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
              <span className="iv-avatar iv-avatar--ring"><img className="iv-av-d" src="assets/crop-robot-head.png" alt=""/><img className="iv-av-m" src="assets/agent-full.png" alt=""/></span>
              <span>
                <b className="iv-readytitle">Pronto para atender</b>
                <span className="wf-teal"><Waveform playing={true}/></span>
              </span>
            </div>
            <span className="iv-pill">Regras ativas e validadas <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.5 2.5 4.5-5"></path></svg></span>
            <div className="iv-divider"></div>
            <b className="iv-apr">Aprovação do responsável</b>
            <div className="iv-owner">
              <span className="iv-rav">R</span>
              <span className="iv-own"><b>Roberto Almeida</b><i>Proprietário</i></span>
              <button className="iv-approve" type="button">Aprovar e ativar <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path></svg></button>
            </div>
          </div>
        </Reveal>
      </div>
      <Reveal delay={150}><div className="iv-rail">
        <span className="iv-railitem"><b>01</b>Ele te liga primeiro</span><span className="iv-dots" aria-hidden="true"></span>
        <span className="iv-railitem"><b>02</b>Ele atende com suas regras</span><span className="iv-dots" aria-hidden="true"></span>
        <span className="iv-railitem"><b>03</b>Ele pergunta antes de aprender</span>
      </div></Reveal>
    </Container>
  </section>;
}

function CallDemo() {
  const [mrun, setMrun] = React.useState(0);
  const [mrel, setMrel] = React.useState(false);
  return <section id="prova" data-screen-label="Prova do produto" className="p7">
    <Container style={{maxWidth: 1500}}>
      <Eyebrow>Prova do produto</Eyebrow>
      <h2 className="p7-title">Dentro das suas regras, ele resolve.<br/>Fora delas, ele pergunta.</h2>
      <p className="p7-sub">O Ligou conduz a conversa em inglês, executa o que já está autorizado e chama você somente quando encontra uma exceção.</p>
      <div className="p7-cq"><div className="p7-board">
        <div className="p7-bar">
          <span className="p7-dot"></span>
          <span className="p7-blab">Chamada · Exemplo</span>
          <span className="p7-en">EN</span>
          <svg className="p7-wf" width="210" height="26" viewBox="0 0 210 26" aria-hidden="true"><rect x="0" y="10" width="3.4" height="6" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="7" y="8" width="3.4" height="10" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="14" y="5.5" width="3.4" height="15" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="21" y="8.5" width="3.4" height="9" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="28" y="4" width="3.4" height="18" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="35" y="7" width="3.4" height="12" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="42" y="3" width="3.4" height="20" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="49" y="9" width="3.4" height="8" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="56" y="6" width="3.4" height="14" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="63" y="4.5" width="3.4" height="17" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="70" y="9.5" width="3.4" height="7" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="77" y="7" width="3.4" height="12" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="84" y="3.5" width="3.4" height="19" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="91" y="8" width="3.4" height="10" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="98" y="10" width="3.4" height="6" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="105" y="5.5" width="3.4" height="15" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="112" y="7.5" width="3.4" height="11" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="119" y="4" width="3.4" height="18" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="126" y="9" width="3.4" height="8" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="133" y="6.5" width="3.4" height="13" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="140" y="5" width="3.4" height="16" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="147" y="10" width="3.4" height="6" rx="1.7" fill="var(--lg-teal-500)"></rect><rect x="154" y="8" width="3.4" height="10" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="161" y="6" width="3.4" height="14" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="168" y="9.5" width="3.4" height="7" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="175" y="7.5" width="3.4" height="11" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="182" y="4.5" width="3.4" height="17" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="189" y="8.5" width="3.4" height="9" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="196" y="6.5" width="3.4" height="13" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="203" y="10" width="3.4" height="6" rx="1.7" fill="var(--lg-teal-500)" opacity=".45"></rect></svg>
          <span className="p7-lead" aria-hidden="true"></span>
          <span className="p7-time">00:12</span>
          <span className="p7-again"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"></path></svg> Ver de novo</span>
        </div>
        <svg className="p7-trail" viewBox="0 0 1360 660" preserveAspectRatio="none" aria-hidden="true">
          <path d="M279 168 C 325 168, 352 162, 374 154" stroke="#c9d4cb" strokeWidth="2" strokeDasharray="3 7" fill="none"></path>
          <path d="M279 452 C 318 462, 342 490, 356 516" stroke="#c9d4cb" strokeWidth="2" strokeDasharray="3 7" fill="none"></path>
          <path d="M652 480 C 690 480, 715 478, 744 476" stroke="#c9d4cb" strokeWidth="2" strokeDasharray="3 7" fill="none"></path>
          <path d="M381 153 C 452 185, 468 224, 453 286 C 438 348, 384 420, 374 470 C 369 498, 370 522, 372 545" stroke="#7fd0c2" strokeWidth="3" fill="none"></path>
          <circle cx="381" cy="153" r="11" fill="#fff" stroke="#0b655a" strokeWidth="3"></circle><circle cx="381" cy="153" r="4" fill="#0b655a"></circle>
          <circle cx="453" cy="286" r="11" fill="#fff" stroke="#0b655a" strokeWidth="3"></circle><circle cx="453" cy="286" r="4" fill="#0b655a"></circle>
          <circle cx="372" cy="551" r="44" fill="none" stroke="#e8efe7" strokeWidth="10"></circle>
          <circle cx="372" cy="551" r="26" fill="#fff" stroke="#dcebe3" strokeWidth="2"></circle>
        </svg>
        <span className="p7-check" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5.5 12.5 4 4 9-9.5"></path></svg></span>
        <div className="p7-agent" aria-hidden="true"><img src="assets/agent-ligou.png" alt=""/></div>
        <div className="p7-card p7-c1">
          <span className="p7-clabel"><i className="p7-cd p7-cd--coral"></i>Urgência identificada</span>
          <p className="p7-crule">Possível vazamento ativo</p>
          <div className="p7-cdiv"></div>
          <span className="p7-cmuted">Local</span>
          <p className="p7-cval">San Rafael, CA</p>
        </div>
        <div className="p7-card p7-c2">
          <span className="p7-clabel"><i className="p7-cd p7-cd--mint"></i>Regra consultada</span>
          <p className="p7-crule">Atendimento no mesmo dia exige aprovação</p>
          <div className="p7-cdiv"></div>
          <span className="p7-cmuted">Fonte</span>
          <p className="p7-cval">Política de Atendimento · v2.4</p>
        </div>
        <div className="p7-card p7-c3">
          <span className="p7-clabel"><i className="p7-cd p7-cd--coral"></i>Responsável avisado</span>
          <p className="p7-crule">Pedido urgente enviado</p>
          <div className="p7-cdiv"></div>
          <div className="p7-strow"><span className="p7-cmuted">Status</span><span className="p7-bang"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5M12 16.4v.2"></path></svg></span></div>
          <p className="p7-crule" style={{margin: '4px 0 0'}}>Aguardando decisão</p>
        </div>
        <div className="p7-brow p7-b1"><span className="p7-bub p7-bub--mint"><span className="p7-blbl">Cliente · Inglês</span>Hi, water is coming in near the chimney in San Rafael.<br/>Is there any chance someone can come today?</span><span className="p7-ts">00:02</span></div>
        <div className="p7-brow p7-b2"><span className="p7-bub"><span className="p7-blbl">Ligou · Inglês</span>I can help. Same-day visits need team approval,<br/>so I’ll check availability now.</span><span className="p7-ts">00:06</span></div>
        <div className="p7-brow p7-b3"><span className="p7-bub"><span className="p7-blbl">Ligou · Inglês</span>I’ve sent your request to the team.<br/>You’ll receive a text as soon as they confirm.</span><span className="p7-ts">00:10</span></div>
        <aside className="p7-drawer">
          <span className="p7-tab" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 5 7 7-7 7"></path></svg></span>
          <div className="p7-dhead"><span className="p7-dot"></span>Resumo em português</div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4.5 20c1.6-3.2 4.3-5 7.5-5s5.9 1.8 7.5 5"></path></svg></span><span><b className="p7-dname">John Miller</b><span className="p7-dval p7-dval--nw">(415) XXX-XXXX</span></span></div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg></span><span><span className="p7-dlab">Local</span><span className="p7-dval p7-dval--nw">San Rafael, CA</span></span></div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5"></rect><path d="M8 3v4M16 3v4M3.5 10.5h17"></path></svg></span><span><span className="p7-dlab">Pedido</span><span className="p7-dval p7-dval--nw">Atendimento hoje</span></span></div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 5 5.8v5.4c0 4.6 3 8 7 9.8 4-1.8 7-5.2 7-9.8V5.8L12 3Z"></path><path d="m9 11.5 2.2 2.2 3.8-4.2"></path></svg></span><span><span className="p7-dlab">Regra aplicada</span><span className="p7-dval">Encaixe no mesmo dia exige aprovação.</span></span></div>
          <div className="p7-drow"><span className="p7-dic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l4 4v14H7V3Z"></path><path d="M14 3v4h4M10 12h5M10 15.5h5"></path></svg></span><span><span className="p7-dlab">Relato do cliente</span><span className="p7-dval p7-dval--sm">Água entrando próxima à chaminé após a chuva. O cliente pediu atendimento hoje. Nenhum horário nem preço foi prometido.</span></span></div>
          <div className="p7-ddiv"></div>
          <p className="p7-darrow">→ Aguardando sua decisão.</p>
          <div className="p7-dbtns"><button className="p7-apr" type="button">Aprovar encaixe</button><button className="p7-adj" type="button">Ajustar resposta</button></div>
        </aside>
      </div></div>
      <div className="p7m" key={mrun}>
        <div className="lc-shell">
          <div className="lc-head lc-i" style={{'--lcd': '0s'}}>
            <span className="lc-avatar lc-avatar--head"><img src="assets/agent-full.png" alt=""/></span>
            <span className="lc-id"><b>Ligou em chamada</b><span className="lc-idsub"><i className="lc-en">EN</i><svg className="lc-wf" width="120" height="22" viewBox="0 0 120 22" aria-hidden="true"><rect x="0" y="8.5" width="3" height="5" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="6" y="6.5" width="3" height="9" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="12" y="4.5" width="3" height="13" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="18" y="7.5" width="3" height="7" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="24" y="3.5" width="3" height="15" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="30" y="6" width="3" height="10" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="36" y="3" width="3" height="16" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="42" y="8" width="3" height="6" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="48" y="5" width="3" height="12" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="54" y="4" width="3" height="14" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="60" y="8" width="3" height="6" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="66" y="6" width="3" height="10" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="72" y="3.5" width="3" height="15" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="78" y="7" width="3" height="8" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="84" y="8.5" width="3" height="5" rx="1.5" fill="var(--lg-teal-500)"></rect><rect x="90" y="5" width="3" height="12" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="96" y="6.5" width="3" height="9" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="102" y="4" width="3" height="14" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="108" y="7.5" width="3" height="7" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect><rect x="114" y="5.5" width="3" height="11" rx="1.5" fill="var(--lg-teal-500)" opacity=".45"></rect></svg></span></span>
            <span className="lc-htime">00:12</span>
            <button className="lc-again" type="button" onClick={() => { setMrel(false); setMrun(m => m + 1); }} aria-label="Ver de novo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"></path></svg></button>
          </div>
          <div className="lc-convo">
            <div className="lc-row lc-row--cust lc-i" style={{'--lcd': '.1s'}}>
              <div className="lc-msg">
                <span className="lc-who">Cliente · Inglês<i className="lc-ts">00:02</i></span>
                <div className="lc-bub lc-bub--cust">Hi, water is coming in near the chimney in San Rafael. Is there any chance someone can come today?</div>
              </div>
              <span className="lc-face lc-face--jm">JM</span>
            </div>
            <div className="lc-ev lc-i" style={{'--lcd': '.55s'}}><span className="lc-evline" aria-hidden="true"></span><i className="lc-evdot" style={{background: 'var(--lg-orange-500)'}}></i><span><b>Urgência identificada</b><em>Possível vazamento ativo · San Rafael, CA</em></span></div>
            <div className="lc-row lc-i" style={{'--lcd': '1s'}}>
              <span className="lc-face lc-face--lg"><img src="assets/agent-full.png" alt=""/></span>
              <div className="lc-msg">
                <span className="lc-who">Ligou · Inglês<i className="lc-ts">00:06</i></span>
                <div className="lc-bub">I can help. Same-day visits need team approval, so I’ll check availability now.</div>
              </div>
            </div>
            <div className="lc-ev lc-i" style={{'--lcd': '1.45s'}}><span className="lc-evline" aria-hidden="true"></span><i className="lc-evdot" style={{background: 'var(--lg-teal-400)'}}></i><span><b>Regra consultada</b><em>Mesmo dia exige aprovação · Política v2.4</em></span></div>
            <div className="lc-row lc-i" style={{'--lcd': '1.9s'}}>
              <span className="lc-face lc-face--lg"><img src="assets/agent-full.png" alt=""/></span>
              <div className="lc-msg">
                <span className="lc-who">Ligou · Inglês<i className="lc-ts">00:10</i></span>
                <div className="lc-bub">I’ve sent your request to the team. You’ll receive a text as soon as they confirm.</div>
              </div>
            </div>
            <div className="lc-ev lc-i" style={{'--lcd': '2.35s'}}><span className="lc-evline" aria-hidden="true"></span><i className="lc-evdot" style={{background: 'var(--lg-orange-500)'}}></i><span><b>Responsável avisado</b><em>Pedido urgente enviado · Aguardando decisão</em></span></div>
          </div>
          <aside className="lc-sheet lc-i" style={{'--lcd': '2.85s'}}>
            <div className="lc-dhead"><span className="lc-ddot"></span>Resumo em português</div>
            <div className="lc-drow"><span className="lc-dic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4.5 20c1.6-3.2 4.3-5 7.5-5s5.9 1.8 7.5 5"></path></svg></span><p><b>John Miller</b> · (415) XXX-XXXX</p></div>
            <div className="lc-drow"><span className="lc-dic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg></span><p>San Rafael, CA</p></div>
            <div className="lc-drow"><span className="lc-dic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5"></rect><path d="M8 3v4M16 3v4M3.5 10.5h17"></path></svg></span><p>Atendimento hoje</p></div>
            <div className="lc-drow"><span className="lc-dic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 5 5.8v5.4c0 4.6 3 8 7 9.8 4-1.8 7-5.2 7-9.8V5.8L12 3Z"></path><path d="m9 11.5 2.2 2.2 3.8-4.2"></path></svg></span><p>Regra: encaixe no mesmo dia exige aprovação</p></div>
            <button className="lc-rel" type="button" id="lc-rel-toggle" aria-expanded={mrel ? 'true' : 'false'} aria-controls="lc-relato-full" onClick={() => setMrel(r => !r)}>{mrel ? 'Ocultar relato' : 'Ver relato completo'}</button>
            {mrel && <p className="lc-relato" id="lc-relato-full">Água entrando próxima à chaminé após a chuva. O cliente pediu atendimento hoje. Nenhum horário nem preço foi prometido.</p>}
            <p className="lc-darrow">→ Aguardando sua decisão</p>
            <div className="lc-btns"><button className="lc-apr" type="button">Aprovar encaixe</button><button className="lc-adj" type="button">Ajustar resposta</button></div>
          </aside>
        </div>
      </div>
      <p className="p7-foot">O Ligou resolve o que já está autorizado — e traz a exceção pronta para você decidir.</p>
    </Container>
  </section>;
}

function Dor() {
  return <section data-screen-label="A dor" style={{marginTop: 120, background: 'var(--surface-sunken)', borderBlock: '1px solid var(--border-soft)'}}>
    <Container className="dor-ct" style={{padding: '88px 32px 92px', display: 'flex', flexDirection: 'column', gap: 26}}>
      <Reveal><Eyebrow>A dor</Eyebrow></Reveal>
      <Reveal delay={80}><h2 className="dorbig">A ligação que você não atende <span className="acc">não fica esperando.</span></h2></Reveal>
      <Reveal delay={140}><p style={{margin: 0, fontSize: 'var(--size-body-lg)', color: 'var(--text-secondary)', maxWidth: 640}}>Você estava no telhado. Estava dirigindo. Estava com outro cliente. O telefone tocou e caiu na caixa postal. Para quem ligou, a próxima empresa está a um toque de distância no Google.</p></Reveal>
      <Reveal delay={200}><p className="dorbig" style={{fontSize: 'clamp(24px,2.8vw,38px)'}}>Uma ligação perdida por dia pode virar até <span className="acc">30 conversas</span> que o seu negócio nem chegou a disputar naquele mês.</p></Reveal>
      <Reveal delay={260}><p style={{margin: 0, color: 'var(--text-secondary)', maxWidth: 640}}>Quanto vale uma única ligação que vira orçamento no seu negócio? Num roofing, numa pintura, numa reforma — às vezes vale milhares de dólares. E ela tocou. E ninguém atendeu.</p></Reveal>
      <Reveal delay={320}><p style={{margin: 0, color: 'var(--text-secondary)', maxWidth: 640}}>E tem o outro lado: você pode ser excelente no que faz e ainda assim não se sentir confortável vendendo pelo telefone em inglês.</p></Reveal>
      <Reveal delay={380}><p style={{margin: 0, fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--size-h3)', letterSpacing: 'var(--track-tight)', maxWidth: 640}}>Você não precisa falar como americano para atender seu cliente como profissional. O Ligou fecha essa distância.</p></Reveal>
    </Container>
  </section>;
}

function Faz() {
  const items = ['Atende em inglês ou português', 'Entende qual serviço o cliente procura', 'Coleta nome, endereço e detalhes importantes', 'Responde somente com informações que você aprovou', 'Verifica disponibilidade e agenda dentro das suas regras', 'Transfere chamadas urgentes para você', 'Envia o resumo em português no seu celular', 'Registra tudo para você revisar depois'];
  return <section data-screen-label="O que ele faz" style={{marginTop: 116}}>
    <Container>
      <SectionHead eyebrow="Numa ligação" title="O que ele faz quando o telefone toca."/>
      <div className="checklist">
        {items.map((t, i) => <Reveal key={t} delay={(i % 2) * 70}><div className="checkitem"><b>→</b>{t}</div></Reveal>)}
      </div>
      <Reveal delay={120}><p className="dorbig" style={{fontSize: 'clamp(22px,2.6vw,34px)', marginTop: 44}}>E quando ele não sabe? <span className="acc">Ele não inventa.</span> Coleta as informações, explica que a equipe retorna, e te avisa imediatamente.</p></Reveal>
    </Container>
  </section>;
}

function Comecar() {
  const steps = [
    ['01', 'Assine', 'Plano mês a mês, sem fidelidade. Cancele quando quiser.'],
    ['02', 'Atenda a ligação do seu Ligou', 'Ele te entrevista em português por uns 15 minutos. Essa conversa cria a primeira versão do atendimento.'],
    ['03', 'Teste e aprove', 'Você liga nele, ajusta o que quiser, e só coloca no ar quando estiver satisfeito.'],
    ['04', 'Divulgue o número ou redirecione o seu', 'Pronto. A próxima ligação não cai na caixa postal.']
  ];
  return <section id="comecar" data-screen-label="Como começar" style={{marginTop: 116}}>
    <Container>
      <SectionHead eyebrow="Como começar" title="Sem reunião. Sem formulário. Uma conversa."/>
      <div className="startgrid">
        {steps.map(([n, t, d], i) => <Reveal key={n} delay={i * 90}><div className="startcard">
          <span className="sn">{n}</span><b>{t}</b><p>{d}</p>
        </div></Reveal>)}
      </div>
    </Container>
  </section>;
}

function Faq() {
  const [open, setOpen] = useState(0);
  const qs = [
    ['Ele vai inventar preço?', 'Não. O Ligou só informa preços, condições e políticas que você autorizou. Quando o pedido exige avaliação, ele coleta os detalhes e agenda a visita ou o retorno da equipe.'],
    ['E se ele não souber responder?', 'Ele não chuta. Coleta as informações do cliente, avisa que alguém confirma, e pergunta para você. Você responde uma vez e aprova a resposta — ela vira uma regra do seu negócio até você decidir alterar ou apagar.'],
    ['E se o cliente quiser falar comigo?', 'Você escolhe: quando transferir na hora, quando só receber aviso, e quando deixar o Ligou concluir sozinho.'],
    ['Ele fala que é inteligência artificial?', 'Ele se apresenta como assistente virtual da sua empresa: "Hi, you\u2019ve reached [Your Business]. I\u2019m their virtual assistant — how can I help?" A conversa é natural, mas a confiança do seu cliente não depende de fingir que existe uma pessoa do outro lado.'],
    ['Preciso falar inglês para configurar?', 'Não. Toda a configuração — a entrevista, os ajustes, os resumos — é em português. O inglês é problema dele, não seu.'],
    ['E se eu quiser cancelar?', 'Você cancela pelo painel, sem multa e sem precisar falar com vendedor.']
  ];
  return <section id="faq" data-screen-label="FAQ" style={{marginTop: 116}}>
    <Container style={{maxWidth: 880}}>
      <SectionHead eyebrow="Perguntas diretas" title="O que todo dono pergunta."/>
      <div>
        {qs.map(([q, a], i) => <Reveal key={q} delay={i * 50}><div className={`faq-item ${open === i ? 'open' : ''}`}>
          <button className="faq-q" onClick={() => setOpen(open === i ? -1 : i)} aria-expanded={open === i}>{q}<span className="pm">+</span></button>
          <div className="faq-a"><p>{a}</p></div>
        </div></Reveal>)}
      </div>
    </Container>
  </section>;
}

function Pricing() {
  const [ref, on] = useInView({threshold: .3});
  const label = {fontSize: 11, fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase'};
  const inc = ['Uma empresa, uma localização', 'Número do Ligou ou redirecionamento do seu', 'Atendimento em inglês e português', 'Onboarding por ligação, 100% em português', 'Regras personalizadas + integração de agenda', 'Resumos em português no seu celular', 'Painel com histórico das ligações', '400 minutos/mês · excedente $0.35/min', 'Testes e aprovação antes de entrar no ar'];
  return <section id="preco" data-screen-label="Preço" style={{marginTop: 110, background: 'var(--surface-inverse)', color: 'var(--text-inverse)'}}>
    <Container className="price-ct" style={{padding: '92px 32px 100px'}}>
      <Reveal><span className="pt-cap__label">Ligou Launch</span></Reveal>
      <Reveal delay={90}><h2 style={{margin: '18px 0 0', fontSize: 'var(--size-display)', fontWeight: 'var(--weight-black)', letterSpacing: 'var(--track-display)', lineHeight: 'var(--leading-display)'}}>O preço oficial é $499.<br/>Os primeiros 25 não pagam isso.</h2></Reveal>
      <Reveal delay={170}><p style={{margin: '16px 0 0', color: 'var(--text-inverse-secondary)', maxWidth: 520}}>Para empresas de serviços que dependem do telefone para gerar trabalhos. Os 25 primeiros negócios entram como Founding Partners — e ajudam a formar o Ligou.</p></Reveal>
      <div ref={ref} className="pricegrid">
        <Reveal delay={120}><Card style={{padding: '36px 36px 40px', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start', height: '100%', boxSizing: 'border-box', color: 'var(--text-body)'}}>
          <Badge variant="orange" style={{whiteSpace: 'nowrap'}}>Founding Partners · 25 vagas</Badge>
          <div style={{display: 'flex', alignItems: 'baseline', gap: 6, color: 'var(--lg-ink-950)', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'clamp(56px,6vw,80px)', letterSpacing: 'var(--track-display)', lineHeight: 1, margin: '4px 0 0'}}>
            <CountUp from={499} to={299} play={on} prefix="$"/><span style={{fontSize: '0.28em', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: 'var(--track-tight)'}}>/mês</span>
          </div>
          <p style={{margin: 0, color: 'var(--text-secondary)', fontSize: 15}}>Enquanto sua assinatura permanecer ativa. Ativação de $499 isenta.</p>
          <div className="inclist">
            {inc.map(t => <div key={t} className="incitem"><b>→</b>{t}</div>)}
          </div>
          <Button variant="accent" href="#preco" style={{marginTop: 8}}>Quero minha vaga Founding</Button>
        </Card></Reveal>
        <Reveal delay={220}><div className="pricecard--ghost" style={{display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'flex-start', justifyContent: 'center', height: '100%', boxSizing: 'border-box'}}>
          <span style={{...label, color: 'var(--text-inverse-secondary)'}}>Preço oficial</span>
          <div style={{display: 'flex', alignItems: 'baseline', gap: 6, fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'clamp(40px,4vw,52px)', letterSpacing: 'var(--track-display)', lineHeight: 1, color: 'var(--text-inverse)'}}>$499<span style={{fontSize: '0.42em', fontWeight: 700, color: 'var(--text-inverse-secondary)'}}>/mês</span></div>
          <p style={{margin: 0, color: 'var(--text-inverse-secondary)', fontSize: 15}}>Vale depois das 25 vagas Founding, com ativação de $499.</p>
          <p style={{margin: 0, color: 'var(--text-inverse-secondary)', fontSize: 15}}>Mesmo produto, mesmas regras, mesmo Ligou.</p>
        </div></Reveal>
      </div>
      <Reveal delay={140}><p style={{margin: '34px 0 0', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--size-h3)', letterSpacing: 'var(--track-tight)', maxWidth: 640}}>Se uma única ligação recuperada vale mais de $499 para o seu negócio, o Ligou pode se pagar com um único trabalho.</p></Reveal>
      <Reveal delay={200}><p style={{margin: '10px 0 0', color: 'var(--text-inverse-secondary)', fontSize: 14}}>Plano mês a mês. Sem fidelidade.</p></Reveal>
    </Container>
  </section>;
}

function Cta() {
  const [ref, on] = useInView({threshold: .3});
  return <section ref={ref} className="cta" data-screen-label="CTA final">
    <Container style={{position: 'relative', zIndex: 1}}>
      <Reveal><p style={{margin: '0 0 26px', color: 'var(--lg-teal-400)', fontSize: 12, fontWeight: 700, letterSpacing: '.18em', textTransform: 'uppercase'}}>Seu negócio pode funcionar em inglês sem depender do seu inglês</p></Reveal>
      <h2 className={on ? 'wr-on' : ''} style={{maxWidth: '72%'}}>
        <span className="lmask"><span className="ln" style={{'--d': '60ms'}}>Ligou?</span></span>
        <span className="lmask"><span className="ln acc" style={{'--d': '220ms'}}>Atendido.</span></span>
      </h2>
      <Reveal delay={380}><div style={{display: 'flex', gap: 12, marginTop: 34, flexWrap: 'wrap'}}>
        <Button variant="accent" size="lg" href="#prova">Ligue na demo ao vivo · <span className="phonenum">{DEMO_PHONE}</span></Button>
        <Button variant="inverse" size="lg" href="#preco">Quero o Ligou no meu negócio</Button>
      </div></Reveal>
    </Container>
    <img className="cta-robot floaty" src="assets/crop-robot.png" alt=""/>
  </section>;
}

function Footer() {
  const a = {color: 'var(--text-inverse-secondary)', textDecoration: 'none'};
  return <footer data-screen-label="Footer" style={{background: 'var(--surface-inverse-deep)', color: 'var(--text-inverse)', borderTop: '1px solid rgba(251,252,248,.1)', overflow: 'hidden'}}>
    <Container style={{padding: '56px 32px 0'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'}}>
        <img src="assets/crop-logo-mark.png" alt="" style={{height: 34, borderRadius: '50%'}}/>
        <span style={{fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '-0.02em'}}>Ligou</span>
        <span style={{display: 'flex', gap: 10, flexWrap: 'wrap', marginLeft: 'auto', fontSize: 14, alignItems: 'center'}}>
          <a href="https://ligou.ai" style={a}>ligou.ai</a><span style={{opacity: .4}}>·</span>
          <a href="mailto:suporte@ligou.ai" style={a}>suporte@ligou.ai</a><span style={{opacity: .4}}>·</span>
          <a href="#" style={a}>Termos</a><span style={{opacity: .4}}>·</span>
          <a href="#" style={a}>Privacidade</a>
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
        <Marquee small items={['Atende em inglês', 'Configurado em português', 'Agenda dentro das suas regras', 'Não inventa preço', 'Resume em português', 'Pergunta antes de aprender']}/>
      </div>
      <Scene/>
      <WaveDraw style={{maxWidth: 'var(--container)', margin: '0 auto', padding: '0 32px'}}/>
      <CallDemo/>
      <Dor/>
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
