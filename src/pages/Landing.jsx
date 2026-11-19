import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, BarChart3, CalendarClock, ChevronLeft, ChevronRight, KeyRound, Mail, Navigation, Percent, RotateCcw, Shield,
  Sparkles, Users, Wallet, Zap,
} from 'lucide-react';
import { Logo } from '../components/AppShell.jsx';
import HeroScene from '../components/HeroScene.jsx';
import { VehicleArt } from '../components/ui.jsx';
import { homeFor, useAuth } from '../lib/auth.jsx';
import { VEHICLE_META } from '../lib/format.js';
import { enter, gsap, reducedMotion, ScrollTrigger, SplitText, TiltCard, useGSAP } from '../lib/motion.jsx';

const STEPS = [
  ['Open the app', 'Your location is detected and nearby drivers appear live on the map.'],
  ['Pick a destination', 'Real road distance, time and an upfront fare for every category.'],
  ['Request a ride', 'Nearby drivers of that category get the request instantly.'],
  ['Driver accepts', 'See who is coming, their vehicle, and their live location.'],
  ['Share your PIN', 'The trip only starts once the driver enters your 4-digit PIN.'],
  ['Arrive & pay', 'Fare is finalised, payment recorded and a receipt generated.'],
  ['Rate your driver', 'Your feedback is saved with the trip in your ride history.'],
];

const VEHICLES = [
  { type: 'bike', seats: 1, base: 20, perKm: 6, min: 30, line: 'Zip through traffic on two wheels.' },
  { type: 'auto', seats: 3, base: 30, perKm: 11, min: 45, line: 'The everyday ride, metered fairly.' },
  { type: 'mini', seats: 4, base: 50, perKm: 14, min: 80, line: 'Comfy, air-conditioned hatchbacks.' },
  { type: 'sedan', seats: 4, base: 70, perKm: 18, min: 120, line: 'Extra legroom and boot space.' },
];

const MARQUEE = [
  [Navigation, 'Live tracking'], [KeyRound, 'PIN-verified pickups'], [Zap, 'Dynamic fares'], [CalendarClock, 'Ride scheduling'],
  [Shield, 'One-tap SOS'], [Percent, 'Promo codes'], [Wallet, 'Wallet & test cards'], [BarChart3, 'Admin analytics'],
];

const FEATURES = [
  { icon: Navigation, title: 'Live driver tracking', text: 'Driver positions stream over Socket.IO every second. Watch the car glide along real roads with a live ETA and remaining route.', span: 'span-4', big: true },
  { icon: KeyRound, title: 'PIN-verified pickup', text: 'A 4-digit PIN only you can see. Five wrong attempts lock the trip.' },
  { icon: Zap, title: 'Dynamic fares', text: 'Distance, time, live demand vs supply, peak hours and night charges.' },
  { icon: CalendarClock, title: 'Scheduling', text: 'Book up to 7 days ahead at a locked, surge-free price.' },
  { icon: Percent, title: 'Promo codes', text: 'Percent or flat, with limits, minimums, categories and expiry.' },
  { icon: Shield, title: 'SOS & safety', text: 'Alert the safety team and your emergency contacts with your live location, or call 112.', span: 'span-3' },
  { icon: RotateCcw, title: 'Cancellations & refunds', text: 'Fair fees that compensate drivers, and refunds credited straight to your wallet.', span: 'span-3' },
  { icon: Wallet, title: 'Driver earnings', text: 'Commission split per trip, with daily, weekly and monthly payouts.' },
  { icon: Mail, title: 'Email notifications', text: 'Booking, driver assigned, receipts, refunds and SOS alerts.' },
  { icon: BarChart3, title: 'Admin analytics', text: 'Revenue, demand by hour, live map, refunds desk and CSV reports.' },
];

function HeroTitle() {
  const words = [['Your'], ['city,'], ['one', true], ['tap', true], ['away.', true]];
  return (
    <h1 className="hero-title">
      {words.map(([w, grad], i) => (
        <span key={i} className="w" style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', paddingBottom: '0.08em', marginRight: '0.22em' }}>
          <span className={`wi ${grad ? 'grad-text' : ''}`} style={{ display: 'inline-block' }}>{w}</span>
          {i === 1 && <br />}
        </span>
      ))}
    </h1>
  );
}

function VehicleCarousel() {
  const ringRef = useRef(null);
  const infoRef = useRef(null);
  const stageRef = useRef(null);
  const [index, setIndex] = useState(0);
  const rot = useRef(0);
  const indexRef = useRef(0);
  const paused = useRef(false);
  // Two laps of the fleet on one ring (8 cards, 45° apart) so neighbours show angled in 3D.
  const SLOTS = VEHICLES.length * 2;
  const STEP = 360 / SLOTS;
  const R = 400;

  const goTo = useCallback((i) => {
    const n = SLOTS;
    const target = ((i % n) + n) % n;
    // shortest rotation to the target card
    const current = rot.current;
    const desired = -target * STEP;
    let delta = ((desired - current) % 360 + 540) % 360 - 180;
    rot.current = current + delta;
    gsap.to(ringRef.current, { rotationY: rot.current, duration: reducedMotion() ? 0 : 1.1, ease: 'expo.out' });
    indexRef.current = target;
    setIndex(target);
  }, [SLOTS, STEP]);

  useEffect(() => {
    if (reducedMotion()) return undefined;
    const t = setInterval(() => {
      if (!paused.current) goTo(indexRef.current + 1);
    }, 3200);
    return () => clearInterval(t);
  }, [goTo]);

  // animate the details panel whenever the active vehicle changes
  useGSAP(
    () => {
      if (reducedMotion()) return;
      enter(infoRef.current.children, { autoAlpha: 0, y: 24, rotationX: -30, stagger: 0.06, duration: 0.7, transformPerspective: 600, clearProps: 'transform' });
    },
    { dependencies: [index % VEHICLES.length] },
  );

  // drag to spin
  useEffect(() => {
    const el = stageRef.current;
    let startX = 0;
    let startRot = 0;
    let dragging = false;
    const down = (e) => {
      dragging = true;
      paused.current = true;
      startX = e.clientX;
      startRot = rot.current;
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!dragging) return;
      rot.current = startRot + (e.clientX - startX) * 0.45;
      gsap.to(ringRef.current, { rotationY: rot.current, duration: 0.4, ease: 'power3' });
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      const i = Math.round(-rot.current / STEP);
      goTo(i);
      setTimeout(() => (paused.current = false), 2500);
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [goTo, STEP]);

  const active = index % VEHICLES.length;
  const v = VEHICLES[active];
  // nearest slot showing vehicle `vi`
  const slotFor = (vi) => {
    const cands = [vi, vi + VEHICLES.length];
    const dist = (sl) => Math.abs(((sl - index) % SLOTS + SLOTS + SLOTS / 2) % SLOTS - SLOTS / 2);
    return cands.sort((a, b) => dist(a) - dist(b))[0];
  };
  return (
    <div className="carousel-wrap">
      <div>
        <div ref={infoRef} className="col gap-16">
          <span className="eyebrow">{VEHICLE_META[v.type].name} · {v.seats} seat{v.seats > 1 ? 's' : ''}</span>
          <h3 className="display" style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 800 }}>{VEHICLE_META[v.type].name}</h3>
          <p className="text-2" style={{ fontSize: '1.05rem' }}>{v.line}</p>
          <div className="grid grid-3" style={{ maxWidth: 420 }}>
            <div className="card card-tight stat"><span className="stat-label">Base</span><span className="stat-value" style={{ fontSize: '1.3rem' }}>₹{v.base}</span></div>
            <div className="card card-tight stat"><span className="stat-label">Per km</span><span className="stat-value" style={{ fontSize: '1.3rem' }}>₹{v.perKm}</span></div>
            <div className="card card-tight stat"><span className="stat-label">Minimum</span><span className="stat-value" style={{ fontSize: '1.3rem' }}>₹{v.min}</span></div>
          </div>
        </div>
        <div className="vehicle-pick mt-24">
          {VEHICLES.map((x, i) => (
            <button key={x.type} className={i === active ? 'active' : ''} onClick={() => { paused.current = true; goTo(slotFor(i)); setTimeout(() => (paused.current = false), 4000); }}>
              <span className="dot" style={{ background: VEHICLE_META[x.type].hex }} /> {VEHICLE_META[x.type].name}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="carousel" ref={stageRef} onMouseEnter={() => (paused.current = true)} onMouseLeave={() => (paused.current = false)}>
          <div className="carousel-floor" />
          <div className="carousel-ring" ref={ringRef}>
            {Array.from({ length: SLOTS }, (_, i) => VEHICLES[i % VEHICLES.length]).map((x, i) => (
              <div
                key={i}
                className={`carousel-card ${i === index ? 'is-active' : ''}`}
                style={{ transform: `rotateY(${i * STEP}deg) translateZ(${R}px)`, '--vc': VEHICLE_META[x.type].hex }}
                onClick={() => goTo(i)}
              >
                <VehicleArt type={x.type} className="cc-photo" zoom={false} />
                <div className="cc-shade" />
                <div className="row-between cc-top">
                  <span className="badge cc-badge">{x.seats} seat{x.seats > 1 ? 's' : ''}</span>
                  <span className="badge cc-badge">from ₹{x.min}</span>
                </div>
                <div className="cc-bottom">
                  <h3>{VEHICLE_META[x.type].name}</h3>
                  <div className="small text-2 mt-8">₹{x.base} base · ₹{x.perKm}/km</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="carousel-nav">
          <button className="icon-btn" aria-label="Previous vehicle" onClick={() => goTo(index - 1)}><ChevronLeft size={18} /></button>
          <span className="small muted" style={{ alignSelf: 'center' }}>Drag to spin</span>
          <button className="icon-btn" aria-label="Next vehicle" onClick={() => goTo(index + 1)}><ChevronRight size={18} /></button>
        </div>
      </div>
    </div>
  );
}

function LiveMini() {
  const ref = useRef(null);
  useGSAP(
    () => {
      if (reducedMotion()) return;
      const path = ref.current.querySelector('.lm-route');
      gsap.from(path, { drawSVG: '0%', duration: 1.6, ease: 'power2.inOut', scrollTrigger: { trigger: ref.current, start: 'top 85%' } });
      gsap.to(ref.current.querySelector('.lm-car'), {
        motionPath: { path, align: path, alignOrigin: [0.5, 0.5], autoRotate: 90 }, duration: 6, repeat: -1, ease: 'none',
      });
    },
    { scope: ref },
  );
  return (
    <svg ref={ref} viewBox="0 0 520 150" width="100%" height="150" aria-hidden="true" style={{ marginTop: 'auto' }}>
      <defs>
        <linearGradient id="lmg" x1="0" x2="1">
          <stop offset="0" stopColor="#2f80ff" />
          <stop offset="1" stopColor="#ff2e7e" />
        </linearGradient>
      </defs>
      <g stroke="rgba(255,255,255,.06)" strokeWidth="8" fill="none" strokeLinecap="round">
        <path d="M0 40 L520 70" /><path d="M0 120 L520 100" /><path d="M120 0 L150 150" /><path d="M360 0 L330 150" />
      </g>
      <path className="lm-route" d="M20 120 C 120 120, 140 40, 240 60 S 400 120, 500 30" stroke="url(#lmg)" strokeWidth="4" fill="none" strokeLinecap="round" />
      <circle cx="20" cy="120" r="7" fill="#2f80ff" stroke="#fff" strokeWidth="3" />
      <circle cx="500" cy="30" r="7" fill="#ff2e7e" stroke="#fff" strokeWidth="3" />
      <g className="lm-car">
        <rect x="-7" y="-12" width="14" height="24" rx="5" fill="#22c39a" stroke="#fff" strokeWidth="1.5" />
        <rect x="-5" y="-7" width="10" height="5" rx="1.5" fill="#111216" />
      </g>
    </svg>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const root = useRef(null);
  const heroRef = useRef(null);
  const ctaTo = user ? homeFor(user.role) : '/signup';

  useGSAP(
    () => {
      if (reducedMotion()) return;
      // hero copy
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      const E = { ease: 'expo.out' };
      tl.add(enter('.hero .eyebrow', { autoAlpha: 0, y: 20, duration: 0.8, ...E }))
        .add(enter('.hero-title .wi', { yPercent: 115, rotationX: -80, transformOrigin: '50% 100%', transformPerspective: 600, stagger: 0.08, duration: 1.2, ...E }), '-=0.5')
        .add(enter('.hero .lead', { autoAlpha: 0, y: 24, duration: 1, ...E }), '-=0.8')
        .fromTo('.hero .hero-cta > *', { autoAlpha: 0, y: 20, rotationX: -40, transformPerspective: 600 }, { autoAlpha: 1, y: 0, rotationX: 0, stagger: 0.1, duration: 0.9, clearProps: 'transform' }, '-=0.75')
        .add(enter('.hero-demo span', { autoAlpha: 0, y: 12, stagger: 0.08, duration: 0.6, ...E }), '-=0.6')
        .add(enter('.scroll-hint', { autoAlpha: 0, duration: 1, ...E }), '-=0.3');

      // grid floor drift
      gsap.to('.hero-grid-bg', { backgroundPositionY: '60px', duration: 2.5, ease: 'none', repeat: -1 });

      // marquee
      const track = root.current.querySelector('.marquee-track');
      gsap.to(track, { xPercent: -50, duration: 32, ease: 'none', repeat: -1 });

      // section headings: word-by-word 3D reveal
      gsap.utils.toArray('.split-head').forEach((el) => {
        const split = SplitText.create(el, { type: 'words', mask: 'words' });
        enter(split.words, {
          yPercent: 110, rotationX: -60, transformPerspective: 600, transformOrigin: '50% 100%', stagger: 0.05, duration: 1,
          scrollTrigger: { trigger: el, start: 'top 85%', once: true },
        });
      });
      gsap.utils.toArray('.reveal').forEach((el) => {
        enter(el, {
          autoAlpha: 0, y: 60, rotationX: -14, transformPerspective: 1000, transformOrigin: '50% 0%', duration: 1.1,
          scrollTrigger: { trigger: el, start: 'top 88%', once: true },
        });
      });
      // bento cards rise in 3D, staggered
      enter('.bento > *', {
        autoAlpha: 0, y: 80, rotationX: -25, z: -100, transformPerspective: 1100, transformOrigin: '50% 0%', stagger: 0.07, duration: 1.1,
        clearProps: 'transform,opacity,visibility',
        scrollTrigger: { trigger: '.bento', start: 'top 80%', once: true },
      });

      // timeline fill + lit steps
      gsap.to('.timeline-fill', {
        scaleY: 1, ease: 'none',
        scrollTrigger: { trigger: '.timeline', start: 'top 65%', end: 'bottom 60%', scrub: 0.6 },
      });
      gsap.utils.toArray('.t-step').forEach((step) => {
        ScrollTrigger.create({
          trigger: step, start: 'top 62%',
          onEnter: () => step.classList.add('lit'),
          onLeaveBack: () => step.classList.remove('lit'),
        });
        enter(step, { autoAlpha: 0, x: 60, rotationY: -25, transformPerspective: 1000, transformOrigin: '0% 50%', duration: 0.9, scrollTrigger: { trigger: step, start: 'top 85%', once: true } });
      });

      // CTA zooms out of depth
      enter('.cta', { scale: 0.86, rotationX: 20, transformPerspective: 1200, autoAlpha: 0, duration: 1.2, scrollTrigger: { trigger: '.cta', start: 'top 85%', once: true } });
    },
    { scope: root },
  );

  return (
    <div className="landing" ref={root}>
      <header className="topbar">
        <Logo />
        <div className="topbar-right">
          {user ? (
            <Link className="btn btn-primary btn-sm" to={homeFor(user.role)}>
              Open app <ArrowRight size={16} />
            </Link>
          ) : (
            <>
              <Link className="btn btn-ghost btn-sm" to="/login">Log in</Link>
              <Link className="btn btn-primary btn-sm" to="/signup">Get started</Link>
            </>
          )}
        </div>
      </header>

      <section className="hero" ref={heroRef}>
        <div className="hero-grid-bg" />
        <div className="hero-inner">
          <div>
            <span className="eyebrow"><Sparkles size={13} /> Real-time ride booking</span>
            <HeroTitle />
            <p className="lead">
              Bikes, autos and cabs on a live map. Get PIN-verified pickups, transparent fares and safety tools that stay one tap away.
            </p>
            <div className="row wrap hero-cta">
              <Link className="btn btn-primary btn-lg" to={ctaTo}>
                Book a ride <ArrowRight size={18} />
              </Link>
              <Link className="btn btn-ghost btn-lg" to={user ? homeFor(user.role) : '/signup?role=driver'}>
                <Users size={18} /> Drive with us
              </Link>
            </div>
            <div className="hero-demo">
              <span>Rider <b>rider@rideflow.app</b> / rider123</span>
              <span>Driver <b>driver@rideflow.app</b> / driver123</span>
            </div>
          </div>
          <HeroScene trackRef={heroRef} />
        </div>
        <div className="scroll-hint"><i />Scroll</div>
      </section>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[...MARQUEE, ...MARQUEE].map(([Icon, label], i) => (
            <span key={i} className="marquee-item"><Icon size={20} /> {label}</span>
          ))}
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <span className="eyebrow">The fleet</span>
          <h2 className="split-head">Four ways to get there.</h2>
          <p className="reveal">Every category has its own base fare, per-km rate and minimum, and the price is calculated before you book.</p>
        </div>
        <div className="reveal"><VehicleCarousel /></div>
      </section>

      <section className="section">
        <div className="split-2">
          <div className="sticky section-head">
            <span className="eyebrow">How it works</span>
            <h2 className="split-head">From tap to destination, live.</h2>
            <p className="reveal">Each step updates both apps in real time over WebSockets. Nobody has to refresh.</p>
            <Link className="btn btn-primary mt-24 reveal" to={ctaTo}>Try the flow <ArrowRight size={16} /></Link>
          </div>
          <div className="timeline">
            <div className="timeline-rail"><div className="timeline-fill" /></div>
            {STEPS.map(([t, d], i) => (
              <div key={t} className="card t-step">
                <span className="t-num">{String(i + 1).padStart(2, '0')}</span>
                <h3>{t}</h3>
                <p className="small muted mt-8">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <span className="eyebrow">Platform</span>
          <h2 className="split-head">Everything a modern ride platform needs.</h2>
        </div>
        <div className="bento">
          {FEATURES.map(({ icon: Icon, title, text, span, big }) => (
            <TiltCard key={title} className={`card feature ${span || ''}`} max={6}>
              <div className="ficon"><Icon size={22} /></div>
              <h3>{title}</h3>
              <p>{text}</p>
              {big && <LiveMini />}
            </TiltCard>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="cta">
          <span className="eyebrow">Ready when you are</span>
          <h2 className="mt-16">Your next ride is <span className="grad-text">one tap away.</span></h2>
          <p className="text-2 mt-16" style={{ maxWidth: 560, margin: '16px auto 0' }}>
            Create a passenger or driver account. The demo runs on its own, with simulated drivers picking up your requests.
          </p>
          <div className="row wrap mt-24" style={{ justifyContent: 'center' }}>
            <Link className="btn btn-primary btn-lg" to={ctaTo}>Create account <ArrowRight size={18} /></Link>
            <Link className="btn btn-ghost btn-lg" to="/login">I have an account</Link>
          </div>
        </div>
      </section>

      <footer className="footer">
        RideFlow is a demo platform with simulated rides and test payments. A real-world launch needs driver verification,
        safety operations and regulatory approvals.
        <div className="mt-8">Vehicle photos: Wikimedia Commons contributors (CC BY / CC BY-SA). <a href="/vehicles/CREDITS.md">Photo credits</a></div>
      </footer>
    </div>
  );
}
