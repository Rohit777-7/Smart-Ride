/* eslint-disable react-refresh/only-export-components -- shared motion hooks + small components live together on purpose */
// GSAP motion toolkit: 3D tilt, staggered 3D entrances, count-ups, page transitions.
// Everything degrades to "no motion" for users who prefer reduced motion.
import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(ScrollTrigger, SplitText, MotionPathPlugin, DrawSVGPlugin, useGSAP);
gsap.defaults({ ease: 'power3.out', duration: 0.7 });

export { gsap, ScrollTrigger, SplitText, useGSAP };

// Explicit end values for entrance tweens. Using fromTo (not from) means a CSS transition or an
// interrupted earlier tween can never leave an element stuck at its starting state.
const NEUTRAL = { autoAlpha: 1, opacity: 1, x: 0, y: 0, z: 0, xPercent: 0, yPercent: 0, rotation: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, scaleX: 1, scaleY: 1 };
const SETUP_ONLY = ['transformPerspective', 'transformOrigin', 'svgOrigin'];
export function enter(targets, fromVars, toVars = {}) {
  const from = {};
  const to = { ...toVars };
  for (const [k, v] of Object.entries(fromVars)) {
    if (k in NEUTRAL) {
      from[k] = v;
      if (!(k in to)) to[k] = NEUTRAL[k];
    } else if (SETUP_ONLY.includes(k)) from[k] = v;
    else to[k] = v; // timing options (duration, ease, stagger, delay, scrollTrigger…)
  }
  return gsap.fromTo(targets, from, to);
}

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const finePointer = () => typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;

/** Pointer-driven 3D tilt with a moving spotlight (sets --mx/--my on the element). */
export function useTilt(ref, { max = 8, lift = 0, perspective = 900 } = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || !finePointer()) return undefined;
    gsap.set(el, { transformPerspective: perspective, transformStyle: 'preserve-3d' });
    const rx = gsap.quickTo(el, 'rotationX', { duration: 0.5, ease: 'power3' });
    const ry = gsap.quickTo(el, 'rotationY', { duration: 0.5, ease: 'power3' });
    const z = gsap.quickTo(el, 'z', { duration: 0.5, ease: 'power3' });
    const move = (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      ry((px - 0.5) * max * 2);
      rx(-(py - 0.5) * max * 2);
      z(lift);
      el.style.setProperty('--mx', `${px * 100}%`);
      el.style.setProperty('--my', `${py * 100}%`);
    };
    const leave = () => {
      rx(0);
      ry(0);
      z(0);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [ref, max, lift, perspective]);
}

export function TiltCard({ as: Tag = 'div', className = '', max = 8, lift = 20, children, ...rest }) {
  const ref = useRef(null);
  useTilt(ref, { max, lift });
  return (
    <Tag ref={ref} className={`tilt ${className}`} {...rest}>
      <span className="spotlight" aria-hidden="true" />
      {children}
    </Tag>
  );
}

/**
 * Staggered 3D entrance of a container's children. Re-plays whenever `key` changes —
 * used for panel state changes (search → options → searching → trip …).
 */
export function useStaggerIn(ref, key, { y = 22, rotationX = -14, stagger = 0.06, delay = 0, selector } = {}) {
  useGSAP(
    () => {
      if (!ref.current || reducedMotion()) return;
      // Never animate the block holding the focused field: autoAlpha briefly sets visibility:hidden,
      // and the browser drops focus from hidden inputs, so the user's first keystrokes would be lost.
      const focused = document.activeElement;
      const targets = [...(selector ? ref.current.querySelectorAll(selector) : ref.current.children)].filter(
        (el) => !(focused && focused !== document.body && el.contains(focused)),
      );
      if (!targets.length) return;
      enter(targets, {
        autoAlpha: 0,
        y,
        rotationX,
        transformPerspective: 800,
        transformOrigin: '50% 0%',
        stagger,
        delay,
        duration: 0.65,
        clearProps: 'transform,opacity,visibility',
      });
    },
    { dependencies: [key], scope: ref },
  );
}

/** Wrapper that plays a 3D entrance once when mounted. */
export function Enter3D({ as: Tag = 'div', from, className, children, ...rest }) {
  const ref = useRef(null);
  useGSAP(
    () => {
      if (reducedMotion()) return;
      enter(ref.current, {
        autoAlpha: 0,
        rotationX: -70,
        y: -24,
        transformPerspective: 900,
        transformOrigin: '50% 0%',
        duration: 0.9,
        ease: 'back.out(1.6)',
        clearProps: 'transform,opacity,visibility',
        ...from,
      });
    },
    { scope: ref },
  );
  return (
    <Tag ref={ref} className={className} {...rest}>
      {children}
    </Tag>
  );
}

/** Number that animates from its previous value to the new one. */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString('en-IN'), duration = 1.1, className }) {
  const ref = useRef(null);
  const prev = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const target = Number(value) || 0;
    if (reducedMotion()) {
      el.textContent = format(target);
      prev.current = target;
      return undefined;
    }
    const obj = { v: prev.current };
    const tween = gsap.to(obj, {
      v: target,
      duration,
      ease: 'power2.out',
      onUpdate: () => {
        el.textContent = format(obj.v);
      },
    });
    prev.current = target;
    return () => tween.kill();
  }, [value, format, duration]);
  return <span ref={ref} className={className}>{format(0)}</span>;
}

/** Reveal elements matching `selector` inside `scope` as they scroll into view. */
export function useScrollReveal(scopeRef, selector = '.reveal') {
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.utils.toArray(selector).forEach((el) => {
        enter(el, {
          autoAlpha: 0,
          y: 50,
          rotationX: -18,
          transformPerspective: 1000,
          transformOrigin: '50% 0%',
          duration: 1,
          scrollTrigger: { trigger: el, start: 'top 88%', once: true },
        });
      });
    },
    { scope: scopeRef },
  );
}
