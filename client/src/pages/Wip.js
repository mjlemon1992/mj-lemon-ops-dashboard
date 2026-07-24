import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s) => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); };

function WipView({ locId }) {
  const { api } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

useEffect(() => { if (!locId) return; setLoading(true); setError(null); api(`/sync/${locId}/wip`).then((d) => setData(d)).catch((e) => setError(String(e))).finally(() => setLoading(false)); }, [locId]);

const totalCount = (data && data.total_count) || 0;
  const totalValue = (data && data.total_value) || 0;
  const activeCount = (data && data.active_count) || 0;
  const activeValue = (data && data.active_value) || 0;
  const agingCount = (data && data.aging_count) || 0;
  const agingValue = (data && data.aging_value) || 0;
  const byStage = (data && data.by_stage) || [];
  const active = (data && data.active) || [];
  const aging = (data && data.aging) || [];
  const agingDays = (data && data.aging_days) || 14;

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px 18px' };
  const label = { fontSize: 'var(--fz-label)', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.04em' };
  const big = { fontSize: '24px', fontWeight: '600', color: 'var(--text)', marginTop: '4px' };
  const sub = { fontSize: 'var(--fz-label)', color: 'var(--text3)', marginTop: '3px' };
  const th = { padding: '8px 12px', fontSize: 'var(--fz-label)', color: 'var(--text3)', textTransform: 'uppercase', textAlign: 'left' };
  const td = { padding: '8px 12px', color: 'var(--text2)', fontSize: 'var(--fz-body)' };

const renderRows = (rows, agingView) => (rows.length === 0 ? (<tr><td colSpan={5} style={{ ...td, color: 'var(--text3)', padding: '14px 12px' }}>None ✓</td></tr>) : rows.map((r) => (<tr key={r.order_number} style={{ borderTop: '1px solid var(--border)' }}><td style={{ ...td, color: 'var(--text)' }}>#{r.order_number}</td><td style={td}>{r.stage}</td><td style={{ ...td, textAlign: 'right', color: 'var(--text)' }}>{money(r.subtotal)}</td><td style={{ ...td, color: 'var(--text3)' }}>{fmtDate(r.authorized_date)}</td><td style={{ ...td, textAlign: 'right', color: agingView && r.age_days > 30 ? 'var(--danger, #d9534f)' : 'var(--text2)' }}>{r.age_days}d</td></tr>)));

return (
  <div>
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
<div>
<div style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)', marginTop: '3px' }}>Authorized work not yet invoiced — potential revenue on the floor (pre-tax)</div>
  </div>
  </div>
                                                                                                                {loading && <div style={{ color: 'var(--text3)', fontSize: 'var(--fz-body)', padding: '20px 0' }}>Loading…</div>}
{error && <div style={{ color: 'var(--danger, #d9534f)', fontSize: 'var(--fz-body)', padding: '20px 0' }}>{error}</div>}
{!loading && !error && (<>
{!(data && data.cached) && (<div style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)', margin: '10px 0' }}>No committed WIP cached yet — run a sync to populate.</div>)}
<div className="stat-grid" style={{ margin: '14px 0' }}>
<div style={card}><div style={label}>Total committed</div><div style={big}>{money(totalValue)}</div><div style={sub}>{totalCount} orders authorized, not invoiced</div></div>
  <div style={card}><div style={label}>Active (≤{agingDays}d)</div><div style={big}>{money(activeValue)}</div><div style={sub}>{activeCount} fresh pipeline</div></div>
  <div style={card}><div style={label}>Aging (&gt;{agingDays}d)</div><div style={{ ...big, color: agingCount ? 'var(--danger, #d9534f)' : 'var(--text)' }}>{money(agingValue)}</div><div style={sub}>{agingCount} need a chase</div></div>
  </div>
{byStage.length > 0 && (<div style={{ ...card, padding: 0, marginBottom: '14px' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Stage</th><th style={{ ...th, textAlign: 'right' }}>Orders</th><th style={{ ...th, textAlign: 'right' }}>Committed $</th></tr></thead><tbody>{byStage.map((s) => (<tr key={s.stage} style={{ borderTop: '1px solid var(--border)' }}><td style={{ ...td, color: 'var(--text)' }}>{s.stage}</td><td style={{ ...td, textAlign: 'right' }}>{s.count}</td><td style={{ ...td, textAlign: 'right', color: 'var(--text)' }}>{money(s.total)}</td></tr>))}</tbody></table></div>)}
<div style={{ ...card, padding: 0, marginBottom: '14px' }}>
<div style={{ padding: '12px 12px 4px', fontSize: 'var(--fz-body)', fontWeight: '600', color: 'var(--text)' }}>Aging chase list ({agingCount})</div>
<table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Order</th><th style={th}>Stage</th><th style={{ ...th, textAlign: 'right' }}>Pre-tax $</th><th style={th}>Auth</th><th style={{ ...th, textAlign: 'right' }}>Age</th></tr></thead><tbody>{renderRows(aging, true)}</tbody></table>
  </div>
<div style={{ ...card, padding: 0 }}>
<div style={{ padding: '12px 12px 4px', fontSize: 'var(--fz-body)', fontWeight: '600', color: 'var(--text)' }}>Active pipeline ({activeCount})</div>
<table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Order</th><th style={th}>Stage</th><th style={{ ...th, textAlign: 'right' }}>Pre-tax $</th><th style={th}>Auth</th><th style={{ ...th, textAlign: 'right' }}>Age</th></tr></thead><tbody>{renderRows(active, false)}</tbody></table>
  </div>
{data && data.synced_at && (<div style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)', marginTop: '10px' }}>Synced {new Date(data.synced_at).toLocaleString('en-CA')}</div>)}
  </>)}
  </div>
);
}

export default function Wip() {
  const { isAll, scopeLocations, selectedId } = useLocations();
  if (!isAll) {
    if (!selectedId) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Select a location.</div>;
    return <WipView locId={selectedId} />;
  }
  return (
    <div>
      {scopeLocations.map(l => (
        <div key={l.id} style={{ marginBottom: '32px' }}>
          <div className="section-label" style={{ marginBottom: '12px' }}>{l.name}</div>
          <WipView locId={l.id} />
        </div>
      ))}
    </div>
  );
}
