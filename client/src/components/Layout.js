import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';
import { parseAlerts, alertId } from '../utils/alerts';
import Icon from './Icon';
import { FeedbackHost } from './Feedback';
import WaitingRail from './WaitingRail';

// Grouped nav (2026-07-17 refresh): same items, same roles — organized into five
// sections so the sidebar reads in blocks instead of a flat list. Every item
// carries its section so labels survive role filtering (showSection compares
// against the previous VISIBLE item).
const NAV = [
  { path: '/', label: 'Home', icon: 'home', section: 'Overview' },
  { path: '/scorecard', label: 'Scorecard', icon: 'chart', section: 'Overview', roles: ['owner', 'partner'] },
  { path: '/performance', label: 'Performance', icon: 'gauge', section: 'Overview' },
  { path: '/alerts', label: 'Alerts', icon: 'bell', section: 'Overview' },
  { path: '/technicians', label: 'Technicians', icon: 'wrench', section: 'Crew' },
  { path: '/time-clock', label: 'Time Clock', icon: 'clock', section: 'Crew', roles: ['owner', 'partner', 'manager'] },
  { path: '/bonus', label: 'Bonus', icon: 'award', section: 'Crew', roles: ['owner', 'partner', 'manager'] },
  { path: '/fuel-card', label: 'Fuel Card', icon: 'fuel', section: 'Crew', roles: ['owner', 'partner', 'manager'] },
  { path: '/comebacks', label: 'Comebacks', icon: 'undo', section: 'Shop', roles: ['owner', 'partner', 'manager'] },
  { path: '/wip', label: 'Committed WIP', icon: 'clipboard', section: 'Shop', roles: ['owner', 'partner', 'manager'] },
  { path: '/notices', label: 'Shop Notices', icon: 'megaphone', section: 'Shop', roles: ['owner', 'partner', 'manager'] },
  { path: '/finance', label: 'Finance', icon: 'dollar', section: 'Money', roles: ['owner', 'partner', 'manager'] },
  { path: '/reports', label: 'Reports', icon: 'file', section: 'Money', roles: ['owner', 'partner', 'manager'] },
  { path: '/marketing', label: 'Marketing', icon: 'spark', section: 'Marketing', roles: ['owner', 'partner', 'manager'] },
  { path: '/locations', label: 'Locations', icon: 'pin', section: 'Settings', roles: ['owner'] },
  { path: '/targets', label: 'Targets', icon: 'target', section: 'Settings', roles: ['owner', 'partner', 'manager'] },
  { path: '/users', label: 'Users', icon: 'users', section: 'Settings', roles: ['owner'] },
  { path: '/chief-of-staff', label: 'Automations', icon: 'gear', section: 'Settings', roles: ['owner', 'partner'] },
];

export default function Layout() {
  const { user, logout, api } = useAuth();
  const { locations, selectedId, isAll, canSwitch, select } = useLocations();
  // Light/dark mode — per device, dark by default (shop-floor boards and the
  // kiosk keep their own default; this only follows the toggle on THIS device).
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);
  const navigate = useNavigate();
  const location = useLocation();
  const [alertCount, setAlertCount] = useState(0);
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth <= 768);
  const [navOpen, setNavOpen] = useState(false);
  const [attention, setAttention] = useState({ items: [], total: 0, detail: null });
  const [attnOpen, setAttnOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('ops_rail') !== 'off');

  // "Waiting on you" — human queues (holiday requests, punch changes,
  // unassigned fuel, bonus prompt). One aggregate call, refreshed every minute.
  const canQueue = user && ['owner', 'partner', 'manager'].includes(user.role);
  const loadAttention = React.useCallback(() => {
    if (!canQueue) return;
    api('/attention')
      .then(d => { if (d && Array.isArray(d.items)) setAttention(d); })
      .catch(() => {});
  }, [api, canQueue]);
  useEffect(() => {
    if (!canQueue) return undefined;
    loadAttention();
    const t = setInterval(loadAttention, 60000);
    return () => clearInterval(t);
  }, [canQueue, loadAttention]);
  // Dismissed nudge cards (fuel/bonus) — per device; bonus keys include the
  // month so next month's prompt returns. Kept here so the pill count, rail
  // visibility and the cards all agree.
  const [dismissed, setDismissed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ops_rail_dismissed') || '[]')); } catch { return new Set(); }
  });
  const dismissCard = (key) => setDismissed(prev => {
    const next = new Set(prev); next.add(key);
    localStorage.setItem('ops_rail_dismissed', JSON.stringify([...next]));
    return next;
  });
  const _raw = attention.detail || {};
  const d = {
    timeoff: _raw.timeoff || [],
    edits: _raw.edits || [],
    fuel: (_raw.fuel || []).filter(r => !dismissed.has(`fuel-${r.location_id}-${r.n}-${r.total}`)),
    reorders: _raw.reorders || [],
    bonus: (_raw.bonus || []).filter(b => !dismissed.has(`bonus-${b.location_id}-${b.month}`)),
  };
  const railCount = d.timeoff.length + d.edits.length + d.fuel.length + d.reorders.length + d.bonus.length;
  const showRail = !isMobile && railOpen && railCount > 0;
  const toggleRail = () => {
    if (isMobile) { setAttnOpen(o => !o); return; }
    setRailOpen(o => { localStorage.setItem('ops_rail', o ? 'off' : 'on'); return !o; });
  };

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
                  <div style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '9.5px', fontWeight: '600', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em', padding: '12px 8px 4px' }}>
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
                  <Icon name={item.icon} size={15} />
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
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: isMobile ? '19px' : '22px', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {visibleNav.find(n => n.path === location.pathname)?.label || 'Dashboard'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, position: 'relative' }}>
            {railCount > 0 && (
              <>
                <div className="badge warning" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={toggleRail}>
                  ⏳ {railCount}{isMobile ? '' : ' waiting on you'}
                </div>
                {isMobile && attnOpen && (
                  <>
                    <div onClick={() => setAttnOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
                    <div style={{ position: 'absolute', top: '40px', right: 0, zIndex: 61, minWidth: 260, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '10px', boxShadow: '0 8px 28px rgba(0,0,0,0.35)', padding: '6px', maxHeight: '60vh', overflowY: 'auto' }}>
                      <div className="section-label" style={{ padding: '6px 10px 4px' }}>Waiting on you</div>
                      {/* Built from the SAME filtered detail as the pill and rail —
                          bonus prompts included, dismissed cards excluded. */}
                      {[
                        ...d.timeoff.map(r => ({ key: `to-${r.id}`, icon: '🏖', text: `${r.person_name} — holiday request`, loc: r.location_id, locName: r.location_name, path: '/time-clock' })),
                        ...d.edits.map(r => ({ key: `ed-${r.id}`, icon: '✎', text: `${r.person_name} — punch change`, loc: r.location_id, locName: r.location_name, path: '/time-clock' })),
                        ...d.fuel.map(r => ({ key: `fu-${r.location_id}`, icon: '⛽', text: `${r.n} unassigned fuel purchase${r.n === 1 ? '' : 's'}`, loc: r.location_id, locName: r.location_name, path: '/fuel-card' })),
                        ...d.reorders.map(r => ({ key: `ro-${r.id}`, icon: '📦', text: `Re-order: ${r.item}`, loc: r.location_id, locName: r.location_name, path: '/time-clock' })),
                        ...d.bonus.map(b => ({ key: `bo-${b.location_id}`, icon: '◆', text: `Bonus — ${b.status === 'draft' ? 'draft awaiting lock' : 'month open'}`, loc: b.location_id, locName: b.location_name, path: '/bonus' })),
                      ].map((it) => (
                        <div key={it.key}
                          onClick={() => { setAttnOpen(false); select(it.loc); navigate(it.path); }}
                          style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '7px', cursor: 'pointer', fontSize: '12.5px', color: 'var(--text)' }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg3)'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                          <span style={{ fontSize: '14px' }}>{it.icon}</span>
                          <span style={{ flex: 1 }}>{it.text}</span>
                          <span style={{ fontSize: '11px', color: 'var(--text3)' }}>{it.locName}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            {alertCount > 0 && (
              <div className="badge danger" style={{ cursor: 'pointer' }} onClick={() => navigate('/alerts')}>
                ⚠ {alertCount}{isMobile ? '' : ' active alerts'}
              </div>
            )}
            <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label="Toggle light/dark mode"
              style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: '8px', padding: '4px 10px', fontSize: '14px', cursor: 'pointer', lineHeight: 1.3 }}>
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </div>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px 14px' : '20px 24px', minWidth: 0 }}>
            <Outlet />
          </div>
          {showRail && (
            <div style={{ width: 300, flexShrink: 0, overflowY: 'auto', borderLeft: '0.5px solid var(--border)', background: 'var(--bg2)' }}>
              <WaitingRail detail={d} api={api} onAction={loadAttention} onClose={toggleRail} onDismiss={dismissCard} multiLoc={locations.length > 1} />
            </div>
          )}
        </div>
      </div>
      <FeedbackHost />
    </div>
  );
}
