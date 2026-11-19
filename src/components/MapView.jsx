// 3D map built on MapLibre GL (vector tiles from MapTiler): pitched camera with a slow cinematic
// orbit, mouse parallax, extruded + lit buildings, a custom night theme and gradient routes.
// The component API (MapView, FitBounds, markers, RouteLine…) is shared by every map screen.
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
// MapLibre 6 parses tiles in a separate worker file; bundle it with Vite and tell MapLibre where it is.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { VEHICLE_META } from '../lib/format.js';
import { reducedMotion } from '../lib/motion.jsx';
import { isImmersive } from '../lib/immersive.js';

const KEY = import.meta.env.MAPTILE_API_KEY;
const STYLE_URL = KEY
  ? `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${KEY}`
  : 'https://demotiles.maplibre.org/style.json';

const PITCH = 56;
const ORBIT_DEG_PER_MS = 0.0006; // ≈ 0.6° per second
const IDLE_BEFORE_ORBIT_MS = 6000;

maplibregl.setWorkerUrl(workerUrl);

const MapCtx = createContext(null);
const isMobile = () => window.innerWidth <= 760;

// ---------------------------------------------------------------- night theme

// Neutral charcoal night palette (no saturated blues): hierarchy comes from lightness, not hue.
const T = {
  bg: '#16181d', land: '#1a1c22', park: '#17211c', water: '#0c0f15', waterLine: '#111620',
  road1: '#2b2e35', road2: '#3a3e47', hwy: '#4e535e', outline: '#101216', rail: '#25282e',
  label: '#b4b9c2', labelDim: '#737985', labelWater: '#4c5a70', halo: '#111317',
};

// Main roads get a soft blue glow underneath, so the street hierarchy reads at night.
const ROAD_GLOW = { Highway: 0.14, 'Major road': 0.06 };

function applyNightTheme(map) {
  const paint = (id, prop, v) => {
    try {
      map.setPaintProperty(id, prop, v);
    } catch {
      /* property not applicable to this layer */
    }
  };
  const hide = (id) => map.setLayoutProperty(id, 'visibility', 'none');
  for (const l of map.getStyle().layers) {
    const { id, type } = l;
    const sl = l['source-layer'];
    if (type === 'background') paint(id, 'background-color', T.bg);
    else if (type === 'fill') {
      if (id === 'Building') hide(id);
      else if (sl === 'water' || /water/i.test(id)) {
        paint(id, 'fill-color', T.water);
        paint(id, 'fill-opacity', 1);
      } else if (/Grass|Wood|Forest|Meadow|Scrub|Crop|Park/i.test(id)) {
        paint(id, 'fill-color', T.park);
        paint(id, 'fill-opacity', 0.85);
      } else if (/Bridge|Pier|Pedestrian/i.test(id)) paint(id, 'fill-color', T.road1);
      else {
        paint(id, 'fill-color', T.land);
        paint(id, 'fill-opacity', 0.7);
      }
    } else if (type === 'line') {
      if (sl === 'waterway') paint(id, 'line-color', T.waterLine);
      else if (sl === 'boundary') paint(id, 'line-color', '#2a2f3a');
      else if (/Path|Footway|Aeroway|Cablecar|Ferry|construction|hatching/i.test(id)) hide(id);
      else if (/outline/i.test(id)) paint(id, 'line-color', T.outline);
      else if (/Highway/i.test(id)) paint(id, 'line-color', T.hwy);
      else if (/Major road/i.test(id)) paint(id, 'line-color', T.road2);
      else if (/rail/i.test(id)) paint(id, 'line-color', T.rail);
      else paint(id, 'line-color', T.road1);
    } else if (type === 'fill-extrusion') {
      paint(id, 'fill-extrusion-color', [
        'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0],
        0, '#202227', 25, '#25282e', 70, '#2c2f36', 150, '#353941', 300, '#42464f',
      ]);
      paint(id, 'fill-extrusion-opacity', 0.9);
    } else if (type === 'symbol') {
      if (sl === 'poi' || /Housenumber|Oneway|shield|junction|Gondola|Ferry|Airport gate/i.test(id)) hide(id);
      else {
        const water = /Ocean|Lake|River/i.test(id);
        paint(id, 'text-color', water ? T.labelWater : /Road/i.test(id) ? T.labelDim : T.label);
        paint(id, 'text-halo-color', T.halo);
        paint(id, 'text-halo-width', 1.2);
      }
    }
  }
  for (const [id, opacity] of Object.entries(ROAD_GLOW)) {
    const l = map.getStyle().layers.find((x) => x.id === id);
    if (!l) continue;
    try {
      map.addLayer(
        {
          id: `${id} glow`,
          type: 'line',
          source: l.source,
          'source-layer': l['source-layer'],
          ...(l.filter ? { filter: l.filter } : {}),
          ...(l.minzoom != null ? { minzoom: l.minzoom } : {}),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#dfe6f2',
            'line-opacity': opacity,
            'line-blur': 6,
            'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 2, 14, 9, 18, 30],
          },
        },
        id,
      );
    } catch {
      /* layer shape not supported */
    }
  }
  try {
    map.setSky({
      'sky-color': '#0d0f13', 'horizon-color': '#2a2f3a', 'fog-color': '#16181d',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.3,
    });
    map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: 0.4, position: [1.3, 215, 30] });
  } catch {
    /* renderer without sky support */
  }
}

const firstSymbolLayer = (map) => map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

// ---------------------------------------------------------------- map

export function MapView({ center, zoom = 15, children, className = 'map', cinematic = true }) {
  const containerRef = useRef(null);
  const [map, setMap] = useState(null);

  useEffect(() => {
    const container = containerRef.current;
    const reduce = reducedMotion();
    const m = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: [center.lng, center.lat],
      zoom: reduce ? zoom : zoom - 2.5,
      pitch: reduce ? PITCH : 0,
      bearing: reduce ? 0 : -30,
      maxPitch: 72,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
    });
    // Focus mode toggled: glide the camera centre into the newly freed space.
    const onImmersive = () => m.easeTo({ padding: padding(), duration: reduce ? 0 : 900 });
    window.addEventListener('rideflow:immersive', onImmersive);
    if (import.meta.env.DEV) window.__rfMap = m; // dev-only handle for debugging
    // Fade the map in once the first tiles are drawn (no black flash on slow devices).
    m.once('load', () => container.classList.add('is-ready'));
    m.on('style.load', () => {
      applyNightTheme(m);
      setMap(m);
    });

    // Camera controller: mouse parallax (small bearing/pitch offsets) + slow idle orbit.
    // Works in deltas so manual rotation, fitBounds and flyTo are never fought.
    let raf = 0;
    let last = performance.now();
    let lastInteract = 0;
    const off = { b: 0, p: 0 };
    const target = { b: 0, p: 0 };
    const onPointer = (e) => {
      const r = container.getBoundingClientRect();
      target.b = ((e.clientX - r.left) / r.width - 0.5) * 12;
      target.p = -((e.clientY - r.top) / r.height - 0.5) * 8;
    };
    const onLeave = () => {
      target.b = 0;
      target.p = 0;
    };
    const markInteract = (e) => {
      if (e.originalEvent) lastInteract = performance.now();
    };
    if (!reduce) {
      container.addEventListener('pointermove', onPointer);
      container.addEventListener('pointerleave', onLeave);
      ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart'].forEach((ev) => m.on(ev, markInteract));
      const tick = (t) => {
        const dt = Math.min(64, t - last);
        last = t;
        if (m.isStyleLoaded() && !m.isMoving()) {
          const nb = off.b + (target.b - off.b) * 0.05;
          const np = off.p + (target.p - off.p) * 0.05;
          let db = nb - off.b;
          const dp = np - off.p;
          off.b = nb;
          off.p = np;
          if (cinematic && t - lastInteract > IDLE_BEFORE_ORBIT_MS) db += dt * ORBIT_DEG_PER_MS;
          if (Math.abs(db) > 1e-4 || Math.abs(dp) > 1e-4) {
            m.jumpTo({ bearing: m.getBearing() + db, pitch: Math.max(0, Math.min(70, m.getPitch() + dp)) });
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener('pointermove', onPointer);
      container.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('rideflow:immersive', onImmersive);
      m.remove();
    };
    // The map is created once; later center/zoom changes go through FitBounds / flyTo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className={className}>
      <MapCtx.Provider value={map}>{map && children}</MapCtx.Provider>
    </div>
  );
}

// Camera padding keeps routes clear of the floating navbar and side card; in focus mode the map has the whole screen.
const padding = () => {
  if (isImmersive()) return isMobile() ? { top: 60, bottom: 60, left: 30, right: 30 } : { top: 70, bottom: 70, left: 90, right: 90 };
  return isMobile()
    ? { top: 100, bottom: Math.round(window.innerHeight * 0.55), left: 40, right: 40 }
    : { top: 120, bottom: 80, left: 470, right: 90 };
};

/** Fly the 3D camera to a set of points whenever their identity (`fitKey`) changes. */
export function FitBounds({ points, fitKey, maxZoom = 16 }) {
  const map = useContext(MapCtx);
  const first = useRef(true);
  useEffect(() => {
    const valid = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!map || !valid.length) return;
    const duration = reducedMotion() ? 0 : first.current ? 2800 : 1600;
    first.current = false;
    const pad = padding();
    if (valid.length === 1) {
      map.flyTo({ center: [valid[0].lng, valid[0].lat], zoom: Math.min(maxZoom, 16), pitch: PITCH + 4, padding: pad, duration, essential: true });
      return;
    }
    const b = new maplibregl.LngLatBounds();
    valid.forEach((p) => b.extend([p.lng, p.lat]));
    const cam = map.cameraForBounds(b, { padding: pad, bearing: map.getBearing() });
    if (!cam) return;
    map.flyTo({
      ...cam,
      zoom: Math.min(maxZoom, cam.zoom + 0.45), // cameraForBounds is conservative for a pitched camera
      pitch: PITCH,
      padding: pad,
      duration,
      essential: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map]);
  return null;
}

export function MapClick({ onClick }) {
  const map = useContext(MapCtx);
  const ref = useRef(onClick);
  useEffect(() => {
    ref.current = onClick;
  });
  useEffect(() => {
    if (!map) return undefined;
    const fn = (e) => ref.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    map.on('click', fn);
    return () => map.off('click', fn);
  }, [map]);
  return null;
}

/** Exposes a small camera API to the parent: flyTo([lat, lng], zoom). */
export function MapRef({ onReady }) {
  const map = useContext(MapCtx);
  useEffect(() => {
    if (!map) return;
    onReady?.({
      flyTo: ([lat, lng], zoom = 16) =>
        map.flyTo({ center: [lng, lat], zoom, pitch: PITCH + 4, padding: padding(), duration: 1600, essential: true }),
    });
  }, [map, onReady]);
  return null;
}

// ---------------------------------------------------------------- markers

function useHtmlMarker({ position, html, anchor = 'center', flat = false, zIndex }) {
  const map = useContext(MapCtx);
  const markerRef = useRef(null);
  const valid = !!position && Number.isFinite(position.lat) && Number.isFinite(position.lng);
  useEffect(() => {
    if (!map || !valid) return undefined;
    const el = document.createElement('div');
    el.className = 'mk';
    el.innerHTML = html;
    if (zIndex) el.style.zIndex = String(zIndex);
    const marker = new maplibregl.Marker({
      element: el,
      anchor,
      rotationAlignment: flat ? 'map' : 'viewport',
      pitchAlignment: flat ? 'map' : 'viewport',
    })
      .setLngLat([position.lng, position.lat])
      .addTo(map);
    markerRef.current = marker;
    return () => {
      marker.remove();
      markerRef.current = null;
    };
    // Position updates are applied separately so the element isn't recreated on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, html, anchor, flat, zIndex, valid]);
  return markerRef;
}

export function MeMarker({ position }) {
  const ref = useHtmlMarker({ position, html: '<div class="mk-me"></div>' });
  useEffect(() => {
    if (position) ref.current?.setLngLat([position.lng, position.lat]);
  }, [position, ref]);
  return null;
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pinSvg = (fill, inner) =>
  `<svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 1C8.2 1 1 8 1 16.7 1 28.5 17 43 17 43s16-14.5 16-26.3C33 8 25.8 1 17 1z" fill="${fill}" stroke="#fff" stroke-width="2"/>${inner}</svg>`;

export function PinMarker({ position, kind = 'pickup', label }) {
  const svg =
    kind === 'pickup'
      ? pinSvg('#2f80ff', '<circle cx="17" cy="16.5" r="6" fill="#fff"/>')
      : pinSvg('#ff2e7e', '<rect x="11" y="10.5" width="12" height="12" rx="2.5" fill="#fff"/>');
  const html = `<div class="mk-pin">${label ? `<div class="mk-label">${esc(label)}</div>` : ''}${svg}</div>`;
  const ref = useHtmlMarker({ position, html, anchor: 'bottom', zIndex: 3 });
  const ring = useHtmlMarker({ position, html: `<div class="mk-ring ${kind}"><i></i><i></i></div>`, flat: true, zIndex: 1 });
  useEffect(() => {
    if (!position) return;
    ref.current?.setLngLat([position.lng, position.lat]);
    ring.current?.setLngLat([position.lng, position.lat]);
  }, [position, ref, ring]);
  return null;
}

function carSvg(type) {
  const c = VEHICLE_META[type]?.hex || '#3987e5';
  if (type === 'bike') {
    return `<svg width="16" height="34" viewBox="0 0 16 34"><rect x="5" y="1" width="6" height="9" rx="3" fill="#1f2937" stroke="#0b1020"/><rect x="5" y="24" width="6" height="9" rx="3" fill="#1f2937" stroke="#0b1020"/><rect x="3" y="8" width="10" height="18" rx="5" fill="${c}" stroke="#fff" stroke-width="1.5"/><circle cx="8" cy="15" r="3.4" fill="#0b1020"/></svg>`;
  }
  if (type === 'auto') {
    return `<svg width="24" height="34" viewBox="0 0 24 34"><path d="M12 1.5c5 0 9.5 3.5 10 9v20a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 30.5v-20c.5-5.5 5-9 10-9z" fill="${c}" stroke="#fff" stroke-width="1.5"/><rect x="5" y="9" width="14" height="16" rx="3" fill="#111827" opacity=".85"/></svg>`;
  }
  const h = type === 'sedan' ? 42 : 38;
  return `<svg width="22" height="${h}" viewBox="0 0 22 ${h}"><rect x="1" y="1" width="20" height="${h - 2}" rx="7" fill="${c}" stroke="#fff" stroke-width="1.5"/><path d="M4.5 10.5h13l-1.5 7h-10z" fill="#111216" opacity=".85"/><path d="M5 ${h - 12}h12l-1 5H6z" fill="#111216" opacity=".7"/><rect x="5" y="19" width="12" height="${h - 32}" rx="2" fill="#000" opacity=".12"/></svg>`;
}

/** Vehicle lying flat on the 3D ground, rotated to its heading, gliding between updates. */
export function CarMarker({ position, heading = 0, type = 'mini', zIndexOffset = 0 }) {
  const ref = useHtmlMarker({ position, html: `<div class="mk-car3d"><span class="mk-car-halo"></span>${carSvg(type)}</div>`, flat: true, zIndex: zIndexOffset ? 4 : 2 });
  const anim = useRef(0);
  const lat = position?.lat;
  const lng = position?.lng;
  useEffect(() => {
    const marker = ref.current;
    if (!marker || !Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
    marker.setRotation(heading || 0);
    const from = marker.getLngLat();
    const far = Math.abs(from.lng - lng) + Math.abs(from.lat - lat) > 0.02;
    cancelAnimationFrame(anim.current);
    if (reducedMotion() || far) {
      marker.setLngLat([lng, lat]);
      return undefined;
    }
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 950);
      marker.setLngLat([from.lng + (lng - from.lng) * k, from.lat + (lat - from.lat) * k]);
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(anim.current);
  }, [lat, lng, heading, ref]);
  return null;
}

// Dash pattern frames that make light appear to flow along the route.
const FLOW_FRAMES = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

/** Route with a soft glow and flowing light; the default blue route uses a blue → pink progress gradient. */
export function RouteLine({ coords, color = '#2f80ff', dashed = false }) {
  const map = useContext(MapCtx);
  const id = `rt${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const gradient = !dashed && color === '#2f80ff';
  useEffect(() => {
    if (!map) return undefined;
    map.addSource(id, { type: 'geojson', lineMetrics: true, data: { type: 'FeatureCollection', features: [] } });
    const before = firstSymbolLayer(map);
    const layout = { 'line-cap': 'round', 'line-join': 'round' };
    map.addLayer(
      { id: `${id}-glow`, type: 'line', source: id, layout, paint: { 'line-color': gradient ? '#4b6bff' : color, 'line-width': dashed ? 8 : 16, 'line-opacity': dashed ? 0.12 : 0.3, 'line-blur': 9 } },
      before,
    );
    map.addLayer(
      {
        id: `${id}-line`,
        type: 'line',
        source: id,
        layout,
        paint: dashed
          ? { 'line-color': color, 'line-width': 3, 'line-dasharray': [1, 2.4], 'line-opacity': 0.9 }
          : gradient
            ? { 'line-width': 5.5, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#2f80ff', 0.55, '#6b6bff', 1, '#ff2e7e'] }
            : { 'line-color': color, 'line-width': 5 },
      },
      before,
    );
    let flowTimer = 0;
    if (!dashed) {
      map.addLayer(
        { id: `${id}-flow`, type: 'line', source: id, layout, paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.55, 'line-dasharray': FLOW_FRAMES[0] } },
        before,
      );
      if (!reducedMotion()) {
        let frame = 0;
        flowTimer = setInterval(() => {
          frame = (frame + 1) % FLOW_FRAMES.length;
          try {
            map.setPaintProperty(`${id}-flow`, 'line-dasharray', FLOW_FRAMES[frame]);
          } catch {
            clearInterval(flowTimer);
          }
        }, 60);
      }
    }
    return () => {
      clearInterval(flowTimer);
      try {
        if (!map.getStyle()) return;
        if (map.getLayer(`${id}-flow`)) map.removeLayer(`${id}-flow`);
        map.removeLayer(`${id}-line`);
        map.removeLayer(`${id}-glow`);
        map.removeSource(id);
      } catch {
        /* map already destroyed */
      }
    };
  }, [map, id, color, dashed, gradient]);
  useEffect(() => {
    if (!map) return;
    map.getSource(id)?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: (coords || []).map(([lat, lng]) => [lng, lat]) },
    });
  }, [map, id, coords, color, dashed]);
  return null;
}
