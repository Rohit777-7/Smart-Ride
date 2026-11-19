// Passenger-facing ride endpoints (plus shared read endpoints for drivers/admins).
import { Router } from 'express';
import { q } from '../db.js';
import { HttpError, requireAuth } from '../auth.js';
import * as rides from '../rideService.js';
import * as chat from '../chat.js';
import { ensureBotsNear } from '../sim.js';
import { geocode, reverseGeocode, isValidPoint, getRoute, nearestRoad } from '../geo.js';
import { VEHICLES, evaluatePromo } from '../fare.js';

const router = Router();
const pointFrom = (query) => ({ lat: Number(query.lat), lng: Number(query.lng) });

// ---- geo helpers (proxied so API keys stay on the server and results are cached)
router.get('/geo/search', requireAuth(), async (req, res) => {
  const text = String(req.query.q || '').trim();
  if (text.length < 2) return res.json({ results: [] });
  const near = isValidPoint(pointFrom(req.query)) ? pointFrom(req.query) : null;
  res.json({ results: await geocode(text, near) });
});

router.get('/geo/reverse', requireAuth(), async (req, res) => {
  const p = pointFrom(req.query);
  if (!isValidPoint(p)) throw new HttpError(400, 'Invalid coordinates');
  res.json(await reverseGeocode(p.lat, p.lng));
});

// Snap a point onto the nearest drivable road (falls back to the point itself if routing is unavailable).
router.get('/geo/snap', requireAuth(), async (req, res) => {
  const p = pointFrom(req.query);
  if (!isValidPoint(p)) throw new HttpError(400, 'Invalid coordinates');
  const road = await nearestRoad(p, { background: false });
  res.json(road || { ...p, distKm: 0, name: null });
});

router.get('/route', requireAuth(), async (req, res) => {
  const from = { lat: Number(req.query.fromLat), lng: Number(req.query.fromLng) };
  const to = { lat: Number(req.query.toLat), lng: Number(req.query.toLng) };
  if (!isValidPoint(from) || !isValidPoint(to)) throw new HttpError(400, 'Invalid coordinates');
  const r = await getRoute(from, to);
  res.json({ distanceKm: r.distanceKm, durationMin: r.durationMin, route: r.coords });
});

router.get('/vehicles',(_req, res) => res.json({ vehicles: Object.values(VEHICLES) }));

router.get('/rides/nearby-drivers', requireAuth(), (req, res) => {
  const p = pointFrom(req.query);
  if (!isValidPoint(p)) throw new HttpError(400, 'Invalid coordinates');
  ensureBotsNear(p);
  const { drivers, eta } = rides.nearbyDrivers(p);
  res.json({ drivers: drivers.map(({ id, vehicle_type, lat, lng, heading }) => ({ id, vehicle_type, lat, lng, heading })), eta });
});

router.post('/rides/estimate', requireAuth('passenger'), async (req, res) => {
  res.json(await rides.estimate(req.user, req.body || {}));
});

router.post('/promos/validate', requireAuth('passenger'), (req, res) => {
  const { code, subtotal, vehicleType } = req.body || {};
  const r = evaluatePromo(code, req.user.id, Number(subtotal) || 0, vehicleType);
  if (r.error) throw new HttpError(400, r.error);
  res.json({ code: r.promo.code, description: r.promo.description, discount: r.discount });
});

router.get('/promos', requireAuth(), (_req, res) => {
  res.json({
    promos: q.all(
      `SELECT code, description, discount_type, value, max_discount, min_fare, vehicle_type, valid_until FROM promo_codes
       WHERE active = 1 AND (valid_until IS NULL OR valid_until > ?) AND (usage_limit IS NULL OR used_count < usage_limit)`,
      new Date().toISOString(),
    ),
  });
});

router.post('/rides', requireAuth('passenger'), async (req, res) => {
  res.status(201).json({ ride: await rides.createRide(req.user, req.body || {}) });
});

router.get('/rides/active', requireAuth(), (req, res) => {
  res.json({ ride: rides.activeRideFor(req.user) });
});

router.get('/rides/history', requireAuth(), (req, res) => {
  const col = req.user.role === 'driver' ? 'driver_id' : 'passenger_id';
  const rows = q.all(
    `SELECT r.id, r.status, r.vehicle_type, r.pickup_address, r.drop_address, r.distance_km, r.est_fare, r.final_fare,
       r.pickup_lat, r.pickup_lng, r.drop_lat, r.drop_lng,
       r.cancellation_fee, r.payment_method, r.payment_status, r.rating, r.scheduled_at, r.requested_at, r.completed_at,
       r.cancelled_at, r.cancelled_by, r.created_at, r.driver_earning, r.promo_code, r.discount,
       du.name driver_name, p.name passenger_name,
       (SELECT status FROM refund_requests rr WHERE rr.ride_id = r.id ORDER BY rr.id DESC LIMIT 1) refund_status
     FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users du ON du.id = r.driver_id
     WHERE r.${col} = ? ORDER BY COALESCE(r.scheduled_at, r.created_at) DESC LIMIT 200`,
    req.user.id,
  );
  res.json({ rides: rows });
});

router.get('/rides/:id', requireAuth(), (req, res) => {
  const r = rides.loadRide(Number(req.params.id));
  if (!r || !rides.canView(r, req.user)) throw new HttpError(404, 'Ride not found');
  const payments = q.all('SELECT * FROM payments WHERE ride_id = ? ORDER BY id', r.id);
  const refunds = q.all('SELECT * FROM refund_requests WHERE ride_id = ? ORDER BY id', r.id);
  res.json({ ride: rides.viewRide(r, req.user), payments, refunds });
});

router.post('/rides/:id/cancel', requireAuth(), (req, res) => {
  const r = rides.cancelRide(Number(req.params.id), req.user, req.body?.reason);
  res.json({ ride: rides.viewRide(r, req.user) });
});

router.post('/rides/:id/rate', requireAuth('passenger'), (req, res) => {
  const r = rides.rateRide(Number(req.params.id), req.user.id, req.body?.rating, req.body?.feedback);
  res.json({ ride: rides.viewRide(r, req.user) });
});

router.post('/rides/:id/refund', requireAuth('passenger'), (req, res) => {
  res.status(201).json({ refund: rides.requestRefund(Number(req.params.id), req.user.id, req.body?.reason, req.body?.amount) });
});

// ---- in-app chat between the rider and driver of a ride
router.get('/rides/:id/messages', requireAuth(), (req, res) => {
  res.json(chat.listMessages(req.params.id, req.user));
});

router.post('/rides/:id/messages', requireAuth('passenger', 'driver'), (req, res) => {
  res.status(201).json({ message: chat.sendMessage(req.params.id, req.user, req.body?.body) });
});

router.post('/rides/:id/messages/read', requireAuth(), (req, res) => {
  res.json(chat.markRead(req.params.id, req.user));
});

router.post('/sos', requireAuth('passenger', 'driver'), (req, res) => {
  res.status(201).json(rides.triggerSos(req.user, req.body || {}));
});

// ---- public live-trip link (shared with family/friends)
router.get('/track/:token', (req, res) => {
  const row = q.get('SELECT id FROM rides WHERE share_token = ?', String(req.params.token));
  if (!row) throw new HttpError(404, 'Trip not found');
  const r = rides.loadRide(row.id);
  res.json({
    ride: {
      id: r.id, status: r.status, vehicle_type: r.vehicle_type,
      passenger_first_name: r.passenger_name.split(' ')[0],
      driver_name: r.driver_name, vehicle_model: r.vehicle_model, vehicle_number: r.vehicle_number, vehicle_color: r.vehicle_color,
      pickup: { lat: r.pickup_lat, lng: r.pickup_lng, address: r.pickup_address },
      drop: { lat: r.drop_lat, lng: r.drop_lng, address: r.drop_address },
      driver: ['accepted', 'arrived', 'in_progress'].includes(r.status) && r.driver_lat != null
        ? { lat: r.driver_lat, lng: r.driver_lng, heading: r.driver_heading } : null,
      route: r.route, started_at: r.started_at, completed_at: r.completed_at, duration_min: r.duration_min,
    },
  });
});

export default router;
