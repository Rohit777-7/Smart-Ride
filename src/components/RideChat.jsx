import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, CheckCheck, Clock3, MessageCircle, SendHorizontal, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { CHAT_MAX, useRideChat } from '../lib/chat.js';
import { useToast } from '../lib/toast.jsx';
import { initials, timeOnly } from '../lib/format.js';
import { gsap, reducedMotion, useGSAP } from '../lib/motion.jsx';

const QUICK = {
  passenger: {
    accepted: ["I'm at the pickup point", "I'll be there in 2 minutes", 'Where are you now?', 'Please call me when you arrive'],
    arrived: ['Coming out now', 'Give me 2 minutes, please', 'Which side of the road are you on?'],
    in_progress: ['Please turn on the AC', 'Can we stop for a minute?', 'Thank you!'],
  },
  driver: {
    accepted: ['On my way', 'Stuck in a little traffic', 'Where exactly should I pick you up?'],
    arrived: ["I've arrived at the pickup", "I'm waiting near the main gate", 'Please share the trip PIN when you board'],
    in_progress: ["We'll reach in about 5 minutes", 'Okay, no problem'],
  },
};

/**
 * Message button + chat panel for the rider and driver of an active ride.
 * `variant="button"` renders a labelled button, `variant="icon"` a compact icon button.
 */
export default function RideChat({ ride, role, variant = 'button' }) {
  const { user } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const peerName = role === 'passenger' ? ride?.driver_name : ride?.passenger_name;
  const first = (peerName || '').split(' ')[0] || (role === 'passenger' ? 'Driver' : 'Passenger');
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  // Pop a toast for live messages that arrive while the panel is closed.
  const chat = useRideChat(ride?.id, user?.id, ride?.status, (m) => {
    if (!openRef.current) toast(m.body, 'info', `${first} sent a message`);
  });

  // Reading the panel marks everything as read (only while the tab is actually visible).
  const { markRead, unread } = chat;
  useEffect(() => {
    if (open && unread > 0 && document.visibilityState === 'visible') markRead();
  }, [open, unread, markRead]);

  if (!ride?.id) return null;
  const label = unread ? `Message ${first}, ${unread} unread` : `Message ${first}`;

  return (
    <>
      {variant === 'fab' ? (
        <button type="button" className={`icon-btn chat-trigger chat-fab ${unread ? 'has-unread' : ''}`} onClick={() => setOpen(true)} aria-label={label} title={`Message ${first}`}>
          <MessageCircle size={20} />
          {unread > 0 && <span className="chat-badge">{unread}</span>}
        </button>
      ) : variant === 'icon' ? (
        <button type="button" className="icon-btn chat-trigger" onClick={() => setOpen(true)} aria-label={label} title="Message">
          <MessageCircle size={18} />
          {unread > 0 && <span className="chat-badge">{unread}</span>}
        </button>
      ) : (
        <button type="button" className="btn btn-ghost chat-trigger" onClick={() => setOpen(true)} aria-label={label}>
          <MessageCircle size={16} /> Message
          {unread > 0 && <span className="chat-badge">{unread}</span>}
        </button>
      )}
      {open && createPortal(<ChatPanel ride={ride} role={role} chat={chat} meId={user?.id} peerName={peerName} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ChatPanel({ ride, role, chat, meId, peerName, onClose }) {
  const [text, setText] = useState('');
  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);
  const quick = QUICK[role]?.[ride.status] || [];
  const subtitle = role === 'passenger'
    ? [[ride.vehicle_color, ride.vehicle_model].filter(Boolean).join(' '), ride.vehicle_number].filter(Boolean).join(' · ')
    : 'Your passenger';

  useGSAP(() => {
    if (reducedMotion()) return;
    gsap.from(panelRef.current, { y: 40, rotationX: -12, autoAlpha: 0, scale: 0.96, transformPerspective: 900, transformOrigin: '50% 100%', duration: 0.5, ease: 'expo.out', clearProps: 'transform,opacity,visibility' });
  }, { scope: panelRef });

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // keep the newest message in view
  const count = chat.messages.length;
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: count ? 'smooth' : 'auto' });
  }, [count, chat.peerTyping]);

  function submit(e) {
    e?.preventDefault();
    if (!text.trim()) return;
    chat.send(text);
    setText('');
    inputRef.current?.focus();
  }

  const lastMineId = [...chat.messages].reverse().find((m) => m.sender_id === meId && !m.pending && !m.failed)?.id;

  return (
    <div className="chat-layer" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="chat-panel" ref={panelRef} role="dialog" aria-label={`Chat with ${peerName || 'your ' + (role === 'passenger' ? 'driver' : 'passenger')}`}>
        <header className="chat-head">
          <span className="chat-avatar">{initials(peerName || '?')}<i className={chat.canSend ? 'on' : ''} /></span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="bold ellipsis">{peerName || 'Chat'}</div>
            <div className={`tiny ellipsis ${chat.peerTyping ? 'chat-typing-label' : 'muted'}`} aria-live="polite">
              {chat.peerTyping ? 'typing…' : subtitle}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close chat"><X size={18} /></button>
        </header>

        <div className="chat-body" ref={bodyRef}>
          <div className="chat-note">
            <ShieldCheck size={14} />
            <span>Messages are saved with this trip for your safety. Never share OTPs or payment details here.</span>
          </div>
          {count === 0 && (
            <div className="chat-empty">
              <span><MessageCircle size={22} /></span>
              <b>Say hello 👋</b>
              <p>{role === 'passenger' ? `Let ${peerName?.split(' ')[0] || 'your driver'} know exactly where to find you.` : 'Let your passenger know you are on the way.'}</p>
            </div>
          )}
          <ol className="chat-list" aria-live="polite">
            {chat.messages.map((m, i) => {
              const mine = m.sender_id === meId;
              const next = chat.messages[i + 1];
              const endOfGroup = !next || next.sender_id !== m.sender_id;
              return (
                <li key={m.id} className={`chat-msg ${mine ? 'mine' : 'theirs'} ${endOfGroup ? 'tail' : ''} ${m.failed ? 'failed' : ''}`}>
                  <div className="chat-bubble">{m.body}</div>
                  {(endOfGroup || m.failed) && (
                    <div className="chat-meta">
                      {m.failed ? (
                        <button type="button" className="chat-retry" onClick={() => chat.retry(m)}>
                          <AlertCircle size={12} /> Not sent · Tap to retry
                        </button>
                      ) : (
                        <>
                          <span>{timeOnly(m.created_at)}</span>
                          {mine && (m.pending
                            ? <Clock3 size={12} aria-label="Sending" />
                            : m.read_at
                              ? <CheckCheck size={13} className="read" aria-label="Read" />
                              : <Check size={13} aria-label="Sent" />)}
                          {mine && m.id === lastMineId && m.read_at && <span className="read">Seen</span>}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {chat.peerTyping && (
              <li className="chat-msg theirs tail">
                <div className="chat-bubble chat-dots" aria-label={`${peerName} is typing`}><i /><i /><i /></div>
              </li>
            )}
          </ol>
        </div>

        {chat.canSend ? (
          <footer className="chat-foot">
            {quick.length > 0 && (
              <div className="chat-quick" aria-label="Quick replies">
                {quick.map((q) => (
                  <button key={q} type="button" onClick={() => chat.send(q)}>{q}</button>
                ))}
              </div>
            )}
            <form className="chat-input" onSubmit={submit}>
              <input
                ref={inputRef}
                value={text}
                maxLength={CHAT_MAX}
                placeholder="Type a message…"
                aria-label="Message"
                onChange={(e) => {
                  setText(e.target.value);
                  chat.setMeTyping(!!e.target.value);
                }}
                onBlur={() => chat.setMeTyping(false)}
              />
              <button className="chat-send" disabled={!text.trim()} aria-label="Send message"><SendHorizontal size={18} /></button>
            </form>
            {text.length > CHAT_MAX - 60 && <div className="tiny muted chat-count">{CHAT_MAX - text.length} characters left</div>}
          </footer>
        ) : (
          <footer className="chat-closed">Chat closed. It is only available while a trip is active.</footer>
        )}
      </section>
    </div>
  );
}
