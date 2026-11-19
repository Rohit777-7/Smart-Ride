// Email notifications. Sends through SMTP when SMTP_HOST is configured; otherwise every
// email is stored in the `emails` table (viewable in Admin → Emails) and logged to the console.
import nodemailer from 'nodemailer';
import { q } from './db.js';

const FROM = process.env.MAIL_FROM || 'RideFlow <no-reply@rideflow.local>';
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

const inr = (n) => `₹${Number(n || 0).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function layout(title, body) {
  return `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#0b0f1a;padding:24px;color:#e8ecf5">
  <div style="max-width:520px;margin:auto;background:#141a29;border-radius:16px;padding:24px;border:1px solid #232b3f">
    <div style="font-weight:800;font-size:20px;color:#3b8cff;margin-bottom:12px">RideFlow</div>
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${esc(title)}</h2>
    ${body}
    <p style="margin-top:24px;font-size:12px;color:#8b93a7">This is a simulated ride platform for demonstration. No real payments were processed.</p>
  </div></div>`;
}

const row = (k, v) =>
  `<tr><td style="padding:4px 0;color:#8b93a7">${esc(k)}</td><td style="padding:4px 0;text-align:right;color:#e8ecf5">${esc(v)}</td></tr>`;

export async function sendEmail(to, subject, html) {
  if (!to) return;
  const info = q.run(
    'INSERT INTO emails (to_email, subject, html, status) VALUES (?, ?, ?, ?)',
    to, subject, html, transporter ? 'queued' : 'logged',
  );
  const id = Number(info.lastInsertRowid);
  if (!transporter) {
    console.log(`[mail] (logged) to=${to} subject="${subject}"`);
    return;
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, html });
    q.run("UPDATE emails SET status = 'sent' WHERE id = ?", id);
  } catch (err) {
    q.run("UPDATE emails SET status = 'failed', error = ? WHERE id = ?", String(err.message), id);
    console.warn('[mail] failed', err.message);
  }
}

const fire = (p) => p.catch((e) => console.warn('[mail]', e.message));

export const mail = {
  welcome(user) {
    fire(sendEmail(user.email, 'Welcome to RideFlow', layout(`Welcome, ${user.name}!`,
      `<p>Your ${user.role} account is ready. ${user.role === 'driver'
        ? 'Go online from the driver dashboard to start receiving ride requests.'
        : 'Open the app, choose a destination and book your first ride.'}</p>`)));
  },
  rideScheduled(user, ride) {
    fire(sendEmail(user.email, `Ride #${ride.id} scheduled`, layout('Your ride is scheduled',
      `<table style="width:100%;font-size:14px">${row('Pickup time', new Date(ride.scheduled_at).toLocaleString('en-IN'))}
      ${row('From', ride.pickup_address)}${row('To', ride.drop_address)}${row('Estimated fare', inr(ride.est_fare))}</table>
      <p>We'll start looking for a driver a few minutes before pickup.</p>`)));
  },
  driverAssigned(user, ride, driver) {
    fire(sendEmail(user.email, `Driver assigned for ride #${ride.id}`, layout(`${driver.name} is on the way`,
      `<table style="width:100%;font-size:14px">${row('Vehicle', `${driver.vehicle_color || ''} ${driver.vehicle_model || ''}`.trim())}
      ${row('Number', driver.vehicle_number)}${row('Trip PIN', ride.pin)}</table>
      <p>Share the PIN with your driver only after you're inside the vehicle.</p>`)));
  },
  receipt(user, ride) {
    const b = ride.fare_breakdown || {};
    fire(sendEmail(user.email, `Receipt for ride #${ride.id} — ${inr(ride.final_fare)}`, layout('Thanks for riding with RideFlow',
      `<table style="width:100%;font-size:14px">
      ${row('From', ride.pickup_address)}${row('To', ride.drop_address)}
      ${row('Distance', `${(b.distanceKm ?? 0).toFixed(1)} km`)}${row('Base fare', inr(b.base))}
      ${row('Distance fare', inr(b.distanceFare))}${row('Time fare', inr(b.timeFare))}
      ${b.surgeAmount ? row(`Surge (${b.surge}x)`, inr(b.surgeAmount)) : ''}
      ${b.discount ? row(`Promo ${ride.promo_code || ''}`, `- ${inr(b.discount)}`) : ''}
      ${row('Taxes (5%)', inr(b.tax))}
      <tr><td style="padding-top:8px;font-weight:700">Total</td><td style="padding-top:8px;text-align:right;font-weight:700">${inr(ride.final_fare)}</td></tr>
      ${row('Paid via', ride.payment_method)}</table>`)));
  },
  cancelled(user, ride, by, fee) {
    fire(sendEmail(user.email, `Ride #${ride.id} cancelled`, layout('Ride cancelled',
      `<p>Your ride from ${esc(ride.pickup_address)} was cancelled by the ${esc(by)}.</p>
      ${fee > 0 ? `<p>A cancellation fee of <b>${inr(fee)}</b> was applied.</p>` : '<p>No cancellation fee was charged.</p>'}`)));
  },
  refund(user, ride, request) {
    fire(sendEmail(user.email, `Refund ${request.status} for ride #${ride.id}`, layout(`Refund ${request.status}`,
      request.status === 'approved'
        ? `<p>${inr(request.amount_approved)} has been credited to your RideFlow wallet.</p>`
        : `<p>Your refund request was not approved.${request.admin_note ? ` Note: ${esc(request.admin_note)}` : ''}</p>`)));
  },
  sos(contact, user, ride, alert) {
    if (!contact.email) return;
    const maps = `https://www.openstreetmap.org/?mlat=${alert.lat}&mlon=${alert.lng}#map=17/${alert.lat}/${alert.lng}`;
    fire(sendEmail(contact.email, `EMERGENCY: ${user.name} triggered SOS`, layout('Emergency alert',
      `<p><b>${esc(user.name)}</b> pressed the SOS button during a ride${ride ? ` (#${ride.id})` : ''}.</p>
      <p>Last known location: <a style="color:#3b8cff" href="${maps}">${alert.lat?.toFixed(5)}, ${alert.lng?.toFixed(5)}</a></p>
      ${ride?.share_token ? `<p>Live trip link: /track/${esc(ride.share_token)}</p>` : ''}
      <p>If you cannot reach them, call 112.</p>`)));
  },
};
