import React from 'react';
import { useNavigate } from 'react-router-dom';

const REPORTS = [
  { icon: '☀', title: 'End of day summary', sub: 'Jobs closed, revenue, vehicles on site, flags', freq: 'Daily at 6pm', available: false },
  { icon: '📅', title: 'Weekly summary', sub: 'Revenue, car count, margins vs target', freq: 'Fridays at 5pm', available: false },
  { icon: '📊', title: 'Mid month summary', sub: 'MTD pace vs monthly target', freq: '15th of each month', available: false },
  { icon: '✓', title: 'End of month', sub: 'Full month vs target, vs prior month', freq: 'Last day of month', available: false },
  { icon: '👤', title: 'Technician efficiency', sub: 'Available vs worked vs sold per tech', freq: 'Live from Shopmonkey', available: true, route: '/reports/tech-efficiency' },
  { icon: '◈', title: 'Parts margin report', sub: 'All jobs below threshold for selected period', freq: 'On demand', available: false },
];

export default function Reports() {
  const navigate = useNavigate();
  return (
    <div>
      <div style={{ background: 'rgba(77,184,255,0.08)', border: '0.5px solid rgba(77,184,255,0.2)', borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)' }}>
        Operational reports run live from Shopmonkey. Click an available report to open it.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        {REPORTS.map(r => (
          <div key={r.title} onClick={() => r.route && navigate(r.route)} className="card" style={{ opacity: r.available ? 1 : 0.6, cursor: r.available ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <div style={{ fontSize: '20px', color: 'var(--text2)', flexShrink: 0, marginTop: '1px' }}>{r.icon}</div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '3px' }}>{r.title}</div>
                <div style={{ fontSize: '11px', color: 'var(--text2)', marginBottom: '6px' }}>{r.sub}</div>
                <div style={{ fontSize: '10px', color: 'var(--text3)' }}>{r.freq}</div>
              </div>
              {!r.available && <span className="badge neutral" style={{ marginLeft: 'auto', flexShrink: 0 }}>Post-closing</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
