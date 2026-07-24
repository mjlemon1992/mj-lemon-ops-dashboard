import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';
import { parseAlerts, alertId, alertTitle, alertSub } from '../utils/alerts';

export default function Alerts() {
  const { api } = useAuth();
  const { scopeLocations } = useLocations();
  const [filter, setFilter] = useState('all');
  const [resolved, setResolved] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  // Stable signature of the scoped location ids so the effect doesn't re-run on
  // every render (scopeLocations is a fresh array each time).
  const scopeKey = scopeLocations.map(l => l.id).join(',');
  // Cleared alerts persist server-side (cos_dismissed_alerts) so a Resolve
  // sticks across reloads and matches what the voice chief of staff clears.
  useEffect(() => {
    let cancelled = false;
    api('/cos/alerts/dismissed').then(keys => { if (!cancelled) setResolved(keys || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [api]);
  useEffect(() => {
    let cancelled = false;
    const ids = scopeKey ? scopeKey.split(',') : [];
    if (!ids.length) { setAlerts([]); setLoading(false); return () => { cancelled = true; }; }
    setLoading(true);
    Promise.all(ids.map(id => api(`/metrics/${id}/summary`).then(parseAlerts).catch(() => [])))
      .then(lists => { if (!cancelled) { setAlerts(lists.flat()); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, scopeKey]);

  const visible = alerts.filter(a => !resolved.includes(alertId(a)));
  const count = type => visible.filter(a => type === 'all' ? true : a.type === type).length;
  const filtered = visible.filter(a => filter === 'all' ? true : a.type === filter);

  if (loading) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading…</div>;

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {[['all', 'All'], ['stale', 'Stale vehicles'], ['margin', 'Margin flags']].map(([val, label]) => (
          <button key={val} onClick={() => setFilter(val)} className={filter === val ? 'primary' : ''}>
            {label} ({count(val)})
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)' }}>
          No active alerts — all clear ✓
        </div>
      )}

      {filtered.map(alert => (
        <div key={alertId(alert)} className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px 16px', marginBottom: '8px' }}>
          <div style={{ fontSize: '18px', color: alert.type === 'stale' ? 'var(--warning)' : 'var(--danger)', marginTop: '1px', flexShrink: 0 }}>
            {alert.type === 'stale' ? '⏱' : '◈'}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--fz-micro)', color: 'var(--text3)', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {alert.type === 'stale' ? 'Stale vehicle' : 'Margin flag'} · {alert.location}
            </div>
            <div style={{ fontSize: 'var(--fz-body)', fontWeight: '500', color: 'var(--text)', marginBottom: '2px' }}>{alertTitle(alert)}</div>
            <div style={{ fontSize: 'var(--fz-label)', color: 'var(--text2)' }}>{alertSub(alert)}</div>
          </div>
          <button onClick={() => { const id = alertId(alert); setResolved(prev => [...prev, id]); api('/cos/alerts/ack', { method: 'POST', body: JSON.stringify({ keys: [id] }) }).catch(() => {}); }} style={{ fontSize: 'var(--fz-label)', padding: '4px 10px', flexShrink: 0 }}>
            Resolve
          </button>
        </div>
      ))}
    </div>
  );
}
