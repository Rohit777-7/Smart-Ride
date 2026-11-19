import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft, Banknote, CalendarDays, Car, CreditCard, Lock, Mail, Phone, Plus, RotateCcw, ShieldCheck, Siren, Star, Trash2, User,
  Wallet, XCircle,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { useToast } from '../../lib/toast.jsx';
import { dateOnly, dateTime, initials, inr } from '../../lib/format.js';
import { Modal, PageLoading, Spinner } from '../../components/ui.jsx';
import { CountUp, TiltCard, useStaggerIn } from '../../lib/motion.jsx';
import { refreshNavStatus } from '../../lib/navStatus.js';

const fmtWallet = (n) => inr(n, 2);
const QUICK_TOPUPS = [200, 500, 1000];

/**
 * How each payment record reads in the activity feed. `wallet` says whether it actually moved
 * wallet money: cash and card ride fares are listed for completeness but never touch the balance.
 */
function describe(t) {
  const viaWallet = t.method === 'wallet';
  switch (t.type) {
    case 'topup':
      return { label: 'Wallet top-up', icon: ArrowDownLeft, tone: 'in', sign: '+', wallet: t.method !== 'wallet' || t.note === 'Welcome credit' };
    case 'refund':
      return { label: 'Refund', icon: RotateCcw, tone: 'in', sign: '+', wallet: true };
    case 'cancellation_fee':
      return { label: 'Cancellation fee', icon: XCircle, tone: viaWallet ? 'out' : 'neutral', sign: viaWallet ? '−' : '', wallet: viaWallet };
    default:
      return {
        label: 'Ride fare',
        icon: t.method === 'cash' ? Banknote : t.method === 'card' ? CreditCard : Car,
        tone: viaWallet ? 'out' : 'neutral',
        sign: viaWallet ? '−' : '',
        wallet: viaWallet,
      };
  }
}
const methodNote = (t) => (t.type === 'charge' && t.method === 'cash' ? 'Paid in cash' : t.type === 'charge' && t.method === 'card' ? 'Charged to test card' : t.note);

export default function Account() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [wallet, setWallet] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [trips, setTrips] = useState(null);
  const [topup, setTopup] = useState(null); // preset amount when the top-up sheet is open
  const [contactOpen, setContactOpen] = useState(false);
  const [txFilter, setTxFilter] = useState('all');
  const [profile, setProfile] = useState({ name: user.name, phone: user.phone || '' });
  const [saving, setSaving] = useState(false);
  const pageRef = useRef(null);
  useStaggerIn(pageRef, wallet ? 'ready' : null, { selector: '.acct-hero, .acct-grid > .acct-col > *', y: 30, rotationX: -16, stagger: 0.07 });

  const load = useCallback(() => {
    api('/me/wallet').then(setWallet).catch((e) => toast(e.message, 'error'));
    api('/me/contacts').then((r) => setContacts(r.contacts)).catch(() => {});
  }, [toast]);
  useEffect(() => {
    load();
    api('/rides/history')
      .then((r) => setTrips(r.rides.filter((x) => x.status === 'completed').length))
      .catch(() => {});
  }, [load]);

  const feed = useMemo(() => {
    const rows = (wallet?.transactions || []).map((t) => ({ ...t, d: describe(t) }));
    const inSum = rows.filter((r) => r.d.tone === 'in' && r.status !== 'failed').reduce((a, r) => a + r.amount, 0);
    const outSum = rows.filter((r) => r.d.tone === 'out' && r.status !== 'failed').reduce((a, r) => a + r.amount, 0);
    const shown = txFilter === 'in' ? rows.filter((r) => r.d.tone === 'in') : txFilter === 'out' ? rows.filter((r) => r.d.tone !== 'in') : rows;
    return { rows: shown, inSum, outSum };
  }, [wallet, txFilter]);

  async function saveProfile(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const { user: u } = await api('/me', { method: 'PATCH', body: profile });
      setUser(u);
      toast('Profile updated', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function removeContact(id) {
    await api(`/me/contacts/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
    load();
  }

  if (!wallet) return <PageLoading />;
  const dirty = profile.name.trim() !== user.name || (profile.phone || '') !== (user.phone || '');

  return (
    <div className="page acct" ref={pageRef}>
      {/* ---------------- profile header */}
      <section className="acct-hero">
        <div className="acct-avatar-ring">
          <div className="acct-avatar">{initials(user.name)}</div>
        </div>
        <div className="acct-hero-info">
          <span className="eyebrow">Your account</span>
          <h1>{user.name}</h1>
          <div className="acct-hero-meta">
            <span><Mail size={14} /> {user.email}</span>
            {user.phone && <span><Phone size={14} /> {user.phone}</span>}
            {user.created_at && <span><CalendarDays size={14} /> Member since {dateOnly(user.created_at)}</span>}
          </div>
        </div>
        <div className="acct-hero-stats">
          <div><span>Trips</span><b>{trips == null ? '—' : <CountUp value={trips} />}</b></div>
          <div><span>Rider rating</span><b className="row gap-4"><Star size={16} fill="#fbbf24" color="#fbbf24" /> {Number(user.rating_avg || 5).toFixed(1)}</b></div>
          <div><span>Safety contacts</span><b>{contacts.length}/5</b></div>
        </div>
      </section>

      <div className="acct-grid">
        <div className="acct-col">
          {/* ---------------- wallet card */}
          <div className="card acct-wallet">
            <TiltCard className="wallet-card" max={10} lift={14}>
              <div className="wallet-card-top">
                <span className="wallet-brand"><span className="logo-mark" style={{ width: 28, height: 28, borderRadius: 9 }}><Wallet size={14} color="#fff" /></span> RideFlow Wallet</span>
                <span className="wallet-chip" aria-hidden="true" />
              </div>
              <div className="wallet-balance-label">Available balance</div>
              <div className="wallet-balance"><CountUp value={wallet.balance} format={fmtWallet} /></div>
              <div className="wallet-card-bottom">
                <span className="mono">RF •••• •••• {String(user.id).padStart(4, '0')}</span>
                <span className="wallet-holder">{user.name}</span>
              </div>
            </TiltCard>
            {wallet.dues > 0 && <div className="notice danger mt-16"><XCircle size={16} /><span>Outstanding dues of <b>{inr(wallet.dues)}</b> will be settled from your next top-up.</span></div>}
            <div className="acct-topups mt-16">
              {QUICK_TOPUPS.map((a) => (
                <button key={a} className="quick-topup" onClick={() => setTopup(a)}>+{inr(a)}</button>
              ))}
              <button className="btn btn-primary" onClick={() => setTopup(500)}><Plus size={16} /> Add money</button>
            </div>
            <div className="acct-method mt-16">
              <span className="acct-method-icon"><CreditCard size={16} /></span>
              <span className="grow">
                <span className="small bold" style={{ display: 'block' }}>Test card •••• 4242</span>
                <span className="tiny muted">Used for top-ups and card rides · simulated, no real money</span>
              </span>
              <span className="badge badge-success">Default</span>
            </div>
          </div>

          {/* ---------------- emergency contacts */}
          <div className="card">
            <div className="row-between">
              <h3 className="row gap-8"><ShieldCheck size={18} color="#86efac" /> Emergency contacts</h3>
              <span className="tiny muted">{contacts.length} of 5</span>
            </div>
            <div className="acct-sos mt-16">
              <span className="acct-sos-icon"><Siren size={16} /></span>
              <span className="small text-2">When you press <b>SOS</b> during a ride, these people get your live location and trip details.</span>
            </div>
            <div className="col gap-8 mt-16">
              {contacts.map((c) => (
                <div key={c.id} className="contact-card">
                  <span className="avatar">{initials(c.name)}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row gap-8">
                      <span className="bold small">{c.name}</span>
                      {c.relation && <span className="badge">{c.relation}</span>}
                    </div>
                    <div className="tiny muted ellipsis">{c.phone}{c.email ? ` · ${c.email}` : ''}</div>
                  </div>
                  <a className="icon-btn" href={`tel:${c.phone}`} aria-label={`Call ${c.name}`}><Phone size={16} /></a>
                  <button className="icon-btn danger-hover" onClick={() => removeContact(c.id)} aria-label={`Remove ${c.name}`}><Trash2 size={16} /></button>
                </div>
              ))}
              {contacts.length < 5 && (
                <button className="contact-add" onClick={() => setContactOpen(true)}>
                  <Plus size={16} /> {contacts.length ? 'Add another contact' : 'Add your first emergency contact'}
                </button>
              )}
            </div>
          </div>

          {/* ---------------- profile */}
          <form className="card col gap-16" onSubmit={saveProfile}>
            <h3 className="row gap-8"><User size={18} color="#6aa8ff" /> Personal details</h3>
            <div className="grid grid-2">
              <label className="field">
                <span className="label">Full name</span>
                <input className="input" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
              </label>
              <label className="field">
                <span className="label">Phone</span>
                <input className="input" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="label">Email</span>
              <div className="input-icon">
                <Lock size={15} />
                <input className="input" value={user.email} readOnly aria-readonly="true" style={{ opacity: 0.7 }} />
              </div>
            </label>
            <div className="row-between wrap">
              <span className="tiny muted">Your email is your login and can't be changed here.</span>
              <button className="btn btn-primary" disabled={saving || !dirty}>{saving ? <Spinner /> : 'Save changes'}</button>
            </div>
          </form>
        </div>

        {/* ---------------- activity */}
        <div className="acct-col">
          <div className="card acct-activity">
            <div className="row-between wrap">
              <h3>Wallet activity</h3>
              <div className="chip-filter" role="group" aria-label="Filter activity">
                {[['all', 'All'], ['in', 'Money in'], ['out', 'Money out']].map(([k, l]) => (
                  <button key={k} className={txFilter === k ? 'active' : ''} onClick={() => setTxFilter(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="acct-flow mt-16">
              <div><span className="tiny muted">Money in</span><b className="in">+{inr(feed.inSum)}</b></div>
              <div><span className="tiny muted">Paid from wallet</span><b>−{inr(feed.outSum)}</b></div>
            </div>
            <div className="tx-list mt-16">
              {feed.rows.length === 0 && <div className="empty" style={{ padding: 30 }}><Wallet size={30} /><div className="small">Nothing here yet.</div></div>}
              {feed.rows.map((t) => {
                const Icon = t.d.icon;
                const failed = t.status === 'failed';
                return (
                  <div key={t.id} className={`tx-row ${failed ? 'failed' : ''}`}>
                    <span className={`tx-icon ${t.d.tone}`}><Icon size={16} /></span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small bold">
                        {t.d.label}{t.ride_id ? <span className="muted"> · ride #{t.ride_id}</span> : null}
                      </div>
                      <div className="tiny muted ellipsis">{dateTime(t.created_at)} · {methodNote(t)}</div>
                    </div>
                    <div className="tx-amount">
                      <b className={`mono ${failed ? '' : t.d.tone}`}>{t.d.sign}{inr(t.amount, 2)}</b>
                      {failed && <span className="badge badge-danger">failed</span>}
                      {t.status === 'due' && <span className="badge badge-warning">due</span>}
                      {!failed && t.d.tone === 'neutral' && <span className="tiny muted">not from wallet</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <TopupModal
        key={topup ?? 'closed'}
        open={topup != null}
        initialAmount={topup || 500}
        onClose={() => setTopup(null)}
        onDone={() => { setTopup(null); load(); refreshNavStatus(); }}
      />
      <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} onDone={() => { setContactOpen(false); load(); }} />
    </div>
  );
}

function TopupModal({ open, initialAmount, onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState(initialAmount);
  const [card, setCard] = useState({ cardNumber: '4242 4242 4242 4242', expiry: '12/30', cvv: '123' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pay(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('/me/wallet/topup', { method: 'POST', body: { amount, ...card } });
      toast(`${inr(amount)} added · ${r.txnId}`, 'success', 'Payment successful');
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add money (test payment)">
      <form className="col gap-16" onSubmit={pay}>
        <div className="row wrap gap-8">
          {[200, 500, 1000, 2000].map((a) => (
            <button type="button" key={a} className="chip" style={amount === a ? { borderColor: 'var(--primary)', background: 'var(--primary-soft)' } : undefined} onClick={() => setAmount(a)}>
              {inr(a)}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="label">Amount</span>
          <input className="input" type="number" min="50" max="10000" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </label>
        <label className="field">
          <span className="label">Card number</span>
          <div className="input-icon">
            <CreditCard size={16} />
            <input className="input mono" value={card.cardNumber} onChange={(e) => setCard({ ...card, cardNumber: e.target.value })} inputMode="numeric" />
          </div>
        </label>
        <div className="grid grid-2">
          <label className="field">
            <span className="label">Expiry (MM/YY)</span>
            <input className="input mono" value={card.expiry} onChange={(e) => setCard({ ...card, expiry: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">CVV</span>
            <input className="input mono" value={card.cvv} onChange={(e) => setCard({ ...card, cvv: e.target.value })} inputMode="numeric" maxLength={3} />
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="notice small">
          <CreditCard size={16} />
          <span>Test gateway: <b>4242 4242 4242 4242</b> succeeds, <b>4000 0000 0000 0002</b> is declined. Real cards are rejected.</span>
        </div>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? <Spinner /> : `Pay ${inr(amount)}`}</button>
      </form>
    </Modal>
  );
}

function ContactModal({ open, onClose, onDone }) {
  const toast = useToast();
  const [c, setC] = useState({ name: '', phone: '', email: '', relation: '' });
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/me/contacts', { method: 'POST', body: c });
      toast('Emergency contact saved', 'success');
      setC({ name: '', phone: '', email: '', relation: '' });
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="Add emergency contact">
      <form className="col gap-16" onSubmit={save}>
        <label className="field"><span className="label">Name</span><input className="input" value={c.name} onChange={set('name')} required /></label>
        <div className="grid grid-2">
          <label className="field"><span className="label">Phone</span><input className="input" type="tel" value={c.phone} onChange={set('phone')} required /></label>
          <label className="field"><span className="label">Relation</span><input className="input" value={c.relation} onChange={set('relation')} placeholder="Parent, friend…" /></label>
        </div>
        <label className="field"><span className="label">Email (receives SOS alerts)</span><input className="input" type="email" value={c.email} onChange={set('email')} /></label>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? <Spinner /> : 'Save contact'}</button>
      </form>
    </Modal>
  );
}
