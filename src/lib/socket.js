import { io } from 'socket.io-client';
import { useEffect, useRef } from 'react';

let socket = null;
// Listeners live in a registry so components can subscribe before/after the socket connects.
const listeners = new Map();
const connListeners = new Set();

export function connectSocket(token) {
  if (socket) socket.disconnect();
  socket = io('/', { auth: { token }, transports: ['websocket', 'polling'] });
  socket.onAny((event, data) => listeners.get(event)?.forEach((fn) => fn(data)));
  socket.on('connect', () => connListeners.forEach((fn) => fn(true)));
  socket.on('disconnect', () => connListeners.forEach((fn) => fn(false)));
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export const isSocketConnected = () => !!socket?.connected;

/** Subscribe to a socket event for the lifetime of the component. */
export function useSocketEvent(event, handler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const fn = (data) => ref.current(data);
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }, [event]);
}

/** Called with true/false whenever the socket (re)connects or drops. */
export function useSocketConnection(handler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const fn = (c) => ref.current(c);
    connListeners.add(fn);
    return () => connListeners.delete(fn);
  }, []);
}

export function emitSocket(event, data) {
  socket?.emit(event, data);
}
