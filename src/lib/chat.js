import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { emitSocket, useSocketConnection, useSocketEvent } from './socket.js';

export const CHAT_OPEN = ['accepted', 'arrived', 'in_progress'];
export const CHAT_MAX = 500;

let tempSeq = 0;

/**
 * Live chat for one ride: history, incoming messages, read receipts and the other
 * person's typing indicator. Messages sent here show instantly (optimistic) and are
 * reconciled with the server copy that comes back over HTTP or the socket.
 */
export function useRideChat(rideId, meId, status, onIncoming) {
  // State is tagged with the ride it belongs to, so switching rides never shows stale messages.
  const [state, setState] = useState({ rideId: null, messages: [] });
  const [typing, setTyping] = useState({ rideId: null, on: false });
  const typingTimer = useRef(null);
  const incomingRef = useRef(onIncoming);
  useEffect(() => {
    incomingRef.current = onIncoming;
  });
  const lastTypingEmit = useRef(0);
  const messages = state.rideId === rideId ? state.messages : [];
  const canSend = !!rideId && CHAT_OPEN.includes(status);

  const load = useCallback(() => {
    if (!rideId) return;
    api(`/rides/${rideId}/messages`)
      .then((r) => setState((s) => ({ rideId, messages: merge(s.rideId === rideId ? s.messages : [], r.messages) })))
      .catch(() => {});
  }, [rideId]);

  useEffect(() => {
    load();
  }, [load]);
  useSocketConnection((connected) => connected && load());

  useSocketEvent('chat:message', (m) => {
    if (m.ride_id !== rideId) return;
    setState((s) => ({ rideId, messages: merge(s.rideId === rideId ? s.messages : [], [m]) }));
    if (m.sender_id !== meId) {
      setTyping({ rideId, on: false });
      incomingRef.current?.(m);
    }
  });
  useSocketEvent('chat:read', (e) => {
    if (e.rideId !== rideId || e.readerId === meId) return;
    setState((s) => (s.rideId !== rideId ? s : {
      rideId,
      messages: s.messages.map((m) => (m.sender_id === meId && !m.read_at && !m.pending ? { ...m, read_at: e.at } : m)),
    }));
  });
  useSocketEvent('chat:typing', (e) => {
    if (e.rideId !== rideId || e.from === meId) return;
    setTyping({ rideId, on: e.typing });
    clearTimeout(typingTimer.current);
    if (e.typing) typingTimer.current = setTimeout(() => setTyping({ rideId, on: false }), 6000);
  });
  useEffect(() => () => clearTimeout(typingTimer.current), []);

  const unread = messages.filter((m) => m.sender_id !== meId && !m.read_at).length;

  const markRead = useCallback(() => {
    if (!rideId || unread === 0) return;
    api(`/rides/${rideId}/messages/read`, { method: 'POST' }).catch(() => {});
    const at = new Date().toISOString();
    setState((s) => (s.rideId !== rideId ? s : {
      rideId,
      messages: s.messages.map((m) => (m.sender_id !== meId && !m.read_at ? { ...m, read_at: at } : m)),
    }));
  }, [rideId, meId, unread]);

  const send = useCallback(
    async (text) => {
      const body = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
      if (!body || !rideId) return;
      const tempId = `tmp-${++tempSeq}`;
      const temp = { id: tempId, ride_id: rideId, sender_id: meId, body, created_at: new Date().toISOString(), pending: true };
      setState((s) => ({ rideId, messages: [...(s.rideId === rideId ? s.messages : []), temp] }));
      emitSocket('chat:typing', { rideId, typing: false });
      lastTypingEmit.current = 0;
      try {
        const { message } = await api(`/rides/${rideId}/messages`, { method: 'POST', body: { body } });
        setState((s) => ({ rideId, messages: merge(s.messages.filter((m) => m.id !== tempId), [message]) }));
      } catch (err) {
        setState((s) => ({ rideId, messages: s.messages.map((m) => (m.id === tempId ? { ...m, pending: false, failed: err.message || 'Not sent' } : m)) }));
      }
    },
    [rideId, meId],
  );

  const retry = useCallback(
    (msg) => {
      setState((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== msg.id) }));
      send(msg.body);
    },
    [send],
  );

  /** Tell the other side we're typing (throttled), or that we stopped. */
  const setMeTyping = useCallback(
    (on) => {
      if (!rideId || !canSend) return;
      const now = Date.now();
      if (on && now - lastTypingEmit.current < 2500) return;
      lastTypingEmit.current = on ? now : 0;
      emitSocket('chat:typing', { rideId, typing: on });
    },
    [rideId, canSend],
  );

  return { messages, unread, canSend, peerTyping: typing.rideId === rideId && typing.on && canSend, send, retry, markRead, setMeTyping };
}

/** Merge server messages into the list: dedupe by id and swap out the matching optimistic copy. */
function merge(list, incoming) {
  let out = list;
  for (const m of incoming) {
    if (out.some((x) => x.id === m.id)) continue;
    const tempIdx = out.findIndex((x) => x.pending && x.sender_id === m.sender_id && x.body === m.body);
    out = tempIdx >= 0 ? out.map((x, i) => (i === tempIdx ? m : x)) : [...out, m];
  }
  return [...out].sort((a, b) => (a.pending === b.pending ? new Date(a.created_at) - new Date(b.created_at) : a.pending ? 1 : -1));
}
