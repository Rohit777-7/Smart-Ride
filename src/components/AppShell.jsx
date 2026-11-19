import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Activity, BarChart3, Car, ChevronDown, Clock, LogOut, MapPin, User, Wallet } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { initials, inr } from '../lib/format.js';
import { api } from '../lib/api.js';
import { useSocketEvent } from '../lib/socket.js';
import { refreshNavStatus, useNavStatus } from '../lib/navStatus.js';
import { CountUp, enter, gsap, reducedMotion, useGSAP } from '../lib/motion.jsx';

const NAV = {
  passenger: [
    { to: '/ride', label: 'Ride', icon: MapPin, end: true },
    { to: '/ride/history', label: 'My rides', icon: Clock },
    { to: '/ride/account', label: 'Account', icon: User },
  ],
  driver: [
    { to: '/driver', label: 'Drive', icon: Car, end: true },
    { to: '/driver/earnings', label: 'Earnings', icon: Wallet },
  ],
  admin: [{ to: '/admin', label: 'Dashboard', icon: BarChart3, end: true }],
};

export function Logo({ to = '/' }) {
  return (
    <NavLink to={to} className="logo">
      <span className="logo-mark">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
          <path d="M12 2C7.6 2 4 5.4 4 9.7 4 15.5 12 22 12 22s8-6.5 8-12.3C20 5.4 16.4 2 12 2z" fill="#fff" />
          <circle cx="12" cy="9.5" r="3" fill="#2a76f2" />
        </svg>
      </span>
      <span className="logo-word">RideFlow</span>
    </NavLink>
  );
}

const fmtInr = (n) => inr(n);

/** Live status chip: wallet for passengers, online state + today's earnings for drivers, live ops for admins. */
function StatusChip({ user }) {
  const nav = useNavStatus();
  const { pathname } = useLocation();
  const [info, setInfo] = useState(null);
  useSocketEvent('ride:update', (r) => {
    if (['completed', 'cancelled'].includes(r.status)) refreshNavStatus();
  });
  // refunds approved by support (and similar account notices) can change the wallet balance
  useSocketEvent('notify', () => refreshNavStatus());
  useEffect(() => {
    let alive = true;
    const load =
      user.role === 'passenger'
        ? api('/me/wallet').then((w) => ({ balance: w.balance }))
        : user.role === 'driver'
          ? api('/driver/earnings').then((e) => ({ today: e.today.earnings }))
          : api('/admin/live').then((l) => ({ live: l.rides.length, drivers: l.drivers.length }));
    load.then((v) => alive && setInfo(v)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [user.role, pathname, nav.version]);
  if (!info) return null;

  if (user.role === 'passenger') {
    return (
      <Link to="/ride/account" className="nav-chip" title="RideFlow wallet">
        <Wallet size={15} />
        <span className="chip-label">Wallet</span>
        <CountUp className="chip-value" value={info.balance} format={fmtInr} />
      </Link>
    );
  }
  if (user.role === 'driver') {
    const online = nav.driverOnline ?? !!user.driver?.is_online;
    return (
      <Link to="/driver/earnings" className={`nav-chip ${online ? 'live' : ''}`} title="Today's earnings">
        <span className="live-dot" />
        <span className="chip-label">{online ? 'Online' : 'Offline'}</span>
        <span className="chip-sep" />
        <CountUp className="chip-value" value={info.today} format={fmtInr} />
        <span className="chip-label">today</span>
      </Link>
    );
  }
  return (
    <span className="nav-chip live" title="Live operations">
      <Activity size={15} />
      <span className="chip-value">{info.live}</span>
      <span className="chip-label">live rides</span>
      <span className="chip-sep" />
      <span className="chip-value">{info.drivers}</span>
      <span className="chip-label">drivers</span>
    </span>
  );
}

function ProfileMenu({ user, items, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  useGSAP(
    () => {
      if (!open || reducedMotion()) return;
      enter('.profile-menu', { autoAlpha: 0, y: -10, rotationX: -25, scale: 0.96, transformPerspective: 800, transformOrigin: '90% 0%', duration: 0.4, ease: 'power3.out' });
      enter('.profile-menu > *', { autoAlpha: 0, x: 8, stagger: 0.03, duration: 0.3, delay: 0.06 });
    },
    { dependencies: [open], scope: ref },
  );

  return (
    <div className="profile" ref={ref}>
      <button className="profile-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar">{initials(user?.name)}</span>
        <span className="profile-name hide-mobile">{user?.name?.split(' ')[0]}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          <div className="profile-head">
            <span className="avatar">{initials(user?.name)}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="bold small ellipsis">{user?.name}</div>
              <div className="tiny muted ellipsis">{user?.email}</div>
            </div>
            <span className="badge" style={{ textTransform: 'capitalize' }}>{user?.role}</span>
          </div>
          <div className="divider" />
          {items.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} role="menuitem" onClick={() => setOpen(false)}><Icon size={16} /> {label}</Link>
          ))}
          <div className="divider" />
          <button className="menu-item danger" role="menuitem" onClick={onLogout}><LogOut size={16} /> Log out</button>
        </div>
      )}
    </div>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const items = NAV[user?.role] || [];
  const navRef = useRef(null);
  const pillRef = useRef(null);
  const pageRef = useRef(null);

  // Sliding pill behind the active nav item.
  useLayoutEffect(() => {
    const active = navRef.current?.querySelector('a.active');
    const pill = pillRef.current;
    if (!pill) return;
    if (!active) {
      gsap.to(pill, { autoAlpha: 0, duration: 0.2 });
      return;
    }
    const first = !pill.dataset.ready;
    pill.dataset.ready = '1';
    gsap.to(pill, {
      x: active.offsetLeft - 4,
      width: active.offsetWidth,
      autoAlpha: 1,
      duration: first || reducedMotion() ? 0 : 0.5,
      ease: 'expo.out',
    });
  }, [pathname]);

  // 3D page transition on route change.
  useGSAP(
    () => {
      if (reducedMotion() || !pageRef.current) return;
      gsap.fromTo(
        pageRef.current,
        { autoAlpha: 0, y: 20, rotationX: 4, transformPerspective: 1400, transformOrigin: '50% 0%' },
        { autoAlpha: 1, y: 0, rotationX: 0, duration: 0.6, ease: 'expo.out', clearProps: 'transform' },
      );
    },
    { dependencies: [pathname] },
  );

  return (
    <>
      <header className="topbar">
        <Logo to={items[0]?.to || '/'} />
        {items.length > 1 && (
          <nav className="nav" ref={navRef} aria-label="Main">
            <span className="nav-pill" ref={pillRef} aria-hidden="true" />
            {items.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end}>
                <Icon size={16} /> {label}
              </NavLink>
            ))}
          </nav>
        )}
        <div className="topbar-right">
          <StatusChip user={user} />
          <ProfileMenu
            user={user}
            items={items}
            onLogout={() => {
              logout();
              navigate('/');
            }}
          />
        </div>
      </header>
      <main ref={pageRef} className="has-mobile-nav" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </main>
      {items.length > 1 && (
        <nav className="mobile-nav">
          {items.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}>
              <Icon size={20} />
              {label}
            </NavLink>
          ))}
        </nav>
      )}
    </>
  );
}
