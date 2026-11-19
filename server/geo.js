// Geography helpers: distances, road routing (OSRM) and geocoding (MapTiler, Nominatim fallback).
const MAPTILE_KEY = () => process.env.MAPTILE_API_KEY;
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
// Backup public OSRM server (OpenStreetMap Germany / FOSSGIS), used when the main one fails or rate-limits.
const OSRM_BACKUP_URL = process.env.OSRM_BACKUP_URL || 'https://routing.openstreetmap.de/routed-car';
const UA = 'RideFlow-demo/1.0 (educational ride-booking simulator)';

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Point at `km` distance and `deg` bearing from origin. */
export function offsetPoint(origin, km, deg) {
  const R = 6371;
  const br = (deg * Math.PI) / 180;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lng1 = (origin.lng * Math.PI) / 180;
  const d = km / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 =
    lng1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
}

export function isValidPoint(p) {
  return (
    p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) &&
    Math.abs(+p.lat) <= 90 && Math.abs(+p.lng) <= 180
  );
}

async function fetchJson(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Reduce a polyline to at most `max` points (keeps first/last). */
function downsample(coords, max = 400) {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  return out;
}

/**
 * Call OSRM, falling back to the other server on failure. Rider-facing requests go to the main
 * server first; background requests (simulated drivers) go to the backup first so the bots don't
 * use up the main server's rate limit.
 */
async function osrm(pathAndQuery, { background = false, ms = 7000 } = {}) {
  const servers = background ? [OSRM_BACKUP_URL, OSRM_URL] : [OSRM_URL, OSRM_BACKUP_URL];
  let lastErr;
  for (const base of [...new Set(servers)]) {
    try {
      const data = await fetchJson(`${base}${pathAndQuery}`, ms);
      if (data.code && data.code !== 'Ok') throw new Error(data.code);
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const routeCache = new Map();
const ESTIMATE_TTL_MS = 20_000; // a straight-line fallback is only kept briefly, then real roads are retried

/** Road route between two points. Returns { distanceKm, durationMin, coords: [[lat,lng],...], source } */
export async function getRoute(from, to, { background = false } = {}) {
  const key = [from.lat, from.lng, to.lat, to.lng].map((n) => (+n).toFixed(5)).join(',');
  const cached = routeCache.get(key);
  if (cached && (cached.source === 'osrm' || Date.now() - cached.at < ESTIMATE_TTL_MS)) return cached;
  let result;
  try {
    const data = await osrm(`/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`, { background });
    const r = data.routes?.[0];
    if (!r) throw new Error('no route');
    result = {
      distanceKm: r.distance / 1000,
      durationMin: r.duration / 60,
      coords: downsample(r.geometry.coordinates.map(([lng, lat]) => [lat, lng])),
      source: 'osrm',
    };
  } catch {
    // Fallback: straight line with a road-winding factor.
    const straight = haversineKm(from, to);
    const coords = [];
    for (let i = 0; i <= 20; i++) {
      coords.push([from.lat + ((to.lat - from.lat) * i) / 20, from.lng + ((to.lng - from.lng) * i) / 20]);
    }
    result = {
      distanceKm: straight * 1.35,
      durationMin: ((straight * 1.35) / 24) * 60,
      coords,
      source: 'estimate',
      at: Date.now(),
    };
    if (!background) console.warn('[geo] road routing unavailable, using a straight-line estimate');
  }
  if (routeCache.size > 500) routeCache.clear();
  routeCache.set(key, result);
  return result;
}

const snapCache = new Map();

/**
 * Snap a point to the nearest drivable road (OSRM "nearest"). Returns { lat, lng, distKm, name }
 * or null if the routing service is unavailable. Used to keep vehicles off water, parks and rooftops.
 */
export async function nearestRoad(p, { background = true } = {}) {
  const key = `${(+p.lat).toFixed(4)},${(+p.lng).toFixed(4)}`;
  if (snapCache.has(key)) return snapCache.get(key);
  try {
    const data = await osrm(`/nearest/v1/driving/${p.lng},${p.lat}?number=1`, { background, ms: 5000 });
    const w = data.waypoints?.[0];
    if (!w) return null;
    const result = { lat: w.location[1], lng: w.location[0], distKm: (w.distance || 0) / 1000, name: w.name || null };
    if (snapCache.size > 2000) snapCache.clear();
    snapCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

export async function geocode(query, near) {
  const key = MAPTILE_KEY();
  if (key) {
    try {
      const prox = near ? `&proximity=${near.lng},${near.lat}` : '';
      const data = await fetchJson(
        `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${key}&limit=6${prox}`,
      );
      return (data.features || []).map((f) => ({
        id: f.id,
        name: f.text || f.place_name,
        address: f.place_name,
        lat: f.center[1],
        lng: f.center[0],
      }));
    } catch {
      /* fall through to Nominatim */
    }
  }
  const view = near ? `&viewbox=${near.lng - 0.5},${near.lat + 0.5},${near.lng + 0.5},${near.lat - 0.5}` : '';
  const data = await fetchJson(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}${view}`,
  );
  return data.map((f) => ({
    id: String(f.place_id),
    name: f.name || f.display_name.split(',')[0],
    address: f.display_name,
    lat: +f.lat,
    lng: +f.lon,
  }));
}

export async function reverseGeocode(lat, lng) {
  const key = MAPTILE_KEY();
  if (key) {
    try {
      const data = await fetchJson(`https://api.maptiler.com/geocoding/${lng},${lat}.json?key=${key}&limit=1`);
      const f = data.features?.[0];
      if (f) return { name: f.text, address: f.place_name };
    } catch {
      /* try Nominatim next */
    }
  }
  try {
    const data = await fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`);
    if (data.display_name) return { name: data.name || data.display_name.split(',')[0], address: data.display_name };
  } catch {
    /* fall back to the road name */
  }
  // Last resort: name the pin after the nearest road rather than showing raw coordinates.
  const road = await nearestRoad({ lat, lng }, { background: false });
  if (road?.name) return { name: road.name, address: `${road.name} (pinned location)` };
  return { name: 'Pinned location', address: 'Pinned location' };
}
