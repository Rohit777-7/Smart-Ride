import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight, BadgePercent, CalendarClock, Car, Clock3, IndianRupee, MapPin, Receipt, RotateCcw, Route as RouteIcon, Search, Star,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../lib/toast.jsx';
import { PAYMENT_LABEL, VEHICLE_META, inr, km, shortAddress, timeOnly } from '../../lib/format.js';
import { BarChart } from '../../components/Charts.jsx';
import { Modal, PageLoading, Spinner, StatusBadge, VehicleArt } from '../../components/ui.jsx';
import { CountUp, useStaggerIn } from '../../lib/motion.jsx';

const FILTERS = [
  ['all', 'All'],
  ['scheduled', 'Upcoming'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
];
const fmtInr = (n) => inr(n);
const fmtKm = (n) => km(n);
const fmtInt = (n) => Math.round(n).toLocaleString('en-IN');

const when = (r) => r.scheduled_at && r.status === 'scheduled' ? r.scheduled_at : r.completed_at || r.cancelled_at || r.requested_at || r.created_at;
const monthKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
};
const monthLabel = (iso) => new Date(iso).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const dayLabel = (iso) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

/** "in 2 h", "in 3 days" for upcoming scheduled rides. */
function startsIn(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'starting now';
  const h = ms / 3_600_000;
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 24) return `in ${Math.round(h)} h`;
  return `in ${Math.round(h / 24)} day${Math.round(h / 24) > 1 ? 's' : ''}`;
}

const placeName = (addr) => shortAddress(addr).split(',')[0];

export default function RideHistory() {
  const toast = useToast();
  const navigate = useNavigate();
  const [rides, setRides] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [refundFor, setRefundFor] = useState(null);
  const pageRef = useRef(null);

  const load = useCallback(() => api('/rides/history').then((r) => setRides(r.rides)).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const c = { all: 0, scheduled: 0, completed: 0, cancelled: 0 };
    for (const r of rides || []) {
      c.all++;
      if (r.status === 'scheduled') c.scheduled++;
      else if (r.status === 'completed') c.completed++;
      else if (['cancelled', 'no_driver'].includes(r.status)) c.cancelled++;
    }
    return c;
  }, [rides]);

  const list = useMemo(() => {
    if (!rides) return [];
    let out = rides;
    if (filter === 'cancelled') out = out.filter((r) => ['cancelled', 'no_driver'].includes(r.status));
    else if (filter !== 'all') out = out.filter((r) => r.status === filter);
    const s = query.trim().toLowerCase();
    if (s) out = out.filter((r) => `#${r.id} ${r.pickup_address} ${r.drop_address} ${r.driver_name || ''} ${VEHICLE_META[r.vehicle_type]?.name}`.toLowerCase().includes(s));
    return out;
  }, [rides, filter, query]);

  // group by month for the timeline
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of list) {
      const key = monthKey(when(r));
      if (!map.has(key)) map.set(key, { label: monthLabel(when(r)), rides: [], spent: 0 });
      const g = map.get(key);
      g.rides.push(r);
      if (r.status === 'completed') g.spent += r.final_fare || 0;
    }
    return [...map.values()];
  }, [list]);

  const insights = useMemo(() => {
    const done = (rides || []).filter((r) => r.status === 'completed');
    const spent = done.reduce((a, r) => a + (r.final_fare || 0), 0);
    const saved = done.reduce((a, r) => a + (r.discount || 0), 0);
    const distance = done.reduce((a, r) => a + (r.distance_km || 0), 0);
    const byType = {};
    const byPlace = {};
    for (const r of done) {
      byType[r.vehicle_type] = (byType[r.vehicle_type] || 0) + 1;
      const p = placeName(r.drop_address);
      if (p) byPlace[p] = (byPlace[p] || 0) + 1;
    }
    const favType = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
    const favPlace = Object.entries(byPlace).sort((a, b) => b[1] - a[1])[0];
    const rated = done.filter((r) => r.rating > 0);
    // spending per week, last 8 weeks
    const weeks = [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay() - 7 * 7);
    for (let i = 0; i < 8; i++) {
      const from = new Date(start);
      from.setDate(from.getDate() + i * 7);
      const to = new Date(from);
      to.setDate(to.getDate() + 7);
      const v = done.filter((r) => {
        const t = new Date(r.completed_at || r.created_at);
        return t >= from && t < to;
      });
      weeks.push({
        label: `Week of ${from.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`,
        short: from.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        value: Math.round(v.reduce((a, r) => a + (r.final_fare || 0), 0)),
        sub: `${v.length} trip${v.length === 1 ? '' : 's'}`,
      });
    }
    return {
      trips: done.length,
      spent,
      saved,
      distance,
      favType: favType ? { type: favType[0], share: favType[1] / done.length } : null,
      favPlace: favPlace ? { name: favPlace[0], count: favPlace[1] } : null,
      avgRating: rated.length ? rated.reduce((a, r) => a + r.rating, 0) / rated.length : null,
      weeks,
    };
  }, [rides]);

  async function cancelScheduled(id) {
    try {
      await api(`/rides/${id}/cancel`, { method: 'POST', body: { reason: 'Cancelled scheduled ride' } });
      toast('Scheduled ride cancelled', 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function bookAgain(r) {
    navigate('/ride', {
      state: {
        rebook: {
          pickup: { lat: r.pickup_lat, lng: r.pickup_lng, name: placeName(r.pickup_address), address: r.pickup_address },
          drop: { lat: r.drop_lat, lng: r.drop_lng, name: placeName(r.drop_address), address: r.drop_address },
          vehicle: r.vehicle_type,
        },
      },
    });
  }

  useStaggerIn(pageRef, rides ? `${filter}` : null, { selector: '.hist-hero, .hist-insights > *, .hist-filterbar, .hist-month, .hist-ride', y: 26, rotationX: -14, stagger: 0.035 });
  if (!rides) return <PageLoading />;
  const fav = insights.favType;

  return (
    <div className="page hist" ref={pageRef}>
      <section className="hist-hero">
        <div className="hist-hero-main">
          <span className="eyebrow">Your journeys</span>
          <h1 className="mt-8">My rides</h1>
          <p className="muted mt-8">Every trip, receipt and upcoming booking in one place.</p>
          <div className="hist-stats">
            <div><span>Trips</span><CountUp className="hist-stat-value" value={insights.trips} format={fmtInt} /></div>
            <div><span>Total spent</span><CountUp className="hist-stat-value" value={insights.spent} format={fmtInr} /></div>
            <div><span>Distance</span><CountUp className="hist-stat-value" value={insights.distance} format={fmtKm} /></div>
            <div><span>Promo savings</span><CountUp className="hist-stat-value saved" value={insights.saved} format={fmtInr} /></div>
          </div>
          <Link className="btn btn-primary mt-24" to="/ride"><Car size={17} /> Book a ride</Link>
        </div>
        <div className="hist-hero-chart">
          <div className="row-between">
            <span className="small bold">Spending</span>
            <span className="tiny muted">last 8 weeks</span>
          </div>
          <BarChart data={insights.weeks} height={190} color="#3d8eff" format={(v) => inr(v)} label="Weekly spending" labelEvery={1} />
        </div>
      </section>

      <div className="hist-insights">
        <div className="hist-insight">
          {fav ? <VehicleArt type={fav.type} size={64} /> : <span className="hist-insight-icon"><Car size={18} /></span>}
          <div>
            <span className="tiny muted">Most booked</span>
            <b>{fav ? VEHICLE_META[fav.type].name : '—'}</b>
            <span className="tiny muted">{fav ? `${Math.round(fav.share * 100)}% of your trips` : 'No trips yet'}</span>
          </div>
        </div>
        <div className="hist-insight">
          <span className="hist-insight-icon pink"><MapPin size={18} /></span>
          <div>
            <span className="tiny muted">Favourite destination</span>
            <b className="ellipsis">{insights.favPlace?.name || '—'}</b>
            <span className="tiny muted">{insights.favPlace ? `${insights.favPlace.count} trips` : 'Book a ride to start'}</span>
          </div>
        </div>
        <div className="hist-insight">
          <span className="hist-insight-icon amber"><Star size={18} /></span>
          <div>
            <span className="tiny muted">Your average rating</span>
            <b>{insights.avgRating ? insights.avgRating.toFixed(1) : '—'}</b>
            <span className="tiny muted">given to drivers</span>
          </div>
        </div>
      </div>

      <div className="card hist-filterbar">
        <div className="chip-filter" role="group" aria-label="Filter rides">
          {FILTERS.map(([k, label]) => (
            <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
              {label} <span className="chip-count">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="input-icon" style={{ width: 280, maxWidth: '100%' }}>
          <Search size={16} />
          <input className="input" style={{ height: 40 }} placeholder="Search places, driver or #id" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="empty card hist-empty">
          <CalendarClock size={40} />
          <div className="bold">{query ? 'No rides match your search' : 'No rides here yet'}</div>
          <div className="small muted">{filter === 'scheduled' ? 'Schedule a ride from the booking screen to see it here.' : 'Your trips will appear here after you ride.'}</div>
          <Link className="btn btn-primary mt-16" to="/ride"><Car size={16} /> Book a ride</Link>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="hist-group">
            <div className="hist-month">
              <span className="hist-month-dot" />
              <b>{g.label}</b>
              <span className="tiny muted">{g.rides.length} ride{g.rides.length === 1 ? '' : 's'}{g.spent ? ` · ${inr(g.spent)} spent` : ''}</span>
            </div>
            <div className="hist-list">
              {g.rides.map((r) => (
                <RideCard
                  key={r.id}
                  r={r}
                  onRefund={() => setRefundFor(r)}
                  onCancel={() => cancelScheduled(r.id)}
                  onRebook={() => bookAgain(r)}
                />
              ))}
            </div>
          </section>
        ))
      )}
      <RefundModal ride={refundFor} onClose={() => setRefundFor(null)} onDone={() => { setRefundFor(null); load(); }} />
    </div>
  );
}

function RideCard({ r, onRefund, onCancel, onRebook }) {
  const upcoming = r.status === 'scheduled';
  const ended = ['cancelled', 'no_driver'].includes(r.status);
  const charged = r.status === 'completed' || r.cancellation_fee > 0;
  const t = when(r);
  const fare = r.status === 'completed' ? inr(r.final_fare) : r.cancellation_fee > 0 ? inr(r.cancellation_fee) : upcoming ? `~${inr(r.est_fare)}` : '—';
  const fareNote = r.status === 'completed' ? PAYMENT_LABEL[r.payment_method]?.split(' ')[0] : r.cancellation_fee > 0 ? 'cancellation fee' : upcoming ? 'estimated' : 'no charge';
  return (
    <article className={`hist-ride ${upcoming ? 'upcoming' : ''} ${ended ? 'ended' : ''}`}>
      <div className="hist-ride-photo">
        <VehicleArt type={r.vehicle_type} size={104} />
        <span className="hist-ride-type">{VEHICLE_META[r.vehicle_type]?.name}</span>
      </div>
      <div className="hist-ride-main">
        <div className="row wrap gap-8">
          <span className="bold">{dayLabel(t)}</span>
          <span className="tiny muted">{timeOnly(t)} · #{r.id}</span>
          <StatusBadge status={r.status} />
          {upcoming && <span className="badge badge-primary"><Clock3 size={12} /> {startsIn(r.scheduled_at)}</span>}
        </div>
        <div className="hist-route">
          <span className="loc-dot pickup" />
          <span className="ellipsis">{shortAddress(r.pickup_address)}</span>
          <span className="hist-route-line" />
          <span />
          <span className="loc-dot drop" />
          <span className="ellipsis">{shortAddress(r.drop_address)}</span>
        </div>
        <div className="hist-meta">
          <span><RouteIcon size={13} /> {km(r.distance_km)}</span>
          {r.driver_name && <span><Car size={13} /> {r.driver_name}</span>}
          {r.rating > 0 && (
            <span className="stars-mini" aria-label={`Rated ${r.rating} of 5`}>
              {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={12} fill={n <= r.rating ? '#fbbf24' : 'none'} color={n <= r.rating ? '#fbbf24' : '#4b5060'} />)}
            </span>
          )}
          {r.promo_code && <span className="promo"><BadgePercent size={13} /> {r.promo_code} −{inr(r.discount)}</span>}
          {r.refund_status && <span className={`refund ${r.refund_status}`}><RotateCcw size={13} /> Refund {r.refund_status}</span>}
          {r.payment_status === 'due' && <span className="due"><IndianRupee size={13} /> Payment due</span>}
        </div>
      </div>
      <div className="hist-ride-side">
        <div className="hist-fare">
          <b>{fare}</b>
          <span className="tiny muted">{fareNote}</span>
        </div>
        <div className="hist-actions">
          {upcoming && <button className="btn btn-sm btn-soft-danger" onClick={onCancel}>Cancel</button>}
          {charged && !r.refund_status && (
            <button className="btn btn-sm btn-ghost" onClick={onRefund}><RotateCcw size={14} /> Refund</button>
          )}
          {charged && <Link className="btn btn-sm btn-ghost" to={`/receipt/${r.id}`}><Receipt size={14} /> Receipt</Link>}
          {!upcoming && r.drop_lat != null && (
            <button className="btn btn-sm btn-primary" onClick={onRebook}>Book again <ArrowRight size={14} /></button>
          )}
        </div>
      </div>
    </article>
  );
}

const REFUND_REASONS = ['Driver took a longer route', 'Charged more than estimate', 'Driver was rude or unsafe', 'Trip was not completed', 'Unfair cancellation fee'];

function RefundModal({ ride, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const paid = ride ? (ride.status === 'completed' ? ride.final_fare : ride.cancellation_fee) : 0;

  async function submit() {
    setBusy(true);
    try {
      await api(`/rides/${ride.id}/refund`, {
        method: 'POST',
        body: { reason: [reason, details].filter(Boolean).join(' — '), amount: amount ? Number(amount) : undefined },
      });
      toast('Refund request submitted. You will be notified once it is reviewed.', 'success');
      setReason('');
      setDetails('');
      setAmount('');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={!!ride} onClose={onClose} title={`Request a refund · ride #${ride?.id}`}>
      <div className="col gap-16">
        <div className="small muted">Amount charged: <b className="text-2">{inr(paid, 2)}</b>. Approved refunds are credited to your RideFlow wallet.</div>
        <div className="row wrap gap-8">
          {REFUND_REASONS.map((r) => (
            <button key={r} className="chip" style={reason === r ? { borderColor: 'var(--primary)', background: 'var(--primary-soft)' } : undefined} onClick={() => setReason(r)}>
              {r}
            </button>
          ))}
        </div>
        <textarea className="textarea" placeholder="Tell us what happened" value={details} onChange={(e) => setDetails(e.target.value)} />
        <label className="field">
          <span className="label">Amount (optional, defaults to full)</span>
          <input className="input" type="number" min="1" max={paid} step="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(paid)} />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy || (!reason && details.trim().length < 5)} onClick={submit}>
          {busy ? <Spinner /> : 'Submit request'}
        </button>
      </div>
    </Modal>
  );
}
