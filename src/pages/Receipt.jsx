import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Banknote, Car, Clock3, Copy, CreditCard, LifeBuoy, Printer, Route as RouteIcon, Share2, Star, Wallet,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { PAYMENT_LABEL, VEHICLE_META, dateOnly, initials, inr, km, mins, shortAddress, timeOnly } from '../lib/format.js';
import { PageLoading, StatusBadge, VehicleArt } from '../components/ui.jsx';
import { FitBounds, MapView, PinMarker, RouteLine } from '../components/MapView.jsx';
import { useStaggerIn } from '../lib/motion.jsx';

const PAY_ICON = { cash: Banknote, card: CreditCard, wallet: Wallet };
const TYPE_LABEL = { charge: 'Ride fare', refund: 'Refund', cancellation_fee: 'Cancellation fee', topup: 'Top-up' };

/** Decorative barcode derived from the receipt number (stable for a given ride). */
function Barcode({ seed }) {
  const bars = useMemo(() => {
    let x = 0;
    let h = 2166136261;
    const out = [];
    for (let i = 0; i < 46; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i % seed.length), 16777619) >>> 0;
      const w = 1 + (h % 3);
      out.push({ x, w });
      x += w + 1 + ((h >> 3) % 2);
    }
    return { out, width: x };
  }, [seed]);
  return (
    <svg className="barcode" viewBox={`0 0 ${bars.width} 40`} preserveAspectRatio="none" aria-hidden="true">
      {bars.out.map((b, i) => <rect key={i} x={b.x} y="0" width={b.w} height="40" />)}
    </svg>
  );
}

function Line({ label, value, strong, minus, note }) {
  return (
    <div className={`rc-line ${strong ? 'strong' : ''}`}>
      <span className="rc-line-label">{label}{note && <span className="tiny muted"> · {note}</span>}</span>
      <span className="rc-line-dots" aria-hidden="true" />
      <span className="rc-line-value mono">{minus ? '−' : ''}{value}</span>
    </div>
  );
}

export default function Receipt() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const pageRef = useRef(null);
  useStaggerIn(pageRef, data ? 'ready' : null, { selector: '.rc-ticket, .rc-ticket-body > *, .rc-side > *', y: 34, rotationX: -18, stagger: 0.035 });

  useEffect(() => {
    api(`/rides/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div className="page page-narrow"><div className="form-error">{error}</div></div>;
  if (!data) return <PageLoading />;
  const { ride, payments, refunds } = data;
  const b = ride.fare_breakdown || {};
  const completed = ride.status === 'completed';
  const total = completed ? ride.final_fare : ride.cancellation_fee;
  const receiptNo = String(ride.id).padStart(6, '0');
  const charge = payments.find((p) => p.type === 'charge' || p.type === 'cancellation_fee');
  const PayIcon = PAY_ICON[charge?.method || ride.payment_method] || Banknote;
  const paid = ['paid', 'refunded', 'partially_refunded'].includes(ride.payment_status);
  const pickup = { lat: ride.pickup_lat, lng: ride.pickup_lng };
  const drop = { lat: ride.drop_lat, lng: ride.drop_lng };
  const isPassenger = user.role === 'passenger';

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`, 'success');
    } catch {
      toast(text, 'info', what);
    }
  }

  async function share() {
    const url = window.location.href;
    const text = `RideFlow receipt #${receiptNo} · ${inr(total, 2)}`;
    try {
      if (navigator.share) await navigator.share({ title: text, url });
      else await copy(url, 'Receipt link');
    } catch {
      /* share dismissed */
    }
  }

  function bookAgain() {
    navigate('/ride', {
      state: {
        rebook: {
          pickup: { ...pickup, name: shortAddress(ride.pickup_address).split(',')[0], address: ride.pickup_address },
          drop: { ...drop, name: shortAddress(ride.drop_address).split(',')[0], address: ride.drop_address },
          vehicle: ride.vehicle_type,
        },
      },
    });
  }

  return (
    <div className="page rc-page" ref={pageRef}>
      <div className="row-between no-print rc-topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}><ArrowLeft size={16} /> Back</button>
        <span className="tiny muted">Receipt #{receiptNo}</span>
      </div>

      <div className="rc-layout">
        {/* ---------------- the receipt itself */}
        <article className="rc-ticket">
          <header className="rc-ticket-head">
            <div className="row-between">
              <span className="rc-brand">
                <span className="logo-mark" style={{ width: 30, height: 30, borderRadius: 10 }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 2C7.6 2 4 5.4 4 9.7 4 15.5 12 22 12 22s8-6.5 8-12.3C20 5.4 16.4 2 12 2z" fill="#fff" /><circle cx="12" cy="9.5" r="3" fill="#2a76f2" /></svg>
                </span>
                RideFlow
              </span>
              <span className="rc-doc">{completed ? 'Trip receipt' : 'Cancellation receipt'}</span>
            </div>
            <div className="rc-total-label">{completed ? 'Total paid' : 'Fee charged'}</div>
            <div className="rc-total">{inr(total, 2)}</div>
            <div className="rc-head-meta">
              <span className="rc-pay-chip"><PayIcon size={14} /> {PAYMENT_LABEL[charge?.method || ride.payment_method] || ride.payment_method}</span>
              <span>{dateOnly(completed ? ride.completed_at : ride.cancelled_at)}</span>
            </div>
            {paid && <div className={`rc-stamp ${ride.payment_status !== 'paid' ? 'refund' : ''}`}>{ride.payment_status === 'paid' ? 'Paid' : 'Refunded'}</div>}
          </header>

          <div className="rc-ticket-body">
            <div className="rc-trip">
              <VehicleArt type={ride.vehicle_type} size={88} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row gap-8 wrap">
                  <span className="bold">{VEHICLE_META[ride.vehicle_type]?.name}</span>
                  <StatusBadge status={ride.status} />
                </div>
                <div className="tiny muted mt-8">{[ride.vehicle_color, ride.vehicle_model].filter(Boolean).join(' ') || '—'}{ride.vehicle_number ? ` · ${ride.vehicle_number}` : ''}</div>
                <div className="rc-chips mt-8">
                  <span><RouteIcon size={12} /> {km(b.distanceKm ?? ride.distance_km)}</span>
                  {completed && <span><Clock3 size={12} /> {mins(b.durationMin ?? ride.duration_min)}</span>}
                  {b.surge > 1 && <span className="surge">{b.surge}x demand</span>}
                </div>
              </div>
            </div>

            <div className="rc-route">
              <div className="rc-stop">
                <span className="loc-dot pickup" />
                <div className="grow">
                  <div className="tiny muted">Pickup{ride.started_at ? ` · ${timeOnly(ride.started_at)}` : ''}</div>
                  <div className="small">{ride.pickup_address}</div>
                </div>
              </div>
              <div className="rc-stop">
                <span className="loc-dot drop" />
                <div className="grow">
                  <div className="tiny muted">Drop-off{ride.completed_at ? ` · ${timeOnly(ride.completed_at)}` : ''}</div>
                  <div className="small">{ride.drop_address}</div>
                </div>
              </div>
            </div>

            <div className="rc-section-title">Fare details</div>
            {completed ? (
              <div className="rc-lines">
                <Line label="Base fare" value={inr(b.base, 2)} />
                <Line label="Distance" note={km(b.distanceKm)} value={inr(b.distanceFare, 2)} />
                <Line label="Ride time" note={mins(b.durationMin)} value={inr(b.timeFare, 2)} />
                {b.surgeAmount > 0 && <Line label="Demand pricing" note={`${b.surge}x`} value={inr(b.surgeAmount, 2)} />}
                {b.minFareApplied && <Line label="Minimum fare adjustment" value="applied" />}
                <Line label="Subtotal" value={inr(b.subtotal, 2)} />
                {b.discount > 0 && <Line label={`Promo ${ride.promo_code || ''}`} value={inr(b.discount, 2)} minus />}
                <Line label="Taxes" note="GST 5%" value={inr(b.tax, 2)} />
              </div>
            ) : (
              <div className="rc-lines">
                <Line label="Late cancellation fee" value={inr(ride.cancellation_fee, 2)} />
              </div>
            )}
            <div className="rc-grand">
              <span>Total</span>
              <b className="mono">{inr(total, 2)}</b>
            </div>
            {b.discount > 0 && <div className="rc-saved">You saved {inr(b.discount, 2)} with {ride.promo_code}</div>}

            <div className="rc-section-title">Payments</div>
            <div className="rc-payments">
              {payments.map((p) => {
                const Icon = PAY_ICON[p.method] || Banknote;
                return (
                  <div key={p.id} className="rc-payment">
                    <span className="rc-payment-icon"><Icon size={15} /></span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small bold">{TYPE_LABEL[p.type] || p.type} · {PAYMENT_LABEL[p.method] || p.method}</div>
                      <button className="rc-txn mono" onClick={() => copy(p.txn_id, 'Transaction ID')} title="Copy transaction ID">{p.txn_id} <Copy size={11} /></button>
                    </div>
                    <div className="rc-payment-amount">
                      <b className="mono">{p.type === 'refund' ? '−' : ''}{inr(p.amount, 2)}</b>
                      <span className={`tiny ${p.status === 'paid' || p.status === 'refunded' ? 'ok' : 'muted'}`}>{p.status}</span>
                    </div>
                  </div>
                );
              })}
              {refunds.map((r) => (
                <div key={`r${r.id}`} className="rc-payment">
                  <span className="rc-payment-icon"><LifeBuoy size={15} /></span>
                  <div className="grow"><div className="small bold">Refund request</div><div className="tiny muted">{r.reason}</div></div>
                  <div className="rc-payment-amount">
                    <b className="mono">{inr(r.amount_approved ?? r.amount_requested, 2)}</b>
                    <span className={`tiny ${r.status === 'approved' ? 'ok' : 'muted'}`}>{r.status}</span>
                  </div>
                </div>
              ))}
            </div>

            {user.role === 'driver' && completed && (
              <div className="rc-earning">
                <span>Your earning</span>
                <b className="mono">{inr(ride.driver_earning, 2)}</b>
                <span className="tiny muted">after {inr(ride.commission, 2)} platform commission</span>
              </div>
            )}

            <footer className="rc-foot">
              <Barcode seed={`${receiptNo}-${charge?.txn_id || ride.id}`} />
              <div className="rc-foot-meta">
                <span className="mono">#{receiptNo}</span>
                <span>{ride.passenger_name}{ride.driver_name ? ` · Driver: ${ride.driver_name}` : ''}</span>
              </div>
              <div className="tiny muted center">Simulated ride with test payments. No real money was charged.</div>
            </footer>
          </div>
        </article>

        {/* ---------------- context + actions */}
        <aside className="rc-side no-print">
          <div className="rc-map">
            <MapView center={pickup} zoom={13} className="map-fill" cinematic={false}>
              <FitBounds fitKey={`rc-${ride.id}`} points={[pickup, drop]} />
              {ride.route?.length > 1 && <RouteLine coords={ride.route} />}
              <PinMarker position={pickup} kind="pickup" />
              <PinMarker position={drop} kind="drop" />
            </MapView>
          </div>

          {ride.driver_name && (
            <div className="rc-driver card">
              <span className="avatar avatar-lg">{initials(ride.driver_name)}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="tiny muted">{isPassenger ? 'Your driver' : 'Driver'}</div>
                <div className="bold">{ride.driver_name}</div>
                <div className="tiny muted row gap-4"><Star size={12} fill="#fbbf24" color="#fbbf24" /> {Number(ride.driver_rating || 5).toFixed(2)} driver rating</div>
              </div>
              {ride.rating > 0 && (
                <div className="rc-your-rating">
                  <span className="tiny muted">You rated</span>
                  <span className="row gap-4">{[1, 2, 3, 4, 5].map((n) => <Star key={n} size={13} fill={n <= ride.rating ? '#fbbf24' : 'none'} color={n <= ride.rating ? '#fbbf24' : '#4b5060'} />)}</span>
                </div>
              )}
            </div>
          )}

          <div className="rc-actions card">
            <button className="btn btn-primary btn-block" onClick={() => window.print()}><Printer size={16} /> Print / Save PDF</button>
            <div className="grid grid-2" style={{ gap: 8 }}>
              <button className="btn btn-ghost" onClick={share}><Share2 size={16} /> Share</button>
              {isPassenger ? (
                <Link className="btn btn-ghost" to="/ride/history"><LifeBuoy size={16} /> Get help</Link>
              ) : (
                <Link className="btn btn-ghost" to={user.role === 'driver' ? '/driver/earnings' : '/admin'}><Car size={16} /> {user.role === 'driver' ? 'Earnings' : 'Dashboard'}</Link>
              )}
            </div>
            {isPassenger && (
              <button className="btn btn-block rc-rebook" onClick={bookAgain}>Book this trip again <ArrowRight size={16} /></button>
            )}
            {isPassenger && <p className="tiny muted center">Charged incorrectly? Use <b>Refund</b> on this ride in <Link to="/ride/history">My rides</Link>.</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
