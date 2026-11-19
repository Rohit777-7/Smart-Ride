// "Focus map" mode: hides the floating navbar and the map side card so the map fills the screen.
// Kept as a tiny global store because the navbar (AppShell) and the card (pages) live in different trees.
import { useSyncExternalStore } from 'react';

let on = false;
const subs = new Set();

export function setImmersive(value) {
  if (on === value) return;
  on = value;
  document.body.classList.toggle('immersive', value);
  // MapView listens for this to re-centre the camera for the new free space.
  window.dispatchEvent(new CustomEvent('rideflow:immersive', { detail: value }));
  subs.forEach((fn) => fn());
}

export const isImmersive = () => on;

export function useImmersive() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => on,
  );
}
