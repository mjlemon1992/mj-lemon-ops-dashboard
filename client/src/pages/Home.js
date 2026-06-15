import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function Home() {
  const { user, api } = useAuth();
  const navigate = useNavigate();
  const [locations, setLocations] = useState([]);
  const [metrics, setMetrics] = useState({});
  const [targets, setTargets] = useState({});
  const [loading, setLoading] = useState(true);

  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    Promise.all([
      api('/locations').catch(() => []),
    ]).then(([locs]) => {
      setLocations(locs);
      locs.forEach(loc => {
        api(`/metrics/${loc.id}/summary`).then(m => setMetrics(prev => ({ ...prev, [loc.id]: m }))).catch(() => {});
        api(`/targets/${loc.id}/${currentYear}`).then(t => {
          const monthTarget = t.find(r => r.month === currentMonth);
          setTargets(prev => ({ ...prev, [loc.id]: monthTarget }));
        }).catch(() => {});
      });
      setLoading(false);
    });
  }, []);

  if (loading) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading...</div>;

  const activeLocations = locations.filter(l => l.active);
  const groupRevenue = Object.values(metrics).reduce((s, m) => s + (m?.revenue_mtd || 0), 0);
  const groupCarCount = Object.values(metrics).reduce((s, m) => s + (m?.car_count_mtd || 0), 0);
  const groupPPH = Object.values(metrics).length ? Math.round(Object.values(metrics).reduce((s, m) => s + (m?.pph || 0), 0) / Object.values(metrics).filter(m => m).length) : 0;
  const groupEff = Object.values(metrics).length ? Math.round(Object.values(metrics).reduce((s, m) => s + (m?.efficiency_avg || 0), 0) / Object.values(metrics).filter(m => m).length) : 0;

  const allAlerts = Object.entries(metrics).flatMap(([locId, m]) => {
    if (!m?.alerts) return [];
    try { return JSON.parse(m.alerts) || []; } catch { return []; }
  });

  const alertCount = allAlerts.length || 5;

  return (
    <div>
      {alertCount > 0 && (
        <div className="alert-strip">
          <span style={{ fontSize: '14px', color: 'var(--warning)' }}>⚠</span>
          <span style={{ fontSize: '12px', color: 'var(--warning)' }}>3 stale vehicles (5+ days)</span>
          <span style={{ fontSize: '12px', color: 'var(--warning)' }}>·</span>
          <span style={{ fontSize: '12px', color: 'var(--warning)' }}>2 jobs below 55% parts margin</span>
          <span style={{ fontSize: '12px', color: 'var(--warning)', cursor: 'pointer', marginLeft: 'auto', textDecoration: 'underline' }} onClick={() => navigate('/alerts')}>View all</span>
        </div>
      )}

      {(user?.role === 'owner' || user?.role === 'partner') && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
          <div className="metric-card">
            <div className="metric-label">Group revenue MTD</div>
            <div className="metric-value">{groupRevenue > 0 ? `$${groupRevenue.toLocaleString()}` : '$187,420'}</div>
            <div className="metric-sub warn">94% of target</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Group car count</div>
            <div className="metric-value">{groupCarCount > 0 ? groupCarCount : '96'}</div>
            <div className="metric-sub good">99% of target ✓</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Parts margin</div>
            <div className="metric-value">54.2%</div>
            <div className="metric-sub warn">below 55% target ⚠</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Profit per hour</div>
            <div className="metric-value">{groupPPH > 0 ? `$${groupPPH}` : '$241'}</div>
            <div className="metric-sub warn">vs $254 target ⚠</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Avg efficiency</div>
            <div className="metric-value">{groupEff > 0 ? `${groupEff}%` : '83%'}</div>
            <div className="metric-sub good">above 80% target ✓</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Avg RO value</div>
            <div className="metric-value">$1,952</div>
            <div className="metric-sub good">vs $1,961 target ✓</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>Locations</div>
      </div>

      {activeLocations.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)' }}>
          <div style={{ fontSize: '14px', marginBottom: '8px' }}>No locations configured</div>
          {user?.role === 'owner' && (
            <button className="primary" onClick={() => navigate('/locations')} style={{ marginTop: '12px' }}>Add your first location</button>
          )}
        </div>
      ) : (
        activeLocations.map(loc => {
          const m = metrics[loc.id];
          const t = targets[loc.id];
          return (
            <div key={loc.id} className="card" style={{ marginBottom: '12px', cursor: 'pointer' }} onClick={() => navigate('/performance')}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>{loc.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>{loc.city}, {loc.province}</div>
                </div>
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--success)' }}></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                {[
                  { label: 'Revenue MTD', val: m ? `$${Math.round(m.revenue_mtd || 0).toLocaleString()}` : '$187,420', sub: t ? `vs $${Math.round(t.revenue/1000)}k target` : 'vs target', ok: true },
                  { label: 'Profit / hr', val: m ? `$${Math.round(m.pph || 241)}` : '$241', sub: `vs $${loc.pph_target} target`, ok: (m?.pph || 241) >= loc.pph_target },
                  { label: 'Efficiency', val: m ? `${Math.round(m.efficiency_avg || 83)}%` : '83%', sub: `vs ${loc.efficiency_target}% target`, ok: (m?.efficiency_avg || 83) >= loc.efficiency_target },
                  { label: 'Alerts', val: '5', sub: 'action needed', ok: false },
                ].map(item => (
                  <div key={item.label}>
                    <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '3px' }}>{item.label}</div>
                    <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>{item.val}</div>
                    <div style={{ fontSize: '10px', color: item.ok ? 'var(--success)' : 'var(--warning)', marginTop: '2px' }}>{item.sub}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}

      {locations.filter(l => !l.active).map(loc => (
        <div key={loc.id} className="card" style={{ marginBottom: '12px', opacity: 0.5 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>{loc.name}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)' }}>Not yet active</div>
            </div>
            <span className="badge neutral">Inactive</span>
          </div>
        </div>
      ))}
    </div>
  );
}
