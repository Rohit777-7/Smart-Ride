import { useEffect } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { setImmersive, useImmersive } from '../lib/immersive.js';

/** One button that hides/shows the navbar and the map side card. Esc exits; leaving the page resets it. */
export default function ImmersiveToggle() {
  const on = useImmersive();

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && setImmersive(false);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setImmersive(false);
    };
  }, []);

  const label = on ? 'Show navbar and panel' : 'Hide navbar and panel';
  return (
    <button
      type="button"
      className={`icon-btn immersive-btn ${on ? 'on' : ''}`}
      aria-label={label}
      aria-pressed={on}
      title={on ? 'Show panels (Esc)' : 'Full-screen map'}
      onClick={() => setImmersive(!on)}
    >
      {on ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
    </button>
  );
}
