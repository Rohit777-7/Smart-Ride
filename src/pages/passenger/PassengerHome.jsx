import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, BadgePercent, Banknote, CalendarClock, Clock, CreditCard, Crosshair, History, LocateFixed, MapPin,
  MessageSquare, Phone, Receipt, Search, Share2, Star, Tag, Users, Wallet, X, Zap,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { emitSocket, useSocketEvent } from '../../lib/socket.js';
import { useToast } from '../../lib/toast.jsx';
import { getPosition } from '../../lib/geo.js';
import {
  PAYMENT_LABEL, VEHICLE_META, dateTime, haversineKm, initials, inr, km, mins, nearestIndex, pathLengthKm, shortAddress,
} from '../../lib/format.js';
import { CarMarker, FitBounds, MapClick, MapRef, MapView, MeMarker, PinMarker, RouteLine } from '../../components/MapView.jsx';
import { Modal, PageLoading, RatingStars, Spinner, StatusBadge, SuccessMark, VehicleArt } from '../../components/ui.jsx';
import { CountUp, useStaggerIn } from '../../lib/motion.jsx';
import SosButton from '../../components/SosButton.jsx';
import RideChat from '../../components/RideChat.jsx';
import { CHAT_OPEN } from '../../lib/chat.js';
import ImmersiveToggle from '../../components/ImmersiveToggle.jsx';

const ACTIVE = ['requested', 'accepted', 'arrived', 'in_progress'];
const CANCEL_FEE = { bike: 20, auto: 25, mini: 40, sedan: 50 };
const CANCEL_REASONS = ['Driver is too far', 'Changed my plans', 'Booked by mistake', 'Found another ride', 'Driver asked me to cancel'];
const RATING_TAGS = ['Great driving', 'Clean vehicle', 'Polite', 'On time', 'Knew the route', 'Safe ride'];
const CITY_SPEED = 24; // km/h for client-side ETAs

const toLocalInput = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function PassengerHome() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);
  const [pickup, setPickup] = useState(null);
  const [drop, setDrop] = useState(null);
  const [editing, setEditing] = useState(null); // 'pickup' | 'drop' | null
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [mapPick, setMapPick] = useState(null); // 'pickup' | 'drop' when choosing on map
  const [estimateState, setEstimateState] = useState(null); // { key, data } tagged with the route it belongs to
  const [routeRetry, setRouteRetry] = useState(0);
  const routeRetries = useRef({ key: null, count: 0 });
  const [vehicle, setVehicle] = useState('mini');
  // 'Book again' from ride history hands over { pickup, drop, vehicle } in router state.
  const location = useLocation();
  const navigate = useNavigate();
  const rebookRef = useRef(location.state?.rebook || null);
  const [payment, setPayment] = useState('cash');
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState('');
  const [promos, setPromos] = useState([]);
  const [showPromos, setShowPromos] = useState(false);
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [booking, setBooking] = useState(false);
  const [ride, setRide] = useState(null);
  const [driverPos, setDriverPos] = useState(null);
  const [nearby, setNearby] = useState({ drivers: [], eta: {} });
  const [wallet, setWallet] = useState(null);
  const [history, setHistory] = useState([]);
  const [cancelOpenedAt, setCancelOpenedAt] = useState(null); // timestamp, set from the click handler
  const [expanded, setExpanded] = useState(false);
  const mapRef = useRef(null);
  const onMapReady = useCallback((m) => {
    mapRef.current = m;
  }, []);

  const status = ride?.status;
  const isActive = ACTIVE.includes(status);
  const needsRating = status === 'completed' && ride?.rating == null;
  const showEnded = ['cancelled', 'no_driver'].includes(status);
  const planning = !ride || showEnded || (status === 'completed' && ride?.rating != null);

  // ------------------------------------------------------------ boot
  const loadSide = useCallback(() => {
    api('/me/wallet').then((w) => setWallet(w.balance)).catch(() => {});
    api('/rides/history').then((h) => setHistory(h.rides)).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [pos, active] = await Promise.all([getPosition(), api('/rides/active').catch(() => ({ ride: null }))]);
      if (!alive) return;
      setMe(pos);
      setPickup({ lat: pos.lat, lng: pos.lng, name: 'Current location', address: null });
      const rebook = rebookRef.current;
      if (rebook && !active.ride) {
        setPickup(rebook.pickup);
        setDrop(rebook.drop);
        if (rebook.vehicle) setVehicle(rebook.vehicle);
        rebookRef.current = null;
        navigate('/ride', { replace: true, state: null }); // a refresh shouldn't rebook again
      }
      if (pos.approximate) toast('Location unavailable — using a default city location. You can set pickup manually.', 'warning');
      if (active.ride) {
        setRide(active.ride);
        if (active.ride.driver_lat != null) setDriverPos({ lat: active.ride.driver_lat, lng: active.ride.driver_lng, heading: active.ride.driver_heading });
      }
      setLoading(false);
      emitSocket('passenger:location', pos);
      api(`/geo/reverse?lat=${pos.lat}&lng=${pos.lng}`)
        .then((r) => alive && setPickup((p) => (p && p.lat === pos.lat ? { ...p, name: r.name || 'Current location', address: r.address } : p)))
        .catch(() => {});
    })();
    loadSide();
    api('/promos').then((r) => setPromos(r.promos)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [toast, loadSide, navigate]);

  // ------------------------------------------------------------ nearby drivers (planning)
  useEffect(() => {
    if (!planning || !pickup) return undefined;
    let alive = true;
    const load = () =>
      api(`/rides/nearby-drivers?lat=${pickup.lat}&lng=${pickup.lng}`)
        .then((r) => alive && setNearby(r))
        .catch(() => {});
    load();
    const t = setInterval(load, 2500); // keeps cruising cars gliding smoothly
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [planning, pickup]);

  // ------------------------------------------------------------ place search
  useEffect(() => {
    if (!editing || query.trim().length < 2) return undefined;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const near = pickup || me;
        const r = await api(`/geo/search?q=${encodeURIComponent(query)}${near ? `&lat=${near.lat}&lng=${near.lng}` : ''}`, { signal: ctrl.signal });
        setResults(r.results);
      } catch {
        /* aborted or failed */
      } finally {
        setSearching(false);
      }
    }, 320);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, editing, pickup, me]);

  const recentPlaces = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const r of history) {
      if (!r.drop_address || r.drop_lat == null || seen.has(r.drop_address)) continue;
      seen.add(r.drop_address);
      out.push({ lat: r.drop_lat, lng: r.drop_lng, name: shortAddress(r.drop_address).split(',')[0], address: r.drop_address });
      if (out.length >= 4) break;
    }
    return out;
  }, [history]);

  const upcoming = useMemo(() => history.filter((r) => r.status === 'scheduled'), [history]);

  function choosePlace(place) {
    if (editing === 'pickup') setPickup(place);
    else setDrop(place);
    setEditing(null);
    setQuery('');
    setResults([]);
  }

  async function onMapClick(p) {
    if (!planning) return;
    const target = mapPick || (editing === 'pickup' ? 'pickup' : 'drop');
    const place = { ...p, name: 'Pinned location', address: null };
    if (target === 'pickup') setPickup(place);
    else setDrop(place);
    setMapPick(null);
    setEditing(null);
    setQuery('');
    try {
      const r = await api(`/geo/reverse?lat=${p.lat}&lng=${p.lng}`);
      const named = { ...place, name: r.name, address: r.address };
      if (target === 'pickup') setPickup((x) => (x?.lat === p.lat ? named : x));
      else setDrop((x) => (x?.lat === p.lat ? named : x));
    } catch {
      /* keep pinned label */
    }
  }

  // ------------------------------------------------------------ estimate
  const scheduledIso = scheduleOn && scheduleAt ? new Date(scheduleAt).toISOString() : null;
  const routeKey = pickup && drop ? [pickup.lat, pickup.lng, drop.lat, drop.lng].join(',') : null;
  const requestKey = `${routeKey}|${promo}|${scheduledIso}`;
  const estimate = planning && estimateState?.key === routeKey ? estimateState.data : null;
  const estimating = planning && !!routeKey && estimateState?.requestKey !== requestKey;
  const shownResults = editing && query.trim().length >= 2 ? results : [];
  useEffect(() => {
    if (!planning || !pickup || !drop) return undefined;
    let alive = true;
    let retryTimer;
    const key = routeKey;
    const reqKey = requestKey;
    api('/rides/estimate', {
      method: 'POST',
      body: { pickup, drop, promoCode: promo || undefined, scheduledAt: scheduledIso || undefined },
    })
      .then((e) => {
        if (!alive) return;
        setEstimateState({ key, requestKey: reqKey, data: e });
        // The routing service was busy and we got a straight-line estimate: quietly retry for real roads.
        if (routeRetries.current.key !== key) routeRetries.current = { key, count: 0 };
        if (e.routeSource === 'estimate' && routeRetries.current.count < 3) {
          routeRetries.current.count += 1;
          retryTimer = setTimeout(() => setRouteRetry((n) => n + 1), 3000 * routeRetries.current.count);
        }
      })
      .catch((err) => {
        if (!alive) return;
        setEstimateState({ key, requestKey: reqKey, data: null });
        toast(err.message, 'error');
      });
    return () => {
      alive = false;
      clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planning, pickup?.lat, pickup?.lng, drop?.lat, drop?.lng, promo, scheduledIso, routeRetry]);

  const selectedOpt = estimate?.options.find((o) => o.type === vehicle);
  const promoError = promo && selectedOpt?.promoError;

  // ------------------------------------------------------------ booking
  async function book() {
    if (!selectedOpt) return;
    if (scheduleOn && !scheduleAt) return toast('Pick a date and time for your scheduled ride', 'warning');
    setBooking(true);
    try {
      const { ride: r } = await api('/rides', {
        method: 'POST',
        body: {
          pickup: { lat: pickup.lat, lng: pickup.lng, address: pickup.address },
          drop: { lat: drop.lat, lng: drop.lng, address: drop.address },
          vehicleType: vehicle,
          paymentMethod: payment,
          promoCode: promo && !promoError ? promo : undefined,
          scheduledAt: scheduledIso || undefined,
        },
      });
      if (r.status === 'scheduled') {
        toast(`We'll find you a driver before ${dateTime(r.scheduled_at)}.`, 'success', 'Ride scheduled');
        resetPlanning();
        loadSide();
      } else {
        setRide(r);
        setDriverPos(null);
        if (!r.notified) toast('No drivers are online right next to you yet — we will keep looking.', 'info');
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBooking(false);
    }
  }

  function resetPlanning() {
    setDrop(null);
    setEstimateState(null);
    setPromo('');
    setPromoInput('');
    setScheduleOn(false);
    setScheduleAt('');
  }

  function bookAgain() {
    setRide(null);
    setDriverPos(null);
    loadSide();
  }

  function finishTrip() {
    setRide(null);
    setDriverPos(null);
    resetPlanning();
    loadSide();
  }

  // ------------------------------------------------------------ realtime
  useSocketEvent('ride:update', (r) => {
    setRide((prev) => {
      if (prev && prev.id !== r.id && ACTIVE.includes(prev.status)) return prev;
      if (!prev && !ACTIVE.includes(r.status)) return prev;
      return { ...(prev?.id === r.id ? prev : {}), ...r };
    });
    if (r.driver_lat != null) setDriverPos((p) => p || { lat: r.driver_lat, lng: r.driver_lng, heading: r.driver_heading });
    if (r.notice) toast(r.notice, 'info');
    const msgs = {
      accepted: ['Driver assigned', `${r.driver_name} is on the way`],
      arrived: ['Your driver has arrived', `Share PIN ${r.pin} once you're in the vehicle`],
      in_progress: ['Trip started', 'Enjoy your ride'],
      completed: ['You have arrived', `Fare ${inr(r.final_fare)} paid via ${PAYMENT_LABEL[r.payment_method] || r.payment_method}`],
      no_driver: ['No drivers available', 'Please try again in a moment'],
    };
    if (msgs[r.status] && !r.notice) toast(msgs[r.status][1], r.status === 'no_driver' ? 'warning' : 'success', msgs[r.status][0]);
    if (r.status === 'requested' && !r.driver_id) setDriverPos(null);
  });
  useSocketEvent('driver:location', (p) => {
    if (ride && p.rideId === ride.id) setDriverPos({ lat: p.lat, lng: p.lng, heading: p.heading });
  });

  // ------------------------------------------------------------ derived trip info
  const pickupPt = ride ? { lat: ride.pickup_lat, lng: ride.pickup_lng } : pickup;
  const dropPt = ride ? { lat: ride.drop_lat, lng: ride.drop_lng } : drop;
  const tripRoute = ride?.route?.length ? ride.route : estimate?.route;
  const remaining =
    status === 'in_progress' && driverPos && ride?.route?.length
      ? [[driverPos.lat, driverPos.lng], ...ride.route.slice(nearestIndex(ride.route, driverPos) + 1)]
      : null;
  const remainingKm = remaining ? pathLengthKm(remaining) : null;
  const pickupEtaMin = status === 'accepted' && driverPos ? Math.max(1, Math.round(((haversineKm(driverPos, pickupPt) * 1.35) / CITY_SPEED) * 60)) : null;
  const progress = remainingKm != null && ride?.distance_km ? Math.min(100, Math.max(2, (1 - remainingKm / ride.distance_km) * 100)) : 0;

  // 3D motion: whole panel cascades on every state change; fares, PIN digits and driver card get their own entrances.
  const bodyRef = useRef(null);
  const phaseKey = `${loading}|${status || 'plan'}|${needsRating}|${drop ? 'd' : ''}|${editing || ''}|${estimate ? 'e' : ''}`;
  useStaggerIn(bodyRef, phaseKey);
  useStaggerIn(bodyRef, estimate ? routeKey : null, { selector: '.vehicle-opt', y: 30, rotationX: -40, stagger: 0.08, delay: 0.15 });
  useStaggerIn(bodyRef, `pin-${status}-${loading}`, { selector: '.pin-box span', y: 0, rotationX: -100, stagger: 0.1, delay: 0.35 });
  useStaggerIn(bodyRef, `drv-${ride?.driver_id}-${loading}`, { selector: '.driver-card .avatar-lg', y: 0, rotationX: -180, delay: 0.35 });

  let fit = { key: 'init', points: [me] };
  if (planning && estimate && pickup && drop) fit = { key: `est-${pickup.lat}-${drop.lat}`, points: [pickup, drop] };
  else if (planning && pickup) fit = { key: `p-${pickup.lat}-${drop?.lat}`, points: drop ? [pickup, drop] : [pickup] };
  if (status === 'requested') fit = { key: `req-${ride.id}`, points: [pickupPt] };
  if (status === 'accepted' && driverPos) fit = { key: `acc-${ride.id}`, points: [driverPos, pickupPt] };
  if (status === 'arrived') fit = { key: `arr-${ride.id}`, points: [pickupPt] };
  if (status === 'in_progress' || needsRating) fit = { key: `trip-${ride.id}`, points: [pickupPt, dropPt] };

  if (loading || !me) return <PageLoading />;

  const center = me;
  const shareUrl = ride?.share_token ? `${window.location.origin}/track/${ride.share_token}` : null;
  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: 'Track my RideFlow trip', url: shareUrl });
      else {
        await navigator.clipboard.writeText(shareUrl);
        toast('Live trip link copied — share it with family or friends', 'success');
      }
    } catch {
      /* dismissed */
    }
  }

  // ------------------------------------------------------------ render
  return (
    <div className="map-screen">
      <MapView center={center} zoom={15}>
        <MapRef onReady={onMapReady} />
        <MapClick onClick={onMapClick} />
        <FitBounds fitKey={fit.key} points={fit.points} />
        {planning && nearby.drivers.map((d) => <CarMarker key={d.id} position={d} heading={d.heading} type={d.vehicle_type} />)}
        {planning && <MeMarker position={me} />}
        {tripRoute && (planning ? estimate : true) && <RouteLine coords={status === 'in_progress' && remaining ? remaining : tripRoute} />}
        {pickupPt && status !== 'in_progress' && <PinMarker position={pickupPt} kind="pickup" label={planning ? pickup?.name : 'Pickup'} />}
        {dropPt && <PinMarker position={dropPt} kind="drop" label={planning ? drop?.name : shortAddress(ride?.drop_address).split(',')[0]} />}
        {isActive && driverPos && <CarMarker position={driverPos} heading={driverPos.heading} type={ride.vehicle_type} zIndexOffset={1000} />}
      </MapView>
      <div className="map-vignette" />

      <div className="map-fab">
        <ImmersiveToggle />
        {ride?.driver_id && CHAT_OPEN.includes(status) && <RideChat ride={ride} role="passenger" variant="fab" />}
        <button
          className="icon-btn"
          aria-label="Center on my location"
          title="My location"
          onClick={() => mapRef.current?.flyTo([(driverPos && isActive ? driverPos : me).lat, (driverPos && isActive ? driverPos : me).lng], 16)}
        >
          <LocateFixed size={18} />
        </button>
      </div>

      {mapPick && (
        <div className="glass" style={{ position: 'absolute', zIndex: 600, top: 'calc(var(--nav-space) + 8px)', left: '50%', transform: 'translateX(-50%)', padding: '10px 16px', borderRadius: 14 }}>
          <span className="small bold">Tap the map to set {mapPick === 'pickup' ? 'pickup' : 'destination'}</span>
          <button className="btn btn-sm btn-ghost" style={{ marginLeft: 10 }} onClick={() => setMapPick(null)}>Cancel</button>
        </div>
      )}

      <div className={`panel glass ${expanded ? 'expanded' : ''} ${planning && !drop && !editing ? 'panel-auto' : ''}`}>
        <div className="sheet-handle" onClick={() => setExpanded((e) => !e)} />
        <div className="panel-body" ref={bodyRef}>
          {planning && !showEnded && renderPlanning()}
          {status === 'requested' && renderSearching()}
          {['accepted', 'arrived', 'in_progress'].includes(status) && renderTrip()}
          {needsRating && <RatePanel ride={ride} onDone={finishTrip} />}
          {showEnded && renderEnded()}
        </div>
      </div>

      <CancelModal
        open={!!cancelOpenedAt}
        openedAt={cancelOpenedAt}
        onClose={() => setCancelOpenedAt(null)}
        ride={ride}
        onCancelled={(r) => {
          setRide(r);
          setCancelOpenedAt(null);
          toast(r.cancellation_fee > 0 ? `Cancellation fee ${inr(r.cancellation_fee)} applied` : 'Ride cancelled — no fee charged', 'info');
          loadSide();
        }}
      />
    </div>
  );

  // ------------------------------------------------------------ panels
  function renderPlanning() {
    return (
      <>
        {!drop && !editing && (
          <div>
            <h2 className="panel-title">Where to?</h2>
            <p className="small muted mt-8">
              {nearby.drivers.length ? `${nearby.drivers.length} drivers near you` : 'Looking for drivers near you…'}
            </p>
          </div>
        )}
        {drop && !editing && (
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={resetPlanning}>
            <ArrowLeft size={16} /> Change destination
          </button>
        )}

        <div className="loc-box">
          <div className="loc-line" />
          <div className="loc-row">
            <span className="loc-dot pickup" />
            <input
              aria-label="Pickup location"
              placeholder="Pickup location"
              value={editing === 'pickup' ? query : pickup?.name || ''}
              onFocus={() => {
                setEditing('pickup');
                setQuery('');
              }}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="loc-row">
            <span className="loc-dot drop" />
            <input
              aria-label="Destination"
              placeholder="Where are you going?"
              value={editing === 'drop' ? query : drop?.name || ''}
              onFocus={() => {
                setEditing('drop');
                setQuery('');
              }}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && shownResults[0] && choosePlace(shownResults[0])}
            />
            {editing && (
              <button className="icon-btn" style={{ width: 32, height: 32 }} aria-label="Close search" onClick={() => setEditing(null)}>
                <X size={16} />
              </button>
            )}
          </div>
        </div>

        {editing && (
          <div className="suggestions">
            {editing === 'pickup' && (
              <button
                className="suggestion"
                onClick={() => choosePlace({ lat: me.lat, lng: me.lng, name: 'Current location', address: pickup?.address })}
              >
                <span className="icon"><Crosshair size={18} /></span>
                <span className="grow"><div className="bold small">Use current location</div></span>
              </button>
            )}
            <button className="suggestion" onClick={() => { setMapPick(editing); setEditing(null); }}>
              <span className="icon"><MapPin size={18} /></span>
              <span className="grow"><div className="bold small">Choose on map</div><div className="tiny muted">Tap anywhere on the map</div></span>
            </button>
            {searching && <div className="row small muted" style={{ padding: 10 }}><Spinner size={16} /> Searching…</div>}
            {shownResults.map((r) => (
              <button key={r.id} className="suggestion" onClick={() => choosePlace(r)}>
                <span className="icon"><Search size={16} /></span>
                <span className="grow">
                  <div className="bold small ellipsis">{r.name}</div>
                  <div className="tiny muted ellipsis">{r.address}</div>
                </span>
                {pickup && <span className="tiny muted">{km(haversineKm(pickup, r))}</span>}
              </button>
            ))}
            {!query && recentPlaces.map((r) => (
              <button key={r.address} className="suggestion" onClick={() => choosePlace(r)}>
                <span className="icon"><History size={16} /></span>
                <span className="grow">
                  <div className="bold small ellipsis">{r.name}</div>
                  <div className="tiny muted ellipsis">{r.address}</div>
                </span>
              </button>
            ))}
          </div>
        )}

        {!drop && !editing && (
          <>
            {recentPlaces.length > 0 && (
              <div className="col gap-4">
                <div className="label">Recent</div>
                {recentPlaces.slice(0, 3).map((r) => (
                  <button key={r.address} className="suggestion" onClick={() => setDrop(r)}>
                    <span className="icon"><Clock size={16} /></span>
                    <span className="grow">
                      <div className="bold small ellipsis">{r.name}</div>
                      <div className="tiny muted ellipsis">{r.address}</div>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {upcoming.length > 0 && (
              <Link to="/ride/history" className="notice" style={{ textDecoration: 'none' }}>
                <CalendarClock size={16} />
                <span>
                  {upcoming.length} upcoming scheduled ride{upcoming.length > 1 ? 's' : ''} · next {dateTime(upcoming[upcoming.length - 1].scheduled_at)}
                </span>
              </Link>
            )}
            <div className="tiny muted">Tip: tap anywhere on the map to set your destination.</div>
          </>
        )}

        {drop && !editing && renderOptions()}
      </>
    );
  }

  function renderOptions() {
    if (estimating && !estimate) {
      return <div className="row small muted" style={{ padding: 20, justifyContent: 'center' }}><Spinner /> Calculating fares…</div>;
    }
    if (!estimate) return null;
    const surge = Math.max(...estimate.options.map((o) => o.surge));
    return (
      <>
        <div className="row-between small">
          <span className="text-2">
            <b>{km(estimate.distanceKm)}</b> · {mins(estimate.durationMin)} by road
          </span>
          {estimating && <Spinner size={14} />}
        </div>
        {surge > 1 && (
          <div className="notice warning">
            <Zap size={16} />
            <span>
              Fares are slightly higher right now ({estimate.options.find((o) => o.surge > 1)?.surgeReasons.join(', ')}).
              Schedule a ride for surge-free pricing.
            </span>
          </div>
        )}
        <div className="vehicle-list" role="radiogroup" aria-label="Vehicle category">
          {estimate.options.map((o) => (
            <button
              key={o.type}
              role="radio"
              aria-checked={vehicle === o.type}
              className={`vehicle-opt ${vehicle === o.type ? 'selected' : ''}`}
              onClick={() => setVehicle(o.type)}
            >
              <span className="vimg"><VehicleArt type={o.type} /></span>
              <span className="grow">
                <span className="row gap-8">
                  <span className="bold">{o.name}</span>
                  <span className="tiny muted row gap-4"><Users size={12} /> {o.seats}</span>
                  {o.surge > 1 && <span className="badge badge-warning" style={{ height: 20 }}>{o.surge}x</span>}
                </span>
                <span className="tiny muted" style={{ display: 'block' }}>
                  {o.etaMin ? `${o.etaMin} min away` : 'No drivers nearby'} · {o.tagline}
                </span>
              </span>
              <span className="price">
                <div className="bold mono">{inr(o.fare)}</div>
                {o.fare !== o.fareWithoutPromo && !o.promoError && <div className="strike">{inr(o.fareWithoutPromo)}</div>}
              </span>
            </button>
          ))}
        </div>

        <div className="col gap-8">
          <div className="label">Payment</div>
          <div className="segmented">
            {[
              ['cash', Banknote, 'Cash'],
              ['wallet', Wallet, wallet != null ? inr(wallet) : 'Wallet'],
              ['card', CreditCard, 'Card'],
            ].map(([k, Icon, label]) => (
              <button key={k} className={payment === k ? 'active' : ''} onClick={() => setPayment(k)}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
          {payment === 'wallet' && selectedOpt && wallet != null && wallet < selectedOpt.fare && (
            <div className="notice danger small">
              <Wallet size={16} />
              <span>Wallet balance is low. <Link to="/ride/account">Top up with a test card</Link>.</span>
            </div>
          )}
          {payment === 'card' && <div className="tiny muted">Charged to test card •••• 4242 at drop-off (simulated, no real money).</div>}
        </div>

        <div className="col gap-8">
          <div className="row-between">
            <span className="label">Promo code</span>
            {promos.length > 0 && (
              <button className="btn btn-sm btn-ghost" style={{ height: 28 }} onClick={() => setShowPromos(true)}>
                <Tag size={13} /> View offers
              </button>
            )}
          </div>
          {promo ? (
            <div className={`notice ${promoError ? 'danger' : 'success'}`}>
              <BadgePercent size={16} />
              <span className="grow">
                <b>{promo}</b> {promoError ? `— ${promoError}` : `applied · you save ${inr(selectedOpt ? selectedOpt.fareWithoutPromo - selectedOpt.fare : 0)}`}
              </span>
              <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Remove promo" onClick={() => { setPromo(''); setPromoInput(''); }}>
                <X size={14} />
              </button>
            </div>
          ) : (
            <form className="row gap-8" onSubmit={(e) => { e.preventDefault(); if (promoInput.trim()) setPromo(promoInput.trim().toUpperCase()); }}>
              <input className="input" style={{ height: 42 }} placeholder="e.g. WELCOME50" value={promoInput} onChange={(e) => setPromoInput(e.target.value)} />
              <button className="btn btn-sm" style={{ height: 42 }} disabled={!promoInput.trim()}>Apply</button>
            </form>
          )}
        </div>

        <div className="col gap-8">
          <label className="row-between check">
            <span className="row gap-8"><CalendarClock size={16} /> Schedule for later</span>
            <button
              type="button"
              className={`switch ${scheduleOn ? 'on' : ''}`}
              aria-pressed={scheduleOn}
              aria-label="Schedule for later"
              onClick={() => {
                setScheduleOn((s) => !s);
                if (!scheduleAt) setScheduleAt(toLocalInput(new Date(Date.now() + 30 * 60_000)));
              }}
            />
          </label>
          {scheduleOn && (
            <>
              <input
                className="input"
                type="datetime-local"
                value={scheduleAt}
                min={toLocalInput(new Date(Date.now() + 15 * 60_000))}
                max={toLocalInput(new Date(Date.now() + 7 * 86_400_000))}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
              <div className="tiny muted">Scheduled rides are surge-free. We start matching a driver 5 minutes before pickup.</div>
            </>
          )}
        </div>

        <button className="btn btn-primary btn-lg btn-block" onClick={book} disabled={booking || !selectedOpt}>
          {booking ? <Spinner /> : scheduleOn ? `Schedule ${selectedOpt?.name || ''}` : `Book ${selectedOpt?.name || ''} · ${inr(selectedOpt?.fare)}`}
        </button>

        <Modal open={showPromos} onClose={() => setShowPromos(false)} title="Available offers">
          <div className="col gap-8">
            {promos.map((p) => (
              <button
                key={p.code}
                className="suggestion"
                style={{ border: '1px dashed var(--border-strong)' }}
                onClick={() => {
                  setPromo(p.code);
                  setPromoInput(p.code);
                  setShowPromos(false);
                }}
              >
                <span className="icon" style={{ color: 'var(--accent)' }}><BadgePercent size={18} /></span>
                <span className="grow">
                  <div className="bold">{p.code}</div>
                  <div className="tiny muted">{p.description}</div>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      </>
    );
  }

  function renderSearching() {
    return (
      <>
        <div className="center">
          <div className="radar">
            <span /><span /><span />
            <div className="core"><Search size={18} color="#fff" /></div>
          </div>
          <h2 className="panel-title">Finding your {VEHICLE_META[ride.vehicle_type]?.name}</h2>
          <p className="small muted mt-8">Nearby drivers have been notified. This usually takes a few seconds.</p>
        </div>
        <TripSummary ride={ride} />
        <button className="btn btn-soft-danger btn-block" onClick={() => setCancelOpenedAt(Date.now())}>Cancel request</button>
      </>
    );
  }

  function renderTrip() {
    const headline = {
      accepted: pickupEtaMin ? `Arriving in ${pickupEtaMin} min` : 'Driver is on the way',
      arrived: 'Your driver has arrived',
      in_progress: remainingKm != null ? `${mins(ride.distance_km ? (ride.duration_min * remainingKm) / ride.distance_km : (remainingKm / CITY_SPEED) * 60)} to destination` : 'On the way to destination',
    }[status];
    return (
      <>
        <div className="row-between">
          <div>
            <h2 className="panel-title">{headline}</h2>
            <div className="mt-8"><StatusBadge status={status} /></div>
          </div>
          <SosButton rideId={ride.id} shareToken={ride.share_token} compact getLocation={() => driverPos || me} />
        </div>

        {status === 'in_progress' && (
          <div className="col gap-8">
            <div className="progress"><div style={{ width: `${progress}%` }} /></div>
            <div className="row-between tiny muted">
              <span>{remainingKm != null ? `${km(remainingKm)} left` : ''}</span>
              <span>{shortAddress(ride.drop_address)}</span>
            </div>
          </div>
        )}

        {status !== 'in_progress' && (
          <div className="card card-tight center" style={{ background: 'var(--bg-2)' }}>
            <div className="small muted">Trip PIN — share only when you're in the vehicle</div>
            <div className="pin-box mt-8">
              {String(ride.pin).split('').map((d, i) => <span key={i}>{d}</span>)}
            </div>
          </div>
        )}

        <div className="card card-tight row driver-card" style={{ background: 'linear-gradient(135deg, rgba(59,130,255,.12), rgba(47,128,255,.05)), var(--surface-2)' }}>
          <div className="avatar avatar-lg">{initials(ride.driver_name)}</div>
          <div className="grow">
            <div className="bold">{ride.driver_name}</div>
            <div className="small muted row gap-4">
              <Star size={13} fill="#fbbf24" color="#fbbf24" /> {Number(ride.driver_rating || 5).toFixed(1)}
              {ride.driver_rating_count ? ` · ${ride.driver_rating_count} ratings` : ''}
            </div>
            <div className="small text-2 mt-8">{[ride.vehicle_color, ride.vehicle_model].filter(Boolean).join(' ')}</div>
          </div>
          <div className="col gap-8" style={{ alignItems: 'flex-end' }}>
            <span className="plate">{ride.vehicle_number}</span>
            <VehicleArt type={ride.vehicle_type} size={56} />
          </div>
        </div>

        <div className="grid grid-2" style={{ gap: 8 }}>
          <a className="btn btn-ghost" href={`tel:${ride.driver_phone || ''}`}><Phone size={16} /> Call</a>
          <button className="btn btn-ghost" onClick={share}><Share2 size={16} /> Share trip</button>
        </div>

        <TripSummary ride={ride} />

        {status !== 'in_progress' && (
          <button className="btn btn-soft-danger btn-block" onClick={() => setCancelOpenedAt(Date.now())}>Cancel ride</button>
        )}
      </>
    );
  }

  function renderEnded() {
    const noDriver = status === 'no_driver';
    return (
      <>
        <div className="center col gap-8" style={{ alignItems: 'center' }}>
          <div className="icon-btn" style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--danger-soft)', color: '#fca5a5' }}>
            <X size={28} />
          </div>
          <h2 className="panel-title">{noDriver ? 'No drivers available' : 'Ride cancelled'}</h2>
          <p className="small muted">
            {noDriver
              ? 'All nearby drivers are busy right now. Please try again.'
              : `Cancelled by ${ride.cancelled_by}${ride.cancellation_fee > 0 ? ` · fee ${inr(ride.cancellation_fee)}` : ' · no fee charged'}`}
          </p>
        </div>
        <TripSummary ride={ride} />
        <button
          className="btn btn-primary btn-lg btn-block"
          onClick={() => {
            setPickup({ lat: ride.pickup_lat, lng: ride.pickup_lng, name: shortAddress(ride.pickup_address).split(',')[0], address: ride.pickup_address });
            setDrop({ lat: ride.drop_lat, lng: ride.drop_lng, name: shortAddress(ride.drop_address).split(',')[0], address: ride.drop_address });
            setVehicle(ride.vehicle_type);
            bookAgain();
          }}
        >
          Try again
        </button>
        <button className="btn btn-ghost btn-block" onClick={() => { bookAgain(); resetPlanning(); }}>New ride</button>
      </>
    );
  }
}

function TripSummary({ ride }) {
  return (
    <div className="card card-tight col gap-8" style={{ background: 'var(--surface-2)' }}>
      <div className="route-mini">
        <span className="loc-dot pickup" />
        <span className="ellipsis">{shortAddress(ride.pickup_address)}</span>
        <span className="line" />
        <span />
        <span className="loc-dot drop" />
        <span className="ellipsis">{shortAddress(ride.drop_address)}</span>
      </div>
      <div className="divider" />
      <div className="row-between small">
        <span className="muted">{VEHICLE_META[ride.vehicle_type]?.name} · {km(ride.distance_km)} · {PAYMENT_LABEL[ride.payment_method]}</span>
        <span className="bold mono">{inr(ride.final_fare ?? ride.est_fare)}</span>
      </div>
      {ride.promo_code && ride.discount > 0 && <div className="tiny" style={{ color: '#86efac' }}>Promo {ride.promo_code}: −{inr(ride.discount)}</div>}
    </div>
  );
}

function CancelModal({ open, openedAt, onClose, ride, onCancelled }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!ride) return null;
  const late = ride.status === 'arrived' || (ride.status === 'accepted' && openedAt - new Date(ride.accepted_at).getTime() > 3 * 60_000);
  const fee = late ? CANCEL_FEE[ride.vehicle_type] : 0;
  async function confirm() {
    setBusy(true);
    try {
      const { ride: r } = await api(`/rides/${ride.id}/cancel`, { method: 'POST', body: { reason } });
      onCancelled(r);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Cancel this ride?">
      <div className="col gap-16">
        {fee > 0 ? (
          <div className="notice warning">
            <Receipt size={16} />
            <span>A cancellation fee of <b>{inr(fee)}</b> applies because your driver {ride.status === 'arrived' ? 'has already arrived' : 'accepted more than 3 minutes ago'}. It compensates the driver for their time.</span>
          </div>
        ) : (
          <div className="notice success"><Receipt size={16} /><span>Free cancellation — no fee will be charged.</span></div>
        )}
        <div className="col gap-8">
          <div className="label">Reason</div>
          <div className="row wrap gap-8">
            {CANCEL_REASONS.map((r) => (
              <button key={r} className="chip" style={reason === r ? { borderColor: 'var(--primary)', background: 'var(--primary-soft)' } : undefined} onClick={() => setReason(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-2" style={{ gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Keep ride</button>
          <button className="btn btn-danger" onClick={confirm} disabled={busy}>{busy ? <Spinner /> : 'Cancel ride'}</button>
        </div>
      </div>
    </Modal>
  );
}

function RatePanel({ ride, onDone }) {
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [tags, setTags] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const b = ride.fare_breakdown || {};

  async function submit(skip) {
    setBusy(true);
    try {
      const feedback = [tags.join(', '), text].filter(Boolean).join(' — ');
      await api(`/rides/${ride.id}/rate`, { method: 'POST', body: { rating: skip ? 0 : rating, feedback } });
      if (!skip) toast('Thanks for rating your driver!', 'success');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="center col gap-4" style={{ alignItems: 'center' }}>
        <SuccessMark />
        <span className="badge badge-success mt-8">Trip completed</span>
        <CountUp className="fare-hero mt-8" value={ride.final_fare} format={(n) => inr(n)} />
        <div className="small muted">Paid via {PAYMENT_LABEL[ride.payment_method]} · {km(b.distanceKm ?? ride.distance_km)}</div>
      </div>
      <div className="card card-tight col gap-8" style={{ background: 'var(--surface-2)' }}>
        <Line k="Base fare" v={inr(b.base, 2)} />
        <Line k={`Distance (${km(b.distanceKm)})`} v={inr(b.distanceFare, 2)} />
        <Line k={`Time (${mins(b.durationMin)})`} v={inr(b.timeFare, 2)} />
        {b.surgeAmount > 0 && <Line k={`Surge ${b.surge}x`} v={inr(b.surgeAmount, 2)} />}
        {b.minFareApplied && <Line k="Minimum fare applied" v="" />}
        {b.discount > 0 && <Line k={`Promo ${ride.promo_code || ''}`} v={`−${inr(b.discount, 2)}`} />}
        <Line k="Taxes (5%)" v={inr(b.tax, 2)} />
      </div>
      <div className="divider" />
      <div className="center">
        <div className="bold">How was your ride with {ride.driver_name?.split(' ')[0]}?</div>
      </div>
      <RatingStars value={rating} onChange={setRating} />
      {rating > 0 && (
        <>
          <div className="row wrap gap-8" style={{ justifyContent: 'center' }}>
            {RATING_TAGS.map((t) => (
              <button
                key={t}
                className="chip"
                style={tags.includes(t) ? { borderColor: 'var(--primary)', background: 'var(--primary-soft)' } : undefined}
                onClick={() => setTags((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="input-icon">
            <MessageSquare size={16} />
            <input className="input" placeholder="Add a comment (optional)" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        </>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={!rating || busy} onClick={() => submit(false)}>
        {busy ? <Spinner /> : 'Submit rating'}
      </button>
      <div className="grid grid-2" style={{ gap: 8 }}>
        <Link className="btn btn-ghost" to={`/receipt/${ride.id}`}><Receipt size={16} /> Receipt</Link>
        <button className="btn btn-ghost" onClick={() => submit(true)} disabled={busy}>Skip</button>
      </div>
    </>
  );
}

function Line({ k, v }) {
  return (
    <div className="row-between small">
      <span className="muted">{k}</span>
      <span className="mono">{v}</span>
    </div>
  );
}
