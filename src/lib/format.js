export const inr = (n, digits = 0) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const km = (n) => `${Number(n || 0).toFixed(n < 10 ? 1 : 0)} km`;

export const mins = (n) => {
  const m = Math.max(1, Math.round(n || 0));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

export const dateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : '—';

export const dateOnly = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export const timeOnly = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—';

export const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0].toUpperCase())
    .join('') || '?';

export const shortAddress = (a = '') => (a || '').split(',').slice(0, 2).join(',');

export const VEHICLE_META = {
  bike: { name: 'Bike', color: 'var(--v-bike)', hex: '#3987e5', seats: 1 },
  auto: { name: 'Auto', color: 'var(--v-auto)', hex: '#d95926', seats: 3 },
  mini: { name: 'Mini', color: 'var(--v-mini)', hex: '#199e70', seats: 4 },
  sedan: { name: 'Sedan', color: 'var(--v-sedan)', hex: '#c98500', seats: 4 },
};
export const VEHICLE_TYPES = Object.keys(VEHICLE_META);

export const STATUS_META = {
  scheduled: { label: 'Scheduled', tone: 'violet' },
  requested: { label: 'Finding driver', tone: 'primary' },
  accepted: { label: 'Driver on the way', tone: 'primary' },
  arrived: { label: 'Driver arrived', tone: 'warning' },
  in_progress: { label: 'On trip', tone: 'primary' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  no_driver: { label: 'No driver found', tone: 'danger' },
};

export const PAYMENT_LABEL = { cash: 'Cash', wallet: 'RideFlow Wallet', card: 'Test card •••• 4242' };

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
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

/** Index of the polyline vertex closest to a point. */
export function nearestIndex(coords, p) {
  let best = 0;
  let bestD = Infinity;
  coords.forEach(([lat, lng], i) => {
    const d = (lat - p.lat) ** 2 + (lng - p.lng) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export function pathLengthKm(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineKm({ lat: coords[i - 1][0], lng: coords[i - 1][1] }, { lat: coords[i][0], lng: coords[i][1] });
  }
  return total;
}
