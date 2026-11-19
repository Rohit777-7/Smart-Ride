import { useEffect, useState } from 'react';

// Used when the browser denies or can't provide a location (MG Road, Bengaluru).
export const DEFAULT_CENTER = { lat: 12.9758, lng: 77.6045 };

/** One-shot current position with graceful fallback. */
export function getPosition(timeout = 8000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({ ...DEFAULT_CENTER, approximate: true });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, approximate: false }),
      () => resolve({ ...DEFAULT_CENTER, approximate: true }),
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    );
  });
}

export function useCurrentPosition() {
  const [pos, setPos] = useState(null);
  useEffect(() => {
    let alive = true;
    getPosition().then((p) => alive && setPos(p));
    return () => {
      alive = false;
    };
  }, []);
  return [pos, setPos];
}
