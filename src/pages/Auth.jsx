import { useId, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight, BarChart3, Car, Eye, EyeOff, Gift, KeyRound, Lock, Mail, Navigation, Phone, ShieldCheck, Sparkles, User, Wallet,
} from 'lucide-react';
import { Logo } from '../components/AppShell.jsx';
import { Spinner, VehicleArt } from '../components/ui.jsx';
import HeroScene from '../components/HeroScene.jsx';
import { enter, gsap, reducedMotion, useGSAP, useTilt } from '../lib/motion.jsx';
import { homeFor, useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { VEHICLE_META, VEHICLE_TYPES } from '../lib/format.js';

const TRUST = [
  { icon: KeyRound, title: 'PIN-verified', text: 'pickups' },
  { icon: Navigation, title: 'Live tracking', text: 'every trip' },
  { icon: Wallet, title: 'Upfront fares', text: 'no surprises' },
];

function AuthLayout({ title, subtitle, children, aside, badge }) {
  const wrap = useRef(null);
  const visual = useRef(null);
  const panel = useRef(null);
  useTilt(panel, { max: 2.5, lift: 0, perspective: 1600 });
  useGSAP(
    () => {
      if (reducedMotion()) return;
      const E = { ease: 'expo.out' };
      gsap.timeline()
        .add(enter('.auth-panel', { autoAlpha: 0, rotationY: -18, rotationX: 6, z: -180, x: 50, transformPerspective: 1400, duration: 1.3, clearProps: 'transform', ...E }))
        .add(enter('.auth-panel-head > *, .auth-panel form > *, .auth-after > *', {
          autoAlpha: 0, y: 18, rotationX: -30, transformPerspective: 700, transformOrigin: '50% 0%', stagger: 0.045, duration: 0.8,
          clearProps: 'transform,opacity,visibility',
          ...E,
        }), '-=0.95')
        .add(enter('.auth-show-copy > *', { autoAlpha: 0, y: 30, stagger: 0.09, duration: 1, ...E }), 0.1)
        .add(enter('.auth-trust > *', { autoAlpha: 0, y: 20, scale: 0.94, stagger: 0.08, duration: 0.9, ...E }), 0.6);
    },
    { scope: wrap },
  );
  return (
    <div className="auth-page">
      <div className="auth-bg" aria-hidden="true">
        <span className="auth-blob b1" />
        <span className="auth-blob b2" />
        <span className="auth-grid" />
      </div>
      <header className="topbar">
        <Logo />
      </header>
      <div className="auth-wrap" ref={wrap}>
        <section className="auth-show" ref={visual}>
          <div className="auth-show-copy">
            <span className="auth-live"><i /> Live in your city</span>
            <h2>{aside || <>Move through your city <span className="grad-text">in real time.</span></>}</h2>
            <p>Live tracking, PIN-verified pickups and transparent fares across bikes, autos and cabs.</p>
          </div>
          <HeroScene trackRef={visual} />
          <div className="auth-trust">
            {TRUST.map(({ icon: Icon, title: t, text }) => (
              <div key={t}>
                <span className="auth-trust-icon"><Icon size={16} /></span>
                <span><b>{t}</b><small>{text}</small></span>
              </div>
            ))}
          </div>
        </section>

        <div className="auth-card">
          <div className="auth-panel tilt" ref={panel}>
            <span className="spotlight" aria-hidden="true" />
            <div className="auth-panel-head">
              <span className="auth-badge">{badge}</span>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Password input with a show/hide toggle and a Caps Lock warning. */
function PasswordField({ label = 'Password', value, onChange, autoComplete, minLength, children }) {
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const id = useId();
  const onKey = (e) => setCaps(e.getModifierState?.('CapsLock') ?? false);
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <div className="input-icon auth-pass">
        <Lock size={18} />
        <input
          id={id}
          className="input"
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          minLength={minLength}
          value={value}
          onChange={onChange}
          onKeyUp={onKey}
          onKeyDown={onKey}
          onBlur={() => setCaps(false)}
          required
        />
        <button type="button" className="auth-eye" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {caps && <span className="auth-caps">Caps Lock is on</span>}
      {children}
    </div>
  );
}

function strength(pw) {
  if (!pw) return 0;
  let s = pw.length >= 6 ? 1 : 0;
  if (pw.length >= 10) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  else if (/\d|[^A-Za-z0-9]/.test(pw) && s > 0) s += 0.5;
  return Math.min(4, Math.max(pw.length ? 1 : 0, Math.floor(s)));
}
const STRENGTH = ['', 'Weak', 'Fair', 'Good', 'Strong'];

const DEMOS = [
  { label: 'Rider', desc: 'Book & track rides', icon: User, tone: 'blue', email: 'rider@rideflow.app', password: 'rider123' },
  { label: 'Driver', desc: 'Accept trips, earn', icon: Car, tone: 'green', email: 'driver@rideflow.app', password: 'driver123' },
  { label: 'Admin', desc: 'Ops & analytics', icon: BarChart3, tone: 'amber', email: 'admin@rideflow.app', password: 'admin123' },
];

export function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null); // 'form' | demo label | null

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  async function submit(e, demo) {
    e?.preventDefault();
    setError('');
    setBusy(demo?.label ?? 'form');
    try {
      const u = await login(demo?.email ?? email, demo?.password ?? password);
      const from = location.state?.from;
      navigate(from && from !== '/' ? from : homeFor(u.role), { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  return (
    <AuthLayout badge={<><Lock size={12} /> Secure sign-in</>} title="Welcome back" subtitle="Log in to book a ride or start driving.">
      <form className="col gap-16" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label className="field">
          <span className="label">Email</span>
          <div className="input-icon">
            <Mail size={18} />
            <input className="input" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
        </label>
        <PasswordField value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        <button className="btn btn-primary btn-lg btn-block auth-submit" disabled={!!busy}>
          {busy === 'form' ? <Spinner /> : <>Log in <ArrowRight size={18} /></>}
        </button>
      </form>

      <div className="auth-after">
        <div className="auth-divider"><span>or jump straight in</span></div>
        <div className="auth-demos">
          {DEMOS.map(({ label, desc, icon: Icon, tone, ...creds }) => (
            <button
              key={label}
              type="button"
              className={`auth-demo ${tone}`}
              onClick={() => submit(null, { label, ...creds })}
              disabled={!!busy}
              aria-label={`${label} demo`}
            >
              <span className="auth-demo-icon">{busy === label ? <Spinner /> : <Icon size={18} />}</span>
              <b>{label}</b>
              <small>{desc}</small>
            </button>
          ))}
        </div>
        <p className="auth-switch">
          New to RideFlow? <Link to="/signup">Create an account <ArrowRight size={14} /></Link>
        </p>
        <p className="auth-foot"><ShieldCheck size={14} /> Simulated rides and test payments. No real money is charged.</p>
      </div>
    </AuthLayout>
  );
}

const ROLES = [
  { key: 'passenger', label: 'Passenger', icon: User, perk: '₹200 test credit on signup', perkIcon: Gift },
  { key: 'driver', label: 'Driver', icon: Car, perk: 'Keep 80–85% of every fare', perkIcon: Wallet },
];

export function Signup() {
  const { user, signup } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const [role, setRole] = useState(params.get('role') === 'driver' ? 'driver' : 'passenger');
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [vehicle, setVehicle] = useState({ type: 'mini', model: '', number: '', color: '', license: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={homeFor(user.role)} replace />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setV = (k) => (e) => setVehicle({ ...vehicle, [k]: e.target.value });
  const score = strength(form.password);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const u = await signup({ ...form, role, vehicle: role === 'driver' ? vehicle : undefined });
      toast(role === 'passenger' ? '₹200 test credit added to your wallet' : 'Go online to start receiving requests', 'success', `Welcome, ${u.name.split(' ')[0]}!`);
      navigate(homeFor(u.role), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      badge={<><Sparkles size={12} /> Free to join</>}
      title="Create your account"
      subtitle={role === 'driver' ? 'Earn on your schedule. Go online whenever you like.' : 'Get moving in under a minute.'}
      aside={role === 'driver' ? <>Drive more. <span className="grad-text">Earn more.</span></> : null}
    >
      <form className="col gap-16" onSubmit={submit}>
        <div className="auth-roles" role="radiogroup" aria-label="Account type">
          {ROLES.map(({ key, label, icon: Icon, perk, perkIcon: Perk }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={role === key}
              className={`auth-role ${role === key ? 'active' : ''}`}
              onClick={() => setRole(key)}
            >
              <span className="auth-role-icon"><Icon size={18} /></span>
              <b>{label}</b>
              <small><Perk size={12} /> {perk}</small>
              <span className="auth-role-check" aria-hidden="true" />
            </button>
          ))}
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label className="field">
          <span className="label">Full name</span>
          <div className="input-icon">
            <User size={18} />
            <input className="input" value={form.name} onChange={set('name')} autoComplete="name" placeholder="Your name" required />
          </div>
        </label>
        <div className="grid grid-2">
          <label className="field">
            <span className="label">Email</span>
            <div className="input-icon">
              <Mail size={18} />
              <input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" placeholder="name@mail.com" required />
            </div>
          </label>
          <label className="field">
            <span className="label">Phone</span>
            <div className="input-icon">
              <Phone size={18} />
              <input className="input" type="tel" value={form.phone} onChange={set('phone')} placeholder="+91 98xxxxxx" autoComplete="tel" />
            </div>
          </label>
        </div>
        <PasswordField value={form.password} onChange={set('password')} minLength={6} autoComplete="new-password">
          {form.password && (
            <span className={`auth-strength s${score}`} aria-live="polite">
              <span className="auth-strength-bars">{[1, 2, 3, 4].map((i) => <i key={i} />)}</span>
              {form.password.length < 6 ? 'At least 6 characters' : STRENGTH[score]}
            </span>
          )}
        </PasswordField>

        {role === 'driver' && (
          <>
            <div className="auth-divider"><span>Your vehicle</span></div>
            <div className="grid grid-4" style={{ gap: 8, gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
              {VEHICLE_TYPES.map((t) => (
                <button
                  type="button"
                  key={t}
                  className={`vehicle-opt ${vehicle.type === t ? 'selected' : ''}`}
                  style={{ flexDirection: 'column', gap: 2, padding: 8 }}
                  onClick={() => setVehicle({ ...vehicle, type: t })}
                >
                  <VehicleArt type={t} size={46} />
                  <span className="small bold">{VEHICLE_META[t].name}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-2">
              <label className="field">
                <span className="label">Vehicle model</span>
                <input className="input" value={vehicle.model} onChange={setV('model')} placeholder="Maruti Swift" required />
              </label>
              <label className="field">
                <span className="label">Colour</span>
                <input className="input" value={vehicle.color} onChange={setV('color')} placeholder="White" />
              </label>
              <label className="field">
                <span className="label">Registration number</span>
                <input className="input" value={vehicle.number} onChange={setV('number')} placeholder="KA 01 AB 1234" required />
              </label>
              <label className="field">
                <span className="label">Driving licence no.</span>
                <input className="input" value={vehicle.license} onChange={setV('license')} required />
              </label>
            </div>
            <div className="notice">
              <ShieldCheck size={16} />
              <span>In this demo, driver documents are not verified. A real launch needs background checks and document verification.</span>
            </div>
          </>
        )}
        <button className="btn btn-primary btn-lg btn-block auth-submit" disabled={busy}>
          {busy ? <Spinner /> : <>{role === 'driver' ? 'Create driver account' : 'Create account'} <ArrowRight size={18} /></>}
        </button>
      </form>
      <div className="auth-after">
        <p className="auth-switch">
          Already have an account? <Link to="/login">Log in <ArrowRight size={14} /></Link>
        </p>
        <p className="auth-foot"><ShieldCheck size={14} /> Simulated rides and test payments. No real money is charged.</p>
      </div>
    </AuthLayout>
  );
}
