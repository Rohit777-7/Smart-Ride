import { useRef } from 'react';
import { KeyRound, Navigation, Star } from 'lucide-react';
import { gsap, reducedMotion, useGSAP } from '../lib/motion.jsx';

// Real screenshots of the running app (captured at phone size).
const SCREENS = {
  front: { src: '/screens/options.jpg', alt: 'RideFlow fare options screen' },
  back: { src: '/screens/tracking.jpg', alt: 'RideFlow driver arriving screen' },
};

function Phone({ variant }) {
  const s = SCREENS[variant];
  return (
    <div className={`phone ${variant}`}>
      <div className="phone-screen">
        <div className="phone-notch" />
        <img src={s.src} alt={s.alt} draggable="false" />
      </div>
      <div className="phone-gloss" />
    </div>
  );
}

/**
 * Interactive 3D stage: two phones showing real app screens at different depths,
 * floating glass cards in front, and pointer-driven parallax rotation.
 */
export default function HeroScene({ trackRef, intro = true, className = '' }) {
  const scope = useRef(null);
  useGSAP(
    () => {
      const inner = scope.current.querySelector('.scene-inner');
      gsap.set('.phone.back', { z: -140, rotationY: 16, rotationZ: -4 });
      gsap.set('.phone.front', { z: 40, rotationY: -10, rotationZ: 3 });
      gsap.set('.fc-a', { z: 170 });
      gsap.set('.fc-b', { z: 220 });
      gsap.set('.fc-c', { z: 120 });
      gsap.set('.scene-ring', { rotationX: 72, z: -200 });
      if (reducedMotion()) return undefined;

      if (intro) {
        gsap.timeline({ defaults: { ease: 'expo.out' } })
          .from(inner, { rotationY: -38, rotationX: 22, z: -420, autoAlpha: 0, duration: 1.8 })
          .from('.phone', { y: 160, autoAlpha: 0, stagger: 0.15, duration: 1.4 }, '<0.15')
          .from('.float-card', { scale: 0.4, autoAlpha: 0, stagger: 0.12, duration: 1, ease: 'back.out(1.8)' }, '-=0.9');
      }

      // Gentle idle float at different depths. It must start only after the intro has landed:
      // relative values ('+=10') are read when a tween first renders, so starting it during the
      // fly-in would lock the float around the intro's offset start position.
      const settle = intro ? 2.4 : 0;
      gsap.to('.float-card', { y: '+=14', duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1, stagger: { each: 0.5 }, delay: settle });
      gsap.to('.phone.front', { y: '-=10', duration: 3.4, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: settle });
      gsap.to('.phone.back', { y: '+=10', duration: 3.8, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: settle });
      gsap.to('.scene-ring.r2', { rotationZ: 360, duration: 60, ease: 'none', repeat: -1 });

      // pointer parallax on the whole 3D stage
      const area = trackRef?.current || scope.current;
      const ry = gsap.quickTo(inner, 'rotationY', { duration: 1.2, ease: 'power3' });
      const rx = gsap.quickTo(inner, 'rotationX', { duration: 1.2, ease: 'power3' });
      const onMove = (e) => {
        const r = area.getBoundingClientRect();
        ry(((e.clientX - r.left) / r.width - 0.5) * 22);
        rx(-((e.clientY - r.top) / r.height - 0.5) * 14);
      };
      const onLeave = () => {
        ry(0);
        rx(0);
      };
      area.addEventListener('pointermove', onMove);
      area.addEventListener('pointerleave', onLeave);
      return () => {
        area.removeEventListener('pointermove', onMove);
        area.removeEventListener('pointerleave', onLeave);
      };
    },
    { scope },
  );

  return (
    <div className={`scene ${className}`} ref={scope} aria-hidden="true">
      <div className="scene-inner">
        <div className="scene-glow" />
        <div className="scene-ring" />
        <div className="scene-ring r2" />
        <Phone variant="back" />
        <Phone variant="front" />
        <div className="float-card fc-a">
          <span className="fc-icon"><KeyRound size={16} /></span>
          <div>
            <div className="tiny muted">Trip PIN</div>
            <div className="fc-title" style={{ letterSpacing: '0.3em' }}>2096</div>
          </div>
        </div>
        <div className="float-card fc-b">
          <span className="fc-icon" style={{ background: 'linear-gradient(135deg,#34d399,#16a34a)' }}><Navigation size={16} /></span>
          <div>
            <div className="tiny muted">Driver live</div>
            <div className="fc-title">5 min away</div>
          </div>
        </div>
        <div className="float-card fc-c">
          <span className="fc-icon" style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)' }}><Star size={16} fill="#fff" /></span>
          <div>
            <div className="tiny muted">Suresh · Mini</div>
            <div className="fc-title">4.7 rating</div>
          </div>
        </div>
      </div>
    </div>
  );
}
