import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('ops_token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => {
          // Expired/invalid token → drop it so the app shows Login, not a
          // logged-in shell with no data.
          if (r.status === 401 || r.status === 403) { localStorage.removeItem('ops_token'); setToken(null); return null; }
          return r.ok ? r.json() : null;
        })
        .then(u => { setUser(u); setLoading(false); })
        .catch(() => { setLoading(false); });
    } else {
      setLoading(false);
    }
  }, [token]);

  const login = async (email, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    localStorage.setItem('ops_token', data.token);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  const logout = () => {
    localStorage.removeItem('ops_token');
    setToken(null);
    setUser(null);
  };

  const api = useCallback(async (path, options = {}) => {
    const res = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options.headers }
    });
    // Session expired mid-use → clear and force a clean re-login instead of
    // every call failing behind a still-"logged-in" shell.
    if (res.status === 401) {
      localStorage.removeItem('ops_token'); setToken(null); setUser(null);
      throw new Error('Your session expired — please sign in again.');
    }
    // Read the body once, tolerating an empty body (204) and non-JSON (a Railway
    // 502/504 returns an HTML page — never surface "Unexpected token '<'").
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok) throw new Error((data && data.error) || (res.status >= 500 ? 'Service temporarily unavailable — try again in a moment.' : `Request failed (${res.status})`));
    return data;
  }, [token]);

  return (
    <AuthContext.Provider value={{ user, token, login, logout, api, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
