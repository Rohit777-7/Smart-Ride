import jwt from 'jsonwebtoken';
import { q } from './db.js';

const SECRET = process.env.JWT_SECRET || 'rideflow-dev-secret-change-me';
if (!process.env.JWT_SECRET) console.warn('[auth] JWT_SECRET not set — using a development secret.');

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '7d' });
}

/** Returns the current DB user for a token, or null. */
export function verifyToken(token) {
  if (!token) return null;
  const payload = jwt.verify(token, SECRET);
  const user = q.get('SELECT id, name, email, role, is_active FROM users WHERE id = ?', payload.id);
  if (!user || !user.is_active) return null;
  return user;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function requireAuth(...roles) {
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    let user = null;
    try {
      user = verifyToken(token);
    } catch {
      /* invalid token */
    }
    if (!user) return next(new HttpError(401, 'Please log in again'));
    if (roles.length && !roles.includes(user.role)) return next(new HttpError(403, 'Not allowed for your role'));
    req.user = user;
    next();
  };
}

export function publicUser(u) {
  if (!u) return null;
  const { password_hash: _p, ...rest } = u;
  return rest;
}
