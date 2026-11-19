// Passenger/driver account: profile, wallet (test payments) and emergency contacts.
import { Router } from 'express';
import crypto from 'node:crypto';
import { q, tx } from '../db.js';
import { HttpError, requireAuth } from '../auth.js';
import { profile } from './auth.js';

const router = Router();
router.use(requireAuth());

router.patch('/', (req, res) => {
  const { name, phone } = req.body || {};
  if (name != null && String(name).trim().length < 2) throw new HttpError(400, 'Name is too short');
  q.run('UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?',
    name ? String(name).trim() : null, phone ? String(phone).trim() : null, req.user.id);
  res.json({ user: profile(req.user.id) });
});

router.get('/wallet', (req, res) => {
  const { wallet_balance } = q.get('SELECT wallet_balance FROM users WHERE id = ?', req.user.id);
  const transactions = q.all('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id);
  const dues = q.get(`SELECT COALESCE(SUM(amount), 0) total FROM payments WHERE user_id = ? AND status = 'due'`, req.user.id).total;
  res.json({ balance: wallet_balance, dues, transactions });
});

/**
 * Wallet top-up with simulated test cards:
 *   4242 4242 4242 4242 → success,  4000 0000 0000 0002 → declined. Any future expiry + any 3-digit CVV.
 */
router.post('/wallet/topup', (req, res) => {
  const amount = Math.round(Number(req.body?.amount));
  const card = String(req.body?.cardNumber || '').replace(/\D/g, '');
  const exp = String(req.body?.expiry || '');
  const cvv = String(req.body?.cvv || '');
  if (!(amount >= 50 && amount <= 10000)) throw new HttpError(400, 'Top up between ₹50 and ₹10,000');
  if (card.length !== 16) throw new HttpError(400, 'Enter a 16-digit test card number');
  const m = exp.match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!m || +m[1] < 1 || +m[1] > 12 || new Date(2000 + +m[2], +m[1]) < new Date()) throw new HttpError(400, 'Enter a valid future expiry (MM/YY)');
  if (!/^\d{3}$/.test(cvv)) throw new HttpError(400, 'Enter a 3-digit CVV');
  const txnId = `TEST_TOPUP_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  if (card === '4000000000000002') {
    q.run(`INSERT INTO payments (user_id, type, method, amount, status, txn_id, note) VALUES (?, 'topup', 'card', ?, 'failed', ?, 'Card declined (test card)')`,
      req.user.id, amount, txnId);
    throw new HttpError(402, 'Card declined by the test gateway');
  }
  if (card !== '4242424242424242') throw new HttpError(400, 'Use test card 4242 4242 4242 4242 — real cards are not accepted');
  tx(() => {
    // Settle outstanding dues first.
    let remaining = amount;
    const dues = q.all(`SELECT * FROM payments WHERE user_id = ? AND status = 'due' ORDER BY id`, req.user.id);
    for (const d of dues) {
      if (remaining < d.amount) break;
      remaining -= d.amount;
      q.run(`UPDATE payments SET status = 'paid', note = 'Settled from wallet top-up' WHERE id = ?`, d.id);
      if (d.ride_id) q.run(`UPDATE rides SET payment_status = 'paid' WHERE id = ? AND payment_status = 'due'`, d.ride_id);
    }
    q.run('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', remaining, req.user.id);
    q.run(`INSERT INTO payments (user_id, type, method, amount, status, txn_id, note) VALUES (?, 'topup', 'card', ?, 'paid', ?, ?)`,
      req.user.id, amount, txnId, `Test card •••• ${card.slice(-4)}${remaining < amount ? ` (₹${amount - remaining} settled dues)` : ''}`);
  });
  const { wallet_balance } = q.get('SELECT wallet_balance FROM users WHERE id = ?', req.user.id);
  res.json({ balance: wallet_balance, txnId });
});

router.get('/contacts', (req, res) => {
  res.json({ contacts: q.all('SELECT * FROM emergency_contacts WHERE user_id = ? ORDER BY id', req.user.id) });
});

router.post('/contacts', (req, res) => {
  const { name, phone, email, relation } = req.body || {};
  if (!name || !phone) throw new HttpError(400, 'Name and phone are required');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Invalid email');
  const n = q.get('SELECT COUNT(*) n FROM emergency_contacts WHERE user_id = ?', req.user.id).n;
  if (n >= 5) throw new HttpError(400, 'You can save up to 5 emergency contacts');
  const info = q.run('INSERT INTO emergency_contacts (user_id, name, phone, email, relation) VALUES (?,?,?,?,?)',
    req.user.id, String(name).trim(), String(phone).trim(), email || null, relation || null);
  res.status(201).json({ contact: q.get('SELECT * FROM emergency_contacts WHERE id = ?', Number(info.lastInsertRowid)) });
});

router.delete('/contacts/:id', (req, res) => {
  q.run('DELETE FROM emergency_contacts WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

export default router;
