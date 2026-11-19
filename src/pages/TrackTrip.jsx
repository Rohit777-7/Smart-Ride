import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Check, Clock, Copy, Crosshair, Flag, MapPinOff, Navigation, Route as RouteIcon, ShieldCheck, Timer, XCircle,
} from 'lucide-react';
import { Logo } from '../components/AppShell.jsx';
import { CarMarker, FitBounds, MapRef, MapView, PinMarker, RouteLine } from '../components/MapView.jsx';
import ImmersiveToggle from '../components/ImmersiveToggle.jsx';
import { PageLoading, Spinner, VehicleArt } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useStaggerIn } from '../lib/motion.jsx';
import { useToast } from '../lib/toast.jsx';
import { VEHICLE_META, haversineKm, initials, km, nearestIndex, pathLengthKm, shortAddress, timeOnly } from '../lib/format.js';

const CITY_SPEED = 24; // km/h, same assumption the rider's own screen uses
const POLL_MS = 3000;
const LIVE = ['accepted', 'arrived', 'in_progress'];
const STEPS = ['Assigned', 'Picked up', 'En route', 'Arrived'];
const STEP_INDEX = { requested: 0, accepted: 0, arrived: 1, in_progress: 2, completed: 4 };

const clockIn = (now, minutes) => timeOnly(new Date(now + minutes * 60000).toISOString());

/** What the hero card says for each trip state. */
function describe(ride, { pickupEta, dropEta, now }) {
  const who = ride.passenger_first_name;
  const driver = ride.driver_name?.split(' ')[0] || 'The driver';
  const drop = shortAddress(ride.drop.address).split(',')[0];
  switch (ride.status) {
    case 'requested':
      return { tone: 'blue', icon: Spinner, title: `Finding a driver for ${who}`, sub: 'Nearby drivers are being notified right now.' };
    case 'scheduled':
      return { tone: 'blue', icon: Clock, title: `${who}'s ride is scheduled`, sub: 'Live tracking starts when a driver is assigned.' };
    case 'accepted':
      return { tone: 'blue', icon: Navigation, title: `${driver} is heading to pick up ${who}`, sub: pickupEta ? `Expected at pickup around ${clockIn(now, pickupEta)}` : 'Driver is on the way.' };
    case 'arrived':
      return { tone: 'amber', icon: Flag, title: `${driver} has arrived at pickup`, sub: `Waiting for ${who} to board. The trip starts after a PIN check.` };
    case 'in_progress':
      return { tone: 'blue', icon: Navigation, title: `${who} is on the way to ${drop}`, sub: dropEta ? `Expected to arrive around ${clockIn(now, dropEta)}` : 'Trip in progress.' };
    case 'completed':
      return { tone: 'green', icon: Check, title: `${who} arrived safely`, sub: `Dropped off at ${drop}${ride.completed_at ? ` at ${timeOnly(ride.completed_at)}` : ''}.` };
    default:
      return { tone: 'red', icon: XCircle, title: 'This trip was cancelled', sub: 'There is nothing to track any more.' };
  }
}

/** Public live-trip page shared by a rider with family and friends. */
export default function TrackTrip() {
  const { token } = useParams();
  const toast = useToast();
  const [ride, setRide] = useState(null);
  const [error, setError] = useState('');
  const [lastAt, setLastAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const mapApi = useRef(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api(`/track/${token}`)
        .then((r) => {
          if (!alive) return;
          setRide(r.ride);
          setError('');
          setLastAt(Date.now());
        })
        .catch((e) => alive && setError(e.message));
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [token]);

  useStaggerIn(bodyRef, ride ? ride.status : null);
  const onMapReady = useCallback((m) => { mapApi.current = m; }, []);

  if (error && !ride) {
    return (
      <>
        <header className="topbar"><Logo /></header>
        <div className="trk-missing">
          <div className="trk-missing-card">
            <span className="trk-missing-icon"><MapPinOff size={26} /></span>
            <h1>Trip link unavailable</h1>
            <p>{error === 'Trip not found' ? 'This tracking link is invalid or has been turned off by the rider.' : error}</p>
            <Link to="/" className="btn btn-primary">Open RideFlow</Link>
          </div>
        </div>
      </>
    );
  }
  if (!ride) return <PageLoading />;

  // ---- derived live numbers
  const live = LIVE.includes(ride.status);
  const route = ride.route || [];
  const totalKm = route.length > 1 ? pathLengthKm(route) : haversineKm(ride.pickup, ride.drop);
  const remainingKm =
    ride.status === 'in_progress' && ride.driver && route.length > 1
      ? pathLengthKm([[ride.driver.lat, ride.driver.lng], ...route.slice(nearestIndex(route, ride.driver) + 1)])
      : null;
  const progress = ride.status === 'completed' ? 100 : remainingKm != null && totalKm ? Math.min(98, Math.max(3, (1 - remainingKm / totalKm) * 100)) : 0;
  const dropEta = remainingKm != null ? Math.max(1, Math.round((remainingKm / CITY_SPEED) * 60)) : null;
  const pickupEta = ride.status === 'accepted' && ride.driver ? Math.max(1, Math.round(((haversineKm(ride.driver, ride.pickup) * 1.35) / CITY_SPEED) * 60)) : null;
  const eta = ride.status === 'accepted' ? pickupEta : dropEta;
  const elapsed = ride.started_at ? Math.max(0, Math.round((new Date(ride.completed_at || now).getTime() - new Date(ride.started_at).getTime()) / 60000)) : null;
  const ago = lastAt ? Math.max(0, Math.round((now - lastAt) / 1000)) : 0;
  const stepIdx = STEP_INDEX[ride.status] ?? -1;
  const hero = describe(ride, { pickupEta, dropEta, now });
  const HeroIcon = hero.icon;

  let fit = { key: `t-${ride.id}`, points: [ride.pickup, ride.drop] };
  if (ride.status === 'accepted' && ride.driver) fit = { key: `acc-${ride.id}`, points: [ride.driver, ride.pickup] };
  if (ride.status === 'arrived') fit = { key: `arr-${ride.id}`, points: [ride.pickup] };

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast('Tracking link copied', 'success');
    } catch {
      toast('Could not copy the link', 'error');
    }
  }

  return (
    <>
      <header className="topbar"><Logo /></header>
      <div className="map-screen">
        <MapView center={ride.pickup} zoom={14}>
          <MapRef onReady={onMapReady} />
          <FitBounds fitKey={fit.key} points={fit.points} />
          <RouteLine coords={route} />
          <PinMarker position={ride.pickup} kind="pickup" label="Pickup" />
          <PinMarker position={ride.drop} kind="drop" label="Drop" />
          {ride.driver && <CarMarker position={ride.driver} heading={ride.driver.heading} type={ride.vehicle_type} />}
        </MapView>
        <div className="map-fab">
          <ImmersiveToggle />
          {ride.driver && (
            <button type="button" className="icon-btn" aria-label="Center map on the vehicle" title="Center on vehicle" onClick={() => mapApi.current?.flyTo([ride.driver.lat, ride.driver.lng], 16)}>
              <Crosshair size={20} />
            </button>
          )}
        </div>

        <div className="panel panel-auto glass trk-panel">
          <div className="sheet-handle" />
          <div className="panel-body" ref={bodyRef}>
            <div className="trk-top">
              {live ? (
                <span className="trk-live"><i /> Live</span>
              ) : (
                <span className="trk-ended">{ride.status === 'completed' ? 'Trip ended' : ride.status === 'requested' || ride.status === 'scheduled' ? 'Waiting' : 'Not active'}</span>
              )}
              <span className="trk-updated">{error ? 'Reconnecting…' : live ? `Updated ${ago <= 1 ? 'just now' : `${ago}s ago`}` : `Ride #${String(ride.id).padStart(6, '0')}`}</span>
              <button type="button" className="icon-btn trk-copy" onClick={copyLink} aria-label="Copy tracking link" title="Copy link">
                <Copy size={16} />
              </button>
            </div>

            <div className={`trk-hero ${hero.tone}`}>
              <span className="trk-hero-icon"><HeroIcon size={20} /></span>
              <div className="trk-hero-text">
                <h1>{hero.title}</h1>
                <p>{hero.sub}</p>
              </div>
              {eta != null && (
                <div className="trk-eta" aria-label={`About ${eta} minutes ${ride.status === 'accepted' ? 'to pickup' : 'to destination'}`}>
                  <b>{eta}</b>
                  <span>min</span>
                </div>
              )}
            </div>

            {(ride.status === 'in_progress' || ride.status === 'completed') && (
              <div className="trk-progress">
                <div className="trk-bar" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} aria-label="Trip progress">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <div className="trk-progress-meta">
                  <span>{km(Math.max(0, totalKm - (remainingKm ?? (ride.status === 'completed' ? 0 : totalKm))))} done</span>
                  <span>{ride.status === 'completed' ? 'Destination reached' : `${km(remainingKm ?? totalKm)} to go`}</span>
                </div>
              </div>
            )}

            {stepIdx >= 0 && (
              <div className={`stepper ${stepIdx >= STEPS.length ? 'all-done' : ''}`} aria-label="Trip progress steps">
                {STEPS.map((label, i) => (
                  <div key={label} className={`step-item ${i < stepIdx ? 'done' : ''} ${i === stepIdx ? 'current' : ''}`} title={label}>
                    <span className="step-dot" aria-hidden="true">{i < stepIdx ? <Check size={13} /> : i + 1}</span>
                    <span className="step-label">{label}</span>
                  </div>
                ))}
              </div>
            )}

            {ride.driver_name && (
              <div className="trk-driver">
                <VehicleArt type={ride.vehicle_type} size={84} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="trk-driver-name">
                    <span className="avatar trk-avatar">{initials(ride.driver_name)}</span>
                    <b className="ellipsis">{ride.driver_name}</b>
                  </div>
                  <div className="small muted ellipsis" style={{ marginTop: 3 }}>
                    {[ride.vehicle_color, ride.vehicle_model].filter(Boolean).join(' ')} · {VEHICLE_META[ride.vehicle_type]?.name}
                  </div>
                  {ride.vehicle_number && <span className="plate" style={{ marginTop: 8 }}>{ride.vehicle_number}</span>}
                </div>
              </div>
            )}

            <div className="trk-metrics">
              <div><RouteIcon size={15} /><span>Distance</span><b>{km(totalKm)}</b></div>
              <div><Timer size={15} /><span>{ride.completed_at ? 'Trip time' : 'Elapsed'}</span><b>{elapsed != null ? `${elapsed} min` : '—'}</b></div>
              <div><Clock size={15} /><span>{ride.completed_at ? 'Arrived' : 'Started'}</span><b>{ride.completed_at ? timeOnly(ride.completed_at) : ride.started_at ? timeOnly(ride.started_at) : '—'}</b></div>
            </div>

            <div className="trk-route">
              <div className="trk-stop">
                <span className="loc-dot pickup" />
                <div style={{ minWidth: 0 }}>
                  <div className="tiny muted">Pickup{ride.started_at ? ` · ${timeOnly(ride.started_at)}` : ''}</div>
                  <div className="small ellipsis">{shortAddress(ride.pickup.address)}</div>
                </div>
              </div>
              <div className="trk-stop">
                <span className="loc-dot drop" />
                <div style={{ minWidth: 0 }}>
                  <div className="tiny muted">
                    Drop-off{ride.completed_at ? ` · ${timeOnly(ride.completed_at)}` : dropEta ? ` · ETA ${clockIn(now, dropEta)}` : ''}
                  </div>
                  <div className="small ellipsis">{shortAddress(ride.drop.address)}</div>
                </div>
              </div>
            </div>

            <div className="trk-safety">
              <ShieldCheck size={16} />
              <span>
                Shared by {ride.passenger_first_name} for their safety. Only people with this link can see the trip
                {live ? ', and location stops being shared when it ends.' : '.'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
