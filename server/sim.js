// Simulated "bot" drivers so the whole ride lifecycle can be demoed with a single browser.
// Bots position themselves around active passengers, accept requests that real drivers
// haven't taken, drive along real road routes, verify the PIN and complete the trip —
// all through the same rideService functions a human driver uses.
import { q } from './db.js';
import { getRoute, haversineKm, offsetPoint, bearing, nearestRoad } from './geo.js';
import { VEHICLES } from './fare.js';
import * as rides from './rideService.js';

export const SIM_ENABLED = process.env.SIM_BOTS !== 'false';
const SPEED_MPS = Number(process.env.SIM_SPEED_MPS || 40); // several times real city speed, keeps demos short
const HUMAN_GRACE_MS = Number(process.env.SIM_HUMAN_GRACE_SECONDS || 20) * 1000;
const TICK_MS = 500;
// Long routes speed up so no demo leg drags on: the drive to pickup and the trip itself each finish
// within these budgets however far apart the points are (short legs keep SPEED_MPS).
const PICKUP_MAX_S = Number(process.env.SIM_PICKUP_MAX_SECONDS || 15);
const TRIP_MAX_S = Number(process.env.SIM_TRIP_MAX_SECONDS || 25);
const BOTS_PER_TYPE_NEARBY = 2;

const driving = new Map(); // botId -> token
const home = new Map(); // botId -> anchor point for idle wandering
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const botRows = (type) =>
  q.all(
    `SELECT d.user_id id, d.lat, d.lng, d.status, d.is_online, d.heading FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE u.is_bot = 1 AND u.is_active = 1 AND d.vehicle_type = ?`,
    type,
  );

const placing = new Set(); // bots currently being snapped onto a road

/**
 * Put a bot on a real road near `point`. Random candidates are snapped with OSRM "nearest";
 * a candidate whose nearest road is far away (sea, lake, park, airport) is rejected.
 */
async function placeBot(id, point) {
  placing.add(id);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cand = offsetPoint(point, 0.5 + Math.random() * 2, Math.random() * 360);
      const road = await nearestRoad(cand);
      if (!road) break; // routing service down — leave the bot offline rather than guess
      if (road.distKm <= 0.25 && haversineKm(point, road) <= 3.2) {
        home.set(id, point);
        q.run('UPDATE drivers SET lat = ?, lng = ?, heading = ?, is_online = 1 WHERE user_id = ?', road.lat, road.lng, Math.random() * 360, id);
        return;
      }
    }
    const road = await nearestRoad(point); // fallback: the road closest to the passenger
    if (road && road.distKm <= 0.5) {
      home.set(id, point);
      q.run('UPDATE drivers SET lat = ?, lng = ?, heading = ?, is_online = 1 WHERE user_id = ?', road.lat, road.lng, Math.random() * 360, id);
    }
  } finally {
    placing.delete(id);
  }
}

/** Make sure a couple of free bots of every category are within ~3 km of `point`, on real roads. */
export function ensureBotsNear(point) {
  if (!SIM_ENABLED || !point) return;
  for (const type of Object.keys(VEHICLES)) {
    const bots = botRows(type);
    const nearIds = new Set(bots.filter((b) => b.is_online && b.lat != null && haversineKm(point, b) <= 3).map((b) => b.id));
    const nearFree = bots.filter((b) => nearIds.has(b.id) && b.status === 'available').length;
    const pending = bots.filter((b) => placing.has(b.id)).length;
    let need = BOTS_PER_TYPE_NEARBY - nearFree - pending;
    if (need <= 0) continue;
    const spare = bots.filter((b) => b.status === 'available' && !driving.has(b.id) && !nearIds.has(b.id) && !placing.has(b.id));
    for (const b of spare) {
      if (need-- <= 0) break;
      cruise.delete(b.id);
      placeBot(b.id, point).catch((e) => console.warn('[sim] place', e.message));
    }
  }
}

// ---------------------------------------------------------------- idle cruising on real roads

const CRUISE_MPS = 9; // ~32 km/h, a believable city speed for idle cars
const CRUISE_TICK_MS = 1500;
const MAX_ROUTE_FETCHES_PER_TICK = 3;
const cruise = new Map(); // botId -> { coords, i, pos } | { pending: true } | { idleUntil }

async function startCruise(b) {
  cruise.set(b.id, { pending: true });
  const anchor = home.get(b.id);
  // Head somewhere 0.6–1.6 km away; drift back towards the passenger area if the bot strayed.
  const dir = anchor && haversineKm(anchor, b) > 2.2 ? bearing(b, anchor) : Math.random() * 360;
  const target = offsetPoint(b, 0.6 + Math.random(), dir);
  try {
    const route = await getRoute(b, target, { background: true });
    if (route.source !== 'osrm' || route.coords.length < 2) {
      cruise.set(b.id, { idleUntil: Date.now() + 30_000 }); // no real road route: park instead of crossing water
      return;
    }
    const [lat, lng] = route.coords[0];
    cruise.set(b.id, { coords: route.coords, i: 0, pos: { lat, lng } });
  } catch {
    cruise.set(b.id, { idleUntil: Date.now() + 30_000 });
  }
}

/** Idle bots cruise along real road routes so the passenger map looks alive (and never shows cars in the sea). */
function cruiseTick() {
  const bots = q.all(
    `SELECT d.user_id id, d.lat, d.lng, d.heading FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE u.is_bot = 1 AND d.is_online = 1 AND d.status = 'available' AND d.lat IS NOT NULL`,
  );
  let fetches = 0;
  for (const b of bots) {
    if (driving.has(b.id) || placing.has(b.id)) continue;
    const st = cruise.get(b.id);
    if (!st) {
      if (fetches++ < MAX_ROUTE_FETCHES_PER_TICK) startCruise(b);
      continue;
    }
    if (st.pending) continue;
    if (st.idleUntil) {
      if (Date.now() > st.idleUntil) cruise.delete(b.id);
      continue;
    }
    let remaining = (CRUISE_MPS * CRUISE_TICK_MS) / 1000 / 1000; // km this tick
    let heading = b.heading || 0;
    while (remaining > 0 && st.i < st.coords.length - 1) {
      const next = { lat: st.coords[st.i + 1][0], lng: st.coords[st.i + 1][1] };
      const seg = haversineKm(st.pos, next);
      if (seg > 0.001) heading = bearing(st.pos, next);
      if (seg <= remaining) {
        remaining -= seg;
        st.pos = next;
        st.i++;
      } else {
        const f = remaining / seg;
        st.pos = { lat: st.pos.lat + (next.lat - st.pos.lat) * f, lng: st.pos.lng + (next.lng - st.pos.lng) * f };
        remaining = 0;
      }
    }
    q.run('UPDATE drivers SET lat = ?, lng = ?, heading = ? WHERE user_id = ? AND status = ?', st.pos.lat, st.pos.lng, heading, b.id, 'available');
    // Reached the end of this leg: short pause (like waiting at a stand), then pick a new one.
    if (st.i >= st.coords.length - 1) cruise.set(b.id, { idleUntil: Date.now() + 2000 + Math.random() * 8000 });
  }
}

/** Move a bot along a polyline, pushing live location each tick. Resolves false if aborted. */
async function follow(botId, coords, stillValid, maxSeconds = TRIP_MAX_S) {
  if (!coords?.length) return true;
  let lengthKm = 0;
  for (let k = 1; k < coords.length; k++) lengthKm += haversineKm({ lat: coords[k - 1][0], lng: coords[k - 1][1] }, { lat: coords[k][0], lng: coords[k][1] });
  const speedMps = Math.max(SPEED_MPS, (lengthKm * 1000) / maxSeconds);
  let i = 0;
  let pos = { lat: coords[0][0], lng: coords[0][1] };
  const step = (speedMps * TICK_MS) / 1000 / 1000; // km per tick
  while (i < coords.length - 1) {
    await sleep(TICK_MS);
    if (!stillValid()) return false;
    let remaining = step;
    let heading = 0;
    while (remaining > 0 && i < coords.length - 1) {
      const next = { lat: coords[i + 1][0], lng: coords[i + 1][1] };
      const seg = haversineKm(pos, next);
      heading = bearing(pos, next) || heading;
      if (seg <= remaining) {
        remaining -= seg;
        pos = next;
        i++;
      } else {
        const f = remaining / seg;
        pos = { lat: pos.lat + (next.lat - pos.lat) * f, lng: pos.lng + (next.lng - pos.lng) * f };
        remaining = 0;
      }
    }
    rides.updateDriverLocation(botId, { ...pos, heading });
  }
  return true;
}

const status = (rideId) => q.get('SELECT status FROM rides WHERE id = ?', rideId)?.status;
const position = (botId) => q.get('SELECT lat, lng FROM drivers WHERE user_id = ?', botId);

async function drive(botId, rideId) {
  if (driving.has(botId)) return;
  driving.set(botId, true);
  cruise.delete(botId);
  try {
    let r = rides.loadRide(rideId);
    if (r?.status === 'accepted') {
      const route = await getRoute(position(botId), { lat: r.pickup_lat, lng: r.pickup_lng }, { background: true });
      const ok = await follow(botId, route.coords, () => status(rideId) === 'accepted', PICKUP_MAX_S);
      if (!ok) return;
      rides.markArrived(rideId, botId);
    }
    r = rides.loadRide(rideId);
    if (r?.status === 'arrived') {
      await sleep(4000); // passenger walks to the vehicle and shares the PIN
      if (status(rideId) !== 'arrived') return;
      rides.startRide(rideId, botId, r.pin);
    }
    r = rides.loadRide(rideId);
    if (r?.status === 'in_progress') {
      const here = position(botId);
      const fresh = haversineKm(here, { lat: r.pickup_lat, lng: r.pickup_lng }) < 0.1;
      const coords = fresh && r.route.length ? r.route : (await getRoute(here, { lat: r.drop_lat, lng: r.drop_lng }, { background: true })).coords;
      const ok = await follow(botId, coords, () => status(rideId) === 'in_progress');
      if (!ok) return;
      await sleep(1500);
      rides.completeRide(rideId, botId);
    }
  } catch (err) {
    console.warn(`[sim] bot ${botId} ride ${rideId}:`, err.message);
  } finally {
    driving.delete(botId);
  }
}

async function tryBotAccept(rideId, attempt = 0) {
  const r = rides.loadRide(rideId);
  if (!r || r.status !== 'requested') return;
  const bot = rides.eligibleDrivers(r).find((d) => d.is_bot && !driving.has(d.user_id));
  if (!bot) {
    if (attempt < 3) {
      ensureBotsNear({ lat: r.pickup_lat, lng: r.pickup_lng });
      setTimeout(() => tryBotAccept(rideId, attempt + 1), 4000);
    }
    return;
  }
  try {
    rides.acceptRide(rideId, bot.user_id);
    drive(bot.user_id, rideId);
  } catch (err) {
    if (err.status !== 409) console.warn('[sim] accept failed', err.message);
  }
}

export function startSimulator() {
  if (!SIM_ENABLED) {
    console.log('[sim] bot drivers disabled (SIM_BOTS=false)');
    return;
  }
  rides.hooks.onRequested = (ride, drivers) => {
    ensureBotsNear({ lat: ride.pickup_lat, lng: ride.pickup_lng });
    const humans = drivers.filter((d) => !d.is_bot).length;
    const delay = (humans ? HUMAN_GRACE_MS : 0) + 2000 + Math.random() * 2000;
    setTimeout(() => tryBotAccept(ride.id), delay);
  };
  setInterval(cruiseTick, CRUISE_TICK_MS);

  // Resume trips that were in flight when the server restarted.
  const inflight = q.all(
    `SELECT r.id, r.driver_id, r.status FROM rides r JOIN users u ON u.id = r.driver_id
     WHERE u.is_bot = 1 AND r.status IN ('accepted','arrived','in_progress')`,
  );
  for (const r of inflight) drive(r.driver_id, r.id);
  const waiting = q.all(`SELECT id FROM rides WHERE status = 'requested'`);
  for (const r of waiting) setTimeout(() => tryBotAccept(r.id), 8000);
  console.log(`[sim] bot drivers enabled — speed ${SPEED_MPS} m/s (pickup ≤${PICKUP_MAX_S}s, trip ≤${TRIP_MAX_S}s), resumed ${inflight.length} trip(s)`);
}
