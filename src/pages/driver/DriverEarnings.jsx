import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Banknote, Car, CreditCard, Gauge, Pencil, Receipt, Route as RouteIcon, Star, Target, Trophy, Wallet, XCircle,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../lib/toast.jsx';
import { VEHICLE_META, inr, km, shortAddress, timeOnly } from '../../lib/format.js';
import { BarChart, StackBar } from '../../components/Charts.jsx';
import { PageLoading, VehicleArt } from '../../components/ui.jsx';
import { CountUp, TiltCard, gsap, reducedMotion, useGSAP, useStaggerIn } from '../../lib/motion.jsx';

const PERIODS = [['today', 'Today'], ['week', '7 days'], ['month', '30 days'], ['allTime', 'All time']];
const PERIOD_LABEL = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', allTime: 'All time' };
const GOAL_KEY = 'rideflow:driver-goal';
const PAY_ICON = { cash: Banknote, wallet: Wallet, card: CreditCard };
const PAY_COLOR = { cash: '#22c55e', wallet: '#3d8eff', card: '#a78bfa' };
const PAY_NAME = { cash: 'Cash', wallet: 'Wallet', card: 'Card' };

function readGoal() {
  try {
    const v = Number(localStorage.getItem(GOAL_KEY));
    return v > 0 ? v : 1500;
  } catch {
    return 1500;
  }
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
}

/** Ring showing today's earnings against a daily goal the driver sets. */
function GoalRing({ value, goal }) {
  const ref = useRef(null);
  const size = 132;
  const stroke = 11;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const pct = Math.min(1, goal ? value / goal : 0);
  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(ref.current.querySelector('.ern-ring-fill'), { strokeDashoffset: C, duration: 1.4, ease: 'expo.out', delay: 0.2 });
    },
    { dependencies: [pct], scope: ref },
  );
  return (
    <div className="ern-ring" ref={ref} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id="ernRing" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4ade80" />
            <stop offset="100%" stopColor="#22c55e" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth={stroke} />
        <circle
          className="ern-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="url(#ernRing)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ern-ring-center">
        <b>{Math.round(pct * 100)}%</b>
        <span>of goal</span>
      </div>
    </div>
  );
}

function GoalCard({ today }) {
  const [goal, setGoal] = useState(readGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const left = Math.max(0, goal - today);

  function save(e) {
    e.preventDefault();
    const v = Math.round(Number(draft));
    if (v > 0) {
      setGoal(v);
      try {
        localStorage.setItem(GOAL_KEY, String(v));
      } catch {
        /* goal just won't persist */
      }
    }
    setEditing(false);
  }

  return (
    <div className="card ern-goal">
      <div className="row-between">
        <span className="ern-card-title"><Target size={16} /> Today's goal</span>
        {!editing && (
          <button type="button" className="icon-btn" style={{ width: 32, height: 32 }} onClick={() => { setDraft(String(goal)); setEditing(true); }} aria-label="Edit daily goal">
            <Pencil size={14} />
          </button>
        )}
      </div>
      <div className="ern-goal-body">
        <GoalRing value={today} goal={goal} />
        <div className="col gap-4" style={{ minWidth: 0 }}>
          <span className="ern-goal-value">{inr(today)}</span>
          <span className="small muted">of {inr(goal)} target</span>
          {editing ? (
            <form className="ern-goal-form" onSubmit={save}>
              <span>₹</span>
              <input className="input" type="number" min="100" step="50" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Daily goal in rupees" autoFocus />
              <button className="btn btn-primary btn-sm">Save</button>
            </form>
          ) : (
            <span className={`ern-goal-left ${left === 0 ? 'done' : ''}`}>
              {left === 0 ? <><Trophy size={14} /> Goal reached. Nice work!</> : <>{inr(left)} to go</>}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TripRow({ r }) {
  const done = r.status === 'completed';
  const PayIcon = PAY_ICON[r.payment_method] || Banknote;
  return (
    <div className={`ern-trip ${done ? '' : 'cancelled'}`}>
      <div className="ern-trip-art">
        {done ? <VehicleArt type={r.vehicle_type} size={64} /> : <span className="ern-trip-x"><XCircle size={22} /></span>}
      </div>
      <div className="ern-trip-main">
        <div className="ern-trip-route">
          <span className="ellipsis">{shortAddress(r.pickup_address).split(',')[0]}</span>
          <ArrowRight size={13} />
          <span className="ellipsis">{shortAddress(r.drop_address).split(',')[0]}</span>
        </div>
        <div className="ern-trip-meta">
          <span>{timeOnly(r.completed_at || r.cancelled_at)}</span>
          {done && <span>{km(r.distance_km)}</span>}
          {done && <span>{VEHICLE_META[r.vehicle_type]?.name}</span>}
          {done ? (
            <span className={`ern-pay ${r.payment_method}`}><PayIcon size={12} /> {PAY_NAME[r.payment_method] || r.payment_method}</span>
          ) : (
            <span className="ern-pay cancel">{r.cancellation_fee > 0 ? 'Cancellation fee' : 'Cancelled'}</span>
          )}
          {r.rating ? <span className="ern-rated"><Star size={12} fill="#fbbf24" color="#fbbf24" /> {r.rating}</span> : null}
        </div>
      </div>
      <div className="ern-trip-money">
        <b className={r.driver_earning > 0 ? 'pos' : ''}>{r.driver_earning > 0 ? '+' : ''}{inr(r.driver_earning || 0, 2)}</b>
        {done && <span>Rider paid {inr(r.final_fare)} · {inr(r.commission, 2)} commission</span>}
      </div>
      {done ? (
        <Link className="icon-btn ern-trip-receipt" to={`/receipt/${r.id}`} aria-label={`Receipt for trip ${r.id}`} title="Receipt"><Receipt size={16} /></Link>
      ) : <span className="ern-trip-receipt" />}
    </div>
  );
}

export default function DriverEarnings() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [period, setPeriod] = useState('week');
  const [filter, setFilter] = useState('all');
  const pageRef = useRef(null);
  useStaggerIn(pageRef, data ? 'ready' : null, { selector: '.ern-hero, .ern-goal, .kpi-grid > *, .ern-grid > *, .ern-trips', y: 28, rotationX: -16, stagger: 0.05 });

  useEffect(() => {
    api('/driver/earnings').then(setData).catch((e) => toast(e.message, 'error'));
  }, [toast]);

  const groups = useMemo(() => {
    if (!data) return [];
    const rows = data.recent.filter((r) => filter === 'all' || r.status === filter);
    const out = [];
    for (const r of rows) {
      const label = dayLabel(r.completed_at || r.cancelled_at);
      const g = out[out.length - 1];
      if (g && g.label === label) {
        g.rows.push(r);
        g.total += r.driver_earning || 0;
      } else out.push({ label, rows: [r], total: r.driver_earning || 0 });
    }
    return out;
  }, [data, filter]);

  if (!data) return <PageLoading />;
  const p = data[period];
  // Drivers earn on the fare before tax and promo discounts (the platform absorbs promos),
  // so the honest split is earnings vs commission, not a share of what the rider paid.
  const tripValue = p.earnings + p.commission;
  const keepPct = tripValue > 0 ? Math.round((p.earnings / tripValue) * 100) : 0;
  const perTrip = p.trips ? p.earnings / p.trips : 0;
  const perKm = p.distance ? p.earnings / p.distance : 0;
  const rating = Number(data.rating.rating_avg || 0);

  const chart = data.daily.map((d) => {
    const dt = new Date(d.date);
    return {
      label: dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }),
      short: dt.toLocaleDateString('en-IN', { weekday: 'short' }),
      value: d.earnings,
      sub: `${d.trips} trip${d.trips === 1 ? '' : 's'}`,
    };
  });
  const best = data.daily.reduce((b, d) => (d.earnings > (b?.earnings ?? 0) ? d : b), null);
  const activeDays = data.daily.filter((d) => d.trips > 0).length;

  // payment mix over the recent completed trips
  const completed = data.recent.filter((r) => r.status === 'completed');
  const mix = ['cash', 'wallet', 'card']
    .map((m) => ({ label: PAY_NAME[m], value: completed.filter((r) => r.payment_method === m).reduce((a, r) => a + (r.final_fare || 0), 0), color: PAY_COLOR[m] }))
    .filter((x) => x.value > 0);
  const counts = { all: data.recent.length, completed: completed.length, cancelled: data.recent.length - completed.length };

  return (
    <div className="page ern" ref={pageRef}>
      <div className="ern-top">
        <TiltCard className="ern-hero" max={3} lift={0}>
          <div className="ern-hero-head">
            <span className="ern-hero-eyebrow"><Wallet size={14} /> Net earnings · {PERIOD_LABEL[period]}</span>
            <div className="ern-periods" role="tablist" aria-label="Earnings period">
              {PERIODS.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={period === k} className={period === k ? 'active' : ''} onClick={() => setPeriod(k)}>{l}</button>
              ))}
            </div>
          </div>
          <CountUp className="ern-hero-value" value={p.earnings} format={(n) => inr(n, 2)} />
          <div className="ern-hero-sub">
            after {inr(p.commission, 2)} platform commission · {p.trips} trip{p.trips === 1 ? '' : 's'} · {km(p.distance)}
          </div>
          <div className="ern-keep">
            <div className="ern-keep-bar" role="img" aria-label={`You keep ${keepPct}% of fares`}>
              <span style={{ width: `${keepPct}%` }} />
            </div>
            <div className="ern-keep-legend">
              {tripValue > 0 ? (
                <>
                  <span><i className="you" /> You keep {keepPct}% · {inr(p.earnings, 2)}</span>
                  <span><i className="fee" /> Commission {100 - keepPct}%</span>
                </>
              ) : (
                <span>No completed fares {period === 'today' ? 'yet today' : 'in this period'}. Go online to start earning.</span>
              )}
            </div>
          </div>
        </TiltCard>
        <GoalCard today={data.today.earnings} />
      </div>

      <div className="kpi-grid">
        <div className="card kpi ern-kpi" style={{ '--kc': '#3d8eff' }}>
          <span className="kpi-icon"><Car size={18} /></span>
          <span className="kpi-label">Completed trips</span>
          <CountUp className="kpi-value" value={p.trips} />
          <span className="small muted">{PERIOD_LABEL[period].toLowerCase()}</span>
        </div>
        <div className="card kpi ern-kpi" style={{ '--kc': '#22c55e' }}>
          <span className="kpi-icon"><Gauge size={18} /></span>
          <span className="kpi-label">Average per trip</span>
          <CountUp className="kpi-value" value={perTrip} format={(n) => inr(n)} />
          <span className="small muted">net, after commission</span>
        </div>
        <div className="card kpi ern-kpi" style={{ '--kc': '#a78bfa' }}>
          <span className="kpi-icon"><RouteIcon size={18} /></span>
          <span className="kpi-label">Earned per km</span>
          <CountUp className="kpi-value" value={perKm} format={(n) => inr(n, 1)} />
          <span className="small muted">{km(p.distance)} driven</span>
        </div>
        <div className="card kpi ern-kpi" style={{ '--kc': '#fbbf24' }}>
          <span className="kpi-icon"><Star size={18} /></span>
          <span className="kpi-label">Driver rating</span>
          <span className="kpi-value row gap-8">
            {rating.toFixed(2)}
            <span className="ern-stars" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={13} fill={n <= Math.round(rating) ? '#fbbf24' : 'transparent'} color="#fbbf24" />)}
            </span>
          </span>
          <span className="small muted">{data.rating.rating_count} ratings</span>
        </div>
      </div>

      <div className="ern-grid">
        <div className="card ern-chart">
          <div className="row-between" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <span className="ern-card-title">Last 7 days</span>
              <div className="ern-chart-total">{inr(data.week.earnings, 2)}</div>
            </div>
            <div className="ern-chart-facts">
              <div><span>Best day</span><b>{best ? `${new Date(best.date).toLocaleDateString('en-IN', { weekday: 'short' })} · ${inr(best.earnings)}` : '—'}</b></div>
              <div><span>Daily average</span><b>{inr(activeDays ? data.week.earnings / activeDays : 0)}</b></div>
              <div><span>Days driven</span><b>{activeDays} / 7</b></div>
            </div>
          </div>
          <div className="mt-16">
            <BarChart data={chart} height={230} color="#22c55e" format={(v) => inr(v, 2)} label="Daily earnings" />
          </div>
        </div>

        <div className="card ern-split">
          <span className="ern-card-title">Where the fare goes</span>
          <p className="small muted" style={{ marginTop: 4 }}>{PERIOD_LABEL[period]} · {inr(tripValue, 2)} trip value before tax</p>
          <div className="mt-16">
            <StackBar
              rows={[
                { label: 'Your earnings', value: p.earnings, color: '#22c55e' },
                { label: 'Platform commission', value: p.commission, color: '#5b6170' },
              ].filter((x) => x.value > 0)}
              format={(v) => inr(v, 2)}
              ariaLabel="Your earnings versus platform commission"
            />
          </div>
          <p className="tiny muted" style={{ marginTop: 10 }}>Promo discounts are covered by RideFlow, so you always earn on the full fare. GST is collected separately.</p>
          <div className="ern-cash">
            <Banknote size={18} />
            <div className="grow">
              <div className="bold small">{inr(p.cash_collected, 2)} collected in cash</div>
              <div className="tiny muted">Riders paid these fares to you directly, so this money is already in your hand.</div>
            </div>
          </div>
          {mix.length > 0 && (
            <>
              <div className="ern-sub-title">Payment mix · last {completed.length} trips</div>
              <div className="ern-mix">
                {mix.map((m) => {
                  const total = mix.reduce((a, x) => a + x.value, 0);
                  return (
                    <div key={m.label}>
                      <span className="row gap-8 small"><span className="dot" style={{ background: m.color }} />{m.label}</span>
                      <span className="ern-mix-bar"><span style={{ width: `${(m.value / total) * 100}%`, background: m.color }} /></span>
                      <b className="small">{Math.round((m.value / total) * 100)}%</b>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card ern-trips">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <span className="ern-card-title">Trip earnings</span>
            <p className="small muted" style={{ marginTop: 4 }}>Your last {data.recent.length} trips, newest first.</p>
          </div>
          <div className="chip-filter" role="tablist" aria-label="Filter trips">
            {[['all', 'All'], ['completed', 'Completed'], ['cancelled', 'Cancelled']].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
                {l} <span className="ern-count">{counts[k]}</span>
              </button>
            ))}
          </div>
        </div>
        {groups.length === 0 ? (
          <div className="empty">
            <Car size={34} />
            <div>{data.recent.length ? 'No trips match this filter.' : 'No trips yet. Go online to start earning.'}</div>
            {!data.recent.length && <Link to="/driver" className="btn btn-primary mt-16">Go to dashboard</Link>}
          </div>
        ) : (
          <div className="ern-days">
            {groups.map((g) => (
              <section key={g.label} className="ern-day">
                <div className="ern-day-head">
                  <span>{g.label}</span>
                  <b>{inr(g.total, 2)}</b>
                </div>
                {g.rows.map((r) => <TripRow key={r.id} r={r} />)}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
