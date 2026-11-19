import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, onUnauthorized, tokenStore } from './api.js';
import { connectSocket, disconnectSocket } from './socket.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(() => !tokenStore.get());
  const [socketReady, setSocketReady] = useState(0);

  const startSession = useCallback((token, u) => {
    tokenStore.set(token);
    connectSocket(token);
    setSocketReady((n) => n + 1);
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    disconnectSocket();
    setUser(null);
  }, []);

  useEffect(() => {
    onUnauthorized(logout);
    const token = tokenStore.get();
    if (!token) return;
    api('/auth/me')
      .then(({ user: u }) => startSession(token, u))
      .catch(() => tokenStore.clear())
      .finally(() => setReady(true));
  }, [logout, startSession]);

  const login = useCallback(
    async (email, password) => {
      const { token, user: u } = await api('/auth/login', { method: 'POST', body: { email, password } });
      startSession(token, u);
      return u;
    },
    [startSession],
  );

  const signup = useCallback(
    async (payload) => {
      const { token, user: u } = await api('/auth/signup', { method: 'POST', body: payload });
      startSession(token, u);
      return u;
    },
    [startSession],
  );

  const refresh = useCallback(async () => {
    const { user: u } = await api('/auth/me');
    setUser(u);
    return u;
  }, []);

  const value = useMemo(
    () => ({ user, ready, login, signup, logout, refresh, setUser, socketReady }),
    [user, ready, login, signup, logout, refresh, socketReady],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);

// eslint-disable-next-line react-refresh/only-export-components
export const homeFor = (role) => (role === 'driver' ? '/driver' : role === 'admin' ? '/admin' : '/ride');
