import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { pacePct as wdPacePct } from '../utils/pace';

// Weekly CEO scorecard: the books (QBO P&L) + operations (Shopmonkey vs target),
// one screen. Composes existing endpoints — /metrics, /targets, /finance — so there's
// no new backend and the numbers always match the other tabs.
const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const money0 = n => (n == null ? '—' : '$' + Math.round(num(n)).toLocaleString('en-CA'));
const monthName = () => new Date().toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });

function Tile({ label, value, sub, tone }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className={`metric-sub ${tone || ''}`}>{sub}</div>
    </div>
  );
}

export default function Scorecard() {
  const { api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [target, setTarget] = useState(null);
  const [pnl, setPnl] = useState(null);
  const [pnlErr, setPnlErr] = useState(false);
  const [loading, setLoading] = useState(true);

  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  useEffect(() => {
    api('/locations').then(locs => {
      setLocations(locs);
      const first = locs.filter(l => l.active)[0] || locs[0];
      if (first) setLocId(first.id); else setLoading(false);
    }).catch(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    if (!locId) return;
    setLoading(true); setPnlErr(false);
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = new Date().toISOString().slice(0, 10);
    Promise.all([
      api(`/metrics/${locId}/summary`).catch(() => null),
      api(`/targets/${locId}/${year}`).catch(() => []),
      api(`/finance/${locId}/pnl?start=${start}&end=${end}`).catch(() => { setPnlErr(true); return null; }),
    ]).then(([m, tg, p]) => {
      setMetrics(m);
      setTarget(Array.isArray(tg) ? (tg.find(r => r.month === month) || null) : null);
      setPnl(p);
      setLoading(false);
    });
  }, [locId, api, year, month]);

  const loc = locations.find(l => l.id === locId);
  const province = loc?.province;
  const pace = (actual, tgt) => (tgt > 0 ? wdPacePct(num(actual), num(tgt), province) : null);

  // Books (QBO P&L, this month)
  const h = pnl?.headline || {};
  const income = h.income, expenses = h.expenses, net = h.netIncome;
  const netMargin = (income && net != null) ? (net / income) * 100 : null;

  // Operations (Shopmonkey MTD)
  const revenue = num(metrics?.revenue_mtd);
  const partsMargin = num(metrics?.parts_margin);
  const aro = num(metrics?.avg_ro_value);
  const cars = num(metrics?.car_count_mtd);
  const pph = num(metrics?.pph);
  const eff = metrics?.efficiency_avg == null ? null : num(metrics.efficiency_avg);
  const pmTarget = num(loc?.parts_margin_target) || 55;
  const effTarget = num(loc?.efficiency_target) || 80;
  const pphTarget = num(loc?.pph_target) || 254;
  const hasMetrics = !!metrics && revenue > 0;

  if (loading) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading scorecard…</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px', flexWrap: 'wrap' }}>
        {locations.length > 1 ? (
          <select value={locId || ''} onChange={e => setLocId(e.target.value)} style={{ width: 'auto' }}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>{loc?.name || 'Location'}</div>
        )}
        <span style={{ fontSize: '11px', color: 'var(--text3)' }}>{monthName()} · the one-screen read</span>
      </div>

      {/* The books — QBO */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>The books</div>
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>QuickBooks · month to date</div>
      </div>
      {pnlErr || !pnl ? (
        <div className="card" style={{ color: 'var(--text3)', padding: '18px', marginBottom: '18px', fontSize: '12px' }}>
          QuickBooks not connected for this view yet — the operations numbers below are live.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '20px' }}>
          <Tile label="Net income" value={money0(net)} tone={num(net) >= 0 ? 'good' : 'bad'}
            sub={netMargin != null ? `${netMargin.toFixed(1)}% net margin` : ''} />
          <Tile label="Net margin" value={netMargin != null ? `${netMargin.toFixed(1)}%` : '—'}
            tone={netMargin >= 15 ? 'good' : 'warn'} sub="target 15–22%" />
          <Tile label="Income" value={money0(income)} sub="this month" />
          <Tile label="Expenses" value={money0(expenses)} sub="this month" />
        </div>
      )}

      {/* Operations — Shopmonkey */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>Operations</div>
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>Shopmonkey · {hasMetrics ? 'live · pre-tax' : 'awaiting sync'}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px' }}>
        <Tile label="Revenue MTD" value={hasMetrics ? money0(revenue) : '—'}
          tone={target?.revenue ? (pace(revenue, target.revenue) >= 90 ? 'good' : 'warn') : ''}
          sub={target?.revenue ? `${pace(revenue, target.revenue)}% of pace` : 'no target set'} />
        <Tile label="Car count" value={hasMetrics ? cars : '—'}
          tone={target?.car_count ? (pace(cars, target.car_count) >= 90 ? 'good' : 'warn') : ''}
          sub={target?.car_count ? `${cars} / ${target.car_count} · ${pace(cars, target.car_count)}% of pace` : 'this month'} />
        <Tile label="Avg RO value" value={aro > 0 ? money0(aro) : '—'}
          tone={target?.avg_ro_value ? (aro >= num(target.avg_ro_value) ? 'good' : 'warn') : ''}
          sub={target?.avg_ro_value ? `vs ${money0(target.avg_ro_value)} target` : 'per car'} />
        <Tile label="Parts margin" value={partsMargin > 0 ? `${partsMargin.toFixed(1)}%` : '—'}
          tone={partsMargin >= pmTarget ? 'good' : 'warn'} sub={`vs ${pmTarget}% target`} />
        <Tile label="Efficiency" value={eff != null && eff > 0 ? `${Math.round(eff)}%` : '—'}
          tone={eff != null ? (eff >= effTarget ? 'good' : 'warn') : ''}
          sub={eff != null && eff > 0 ? `vs ${effTarget}% target` : 'no hours yet'} />
        <Tile label="Profit / hour" value={pph > 0 ? `$${Math.round(pph)}` : '—'}
          tone={pph >= pphTarget ? 'good' : 'warn'} sub={`vs $${pphTarget} target`} />
      </div>
    </div>
  );
}
