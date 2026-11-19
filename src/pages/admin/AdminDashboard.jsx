import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BadgePercent, Car, CheckCircle2, Copy, Download, Gauge, IndianRupee,
  LayoutDashboard, Mail, MapPin, Plus, Radio, RotateCcw, Search, Siren, Star, Users, Wifi,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { isSocketConnected, useSocketConnection, useSocketEvent } from '../../lib/socket.js';
import { useToast } from '../../lib/toast.jsx';
import { DEFAULT_CENTER } from '../../lib/geo.js';
import { PAYMENT_LABEL, VEHICLE_META, VEHICLE_TYPES, dateTime, initials, inr, km, shortAddress } from '../../lib/format.js';
import { BarChart, Donut, LineChart, Sparkline, StackBar } from '../../components/Charts.jsx';
import { CarMarker, FitBounds, MapView, PinMarker } from '../../components/MapView.jsx';
import { Modal, PageLoading, Spinner, StatusBadge, VehicleArt } from '../../components/ui.jsx';
import { CountUp, TiltCard, useStaggerIn } from '../../lib/motion.jsx';

const TABS = [
  ['overview', 'Overview', LayoutDashboard, 'Performance, revenue and demand at a glance.'],
  ['live', 'Live map', MapPin, 'Every online driver and active trip, in real time.'],
  ['rides', 'Rides', Car, 'Search and audit every ride on the platform.'],
  ['users', 'Users', Users, 'Passengers, drivers and admins.'],
  ['promos', 'Promos', BadgePercent, 'Create and manage discount campaigns.'],
  ['refunds', 'Refunds', RotateCcw, 'Review refund requests from riders.'],
  ['sos', 'SOS', Siren, 'Safety alerts raised during rides.'],
  ['emails', 'Emails', Mail, 'Every notification the platform has sent.'],
];

// categorical palette slots 1–3 (validated order) for payment methods
const PAYMENT_COLORS = { cash: '#3987e5', wallet: '#d95926', card: '#199e70' };
const fmtInr = (n) => inr(n);
const fmtInt = (n) => Math.round(n).toLocaleString('en-IN');
const fmtPct = (n) => `${Math.round(n * 100)}%`;
const fmtRating = (n) => n.toFixed(2);

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function AdminDashboard() {
  const toast = useToast();
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [counts, setCounts] = useState({});
  const [liveTick, setLiveTick] = useState(0);
  const [pulse, setPulse] = useState(null);
  const [connected, setConnected] = useState(isSocketConnected());

  useSocketConnection(setConnected);
  useSocketEvent('sos:new', (a) => {
    toast(`${a.user_name} (${a.role}) triggered SOS${a.ride_id ? ` on ride #${a.ride_id}` : ''}`, 'error', 'SOS alert');
    setCounts((c) => ({ ...c, open_sos: (c.open_sos || 0) + 1 }));
  });
  useSocketEvent('admin:event', (e) => {
    if (e.type === 'refund_requested') setCounts((c) => ({ ...c, pending_refunds: (c.pending_refunds || 0) + 1 }));
    setLiveTick((t) => t + 1);
  });

  // live pulse in the header (rides in flight, drivers online)
  useEffect(() => {
    let alive = true;
    const load = () => api('/admin/live').then((d) => alive && setPulse({ rides: d.rides.length, drivers: d.drivers.length })).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [liveTick]);

  const current = TABS.find((t) => t[0] === tab);
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="admin">
      <aside className="admin-side">
        <div className="admin-side-title">Operations</div>
        <nav className="admin-nav" role="tablist" aria-orientation="vertical" aria-label="Admin sections">
          {TABS.map(([k, label, Icon]) => {
            const badge = k === 'sos' ? counts.open_sos : k === 'refunds' ? counts.pending_refunds : 0;
            return (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                <span className="admin-nav-icon"><Icon size={17} /></span>
                <span className="grow">{label}</span>
                {badge > 0 && <span className={`admin-nav-badge ${k === 'sos' ? 'danger' : 'warning'}`}>{badge}</span>}
              </button>
            );
          })}
        </nav>
        <div className="admin-side-card">
          <div className="tiny muted bold" style={{ letterSpacing: '.08em', textTransform: 'uppercase' }}>System status</div>
          <div className="sys-row"><span className="sys-dot ok" /> API <span className="muted">operational</span></div>
          <div className="sys-row"><span className={`sys-dot ${connected ? 'ok' : 'bad'}`} /> Realtime <span className="muted">{connected ? 'connected' : 'reconnecting'}</span></div>
          <div className="sys-row"><span className="sys-dot ok" /> Dispatch <span className="muted">{pulse ? `${pulse.drivers} drivers` : '—'}</span></div>
        </div>
      </aside>

      <section className="admin-main">
        <header className="admin-head">
          <div>
            <span className="eyebrow">{greeting()}, {user?.name} · {today}</span>
            <h1 className="mt-8">{current[1] === 'Overview' ? 'Operations overview' : current[1]}</h1>
            <p className="muted mt-8">{current[3]}</p>
          </div>
          <div className="admin-pulse">
            <span className="live-dot" />
            <span><b className="mono">{pulse?.rides ?? '—'}</b> live rides</span>
            <span className="chip-sep" />
            <span><b className="mono">{pulse?.drivers ?? '—'}</b> drivers online</span>
          </div>
        </header>

        {tab === 'overview' && <Overview onCounts={setCounts} liveTick={liveTick} />}
        {tab === 'live' && <LiveMap />}
        {tab === 'rides' && <RidesTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'promos' && <PromosTab />}
        {tab === 'refunds' && <RefundsTab onChange={() => setCounts((c) => ({ ...c, pending_refunds: Math.max(0, (c.pending_refunds || 1) - 1) }))} />}
        {tab === 'sos' && <SosTab onChange={() => setCounts((c) => ({ ...c, open_sos: Math.max(0, (c.open_sos || 1) - 1) }))} />}
        {tab === 'emails' && <EmailsTab />}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- overview

/** Change vs the previous period. Hidden behind 'no prior data' when that period is too thin to compare. */
function Delta({ cur, prev, points = false, enough = true }) {
  if (!enough || prev == null || cur == null || (!points && !prev)) return <span className="delta flat">no prior data</span>;
  const diff = points ? (cur - prev) * 100 : ((cur - prev) / prev) * 100;
  const up = diff >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`delta ${Math.abs(diff) < 0.5 ? 'flat' : up ? 'up' : 'down'}`}>
      <Icon size={13} /> {Math.abs(diff) > 999 ? '>999' : Math.abs(diff).toFixed(Math.abs(diff) < 10 ? 1 : 0)}{points ? ' pts' : '%'}
      <span className="muted"> vs prev.</span>
    </span>
  );
}

function KpiCard({ icon: Icon, label, value, format, sub, delta, spark, color }) {
  return (
    <TiltCard className="card kpi" max={6} lift={10}>
      <div className="row-between">
        <span className="kpi-icon" style={{ '--kc': color }}><Icon size={17} /></span>
        {delta}
      </div>
      <div className="kpi-label">{label}</div>
      <CountUp className="kpi-value" value={value} format={format} />
      {sub && <div className="stat-sub">{sub}</div>}
      <div className="kpi-spark"><Sparkline values={spark} color={color} /></div>
    </TiltCard>
  );
}

function OpsTile({ icon: Icon, label, value, sub, tone }) {
  return (
    <div className={`ops-tile ${tone || ''}`}>
      <span className="ops-icon"><Icon size={16} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ops-label">{label}</div>
        <div className="ops-value">{value}</div>
        {sub && <div className="tiny muted ellipsis">{sub}</div>}
      </div>
    </div>
  );
}

function Overview({ onCounts, liveTick }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [view, setView] = useState('chart');
  const [metric, setMetric] = useState('rides');
  const overviewRef = useRef(null);
  useStaggerIn(overviewRef, data ? `${days}-${view}` : null, { selector: '.kpi-grid > *, .ops-strip, .ov-grid > .card, .ov-full', y: 30, rotationX: -16, stagger: 0.05 });

  const load = useCallback(() => {
    api(`/admin/analytics?days=${days}`)
      .then((d) => {
        setData(d);
        onCounts(d.kpis);
      })
      .catch((e) => toast(e.message, 'error'));
  }, [days, onCounts, toast]);
  useEffect(() => {
    load();
  }, [load]);
  // refresh when rides complete / new requests arrive (debounced)
  const t = useRef(null);
  useEffect(() => {
    if (!liveTick) return undefined;
    clearTimeout(t.current);
    t.current = setTimeout(load, 1500);
    return () => clearTimeout(t.current);
  }, [liveTick, load]);

  if (!data) return <PageLoading />;
  const k = data.kpis;
  const p = data.previous || {};
  // Only compare when the previous window has a meaningful amount of activity.
  const comparable = (p.totalRides || 0) >= Math.max(5, k.totalRides * 0.25);
  const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const every = days > 14 ? Math.ceil(days / 8) : 1;
  const series = {
    rides: data.daily.map((d) => d.rides),
    revenue: data.daily.map((d) => d.revenue),
    commission: data.daily.map((d) => d.commission),
    completion: data.daily.map((d) => (d.rides ? d.completed / d.rides : 0)),
  };
  const trend = {
    rides: { label: 'Rides', total: fmtInt(k.totalRides), data: data.daily.map((d) => ({ label: fmtDay(d.date), short: fmtDay(d.date), value: d.rides, sub: `${d.completed} completed · ${d.cancelled} cancelled` })) },
    revenue: { label: 'Revenue', total: inr(k.gmv), data: data.daily.map((d) => ({ label: fmtDay(d.date), short: fmtDay(d.date), value: d.revenue, sub: `Commission ${inr(d.commission)}` })) },
    commission: { label: 'Commission', total: inr(k.commission), data: data.daily.map((d) => ({ label: fmtDay(d.date), short: fmtDay(d.date), value: d.commission, sub: `Revenue ${inr(d.revenue)}` })) },
  }[metric];
  const hours = data.byHour.map((h) => ({ label: `${String(h.hour).padStart(2, '0')}:00–${String(h.hour).padStart(2, '0')}:59`, short: String(h.hour), value: h.rides }));
  const peak = data.byHour.reduce((a, b) => (b.rides > a.rides ? b : a), data.byHour[0]);
  const catRows = data.byVehicle.map((v) => ({ label: VEHICLE_META[v.type].name, value: v.revenue, color: VEHICLE_META[v.type].hex, type: v.type, rides: v.rides }));
  const payRows = ['cash', 'wallet', 'card']
    .map((m) => data.byPayment.find((x) => x.method === m))
    .filter(Boolean)
    .map((x) => ({ label: x.method[0].toUpperCase() + x.method.slice(1), value: x.amount, color: PAYMENT_COLORS[x.method] }));
  const maxEarn = Math.max(1, ...data.topDrivers.map((d) => d.earnings));

  return (
    <div className="col gap-16" ref={overviewRef}>
      <div className="row-between wrap admin-toolbar">
        <div className="segmented" style={{ minWidth: 260 }}>
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>Last {d} days</button>
          ))}
        </div>
        <div className="row gap-8">
          <div className="segmented">
            <button className={view === 'chart' ? 'active' : ''} onClick={() => setView('chart')}>Charts</button>
            <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>Table</button>
          </div>
          <CsvButton />
        </div>
      </div>

      <div className="kpi-grid">
        <KpiCard icon={Car} label="Rides" value={k.totalRides} format={fmtInt} color="#3d8eff" spark={series.rides}
          sub={`${k.completed} completed · ${k.cancelled} cancelled`} delta={<Delta cur={k.totalRides} prev={p.totalRides} enough={comparable} />} />
        <KpiCard icon={IndianRupee} label="Gross bookings" value={k.gmv} format={fmtInr} color="#22c55e" spark={series.revenue}
          sub={`Avg fare ${inr(k.avgFare)}`} delta={<Delta cur={k.gmv} prev={p.gmv} enough={comparable} />} />
        <KpiCard icon={Gauge} label="Platform net revenue" value={k.platformNet} format={fmtInr} color="#a78bfa" spark={series.commission}
          sub={`${inr(k.commission)} commission − ${inr(k.discounts + k.refunded)} promos & refunds`} delta={<Delta cur={k.platformNet} prev={p.platformNet} enough={comparable} />} />
        <KpiCard icon={CheckCircle2} label="Completion rate" value={k.completionRate} format={fmtPct} color="#f5a524" spark={series.completion}
          sub={`${k.cancelled} cancelled or unmatched`} delta={<Delta cur={k.completionRate} prev={p.completionRate} points enough={comparable} />} />
      </div>

      <div className="ops-strip card">
        <OpsTile icon={Radio} label="Live rides" value={<CountUp value={k.live_rides} format={fmtInt} />} sub={`${k.scheduled_rides} scheduled`} tone="blue" />
        <OpsTile icon={Wifi} label="Drivers online" value={<CountUp value={k.online_drivers} format={fmtInt} />} sub={`${k.drivers} real · ${k.bot_drivers} simulated`} tone="green" />
        <OpsTile icon={Users} label="Passengers" value={<CountUp value={k.passengers} format={fmtInt} />} sub="registered riders" />
        <OpsTile icon={Star} label="Avg rating" value={k.avgRating ? <CountUp value={k.avgRating} format={fmtRating} /> : '—'} sub={`Payouts ${inr(k.driverPayout)}`} tone="amber" />
        <OpsTile icon={AlertTriangle} label="Needs attention" value={k.open_sos + k.pending_refunds} sub={`${k.open_sos} SOS · ${k.pending_refunds} refunds`} tone={k.open_sos ? 'red' : ''} />
      </div>

      {view === 'chart' ? (
        <>
          <div className="ov-grid">
            <div className="card">
              <div className="row-between wrap">
                <div>
                  <h3>{trend.label} trend</h3>
                  <div className="trend-total mt-8">{trend.total} <span className="tiny muted">in the last {days} days</span></div>
                </div>
                <div className="segmented">
                  {[['rides', 'Rides'], ['revenue', 'Revenue'], ['commission', 'Commission']].map(([key, l]) => (
                    <button key={key} className={metric === key ? 'active' : ''} onClick={() => setMetric(key)}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="mt-16">
                {metric === 'rides' ? (
                  <BarChart key="rides" data={trend.data} label="Rides per day" format={(v) => `${v} rides`} labelEvery={every} height={300} />
                ) : (
                  <LineChart key={metric} data={trend.data} label={trend.label} color={metric === 'revenue' ? '#22c55e' : '#a78bfa'} format={(v) => inr(v)} labelEvery={every} height={300} />
                )}
              </div>
            </div>
            <div className="card">
              <h3>Revenue by category</h3>
              <div className="donut-wrap mt-16">
                <Donut rows={catRows} format={fmtInr} centerLabel="Revenue" />
              </div>
              <div className="cat-legend mt-16">
                {catRows.map((c) => (
                  <div key={c.type}>
                    <VehicleArt type={c.type} size={44} />
                    <span className="grow">
                      <span className="small bold">{c.label}</span>
                      <span className="tiny muted" style={{ display: 'block' }}>{c.rides} rides</span>
                    </span>
                    <span className="small mono bold">{inr(c.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="ov-grid">
            <div className="card">
              <div className="row-between wrap">
                <div>
                  <h3>Demand by hour of day</h3>
                  <p className="tiny muted mt-8">Ride requests by the hour they were made</p>
                </div>
                <span className="badge badge-primary">Peak {String(peak.hour).padStart(2, '0')}:00 · {peak.rides} rides</span>
              </div>
              <div className="mt-16"><BarChart data={hours} label="Demand by hour" color="#3d8eff" format={(v) => `${v} rides`} labelEvery={3} /></div>
            </div>
            <div className="card">
              <h3>Payment split</h3>
              <p className="tiny muted mt-8">Share of completed-ride revenue</p>
              <div className="mt-16"><StackBar rows={payRows} format={fmtInr} /></div>
            </div>
          </div>
        </>
      ) : (
        <div className="card ov-full">
          <h3>Daily breakdown</h3>
          <div className="table-wrap mt-16">
            <table className="table">
              <thead><tr><th>Date</th><th className="num">Rides</th><th className="num">Completed</th><th className="num">Cancelled</th><th className="num">Revenue</th><th className="num">Commission</th></tr></thead>
              <tbody>
                {[...data.daily].reverse().map((d) => (
                  <tr key={d.date}><td>{fmtDay(d.date)}</td><td className="num">{d.rides}</td><td className="num">{d.completed}</td><td className="num">{d.cancelled}</td><td className="num">{inr(d.revenue)}</td><td className="num">{inr(d.commission)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card ov-full">
        <div className="row-between">
          <h3>Top drivers</h3>
          <span className="tiny muted">by earnings · last {days} days</span>
        </div>
        <div className="leaderboard mt-16">
          {data.topDrivers.map((d, i) => (
            <div key={d.id} className="lb-row">
              <span className={`lb-rank r${i + 1}`}>{i + 1}</span>
              <span className="avatar">{initials(d.name)}</span>
              <span className="lb-name">
                <span className="small bold">{d.name}</span>
                <span className="tiny muted">{VEHICLE_META[d.vehicle_type]?.name}{d.is_bot ? ' · simulated' : ''}</span>
              </span>
              <span className="lb-bar"><span style={{ width: `${(d.earnings / maxEarn) * 100}%` }} /></span>
              <span className="lb-num"><b className="mono">{inr(d.earnings)}</b><span className="tiny muted">{d.trips} trips</span></span>
              <span className="lb-rating"><Star size={12} fill="#fbbf24" color="#fbbf24" /> {Number(d.rating_avg).toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CsvButton() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const res = await api('/admin/reports/rides.csv', { raw: true });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rideflow-rides-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="btn btn-sm" onClick={download} disabled={busy}>
      {busy ? <Spinner size={16} /> : <Download size={16} />} Export CSV
    </button>
  );
}

// ---------------------------------------------------------------- live map
function LiveMap() {
  const toast = useToast();
  const [live, setLive] = useState(null);
  const [focus, setFocus] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api('/admin/live').then((d) => alive && setLive(d)).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!live) return <PageLoading />;
  // The map reads its centre only on mount, so this is effectively the first snapshot.
  const center = live.drivers[0] ? { lat: live.drivers[0].lat, lng: live.drivers[0].lng } : DEFAULT_CENTER;
  const byType = Object.fromEntries(VEHICLE_TYPES.map((t) => [t, live.drivers.filter((d) => d.vehicle_type === t).length]));
  const onTrip = live.drivers.filter((d) => d.status === 'on_trip').length;

  async function cancel(id) {
    if (!window.confirm(`Cancel ride #${id}? The passenger won't be charged.`)) return;
    try {
      await api(`/admin/rides/${id}/cancel`, { method: 'POST', body: { reason: 'Cancelled by operations' } });
      toast(`Ride #${id} cancelled`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  const focused = live.rides.find((r) => r.id === focus);
  return (
    <div className="admin-live">
      <MapView center={center} zoom={13} className="map-fill">
        {focused && <FitBounds fitKey={`f-${focused.id}`} points={[{ lat: focused.pickup_lat, lng: focused.pickup_lng }, { lat: focused.drop_lat, lng: focused.drop_lng }]} />}
        {live.drivers.map((d) => <CarMarker key={d.id} position={d} heading={d.heading} type={d.vehicle_type} />)}
        {live.rides.map((r) => <PinMarker key={`p${r.id}`} position={{ lat: r.pickup_lat, lng: r.pickup_lng }} kind="pickup" label={`#${r.id}`} />)}
        {focused && <PinMarker position={{ lat: focused.drop_lat, lng: focused.drop_lng }} kind="drop" label={`#${focused.id} drop`} />}
      </MapView>
      <div className="map-vignette" />

      <div className="live-fleet glass">
        <div className="tiny muted bold" style={{ letterSpacing: '.08em', textTransform: 'uppercase' }}>Fleet online</div>
        <div className="live-fleet-total"><CountUp value={live.drivers.length} format={fmtInt} /> <span className="small muted">drivers · {onTrip} on trips</span></div>
        <div className="live-fleet-types">
          {VEHICLE_TYPES.map((t) => (
            <span key={t}><span className="dot" style={{ background: VEHICLE_META[t].hex }} />{VEHICLE_META[t].name}<b className="mono">{byType[t]}</b></span>
          ))}
        </div>
      </div>

      <div className="live-rides glass">
        <div className="row-between">
          <h3>Active rides</h3>
          <span className="badge badge-primary">{live.rides.length}</span>
        </div>
        <div className="live-rides-list">
          {live.rides.length === 0 && (
            <div className="empty" style={{ padding: '28px 10px' }}>
              <Radio size={28} />
              <div className="small">No active rides right now. New requests appear here instantly.</div>
            </div>
          )}
          {live.rides.map((r) => (
            <div key={r.id} className={`live-ride ${focus === r.id ? 'active' : ''}`} onClick={() => setFocus(r.id)}>
              <div className="row-between">
                <span className="bold small">#{r.id} · {VEHICLE_META[r.vehicle_type].name}</span>
                <StatusBadge status={r.status} />
              </div>
              <div className="tiny muted">{r.passenger_name} → {r.driver_name || 'unassigned'}</div>
              <div className="tiny ellipsis">{shortAddress(r.pickup_address)} → {shortAddress(r.drop_address)}</div>
              <div className="row-between">
                <span className="small mono bold">{inr(r.est_fare)}</span>
                <button className="btn btn-sm btn-soft-danger" style={{ height: 30 }} onClick={(e) => { e.stopPropagation(); cancel(r.id); }}>Cancel</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- rides
const RIDE_FILTERS = [
  ['', 'All'], ['requested', 'Searching'], ['in_progress', 'On trip'], ['completed', 'Completed'],
  ['cancelled', 'Cancelled'], ['scheduled', 'Scheduled'], ['no_driver', 'No driver'],
];

function RidesTab() {
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [rides, setRides] = useState(null);
  useEffect(() => {
    api(`/admin/rides?status=${status}`).then((r) => setRides(r.rides)).catch(() => setRides([]));
  }, [status]);
  const shown = useMemo(() => {
    const s = query.trim().toLowerCase();
    if (!rides || !s) return rides;
    return rides.filter((r) => `#${r.id} ${r.passenger_name} ${r.driver_name || ''} ${r.pickup_address} ${r.drop_address}`.toLowerCase().includes(s));
  }, [rides, query]);
  return (
    <div className="col gap-16">
      <div className="card admin-filterbar">
        <div className="chip-filter" role="group" aria-label="Filter by status">
          {RIDE_FILTERS.map(([v, l]) => (
            <button key={v || 'all'} className={status === v ? 'active' : ''} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        <div className="row gap-8">
          <div className="input-icon" style={{ width: 260 }}>
            <Search size={16} />
            <input className="input" style={{ height: 40 }} placeholder="Search rider, driver, address, #id" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <CsvButton />
        </div>
      </div>
      {!shown ? <PageLoading /> : shown.length === 0 ? (
        <div className="empty card"><Car size={36} /><div>No rides match this filter.</div></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Ride</th><th>Passenger / driver</th><th>Route</th><th>Status</th><th className="num">Fare</th><th className="num">Commission</th><th>Payment</th></tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="row gap-8">
                      <VehicleArt type={r.vehicle_type} size={40} />
                      <div><div className="bold">#{r.id}</div><div className="tiny muted">{dateTime(r.scheduled_at || r.created_at)}</div></div>
                    </div>
                  </td>
                  <td>
                    <div className="row gap-8">
                      <span className="avatar" style={{ width: 32, height: 32, fontSize: '0.72rem' }}>{initials(r.passenger_name)}</span>
                      <div><div className="small">{r.passenger_name}</div><div className="tiny muted">{r.driver_name ? `with ${r.driver_name}` : 'no driver'}</div></div>
                    </div>
                  </td>
                  <td style={{ maxWidth: 260 }}><div className="ellipsis small">{shortAddress(r.pickup_address)}</div><div className="ellipsis tiny muted">→ {shortAddress(r.drop_address)} · {km(r.distance_km)}{r.surge > 1 ? ` · ${r.surge}x` : ''}</div></td>
                  <td><StatusBadge status={r.status} />{r.cancelled_by && <div className="tiny muted mt-8">by {r.cancelled_by}</div>}</td>
                  <td className="num">{r.final_fare != null ? inr(r.final_fare, 2) : r.cancellation_fee ? `${inr(r.cancellation_fee)} fee` : `~${inr(r.est_fare)}`}{r.promo_code && <div className="tiny" style={{ color: '#86efac' }}>{r.promo_code} −{inr(r.discount)}</div>}</td>
                  <td className="num">{r.commission != null ? inr(r.commission, 2) : '—'}</td>
                  <td><div className="small">{PAYMENT_LABEL[r.payment_method]?.split(' ')[0]}</div><div className="tiny muted">{r.payment_status}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- users
function UsersTab() {
  const toast = useToast();
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [users, setUsers] = useState(null);
  const load = useCallback(() => api(`/admin/users?role=${role}&q=${encodeURIComponent(q)}`).then((r) => setUsers(r.users)), [role, q]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  async function toggle(u) {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } });
      toast(`${u.name} ${u.is_active ? 'suspended' : 'reactivated'}`, 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  return (
    <div className="col gap-16">
      <div className="card admin-filterbar">
        <div className="chip-filter" role="group" aria-label="Filter by role">
          {[['', 'Everyone'], ['passenger', 'Passengers'], ['driver', 'Drivers'], ['admin', 'Admins']].map(([v, l]) => (
            <button key={v || 'all'} className={role === v ? 'active' : ''} onClick={() => setRole(v)}>{l}</button>
          ))}
        </div>
        <div className="input-icon" style={{ width: 280 }}>
          <Search size={16} />
          <input className="input" style={{ height: 40 }} placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!users ? <PageLoading /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>User</th><th>Role</th><th>Vehicle</th><th className="num">Trips</th><th className="num">Rating</th><th className="num">Wallet</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="row gap-8">
                      <span className="avatar" style={{ width: 34, height: 34, fontSize: '0.75rem' }}>{initials(u.name)}</span>
                      <div><div className="bold small">{u.name}</div><div className="tiny muted">{u.email}</div></div>
                    </div>
                  </td>
                  <td><span className={`badge role-${u.role}`}>{u.role}</span>{u.is_bot ? <span className="badge badge-violet" style={{ marginLeft: 4 }}>sim</span> : null}</td>
                  <td className="small">{u.vehicle_type ? <>{VEHICLE_META[u.vehicle_type].name} · {u.vehicle_number}<div className="tiny muted">{u.is_online ? `online · ${u.driver_status}` : 'offline'}</div></> : '—'}</td>
                  <td className="num">{u.trips}</td>
                  <td className="num">{u.role === 'driver' ? Number(u.rating_avg).toFixed(2) : '—'}</td>
                  <td className="num">{u.role === 'passenger' ? inr(u.wallet_balance) : '—'}</td>
                  <td>{u.is_active ? <span className="badge badge-success">active</span> : <span className="badge badge-danger">suspended</span>}</td>
                  <td>{u.role !== 'admin' && <button className={`btn btn-sm ${u.is_active ? 'btn-soft-danger' : ''}`} onClick={() => toggle(u)}>{u.is_active ? 'Suspend' : 'Activate'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- promos
function PromosTab() {
  const toast = useToast();
  const [promos, setPromos] = useState(null);
  const [open, setOpen] = useState(false);
  const empty = { code: '', description: '', discount_type: 'percent', value: '', max_discount: '', min_fare: '', usage_limit: '', per_user_limit: 1, vehicle_type: '', valid_until: '' };
  const [form, setForm] = useState(empty);
  const load = useCallback(() => api('/admin/promos').then((r) => setPromos(r.promos)), []);
  useEffect(() => {
    load();
  }, [load]);
  async function create(e) {
    e.preventDefault();
    try {
      await api('/admin/promos', { method: 'POST', body: form });
      toast(`Promo ${form.code.toUpperCase()} created`, 'success');
      setOpen(false);
      setForm(empty);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  async function toggle(p) {
    await api(`/admin/promos/${p.code}`, { method: 'PATCH', body: { active: !p.active } });
    load();
  }
  async function copy(code) {
    try {
      await navigator.clipboard.writeText(code);
      toast(`${code} copied`, 'success');
    } catch {
      /* clipboard unavailable */
    }
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  if (!promos) return <PageLoading />;
  return (
    <div className="promo-grid">
      <button className="promo-new" onClick={() => setOpen(true)}>
        <span className="kpi-icon" style={{ '--kc': '#3d8eff' }}><Plus size={18} /></span>
        <b>New promo code</b>
        <span className="tiny muted">Percent or flat discount with limits</span>
      </button>
      {promos.map((p) => {
        const used = p.usage_limit ? Math.min(1, p.used_count / p.usage_limit) : null;
        return (
          <div key={p.code} className={`coupon ${p.active ? '' : 'paused'}`}>
            <div className="coupon-stub">
              <b>{p.discount_type === 'percent' ? `${p.value}%` : inr(p.value)}</b>
              <span>OFF</span>
            </div>
            <div className="coupon-body">
              <div className="row-between">
                <button className="coupon-code" onClick={() => copy(p.code)} title="Copy code">{p.code} <Copy size={12} /></button>
                <button type="button" className={`switch ${p.active ? 'on' : ''}`} aria-pressed={!!p.active} aria-label={p.active ? `Pause ${p.code}` : `Activate ${p.code}`} onClick={() => toggle(p)} />
              </div>
              <div className="small text-2">{p.description || '—'}</div>
              <div className="coupon-rules tiny muted">
                {p.max_discount ? `Up to ${inr(p.max_discount)} · ` : ''}{p.min_fare ? `Min ${inr(p.min_fare)} · ` : ''}{p.per_user_limit}/rider{p.vehicle_type ? ` · ${VEHICLE_META[p.vehicle_type].name} only` : ''}
              </div>
              <div className="coupon-usage">
                <span className="tiny muted">{p.used_count}{p.usage_limit ? ` / ${p.usage_limit}` : ''} used</span>
                <span className="tiny muted">{p.valid_until ? `Ends ${dateTime(p.valid_until)}` : 'No expiry'}</span>
              </div>
              {used != null && <div className="progress" style={{ height: 5 }}><div style={{ width: `${used * 100}%` }} /></div>}
            </div>
          </div>
        );
      })}
      <Modal open={open} onClose={() => setOpen(false)} title="New promo code" width={520}>
        <form className="col gap-16" onSubmit={create}>
          <div className="grid grid-2">
            <label className="field"><span className="label">Code</span><input className="input" value={form.code} onChange={set('code')} placeholder="DIWALI25" required /></label>
            <label className="field"><span className="label">Type</span>
              <select className="select" value={form.discount_type} onChange={set('discount_type')}><option value="percent">Percent</option><option value="flat">Flat ₹</option></select>
            </label>
          </div>
          <label className="field"><span className="label">Description</span><input className="input" value={form.description} onChange={set('description')} /></label>
          <div className="grid grid-2">
            <label className="field"><span className="label">{form.discount_type === 'percent' ? 'Percent off' : 'Amount off (₹)'}</span><input className="input" type="number" min="1" value={form.value} onChange={set('value')} required /></label>
            <label className="field"><span className="label">Max discount (₹)</span><input className="input" type="number" min="0" value={form.max_discount} onChange={set('max_discount')} /></label>
            <label className="field"><span className="label">Minimum fare (₹)</span><input className="input" type="number" min="0" value={form.min_fare} onChange={set('min_fare')} /></label>
            <label className="field"><span className="label">Total uses</span><input className="input" type="number" min="1" value={form.usage_limit} onChange={set('usage_limit')} placeholder="Unlimited" /></label>
            <label className="field"><span className="label">Uses per rider</span><input className="input" type="number" min="1" value={form.per_user_limit} onChange={set('per_user_limit')} /></label>
            <label className="field"><span className="label">Category</span>
              <select className="select" value={form.vehicle_type} onChange={set('vehicle_type')}><option value="">All</option>{VEHICLE_TYPES.map((t) => <option key={t} value={t}>{VEHICLE_META[t].name}</option>)}</select>
            </label>
          </div>
          <label className="field"><span className="label">Valid until</span><input className="input" type="datetime-local" value={form.valid_until} onChange={set('valid_until')} /></label>
          <button className="btn btn-primary btn-block">Create promo</button>
        </form>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------- refunds
function RefundsTab({ onChange }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [amounts, setAmounts] = useState({});
  const load = useCallback(() => api('/admin/refunds').then((r) => setList(r.refunds)), []);
  useEffect(() => {
    load();
  }, [load]);
  async function resolve(r, approve) {
    try {
      await api(`/admin/refunds/${r.id}`, { method: 'POST', body: { approve, amount: amounts[r.id] ?? r.amount_requested, note: approve ? 'Approved by support' : 'Trip charges verified as correct' } });
      toast(approve ? 'Refund approved and credited to wallet' : 'Refund rejected', 'success');
      onChange();
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  if (!list) return <PageLoading />;
  if (!list.length) return <div className="empty card"><RotateCcw size={36} /><div>No refund requests yet.</div></div>;
  return (
    <div className="col gap-8">
      {list.map((r) => (
        <div key={r.id} className={`card card-tight row wrap admin-item ${r.status === 'pending' ? 'pending' : ''}`} style={{ gap: 16 }}>
          <span className="avatar">{initials(r.user_name)}</span>
          <div className="grow" style={{ minWidth: 240 }}>
            <div className="row gap-8"><span className="bold">Ride #{r.ride_id}</span><span className={`badge badge-${r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : 'warning'}`}>{r.status}</span></div>
            <div className="small mt-8">{r.reason}</div>
            <div className="tiny muted mt-8">{r.user_name} · {dateTime(r.created_at)} · paid {inr(r.ride_status === 'completed' ? r.final_fare : r.cancellation_fee, 2)} via {r.payment_method}</div>
          </div>
          {r.status === 'pending' ? (
            <div className="row gap-8">
              <input className="input" style={{ width: 110, height: 38 }} type="number" min="1" max={r.amount_requested} value={amounts[r.id] ?? r.amount_requested} onChange={(e) => setAmounts({ ...amounts, [r.id]: e.target.value })} aria-label="Refund amount" />
              <button className="btn btn-sm btn-success" onClick={() => resolve(r, true)}>Approve</button>
              <button className="btn btn-sm btn-soft-danger" onClick={() => resolve(r, false)}>Reject</button>
            </div>
          ) : (
            <div className="bold mono">{r.status === 'approved' ? inr(r.amount_approved, 2) : '—'}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- SOS
function SosTab({ onChange }) {
  const [list, setList] = useState(null);
  const load = useCallback(() => api('/admin/sos').then((r) => setList(r.alerts)), []);
  useEffect(() => {
    load();
  }, [load]);
  useSocketEvent('sos:new', () => load());
  async function resolve(id) {
    await api(`/admin/sos/${id}/resolve`, { method: 'POST' });
    onChange();
    load();
  }
  if (!list) return <PageLoading />;
  if (!list.length) return <div className="empty card"><Siren size={36} /><div>No SOS alerts. All quiet.</div></div>;
  return (
    <div className="col gap-8">
      {list.map((a) => (
        <div key={a.id} className={`card card-tight row wrap admin-item ${a.status === 'open' ? 'alert' : ''}`} style={{ gap: 16 }}>
          <div className="icon-btn" style={{ background: a.status === 'open' ? 'var(--danger-soft)' : 'var(--surface-2)', color: a.status === 'open' ? '#fca5a5' : 'var(--muted)' }}>
            {a.status === 'open' ? <Siren size={18} /> : <CheckCircle2 size={18} />}
          </div>
          <div className="grow" style={{ minWidth: 220 }}>
            <div className="bold">{a.user_name} <span className="muted small">({a.role}) · {a.user_phone}</span></div>
            <div className="small text-2">
              {a.ride_id ? `Ride #${a.ride_id} · ${a.ride_status} · driver ${a.driver_name || '—'} ${a.vehicle_number || ''}` : 'No ride attached'}
            </div>
            <div className="tiny muted">{dateTime(a.created_at)}{a.resolved_at ? ` · resolved ${dateTime(a.resolved_at)}` : ''}</div>
          </div>
          {a.lat != null && (
            <a className="btn btn-sm btn-ghost" href={`https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}`} target="_blank" rel="noreferrer">
              <MapPin size={14} /> Location
            </a>
          )}
          {a.user_phone && <a className="btn btn-sm" href={`tel:${a.user_phone}`}>Call</a>}
          {a.status === 'open' && <button className="btn btn-sm btn-success" onClick={() => resolve(a.id)}>Mark resolved</button>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- emails
function EmailsTab() {
  const [list, setList] = useState(null);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    api('/admin/emails').then((r) => setList(r.emails));
  }, []);
  if (!list) return <PageLoading />;
  return (
    <div className="col gap-16">
      <div className="notice">
        <Mail size={16} />
        <span>Without SMTP settings, emails are recorded here instead of being sent. Add <code>SMTP_HOST</code>, <code>SMTP_USER</code> and <code>SMTP_PASS</code> to <code>.env</code> to deliver them.</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id}>
                <td className="small">{dateTime(m.created_at)}</td>
                <td className="small">{m.to_email}</td>
                <td className="small">{m.subject}</td>
                <td><span className={`badge ${m.status === 'sent' ? 'badge-success' : m.status === 'failed' ? 'badge-danger' : ''}`}>{m.status}</span></td>
                <td><button className="btn btn-sm btn-ghost" onClick={() => setPreview(m)}>Preview</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.subject} width={620}>
        {preview && <iframe title="Email preview" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 460, border: 0, borderRadius: 12, background: '#0b0f1a' }} />}
      </Modal>
    </div>
  );
}
