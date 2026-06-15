import React, { useState } from 'react';

const ALERTS = [
  { type: 'stale', title: '2022 Ram 2500 — Alex Bradford', sub: 'RO #10600418 · Checked in Jun 8 · 7 days on site', location: 'Hwy 97 Mister Transmission' },
  { type: 'stale', title: '2015 Ford F-350 — Larry Mellor', sub: 'RO #10600414 · Checked in Jun 5 · 10 days on site', location: 'Hwy 97 Mister Transmission' },
  { type: 'stale', title: '2019 Chevy Silverado — Dan Moore', sub: 'RO #10600421 · Checked in Jun 9 · 6 days on site', location: 'Hwy 97 Mister Transmission' },
  { type: 'margin', title: '2017 Honda CR-V — RO #10600419', sub: 'Parts margin 48.2% — below 55% target', location: 'Hwy 97 Mister Transmission' },
  { type: 'margin', title: '2020 Ford Edge — RO #10600422', sub: 'Parts margin 51.7% — below 55% target', location: 'Hwy 97 Mister Transmission' },
];

export default function Alerts() {
  const [filter, setFilter] = useState('all');
  const [resolved, setResolved] = useState([]);

  const filtered = ALERTS.filter(a => {
    if (resolved.includes(a.title)) return false;
    if (filter === 'stale') return a.type === 'stale';
    if (filter === 'margin') return a.type === 'margin';
    return true;
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {[['all','All'], ['stale','Stale vehicles'], ['margin','Margin flags']].map(([val, label]) => (
          <button key={val} onClick={() => setFilter(val)} className={filter === val ? 'primary' : ''}>
            {label} {val === 'all' ? `(${ALERTS.filter(a => !resolved.includes(a.title)).length})` : val === 'stale' ? `(${ALERTS.filter(a => a.type === 'stale' && !resolved.includes(a.title)).length})` : `(${ALERTS.filter(a => a.type === 'margin' && !resolved.includes(a.title)).length})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)' }}>
          No active alerts — all clear ✓
        </div>
      )}

      {filtered.map(alert => (
        <div key={alert.title} className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px 16px', marginBottom: '8px' }}>
          <div style={{ fontSize: '18px', color: alert.type === 'stale' ? 'var(--warning)' : 'var(--danger)', marginTop: '1px', flexShrink: 0 }}>
            {alert.type === 'stale' ? '⏱' : '◈'}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {alert.type === 'stale' ? 'Stale vehicle' : 'Margin flag'} · {alert.location}
            </div>
            <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '2px' }}>{alert.title}</div>
            <div style={{ fontSize: '11px', color: 'var(--text2)' }}>{alert.sub}</div>
          </div>
          <button onClick={() => setResolved(prev => [...prev, alert.title])} style={{ fontSize: '11px', padding: '4px 10px', flexShrink: 0 }}>
            Resolve
          </button>
        </div>
      ))}
    </div>
  );
}
