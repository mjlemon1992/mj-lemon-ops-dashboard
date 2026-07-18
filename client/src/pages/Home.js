import React, { useState, useEffect } from 'react';
import { pacePct as wdPacePct } from '../utils/pace';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';
import { parseAlerts } from '../utils/alerts';
import PaceTach from '../components/PaceTach';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function Home() {
  const { user, api } = useAuth();
  const { isAll, selectedId } = useLocations();
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

  // Scope to the global location selection: "All" = every active shop (group
  // view), otherwise just the selected one.
  const activeLocations = locations.filter(l => l.active && (isAll || l.id === selectedId));
  const metricList = activeLocations.map(l => metrics[l.id]).filter(Boolean);
  const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;

  const groupRevenue = metricList.reduce((s, m) => s + num(m.revenue_mtd), 0);
  const groupCarCount = metricList.reduce((s, m) => s + num(m.car_count_mtd), 0);
  // Rate metrics (PPH, efficiency) average ONLY over shops that actually have
  // data. A no-data shop (e.g. Hwy 97, zero row / empty roster) must not be
  // averaged in as a 0 — that would halve the group number.
  const _pphVals = metricList.map(m => num(m.pph)).filter(v => v > 0);
  const groupPPH = _pphVals.length ? Math.round(_pphVals.reduce((a, b) => a + b, 0) / _pphVals.length) : 0;
  const _effList = activeLocations.map(l => teff[l.id]).filter(Boolean);
  const _locEff = (lid) => {
    const d = teff[lid];
    if (!d || !d.technicians) return null;
    const w = d.technicians.reduce((a, t) => a + num(t.hours_worked), 0);
    const so = d.technicians.reduce((a, t) => a + num(t.hours_sold), 0);
    return w > 0 ? Math.round((so / w) * 100) : null;
  };
  const _effVals = _effList
    .map(d => {
      const w = (d.technicians || []).reduce((a, t) => a + num(t.hours_worked), 0);
      const so = (d.technicians || []).reduce((a, t) => a + num(t.hours_sold), 0);
      return w > 0 ? (so / w) * 100 : null;
    })
    .filter(v => v != null);
  const groupEff = _effVals.length ? Math.round(_effVals.reduce((a, b) => a + b, 0) / _effVals.length) : 0;
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
  const toneClass = p => p == null ? '' : (p >= 100 ? 'good' : (p >= 90 ? 'warn' : 'bad'));
  // Group targets = sum of per-location targets (revenue, car_count) / first loc for rates.
  const _locTargets = activeLocations.map(l => targets[l.id]).filter(Boolean);
  const _sumT = key => _locTargets.reduce((s, t) => s + (parseFloat(t && t[key]) || 0), 0);
  const gRevTarget = _sumT('revenue');
  const gCarTarget = _sumT('car_count');
  // Rate-metric group targets = average over shops that ACTUALLY have a target set.
  // A shop with a 0/unset target (e.g. Hwy 97, not configured) is excluded — we
  // never invent a default target, so an untargeted shop shows no attainment and
  // doesn't drag the group denominator. 0 -> targetPct returns null -> no "% of target".
  const avgPos = vals => { const f = vals.filter(v => v > 0); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0; };
  const gRoTarget = avgPos(_locTargets.map(t => parseFloat(t.avg_ro_value) || 0));
  const gPphTarget = avgPos(activeLocations.map(l => parseFloat(l.pph_target) || 0));
  const gEffTarget = avgPos(activeLocations.map(l => parseFloat(l.efficiency_target) || 0));
  const money0 = n => '$' + Math.round(n).toLocaleString('en-CA');


  const allAlerts = metricList.flatMap(parseAlerts);
  const alertCount = allAlerts.length;
  const staleCount = allAlerts.filter(a => a.type === 'stale').length;
  const marginCount = allAlerts.filter(a => a.type === 'margin').length;
  // Alert-strip thresholds: use the first location that actually has one set —
  // an unconfigured shop (threshold 0) must not make the strip read "below 0%".
  const firstPos = vals => vals.filter(v => v > 0)[0];
  const staleDays = firstPos(activeLocations.map(l => parseInt(l.stale_threshold_days, 10) || 0)) || 5;
  const marginTarget = Math.round(firstPos(activeLocations.map(l => parseFloat(l.parts_margin_target) || 0)) || 55);

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

      {/* Glance board: the one-look answer — revenue vs target on a tach, pace,
          cars, efficiency. The detailed cards below stay untouched. */}
      {gRevTarget > 0 && (
        <div className="glance-board">
          <div className="glance-main">
            <div className="section-label">{isAll ? 'Group revenue · MTD' : 'Revenue · MTD'}</div>
            <div className="glance-rev">{groupRevenue > 0 ? money0(groupRevenue) : '—'}</div>
            <div className="glance-sub">
              of {money0(gRevTarget)} target ·{' '}
              <span style={{ color: groupRevenue >= gRevTarget ? 'var(--success)' : 'var(--text3)' }}>
                {groupRevenue >= gRevTarget ? `${money0(groupRevenue - gRevTarget)} over` : `${money0(gRevTarget - groupRevenue)} to go`}
              </span>{' · '}
              <span style={{ color: pctColor(pacePct(groupRevenue, gRevTarget)) }}>
                {pacePct(groupRevenue, gRevTarget) != null ? `${pacePct(groupRevenue, gRevTarget)}% of pace` : 'no pace data'}
              </span>
            </div>
            <div className="glance-meter">
              <div className="glance-meter-fill" style={{ width: `${Math.min(targetPct(groupRevenue, gRevTarget) || 0, 100)}%` }} />
            </div>
          </div>
          <div className="glance-side">
            <div>
              <div className="section-label">Cars</div>
              <div className="glance-num">{groupCarCount > 0 ? groupCarCount : '—'}</div>
              <div className="glance-sub">{gCarTarget > 0 ? `of ${gCarTarget}` : ' '}</div>
            </div>
            <div>
              <div className="section-label">Efficiency</div>
              <div className="glance-num">{groupEff > 0 ? `${groupEff}%` : '—'}</div>
              <div className="glance-sub">{gEffTarget > 0 ? `target ${Math.round(gEffTarget)}%` : ' '}</div>
            </div>
          </div>
          <div className="glance-tach">
            <PaceTach pct={targetPct(groupRevenue, gRevTarget)} />
          </div>
        </div>
      )}

      {/* Full metric block for every role — a manager's "group" is just their own
          location (the locations list is already server-filtered to it). */}
      {(
        <div className="stat-grid" style={{ marginBottom: '20px' }}>
          {/* Revenue / cars / efficiency live on the glance board when a target
              exists — only fall back to cards when the board is hidden. */}
          {!(gRevTarget > 0) && (
          <div className="metric-card">
            <div className="metric-label">{isAll ? 'Group revenue MTD' : 'Revenue MTD'}</div>
            <div className="metric-value">{groupRevenue > 0 ? money0(groupRevenue) : '—'}</div>
            <div className={`metric-sub ${toneClass(pacePct(groupRevenue, gRevTarget))}`} style={{ color: pctColor(pacePct(groupRevenue, gRevTarget)) }}>{groupRevenue > 0 ? (pacePct(groupRevenue, gRevTarget) != null ? `${pacePct(groupRevenue, gRevTarget)}% of pace` : 'live from Shopmonkey') : 'awaiting sync'}</div>
          </div>
          )}
          {!(gRevTarget > 0) && (
          <div className="metric-card">
            <div className="metric-label">{isAll ? 'Group car count' : 'Car count'}</div>
            <div className="metric-value">{groupCarCount > 0 ? groupCarCount : '—'}</div>
            <div className={`metric-sub ${toneClass(pacePct(groupCarCount, gCarTarget))}`} style={{ color: pctColor(pacePct(groupCarCount, gCarTarget)) }}>{groupCarCount > 0 ? (pacePct(groupCarCount, gCarTarget) != null ? `${pacePct(groupCarCount, gCarTarget)}% of pace` : 'invoiced this month') : 'awaiting sync'}</div>
          </div>
          )}
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
            <div className={`metric-sub ${toneClass(targetPct(groupPPH, gPphTarget))}`} style={{ color: pctColor(targetPct(groupPPH, gPphTarget)) }}>{groupPPH > 0 ? (targetPct(groupPPH, gPphTarget) != null ? `${targetPct(groupPPH, gPphTarget)}% of target` : 'hours sold basis') : 'awaiting sync'}</div>
          </div>
          {!(gRevTarget > 0) && (
          <div className="metric-card">
            <div className="metric-label">Avg efficiency</div>
            <div className="metric-value">{groupEff > 0 ? `${groupEff}%` : '—'}</div>
            <div className={`metric-sub ${toneClass(targetPct(groupEff, gEffTarget))}`} style={{ color: pctColor(targetPct(groupEff, gEffTarget)) }}>{groupEff > 0 ? (targetPct(groupEff, gEffTarget) != null ? `${targetPct(groupEff, gEffTarget)}% of target` : 'hours sold / worked') : 'no hours yet'}</div>
          </div>
          )}
          <div className="metric-card">
            <div className="metric-label">Avg RO value</div>
            <div className="metric-value">{groupAvgRO > 0 ? money0(groupAvgRO) : '—'}</div>
            <div className={`metric-sub ${toneClass(targetPct(groupAvgRO, gRoTarget))}`} style={{ color: pctColor(targetPct(groupAvgRO, gRoTarget)) }}>{groupAvgRO > 0 ? (targetPct(groupAvgRO, gRoTarget) != null ? `${targetPct(groupAvgRO, gRoTarget)}% of target` : 'revenue / car count') : 'awaiting sync'}</div>
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
                  { label: 'Revenue MTD', val: m ? money0(num(m.revenue_mtd)) : '—', sub: (m && t && num(t.revenue) > 0) ? `${pacePct(num(m.revenue_mtd), num(t.revenue), loc.province)}% of pace` : ((t && num(t.revenue) > 0) ? `vs $${Math.round(num(t.revenue)/1000)}k target` : 'no target set'), ok: (m && t && num(t.revenue) > 0) ? pacePct(num(m.revenue_mtd), num(t.revenue), loc.province) >= 90 : true, sub2: (m && t && t.revenue) ? `Target ${money0(num(t.revenue))} · ${num(m.revenue_mtd) >= num(t.revenue) ? `${money0(num(m.revenue_mtd) - num(t.revenue))} over` : `${money0(num(t.revenue) - num(m.revenue_mtd))} to go`}` : null },
                  { label: 'Profit / hr', val: m && num(m.pph) > 0 ? `$${Math.round(num(m.pph))}` : '—', sub: (m && num(m.pph) > 0 && num(loc.pph_target) > 0) ? `${targetPct(num(m.pph), num(loc.pph_target))}% of target` : (num(loc.pph_target) > 0 ? `vs $${Math.round(num(loc.pph_target))} target` : 'no target set'), ok: num(loc.pph_target) > 0 ? num(m?.pph) >= num(loc.pph_target) : true },
                  { label: 'Efficiency', val: _locEff(loc.id) != null ? `${_locEff(loc.id)}%` : '—', sub: num(loc.efficiency_target) > 0 ? `vs ${loc.efficiency_target}% target` : 'no target set', ok: num(loc.efficiency_target) > 0 ? (_locEff(loc.id) || 0) >= num(loc.efficiency_target) : true },
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

      {(isAll ? locations.filter(l => !l.active) : []).map(loc => (
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
