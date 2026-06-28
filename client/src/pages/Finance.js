import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';

const num = v => (typeof v === 'number' ? v : parseFloat(v));
const money = n => (n == null || Number.isNaN(num(n)))
  ? '—'
  : '$' + Math.round(num(n)).toLocaleString('en-CA');

const thisYearStart = () => `${new Date().getFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

function FinanceView({ locId }) {
  const { api } = useAuth();
  const { locations } = useLocations();
  const loc = locations.find(l => l.id === locId);
  const [start, setStart] = useState(thisYearStart());
  const [end, setEnd] = useState(today());
  const [configured, setConfigured] = useState(true);
  const [pnl, setPnl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  // Is the connector wired up? (drives the "not configured yet" state)
  useEffect(() => {
    api('/finance/status')
      .then(s => setConfigured(!!s.configured))
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    if (!locId) return;
    setLoading(true); setErr(null); setPnl(null);
    api(`/finance/${locId}/pnl?start=${start}&end=${end}`)
      .then(setPnl)
      .catch(e => setErr(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [locId, start, end, api]);

  const h = pnl?.headline || {};
  const summaries = Array.isArray(pnl?.summaries) ? pnl.summaries : [];

  const cards = [
    ['Total income', h.income, 'good'],
    ['Gross profit', h.grossProfit, 'good'],
    ['Total expenses', h.expenses, ''],
    ['Net income', h.netIncome, num(h.netIncome) >= 0 ? 'good' : 'bad'],
  ];

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="date" value={start} max={end} onChange={e => setStart(e.target.value)} style={{ width: 'auto' }} />
        <span style={{ color: 'var(--text3)', fontSize: '12px' }}>to</span>
        <input type="date" value={end} min={start} max={today()} onChange={e => setEnd(e.target.value)} style={{ width: 'auto' }} />
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>read-only · live from QuickBooks via the connector</div>
      </div>

      {!configured && (
        <div className="alert-strip" style={{ background: 'rgba(77,184,255,0.06)', borderColor: 'rgba(77,184,255,0.3)' }}>
          <span style={{ color: 'var(--info)' }}>QBO connector not configured yet.</span>
          <span style={{ fontSize: '12px', color: 'var(--text2)' }}>
            Set <code>QBO_CONNECTOR_URL</code> and <code>QBO_API_TOKEN</code> in the dashboard env to light this up.
          </span>
        </div>
      )}

      {loading && <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading&hellip;</div>}

      {!loading && err && (
        <div className="card" style={{ borderColor: 'rgba(255,77,77,0.3)' }}>
          <div style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '4px' }}>Couldn&rsquo;t load financials</div>
          <div style={{ fontSize: '12px', color: 'var(--text2)' }}>{err}</div>
        </div>
      )}

      {!loading && !err && pnl && (
        <>
          <div className="stat-grid" style={{ marginBottom: '16px' }}>
            {cards.map(([label, value, tone]) => (
              <div className="metric-card" key={label}>
                <div className="metric-label">{label}</div>
                <div className="metric-value">{money(value)}</div>
                <div className={`metric-sub ${value != null ? tone : ''}`}>
                  {value != null ? `${start} → ${end}` : 'no data'}
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>Profit &amp; Loss</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{loc?.name} · {summaries.length} lines</div>
            </div>
            {summaries.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)', fontSize: '12px' }}>
                No line items returned for this period.
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Section</th><th>Line</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
                  </thead>
                  <tbody>
                    {summaries.map((r, i) => (
                      <tr key={`${r.label}-${i}`}>
                        <td style={{ color: 'var(--text3)' }}>{r.section || '—'}</td>
                        <td className="strong">{r.label}</td>
                        <td style={{ textAlign: 'right' }}>{money(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function Finance() {
  const { isAll, scopeLocations, selectedId } = useLocations();
  if (!isAll) {
    if (!selectedId) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Select a location.</div>;
    return <FinanceView locId={selectedId} />;
  }
  return (
    <div>
      {scopeLocations.map(l => (
        <div key={l.id} style={{ marginBottom: '32px' }}>
          <div className="section-label" style={{ marginBottom: '12px' }}>{l.name}</div>
          <FinanceView locId={l.id} />
        </div>
      ))}
    </div>
  );
}
