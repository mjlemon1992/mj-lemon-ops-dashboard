import React from 'react';
import { Outlet, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Phase 3 destination shell: a segmented tab row over the existing, proven
// page components. Tabs are PATH-based (/money/parts, /crew/bonus …) so each
// page's own ?tab= deep links keep working exactly as before — the IA moved,
// the internals didn't (the parity-map rule).
export function Destination({ tabs }) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const allowed = tabs.filter(t => !t.roles || t.roles.includes(user?.role));
  if (!allowed.length) return <Navigate to="/" replace />;

  return (
    <div>
      {allowed.length > 1 && (
        <div style={{ display: 'inline-flex', background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '3px', gap: '2px', marginBottom: '16px', flexWrap: 'wrap' }}>
          {allowed.map(t => {
            const active = location.pathname === t.path || location.pathname.startsWith(t.path + '/');
            return (
              <button key={t.path} onClick={() => { if (!active) navigate(t.path); }}
                style={{
                  border: 'none', borderRadius: 'var(--r-sm)', padding: '6px 14px',
                  fontSize: 'var(--fz-body)', fontWeight: 600, cursor: 'pointer',
                  background: active ? 'var(--bg3)' : 'transparent',
                  color: active ? 'var(--text)' : 'var(--text3)',
                  transition: `background var(--dur-snap) ease-out, color var(--dur-snap) ease-out`,
                }}>
                {t.label}
              </button>
            );
          })}
        </div>
      )}
      <Outlet />
    </div>
  );
}

// Index route of a destination: land on the first tab this role may see,
// keeping query/hash (a deep link to /crew?x=1 must not lose its payload).
export function DefaultTab({ tabs }) {
  const { user } = useAuth();
  const { search, hash } = useLocation();
  const first = tabs.find(t => !t.roles || t.roles.includes(user?.role));
  return <Navigate to={first ? first.path + search + hash : '/'} replace />;
}

// Old URL -> new home, keeping the query string so ?tab= deep links (Inbox
// cards, push notifications, bookmarks, Shopmonkey back-links) still land
// on the exact sub-view they always did.
export function RedirectKeep({ to }) {
  const { search, hash } = useLocation();
  return <Navigate to={to + search + hash} replace />;
}
