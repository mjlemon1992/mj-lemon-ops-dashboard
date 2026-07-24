import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';
import { parseAlerts, alertId } from '../utils/alerts';
import Icon from './Icon';
import { FeedbackHost, showToast } from './Feedback';
import Inbox from './Inbox';
import { NUMBERS_TABS, MONEY_TABS, CREW_TABS, SHOP_TABS, tabRoles } from './ia';
import { pushSupported, pushState, enablePush, disablePush, playChime } from '../utils/push';
import { workingDaysLeftInMonth, shopNow } from '../utils/pace';

// Grouped nav (2026-07-17 refresh): same items, same roles — organized into five
// sections so the sidebar reads in blocks instead of a flat list. Every item
// carries its section so labels survive role filtering (showSection compares
// against the previous VISIBLE item).
// Phase 3 IA: six destinations + Atlas, with Admin pinned below. Destinations
// are prefixes — /crew/bonus lights up Crew. Old URLs all redirect (App.js).
const NAV = [
  { path: '/', label: 'Today', icon: 'home', roles: ['owner', 'partner', 'manager', 'advisor'] },
  { path: '/numbers', label: 'Numbers', icon: 'chart', roles: tabRoles(NUMBERS_TABS) },
  { path: '/money', label: 'Money', icon: 'dollar', roles: tabRoles(MONEY_TABS) },
  { path: '/crew', label: 'Crew', icon: 'users', roles: tabRoles(CREW_TABS) },
  { path: '/shop', label: 'Shop', icon: 'wrench', roles: tabRoles(SHOP_TABS) },
  { path: '/studio', label: 'Studio', icon: 'spark', roles: ['owner', 'partner', 'manager'] },
  { path: '/atlas', label: 'Atlas', icon: 'gear', roles: ['owner', 'partner'] },
  { path: '/alerts', label: 'Alert history', icon: 'bell', section: 'Admin', roles: ['owner', 'partner', 'manager', 'advisor'] },
  { path: '/locations', label: 'Locations', icon: 'pin', section: 'Admin', roles: ['owner'] },
  { path: '/users', label: 'Users', icon: 'key', section: 'Admin', roles: ['owner'] },
];
// Bottom tab bar (phones): the destinations only — Admin lives in the ☰ drawer.
const TAB_BAR = NAV.filter(n => !n.section);
const navActive = (path, pathname) => path === '/' ? pathname === '/' : (pathname === path || pathname.startsWith(path + '/'));

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
  const [watchAlerts, setWatchAlerts] = useState([]);   // visible (undismissed) Watch feed
  const [ackedLocal, setAckedLocal] = useState(() => new Set());  // acked this session
  const alertCount = watchAlerts.filter(a => !ackedLocal.has(alertId(a))).length;
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth <= 768);
  const [navOpen, setNavOpen] = useState(false);
  const [attention, setAttention] = useState({ items: [], total: 0, detail: null });
  // Phase 2: the unified Inbox drawer replaces the ⏳ pill popover, the
  // Home-pinned rail and the separate alerts badge. ops_rail localStorage
  // key retired (harmless if present on devices).
  const [inboxOpen, setInboxOpen] = useState(false);
  const inboxOpenRef = React.useRef(false);
  useEffect(() => { inboxOpenRef.current = inboxOpen; }, [inboxOpen]);

  // "Waiting on you" — human queues (holiday requests, punch changes,
  // unassigned fuel, bonus prompt). One aggregate call, refreshed every minute.
  // Advisors poll too — the server hands them a re-orders-only queue.
  const canQueue = user && ['owner', 'partner', 'manager', 'advisor'].includes(user.role);
  // Chime + toast when something NEW lands in the queue (count rose since the
  // last poll) — the audible half of notifications; Web Push covers app-closed.
  // `unseen` keeps the pill SHAKING (and the tab title flashing) until the
  // queue is actually opened — the chime alone is easy to miss under a hoist.
  const prevTotal = React.useRef(null);
  const [unseen, setUnseen] = useState(false);
  const loadAttention = React.useCallback(() => {
    if (!canQueue) return;
    api('/attention')
      .then(d => {
        if (!d || !Array.isArray(d.items)) return;
        if (prevTotal.current != null && d.total > prevTotal.current) {
          playChime();
          if (!inboxOpenRef.current) setUnseen(true);
          showToast(`⏳ ${d.total - prevTotal.current} new item${d.total - prevTotal.current === 1 ? '' : 's'} waiting on you`);
        }
        if (d.total === 0) setUnseen(false);
        prevTotal.current = d.total;
        setAttention(d);
      })
      .catch(() => {});
  }, [api, canQueue]);

  // Flash the browser-tab title while unseen — a background tab still shows it.
  useEffect(() => {
    if (!unseen) return undefined;
    const original = document.title;
    let flip = false;
    const t = setInterval(() => { flip = !flip; document.title = flip ? '📦 New — OPS' : original; }, 1200);
    return () => { clearInterval(t); document.title = original; };
  }, [unseen]);

  // 🔔 per-device push enrolment state.
  const [pushOn, setPushOn] = useState('off');   // on | off | denied | unsupported
  useEffect(() => { pushState().then(setPushOn).catch(() => setPushOn('unsupported')); }, []);
  const togglePush = async () => {
    try {
      if (pushOn === 'on') { await disablePush(api); setPushOn('off'); showToast('Notifications off on this device'); }
      else { await enablePush(api); setPushOn('on'); showToast('Notifications on — this device gets pinged even with the app closed'); }
    } catch (e) { showToast(String(e.message || e), 'error'); pushState().then(setPushOn).catch(() => {}); }
  };
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
    clockq: _raw.clockq || [],
    bonus: (_raw.bonus || []).filter(b => !dismissed.has(`bonus-${b.location_id}-${b.month}`)),
    parts: (_raw.parts || []).filter(p => !dismissed.has(`parts-${p.id}`)),
  };
  const railCount = d.timeoff.length + d.edits.length + d.fuel.length + d.reorders.length + d.clockq.length + d.bonus.length + d.parts.length;
  const visibleWatch = watchAlerts.filter(a => !ackedLocal.has(alertId(a)));
  const inboxCount = railCount + visibleWatch.length;
  const openInbox = () => { setUnseen(false); setInboxOpen(true); };

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
    // Advisors can't read the group rollup (firewalled) — pin them to their
    // own shop so the Watch feed is honest instead of silently empty.
    const path = (user.role === 'advisor' && user.location_id)
      ? `/metrics/${user.location_id}/summary`
      : (isAll ? '/metrics/group/summary' : `/metrics/${selectedId}/summary`);
    Promise.all([api(path), api('/cos/alerts/dismissed').catch(() => [])])
      .then(([res, dismissed]) => {
        const rows = Array.isArray(res) ? res : [res];
        const dset = new Set(dismissed || []);
        return rows.flatMap(m => parseAlerts(m)).filter(a => !dset.has(alertId(a)));
      })
      .then(list => { if (!cancelled) { setWatchAlerts(list); setAckedLocal(new Set()); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user, api, isAll, selectedId]);

  // Advisors are allow-list only: items must NAME the role. Every other role
  // keeps the default (roleless items are visible to them).
  const visibleNav = NAV.filter(n => (user?.role === 'advisor'
    ? (n.roles || []).includes('advisor')
    : (!n.roles || n.roles.includes(user?.role))));
  const initials = user?.name ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : 'U';
  // Re-tapping where you already are must never reset the destination to its
  // first tab (mid-workflow unmount = lost form state — verify finding).
  const go = (path) => { if (!navActive(path, location.pathname)) navigate(path); if (isMobile) setNavOpen(false); };

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
          <div style={{ width: 32, height: 32, borderRadius: 'var(--radius)', background: 'var(--bg3)', border: '0.5px solid rgba(240,84,35,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <img src={`${process.env.PUBLIC_URL}/mt-mark.png`} alt="Mister Transmission" style={{ width: 22, height: 'auto', display: 'block' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Archivo', sans-serif", fontSize: '18px', fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.3px', lineHeight: 1 }}>OPS</div>
            <div style={{ fontSize: 'var(--fz-micro)', fontWeight: '600', letterSpacing: '0.12em', color: 'var(--text3)', textTransform: 'uppercase', marginTop: '3px' }}>MJ Lemon</div>
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
              style={{ width: '100%', background: 'transparent', border: 'none', padding: 0, fontSize: 'var(--fz-label)', fontWeight: 500, color: 'var(--text)', cursor: 'pointer', outline: 'none' }}
            >
              <option value="all">All locations</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          ) : (
            <div style={{ fontSize: 'var(--fz-label)', fontWeight: 500, color: 'var(--text)' }}>
              {locations.find(l => l.id === selectedId)?.name || 'Location'}
            </div>
          )}
          <div style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)', marginTop: '1px', textTransform: 'capitalize' }}>{user?.role} view</div>
        </div>

        <nav style={{ padding: '4px 8px', flex: 1, overflowY: 'auto' }}>
          {visibleNav.map((item, i) => {
            const active = navActive(item.path, location.pathname);
            const prevItem = visibleNav[i - 1];
            const showSection = item.section && (!prevItem || prevItem.section !== item.section);
            return (
              <React.Fragment key={item.path}>
                {showSection && (
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-micro)', fontWeight: '600', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em', padding: '12px 8px 4px' }}>
                    {item.section}
                  </div>
                )}
                <div
                  onClick={() => go(item.path)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: isMobile ? '11px 8px' : '7px 8px', borderRadius: 'var(--radius)',
                    cursor: 'pointer', fontSize: 'var(--fz-body)',
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
                    <span style={{ background: 'rgba(255,77,77,0.15)', color: 'var(--danger)', fontSize: 'var(--fz-micro)', padding: '1px 6px', borderRadius: 'var(--radius)' }}>{alertCount}</span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </nav>

        <div style={{ padding: '12px', borderTop: '0.5px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(240,84,35,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--fz-label)', fontWeight: '500', color: 'var(--accent)', flexShrink: 0 }}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 'var(--fz-label)', fontWeight: '500', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
              <div style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)', textTransform: 'capitalize' }}>{user?.role}</div>
            </div>
            <button onClick={logout} style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 'var(--fz-title)', padding: '4px', cursor: 'pointer' }} title="Sign out">⏻</button>
          </div>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <div style={{ background: 'var(--bg2)', borderBottom: '0.5px solid var(--border)', padding: isMobile ? '0 14px' : '0 24px', height: '52px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            {isMobile && (
              <button onClick={() => setNavOpen(true)} aria-label="Open menu" style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: 'var(--fz-d3)', cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 }}>☰</button>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-disp)', fontSize: isMobile ? '19px' : '22px', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {visibleNav.find(n => navActive(n.path, location.pathname))?.label || 'Dashboard'}
              </div>
              {!isMobile && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-micro)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text2)', marginTop: '1px' }}>
                  {shopNow().toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {(() => { const prov = (locations.find(l2 => l2.id === selectedId)?.province || locations[0]?.province || 'ab').toLowerCase(); const d = workingDaysLeftInMonth(prov); return ` · ${d} working day${d === 1 ? '' : 's'} left`; })()}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, position: 'relative' }}>
            {canQueue && (
              <div className={`badge ${inboxCount > 0 ? 'warning' : 'neutral'}${unseen ? ' pill-shake' : ''}`}
                role="button" tabIndex={0} aria-label="Open inbox"
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openInbox(); } }}
                onClick={openInbox}
                style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px', fontVariantNumeric: 'tabular-nums' }}>
                <Icon name="mail" size={12} /> {isMobile ? (inboxCount || '') : `Inbox${inboxCount ? ` · ${inboxCount}` : ''}`}
              </div>
            )}
            {canQueue && pushSupported() && (
              <button onClick={togglePush}
                title={pushOn === 'on' ? 'Notifications ON for this device — tap to turn off'
                  : pushOn === 'denied' ? 'Notifications are blocked in the browser settings for this site'
                  : 'Get pinged on this device when something lands in your queue — even with the app closed'}
                aria-label="Toggle notifications"
                style={{ background: 'var(--bg3)', border: `1px solid ${pushOn === 'on' ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 'var(--radius)', padding: '4px 10px', fontSize: 'var(--fz-body)', cursor: 'pointer', lineHeight: 1.3, opacity: pushOn === 'denied' ? 0.5 : 1 }}>
                <Icon name={pushOn === 'on' ? 'bell' : 'bellOff'} size={15} style={{ verticalAlign: 'middle' }} />
              </button>
            )}
            <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label="Toggle light/dark mode"
              style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '4px 10px', fontSize: 'var(--fz-body)', cursor: 'pointer', lineHeight: 1.3 }}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} style={{ verticalAlign: 'middle' }} />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px 14px calc(74px + env(safe-area-inset-bottom))' : '20px 24px', minWidth: 0 }}>
            <Outlet />
          </div>

        </div>
      </div>
      {isMobile && (
        <nav aria-label="Destinations" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 40, display: 'flex', justifyContent: 'space-around', background: 'var(--bg2)', borderTop: '0.5px solid var(--border)', padding: '4px 2px calc(4px + env(safe-area-inset-bottom))' }}>
          {TAB_BAR.filter(n => (n.roles || []).includes(user?.role)).map(item => {
            const active = navActive(item.path, location.pathname);
            return (
              <button key={item.path} onClick={() => { if (!active) navigate(item.path); setNavOpen(false); }}
                aria-current={active ? 'page' : undefined}
                style={{ flex: 1, maxWidth: 88, minHeight: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '3px', background: 'none', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', color: active ? 'var(--accent)' : 'var(--text3)', fontSize: 'var(--fz-micro)', fontWeight: 600, letterSpacing: '0.02em', padding: '4px 2px' }}>
                <Icon name={item.icon} size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>
      )}
      <Inbox open={inboxOpen} onClose={() => { setInboxOpen(false); setUnseen(false); }} detail={d} api={api}
        onAction={loadAttention} onDismiss={dismissCard} multiLoc={locations.length > 1}
        alerts={visibleWatch}
        onAlertAcked={(id) => setAckedLocal(prev => { const n = new Set(prev); n.add(id); return n; })} />
      <FeedbackHost />
    </div>
  );
}
