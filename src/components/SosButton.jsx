import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Copy, Phone, Shield, Siren } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Modal, Spinner } from './ui.jsx';

/**
 * SOS / emergency interface. Lets the rider call emergency services, alert the
 * platform safety team + saved emergency contacts with live location, and share the trip.
 */
export default function SosButton({ rideId, shareToken, getLocation, compact = false, showContacts = true }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const toast = useToast();
  const shareUrl = shareToken ? `${window.location.origin}/track/${shareToken}` : null;

  async function sendAlert() {
    setSending(true);
    try {
      const loc = getLocation?.() || {};
      const r = await api('/sos', { method: 'POST', body: { rideId, lat: loc.lat, lng: loc.lng, message: 'SOS from app' } });
      setResult(r);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSending(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast('Live trip link copied', 'success');
    } catch {
      toast(shareUrl, 'info', 'Share this link');
    }
  }

  return (
    <>
      <button className={`btn sos-btn ${compact ? 'btn-sm' : ''}`} onClick={() => setOpen(true)} aria-label="Emergency SOS">
        <Siren size={18} /> SOS
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Emergency assistance">
        <div className="col gap-16">
          {!result ? (
            <>
              <button className="btn sos-btn sos-big" onClick={sendAlert} disabled={sending} aria-label="Send SOS alert">
                {sending ? <Spinner size={30} /> : 'SOS'}
              </button>
              <p className="center text-2 small">
                Tap to alert the RideFlow safety team and your emergency contacts with your live location.
              </p>
            </>
          ) : (
            <div className="notice success">
              <CheckCircle2 size={18} />
              <div>
                <div className="bold">Alert sent</div>
                Our safety team has been notified with your location.{' '}
                {result.contactsNotified
                  ? `${result.contactsNotified} emergency contact${result.contactsNotified > 1 ? 's' : ''} alerted${result.contactsWithEmail ? ' by email' : ''}.`
                  : 'You have no emergency contacts saved yet.'}
              </div>
            </div>
          )}
          <a className="btn btn-danger btn-block" href="tel:112">
            <Phone size={18} /> Call emergency services (112)
          </a>
          {shareUrl && (
            <button className="btn btn-ghost btn-block" onClick={copyLink}>
              <Copy size={16} /> Copy live trip link
            </button>
          )}
          <div className="notice">
            <Shield size={16} />
            <div>
              {showContacts ? (
                <>Manage your emergency contacts in <Link to="/ride/account" onClick={() => setOpen(false)}>Account → Safety</Link>.</>
              ) : (
                'Your location and trip details are shared with the safety team.'
              )}
              <div className="tiny muted mt-8">Simulated platform: alerts reach the demo admin dashboard, not real responders. Call 112 in a real emergency.</div>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
