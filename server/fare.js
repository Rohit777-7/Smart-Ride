// Vehicle categories, dynamic (surge) pricing, promo codes and commission.
import { q } from './db.js';
import { haversineKm } from './geo.js';

export const DISPATCH_RADIUS_KM = Number(process.env.DISPATCH_RADIUS_KM || 6);
export const TAX_RATE = 0.05;

export const VEHICLES = {
  bike: {
    id: 'bike', name: 'Bike', seats: 1, tagline: 'Beat the traffic',
    base: 20, perKm: 6, perMin: 1, minFare: 30, commission: 0.15, cancelFee: 20, speedFactor: 1.15,
  },
  auto: {
    id: 'auto', name: 'Auto', seats: 3, tagline: 'Everyday rides',
    base: 30, perKm: 11, perMin: 1.5, minFare: 45, commission: 0.15, cancelFee: 25, speedFactor: 0.95,
  },
  mini: {
    id: 'mini', name: 'Mini', seats: 4, tagline: 'Comfy hatchbacks',
    base: 50, perKm: 14, perMin: 2, minFare: 80, commission: 0.2, cancelFee: 40, speedFactor: 1,
  },
  sedan: {
    id: 'sedan', name: 'Sedan', seats: 4, tagline: 'Extra legroom',
    base: 70, perKm: 18, perMin: 2.5, minFare: 120, commission: 0.2, cancelFee: 50, speedFactor: 1,
  },
};

export const isVehicleType = (t) => Object.hasOwn(VEHICLES, t);
const round = (n) => Math.round(n * 100) / 100;

/** Time-of-day multiplier (peak hours and night charge). */
function timeMultiplier(date = new Date()) {
  const h = date.getHours();
  if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) return { value: 0.2, label: 'Peak hours' };
  if (h >= 23 || h < 5) return { value: 0.15, label: 'Night charge' };
  return { value: 0, label: null };
}

/**
 * Dynamic surge based on live demand (open requests nearby) vs supply (free drivers nearby),
 * plus a time-of-day component. Capped at 2.5x.
 */
export function computeSurge(point, vehicleType, when = new Date()) {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const open = q.all(
    `SELECT pickup_lat lat, pickup_lng lng FROM rides
     WHERE status = 'requested' AND vehicle_type = ? AND requested_at >= ?`,
    vehicleType, since,
  );
  const demand = open.filter((r) => haversineKm(point, r) <= DISPATCH_RADIUS_KM).length;
  const drivers = q.all(
    `SELECT lat, lng FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE d.is_online = 1 AND d.status = 'available' AND d.vehicle_type = ? AND u.is_active = 1 AND d.lat IS NOT NULL`,
    vehicleType,
  );
  const supply = drivers.filter((d) => haversineKm(point, d) <= DISPATCH_RADIUS_KM).length;

  const ratio = (demand + 1) / (supply + 1);
  const demandPart = ratio > 1 ? Math.min(0.9, (ratio - 1) * 0.4) : 0;
  const scarcity = supply === 0 ? 0.2 : 0;
  const tm = timeMultiplier(when);
  const surge = Math.min(2.5, Math.round((1 + demandPart + scarcity + tm.value) * 10) / 10);

  const reasons = [];
  if (demandPart > 0) reasons.push('High demand');
  if (scarcity > 0) reasons.push('Few drivers nearby');
  if (tm.label) reasons.push(tm.label);
  return { surge, demand, supply, reasons };
}

/** Fare for a category. Returns a full breakdown (all INR). */
export function priceFor(vehicleType, distanceKm, durationMin, surge = 1) {
  const v = VEHICLES[vehicleType];
  const distanceFare = v.perKm * distanceKm;
  const timeFare = v.perMin * durationMin;
  const raw = v.base + distanceFare + timeFare;
  const surgeAmount = raw * (surge - 1);
  const subtotal = Math.max(v.minFare, raw + surgeAmount);
  return {
    base: round(v.base),
    distanceKm: round(distanceKm),
    distanceFare: round(distanceFare),
    durationMin: round(durationMin),
    timeFare: round(timeFare),
    surge,
    surgeAmount: round(surgeAmount),
    minFareApplied: subtotal === v.minFare,
    subtotal: round(subtotal),
  };
}

/** Apply discount + tax on top of a priceFor() breakdown. */
export function finalize(breakdown, discount = 0) {
  const d = Math.min(discount, breakdown.subtotal);
  const taxable = breakdown.subtotal - d;
  const tax = taxable * TAX_RATE;
  return { ...breakdown, discount: round(d), tax: round(tax), total: Math.round(taxable + tax) };
}

/** Validate a promo for a user/fare. Returns { promo, discount } or { error }. */
export function evaluatePromo(code, userId, subtotal, vehicleType) {
  if (!code) return { discount: 0 };
  const promo = q.get('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE', String(code).trim());
  if (!promo || !promo.active) return { error: 'Invalid promo code' };
  if (promo.valid_until && new Date(promo.valid_until) < new Date()) return { error: 'This promo has expired' };
  if (promo.usage_limit != null && promo.used_count >= promo.usage_limit) return { error: 'Promo usage limit reached' };
  if (promo.vehicle_type && promo.vehicle_type !== vehicleType) {
    return { error: `Valid only on ${VEHICLES[promo.vehicle_type]?.name || promo.vehicle_type} rides` };
  }
  if (subtotal < promo.min_fare) return { error: `Minimum fare ₹${promo.min_fare} required` };
  const used = q.get(
    `SELECT COUNT(*) n FROM promo_usage pu JOIN rides r ON r.id = pu.ride_id
     WHERE pu.code = ? AND pu.user_id = ? AND r.status != 'cancelled'`,
    promo.code, userId,
  ).n;
  if (used >= promo.per_user_limit) return { error: 'You have already used this promo' };
  let discount = promo.discount_type === 'percent' ? (subtotal * promo.value) / 100 : promo.value;
  if (promo.max_discount != null) discount = Math.min(discount, promo.max_discount);
  return { promo, discount: round(Math.min(discount, subtotal)) };
}

/** Driver earning & platform commission. Platform absorbs promo discounts. */
export function splitEarnings(vehicleType, subtotal, discount) {
  const rate = VEHICLES[vehicleType].commission;
  const commission = subtotal * rate;
  return {
    rate,
    driverEarning: round(subtotal - commission),
    commission: round(commission),
    platformNet: round(commission - discount),
  };
}
