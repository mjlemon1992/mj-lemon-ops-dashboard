import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { askConfirm, showToast } from '../components/Feedback';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const DEFAULT_TARGETS = [
  { month:1, revenue:146250, car_count:75, parts_margin:55, labour_margin:70, labour_hours:362, efficiency:80, avg_ro_value:1950, pph:254 },
  { month:2, revenue:146750, car_count:65, parts_margin:55, labour_margin:70, labour_hours:364, efficiency:80, avg_ro_value:2257, pph:254 },
  { month:3, revenue:175500, car_count:90, parts_margin:55, labour_margin:70, labour_hours:435, efficiency:80, avg_ro_value:1950, pph:254 },
  { month:4, revenue:180500, car_count:92, parts_margin:55, labour_margin:70, labour_hours:447, efficiency:80, avg_ro_value:1962, pph:254 },
  { month:5, revenue:190250, car_count:97, parts_margin:55, labour_margin:70, labour_hours:472, efficiency:80, avg_ro_value:1961, pph:254 },
  { month:6, revenue:190250, car_count:97, parts_margin:55, labour_margin:70, labour_hours:472, efficiency:80, avg_ro_value:1961, pph:254 },
  { month:7, revenue:190250, car_count:102, parts_margin:55, labour_margin:70, labour_hours:472, efficiency:80, avg_ro_value:1865, pph:254 },
  { month:8, revenue:200500, car_count:95, parts_margin:55, labour_margin:70, labour_hours:497, efficiency:80, avg_ro_value:2110, pph:254 },
  { month:9, revenue:185250, car_count:96, parts_margin:55, labour_margin:70, labour_hours:459, efficiency:80, avg_ro_value:1930, pph:254 },
  { month:10, revenue:187200, car_count:95, parts_margin:55, labour_margin:70, labour_hours:464, efficiency:80, avg_ro_value:1971, pph:254 },
  { month:11, revenue:126750, car_count:65, parts_margin:55, labour_margin:70, labour_hours:314, efficiency:80, avg_ro_value:1950, pph:254 },
  { month:12, revenue:126750, car_count:65, parts_margin:55, labour_margin:70, labour_hours:314, efficiency:80, avg_ro_value:1950, pph:254 },
];

export default function Targets() {
  const { api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [selectedLoc, setSelectedLoc] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth());
  const [targets, setTargets] = useState(DEFAULT_TARGETS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api('/locations').then(locs => {
      setLocations(locs);
      if (locs.length) setSelectedLoc(locs[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedLoc) return;
    api(`/targets/${selectedLoc}/${year}`)
      .then(rows => {
        // Slot i is always month i+1, regardless of which months the server
        // returned — prevents index/month drift on partial target sets.
        const byMonth = Object.fromEntries((rows || []).map(r => [Number(r.month), r]));
        setTargets(DEFAULT_TARGETS.map((d, i) => byMonth[i + 1] || d));
      })
      .catch(() => setTargets(DEFAULT_TARGETS));
  }, [selectedLoc, year]);

  const currentTarget = targets[selectedMonth] || DEFAULT_TARGETS[selectedMonth];

  const updateField = (key, val) => {
    setTargets(prev => prev.map((t, i) => i === selectedMonth ? { ...t, [key]: parseFloat(val) || 0 } : t));
  };

  const saveTargets = async () => {
    if (!selectedLoc) return;
    setSaving(true);
    try {
      await api(`/targets/${selectedLoc}/${year}/bulk`, { method: 'POST', body: JSON.stringify({ targets: targets.map((t, i) => ({ ...t, month: i + 1 })) }) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { showToast((e && e.message) || 'Could not save targets', 'error'); }
    setSaving(false);
  };

  const [recalcing, setRecalcing] = useState(false);
  // Missed a month? Pull actuals for completed months, and if we're behind,
  // spread the shortfall evenly across the remaining months so the year still
  // lands on its original annual target. Preview first, then save on confirm.
  const recalcTargets = async () => {
    if (!selectedLoc) return;
    setRecalcing(true);
    try {
      const r = await api(`/targets/${selectedLoc}/${year}/recalculate`, { method: 'POST', body: JSON.stringify({}) });
      if (r.status !== 'behind') { showToast(r.message || 'Nothing to recalculate', r.status === 'ahead' ? 'success' : undefined); setRecalcing(false); return; }
      const k = (n) => '$' + Math.round(n).toLocaleString('en-CA');
      const lines = r.proposed.map((p) => `${MONTHS[p.month - 1]}:  ${k(p.old_revenue)} → ${k(p.new_revenue)}`).join('\n');
      const skipNote = (r.skipped && r.skipped.length)
        ? `\n\nSkipped (no Shopmonkey data): ${r.skipped.map((m) => SHORT[m - 1]).join(', ')} — not counted as misses.`
        : '';
      const ok = await askConfirm({
        title: 'Recalculate to yearly target',
        body: `Completed months are ${k(r.shortfall)} behind the ${k(r.yearly_target)} annual target.\n\nEven split adds ${k(r.per_month_bump)} to each of the ${r.remaining_count} remaining months so the year still lands on ${k(r.yearly_target)}:\n\n${lines}${skipNote}`,
        confirmLabel: 'Apply & save',
      });
      if (!ok) { setRecalcing(false); return; }
      const bump = Object.fromEntries(r.proposed.map((p) => [p.month, p.new_revenue]));
      const next = targets.map((t, i) => (bump[i + 1] != null ? { ...t, revenue: bump[i + 1] } : t));
      setTargets(next);
      await api(`/targets/${selectedLoc}/${year}/bulk`, { method: 'POST', body: JSON.stringify({ targets: next.map((t, i) => ({ ...t, month: i + 1 })) }) });
      showToast('Targets recalculated & saved ✓');
    } catch (e) { showToast((e && e.message) || 'Recalculate failed', 'error'); }
    setRecalcing(false);
  };

  // ── Build-from-curve: one annual number → 12 seasonal monthly targets ──
  const [annual, setAnnual] = useState('');
  const [building, setBuilding] = useState(false);
  const buildFromCurve = async () => {
    const total = Math.round(Number(annual));
    if (!selectedLoc || !Number.isFinite(total) || total <= 0) { showToast('Enter the annual revenue target first', 'error'); return; }
    setBuilding(true);
    try {
      const r = await api(`/targets/${selectedLoc}/${year}/build-from-curve`, { method: 'POST', body: JSON.stringify({ total_revenue: total }) });
      const k = (n) => '$' + Math.round(n).toLocaleString('en-CA');
      const lines = r.proposed.map((p) => `${SHORT[p.month - 1]}:  ${k(p.revenue)}  (${p.weight_pct}%${p.car_count != null ? ` · ${p.car_count} cars` : ''})`).join('\n');
      const src = r.basis_source === 'quickbooks' ? 'QuickBooks books income' : 'ShopMonkey sales';
      const ok = await askConfirm({
        title: `Build ${year} from ${r.basis_year}'s curve`,
        body: `${r.basis_year} did ${k(r.basis_total)} (${src}); this shapes ${k(r.total)} (${r.growth_pct >= 0 ? '+' : ''}${r.growth_pct}%) the same way:\n\n${lines}\n\nThis OVERWRITES the monthly revenue targets for all 12 months of ${year}${r.basis_source === 'quickbooks' ? ' (car counts and avg-RO keep their current values — the books have no car counts)' : ', plus car count and avg-RO'}. Other fields keep their values.`,
        confirmLabel: 'Apply & save',
      });
      if (!ok) { setBuilding(false); return; }
      const byMonth = Object.fromEntries(r.proposed.map((p) => [p.month, p]));
      const next = targets.map((t, i) => {
        const p = byMonth[i + 1];
        return p ? { ...t, revenue: p.revenue, car_count: p.car_count ?? t.car_count, avg_ro_value: p.avg_ro_value ?? t.avg_ro_value } : t;
      });
      setTargets(next);
      await api(`/targets/${selectedLoc}/${year}/bulk`, { method: 'POST', body: JSON.stringify({ targets: next.map((t, i) => ({ ...t, month: i + 1 })) }) });
      showToast(`${year} targets built from ${r.basis_year}'s curve ✓`);
      setGoalsTick((n) => n + 1);
    } catch (e) { showToast((e && e.message) || 'Could not build from curve', 'error'); }
    setBuilding(false);
  };

  // ── Goals board data (Actual / Goal / Last Year per month) ──
  const [goals, setGoals] = useState(null);
  const [goalsErr, setGoalsErr] = useState('');
  const [goalsLoading, setGoalsLoading] = useState(false);
  const [goalsTick, setGoalsTick] = useState(0);
  useEffect(() => {
    if (!selectedLoc) return;
    let cancelled = false;
    setGoalsLoading(true); setGoalsErr(''); setGoals(null);
    api(`/targets/${selectedLoc}/${year}/goals`)
      .then((g) => { if (!cancelled) setGoals(g); })
      .catch((e) => { if (!cancelled) setGoalsErr((e && e.message) || 'Could not load actuals'); })
      .finally(() => { if (!cancelled) setGoalsLoading(false); });
    return () => { cancelled = true; };
  }, [selectedLoc, year, goalsTick]);

  const field = (key, label) => (
    <div className="form-group" key={key}>
      <label className="form-label">{label}</label>
      <input type="number" value={currentTarget[key] ?? ''} onChange={e => updateField(key, e.target.value)} />
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <select value={selectedLoc} onChange={e => setSelectedLoc(e.target.value)} style={{ width: 'auto' }}>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          {locations.length === 0 && <option>Hwy 97 Mister Transmission</option>}
        </select>
        <select value={year} onChange={e => setYear(parseInt(e.target.value))} style={{ width: 'auto' }}>
          {(() => { const c = new Date().getFullYear(); return [c - 1, c, c + 1]; })().map(y => <option key={y}>{y}</option>)}
        </select>
        <button onClick={recalcTargets} disabled={recalcing || saving} style={{ marginLeft: 'auto' }}
          title="If completed months missed target, bump the remaining months so the year still hits its annual target">
          {recalcing ? 'Recalculating…' : '↻ Recalculate to yearly'}
        </button>
        <button className="primary" onClick={saveTargets} disabled={saving || recalcing}>
          {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save all targets'}
        </button>
      </div>

      {/* ── Going for the Goals — the wall chart, live ── */}
      <div className="card" style={{ marginBottom: '16px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Going for the goals — {year}</div>
          <div style={{ fontSize: '11px', color: 'var(--text3)' }}>
            Actual & last year from ShopMonkey{goals && goals.qbo_used ? ' · last-year months ShopMonkey can’t see use QuickBooks books income (no car counts)' : ''} · goal from this page
          </div>
          <button onClick={() => setGoalsTick(n => n + 1)} disabled={goalsLoading} style={{ marginLeft: 'auto', fontSize: '12px' }}>↻ Refresh</button>
        </div>
        {goalsLoading && <div style={{ color: 'var(--text3)', fontSize: '12px', padding: '18px 0' }}>Pulling ShopMonkey history — first load takes ~20 seconds…</div>}
        {goalsErr && !goalsLoading && <div style={{ color: 'var(--warning)', fontSize: '12px', padding: '12px 0' }}>{goalsErr}</div>}
        {goals && !goalsLoading && (() => {
          const money0 = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-CA'));
          const moneyK = (n) => (n == null ? '—' : '$' + Math.round(n / 1000) + 'k');
          const series = goals.months;
          const vals = [];
          series.forEach((m) => { ['actual', 'goal', 'last_year'].forEach((k) => { if (m[k] && m[k].revenue > 0) vals.push(m[k].revenue); }); });
          const maxV = Math.max(...vals, 1);
          const X = (i) => 30 + i * (660 / 11);
          const Y = (v) => 150 - (v / maxV) * 130;
          const line = (key) => series.map((m, i) => (m[key] && m[key].revenue > 0 ? `${X(i)},${Y(m[key].revenue)}` : null)).filter(Boolean).join(' ');
          const rowDefs = [
            ['actual', 'ACTUAL', 'var(--text)'],
            ['goal', 'GOAL', 'var(--accent)'],
            ['last_year', 'LAST YEAR', 'var(--text3)'],
          ];
          return (
            <>
              <svg viewBox="0 0 720 165" style={{ width: '100%', height: 'auto', display: 'block', margin: '6px 0 10px' }} role="img" aria-label="Monthly revenue: actual vs goal vs last year">
                {[0.25, 0.5, 0.75, 1].map((f) => (
                  <g key={f}>
                    <line x1="30" x2="690" y1={Y(maxV * f)} y2={Y(maxV * f)} stroke="var(--border)" strokeWidth="0.5" />
                    <text x="2" y={Y(maxV * f) + 3} fontSize="8" fill="var(--text3)">{moneyK(maxV * f)}</text>
                  </g>
                ))}
                {SHORT.map((m, i) => <text key={m} x={X(i)} y="162" fontSize="8" fill="var(--text3)" textAnchor="middle">{m}</text>)}
                <polyline points={line('last_year')} fill="none" stroke="var(--text3)" strokeWidth="1.4" strokeDasharray="1.5 2.5" />
                <polyline points={line('goal')} fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeDasharray="5 3" opacity="0.85" />
                <polyline points={line('actual')} fill="none" stroke="var(--text)" strokeWidth="2.2" />
                {series.map((m, i) => (m.actual && m.actual.revenue > 0 ? <circle key={i} cx={X(i)} cy={Y(m.actual.revenue)} r="2.6" fill="var(--text)" /> : null))}
              </svg>
              <div style={{ display: 'flex', gap: '16px', fontSize: '10px', color: 'var(--text3)', marginBottom: '10px' }}>
                <span><span style={{ display: 'inline-block', width: 18, borderTop: '2.2px solid var(--text)', verticalAlign: 'middle', marginRight: 5 }} />Actual</span>
                <span><span style={{ display: 'inline-block', width: 18, borderTop: '2px dashed var(--accent)', verticalAlign: 'middle', marginRight: 5 }} />Goal</span>
                <span><span style={{ display: 'inline-block', width: 18, borderTop: '2px dotted var(--text3)', verticalAlign: 'middle', marginRight: 5 }} />Last year</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: '860px', fontSize: '11px', fontVariantNumeric: 'tabular-nums' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text3)', fontWeight: 500 }}></th>
                      {SHORT.map((m) => <th key={m} style={{ padding: '4px 6px', color: 'var(--text3)', fontWeight: 600 }}>{m.toUpperCase()}</th>)}
                      <th style={{ padding: '4px 6px', color: 'var(--text)', fontWeight: 700 }}>TOTAL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rowDefs.map(([key, label, color]) => (
                      <React.Fragment key={key}>
                        <tr style={{ borderTop: '0.5px solid var(--border)' }}>
                          <td style={{ padding: '4px 6px', color, fontWeight: 700, whiteSpace: 'nowrap' }}>{label} · sales</td>
                          {series.map((m, i) => <td key={i} style={{ padding: '4px 6px', textAlign: 'center', color: 'var(--text2)' }}>{m[key] && m[key].revenue ? moneyK(m[key].revenue) : '—'}</td>)}
                          <td style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 700, color: 'var(--text)' }}>{money0(goals.totals[key] && goals.totals[key].revenue)}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 6px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>avg work order</td>
                          {series.map((m, i) => <td key={i} style={{ padding: '2px 6px', textAlign: 'center', color: 'var(--text3)' }}>{m[key] && m[key].awo ? money0(m[key].awo) : '—'}</td>)}
                          <td />
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 6px 6px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>cars</td>
                          {series.map((m, i) => <td key={i} style={{ padding: '2px 6px 6px', textAlign: 'center', color: 'var(--text3)' }}>{m[key] && m[key].cars ? m[key].cars : '—'}</td>)}
                          <td style={{ padding: '2px 6px 6px', textAlign: 'center', color: 'var(--text3)', fontWeight: 600 }}>{(goals.totals[key] && goals.totals[key].cars) || '—'}</td>
                        </tr>
                      </React.Fragment>
                    ))}
                    <tr style={{ borderTop: '0.5px solid var(--border)' }}>
                      <td style={{ padding: '4px 6px', color: 'var(--text3)', fontWeight: 600 }}>% of goal</td>
                      {series.map((m, i) => {
                        const pct = m.actual && m.goal && m.goal.revenue > 0 && m.actual.revenue > 0 ? Math.round((m.actual.revenue / m.goal.revenue) * 100) : null;
                        return <td key={i} style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 700, color: pct == null ? 'var(--text3)' : pct >= 100 ? 'var(--success)' : pct >= 90 ? 'var(--warning)' : 'var(--danger)' }}>{pct == null ? '—' : pct + '%'}</td>;
                      })}
                      <td style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 700, color: 'var(--text)' }}>
                        {goals.totals.goal.revenue > 0 && goals.totals.actual.revenue > 0 ? Math.round((goals.totals.actual.revenue / goals.totals.goal.revenue) * 100) + '%' : '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}
      </div>

      {/* ── Build the year from last year's curve ── */}
      <div className="card" style={{ marginBottom: '16px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '12px', color: 'var(--text2)', flex: '1 1 260px' }}>
          <strong style={{ color: 'var(--text)' }}>Build {year} from last year's curve.</strong> Enter the annual revenue target — it splits across the months the way {year - 1} actually flowed (slow months stay realistic, big months carry more), summing exactly to your number.
        </div>
        <input type="number" placeholder={`Annual revenue for ${year}`} value={annual} onChange={(e) => setAnnual(e.target.value)}
          style={{ width: '190px' }} />
        <button onClick={buildFromCurve} disabled={building || saving || recalcing}>
          {building ? 'Building…' : '📈 Build monthly targets'}
        </button>
      </div>

      <div className="stat-grid-sm" style={{ marginBottom: '16px' }}>
        {SHORT.map((m, i) => {
          const t = targets[i] || DEFAULT_TARGETS[i];
          return (
            <div key={m} onClick={() => setSelectedMonth(i)}
              role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedMonth(i); } }}
              className="card"
              style={{ cursor: 'pointer', border: selectedMonth === i ? '0.5px solid var(--accent)' : '0.5px solid var(--border)', padding: '10px 12px' }}>
              <div style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text)', marginBottom: '6px' }}>{m}</div>
              <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>${Math.round((t.revenue || 0) / 1000)}k</div>
              <div style={{ fontSize: '10px', color: 'var(--text3)' }}>{t.car_count} cars</div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '14px' }}>
          {MONTHS[selectedMonth]} {year} targets
        </div>
        <div className="form-row">{field('revenue','Revenue target ($)')} {field('car_count','Car count target')}</div>
        <div className="form-row">{field('parts_margin','Parts margin target (%)')} {field('labour_margin','Labour margin target (%)')}</div>
        <div className="form-row">{field('labour_hours','Labour hours to sell')} {field('efficiency','Efficiency target (%)')}</div>
        <div className="form-row">{field('avg_ro_value','Avg RO value ($)')} {field('pph','Profit per hour target ($)')}</div>
      </div>
    </div>
  );
}
