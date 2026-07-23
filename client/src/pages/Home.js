import React, { useState, useEffect } from 'react';
import { pacePct as wdPacePct, workingPaceFrac, workingDaysLeftInMonth, shopTodayIso } from '../utils/pace';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';
import { parseAlerts } from '../utils/alerts';
import PaceTach from '../components/PaceTach';
import { Skeleton } from '../components/Feedback';
import { fmtShortDate as fmtD2, money0 } from '../utils/format';
import { crewPaidHours } from '../utils/pay';

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

  // Foreman decks: who's on the clock, upcoming time off, crew paid this
  // pay period — per active location, quietly skipped on any error.
  const [clockByLoc, setClockByLoc] = useState({});
  const [offByLoc, setOffByLoc] = useState({});
  const [paidByLoc, setPaidByLoc] = useState({});
  // Holidays per PROVINCE — a Red Deer (AB) view must never show BC Day just
  // because a BC shop sorts first. Fetched once per distinct province; the
  // deck below picks the calendars matching the locations actually in scope.
  const [holidaysByProv, setHolidaysByProv] = useState({});
  useEffect(() => {
    const provs = [...new Set(locations.filter(l => l.active).map(l => (l.province || 'ab').toLowerCase()))];
    provs.forEach(pv => {
      api(`/meta/holidays/${pv}`)
        .then(d => setHolidaysByProv(prev => ({ ...prev, [pv]: d.holidays || [] })))
        .catch(() => {});
    });
  }, [locations, api]);
  useEffect(() => {
    // Only the shops the decks will actually render (global selection scope).
    const active = locations.filter(l => l.active && (isAll || l.id === selectedId));
    if (!active.length || !['owner', 'partner', 'manager', 'advisor'].includes(user?.role)) return undefined;
    let cancelled = false;
    Promise.all(active.map(async (loc) => {
      const [st, toff, pp] = await Promise.all([
        api(`/clock/${loc.id}/status`).catch(() => null),
        api(`/clock/${loc.id}/timeoff`).catch(() => null),
        api(`/clock/${loc.id}/pay-periods`).catch(() => null),
      ]);
      let paid = null;
      const cur = pp && (pp.periods || []).find(x => x.current);
      if (cur) {
        const e = await api(`/clock/${loc.id}/entries?from=${cur.from}&to=${cur.to}`).catch(() => null);
        if (e) paid = crewPaidHours(e, st ? (st.people || []).length : 0);
      }
      return [loc.id, st ? st.people || [] : null, toff, paid];
    })).then(rows => {
      if (cancelled) return;
      const c = {}, o = {}, p = {};
      rows.forEach(([id, st, toff, paid]) => { if (st) c[id] = st; if (toff) o[id] = toff; if (paid != null) p[id] = paid; });
      setClockByLoc(c); setOffByLoc(o); setPaidByLoc(p);
    });
    return () => { cancelled = true; };
  }, [locations, api, user, isAll, selectedId]);

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

  if (loading) return <Skeleton rows={6} height={20} />;

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
  // Techs hidden on the Technicians page must drop off every efficiency surface,
  // not just that page — same key (tech_id, else name) the Performance board uses.
  const _visTechs = (d) => {
    const h = new Set(((d && d.hidden) || []).map(x => x.tech_id || x.tech_name));
    return ((d && d.technicians) || []).filter(t => !h.has(t.tech_id || t.tech_name));
  };
  const _locEff = (lid) => {
    const techs = _visTechs(teff[lid]);
    if (!techs.length) return null;
    const w = techs.reduce((a, t) => a + num(t.hours_worked), 0);
    const so = techs.reduce((a, t) => a + num(t.hours_sold), 0);
    return w > 0 ? Math.round((so / w) * 100) : null;
  };
  const _effVals = _effList
    .map(d => {
      const techs = _visTechs(d);
      const w = techs.reduce((a, t) => a + num(t.hours_worked), 0);
      const so = techs.reduce((a, t) => a + num(t.hours_sold), 0);
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


  const allAlerts = metricList.flatMap(parseAlerts);
  const alertCount = allAlerts.length;
  const staleCount = allAlerts.filter(a => a.type === 'stale').length;
  const marginCount = allAlerts.filter(a => a.type === 'margin').length;
  // Alert-strip thresholds: use the first location that actually has one set —
  // an unconfigured shop (threshold 0) must not make the strip read "below 0%".
  const firstPos = vals => vals.filter(v => v > 0)[0];
  const staleDays = firstPos(activeLocations.map(l => parseInt(l.stale_threshold_days, 10) || 0)) || 5;
  const marginTarget = Math.round(firstPos(activeLocations.map(l => parseFloat(l.parts_margin_target) || 0)) || 55);

  // Advisor Home = the operational decks (crew, efficiency, two weeks) plus
  // alerts. Money sections stay off; the server strips those fields from the
  // advisor's API responses anyway — this just keeps the layout honest.
  const isAdvisor = user?.role === 'advisor';

  return (
    <div>
      {!isAdvisor && (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginBottom: '12px' }}>
        {lastSync && <span style={{ fontSize: '11px', color: 'var(--text3)' }}>Last synced {lastSync.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}</span>}
        <button onClick={handleRefresh} disabled={refreshing}
          style={{ fontSize: '12px', fontWeight: '500', padding: '6px 14px', borderRadius: '6px', cursor: refreshing ? 'default' : 'pointer',
            background: refreshing ? 'var(--surface2)' : 'var(--accent)', color: refreshing ? 'var(--text3)' : '#fff', border: 'none' }}>
          {refreshing ? 'Syncing…' : 'Refresh now'}
        </button>
      </div>
      )}
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

      {/* Foreman hero band — the demo layout on real data */}
      {gRevTarget > 0 && (() => {
        const frac = workingPaceFrac(_groupProv) || 0;
        const delta = groupRevenue - gRevTarget * frac;
        const daysLeft = workingDaysLeftInMonth(_groupProv);
        const pctFill = Math.min((groupRevenue / gRevTarget) * 100, 100);
        const crewPaidTotal = activeLocations.reduce((a, l) => a + (paidByLoc[l.id] || 0), 0);
        const havePaid = activeLocations.some(l => paidByLoc[l.id] != null);
        return (
          <div className="hero-band">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="section-label" style={{ marginBottom: '8px' }}>Month to date · vs target {money0(gRevTarget)}</div>
              <div className="hero-stats">
                <div>
                  <div className="hero-num">{groupRevenue > 0 ? money0(groupRevenue) : '—'}</div>
                  <div className="hero-sub">revenue · <span style={{ color: delta >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>{delta >= 0 ? `ahead by ${money0(delta)}` : `behind by ${money0(-delta)}`}</span> · {groupRevenue >= gRevTarget ? `${money0(groupRevenue - gRevTarget)} over target` : `${money0(gRevTarget - groupRevenue)} to go`}</div>
                </div>
                <div>
                  <div className="hero-num">{groupCarCount > 0 ? groupCarCount : '—'}</div>
                  <div className="hero-sub">car count{gCarTarget > 0 ? ` of ${gCarTarget}` : ''}</div>
                </div>
                <div>
                  <div className="hero-num">{groupEff > 0 ? groupEff : '—'}<span className="hero-unit">%</span></div>
                  <div className="hero-sub">avg efficiency</div>
                </div>
                {havePaid && (
                  <div>
                    <div className="hero-num">{Math.round(crewPaidTotal * 10) / 10}<span className="hero-unit">h</span></div>
                    <div className="hero-sub">crew paid this period</div>
                  </div>
                )}
              </div>
              <div className="hero-bar-row">
                <div className="hero-bar">
                  <div className="hero-bar-fill" style={{ width: `${pctFill}%` }} />
                  <div className="hero-bar-marker" style={{ left: `${Math.min(frac * 100, 100)}%` }} title="Where pace says you should be" />
                </div>
                <div className="hero-bar-cap">{daysLeft} working day{daysLeft === 1 ? '' : 's'} left</div>
              </div>
            </div>
            <div className="glance-tach"><PaceTach pct={targetPct(groupRevenue, gRevTarget)} /></div>
          </div>
        );
      })()}

      {/* Live decks: crew now · efficiency · two weeks */}
      {Object.keys(clockByLoc).length > 0 && (() => {
        const scopeIds = activeLocations.map(l => l.id);
        const todayIso = shopTodayIso();
        const offToday = new Set();
        const upcoming = [];
        scopeIds.forEach(id => ((offByLoc[id] || {}).requests || []).forEach(r => {
          if (r.status !== 'approved') return;
          if (r.start_date <= todayIso && r.end_date >= todayIso && r.person_id) offToday.add(r.person_id);
          if (r.end_date >= todayIso) upcoming.push(r);
        }));
        upcoming.sort((a, b) => a.start_date < b.start_date ? -1 : 1);
        const crew = scopeIds.flatMap(id => clockByLoc[id] || []);
        const onCount = crew.filter(p => p.status !== 'off' && !offToday.has(p.id)).length;
        const fmtSince = t => t ? new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[ap]\.?m\.?/i, '') : '';
        const breakMins = t => Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
        const effRows = activeLocations.flatMap(l => _visTechs(teff[l.id]))
          .map(t => { const w = num(t.hours_worked), so = num(t.hours_sold); return w > 0 ? { name: t.tech_name, eff: Math.round((so / w) * 100) } : null; })
          .filter(Boolean);
        // Build the 14-day strip from the SHOP's calendar day (noon-UTC stepping
        // avoids DST edges); holidays come from the server's 13-province calendar,
        // limited to the provinces of the locations in scope (AB view ≠ BC Day).
        const base = new Date(todayIso + 'T12:00:00Z');
        const days = Array.from({ length: 14 }, (_, i) => new Date(base.getTime() + i * 86400000));
        const scopeProvs = [...new Set(activeLocations.map(l => (l.province || 'ab').toLowerCase()))];
        const scopeHolidays = scopeProvs
          .flatMap(pv => (holidaysByProv[pv] || []).map(h => ({ ...h, prov: pv })))
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        const hset = new Set(scopeHolidays.map(x => x.date));
        const offDates = (iso) => { let approved = false, pending = false;
          scopeIds.forEach(id => ((offByLoc[id] || {}).requests || []).forEach(r => {
            if (r.start_date <= iso && r.end_date >= iso) { if (r.status === 'approved') approved = true; else if (r.status === 'pending') pending = true; }
          }));
          return { approved, pending };
        };
        const nh = scopeHolidays.find(x => x.date >= todayIso);
        // On the all-locations view a holiday may belong to only one province —
        // tag it so "BC Day" can't read as a Red Deer day off.
        const nextStat = nh ? { label: `${nh.name} ${fmtD2(nh.date)}${scopeProvs.length > 1 ? ` (${nh.prov.toUpperCase()})` : ''}` } : null;
        const nextOff = upcoming.find(r => r.person_id);
        return (
          <div className="deck-row">
            <div className="card deck">
              <div className="deck-head"><span className="deck-title">Crew now</span><span className="section-label">{onCount} of {crew.length} in</span></div>
              {crew.length === 0 && <div className="deck-empty">No crew on the time clock yet.</div>}
              {crew.map(p => {
                const hol = offToday.has(p.id);
                return (
                  <div key={p.id} className="crew-row">
                    {p.photo
                      ? <img src={p.photo} alt="" className="crew-ava" style={{ border: p.color ? `2px solid ${p.color}` : 'none' }} />
                      : <span className="crew-ava crew-ava-fallback" style={{ background: p.color || 'var(--bg3)' }}>{(p.name || '?')[0]}</span>}
                    <span className="crew-name">{p.name.split(' ')[0]}</span>
                    <span className="crew-state" style={{ color: hol ? 'var(--warning)' : p.status === 'on' ? 'var(--success)' : p.status === 'break' ? 'var(--warning)' : 'var(--text3)' }}>
                      {hol ? 'HOLIDAY' : p.status === 'on' ? `ON · ${fmtSince(p.clock_in)}` : p.status === 'break' ? `BREAK · ${breakMins(p.break_started_at)}m` : 'OUT'}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="card deck">
              <div className="deck-head"><span className="deck-title">Efficiency</span><span className="section-label">{gEffTarget > 0 ? `vs ${Math.round(gEffTarget)}% target` : 'MTD'}</span></div>
              {effRows.length === 0 && <div className="deck-empty">No hours yet this month.</div>}
              {effRows.map(r => (
                <div key={r.name} className="eff-row">
                  <span className="crew-name">{r.name.split(' ')[0]}</span>
                  <div className="eff-bar">
                    <div className="eff-bar-fill" style={{ width: `${Math.min(r.eff, 110) / 110 * 100}%`, background: gEffTarget > 0 ? (r.eff >= gEffTarget ? 'var(--success)' : 'var(--warning)') : 'var(--accent)' }} />
                    {gEffTarget > 0 && <div className="eff-bar-marker" style={{ left: `${Math.min(gEffTarget, 110) / 110 * 100}%` }} />}
                  </div>
                  <span className="eff-pct">{r.eff}%</span>
                </div>
              ))}
            </div>
            <div className="card deck">
              <div className="deck-head"><span className="deck-title">Two weeks</span><span className="section-label">Off &amp; stats</span></div>
              <div className="tw-grid">
                {days.map(dt => {
                  const iso = dt.toISOString().slice(0, 10);
                  const dow = dt.getUTCDay();
                  const o = offDates(iso);
                  const cls = ['tw-cell'];
                  if (dow === 0 || dow === 6) cls.push('dim');
                  if (hset.has(iso)) cls.push('stat');
                  if (o.approved) cls.push('off');
                  else if (o.pending) cls.push('pending');
                  return <span key={iso} className={cls.join(' ')} title={iso}>{dt.getDate()}</span>;
                })}
              </div>
              <div className="deck-foot">
                {nextOff ? `${(nextOff.person_name || '').split(' ')[0]} ${fmtD2(nextOff.start_date)}–${fmtD2(nextOff.end_date)}${nextOff.paid === true ? ' paid' : ''}` : 'No time off booked'}
                {nextStat ? ` · next stat: ${nextStat.label}` : ''}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Advisor: cars + efficiency only — the allowed operational metrics.
          Fallback like the owner cards: the hero band covers these when a
          revenue target exists. */}
      {isAdvisor && !(gRevTarget > 0) && (
        <div className="stat-grid" style={{ marginBottom: '20px' }}>
          <div className="metric-card">
            <div className="metric-label">Car count MTD</div>
            <div className="metric-value">{groupCarCount > 0 ? groupCarCount : '—'}</div>
            <div className="metric-sub">{groupCarCount > 0 ? 'invoiced this month' : 'awaiting sync'}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Avg efficiency</div>
            <div className="metric-value">{groupEff > 0 ? `${groupEff}%` : '—'}</div>
            <div className="metric-sub">{groupEff > 0 ? 'hours sold / worked' : 'no hours yet'}</div>
          </div>
        </div>
      )}

      {/* Full metric block for every role — a manager's "group" is just their own
          location (the locations list is already server-filtered to it). */}
      {!isAdvisor && (
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


      {/* Location money cards — not for advisors (their nav has no Performance
          to click through to either). */}
      {!isAdvisor && (<>
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
      </>)}
    </div>
  );
}
