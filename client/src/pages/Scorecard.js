import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';
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

function ScorecardView({ locId }) {
  const { api } = useAuth();
  const { locations } = useLocations();
  const [metrics, setMetrics] = useState(null);
  const [target, setTarget] = useState(null);
  const [pnl, setPnl] = useState(null);
  const [pnlErr, setPnlErr] = useState(false);
  const [loading, setLoading] = useState(true);

  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  useEffect(() => {
    if (!locId) return;
    setLoading(true); setPnlErr(false);
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = new Date().toISOString().slice(0, 10);
    let cancelled = false;
    Promise.all([
      api(`/metrics/${locId}/summary`).catch(() => null),
      api(`/targets/${locId}/${year}`).catch(() => []),
      api(`/finance/${locId}/pnl?start=${start}&end=${end}`).catch(() => { setPnlErr(true); return null; }),
    ]).then(([m, tg, p]) => {
      if (cancelled) return;
      setMetrics(m);
      setTarget(Array.isArray(tg) ? (tg.find(r => r.month === month) || null) : null);
      setPnl(p);
      setLoading(false);
    });
    return () => { cancelled = true; };
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
  const door = num(loc?.labour_rate) || 170;
  const effRate = metrics?.effective_labour_rate != null ? num(metrics.effective_labour_rate)
    : (num(metrics?.labour_revenue) > 0 && num(metrics?.labour_hours_sold) > 0 ? num(metrics.labour_revenue) / num(metrics.labour_hours_sold) : 0);
  const hasMetrics = !!metrics && revenue > 0;

  if (loading) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading scorecard…</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px', flexWrap: 'wrap' }}>
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
        <div className="stat-grid" style={{ marginBottom: '20px' }}>
          <Tile label="Net income" value={money0(net)} tone={num(net) >= 0 && !(netMargin > 30) ? (num(net) >= 0 ? 'good' : 'bad') : ''}
            sub={netMargin != null ? `${netMargin.toFixed(1)}% net margin` : ''} />
          {/* A net margin far above the 15–22% band on month-to-date QuickBooks is
              almost always books-not-closed (income posted, expenses lagging), NOT a
              win — so don't paint it green, and say why. */}
          <Tile label="Net margin" value={netMargin != null ? `${netMargin.toFixed(1)}%` : '—'}
            tone={(netMargin >= 15 && netMargin <= 30) ? 'good' : 'warn'}
            sub={netMargin > 30 ? 'above range — books likely not closed yet' : 'target 15–22%'} />
          <Tile label="Income" value={money0(income)} sub="this month" />
          <Tile label="Expenses" value={money0(expenses)} sub="this month" />
        </div>
      )}

      {/* Operations — Shopmonkey */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>Operations</div>
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>Shopmonkey · {hasMetrics ? 'live · pre-tax' : 'awaiting sync'}</div>
      </div>
      <div className="stat-grid">
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
        <Tile label="Effective labour rate" value={effRate > 0 ? `$${Math.round(effRate)}/hr` : '—'}
          sub={effRate > 0 ? `vs $${Math.round(door)} door${effRate < door ? ` · −$${Math.round(door - effRate)}` : ''}` : 'awaiting sync'} />
      </div>
    </div>
  );
}

export default function Scorecard() {
  const { isAll, scopeLocations, selectedId } = useLocations();
  if (!isAll) {
    if (!selectedId) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Select a location.</div>;
    return <ScorecardView locId={selectedId} />;
  }
  return (
    <div>
      {scopeLocations.map(l => (
        <div key={l.id} style={{ marginBottom: '32px' }}>
          <div className="section-label" style={{ marginBottom: '12px' }}>{l.name}</div>
          <ScorecardView locId={l.id} />
        </div>
      ))}
    </div>
  );
}
