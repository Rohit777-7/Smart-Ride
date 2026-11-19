import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Banknote, Check, CheckCircle2, Clock3, Route as RouteIcon, Crosshair, KeyRound, LocateFixed, MapPin, Navigation, Phone, Power, Radio, Square, Star, Wallet,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { emitSocket, useSocketConnection, useSocketEvent } from '../../lib/socket.js';
import { useToast } from '../../lib/toast.jsx';
import { getPosition } from '../../lib/geo.js';
import {
  PAYMENT_LABEL, VEHICLE_META, bearing, haversineKm, initials, inr, km, mins, nearestIndex, pathLengthKm, shortAddress,
} from '../../lib/format.js';
import { CarMarker, FitBounds, MapClick, MapRef, MapView, PinMarker, RouteLine } from '../../components/MapView.jsx';
import { Modal, PageLoading, Spinner, StatusBadge, SuccessMark, VehicleArt } from '../../components/ui.jsx';
import { CountUp, Enter3D, useStaggerIn } from '../../lib/motion.jsx';
import { refreshNavStatus, setNavDriverOnline } from '../../lib/navStatus.js';
import RideChat from '../../components/RideChat.jsx';
import { CHAT_OPEN } from '../../lib/chat.js';
import SosButton from '../../components/SosButton.jsx';
import ImmersiveToggle from '../../components/ImmersiveToggle.jsx';

const OFFER_SECONDS = 30;
const SIM_SPEED_MPS = 45; // simulated driving speed (several times real city speed, keeps demos short)
const fmtInr = (n) => inr(n);
const offerDeadline = (r) => Math.min(r.receivedAt + OFFER_SECONDS * 1000, new Date(r.expires_at).getTime());

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.15);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.16);
    });
  } catch {
    /* audio unavailable */
  }
}

export default function DriverHome() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const driver = user.driver || {};
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);
  const [online, setOnline] = useState(!!driver.is_online);
  const [toggling, setToggling] = useState(false);
  const [requests, setRequests] = useState([]);
  const [selected, setSelected] = useState(null);
  const [accepting, setAccepting] = useState(null);
  const [ride, setRide] = useState(null);
  const [navRoute, setNavRoute] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [gps, setGps] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(null);
  const [today, setToday] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [cancelOpen, setCancelOpen] = useState(false);
  const simRef = useRef(null);
  const mapRef = useRef(null);
  const onMapReady = useCallback((m) => {
    mapRef.current = m;
  }, []);

  const loadToday = useCallback(
    () => api('/driver/earnings').then((e) => setToday({ ...e.today, rating: e.rating?.rating_avg })).catch(() => {}),
    [],
  );

  // ------------------------------------------------------------ boot
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ ride: active }, pos] = await Promise.all([api('/rides/active').catch(() => ({ ride: null })), getPosition()]);
      if (!alive) return;
      const stored = driver.lat != null && (driver.is_online || active) ? { lat: driver.lat, lng: driver.lng, heading: driver.heading || 0 } : null;
      setMe(stored || { lat: pos.lat, lng: pos.lng, heading: 0 });
      if (pos.approximate && !stored) toast('Location unavailable — using a default city location. Tap the map to place your vehicle.', 'warning');
      setRide(active);
      if (driver.is_online && !active) api('/driver/requests').then((r) => alive && setRequests(r.requests)).catch(() => {});
      setLoading(false);
    })();
    loadToday();
    return () => {
      alive = false;
      clearInterval(simRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------ location publishing
  const meRef = useRef(me);
  useEffect(() => {
    meRef.current = me;
    if (me && (online || ride)) emitSocket('driver:location', me);
  }, [me, online, ride]);
  useEffect(() => {
    if (!online && !ride) return undefined;
    const t = setInterval(() => meRef.current && emitSocket('driver:location', meRef.current), 15_000);
    return () => clearInterval(t);
  }, [online, ride]);
  useSocketConnection((connected) => {
    if (connected && meRef.current && (online || ride)) emitSocket('driver:location', meRef.current);
  });

  // Real device GPS (useful on a phone actually moving)
  useEffect(() => {
    if (!gps || !('geolocation' in navigator)) return undefined;
    const id = navigator.geolocation.watchPosition(
      (p) => setMe((prev) => ({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        heading: Number.isFinite(p.coords.heading) ? p.coords.heading : prev ? bearing(prev, { lat: p.coords.latitude, lng: p.coords.longitude }) : 0,
      })),
      () => toast('Could not read device GPS', 'error'),
      { enableHighAccuracy: true, maximumAge: 2000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [gps, toast]);

  // countdown tick for offers; expired offers are auto-declined
  const requestsRef = useRef(requests);
  useEffect(() => {
    requestsRef.current = requests;
  });
  useEffect(() => {
    if (!requests.length) return undefined;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      const expired = requestsRef.current.filter((r) => offerDeadline(r) <= n);
      if (!expired.length) return;
      expired.forEach((r) => api(`/driver/rides/${r.id}/decline`, { method: 'POST' }).catch(() => {}));
      const ids = new Set(expired.map((r) => r.id));
      setRequests((rs) => rs.filter((r) => !ids.has(r.id)));
    }, 1000);
    return () => clearInterval(t);
  }, [requests.length]);

  const offers = requests
    .map((r) => ({ ...r, left: Math.max(0, Math.round((offerDeadline(r) - now) / 1000)) }))
    .filter((r) => r.left > 0);

  // ------------------------------------------------------------ socket events
  useSocketEvent('ride:request', (r) => {
    if (ride) return;
    setRequests((rs) => (rs.some((x) => x.id === r.id) ? rs : [{ ...r, receivedAt: Date.now() }, ...rs]));
    beep();
    toast(`${inr(r.est_fare)} · ${km(r.distance_km)} trip`, 'info', 'New ride request');
  });
  useSocketEvent('ride:request_closed', ({ id }) => {
    setRequests((rs) => rs.filter((r) => r.id !== id));
    setSelected((s) => (s === id ? null : s));
  });
  useSocketEvent('ride:update', (r) => {
    if (!ride || r.id !== ride.id) return;
    if (r.status === 'cancelled') {
      stopSim();
      setRide(null);
      setNavRoute(null);
      toast(r.cancelled_by === 'driver' ? 'You cancelled the ride' : `Passenger cancelled${r.cancellation_fee > 0 ? ` · you earn ${inr(r.driver_earning)} cancellation fee` : ''}`, 'warning');
      loadToday();
      return;
    }
    if (r.status === 'requested') return;
    setRide((prev) => ({ ...prev, ...r }));
  });
  useSocketEvent('ride:rated', (r) => toast(`${'★'.repeat(r.rating)}${r.feedback ? ` — ${r.feedback}` : ''}`, 'success', `Ride #${r.rideId} rated`));

  // ------------------------------------------------------------ actions
  async function toggleOnline() {
    if (!me) return;
    setToggling(true);
    try {
      const r = await api('/driver/online', { method: 'POST', body: { online: !online, lat: me.lat, lng: me.lng } });
      setOnline(!!r.driver.is_online);
      setNavDriverOnline(!!r.driver.is_online);
      setRequests((r.requests || []).map((x) => ({ ...x, receivedAt: Date.now() })));
      toast(r.driver.is_online ? 'You are online — requests nearby will appear here' : 'You are offline', r.driver.is_online ? 'success' : 'info');
      refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setToggling(false);
    }
  }

  async function accept(id) {
    setAccepting(id);
    try {
      const { ride: r } = await api(`/driver/rides/${id}/accept`, { method: 'POST' });
      setRide(r);
      setRequests([]);
      setSelected(null);
      setPin('');
      setSummary(null);
      toast(`Head to ${shortAddress(r.pickup_address)}`, 'success', 'Ride accepted');
      loadNav(r, me);
    } catch (e) {
      toast(e.message, 'error');
      setRequests((rs) => rs.filter((x) => x.id !== id));
    } finally {
      setAccepting(null);
    }
  }

  function decline(id) {
    setRequests((rs) => rs.filter((r) => r.id !== id));
    api(`/driver/rides/${id}/decline`, { method: 'POST' }).catch(() => {});
  }

  async function loadNav(r, from) {
    if (!r || !from) return;
    try {
      const nav = await api(`/route?fromLat=${from.lat}&fromLng=${from.lng}&toLat=${r.pickup_lat}&toLng=${r.pickup_lng}`);
      setNavRoute(nav.route);
    } catch {
      setNavRoute(null);
    }
  }
  useEffect(() => {
    if (ride?.status === 'accepted' && !navRoute && me) loadNav(ride, me);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride?.id, ride?.status]);

  function stopSim() {
    clearInterval(simRef.current);
    simRef.current = null;
    setSimulating(false);
  }

  /** Drive the vehicle along a polyline, publishing location every second. */
  function simulate(coords, onDone) {
    if (!coords?.length) return;
    stopSim();
    setGps(false);
    let i = nearestIndex(coords, meRef.current || { lat: coords[0][0], lng: coords[0][1] });
    let pos = meRef.current || { lat: coords[0][0], lng: coords[0][1] };
    setSimulating(true);
    simRef.current = setInterval(() => {
      let remaining = SIM_SPEED_MPS / 1000;
      let heading = pos.heading || 0;
      while (remaining > 0 && i < coords.length - 1) {
        const next = { lat: coords[i + 1][0], lng: coords[i + 1][1] };
        const seg = haversineKm(pos, next);
        if (seg > 0.0005) heading = bearing(pos, next);
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
      pos = { ...pos, heading };
      setMe(pos);
      if (i >= coords.length - 1) {
        stopSim();
        onDone?.();
      }
    }, 1000);
  }

  async function act(path, body, okMsg) {
    setBusy(true);
    try {
      const { ride: r } = await api(`/driver/rides/${ride.id}/${path}`, { method: 'POST', body });
      setRide(r);
      if (okMsg) toast(okMsg, 'success');
      return r;
    } catch (e) {
      toast(e.message, 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function startTrip(e) {
    e.preventDefault();
    const r = await act('start', { pin }, 'PIN verified — trip started');
    if (r) {
      setPin('');
      setNavRoute(null);
    }
  }

  async function complete() {
    const dist = me ? haversineKm(me, { lat: ride.drop_lat, lng: ride.drop_lng }) : 0;
    if (dist > 0.5 && !window.confirm(`You are ${km(dist)} from the drop location. Complete the trip here?`)) return;
    stopSim();
    const r = await act('complete', undefined);
    if (r) {
      setSummary(r);
      setRide(null);
      loadToday();
      refreshNavStatus();
    }
  }

  async function driverCancel(reason) {
    setBusy(true);
    try {
      await api(`/rides/${ride.id}/cancel`, { method: 'POST', body: { reason } });
      stopSim();
      setRide(null);
      setNavRoute(null);
      setCancelOpen(false);
      toast('Ride released to other drivers', 'info');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onMapClick(p) {
    if (ride || simulating) return;
    // Snap the tapped point onto the nearest road so the vehicle never sits in water or on rooftops.
    let target = p;
    try {
      const road = await api(`/geo/snap?lat=${p.lat}&lng=${p.lng}`);
      if (road?.distKm > 0.5) return toast('No road nearby. Tap closer to a street.', 'warning');
      if (Number.isFinite(road?.lat)) target = { lat: road.lat, lng: road.lng };
    } catch {
      /* keep the tapped point */
    }
    setMe((prev) => ({ ...target, heading: prev ? bearing(prev, target) : 0 }));
    if (online) toast('Vehicle moved to the nearest road', 'info');
  }

  // ------------------------------------------------------------ derived
  const sel = offers.find((o) => o.id === selected) || (offers.length && !ride ? offers[0] : null);
  const pickupPt = ride ? { lat: ride.pickup_lat, lng: ride.pickup_lng } : sel?.pickup;
  const dropPt = ride ? { lat: ride.drop_lat, lng: ride.drop_lng } : sel?.drop;
  const remaining =
    ride?.status === 'in_progress' && me && ride.route?.length
      ? [[me.lat, me.lng], ...ride.route.slice(nearestIndex(ride.route, me) + 1)]
      : null;
  const toPickupKm = ride && me && ride.status === 'accepted' ? haversineKm(me, pickupPt) : null;
  const atPickup = toPickupKm != null && toPickupKm < 0.25;

  // 3D motion: panel cascades between trip states (request cards animate themselves via Enter3D).
  const bodyRef = useRef(null);
  useStaggerIn(bodyRef, `${loading}|${ride?.status || 'idle'}|${summary ? 's' : ''}`, { selector: ':scope > :not(.request-card)' });

  let fit = { key: 'me', points: [me] };
  if (!ride && sel) fit = { key: `req-${sel.id}`, points: [me, sel.pickup, sel.drop] };
  if (ride?.status === 'accepted') fit = { key: `acc-${ride.id}`, points: [me, pickupPt] };
  if (ride?.status === 'in_progress') fit = { key: `trip-${ride.id}`, points: [pickupPt, dropPt] };

  if (loading || !me) return <PageLoading />;
  const vtype = driver.vehicle_type || 'mini';

  return (
    <div className="map-screen">
      <MapView center={me} zoom={15}>
        <MapRef onReady={onMapReady} />
        <MapClick onClick={onMapClick} />
        <FitBounds fitKey={fit.key} points={fit.points} />
        {!ride && sel && <RouteLine coords={sel.route} color="#7aa8ff" />}
        {ride?.status === 'accepted' && navRoute && <RouteLine coords={navRoute} />}
        {ride?.status === 'in_progress' && remaining && <RouteLine coords={remaining} />}
        {ride && ride.status !== 'in_progress' && ride.route?.length > 0 && <RouteLine coords={ride.route} color="#6b7280" dashed />}
        {pickupPt && ride?.status !== 'in_progress' && <PinMarker position={pickupPt} kind="pickup" label={ride ? ride.passenger_name : 'Pickup'} />}
        {dropPt && <PinMarker position={dropPt} kind="drop" label="Drop" />}
        <CarMarker position={me} heading={me.heading} type={vtype} zIndexOffset={1000} />
      </MapView>
      <div className="map-vignette" />

      <div className="map-fab">
        <ImmersiveToggle />
        {ride && CHAT_OPEN.includes(ride.status) && <RideChat ride={ride} role="driver" variant="fab" />}
        <button className="icon-btn" aria-label="Center on my vehicle" onClick={() => mapRef.current?.flyTo([me.lat, me.lng], 16)}>
          <LocateFixed size={18} />
        </button>
      </div>

      <div className="panel glass">
        <div className="sheet-handle" />
        <div className="panel-body" ref={bodyRef}>
          {!ride && !summary && renderIdle()}
          {summary && !ride && renderSummary()}
          {ride && renderTrip()}
        </div>
      </div>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Release this ride?">
        <div className="col gap-16">
          <p className="small text-2">The request goes back to nearby drivers and the passenger is matched again. Frequent cancellations can affect your account.</p>
          {['Passenger not reachable', 'Vehicle issue', 'Pickup location unreachable', 'Personal emergency'].map((r) => (
            <button key={r} className="btn btn-ghost btn-block" disabled={busy} onClick={() => driverCancel(r)}>{r}</button>
          ))}
        </div>
      </Modal>
    </div>
  );

  // ------------------------------------------------------------ panels
  function renderIdle() {
    const vName = VEHICLE_META[vtype].name;
    return (
      <>
        <div className="drv-hero">
          <VehicleArt type={vtype} className="drv-hero-photo" zoom={false} />
          <div className="drv-hero-shade" />
          <div className="drv-hero-top">
            <span className={`status-pill ${online ? 'on' : ''}`}><span className="live-dot" /> {online ? 'Online' : 'Offline'}</span>
            <span className="plate">{driver.vehicle_number}</span>
          </div>
          <div className="drv-hero-bottom">
            <div className="tiny drv-hero-sub">{vName}{driver.vehicle_color ? ` · ${driver.vehicle_color}` : ''}</div>
            <div className="drv-hero-title">{driver.vehicle_model || vName}</div>
          </div>
        </div>

        <div className={`go-wrap ${online ? 'on' : ''}`}>
          <button
            type="button"
            className={`go-btn ${online ? 'on' : ''}`}
            onClick={toggleOnline}
            disabled={toggling}
            aria-label={online ? 'Go offline' : 'Go online'}
            aria-pressed={online}
          >
            <span className="go-ring" />
            <span className="go-ring r2" />
            <span className="go-core">{toggling ? <Spinner /> : <><Power size={20} /><b>{online ? 'STOP' : 'GO'}</b></>}</span>
          </button>
          <div className="grow">
            <div className="bold">{online ? "You're online" : "You're offline"}</div>
            <div className="small muted">{online ? `Finding ${vName} trips within 6 km` : 'Tap GO to start receiving ride requests'}</div>
          </div>
        </div>

        <div className="drv-stats">
          <Link to="/driver/earnings" className="drv-stat">
            <span className="drv-stat-label"><Wallet size={13} /> Today</span>
            <CountUp className="drv-stat-value" value={today?.earnings || 0} format={fmtInr} />
          </Link>
          <div className="drv-stat">
            <span className="drv-stat-label"><RouteIcon size={13} /> Trips</span>
            <CountUp className="drv-stat-value" value={today?.trips || 0} />
          </div>
          <div className="drv-stat">
            <span className="drv-stat-label"><Star size={13} /> Rating</span>
            <span className="drv-stat-value">{Number(today?.rating || user.rating_avg || 5).toFixed(2)}</span>
          </div>
        </div>

        {online && offers.length === 0 && (
          <div className="drv-waiting">
            <div className="radar" style={{ width: 84, height: 84, margin: 0 }}>
              <span /><span /><span />
              <div className="core" style={{ inset: 27 }}><Radio size={14} color="#fff" /></div>
            </div>
            <div>
              <div className="bold">Waiting for ride requests…</div>
              <div className="small muted">Requests within 6 km for {vName} appear here instantly.</div>
            </div>
          </div>
        )}

        {online && offers.map((o) => {
          const frac = o.left / OFFER_SECONDS;
          const urgent = o.left <= 10;
          return (
            <Enter3D
              key={o.id}
              className={`request-card ${sel?.id === o.id ? '' : 'dim'}`}
              onClick={() => setSelected(o.id)}
            >
              <div className="rq-head">
                <div className={`rq-ring ${urgent ? 'urgent' : ''}`} aria-label={`${o.left} seconds to accept`}>
                  <svg viewBox="0 0 52 52" width="52" height="52">
                    <circle cx="26" cy="26" r="22" className="rq-ring-track" />
                    <circle cx="26" cy="26" r="22" className="rq-ring-bar" style={{ strokeDashoffset: 138.2 * (1 - frac) }} />
                  </svg>
                  <span>{o.left}s</span>
                </div>
                <div className="grow">
                  <div className="tiny muted">New request · {PAYMENT_LABEL[o.payment_method]}</div>
                  <div className="rq-earn">{inr(o.est_earning)}</div>
                  <div className="tiny muted">
                    You earn · passenger pays {inr(o.est_fare)}
                    {o.discount > 0 ? ' (promo covered by RideFlow)' : ''}
                  </div>
                </div>
                {o.surge > 1 && <span className="badge badge-warning">{o.surge}x</span>}
              </div>
              <div className="rq-metrics">
                <span><Navigation size={13} /> {km(o.pickup_distance_km)} away</span>
                <span><RouteIcon size={13} /> {km(o.distance_km)}</span>
                <span><Clock3 size={13} /> {mins(o.duration_min)}</span>
              </div>
              <div className="route-mini">
                <span className="loc-dot pickup" />
                <span className="small ellipsis">{shortAddress(o.pickup.address)}</span>
                <span className="line" />
                <span />
                <span className="loc-dot drop" />
                <span className="small ellipsis">{shortAddress(o.drop.address)}</span>
              </div>
              <div className="rq-rider">
                <span className="avatar" style={{ width: 30, height: 30, fontSize: '0.72rem' }}>{initials(o.passenger_name)}</span>
                <span className="small bold">{o.passenger_name}</span>
                <span className="tiny muted row gap-4"><Star size={11} fill="#fbbf24" color="#fbbf24" /> {Number(o.passenger_rating || 5).toFixed(1)}</span>
              </div>
              <div className="grid grid-2" style={{ gap: 8 }}>
                <button className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); decline(o.id); }}>Decline</button>
                <button className="btn btn-success" disabled={accepting === o.id} onClick={(e) => { e.stopPropagation(); accept(o.id); }}>
                  {accepting === o.id ? <Spinner /> : 'Accept'}
                </button>
              </div>
            </Enter3D>
          );
        })}

        <div className="drv-settings">
          <label className="row-between check">
            <span className="row gap-8 small"><Crosshair size={16} /> Use live device GPS</span>
            <button type="button" className={`switch ${gps ? 'on' : ''}`} aria-pressed={gps} aria-label="Use live device GPS" onClick={() => setGps((g) => !g)} />
          </label>
          <div className="tiny muted">Testing on a desktop? Tap the map to move your vehicle. Simulated passengers and bot drivers share the same map.</div>
        </div>
      </>
    );
  }

  function renderTrip() {
    const st = ride.status;
    const stepIdx = st === 'accepted' ? 0 : st === 'arrived' ? 1 : 2;
    return (
      <>
        <div className="stepper" aria-label="Trip progress">
          {['Pickup', 'Verify PIN', 'Drop-off'].map((label, i) => (
            <div key={label} className={`step-item ${i < stepIdx ? 'done' : ''} ${i === stepIdx ? 'current' : ''}`}>
              <span className="step-dot">{i < stepIdx ? <Check size={13} /> : i + 1}</span>
              <span className="step-label">{label}</span>
            </div>
          ))}
        </div>
        <div className="row-between">
          <div>
            <h2 className="panel-title">
              {st === 'accepted' ? 'Pick up passenger' : st === 'arrived' ? 'Verify trip PIN' : 'Drop off passenger'}
            </h2>
            <div className="mt-8"><StatusBadge status={st} /></div>
          </div>
          <SosButton rideId={ride.id} compact showContacts={false} getLocation={() => me} />
        </div>

        <div className="card card-tight row" style={{ background: 'var(--surface-2)' }}>
          <div className="avatar avatar-lg">{initials(ride.passenger_name)}</div>
          <div className="grow">
            <div className="bold">{ride.passenger_name}</div>
            <div className="small muted row gap-4"><Star size={12} fill="#fbbf24" color="#fbbf24" /> {Number(ride.passenger_rating || 5).toFixed(1)} · {PAYMENT_LABEL[ride.payment_method]}</div>
          </div>
          <a className="icon-btn" href={`tel:${ride.passenger_phone || ''}`} aria-label="Call passenger"><Phone size={18} /></a>
        </div>

        <div className="route-mini">
          <span className="loc-dot pickup" />
          <span className="small">{shortAddress(ride.pickup_address)}</span>
          <span className="line" />
          <span />
          <span className="loc-dot drop" />
          <span className="small">{shortAddress(ride.drop_address)}</span>
        </div>

        <div className="trip-metrics">
          <div><span>Trip</span><b>{km(ride.distance_km)}</b></div>
          <div><span>Est. fare</span><b>{inr(ride.est_fare)}</b></div>
          <div><span>Payment</span><b>{(PAYMENT_LABEL[ride.payment_method] || '').split(' ')[0]}</b></div>
        </div>

        {st === 'accepted' && (
          <>
            <div className="notice">
              <Navigation size={16} />
              <span>{atPickup ? 'You are at the pickup point.' : `${km(toPickupKm)} to pickup${navRoute ? ` · about ${mins((pathLengthKm(navRoute) / 24) * 60)}` : ''}`}</span>
            </div>
            {!atPickup && (
              simulating ? (
                <button className="btn btn-ghost btn-block" onClick={stopSim}><Square size={16} /> Stop navigation</button>
              ) : (
                <button className="btn btn-block" onClick={() => simulate(navRoute || [[me.lat, me.lng], [ride.pickup_lat, ride.pickup_lng]], () => toast('You have reached the pickup point', 'success'))}>
                  <Navigation size={16} /> Navigate to pickup (simulated)
                </button>
              )
            )}
            <button
              className="btn btn-primary btn-lg btn-block"
              disabled={busy}
              onClick={() => {
                if (toPickupKm > 0.3 && !window.confirm(`You are still ${km(toPickupKm)} from the pickup point. Mark as arrived anyway?`)) return;
                stopSim();
                act('arrived', undefined, 'Passenger notified that you have arrived');
              }}
            >
              <MapPin size={18} /> I've arrived
            </button>
            <button className="btn btn-soft-danger btn-block btn-sm" onClick={() => setCancelOpen(true)}>Cancel ride</button>
          </>
        )}

        {st === 'arrived' && (
          <form className="col gap-16" onSubmit={startTrip}>
            <div className="notice"><KeyRound size={16} /><span>Ask the passenger for their 4-digit trip PIN. The trip can only start with the correct PIN.</span></div>
            <input
              className="input pin-input mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={4}
              placeholder="••••"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              aria-label="Trip PIN"
              autoFocus
            />
            <button className="btn btn-primary btn-lg btn-block" disabled={pin.length !== 4 || busy}>
              {busy ? <Spinner /> : 'Verify PIN & start trip'}
            </button>
            <button type="button" className="btn btn-soft-danger btn-block btn-sm" onClick={() => setCancelOpen(true)}>Passenger didn't show up</button>
          </form>
        )}

        {st === 'in_progress' && (
          <>
            <div className="notice">
              <Navigation size={16} />
              <span>{remaining ? `${km(pathLengthKm(remaining))} to destination` : 'Head to the destination'}</span>
            </div>
            {simulating ? (
              <button className="btn btn-ghost btn-block" onClick={stopSim}><Square size={16} /> Stop navigation</button>
            ) : (
              <button className="btn btn-block" onClick={() => simulate(ride.route, () => toast('Destination reached — complete the trip', 'success'))}>
                <Navigation size={16} /> Drive to destination (simulated)
              </button>
            )}
            <button className="btn btn-success btn-lg btn-block" disabled={busy} onClick={complete}>
              <CheckCircle2 size={18} /> Complete trip
            </button>
          </>
        )}
      </>
    );
  }

  function renderSummary() {
    const s = summary;
    return (
      <>
        <div className="center col gap-4" style={{ alignItems: 'center' }}>
          <SuccessMark />
          <span className="badge badge-success mt-8">Trip completed</span>
          <CountUp className="fare-hero mt-8" value={s.final_fare} format={(n) => inr(n)} />
          <div className="small muted">{PAYMENT_LABEL[s.payment_method]}</div>
        </div>
        {s.payment_method === 'cash' && (
          <div className="notice warning"><Banknote size={16} /><span>Collect <b>{inr(s.final_fare)}</b> in cash from {s.passenger_name}.</span></div>
        )}
        <div className="card card-tight col gap-8" style={{ background: 'var(--surface-2)' }}>
          <div className="row-between small"><span className="muted">Trip fare (before tax)</span><span className="mono">{inr(s.fare_breakdown?.subtotal, 2)}</span></div>
          <div className="row-between small"><span className="muted">Platform commission ({Math.round((s.fare_breakdown?.commissionRate || 0) * 100)}%)</span><span className="mono">−{inr(s.commission, 2)}</span></div>
          {s.discount > 0 && <div className="row-between small"><span className="muted">Promo (paid by platform)</span><span className="mono">{inr(s.discount, 2)}</span></div>}
          <div className="divider" />
          <div className="row-between"><span className="bold">Your earning</span><span className="bold mono" style={{ color: '#86efac' }}>{inr(s.driver_earning, 2)}</span></div>
        </div>
        <button className="btn btn-primary btn-lg btn-block" onClick={() => { setSummary(null); if (online) api('/driver/requests').then((r) => setRequests(r.requests.map((x) => ({ ...x, receivedAt: Date.now() })))).catch(() => {}); }}>
          Find next ride
        </button>
        <Link className="btn btn-ghost btn-block" to={`/receipt/${s.id}`}>View receipt</Link>
      </>
    );
  }
}
