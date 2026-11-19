// First-run seed: demo accounts, promo codes, simulated bot drivers and some
// historical demo rides so the admin analytics have something to show.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { q, tx } from './db.js';
import { VEHICLES, priceFor, finalize, splitEarnings } from './fare.js';
import { offsetPoint, haversineKm } from './geo.js';

const hash = (p) => bcrypt.hashSync(p, 10);

const BOT_NAMES = [
  'Arjun Mehta', 'Ravi Kumar', 'Suresh Nair', 'Imran Shaikh', 'Vikram Singh',
  'Manoj Yadav', 'Prakash Rao', 'Deepak Joshi', 'Sanjay Patil', 'Farhan Ali',
  'Kiran Reddy', 'Anil Gupta', 'Rahul Verma', 'Naveen Das', 'Ajay Pillai',
  'Harish Gowda', 'Mohit Sharma', 'Gopal Iyer', 'Sameer Khan', 'Tarun Bose',
];
const MODELS = {
  bike: ['Honda Shine', 'Bajaj Pulsar 150', 'TVS Apache', 'Hero Splendor', 'Yamaha FZ'],
  auto: ['Bajaj RE', 'Piaggio Ape', 'TVS King', 'Mahindra Treo', 'Bajaj RE Compact'],
  mini: ['Maruti Swift', 'Hyundai i20', 'Tata Tiago', 'Maruti WagonR', 'Renault Kwid'],
  sedan: ['Honda City', 'Maruti Dzire', 'Hyundai Verna', 'Toyota Etios', 'Skoda Slavia'],
};
const COLORS = ['White', 'Silver', 'Grey', 'Blue', 'Red', 'Black'];
const plate = () =>
  `KA ${String(crypto.randomInt(1, 60)).padStart(2, '0')} ${String.fromCharCode(65 + crypto.randomInt(26))}${String.fromCharCode(65 + crypto.randomInt(26))} ${crypto.randomInt(1000, 9999)}`;

function insertUser(name, email, password, role, extra = {}) {
  const info = q.run(
    'INSERT INTO users (name, email, phone, password_hash, role, wallet_balance, is_bot, rating_avg, rating_count) VALUES (?,?,?,?,?,?,?,?,?)',
    name, email, extra.phone || `+91 9${crypto.randomInt(100000000, 999999999)}`, hash(password), role,
    extra.wallet ?? 0, extra.bot ? 1 : 0, extra.rating ?? 5, extra.ratingCount ?? 0,
  );
  return Number(info.lastInsertRowid);
}

export function seedIfEmpty() {
  const count = q.get('SELECT COUNT(*) n FROM users').n;
  if (count > 0) return false;

  tx(() => {
    insertUser('Platform Admin', 'admin@rideflow.app', 'admin123', 'admin');
    const rider = insertUser('Demo Rider', 'rider@rideflow.app', 'rider123', 'passenger', { wallet: 500, phone: '+91 9876543210' });
    q.run('INSERT INTO emergency_contacts (user_id, name, phone, email, relation) VALUES (?,?,?,?,?)',
      rider, 'Asha (Sister)', '+91 9123456780', 'asha@example.com', 'Sister');
    const driver = insertUser('Demo Driver', 'driver@rideflow.app', 'driver123', 'driver', { phone: '+91 9988776655', rating: 4.8, ratingCount: 12 });
    q.run('INSERT INTO drivers (user_id, vehicle_type, vehicle_model, vehicle_number, vehicle_color, license_no) VALUES (?,?,?,?,?,?)',
      driver, 'mini', 'Maruti Swift', 'KA 05 MJ 2468', 'White', 'KA0520190012345');

    const types = Object.keys(VEHICLES);
    BOT_NAMES.forEach((name, i) => {
      const type = types[i % types.length];
      const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
      const id = insertUser(name, `${slug}.bot@rideflow.app`, crypto.randomBytes(12).toString('hex'), 'driver', {
        bot: true, rating: +(4.4 + Math.random() * 0.6).toFixed(2), ratingCount: crypto.randomInt(40, 900),
      });
      q.run('INSERT INTO drivers (user_id, vehicle_type, vehicle_model, vehicle_number, vehicle_color, license_no) VALUES (?,?,?,?,?,?)',
        id, type, MODELS[type][Math.floor(i / types.length) % 5], plate(), COLORS[i % COLORS.length], `SIM${100000 + i}`);
    });

    const promos = [
      ['WELCOME50', '50% off your first ride (up to ₹100)', 'percent', 50, 100, 0, null, 1, null],
      ['FLAT30', '₹30 off on rides above ₹150', 'flat', 30, null, 150, 1000, 3, null],
      ['BIKE20', '20% off bike rides (up to ₹40)', 'percent', 20, 40, 0, null, 5, 'bike'],
      ['SEDAN100', '₹100 off Sedan rides above ₹400', 'flat', 100, null, 400, 200, 2, 'sedan'],
    ];
    for (const p of promos) {
      q.run(
        'INSERT INTO promo_codes (code, description, discount_type, value, max_discount, min_fare, usage_limit, per_user_limit, vehicle_type) VALUES (?,?,?,?,?,?,?,?,?)',
        ...p,
      );
    }
  });
  seedHistory();
  console.log('[seed] demo accounts created: rider@rideflow.app / rider123, driver@rideflow.app / driver123, admin@rideflow.app / admin123');
  return true;
}

/** ~30 days of completed/cancelled demo rides (Bengaluru) for analytics. */
function seedHistory() {
  const center = { lat: 12.9716, lng: 77.5946 };
  const passengers = [];
  const riderNames = ['Neha Kapoor', 'Rohan Das', 'Priya Menon', 'Karthik S', 'Aisha Khan', 'Vivek Jain'];
  for (const n of riderNames) {
    passengers.push(insertUser(n, `${n.toLowerCase().replace(/[^a-z]+/g, '.')}@demo.rideflow.app`, crypto.randomBytes(8).toString('hex'), 'passenger'));
  }
  passengers.push(q.get(`SELECT id FROM users WHERE email = 'rider@rideflow.app'`).id);
  const drivers = q.all('SELECT user_id id, vehicle_type FROM drivers');
  const places = ['Indiranagar', 'Koramangala', 'MG Road', 'Whitefield', 'HSR Layout', 'Jayanagar', 'Hebbal', 'Electronic City', 'Malleshwaram', 'BTM Layout'];
  const weights = { bike: 0.3, auto: 0.3, mini: 0.25, sedan: 0.15 };
  const pickType = () => {
    let r = Math.random();
    for (const [t, w] of Object.entries(weights)) if ((r -= w) <= 0) return t;
    return 'mini';
  };
  // Busier mornings/evenings.
  const hourWeights = [1, 0.5, 0.3, 0.3, 0.4, 1, 2, 4, 6, 6, 4, 3, 3, 3, 3, 3, 4, 6, 7, 7, 5, 4, 3, 2];
  const pickHour = () => {
    const total = hourWeights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let h = 0; h < 24; h++) if ((r -= hourWeights[h]) <= 0) return h;
    return 18;
  };

  tx(() => {
    for (let day = 30; day >= 1; day--) {
      const n = 4 + Math.floor(Math.random() * 6) + Math.floor((30 - day) / 6);
      for (let k = 0; k < n; k++) {
        const type = pickType();
        const driver = drivers.filter((d) => d.vehicle_type === type)[Math.floor(Math.random() * 6) % 6] ||
          drivers.find((d) => d.vehicle_type === type);
        const passenger = passengers[Math.floor(Math.random() * passengers.length)];
        const pickup = offsetPoint(center, Math.random() * 6, Math.random() * 360);
        const drop = offsetPoint(pickup, 1.5 + Math.random() * 10, Math.random() * 360);
        const dist = haversineKm(pickup, drop) * 1.3;
        const dur = (dist / 22) * 60;
        const start = new Date();
        start.setDate(start.getDate() - day);
        start.setHours(pickHour(), Math.floor(Math.random() * 60), 0, 0);
        const surge = Math.random() < 0.25 ? 1.2 + Math.round(Math.random() * 5) / 10 : 1;
        const fin = finalize(priceFor(type, dist, dur, surge), 0);
        const split = splitEarnings(type, fin.subtotal, 0);
        const cancelled = Math.random() < 0.12;
        const method = ['cash', 'wallet', 'card'][Math.floor(Math.random() * 3)];
        const iso = (d) => new Date(d).toISOString();
        const t0 = start.getTime();
        const pA = places[Math.floor(Math.random() * places.length)];
        let pB = places[Math.floor(Math.random() * places.length)];
        if (pB === pA) pB = places[(places.indexOf(pA) + 3) % places.length];
        const info = q.run(
          `INSERT INTO rides (passenger_id, driver_id, vehicle_type, status, pickup_lat, pickup_lng, pickup_address, drop_lat, drop_lng, drop_address,
            distance_km, duration_min, route, surge, est_fare, fare_breakdown, final_fare, tax, commission, driver_earning, pin, payment_method,
            payment_status, requested_at, accepted_at, arrived_at, started_at, completed_at, cancelled_at, cancelled_by, cancel_reason, rating, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          passenger, cancelled ? null : driver.id, type, cancelled ? 'cancelled' : 'completed',
          pickup.lat, pickup.lng, `${pA}, Bengaluru`, drop.lat, drop.lng, `${pB}, Bengaluru`,
          +dist.toFixed(2), +dur.toFixed(1), '[]', surge, fin.total,
          JSON.stringify({ ...fin, commissionRate: split.rate, platformNet: split.platformNet }),
          cancelled ? null : fin.total, cancelled ? null : fin.tax, cancelled ? null : split.commission, cancelled ? null : split.driverEarning,
          String(crypto.randomInt(0, 10000)).padStart(4, '0'), method, cancelled ? 'none' : 'paid',
          iso(t0), cancelled ? null : iso(t0 + 60_000), cancelled ? null : iso(t0 + 300_000), cancelled ? null : iso(t0 + 360_000),
          cancelled ? null : iso(t0 + 360_000 + dur * 60_000), cancelled ? iso(t0 + 90_000) : null,
          cancelled ? 'passenger' : null, cancelled ? 'Changed plans' : null,
          cancelled ? null : Math.random() < 0.8 ? [5, 5, 5, 4, 4, 3][Math.floor(Math.random() * 6)] : null,
          iso(t0),
        );
        if (!cancelled) {
          q.run(`INSERT INTO payments (ride_id, user_id, type, method, amount, status, txn_id, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
            Number(info.lastInsertRowid), passenger, 'charge', method, fin.total, 'paid',
            `DEMO_${crypto.randomBytes(5).toString('hex').toUpperCase()}`, 'Seeded demo history', iso(t0 + 360_000 + dur * 60_000));
        }
      }
    }
  });
}
