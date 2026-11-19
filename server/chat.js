// In-app chat between the passenger and driver of a ride.
// Messages are stored with the ride (useful for support and safety reviews) and pushed live
// over Socket.IO. Chat is open from driver assignment until the trip ends; afterwards the
// conversation stays readable but no new messages can be sent.
import { q } from './db.js';
import { HttpError } from './auth.js';
import { emit } from './realtime.js';
import { botReply } from './botChat.js';

export const CHAT_OPEN = ['accepted', 'arrived', 'in_progress'];
export const MAX_LENGTH = 500;
const RATE_WINDOW_MS = 30_000;
const RATE_MAX = 15; // messages per user per window
const sent = new Map(); // userId -> timestamps

function rideFor(rideId, user, { forWrite = false } = {}) {
  const r = q.get(
    `SELECT r.id, r.status, r.passenger_id, r.driver_id, p.name passenger_name, du.name driver_name, du.is_bot driver_is_bot,
       d.vehicle_model, d.vehicle_color, d.vehicle_number
     FROM rides r JOIN users p ON p.id = r.passenger_id
     LEFT JOIN users du ON du.id = r.driver_id LEFT JOIN drivers d ON d.user_id = r.driver_id
     WHERE r.id = ?`,
    Number(rideId),
  );
  if (!r) throw new HttpError(404, 'Ride not found');
  const isParticipant = user.id === r.passenger_id || (r.driver_id && user.id === r.driver_id);
  if (!isParticipant && !(user.role === 'admin' && !forWrite)) throw new HttpError(403, 'You are not part of this ride');
  return r;
}

const otherParty = (r, userId) => (userId === r.passenger_id ? r.driver_id : r.passenger_id);

function view(m, r) {
  return {
    id: m.id,
    ride_id: m.ride_id,
    sender_id: m.sender_id,
    sender_role: m.sender_id === r.passenger_id ? 'passenger' : 'driver',
    body: m.body,
    created_at: m.created_at,
    read_at: m.read_at,
  };
}

export function listMessages(rideId, user) {
  const r = rideFor(rideId, user);
  const rows = q.all('SELECT * FROM messages WHERE ride_id = ? ORDER BY id', r.id);
  return {
    messages: rows.map((m) => view(m, r)),
    canSend: CHAT_OPEN.includes(r.status) && !!r.driver_id && user.role !== 'admin',
    unread: rows.filter((m) => m.sender_id !== user.id && !m.read_at).length,
  };
}

function insertMessage(r, senderId, body) {
  const res = q.run('INSERT INTO messages (ride_id, sender_id, body) VALUES (?, ?, ?)', r.id, senderId, body);
  const msg = view(q.get('SELECT * FROM messages WHERE id = ?', Number(res.lastInsertRowid)), r);
  emit.user(r.passenger_id, 'chat:message', msg);
  if (r.driver_id) emit.user(r.driver_id, 'chat:message', msg);
  return msg;
}

export function sendMessage(rideId, user, rawBody) {
  const r = rideFor(rideId, user, { forWrite: true });
  if (!r.driver_id || !CHAT_OPEN.includes(r.status)) throw new HttpError(409, 'Chat is only available during an active trip');
  const body = String(rawBody ?? '').replace(/\s+/g, ' ').trim();
  if (!body) throw new HttpError(400, 'Message is empty');
  if (body.length > MAX_LENGTH) throw new HttpError(400, `Messages can be at most ${MAX_LENGTH} characters`);

  const now = Date.now();
  const recent = (sent.get(user.id) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) throw new HttpError(429, 'You are sending messages too quickly. Please wait a moment.');
  recent.push(now);
  sent.set(user.id, recent);

  const msg = insertMessage(r, user.id, body);
  if (user.id === r.passenger_id && r.driver_is_bot) scheduleBotReply(r);
  return msg;
}

export function markRead(rideId, user) {
  const r = rideFor(rideId, user);
  if (user.role === 'admin') return { updated: 0 };
  const res = q.run(
    `UPDATE messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ride_id = ? AND sender_id != ? AND read_at IS NULL`,
    r.id, user.id,
  );
  const other = otherParty(r, user.id);
  if (res.changes > 0 && other) emit.user(other, 'chat:read', { rideId: r.id, readerId: user.id, at: new Date().toISOString() });
  return { updated: res.changes };
}

/** Relay a "typing…" indicator to the other participant (socket event, nothing stored). */
export function relayTyping(user, payload) {
  try {
    const r = rideFor(payload?.rideId, user, { forWrite: true });
    if (!CHAT_OPEN.includes(r.status)) return;
    const other = otherParty(r, user.id);
    if (other) emit.user(other, 'chat:typing', { rideId: r.id, from: user.id, typing: !!payload.typing });
  } catch {
    /* ignore bad or unauthorised typing events */
  }
}

// ---------------------------------------------------------------- simulated driver replies
// Bot drivers answer the rider so the chat can be demoed with a single browser.
// A short debounce means a burst of quick messages gets one combined answer.
const pendingReply = new Map(); // rideId -> timer

function botContext(rideId) {
  return q.get(
    `SELECT r.id, r.status, r.passenger_id, r.driver_id, r.vehicle_type, r.payment_method, r.est_fare, r.final_fare, r.distance_km,
       r.pickup_lat, r.pickup_lng, r.pickup_address, r.drop_lat, r.drop_lng, r.drop_address,
       p.name passenger_name, du.name driver_name, d.vehicle_model, d.vehicle_color, d.vehicle_number,
       d.lat driver_lat, d.lng driver_lng
     FROM rides r JOIN users p ON p.id = r.passenger_id
     JOIN users du ON du.id = r.driver_id JOIN drivers d ON d.user_id = r.driver_id
     WHERE r.id = ?`,
    rideId,
  );
}

function scheduleBotReply(r) {
  clearTimeout(pendingReply.get(r.id));
  pendingReply.set(r.id, setTimeout(() => {
    pendingReply.delete(r.id);
    const ctx = botContext(r.id);
    if (!ctx || !CHAT_OPEN.includes(ctx.status)) return;
    // everything the rider said since the bot's last message
    const lastBot = q.get('SELECT MAX(id) id FROM messages WHERE ride_id = ? AND sender_id = ?', r.id, r.driver_id)?.id || 0;
    const unanswered = q.all('SELECT body FROM messages WHERE ride_id = ? AND sender_id = ? AND id > ? ORDER BY id', r.id, r.passenger_id, lastBot);
    if (!unanswered.length) return;
    const text = botReply(ctx, unanswered.map((m) => m.body).join('. '));

    markRead(r.id, { id: r.driver_id, role: 'driver' });
    emit.user(r.passenger_id, 'chat:typing', { rideId: r.id, from: r.driver_id, typing: true });
    const typingMs = Math.min(3200, 900 + text.length * 22);
    setTimeout(() => {
      emit.user(r.passenger_id, 'chat:typing', { rideId: r.id, from: r.driver_id, typing: false });
      const fresh = q.get('SELECT status FROM rides WHERE id = ?', r.id);
      if (!fresh || !CHAT_OPEN.includes(fresh.status)) return;
      insertMessage({ ...r, status: fresh.status }, r.driver_id, text);
    }, typingMs);
  }, 800 + Math.random() * 500));
}
