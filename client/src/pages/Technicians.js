import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';

const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const money0 = n => '$' + Math.round(num(n)).toLocaleString('en-CA');
const hrsNum = n => (Math.round(num(n) * 10) / 10).toLocaleString('en-CA');

function TechniciansView({ locId }) {
  const { user, api } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const showFinancials = user?.role !== 'manager';
  const [weekly, setWeekly] = useState({});
  const [saving, setSaving] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState(null);
  const [period, setPeriod] = useState('mtd');
  const [hidden, setHidden] = useState(new Set());
  const [clock, setClock] = useState([]);          // live time-clock status per crew member
  const [tick, setTick] = useState(0);             // re-render so break durations count up

  // Live clock status (from the shop-floor kiosk) — polled so the page mirrors
  // the bay in near-real-time. Best-effort: absence of clock data hides chips.
  useEffect(() => {
    if (!locId) return undefined;
    let alive = true;
    const pull = () => api(`/clock/${locId}/status`).then(d => { if (alive) setClock(d.people || []); }).catch(() => {});
    pull();
    const t = setInterval(() => { pull(); setTick(x => x + 1); }, 30 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [api, locId]);

  // Match kiosk crew to Shopmonkey tech names by folded first name (same rule
  // the bonus pull uses).
  const normFirst = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/)[0];
  const clockFor = (techName) => clock.find(c => normFirst(c.name) && normFirst(techName).startsWith(normFirst(c.name)));
  const fmtT = (t) => t ? new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '';
  const minsSince = (t) => Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
  const ClockChip = ({ c }) => {
    if (!c) return null;
    const style = { fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '10px', marginLeft: '8px', whiteSpace: 'nowrap' };
    if (c.status === 'on') return <span style={{ ...style, background: 'rgba(52,199,89,0.14)', color: 'var(--success)' }}>🟢 Clocked in {fmtT(c.clock_in)}</span>;
    if (c.status === 'break') return <span style={{ ...style, background: 'rgba(255,184,0,0.16)', color: 'var(--warning)' }}>🟡 On break {minsSince(c.break_started_at)} min</span>;
    return <span style={{ ...style, background: 'var(--bg3)', color: 'var(--text3)' }}>⚫ Clocked out</span>;
  };

  useEffect(() => {
    if (!locId) return;
    setLoading(true); setError(null);
    api(`/technicians/${locId}?period=${period}`).then(d => {
        setData(d);
        const w = {};
        (d.technicians || []).forEach(t => { if (t.hours_per_week != null) w[t.tech_id] = String(t.hours_per_week); });
        setWeekly(w);
        setLoading(false);
      })
      .catch(err => { setError(err.message || 'Could not load technicians'); setLoading(false); });
  }, [locId]); // eslint-disable-line

  const allTechs = (data && data.technicians) || [];
  const techs = allTechs.filter(t => !hidden.has(t.tech_id || t.tech_name));
  const hiddenTechList = allTechs.filter(t => hidden.has(t.tech_id || t.tech_name));
  const count = techs.length;
  const hasHours = !!(data && data.has_hours);
  const totalSold = techs.reduce((s, t) => s + num(t.hours_sold), 0);
  const totalBilled = techs.reduce((s, t) => s + num(t.hours_billed), 0);
  const totalRev = techs.reduce((s, t) => s + num(t.labour_revenue), 0);
  const totalVehicles = techs.reduce((s, t) => s + num(t.vehicle_count), 0);
  const distinctVehicles = data?.distinct_vehicles_mtd != null ? data.distinct_vehicles_mtd : null;

  const effTechs = techs.filter(t => t.efficiency != null && t.hours_worked != null);
  const _gWorked = effTechs.reduce((s, t) => s + num(t.hours_worked), 0);
  const _gSold = effTechs.reduce((s, t) => s + num(t.hours_sold), 0);
  const groupEff = _gWorked > 0 ? Math.round((_gSold / _gWorked) * 100) : null;
  const effTarget = 80;

  useEffect(() => {
    if (data && Array.isArray(data.hidden)) {
      setHidden(new Set(data.hidden.map(h => h.tech_id || h.tech_name)));
    }
  }, [data]);

  const toggleHide = async (t, willHide) => {
    const key = t.tech_id || t.tech_name;
    setHidden(prev => { const n = new Set(prev); if (willHide) n.add(key); else n.delete(key); return n; });
    try {
      await api(`/technicians/${locId}/hidden-techs`, { method: 'POST', body: JSON.stringify({ tech_id: t.tech_id, tech_name: t.tech_name, hidden: willHide }) });
    } catch (e) {}
  };

  const loadPeriod = async (pk) => {
    const d = await api(`/technicians/${locId}?period=${pk}`);
    setData(d);
  };

  const switchPeriod = async (pk) => {
    if (pk === period) return;
    setPeriod(pk); setRecomputeMsg(null); setError(null);
    try { await loadPeriod(pk); } catch (e) { setError(e.message || 'Load failed'); }
  };

  const refresh = async () => {
    setSaving(true); setError(null);
    try {
      if (period === 'ytd') {
        await api(`/hours/${locId}/recompute-ytd`, { method: 'POST', body: JSON.stringify({}) });
        setRecomputeMsg('YTD is recomputing in the background \u2014 it takes a few minutes. Switch away and back to YTD to see the updated numbers.');
      } else {
        const r = await api(`/hours/${locId}/recompute-from-weekly`, { method: 'POST', body: JSON.stringify({ period_type: 'mtd' }) });
        setRecomputeMsg(`Updated ${r.count} techs \u00b7 ${r.worked_hours}h worked (${r.period_start} to ${r.period_end}).`);
        await loadPeriod('mtd');
      }
    } catch (e) {
      setError(e.message || 'Refresh failed');
    } finally {
      setSaving(false);
    }
  };

  const cols = showFinancials ? 7 : 6;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: '600', color: 'var(--text)', margin: 0 }}>Technicians</h1>
          <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '3px' }}>
            Live roster pulled from Shopmonkey. Add or remove techs in Shopmonkey and this follows on the next sync &mdash; no manual list to maintain.
          </div>
        </div>
      </div>

      {error && <div className="card" style={{ padding: '14px', color: 'var(--danger)', margin: '12px 0' }}>{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)' }}>Loading&hellip;</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', margin: '14px 0 18px' }}>
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Technicians</div>
              <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--text)', marginTop: '4px' }}>{count}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>{data?.roster_source === 'shopmonkey_live' ? 'live count' : 'last known'}</div>
            </div>
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Hours sold MTD</div>
              <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--text)', marginTop: '4px' }}>{hasHours ? hrsNum(totalSold) : '\u2014'}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>{hasHours ? 'booked on tickets' : 'pending tech sync'}</div>
            </div>
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Hours billed MTD</div>
              <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--text)', marginTop: '4px' }}>{hasHours ? hrsNum(totalBilled) : '\u2014'}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>{hasHours ? 'completed lines' : 'pending tech sync'}</div>
            </div>
          </div>

          {data?.roster_error && (
            <div className="card" style={{ padding: '12px 14px', color: 'var(--warning)', fontSize: '12px', marginBottom: '12px' }}>
              Live roster unavailable ({data.roster_error}); showing last known count.
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', gap: '3px', background: 'var(--bg2)', borderRadius: '8px', padding: '3px' }}>
              {[['mtd', 'This month'], ['ytd', 'YTD']].map(([pk, label]) => (
                <button key={pk} onClick={() => switchPeriod(pk)}
                  style={{ fontSize: '12px', fontWeight: '600', padding: '5px 14px', borderRadius: '6px', cursor: 'pointer', border: 'none',
                    background: period === pk ? 'var(--accent)' : 'transparent', color: period === pk ? '#fff' : 'var(--text3)' }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text3)', flex: 1 }}>
              {recomputeMsg ? recomputeMsg : (period === 'ytd'
                ? 'Year to date \u00b7 Jan 1 to today. Efficiency = hours sold \u00f7 working days elapsed this year \u00d7 8h.'
                : 'This month \u00b7 efficiency = hours sold \u00f7 working days elapsed this month \u00d7 8h (stat holidays excluded).')}
            </div>
            <button onClick={refresh} disabled={saving}
              style={{ fontSize: '12px', fontWeight: '500', padding: '6px 14px', borderRadius: '6px', cursor: saving ? 'default' : 'pointer',
                background: saving ? 'var(--surface2)' : 'var(--accent)', color: saving ? 'var(--text3)' : '#fff', border: 'none', whiteSpace: 'nowrap' }}>
              {saving ? 'Working\u2026' : 'Refresh'}
            </button>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg3)', color: 'var(--text3)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px', fontWeight: '500' }}>Technician</th>
                  <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Hours sold</th>
                  <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Hours billed</th>
                  <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Vehicles</th>
                  {showFinancials && <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Labour revenue</th>}
                  <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Efficiency</th>
                </tr>
              </thead>
              <tbody>
                {techs.length === 0 ? (
                  <tr><td colSpan={cols} style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)' }}>No technicians returned from Shopmonkey.</td></tr>
                ) : techs.map(t => (
                  <tr key={t.tech_id || t.tech_name} onClick={() => toggleHide(t, true)} title="Click to hide from board" style={{ borderTop: '0.5px solid var(--border)', cursor: 'pointer' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text)' }} className="strong">
                      {(() => { const c = clockFor(t.tech_name); return (<>
                        {c && c.photo && <img src={c.photo} alt="" style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover', verticalAlign: 'middle', marginRight: '7px', border: c.color ? `2px solid ${c.color}` : 'none' }} />}
                        <span style={{ color: (c && c.color) || 'var(--text)' }}>{t.tech_name}</span>
                        <ClockChip c={c} />
                      </>); })()}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: t.hours_sold != null ? 'var(--text)' : 'var(--text3)' }}>{t.hours_sold != null ? hrsNum(t.hours_sold) : '\u2014'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: t.hours_billed != null ? 'var(--text)' : 'var(--text3)' }}>{t.hours_billed != null ? hrsNum(t.hours_billed) : '\u2014'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: t.vehicle_count != null ? 'var(--text)' : 'var(--text3)' }}>{t.vehicle_count != null ? t.vehicle_count : '\u2014'}</td>
                    {showFinancials && <td style={{ padding: '8px 12px', textAlign: 'right', color: t.labour_revenue != null ? 'var(--text)' : 'var(--text3)' }}>{t.labour_revenue != null ? money0(t.labour_revenue) : '\u2014'}</td>}
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>{t.efficiency != null
                      ? <span style={{ color: t.efficiency >= effTarget ? 'var(--success)' : 'var(--warning)', fontWeight: '600' }}>{Math.round(t.efficiency)}%{t.hours_worked != null ? <span style={{ color: 'var(--text3)', fontWeight: '400', fontSize: '11px' }}> ({hrsNum(t.hours_worked)}h)</span> : null}</span>
                      : <span style={{ color: 'var(--text3)' }}>{'\u2014'}</span>}</td>
                  </tr>
                ))}
              </tbody>
              {techs.length > 0 && hasHours && (
                <tfoot>
                  <tr style={{ borderTop: '0.5px solid var(--border2)', background: 'var(--bg3)' }}>
                    <td style={{ padding: '8px 12px' }} className="strong">Group total</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }} className="strong">{hrsNum(totalSold)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }} className="strong">{hrsNum(totalBilled)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }} className="strong">{distinctVehicles != null ? distinctVehicles : '\u2014'}</td>
                    {showFinancials && <td style={{ padding: '8px 12px', textAlign: 'right' }} className="strong">{money0(totalRev)}</td>}
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text3)' }}>&mdash;</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }} className="strong">{groupEff != null ? `${groupEff}%` : '\u2014'}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {hiddenTechList.length > 0 && (
            <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--text3)', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: '600' }}>Hidden:</span>
              {hiddenTechList.map(t => (
                <button key={t.tech_id || t.tech_name} onClick={() => toggleHide(t, false)}
                  style={{ fontSize: '11px', padding: '2px 10px', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', cursor: 'pointer' }}>
                  {t.tech_name} +
                </button>
              ))}
              <span>&middot; click a name to restore it</span>
            </div>
          )}

          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>
            Hours sold = booked on tickets; hours billed = completed lines. The gap is labour discounted down (road tests, multi-checks, goodwill). Labour revenue is pre-tax, after discounts. Efficiency = hours sold ÷ worked hours, measured month-to-date; worked = each tech’s weekly hours × weeks elapsed this month. Multi-tech jobs attribute each labour line to the tech who performed it, matching Shopmonkey&rsquo;s per-technician report.
          </div>
        </>
      )}
    </div>
  );
}

export default function Technicians() {
  const { isAll, scopeLocations, selectedId } = useLocations();
  if (!isAll) {
    if (!selectedId) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Select a location.</div>;
    return <TechniciansView locId={selectedId} />;
  }
  return (
    <div>
      {scopeLocations.map(l => (
        <div key={l.id} style={{ marginBottom: '32px' }}>
          <div className="section-label" style={{ marginBottom: '12px' }}>{l.name}</div>
          <TechniciansView locId={l.id} />
        </div>
      ))}
    </div>
  );
}
