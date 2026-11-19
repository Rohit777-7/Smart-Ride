import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { homeFor, useAuth } from './lib/auth.jsx';
import { useSocketEvent } from './lib/socket.js';
import { useToast } from './lib/toast.jsx';
import AppShell from './components/AppShell.jsx';
import { PageLoading } from './components/ui.jsx';
import Landing from './pages/Landing.jsx';
import { Login, Signup } from './pages/Auth.jsx';
import PassengerHome from './pages/passenger/PassengerHome.jsx';
import RideHistory from './pages/passenger/RideHistory.jsx';
import Account from './pages/passenger/Account.jsx';
import Receipt from './pages/Receipt.jsx';
import TrackTrip from './pages/TrackTrip.jsx';
import DriverHome from './pages/driver/DriverHome.jsx';
// Chart-heavy pages are loaded on demand.
const DriverEarnings = lazy(() => import('./pages/driver/DriverEarnings.jsx'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard.jsx'));

function RequireRole({ roles, children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <PageLoading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}

function GlobalNotifications() {
  const toast = useToast();
  useSocketEvent('notify', (n) => toast(n.body, 'info', n.title));
  return null;
}

export default function App() {
  const { ready } = useAuth();
  if (!ready) return <PageLoading />;
  return (
    <>
      <GlobalNotifications />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/track/:token" element={<TrackTrip />} />
        <Route
          element={
            <RequireRole>
              <AppShell />
            </RequireRole>
          }
        >
          <Route path="/ride" element={<RequireRole roles={['passenger']}><PassengerHome /></RequireRole>} />
          <Route path="/ride/history" element={<RequireRole roles={['passenger']}><RideHistory /></RequireRole>} />
          <Route path="/ride/account" element={<RequireRole roles={['passenger']}><Account /></RequireRole>} />
          <Route path="/driver" element={<RequireRole roles={['driver']}><DriverHome /></RequireRole>} />
          <Route path="/driver/earnings" element={<RequireRole roles={['driver']}><Suspense fallback={<PageLoading />}><DriverEarnings /></Suspense></RequireRole>} />
          <Route path="/admin" element={<RequireRole roles={['admin']}><Suspense fallback={<PageLoading />}><AdminDashboard /></Suspense></RequireRole>} />
          <Route path="/receipt/:id" element={<Receipt />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
