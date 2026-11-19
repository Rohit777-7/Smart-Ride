import { Router } from 'express';
import { q, nowIso } from '../db.js';
import { HttpError, requireAuth } from '../auth.js';
import * as rides from '../rideService.js';
import { VEHICLES } from '../fare.js';
import { emit } from '../realtime.js';

const router = Router();
router.use(requireAuth('admin'));

const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

router.get('/analytics', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const rows = q.all(
    `SELECT r.id, r.status, r.vehicle_type, r.final_fare, r.commission, r.driver_earning, r.discount, r.payment_method,
       r.rating, r.cancelled_by, r.created_at, r.completed_at, r.driver_id, r.cancellation_fee, r.fare_breakdown
     FROM rides r WHERE r.created_at >= ? AND r.status != 'scheduled'`,
    start.toISOString(),
  );

  const daily = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    daily.set(dayKey(d), { date: dayKey(d), rides: 0, completed: 0, cancelled: 0, revenue: 0, commission: 0 });
  }
  const byVehicle = Object.fromEntries(Object.keys(VEHICLES).map((t) => [t, { type: t, rides: 0, completed: 0, revenue: 0 }]));
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, rides: 0 }));
  const byPayment = {};
  const status = {};
  let gmv = 0, commission = 0, discounts = 0, driverPayout = 0, ratingSum = 0, ratingN = 0, completed = 0, cancelled = 0;

  for (const r of rows) {
    const day = daily.get(dayKey(r.created_at));
    status[r.status] = (status[r.status] || 0) + 1;
    byHour[new Date(r.created_at).getHours()].rides++;
    byVehicle[r.vehicle_type].rides++;
    if (day) day.rides++;
    if (r.status === 'completed') {
      completed++;
      gmv += r.final_fare || 0;
      commission += r.commission || 0;
      discounts += r.discount || 0;
      driverPayout += r.driver_earning || 0;
      byVehicle[r.vehicle_type].completed++;
      byVehicle[r.vehicle_type].revenue += r.final_fare || 0;
      byPayment[r.payment_method] = byPayment[r.payment_method] || { method: r.payment_method, rides: 0, amount: 0 };
      byPayment[r.payment_method].rides++;
      byPayment[r.payment_method].amount += r.final_fare || 0;
      if (r.rating > 0) {
        ratingSum += r.rating;
        ratingN++;
      }
      if (day) {
        day.completed++;
        day.revenue += r.final_fare || 0;
        day.commission += r.commission || 0;
      }
    } else if (r.status === 'cancelled' || r.status === 'no_driver') {
      cancelled++;
      commission += r.commission || 0;
      if (day) day.cancelled++;
    }
  }

  const topDrivers = q.all(
    `SELECT u.id, u.name, u.rating_avg, u.is_bot, d.vehicle_type, COUNT(r.id) trips, COALESCE(SUM(r.driver_earning), 0) earnings
     FROM rides r JOIN users u ON u.id = r.driver_id JOIN drivers d ON d.user_id = u.id
     WHERE r.status = 'completed' AND r.created_at >= ?
     GROUP BY u.id ORDER BY earnings DESC LIMIT 8`,
    start.toISOString(),
  );

  const counts = q.get(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE role = 'passenger') passengers,
       (SELECT COUNT(*) FROM users WHERE role = 'driver' AND is_bot = 0) drivers,
       (SELECT COUNT(*) FROM users WHERE role = 'driver' AND is_bot = 1) bot_drivers,
       (SELECT COUNT(*) FROM drivers WHERE is_online = 1) online_drivers,
       (SELECT COUNT(*) FROM rides WHERE status IN ('requested','accepted','arrived','in_progress')) live_rides,
       (SELECT COUNT(*) FROM rides WHERE status = 'scheduled') scheduled_rides,
       (SELECT COUNT(*) FROM sos_alerts WHERE status = 'open') open_sos,
       (SELECT COUNT(*) FROM refund_requests WHERE status = 'pending') pending_refunds,
       (SELECT COALESCE(SUM(amount_approved), 0) FROM refund_requests WHERE status = 'approved' AND resolved_at >= ?) refunded`,
    start.toISOString(),
  );

  const r2 = (n) => Math.round(n * 100) / 100;

  // Same KPIs for the previous window of equal length, for "vs previous period" trend badges.
  const prevStart = new Date(start);
  prevStart.setDate(prevStart.getDate() - days);
  const prev = q.get(
    `SELECT COUNT(*) rides,
       COUNT(CASE WHEN status = 'completed' THEN 1 END) completed,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN final_fare END), 0) gmv,
       COALESCE(SUM(commission), 0) commission,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN discount END), 0) discounts,
       AVG(CASE WHEN status = 'completed' AND rating > 0 THEN rating END) rating
     FROM rides WHERE created_at >= ? AND created_at < ? AND status != 'scheduled'`,
    prevStart.toISOString(), start.toISOString(),
  );
  const previous = {
    totalRides: prev.rides,
    completionRate: prev.rides ? prev.completed / prev.rides : 0,
    gmv: r2(prev.gmv),
    platformNet: r2(prev.commission - prev.discounts),
    avgFare: prev.completed ? r2(prev.gmv / prev.completed) : 0,
    avgRating: prev.rating != null ? r2(prev.rating) : null,
  };

  res.json({
    days,
    previous,
    kpis: {
      totalRides: rows.length,
      completed,
      cancelled,
      completionRate: rows.length ? completed / rows.length : 0,
      gmv: r2(gmv),
      commission: r2(commission),
      platformNet: r2(commission - discounts - counts.refunded),
      discounts: r2(discounts),
      driverPayout: r2(driverPayout),
      avgFare: completed ? r2(gmv / completed) : 0,
      avgRating: ratingN ? r2(ratingSum / ratingN) : null,
      ...counts,
    },
    daily: [...daily.values()].map((d) => ({ ...d, revenue: r2(d.revenue), commission: r2(d.commission) })),
    byVehicle: Object.values(byVehicle).map((v) => ({ ...v, revenue: r2(v.revenue) })),
    byHour,
    byPayment: Object.values(byPayment).map((p) => ({ ...p, amount: r2(p.amount) })),
    status,
    topDrivers,
  });
});

router.get('/live', (_req, res) => {
  const drivers = q.all(
    `SELECT d.user_id id, u.name, u.is_bot, d.vehicle_type, d.status, d.lat, d.lng, d.heading FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE d.is_online = 1 AND d.lat IS NOT NULL`,
  );
  const active = q.all(
    `SELECT r.id, r.status, r.vehicle_type, r.pickup_lat, r.pickup_lng, r.drop_lat, r.drop_lng, r.pickup_address, r.drop_address,
       r.driver_id, p.name passenger_name, du.name driver_name, r.est_fare, r.requested_at
     FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users du ON du.id = r.driver_id
     WHERE r.status IN ('requested','accepted','arrived','in_progress') ORDER BY r.id DESC`,
  );
  res.json({ drivers, rides: active });
});

router.get('/users', (req, res) => {
  const role = ['passenger', 'driver', 'admin'].includes(req.query.role) ? req.query.role : null;
  const search = `%${String(req.query.q || '').trim()}%`;
  const users = q.all(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.wallet_balance, u.rating_avg, u.rating_count, u.is_active, u.is_bot, u.created_at,
       d.vehicle_type, d.vehicle_model, d.vehicle_number, d.is_online, d.status driver_status,
       (SELECT COUNT(*) FROM rides r WHERE (r.passenger_id = u.id OR r.driver_id = u.id) AND r.status = 'completed') trips
     FROM users u LEFT JOIN drivers d ON d.user_id = u.id
     WHERE (? IS NULL OR u.role = ?) AND (u.name LIKE ? OR u.email LIKE ?)
     ORDER BY u.is_bot, u.id DESC LIMIT 300`,
    role, role, search, search,
  );
  res.json({ users });
});

router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'You cannot change your own account here');
  const { is_active } = req.body || {};
  q.run('UPDATE users SET is_active = ? WHERE id = ?', is_active ? 1 : 0, id);
  if (!is_active) {
    q.run('UPDATE drivers SET is_online = 0 WHERE user_id = ?', id);
    emit.user(id, 'notify', { title: 'Account suspended', body: 'Your account was suspended by an administrator.' });
  }
  res.json({ ok: true });
});

router.get('/rides', (req, res) => {
  const status = String(req.query.status || '');
  const list = q.all(
    `SELECT r.id, r.status, r.vehicle_type, r.pickup_address, r.drop_address, r.distance_km, r.est_fare, r.final_fare, r.commission,
       r.driver_earning, r.discount, r.promo_code, r.payment_method, r.payment_status, r.rating, r.surge, r.cancelled_by, r.cancellation_fee,
       r.created_at, r.scheduled_at, r.completed_at, p.name passenger_name, du.name driver_name
     FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users du ON du.id = r.driver_id
     WHERE (? = '' OR r.status = ?) ORDER BY r.id DESC LIMIT 300`,
    status, status,
  );
  res.json({ rides: list });
});

router.post('/rides/:id/cancel', (req, res) => {
  res.json({ ride: rides.cancelRide(Number(req.params.id), req.user, req.body?.reason || 'Cancelled by admin') });
});

router.get('/reports/rides.csv', (req, res) => {
  const list = q.all(
    `SELECT r.id, r.created_at, r.status, r.vehicle_type, p.name passenger, du.name driver, r.pickup_address, r.drop_address,
       r.distance_km, r.surge, r.est_fare, r.discount, r.promo_code, r.final_fare, r.tax, r.commission, r.driver_earning,
       r.cancellation_fee, r.payment_method, r.payment_status, r.rating
     FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users du ON du.id = r.driver_id ORDER BY r.id DESC`,
  );
  const cols = Object.keys(list[0] || { id: 0 });
  const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(','), ...list.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rides-report-${dayKey(new Date())}.csv"`);
  res.send('﻿' + csv);
});

// ---- promo codes
router.get('/promos', (_req, res) => {
  res.json({ promos: q.all('SELECT * FROM promo_codes ORDER BY created_at DESC') });
});

router.post('/promos', (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(code)) throw new HttpError(400, 'Code must be 3–20 letters/numbers');
  if (!['percent', 'flat'].includes(b.discount_type)) throw new HttpError(400, 'Choose percent or flat');
  const value = Number(b.value);
  if (!(value > 0) || (b.discount_type === 'percent' && value > 100)) throw new HttpError(400, 'Invalid discount value');
  if (b.vehicle_type && !VEHICLES[b.vehicle_type]) throw new HttpError(400, 'Invalid vehicle type');
  if (q.get('SELECT code FROM promo_codes WHERE code = ?', code)) throw new HttpError(409, 'Code already exists');
  q.run(
    `INSERT INTO promo_codes (code, description, discount_type, value, max_discount, min_fare, usage_limit, per_user_limit, vehicle_type, valid_until)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    code, b.description || null, b.discount_type, value, b.max_discount ? Number(b.max_discount) : null,
    Number(b.min_fare) || 0, b.usage_limit ? Number(b.usage_limit) : null, Number(b.per_user_limit) || 1,
    b.vehicle_type || null, b.valid_until ? new Date(b.valid_until).toISOString() : null,
  );
  res.status(201).json({ promo: q.get('SELECT * FROM promo_codes WHERE code = ?', code) });
});

router.patch('/promos/:code', (req, res) => {
  q.run('UPDATE promo_codes SET active = ? WHERE code = ?', req.body?.active ? 1 : 0, req.params.code);
  res.json({ promo: q.get('SELECT * FROM promo_codes WHERE code = ?', req.params.code) });
});

// ---- refunds
router.get('/refunds', (_req, res) => {
  res.json({
    refunds: q.all(
      `SELECT rr.*, u.name user_name, r.final_fare, r.cancellation_fee, r.status ride_status, r.pickup_address, r.drop_address, r.payment_method
       FROM refund_requests rr JOIN users u ON u.id = rr.user_id JOIN rides r ON r.id = rr.ride_id ORDER BY rr.status = 'pending' DESC, rr.id DESC`,
    ),
  });
});

router.post('/refunds/:id', (req, res) => {
  const { approve, amount, note } = req.body || {};
  res.json({ refund: rides.resolveRefund(Number(req.params.id), !!approve, amount, note) });
});

// ---- SOS
router.get('/sos', (_req, res) => {
  res.json({
    alerts: q.all(
      `SELECT s.*, u.name user_name, u.phone user_phone, r.status ride_status, r.vehicle_type,
         du.name driver_name, d.vehicle_number
       FROM sos_alerts s JOIN users u ON u.id = s.user_id LEFT JOIN rides r ON r.id = s.ride_id
       LEFT JOIN users du ON du.id = r.driver_id LEFT JOIN drivers d ON d.user_id = r.driver_id
       ORDER BY s.status = 'open' DESC, s.id DESC LIMIT 100`,
    ),
  });
});

router.post('/sos/:id/resolve', (req, res) => {
  const alert = q.get('SELECT * FROM sos_alerts WHERE id = ?', Number(req.params.id));
  if (!alert) throw new HttpError(404, 'Alert not found');
  q.run(`UPDATE sos_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`, nowIso(), alert.id);
  emit.user(alert.user_id, 'notify', { title: 'Safety team update', body: 'Your SOS alert has been reviewed and resolved by our safety team.' });
  res.json({ ok: true });
});

// ---- emails
router.get('/emails', (_req, res) => {
  res.json({ emails: q.all('SELECT * FROM emails ORDER BY id DESC LIMIT 100') });
});

export default router;
