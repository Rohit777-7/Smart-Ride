import { Router } from 'express';
import { q, nowIso } from '../db.js';
import { HttpError, requireAuth } from '../auth.js';
import * as rides from '../rideService.js';
import { isValidPoint } from '../geo.js';

const router = Router();
router.use(requireAuth('driver'));

router.post('/online', (req, res) => {
  const { online, lat, lng } = req.body || {};
  const active = q.get(`SELECT id FROM rides WHERE driver_id = ? AND status IN ('accepted','arrived','in_progress')`, req.user.id);
  if (!online && active) throw new HttpError(400, 'Finish your current trip before going offline');
  if (online && !isValidPoint({ lat, lng })) throw new HttpError(400, 'Location is required to go online');
  if (online) {
    q.run('UPDATE drivers SET is_online = 1, lat = ?, lng = ?, location_updated_at = ? WHERE user_id = ?', +lat, +lng, nowIso(), req.user.id);
  } else {
    q.run('UPDATE drivers SET is_online = 0 WHERE user_id = ?', req.user.id);
  }
  res.json({
    driver: q.get('SELECT * FROM drivers WHERE user_id = ?', req.user.id),
    requests: online ? rides.openRequestsFor(req.user.id) : [],
  });
});

router.post('/location', (req, res) => {
  rides.updateDriverLocation(req.user.id, req.body || {});
  res.json({ ok: true });
});

router.get('/requests', (req, res) => {
  res.json({ requests: rides.openRequestsFor(req.user.id) });
});

router.post('/rides/:id/accept', (req, res) => {
  res.json({ ride: rides.viewRide(rides.acceptRide(Number(req.params.id), req.user.id), req.user) });
});

router.post('/rides/:id/decline', (req, res) => {
  rides.declineRide(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

router.post('/rides/:id/arrived', (req, res) => {
  res.json({ ride: rides.viewRide(rides.markArrived(Number(req.params.id), req.user.id), req.user) });
});

router.post('/rides/:id/start', (req, res) => {
  res.json({ ride: rides.viewRide(rides.startRide(Number(req.params.id), req.user.id, req.body?.pin), req.user) });
});

router.post('/rides/:id/complete', (req, res) => {
  res.json({ ride: rides.viewRide(rides.completeRide(Number(req.params.id), req.user.id), req.user) });
});

router.patch('/profile', (req, res) => {
  const { vehicle_model, vehicle_number, vehicle_color } = req.body || {};
  q.run(
    `UPDATE drivers SET vehicle_model = COALESCE(?, vehicle_model), vehicle_number = COALESCE(?, vehicle_number),
       vehicle_color = COALESCE(?, vehicle_color) WHERE user_id = ?`,
    vehicle_model || null, vehicle_number ? String(vehicle_number).toUpperCase() : null, vehicle_color || null, req.user.id,
  );
  res.json({ driver: q.get('SELECT * FROM drivers WHERE user_id = ?', req.user.id) });
});

router.get('/earnings', (req, res) => {
  const id = req.user.id;
  const startOf = (days) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - days);
    return d.toISOString();
  };
  const summary = (since) =>
    q.get(
      `SELECT COUNT(CASE WHEN status = 'completed' THEN 1 END) trips,
         COALESCE(SUM(driver_earning), 0) earnings,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN final_fare END), 0) collected,
         COALESCE(SUM(commission), 0) commission,
         COALESCE(SUM(CASE WHEN status = 'completed' AND payment_method = 'cash' THEN final_fare END), 0) cash_collected,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN distance_km END), 0) distance
       FROM rides WHERE driver_id = ? AND driver_earning IS NOT NULL AND COALESCE(completed_at, cancelled_at) >= ?`,
      id, since,
    );
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const from = startOf(i);
    const to = startOf(i - 1);
    const row = q.get(
      `SELECT COALESCE(SUM(driver_earning), 0) earnings, COUNT(CASE WHEN status = 'completed' THEN 1 END) trips FROM rides
       WHERE driver_id = ? AND driver_earning IS NOT NULL AND COALESCE(completed_at, cancelled_at) >= ? AND COALESCE(completed_at, cancelled_at) < ?`,
      id, from, to,
    );
    daily.push({ date: from, ...row });
  }
  const user = q.get('SELECT rating_avg, rating_count FROM users WHERE id = ?', id);
  const recent = q.all(
    `SELECT id, status, vehicle_type, pickup_address, drop_address, distance_km, final_fare, commission, driver_earning,
       payment_method, rating, completed_at, cancelled_at, cancellation_fee
     FROM rides WHERE driver_id = ? AND status IN ('completed','cancelled') ORDER BY COALESCE(completed_at, cancelled_at) DESC LIMIT 30`,
    id,
  );
  res.json({
    today: summary(startOf(0)),
    week: summary(startOf(6)),
    month: summary(startOf(29)),
    allTime: summary('1970-01-01'),
    daily,
    rating: user,
    recent,
  });
});

export default router;
