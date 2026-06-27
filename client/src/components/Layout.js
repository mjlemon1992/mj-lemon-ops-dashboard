import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { parseAlerts } from '../utils/alerts';

const NAV = [
  { path: '/', label: 'Home', icon: '⌂', section: 'Overview' },
  { path: '/scorecard', label: 'Scorecard', icon: '✦', section: null, roles: ['owner', 'partner'] },
  { path: '/performance', label: 'Performance', icon: '◈', section: null },
  { path: '/technicians', label: 'Technicians', icon: '⚒', section: null },
  { path: '/alerts', label: 'Alerts', icon: '◉', section: null },
  { path: '/reports', label: 'Reports', icon: '▤', section: 'Reports', roles: ['owner', 'partner'] },
  { path: '/finance', label: 'Finance', icon: '$', section: null, roles: ['owner', 'partner'] },
  { path: '/marketing', label: 'Marketing', icon: '◆', section: null, roles: ['owner', 'partner'] },
  { path: '/comebacks', label: 'Comebacks', icon: '↩', section: null, roles: ['owner', 'partner', 'manager'] },
  { path: '/wip', label: 'Committed WIP', icon: '📋', section: null, roles: ['owner', 'partner', 'manager'] },
  { path: '/locations', label: 'Locations', icon: '◎', section: 'Settings', roles: ['owner'] },
  { path: '/targets', label: 'Targets', icon: '◎', section: null, roles: ['owner', 'partner'] },
  { path: '/users', label: 'Users', icon: '◈', section: null, roles: ['owner'] },
];

export default function Layout() {
  const { user, logout, api } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [alertCount, setAlertCount] = useState(0);

  // Live count for the sidebar badge + header pill. Owners/partners see the
  // group total; a manager sees only their own location's alerts.
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    const path = (user.role === 'manager' && user.location_id)
      ? `/metrics/${user.location_id}/summary`
      : '/metrics/group/summary';
    api(path)
      .then(res => {
        const rows = Array.isArray(res) ? res : [res];
        return rows.reduce((n, m) => n + parseAlerts(m).length, 0);
      })
      .then(n => { if (!cancelled) setAlertCount(n); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user, api]);

  const visibleNav = NAV.filter(n => !n.roles || n.roles.includes(user?.role));

  const initials = user?.name ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : 'U';

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* Sidebar */}
      <div style={{ width: 220, flexShrink: 0, background: 'var(--bg2)', borderRight: '0.5px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 16px 14px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--bg3)', border: '0.5px solid rgba(240,84,35,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <img src={`${process.env.PUBLIC_URL}/mt-mark.png`} alt="Mister Transmission" style={{ width: 22, height: 'auto', display: 'block' }} />
          </div>
          <div>
            <div style={{ fontFamily: "'Archivo', sans-serif", fontSize: '18px', fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.3px', lineHeight: 1 }}>OPS</div>
            <div style={{ fontSize: '9.5px', fontWeight: '600', letterSpacing: '0.12em', color: 'var(--text3)', textTransform: 'uppercase', marginTop: '3px' }}>MJ Lemon</div>
          </div>
        </div>

        <div style={{ margin: '12px', padding: '8px 10px', background: 'var(--bg3)', borderRadius: 'var(--radius)', fontSize: '12px' }}>
          <div style={{ fontWeight: '500', color: 'var(--text)' }}>All locations</div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '1px', textTransform: 'capitalize' }}>{user?.role} view</div>
        </div>

        <nav style={{ padding: '4px 8px', flex: 1, overflowY: 'auto' }}>
          {visibleNav.map((item, i) => {
            const active = location.pathname === item.path;
            const prevItem = visibleNav[i - 1];
            const showSection = item.section && (!prevItem || prevItem.section !== item.section);
            return (
              <React.Fragment key={item.path}>
                {showSection && (
                  <div style={{ fontSize: '10px', fontWeight: '500', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '12px 8px 4px' }}>
                    {item.section}
                  </div>
                )}
                <div
                  onClick={() => navigate(item.path)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '7px 8px', borderRadius: 'var(--radius)',
                    cursor: 'pointer', fontSize: '13px',
                    color: active ? 'var(--accent)' : 'var(--text2)',
                    background: active ? 'rgba(240,84,35,0.12)' : 'transparent',
                    boxShadow: active ? 'inset 2px 0 0 var(--accent)' : 'none',
                    fontWeight: active ? '500' : '400',
                    marginBottom: '1px'
                  }}
                >
                  <span style={{ fontSize: '14px' }}>{item.icon}</span>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.path === '/alerts' && alertCount > 0 && (
                    <span style={{ background: 'rgba(255,77,77,0.15)', color: 'var(--danger)', fontSize: '10px', padding: '1px 6px', borderRadius: '10px' }}>{alertCount}</span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </nav>

        <div style={{ padding: '12px', borderTop: '0.5px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(240,84,35,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '500', color: 'var(--accent)', flexShrink: 0 }}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12px', fontWeight: '500', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', textTransform: 'capitalize' }}>{user?.role}</div>
            </div>
            <button onClick={logout} style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: '16px', padding: '4px', cursor: 'pointer' }} title="Sign out">⏻</button>
          </div>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ background: 'var(--bg2)', borderBottom: '0.5px solid var(--border)', padding: '0 24px', height: '52px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ fontFamily: "'Archivo', sans-serif", fontSize: '20px', fontWeight: 800, letterSpacing: '-0.5px', color: 'var(--text)' }}>
            {visibleNav.find(n => n.path === location.pathname)?.label || 'Dashboard'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {alertCount > 0 && (
              <div className="badge danger" style={{ cursor: 'pointer' }} onClick={() => navigate('/alerts')}>
                ⚠ {alertCount} active alerts
              </div>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
