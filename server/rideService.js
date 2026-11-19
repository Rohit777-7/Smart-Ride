// Core ride lifecycle. Every state change goes through here so that HTTP routes,
// sockets and the simulated bot drivers share exactly the same rules.
import crypto from 'node:crypto';
import { q, tx, nowIso } from './db.js';
import { HttpError } from './auth.js';
import { emit } from './realtime.js';
import { mail } from './mailer.js';
import { getRoute, haversineKm, isValidPoint, reverseGeocode } from './geo.js';
import {
  VEHICLES, DISPATCH_RADIUS_KM, isVehicleType, computeSurge, priceFor, finalize, evaluatePromo, splitEarnings,
} from './fare.js';

export const ACTIVE_STATUSES = ['requested', 'accepted', 'arrived', 'in_progress'];
const ACTIVE_SQL = `('requested','accepted','arrived','in_progress')`;
export const REQUEST_TTL_MS = Number(process.env.REQUEST_TTL_SECONDS || 180) * 1000;
const FREE_CANCEL_MS = 3 * 60_000;
const PAYMENT_METHODS = ['cash', 'wallet', 'card'];

/** Hooks other modules (the simulator) can attach to. */
export const hooks = { onRequested: null, onDriverCancelled: null };

const txn = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
const pin4 = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- reading

export function loadRide(id) {
  const r = q.get(
    `SELECT r.*,
       p.name passenger_name, p.phone passenger_phone, p.email passenger_email, p.rating_avg passenger_rating,
       du.name driver_name, du.phone driver_phone, du.email driver_email,
       du.rating_avg driver_rating, du.rating_count driver_rating_count, du.is_bot driver_is_bot,
       d.vehicle_model, d.vehicle_number, d.vehicle_color,
       d.lat driver_lat, d.lng driver_lng, d.heading driver_heading
     FROM rides r
     JOIN users p ON p.id = r.passenger_id
     LEFT JOIN users du ON du.id = r.driver_id
     LEFT JOIN drivers d ON d.user_id = r.driver_id
     WHERE r.id = ?`,
    id,
  );
  if (!r) return null;
  r.route = r.route ? JSON.parse(r.route) : [];
  r.fare_breakdown = r.fare_breakdown ? JSON.parse(r.fare_breakdown) : null;
  return r;
}

/** Strip fields a viewer must not see (the PIN is for the passenger only). */
export function viewRide(r, viewer) {
  if (!r) return null;
  const out = { ...r };
  const isPassenger = viewer && viewer.role === 'passenger' && viewer.id === r.passenger_id;
  if (!isPassenger) delete out.pin;
  delete out.passenger_email;
  delete out.driver_email;
  return out;
}

export function canView(r, user) {
  return user.role === 'admin' || r.passenger_id === user.id || r.driver_id === user.id;
}

function broadcast(rideId, extra = {}) {
  const r = loadRide(rideId);
  if (!r) return null;
  emit.user(r.passenger_id, 'ride:update', { ...viewRide(r, { id: r.passenger_id, role: 'passenger' }), ...extra });
  if (r.driver_id) emit.user(r.driver_id, 'ride:update', { ...viewRide(r, { id: r.driver_id, role: 'driver' }), ...extra });
  emit.admins('admin:ride', { id: r.id, status: r.status, vehicle_type: r.vehicle_type });
  return r;
}

export function activeRideFor(user) {
  const col = user.role === 'driver' ? 'driver_id' : 'passenger_id';
  let row = q.get(`SELECT id FROM rides WHERE ${col} = ? AND status IN ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`, user.id);
  if (!row && user.role === 'passenger') {
    // A just-finished ride still waiting for a rating keeps the passenger on the summary screen.
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    row = q.get(
      `SELECT id FROM rides WHERE passenger_id = ? AND status = 'completed' AND rating IS NULL AND completed_at >= ?
       ORDER BY id DESC LIMIT 1`,
      user.id, since,
    );
  }
  return row ? viewRide(loadRide(row.id), user) : null;
}

// ---------------------------------------------------------------- drivers

export function eligibleDrivers(ride, excludeIds = []) {
  const rows = q.all(
    `SELECT d.*, u.name, u.is_bot, u.rating_avg FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE d.is_online = 1 AND d.status = 'available' AND d.vehicle_type = ? AND u.is_active = 1 AND d.lat IS NOT NULL`,
    ride.vehicle_type,
  );
  const pickup = { lat: ride.pickup_lat, lng: ride.pickup_lng };
  return rows
    .map((d) => ({ ...d, pickup_distance_km: haversineKm(pickup, d) }))
    .filter((d) => d.pickup_distance_km <= DISPATCH_RADIUS_KM && !excludeIds.includes(d.user_id))
    .sort((a, b) => a.pickup_distance_km - b.pickup_distance_km);
}

export function nearbyDrivers(point, radiusKm = 4) {
  const rows = q.all(
    `SELECT d.user_id id, d.vehicle_type, d.lat, d.lng, d.heading FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE d.is_online = 1 AND d.status = 'available' AND u.is_active = 1 AND d.lat IS NOT NULL`,
  );
  const near = rows
    .map((d) => ({ ...d, distance_km: haversineKm(point, d) }))
    .filter((d) => d.distance_km <= radiusKm);
  const eta = {};
  for (const t of Object.keys(VEHICLES)) {
    const best = near.filter((d) => d.vehicle_type === t).sort((a, b) => a.distance_km - b.distance_km)[0];
    eta[t] = best ? Math.max(2, Math.round(((best.distance_km * 1.3) / 22) * 60)) : null;
  }
  return { drivers: near, eta };
}

export function requestPayload(r, driver) {
  const v = VEHICLES[r.vehicle_type];
  const subtotal = r.fare_breakdown?.subtotal ?? r.est_fare;
  return {
    id: r.id,
    vehicle_type: r.vehicle_type,
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng, address: r.pickup_address },
    drop: { lat: r.drop_lat, lng: r.drop_lng, address: r.drop_address },
    distance_km: r.distance_km,
    duration_min: r.duration_min,
    est_fare: r.est_fare,
    est_earning: round2(subtotal * (1 - v.commission)),
    discount: r.discount || 0,
    surge: r.surge,
    payment_method: r.payment_method,
    passenger_name: r.passenger_name,
    passenger_rating: r.passenger_rating,
    pickup_distance_km: driver ? round2(haversineKm({ lat: r.pickup_lat, lng: r.pickup_lng }, driver)) : null,
    route: r.route,
    requested_at: r.requested_at,
    expires_at: new Date(new Date(r.requested_at).getTime() + REQUEST_TTL_MS).toISOString(),
  };
}

/** Pending requests a specific driver can still accept. */
export function openRequestsFor(driverId) {
  const d = q.get('SELECT * FROM drivers WHERE user_id = ?', driverId);
  if (!d || !d.is_online || d.status !== 'available' || d.lat == null) return [];
  const since = new Date(Date.now() - REQUEST_TTL_MS).toISOString();
  const rows = q.all(
    `SELECT id FROM rides WHERE status = 'requested' AND vehicle_type = ? AND requested_at >= ? ORDER BY id DESC`,
    d.vehicle_type, since,
  );
  return rows
    .map((row) => loadRide(row.id))
    .filter((r) => haversineKm({ lat: r.pickup_lat, lng: r.pickup_lng }, d) <= DISPATCH_RADIUS_KM)
    .filter((r) => !(declined.get(r.id)?.has(driverId)))
    .map((r) => requestPayload(r, d));
}

const declined = new Map(); // rideId -> Set(driverId)
export function declineRide(rideId, driverId) {
  if (!declined.has(rideId)) declined.set(rideId, new Set());
  declined.get(rideId).add(driverId);
}

// ---------------------------------------------------------------- estimate / create

function readPoint(p, label) {
  if (!isValidPoint(p)) throw new HttpError(400, `${label} location is missing or invalid`);
  return { lat: +p.lat, lng: +p.lng, address: p.address ? String(p.address).slice(0, 300) : null };
}

export async function estimate(user, body) {
  const pickup = readPoint(body.pickup, 'Pickup');
  const drop = readPoint(body.drop, 'Destination');
  const straight = haversineKm(pickup, drop);
  if (straight < 0.2) throw new HttpError(400, 'Pickup and destination are too close');
  if (straight > 150) throw new HttpError(400, 'Destination is too far for a city ride (max 150 km)');
  const scheduled = body.scheduledAt ? new Date(body.scheduledAt) : null;
  const route = await getRoute(pickup, drop);
  const near = nearbyDrivers(pickup, DISPATCH_RADIUS_KM);
  const options = Object.values(VEHICLES).map((v) => {
    const durationMin = route.durationMin / v.speedFactor;
    const s = scheduled ? { surge: 1, reasons: [] } : computeSurge(pickup, v.id);
    const bd = priceFor(v.id, route.distanceKm, durationMin, s.surge);
    const promo = body.promoCode ? evaluatePromo(body.promoCode, user.id, bd.subtotal, v.id) : { discount: 0 };
    const fin = finalize(bd, promo.discount || 0);
    return {
      type: v.id, name: v.name, seats: v.seats, tagline: v.tagline,
      fare: fin.total,
      fareWithoutPromo: finalize(bd, 0).total,
      breakdown: fin,
      surge: s.surge,
      surgeReasons: s.reasons,
      promoError: promo.error || null,
      etaMin: near.eta[v.id],
      durationMin: Math.round(durationMin),
    };
  });
  return {
    distanceKm: round2(route.distanceKm),
    durationMin: Math.round(route.durationMin),
    route: route.coords,
    routeSource: route.source,
    options,
  };
}

export async function createRide(passenger, body) {
  const pickup = readPoint(body.pickup, 'Pickup');
  const drop = readPoint(body.drop, 'Destination');
  const type = body.vehicleType;
  if (!isVehicleType(type)) throw new HttpError(400, 'Choose a vehicle category');
  const paymentMethod = body.paymentMethod || 'cash';
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw new HttpError(400, 'Unsupported payment method');
  const straight = haversineKm(pickup, drop);
  if (straight < 0.2) throw new HttpError(400, 'Pickup and destination are too close');
  if (straight > 150) throw new HttpError(400, 'Destination is too far for a city ride (max 150 km)');

  let scheduledAt = null;
  if (body.scheduledAt) {
    const d = new Date(body.scheduledAt);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid schedule time');
    if (d.getTime() < Date.now() + 14 * 60_000) throw new HttpError(400, 'Schedule at least 15 minutes ahead');
    if (d.getTime() > Date.now() + 7 * 86_400_000) throw new HttpError(400, 'You can schedule up to 7 days ahead');
    scheduledAt = d.toISOString();
  } else {
    const active = q.get(`SELECT id FROM rides WHERE passenger_id = ? AND status IN ${ACTIVE_SQL}`, passenger.id);
    if (active) throw new HttpError(409, 'You already have an active ride');
  }

  const v = VEHICLES[type];
  const route = await getRoute(pickup, drop);
  const durationMin = route.durationMin / v.speedFactor;
  // Scheduled rides lock a no-surge price.
  const surge = scheduledAt ? 1 : computeSurge(pickup, type).surge;
  const bd = priceFor(type, route.distanceKm, durationMin, surge);
  const promo = evaluatePromo(body.promoCode, passenger.id, bd.subtotal, type);
  if (promo.error) throw new HttpError(400, promo.error);
  const fin = finalize(bd, promo.discount || 0);

  if (paymentMethod === 'wallet') {
    const { wallet_balance } = q.get('SELECT wallet_balance FROM users WHERE id = ?', passenger.id);
    if (wallet_balance < fin.total) {
      throw new HttpError(400, `Wallet balance ₹${wallet_balance.toFixed(0)} is less than the fare ₹${fin.total}. Top up or pick another method.`);
    }
  }

  const [pAddr, dAddr] = await Promise.all([
    pickup.address || reverseGeocode(pickup.lat, pickup.lng).then((x) => x.address),
    drop.address || reverseGeocode(drop.lat, drop.lng).then((x) => x.address),
  ]);

  const now = nowIso();
  const rideId = tx(() => {
    const info = q.run(
      `INSERT INTO rides (passenger_id, vehicle_type, status, pickup_lat, pickup_lng, pickup_address,
        drop_lat, drop_lng, drop_address, distance_km, duration_min, route, surge, est_fare, promo_code, discount,
        fare_breakdown, pin, payment_method, share_token, scheduled_at, requested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      passenger.id, type, scheduledAt ? 'scheduled' : 'requested',
      pickup.lat, pickup.lng, pAddr, drop.lat, drop.lng, dAddr,
      round2(route.distanceKm), round2(durationMin), JSON.stringify(route.coords),
      surge, fin.total, promo.promo?.code || null, fin.discount, JSON.stringify(fin),
      pin4(), paymentMethod, crypto.randomBytes(9).toString('base64url'),
      scheduledAt, scheduledAt ? null : now,
    );
    const id = Number(info.lastInsertRowid);
    if (promo.promo) {
      q.run('INSERT INTO promo_usage (code, user_id, ride_id, discount) VALUES (?,?,?,?)', promo.promo.code, passenger.id, id, fin.discount);
      q.run('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?', promo.promo.code);
    }
    return id;
  });

  const ride = loadRide(rideId);
  if (scheduledAt) {
    mail.rideScheduled(q.get('SELECT * FROM users WHERE id = ?', passenger.id), ride);
    emit.admins('admin:ride', { id: rideId, status: 'scheduled' });
  } else {
    ride.notified = dispatch(rideId);
  }
  return viewRide({ ...loadRide(rideId), notified: ride.notified }, passenger);
}

/** Notify nearby eligible drivers in real time. Returns how many were notified. */
export function dispatch(rideId, excludeIds = []) {
  const r = loadRide(rideId);
  if (!r || r.status !== 'requested') return 0;
  const drivers = eligibleDrivers(r, [...excludeIds, ...(declined.get(rideId) || [])]);
  for (const d of drivers) {
    if (!d.is_bot) emit.user(d.user_id, 'ride:request', requestPayload(r, d));
  }
  emit.admins('admin:event', { type: 'ride_requested', rideId, drivers: drivers.length });
  hooks.onRequested?.(r, drivers);
  return drivers.length;
}

// ---------------------------------------------------------------- lifecycle

function mustBeDriverOf(r, driverId) {
  if (!r) throw new HttpError(404, 'Ride not found');
  if (r.driver_id !== driverId) throw new HttpError(403, 'This ride is not assigned to you');
}

export function acceptRide(rideId, driverId) {
  const drv = q.get('SELECT d.*, u.name FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = ?', driverId);
  if (!drv) throw new HttpError(404, 'Driver profile not found');
  if (!drv.is_online) throw new HttpError(400, 'Go online to accept rides');
  if (drv.status !== 'available') throw new HttpError(400, 'Finish your current trip first');
  const r = loadRide(rideId);
  if (!r) throw new HttpError(404, 'Ride not found');
  if (r.vehicle_type !== drv.vehicle_type) throw new HttpError(400, 'Vehicle category does not match');

  tx(() => {
    const res = q.run(
      `UPDATE rides SET driver_id = ?, status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'requested'`,
      driverId, nowIso(), rideId,
    );
    if (res.changes !== 1) throw new HttpError(409, 'Another driver already accepted this ride');
    q.run(`UPDATE drivers SET status = 'on_trip' WHERE user_id = ?`, driverId);
  });
  declined.delete(rideId);
  emit.drivers('ride:request_closed', { id: rideId });
  const ride = broadcast(rideId);
  mail.driverAssigned({ email: ride.passenger_email }, ride, { ...drv, name: drv.name });
  return ride;
}

export function markArrived(rideId, driverId) {
  const r = loadRide(rideId);
  mustBeDriverOf(r, driverId);
  if (r.status !== 'accepted') throw new HttpError(400, `Cannot mark arrived while ride is ${r.status}`);
  q.run(`UPDATE rides SET status = 'arrived', arrived_at = ? WHERE id = ?`, nowIso(), rideId);
  return broadcast(rideId);
}

const tripTrail = new Map(); // driverId -> last point while in progress

export function startRide(rideId, driverId, pin) {
  const r = loadRide(rideId);
  mustBeDriverOf(r, driverId);
  if (!['accepted', 'arrived'].includes(r.status)) throw new HttpError(400, `Cannot start a ride that is ${r.status}`);
  if (r.pin_attempts >= 5) throw new HttpError(429, 'Too many wrong PIN attempts. Ask the passenger to contact support.');
  if (String(pin || '').trim() !== r.pin) {
    q.run('UPDATE rides SET pin_attempts = pin_attempts + 1 WHERE id = ?', rideId);
    const left = 4 - r.pin_attempts;
    throw new HttpError(400, `Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} left.`);
  }
  const now = nowIso();
  q.run(
    `UPDATE rides SET status = 'in_progress', started_at = ?, arrived_at = COALESCE(arrived_at, ?), actual_distance_km = 0 WHERE id = ?`,
    now, now, rideId,
  );
  tripTrail.delete(driverId);
  return broadcast(rideId);
}

export function completeRide(rideId, driverId) {
  const r = loadRide(rideId);
  mustBeDriverOf(r, driverId);
  if (r.status !== 'in_progress') throw new HttpError(400, 'Only rides in progress can be completed');

  // Fare from actual trip where it meaningfully differs from the plan (detours / early drop-off).
  const planned = r.distance_km;
  const actual = r.actual_distance_km;
  let distance = planned;
  if (actual > planned * 1.1 || (actual > 0.3 && actual < planned * 0.6)) distance = actual;
  const elapsedMin = (Date.now() - new Date(r.started_at).getTime()) / 60_000;
  const duration = Math.max(r.duration_min, elapsedMin);
  const bd = priceFor(r.vehicle_type, distance, duration, r.surge);
  const fin = finalize(bd, r.discount);
  const split = splitEarnings(r.vehicle_type, fin.subtotal, fin.discount);

  let method = r.payment_method;
  let note = null;
  tx(() => {
    if (method === 'wallet') {
      const res = q.run('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ? AND wallet_balance >= ?', fin.total, r.passenger_id, fin.total);
      if (res.changes !== 1) {
        method = 'cash';
        note = 'Wallet balance insufficient at drop-off — collected in cash';
      }
    }
    const txnId = txn(method === 'card' ? 'TEST_CARD' : method === 'wallet' ? 'WALLET' : 'CASH');
    q.run(
      `INSERT INTO payments (ride_id, user_id, type, method, amount, status, txn_id, note) VALUES (?,?,?,?,?,?,?,?)`,
      rideId, r.passenger_id, 'charge', method, fin.total, 'paid', txnId,
      note || (method === 'card' ? 'Simulated test-card charge' : method === 'cash' ? 'Collected by driver' : 'Debited from wallet'),
    );
    q.run(
      `UPDATE rides SET status = 'completed', completed_at = ?, final_fare = ?, tax = ?, commission = ?, driver_earning = ?,
         fare_breakdown = ?, payment_method = ?, payment_status = 'paid' WHERE id = ?`,
      nowIso(), fin.total, fin.tax, split.commission, split.driverEarning,
      JSON.stringify({ ...fin, commissionRate: split.rate, platformNet: split.platformNet, plannedDistanceKm: planned, actualDistanceKm: round2(actual) }),
      method, rideId,
    );
    q.run(`UPDATE drivers SET status = 'available' WHERE user_id = ?`, driverId);
  });
  tripTrail.delete(driverId);
  const ride = broadcast(rideId);
  mail.receipt({ email: ride.passenger_email }, ride);
  emit.admins('admin:event', { type: 'ride_completed', rideId, fare: fin.total });
  return ride;
}

function restorePromo(r) {
  if (!r.promo_code) return;
  const del = q.run('DELETE FROM promo_usage WHERE ride_id = ?', r.id);
  if (del.changes) q.run('UPDATE promo_codes SET used_count = MAX(0, used_count - 1) WHERE code = ?', r.promo_code);
}

export function cancelRide(rideId, user, reason) {
  const r = loadRide(rideId);
  if (!r) throw new HttpError(404, 'Ride not found');
  reason = String(reason || '').slice(0, 200) || null;

  // Driver backs out: ride returns to the pool and is re-dispatched to other drivers.
  if (user.role === 'driver') {
    mustBeDriverOf(r, user.id);
    if (!['accepted', 'arrived'].includes(r.status)) throw new HttpError(400, 'This ride can no longer be cancelled');
    tx(() => {
      q.run(
        `UPDATE rides SET status = 'requested', driver_id = NULL, accepted_at = NULL, arrived_at = NULL, requested_at = ? WHERE id = ?`,
        nowIso(), rideId,
      );
      q.run(`UPDATE drivers SET status = 'available' WHERE user_id = ?`, user.id);
    });
    declineRide(rideId, user.id);
    emit.user(user.id, 'ride:update', { ...viewRide(r, user), status: 'cancelled', cancelled_by: 'driver' });
    broadcast(rideId, { notice: 'Your driver cancelled. Finding you another driver…' });
    dispatch(rideId, [user.id]);
    hooks.onDriverCancelled?.(rideId, user.id);
    return loadRide(rideId);
  }

  const isOwner = user.role === 'passenger' && r.passenger_id === user.id;
  if (!isOwner && user.role !== 'admin') throw new HttpError(403, 'Not your ride');
  if (!['scheduled', 'requested', 'accepted', 'arrived'].includes(r.status)) {
    throw new HttpError(400, r.status === 'in_progress' ? 'Ride is in progress — ask the driver to end it, or use SOS in an emergency' : 'This ride can no longer be cancelled');
  }

  // Cancellation fee: after the driver arrived, or more than 3 minutes after the driver accepted.
  let fee = 0;
  if (isOwner) {
    const lateAccept = r.status === 'accepted' && Date.now() - new Date(r.accepted_at).getTime() > FREE_CANCEL_MS;
    if (r.status === 'arrived' || lateAccept) fee = VEHICLES[r.vehicle_type].cancelFee;
  }
  const by = isOwner ? 'passenger' : 'admin';

  tx(() => {
    let feeStatus = null;
    let feeMethod = r.payment_method === 'card' ? 'card' : 'wallet';
    if (fee > 0) {
      if (feeMethod === 'wallet') {
        const res = q.run('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ? AND wallet_balance >= ?', fee, r.passenger_id, fee);
        feeStatus = res.changes ? 'paid' : 'due';
      } else feeStatus = 'paid';
      q.run(
        `INSERT INTO payments (ride_id, user_id, type, method, amount, status, txn_id, note) VALUES (?,?,?,?,?,?,?,?)`,
        rideId, r.passenger_id, 'cancellation_fee', feeMethod, fee, feeStatus, txn('CXL'),
        feeStatus === 'due' ? 'Insufficient wallet balance — added as dues' : 'Late cancellation fee',
      );
    }
    const split = fee > 0 ? splitEarnings(r.vehicle_type, fee, 0) : null;
    q.run(
      `UPDATE rides SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, cancellation_fee = ?,
         driver_earning = ?, commission = ?, payment_status = ? WHERE id = ?`,
      nowIso(), by, reason, fee, split?.driverEarning ?? null, split?.commission ?? null,
      fee > 0 ? (feeStatus === 'due' ? 'due' : 'paid') : 'none', rideId,
    );
    if (r.driver_id) q.run(`UPDATE drivers SET status = 'available' WHERE user_id = ?`, r.driver_id);
    restorePromo(r);
  });
  if (r.status === 'requested') emit.drivers('ride:request_closed', { id: rideId });
  const ride = broadcast(rideId);
  mail.cancelled({ email: ride.passenger_email }, ride, by, fee);
  return ride;
}

// ---------------------------------------------------------------- location tracking

export function updateDriverLocation(driverId, p) {
  if (!isValidPoint(p)) return;
  const point = { lat: +p.lat, lng: +p.lng };
  const heading = Number.isFinite(+p.heading) ? +p.heading : 0;
  q.run('UPDATE drivers SET lat = ?, lng = ?, heading = ?, location_updated_at = ? WHERE user_id = ?', point.lat, point.lng, heading, nowIso(), driverId);
  const active = q.get(`SELECT id, passenger_id, status FROM rides WHERE driver_id = ? AND status IN ('accepted','arrived','in_progress')`, driverId);
  if (!active) return;
  emit.user(active.passenger_id, 'driver:location', { rideId: active.id, ...point, heading });
  if (active.status === 'in_progress') {
    const prev = tripTrail.get(driverId);
    if (prev) {
      const d = haversineKm(prev, point);
      if (d > 0.002 && d < 1) q.run('UPDATE rides SET actual_distance_km = actual_distance_km + ? WHERE id = ?', d, active.id);
    }
    tripTrail.set(driverId, point);
  }
}

// ---------------------------------------------------------------- rating, refunds, SOS

export function rateRide(rideId, passengerId, rating, feedback) {
  const r = loadRide(rideId);
  if (!r || r.passenger_id !== passengerId) throw new HttpError(404, 'Ride not found');
  if (r.status !== 'completed') throw new HttpError(400, 'You can rate only completed rides');
  if (r.rating != null) throw new HttpError(400, 'Ride already rated');
  const value = Math.round(Number(rating));
  if (!(value >= 0 && value <= 5)) throw new HttpError(400, 'Rating must be 1–5');
  tx(() => {
    q.run('UPDATE rides SET rating = ?, feedback = ? WHERE id = ?', value, String(feedback || '').slice(0, 500) || null, rideId);
    if (value > 0 && r.driver_id) {
      q.run(
        `UPDATE users SET rating_avg = ROUND((rating_avg * rating_count + ?) / (rating_count + 1), 2), rating_count = rating_count + 1 WHERE id = ?`,
        value, r.driver_id,
      );
    }
  });
  const ride = loadRide(rideId);
  if (value > 0 && r.driver_id) emit.user(r.driver_id, 'ride:rated', { rideId, rating: value, feedback: ride.feedback });
  return ride;
}

export function requestRefund(rideId, userId, reason, amount) {
  const r = loadRide(rideId);
  if (!r || r.passenger_id !== userId) throw new HttpError(404, 'Ride not found');
  const paid = r.status === 'completed' ? r.final_fare : r.cancellation_fee;
  if (!paid) throw new HttpError(400, 'Nothing was charged for this ride');
  if (!reason || String(reason).trim().length < 5) throw new HttpError(400, 'Please describe the issue');
  const existing = q.get(`SELECT id FROM refund_requests WHERE ride_id = ? AND status IN ('pending','approved')`, rideId);
  if (existing) throw new HttpError(400, 'A refund request already exists for this ride');
  const amt = amount ? Math.min(Number(amount), paid) : paid;
  if (!(amt > 0)) throw new HttpError(400, 'Invalid amount');
  const info = q.run('INSERT INTO refund_requests (ride_id, user_id, reason, amount_requested) VALUES (?,?,?,?)', rideId, userId, String(reason).slice(0, 500), round2(amt));
  emit.admins('admin:event', { type: 'refund_requested', rideId });
  return q.get('SELECT * FROM refund_requests WHERE id = ?', Number(info.lastInsertRowid));
}

export function resolveRefund(requestId, approve, amount, note) {
  const req = q.get('SELECT * FROM refund_requests WHERE id = ?', requestId);
  if (!req) throw new HttpError(404, 'Refund request not found');
  if (req.status !== 'pending') throw new HttpError(400, 'Already resolved');
  const ride = loadRide(req.ride_id);
  const amt = approve ? Math.min(Number(amount ?? req.amount_requested), req.amount_requested) : null;
  if (approve && !(amt > 0)) throw new HttpError(400, 'Invalid refund amount');
  tx(() => {
    q.run(
      `UPDATE refund_requests SET status = ?, amount_approved = ?, admin_note = ?, resolved_at = ? WHERE id = ?`,
      approve ? 'approved' : 'rejected', amt, note || null, nowIso(), requestId,
    );
    if (approve) {
      q.run('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', amt, req.user_id);
      q.run(
        `INSERT INTO payments (ride_id, user_id, type, method, amount, status, txn_id, note) VALUES (?,?,?,?,?,?,?,?)`,
        req.ride_id, req.user_id, 'refund', 'wallet', amt, 'refunded', txn('RFND'), note || 'Refund credited to wallet',
      );
      const total = ride.status === 'completed' ? ride.final_fare : ride.cancellation_fee;
      q.run('UPDATE rides SET payment_status = ? WHERE id = ?', amt >= total ? 'refunded' : 'partially_refunded', req.ride_id);
    }
  });
  const updated = q.get('SELECT * FROM refund_requests WHERE id = ?', requestId);
  const user = q.get('SELECT * FROM users WHERE id = ?', req.user_id);
  mail.refund(user, ride, updated);
  emit.user(req.user_id, 'notify', {
    title: `Refund ${updated.status}`,
    body: approve ? `₹${amt} credited to your wallet for ride #${req.ride_id}` : `Refund for ride #${req.ride_id} was rejected`,
  });
  return updated;
}

export function triggerSos(user, body) {
  const rideId = body.rideId ? Number(body.rideId) : null;
  const ride = rideId ? loadRide(rideId) : null;
  if (ride && !canView(ride, user)) throw new HttpError(403, 'Not your ride');
  let lat = Number(body.lat), lng = Number(body.lng);
  if (!Number.isFinite(lat) && ride) {
    lat = ride.driver_lat ?? ride.pickup_lat;
    lng = ride.driver_lng ?? ride.pickup_lng;
  }
  const info = q.run(
    'INSERT INTO sos_alerts (ride_id, user_id, role, lat, lng, message) VALUES (?,?,?,?,?,?)',
    rideId, user.id, user.role, Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null,
    String(body.message || '').slice(0, 300) || null,
  );
  const alert = q.get(
    'SELECT s.*, u.name user_name, u.phone user_phone FROM sos_alerts s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
    Number(info.lastInsertRowid),
  );
  const contacts = q.all('SELECT * FROM emergency_contacts WHERE user_id = ?', user.id);
  const fullUser = q.get('SELECT * FROM users WHERE id = ?', user.id);
  for (const c of contacts) mail.sos(c, fullUser, ride, alert);
  emit.admins('sos:new', alert);
  return { alert, contactsNotified: contacts.length, contactsWithEmail: contacts.filter((c) => c.email).length };
}

// ---------------------------------------------------------------- background jobs

export function expireStaleRequests() {
  const cutoff = new Date(Date.now() - REQUEST_TTL_MS).toISOString();
  const stale = q.all(`SELECT id FROM rides WHERE status = 'requested' AND requested_at < ?`, cutoff);
  for (const { id } of stale) {
    const r = loadRide(id);
    q.run(
      `UPDATE rides SET status = 'no_driver', cancelled_at = ?, cancelled_by = 'system', cancel_reason = 'No drivers accepted in time', payment_status = 'none' WHERE id = ? AND status = 'requested'`,
      nowIso(), id,
    );
    restorePromo(r);
    emit.drivers('ride:request_closed', { id });
    broadcast(id);
  }
}

export function releaseScheduledRides() {
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const due = q.all(`SELECT id, passenger_id FROM rides WHERE status = 'scheduled' AND scheduled_at <= ?`, soon);
  for (const { id, passenger_id } of due) {
    const busy = q.get(`SELECT id FROM rides WHERE passenger_id = ? AND status IN ${ACTIVE_SQL}`, passenger_id);
    if (busy) continue; // try again next tick
    q.run(`UPDATE rides SET status = 'requested', requested_at = ? WHERE id = ? AND status = 'scheduled'`, nowIso(), id);
    broadcast(id, { notice: 'Your scheduled ride is now looking for a driver' });
    emit.user(passenger_id, 'notify', { title: 'Scheduled ride', body: `Finding a driver for ride #${id}` });
    dispatch(id);
  }
}
