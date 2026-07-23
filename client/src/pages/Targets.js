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
    } catch {}
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
          {[2025, 2026, 2027].map(y => <option key={y}>{y}</option>)}
        </select>
        <button onClick={recalcTargets} disabled={recalcing || saving} style={{ marginLeft: 'auto' }}
          title="If completed months missed target, bump the remaining months so the year still hits its annual target">
          {recalcing ? 'Recalculating…' : '↻ Recalculate to yearly'}
        </button>
        <button className="primary" onClick={saveTargets} disabled={saving || recalcing}>
          {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save all targets'}
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
