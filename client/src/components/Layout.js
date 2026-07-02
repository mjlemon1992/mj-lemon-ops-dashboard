import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';
import { parseAlerts, alertId } from '../utils/alerts';

const NAV = [
  { path: '/', label: 'Home', icon: '⌂', section: 'Overview' },
  { path: '/chief-of-staff', label: 'Automations', icon: '⏱', section: null, roles: ['owner', 'partner'] },
  { path: '/scorecard', label: 'Scorecard', icon: '✦', section: null, roles: ['owner', 'partner'] },
  { path: '/performance', label: 'Performance', icon: '◈', section: null },
  { path: '/technicians', label: 'Technicians', icon: '⚒', section: null },
  { path: '/alerts', label: 'Alerts', icon: '◉', section: null },
  { path: '/reports', label: 'Reports', icon: '▤', section: 'Reports', roles: ['owner', 'partner'] },
  { path: '/finance', label: 'Finance', icon: '$', section: null, roles: ['owner', 'partner'] },
  { path: '/marketing', label: 'Marketing', icon: '◆', section: null, roles: ['owner', 'partner'] },
  { path: '/comebacks', label: 'Comebacks', icon: '↩', section: null, roles: ['owner', 'partner', 'manager'] },
  { path: '/wip', label: 'Committed WIP', icon: '📋', section: null, roles: ['owner', 'partner', 'manager'] },
  { path: '/notices', label: 'Shop Notices', icon: '📢', section: null, roles: ['owner', 'partner'] },
  { path: '/locations', label: 'Locations', icon: '◎', section: 'Settings', roles: ['owner'] },
  { path: '/targets', label: 'Targets', icon: '◎', section: null, roles: ['owner', 'partner'] },
  { path: '/users', label: 'Users', icon: '◈', section: null, roles: ['owner'] },
];

export default function Layout() {
  const { user, logout, api } = useAuth();
  const { locations, selectedId, isAll, canSwitch, select } = useLocations();
  const navigate = useNavigate();
  const location = useLocation();
  const [alertCount, setAlertCount] = useState(0);
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth <= 768);
  const [navOpen, setNavOpen] = useState(false);

  // Collapse the sidebar into a drawer on phones; restore it on wider screens.
  useEffect(() => {
    const onResize = () => {
      const m = window.innerWidth <= 768;
      setIsMobile(m);
      if (!m) setNavOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Live count for the sidebar badge + header pill, scoped to the current
  // location selection: a specific shop shows its own alerts, "All" the group.
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    const path = isAll ? '/metrics/group/summary' : `/metrics/${selectedId}/summary`;
    Promise.all([api(path), api('/cos/alerts/dismissed').catch(() => [])])
      .then(([res, dismissed]) => {
        const rows = Array.isArray(res) ? res : [res];
        const dset = new Set(dismissed || []);
        return rows.reduce((n, m) => n + parseAlerts(m).filter(a => !dset.has(alertId(a))).length, 0);
      })
      .then(n => { if (!cancelled) setAlertCount(n); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user, api, isAll, selectedId]);

  const visibleNav = NAV.filter(n => !n.roles || n.roles.includes(user?.role));
  const initials = user?.name ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : 'U';
  const go = (path) => { navigate(path); if (isMobile) setNavOpen(false); };

  const sidebarStyle = {
    width: 220, flexShrink: 0, background: 'var(--bg2)', borderRight: '0.5px solid var(--border)',
    display: 'flex', flexDirection: 'column',
    ...(isMobile ? {
      position: 'fixed', top: 0, left: 0, height: '100%', zIndex: 50, width: 250,
      transform: navOpen ? 'translateX(0)' : 'translateX(-100%)',
      transition: 'transform 0.25s ease',
      boxShadow: navOpen ? '2px 0 16px rgba(0,0,0,0.35)' : 'none',
    } : {}),
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* Backdrop (mobile drawer) */}
      {isMobile && navOpen && (
        <div onClick={() => setNavOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 45 }} />
      )}

      {/* Sidebar */}
      <div style={sidebarStyle}>
        <div style={{ padding: '18px 16px 14px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--bg3)', border: '0.5px solid rgba(240,84,35,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <img src={`${process.env.PUBLIC_URL}/mt-mark.png`} alt="Mister Transmission" style={{ width: 22, height: 'auto', display: 'block' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Archivo', sans-serif", fontSize: '18px', fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.3px', lineHeight: 1 }}>OPS</div>
            <div style={{ fontSize: '9.5px', fontWeight: '600', letterSpacing: '0.12em', color: 'var(--text3)', textTransform: 'uppercase', marginTop: '3px' }}>MJ Lemon</div>
          </div>
          {isMobile && (
            <button onClick={() => setNavOpen(false)} aria-label="Close menu" style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: '20px', cursor: 'pointer', padding: '2px 4px', lineHeight: 1 }}>✕</button>
          )}
        </div>

        <div style={{ margin: '12px', padding: '8px 10px', background: 'var(--bg3)', borderRadius: 'var(--radius)' }}>
          {canSwitch ? (
            <select
              value={selectedId}
              onChange={e => select(e.target.value)}
              aria-label="Location"
              style={{ width: '100%', background: 'transparent', border: 'none', padding: 0, fontSize: '12px', fontWeight: 500, color: 'var(--text)', cursor: 'pointer', outline: 'none' }}
            >
              <option value="all">All locations</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          ) : (
            <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)' }}>
              {locations.find(l => l.id === selectedId)?.name || 'Location'}
            </div>
          )}
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
                  onClick={() => go(item.path)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: isMobile ? '11px 8px' : '7px 8px', borderRadius: 'var(--radius)',
                    cursor: 'pointer', fontSize: '13px',
                    color: active ? 'var(--accent)' : 'var(--text2)',
                    background: active ? 'rgba(240,84,35,0.12)' : 'transparent',
                    boxShadow: active ? 'inset 2px 0 0 var(--accent)' : 'none',
                    fontWeight: active ? '500' : '400',
                    marginBottom: '1px',
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <div style={{ background: 'var(--bg2)', borderBottom: '0.5px solid var(--border)', padding: isMobile ? '0 14px' : '0 24px', height: '52px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            {isMobile && (
              <button onClick={() => setNavOpen(true)} aria-label="Open menu" style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: '22px', cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 }}>☰</button>
            )}
            <div style={{ fontFamily: "'Archivo', sans-serif", fontSize: isMobile ? '17px' : '20px', fontWeight: 800, letterSpacing: '-0.5px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {visibleNav.find(n => n.path === location.pathname)?.label || 'Dashboard'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            {alertCount > 0 && (
              <div className="badge danger" style={{ cursor: 'pointer' }} onClick={() => navigate('/alerts')}>
                ⚠ {alertCount}{isMobile ? '' : ' active alerts'}
              </div>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px 14px' : '20px 24px' }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
