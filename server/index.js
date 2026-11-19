import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { q } from './db.js';
import { seedIfEmpty } from './seed.js';
import { initRealtime } from './realtime.js';
import * as rides from './rideService.js';
import { relayTyping } from './chat.js';
import { startSimulator, ensureBotsNear } from './sim.js';
import authRoutes from './routes/auth.js';
import rideRoutes from './routes/rides.js';
import driverRoutes from './routes/driver.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';

seedIfEmpty();

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api/me', accountRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', rideRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built frontend in production.
const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()));
}

app.use((err, _req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side' : err.message });
});

const server = http.createServer(app);
initRealtime(server, {
  onDriverLocation: (driverId, p) => rides.updateDriverLocation(driverId, p),
  onChatTyping: (user, p) => relayTyping(user, p),
  onPassengerLocation: (_userId, p) => {
    if (Number.isFinite(+p.lat) && Number.isFinite(+p.lng)) ensureBotsNear({ lat: +p.lat, lng: +p.lng });
  },
});
startSimulator();

// Background jobs: release scheduled rides, expire unanswered requests, drop stale human drivers.
setInterval(() => {
  try {
    rides.releaseScheduledRides();
    rides.expireStaleRequests();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    q.run(
      `UPDATE drivers SET is_online = 0 WHERE is_online = 1 AND status = 'available' AND location_updated_at < ?
       AND user_id IN (SELECT id FROM users WHERE is_bot = 0)`,
      stale,
    );
  } catch (err) {
    console.error('[jobs]', err);
  }
}, 10_000);

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () => console.log(`[server] RideFlow API on http://localhost:${PORT}`));
