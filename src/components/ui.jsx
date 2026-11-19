import { useEffect, useRef } from 'react';
import { Star, X } from 'lucide-react';
import { STATUS_META, VEHICLE_META } from '../lib/format.js';
import { gsap, reducedMotion, useGSAP } from '../lib/motion.jsx';

export function Modal({ open, onClose, title, children, width }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  useGSAP(
    () => {
      if (!open || !ref.current || reducedMotion()) return;
      gsap.fromTo(ref.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: 'power1.out' });
      gsap.from(ref.current.querySelector('.modal'), {
        rotationX: 18, y: 40, z: -120, scale: 0.94, autoAlpha: 0, transformPerspective: 1200, duration: 0.6, ease: 'expo.out',
      });
    },
    { dependencies: [open] },
  );
  if (!open) return null;
  return (
    <div ref={ref} className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={width ? { maxWidth: width } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function StatusBadge({ status }) {
  const m = STATUS_META[status] || { label: status, tone: '' };
  return <span className={`badge badge-${m.tone}`}>{m.label}</span>;
}

export function RatingStars({ value, onChange, size = 34 }) {
  return (
    <div className="stars" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={n <= value ? 'on' : ''}
          onClick={(e) => {
            onChange(n);
            if (!reducedMotion()) gsap.fromTo(e.currentTarget, { scale: 0.6, rotation: -30 }, { scale: 1, rotation: 0, duration: 0.6, ease: 'elastic.out(1, 0.4)', clearProps: 'transform' });
          }}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          role="radio"
          aria-checked={n === value}
        >
          <Star size={size} fill="currentColor" strokeWidth={1} />
        </button>
      ))}
    </div>
  );
}

export function Spinner({ size = 20 }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function PageLoading() {
  return (
    <div className="page-loading">
      <Spinner size={28} />
    </div>
  );
}

/** Animated success check: ring + tick draw in, then a soft glow pulse. */
export function SuccessMark() {
  const ref = useRef(null);
  useGSAP(
    () => {
      if (reducedMotion()) return;
      const tl = gsap.timeline();
      tl.from(ref.current, { scale: 0.4, rotation: -90, autoAlpha: 0, duration: 0.6, ease: 'back.out(2)' })
        .from('.sm-ring', { drawSVG: '0%', duration: 0.6, ease: 'power2.inOut' }, '<0.1')
        .from('.sm-tick', { drawSVG: '0%', duration: 0.45, ease: 'power2.out' }, '-=0.15');
    },
    { scope: ref },
  );
  return (
    <svg ref={ref} className="success-mark" viewBox="0 0 80 80" aria-hidden="true">
      <defs>
        <linearGradient id="smg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4ade80" />
          <stop offset="1" stopColor="#16a34a" />
        </linearGradient>
      </defs>
      <circle cx="40" cy="40" r="34" fill="rgba(34,197,94,.12)" />
      <circle className="sm-ring" cx="40" cy="40" r="34" fill="none" stroke="url(#smg)" strokeWidth="4" strokeLinecap="round" transform="rotate(-90 40 40)" />
      <path className="sm-tick" d="M26 41 L36 51 L55 31" fill="none" stroke="#86efac" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- vehicle photos

// Real photos (Wikimedia Commons, credits in public/vehicles/CREDITS.md). Each has a focal point
// and a zoom so the vehicle fills small thumbnails as well as large cards.
const VEHICLE_PHOTOS = {
  bike: { src: '/vehicles/bike.jpg', pos: '47% 58%', zoom: 1.15 },
  auto: { src: '/vehicles/auto.jpg', pos: '63% 56%', zoom: 1.45 },
  mini: { src: '/vehicles/mini.jpg', pos: '50% 58%', zoom: 1.12 },
  sedan: { src: '/vehicles/sedan.jpg', pos: '26% 68%', zoom: 1.35 },
};

/** Realistic vehicle thumbnail (photo) used across the app. */
export function VehicleArt({ type, size = 58, className = '', zoom = true }) {
  const p = VEHICLE_PHOTOS[type] || VEHICLE_PHOTOS.mini;
  return (
    <span className={`vphoto ${className}`} style={{ width: size, height: Math.round(size * 0.7) }}>
      <img
        src={p.src}
        alt={`${VEHICLE_META[type]?.name || 'Vehicle'} photo`}
        loading="lazy"
        draggable="false"
        style={{ objectPosition: p.pos, transform: zoom ? `scale(${p.zoom})` : undefined, transformOrigin: p.pos }}
      />
    </span>
  );
}
