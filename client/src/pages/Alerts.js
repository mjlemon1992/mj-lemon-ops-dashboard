import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { parseAlerts, alertId, alertTitle, alertSub } from '../utils/alerts';

export default function Alerts() {
  const { api } = useAuth();
  const [filter, setFilter] = useState('all');
  const [resolved, setResolved] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api('/locations').catch(() => [])
      .then(locs => Promise.all((locs || []).map(loc =>
        api(`/metrics/${loc.id}/summary`).then(parseAlerts).catch(() => [])
      )))
      .then(lists => { if (!cancelled) { setAlerts(lists.flat()); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

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
            <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {alert.type === 'stale' ? 'Stale vehicle' : 'Margin flag'} · {alert.location}
            </div>
            <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '2px' }}>{alertTitle(alert)}</div>
            <div style={{ fontSize: '11px', color: 'var(--text2)' }}>{alertSub(alert)}</div>
          </div>
          <button onClick={() => setResolved(prev => [...prev, alertId(alert)])} style={{ fontSize: '11px', padding: '4px 10px', flexShrink: 0 }}>
            Resolve
          </button>
        </div>
      ))}
    </div>
  );
}
