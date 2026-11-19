import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../db.js';
import { HttpError, publicUser, requireAuth, signToken } from '../auth.js';
import { isVehicleType } from '../fare.js';
import { mail } from '../mailer.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function profile(userId) {
  const user = publicUser(q.get('SELECT * FROM users WHERE id = ?', userId));
  if (user?.role === 'driver') {
    user.driver = q.get('SELECT * FROM drivers WHERE user_id = ?', userId);
  }
  return user;
}

router.post('/signup', async (req, res) => {
  const { name, email, phone, password, role = 'passenger', vehicle = {} } = req.body || {};
  if (!name || String(name).trim().length < 2) throw new HttpError(400, 'Please enter your full name');
  if (!EMAIL_RE.test(String(email || ''))) throw new HttpError(400, 'Please enter a valid email');
  if (!password || String(password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  if (!['passenger', 'driver'].includes(role)) throw new HttpError(400, 'Invalid account type');
  if (phone && !/^[+\d][\d\s-]{7,16}$/.test(String(phone))) throw new HttpError(400, 'Please enter a valid phone number');
  if (role === 'driver') {
    if (!isVehicleType(vehicle.type)) throw new HttpError(400, 'Choose your vehicle category');
    if (!vehicle.model || !vehicle.number || !vehicle.license) throw new HttpError(400, 'Vehicle model, number and licence are required');
  }
  const exists = q.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', String(email).trim());
  if (exists) throw new HttpError(409, 'An account with this email already exists');

  const hash = await bcrypt.hash(String(password), 10);
  const info = q.run(
    'INSERT INTO users (name, email, phone, password_hash, role, wallet_balance) VALUES (?,?,?,?,?,?)',
    String(name).trim(), String(email).trim().toLowerCase(), phone ? String(phone).trim() : null, hash, role,
    role === 'passenger' ? 200 : 0, // welcome wallet credit (test money)
  );
  const id = Number(info.lastInsertRowid);
  if (role === 'driver') {
    q.run(
      'INSERT INTO drivers (user_id, vehicle_type, vehicle_model, vehicle_number, vehicle_color, license_no) VALUES (?,?,?,?,?,?)',
      id, vehicle.type, String(vehicle.model).trim(), String(vehicle.number).trim().toUpperCase(),
      vehicle.color ? String(vehicle.color).trim() : null, String(vehicle.license).trim().toUpperCase(),
    );
  }
  if (role === 'passenger') {
    q.run(`INSERT INTO payments (user_id, type, method, amount, status, txn_id, note) VALUES (?, 'topup', 'wallet', 200, 'paid', ?, 'Welcome credit')`,
      id, `WELCOME_${id}`);
  }
  const user = profile(id);
  mail.welcome(user);
  res.status(201).json({ token: signToken(user), user });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const row = q.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', String(email || '').trim());
  const ok = row && !row.is_bot && (await bcrypt.compare(String(password || ''), row.password_hash));
  if (!ok) throw new HttpError(401, 'Incorrect email or password');
  if (!row.is_active) throw new HttpError(403, 'Your account has been suspended. Contact support.');
  res.json({ token: signToken(row), user: profile(row.id) });
});

router.get('/me', requireAuth(), (req, res) => {
  res.json({ user: profile(req.user.id) });
});

export default router;
