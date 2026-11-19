// SQLite persistence using Node's built-in driver (node:sqlite).
// Run Node with --experimental-sqlite on versions where it is still flagged.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || 'server/data');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'rideflow.db');
export const isFreshDb = !fs.existsSync(dbFile);
export const db = new DatabaseSync(dbFile);

db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('passenger','driver','admin')),
  wallet_balance REAL NOT NULL DEFAULT 0,
  rating_avg REAL NOT NULL DEFAULT 5,
  rating_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS drivers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL,
  vehicle_model TEXT,
  vehicle_number TEXT,
  vehicle_color TEXT,
  license_no TEXT,
  is_online INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  lat REAL, lng REAL, heading REAL DEFAULT 0,
  location_updated_at TEXT
);

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  relation TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passenger_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER REFERENCES users(id),
  vehicle_type TEXT NOT NULL,
  status TEXT NOT NULL,
  pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL, pickup_address TEXT,
  drop_lat REAL NOT NULL, drop_lng REAL NOT NULL, drop_address TEXT,
  distance_km REAL, duration_min REAL, route TEXT,
  surge REAL NOT NULL DEFAULT 1,
  est_fare REAL,
  promo_code TEXT,
  discount REAL NOT NULL DEFAULT 0,
  fare_breakdown TEXT,
  final_fare REAL, tax REAL, commission REAL, driver_earning REAL,
  actual_distance_km REAL NOT NULL DEFAULT 0,
  pin TEXT NOT NULL,
  pin_attempts INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  share_token TEXT,
  scheduled_at TEXT, requested_at TEXT, accepted_at TEXT, arrived_at TEXT,
  started_at TEXT, completed_at TEXT, cancelled_at TEXT,
  cancelled_by TEXT, cancel_reason TEXT,
  cancellation_fee REAL NOT NULL DEFAULT 0,
  rating INTEGER, feedback TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_passenger ON rides(passenger_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER REFERENCES rides(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,           -- charge | refund | cancellation_fee | topup
  method TEXT NOT NULL,         -- cash | wallet | card
  amount REAL NOT NULL,
  status TEXT NOT NULL,         -- paid | refunded | failed | due
  txn_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS refund_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER NOT NULL REFERENCES rides(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  amount_requested REAL NOT NULL,
  amount_approved REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  description TEXT,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','flat')),
  value REAL NOT NULL,
  max_discount REAL,
  min_fare REAL NOT NULL DEFAULT 0,
  usage_limit INTEGER,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  vehicle_type TEXT,
  valid_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS promo_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  ride_id INTEGER NOT NULL,
  discount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER REFERENCES rides(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  lat REAL, lng REAL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  status TEXT NOT NULL,         -- sent | logged | failed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

-- in-app chat between the rider and driver of one ride
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_ride ON messages(ride_id, id);
`);

// node:sqlite rejects undefined and booleans — normalise parameters.
const clean = (params) =>
  params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
};

export const q = {
  get: (sql, ...p) => {
    const row = stmt(sql).get(...clean(p));
    return row ? { ...row } : undefined;
  },
  all: (sql, ...p) => stmt(sql).all(...clean(p)).map((r) => ({ ...r })),
  run: (sql, ...p) => stmt(sql).run(...clean(p)),
};

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();




