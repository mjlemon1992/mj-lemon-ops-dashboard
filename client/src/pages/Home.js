import React, { useState, useEffect } from 'react';
import { pacePct as wdPacePct } from '../utils/pace';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { parseAlerts } from '../utils/alerts';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function Home() {
  const { user, api } = useAuth();
  const navigate = useNavigate();
  const [locations, setLocations] = useState([]);
  const [metrics, setMetrics] = useState({});
  const [teff, setTeff] = useState({});
  const [targets, setTargets] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();

  const loadData = () => {
    return api('/locations').catch(() => []).then(locs => {
      setLocations(locs);
      return Promise.all((locs || []).map(loc =>
        Promise.all([
          api(`/metrics/${loc.id}/summary`).then(m => setMetrics(prev => ({ ...prev, [loc.id]: m }))).catch(() => {}),
          api(`/targets/${loc.id}/${currentYear}`).then(t => {
            const monthTarget = t.find(r => r.month === currentMonth);
            setTargets(prev => ({ ...prev, [loc.id]: monthTarget }));
          }).catch(() => {}),
          api(`/technicians/${loc.id}?period=mtd`).then(d => setTeff(prev => ({ ...prev, [loc.id]: d }))).catch(() => {})
        ])
      ));
    });
  };

  useEffect(() => { loadData().then(() => setLoading(false)); }, []);

  // Manual "Refresh now": force a live Shopmonkey sync, then reload the cache.
  const handleRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    const active = locations.filter(l => l.active);
    Promise.all(active.flatMap(loc => [
      api(`/sync/${loc.id}/refresh`, { method: 'POST' }).catch(() => {}),
      api(`/sync/${loc.id}/refresh-tech`, { method: 'POST' }).catch(() => {})
    ]))
      .then(() => loadData())
      .then(() => setLastSync(new Date()))
      .finally(() => setRefreshing(false));
  };

  if (loading) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading...</div>;

  const activeLocations = locations.filter(l => l.active);
  const metricList = Object.values(metrics).filter(Boolean);
  const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;

  const groupRevenue = metricList.reduce((s, m) => s + num(m.revenue_mtd), 0);
  const groupCarCount = metricList.reduce((s, m) => s + num(m.car_count_mtd), 0);
  const groupPPH = metricList.length ? Math.round(metricList.reduce((s, m) => s + num(m.pph), 0) / metricList.length) : 0;
  const _effList = Object.values(teff).filter(Boolean);
  const _locEff = (lid) => {
    const d = teff[lid];
    if (!d || !d.technicians) return null;
    const w = d.technicians.reduce((a, t) => a + num(t.hours_worked), 0);
    const so = d.technicians.reduce((a, t) => a + num(t.hours_sold), 0);
    return w > 0 ? Math.round((so / w) * 100) : null;
  };
  const groupEff = _effList.length
    ? Math.round(_effList.reduce((s, d) => {
        const w = (d.technicians || []).reduce((a, t) => a + num(t.hours_worked), 0);
        const so = (d.technicians || []).reduce((a, t) => a + num(t.hours_sold), 0);
        return s + (w > 0 ? (so / w) * 100 : 0);
      }, 0) / _effList.length)
    : 0;
  // Revenue-weighted parts margin across locations (falls back to simple avg)
  const marginVals = metricList.map(m => num(m.parts_margin)).filter(v => v > 0);
  const groupMargin = marginVals.length ? (marginVals.reduce((a, b) => a + b, 0) / marginVals.length) : 0;
  // Group avg RO = total revenue / total cars
  const groupAvgRO = groupCarCount > 0 ? groupRevenue / groupCarCount : 0;

  // --- target attainment helpers ---
  // Pace-aware (working days, province-aware) for cumulative MTD totals.
  // Group cards pace against the first active location's province as the
  // representative calendar; per-location rows use each location's own province.
  const _groupProv = (activeLocations[0] && activeLocations[0].province) || 'ab';
  const pacePct = (actual, target, prov) => wdPacePct(actual, target, prov || _groupProv);
  // Straight: for rate/average metrics (avg RO, PPH, margin) that should hit 100% any day.
  const targetPct = (actual, target) => {
    if (!target || target <= 0 || !actual) return null;
    return Math.round((actual / target) * 100);
  };
  const pctColor = p => p == null ? 'var(--text3)' : (p >= 100 ? 'var(--success)' : (p >= 90 ? 'var(--warning)' : 'var(--danger)'));
  // Group targets = sum of per-location targets (revenue, car_count) / first loc for rates.
  const _locTargets = Object.values(targets).filter(Boolean);
  const _sumT = key => _locTargets.reduce((s, t) => s + (parseFloat(t && t[key]) || 0), 0);
  const gRevTarget = _sumT('revenue');
  const gCarTarget = _sumT('car_count');
  const gRoTarget = _locTargets.length ? (_locTargets.reduce((s,t)=>s+(parseFloat(t.avg_ro_value)||0),0) / _locTargets.length) : 0;
  const money0 = n => '$' + Math.round(n).toLocaleString('en-CA');


  const allAlerts = Object.values(metrics).flatMap(parseAlerts);
  const alertCount = allAlerts.length;
  const staleCount = allAlerts.filter(a => a.type === 'stale').length;
  const marginCount = allAlerts.filter(a => a.type === 'margin').length;
  const staleDays = (activeLocations[0] && activeLocations[0].stale_threshold_days) || 5;
  const marginTarget = Math.round((activeLocations[0] && activeLocations[0].parts_margin_target) || 55);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginBottom: '12px' }}>
        {lastSync && <span style={{ fontSize: '11px', color: 'var(--text3)' }}>Last synced {lastSync.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}</span>}
        <button onClick={handleRefresh} disabled={refreshing}
          style={{ fontSize: '12px', fontWeight: '500', padding: '6px 14px', borderRadius: '6px', cursor: refreshing ? 'default' : 'pointer',
            background: refreshing ? 'var(--surface2)' : 'var(--accent)', color: refreshing ? 'var(--text3)' : '#fff', border: 'none' }}>
          {refreshing ? 'Syncing…' : 'Refresh now'}
        </button>
      </div>
      {alertCount > 0 && (
        <div className="alert-strip">
          <span style={{ fontSize: '14px', color: 'var(--warning)' }}>⚠</span>
          {staleCount > 0 && (
            <span style={{ fontSize: '12px', color: 'var(--warning)' }}>{staleCount} stale vehicle{staleCount > 1 ? 's' : ''} ({staleDays}+ days)</span>
          )}
          {staleCount > 0 && marginCount > 0 && (
            <span style={{ fontSize: '12px', color: 'var(--warning)' }}>·</span>
          )}
          {marginCount > 0 && (
            <span style={{ fontSize: '12px', color: 'var(--warning)' }}>{marginCount} job{marginCount > 1 ? 's' : ''} below {marginTarget}% parts margin</span>
          )}
          <span style={{ fontSize: '12px', color: 'var(--warning)', cursor: 'pointer', marginLeft: 'auto', textDecoration: 'underline' }} onClick={() => navigate('/alerts')}>View all</span>
        </div>
      )}

      {(user?.role === 'owner' || user?.role === 'partner') && (
        <div className="stat-grid" style={{ marginBottom: '20px' }}>
          <div className="metric-card">
            <div className="metric-label">Group revenue MTD</div>
            <div className="metric-value">{groupRevenue > 0 ? money0(groupRevenue) : '—'}</div>
            <div className="metric-sub" style={{ color: pctColor(pacePct(groupRevenue, gRevTarget)) }}>{groupRevenue > 0 ? (pacePct(groupRevenue, gRevTarget) != null ? `${pacePct(groupRevenue, gRevTarget)}% of pace` : 'live from Shopmonkey') : 'awaiting sync'}</div>
            {gRevTarget > 0 && (
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '3px' }}>
                Target {money0(gRevTarget)} · <span style={{ color: groupRevenue >= gRevTarget ? 'var(--success)' : 'var(--text2)' }}>{groupRevenue >= gRevTarget ? `${money0(groupRevenue - gRevTarget)} over` : `${money0(gRevTarget - groupRevenue)} to go`}</span>
              </div>
            )}
          </div>
          <div className="metric-card">
            <div className="metric-label">Group car count</div>
            <div className="metric-value">{groupCarCount > 0 ? groupCarCount : '—'}</div>
            <div className="metric-sub" style={{ color: pctColor(pacePct(groupCarCount, gCarTarget)) }}>{groupCarCount > 0 ? (pacePct(groupCarCount, gCarTarget) != null ? `${pacePct(groupCarCount, gCarTarget)}% of pace` : 'invoiced this month') : 'awaiting sync'}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Parts margin</div>
            <div className="metric-value">{groupMargin > 0 ? `${groupMargin.toFixed(1)}%` : '—'}</div>
            <div className={`metric-sub ${groupMargin >= 55 ? 'good' : 'warn'}`}>
              {groupMargin > 0 ? (groupMargin >= 55 ? 'above 55% target ✓' : 'below 55% target ⚠') : 'awaiting sync'}
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Profit per hour</div>
            <div className="metric-value">{groupPPH > 0 ? `$${groupPPH}` : '—'}</div>
            <div className="metric-sub">{groupPPH > 0 ? 'hours sold basis' : 'awaiting sync'}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Avg efficiency</div>
            <div className="metric-value">{groupEff > 0 ? `${groupEff}%` : '—'}</div>
            <div className="metric-sub">{groupEff > 0 ? 'hours sold / worked' : 'no hours yet'}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Avg RO value</div>
            <div className="metric-value">{groupAvgRO > 0 ? money0(groupAvgRO) : '—'}</div>
            <div className="metric-sub" style={{ color: pctColor(targetPct(groupAvgRO, gRoTarget)) }}>{groupAvgRO > 0 ? (targetPct(groupAvgRO, gRoTarget) != null ? `${targetPct(groupAvgRO, gRoTarget)}% of target` : 'revenue / car count') : 'awaiting sync'}</div>
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
            <div key={loc.id} className="card" style={{ marginBottom: '12px', cursor: 'pointer' }}
              role="button" tabIndex={0} onClick={() => navigate('/performance')}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/performance'); } }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>{loc.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>{loc.city}, {loc.province}</div>
                </div>
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--success)' }}></div>
              </div>
              <div className="stat-grid-sm">
                {[
                  { label: 'Revenue MTD', val: m ? money0(num(m.revenue_mtd)) : '—', sub: (m && t && t.revenue) ? `${pacePct(num(m.revenue_mtd), num(t.revenue), loc.province)}% of pace` : (t ? `vs $${Math.round(t.revenue/1000)}k target` : 'vs target'), ok: (m && t && t.revenue) ? pacePct(num(m.revenue_mtd), num(t.revenue), loc.province) >= 90 : true, sub2: (m && t && t.revenue) ? `Target ${money0(num(t.revenue))} · ${num(m.revenue_mtd) >= num(t.revenue) ? `${money0(num(m.revenue_mtd) - num(t.revenue))} over` : `${money0(num(t.revenue) - num(m.revenue_mtd))} to go`}` : null },
                  { label: 'Profit / hr', val: m && num(m.pph) > 0 ? `$${Math.round(num(m.pph))}` : '—', sub: (m && num(m.pph) > 0 && loc.pph_target) ? `${targetPct(num(m.pph), num(loc.pph_target))}% of target` : `vs $${loc.pph_target} target`, ok: num(m?.pph) >= loc.pph_target },
                  { label: 'Efficiency', val: _locEff(loc.id) != null ? `${_locEff(loc.id)}%` : '—', sub: `vs ${loc.efficiency_target}% target`, ok: (_locEff(loc.id) || 0) >= loc.efficiency_target },
                  { label: 'Avg RO', val: m && num(m.avg_ro_value) > 0 ? money0(num(m.avg_ro_value)) : '—', sub: (m && num(m.avg_ro_value) > 0 && t && t.avg_ro_value) ? `${targetPct(num(m.avg_ro_value), num(t.avg_ro_value))}% of target` : 'per car', ok: (m && t && t.avg_ro_value) ? num(m.avg_ro_value) >= num(t.avg_ro_value) : true },
                ].map(item => (
                  <div key={item.label}>
                    <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '3px' }}>{item.label}</div>
                    <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>{item.val}</div>
                    <div style={{ fontSize: '10px', color: item.ok ? 'var(--success)' : 'var(--warning)', marginTop: '2px' }}>{item.sub}</div>
                    {item.sub2 && <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '1px' }}>{item.sub2}</div>}
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
