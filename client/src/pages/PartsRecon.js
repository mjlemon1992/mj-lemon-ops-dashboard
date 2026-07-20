import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import PerLocationPage from '../components/PerLocationPage';
import { money } from '../utils/format';
import { Skeleton } from '../components/Feedback';

// Parts reconciliation — v1a: ShopMonkey parts margin / exposure per RO.
// A worklist of parts paid for but not (fully) billed, worst first. The
// vendor-invoice reconciliation (three-way check) layers on in v1b.
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '—';
const CLASS = {
  leak: { label: 'LEAK', color: 'var(--danger)', bg: 'rgba(255,77,77,0.12)' },
  under_billed: { label: 'UNDER-BILLED', color: 'var(--warning)', bg: 'rgba(255,184,0,0.12)' },
  bundled: { label: 'BUNDLED', color: 'var(--text2)', bg: 'var(--bg3)' },
};
const th = { padding: '8px 12px', fontWeight: 500 };
const td = { padding: '8px 12px' };

export default function PartsRecon() {
  return <PerLocationPage>{(locId) => <PartsView locId={locId} />}</PerLocationPage>;
}

function PartsView({ locId }) {
  const { api } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');

  const load = useCallback((fresh) => {
    setBusy(true);
    api(`/parts/${locId}/margin${fresh ? '?fresh=1' : ''}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [api, locId]);
  useEffect(() => { load(); }, [load]);

  if (err && !data) return <div className="card" style={{ color: 'var(--danger)' }}>{err}</div>;
  if (!data) return <Skeleton rows={6} height={18} />;
  if (data.connected === false) return <div className="card" style={{ color: 'var(--text3)', textAlign: 'center', padding: '32px' }}>{data.message}</div>;

  const s = data.summary;
  const items = filter === 'all' ? data.items : data.items.filter((i) => i.class === filter);
  const Tile = ({ label, val, color }) => (
    <div className="metric-card"><div className="metric-label">{label}</div><div className="metric-value" style={color ? { color } : {}}>{val}</div></div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '12px', color: 'var(--text3)' }}>
          Parts paid vs billed · this month · {data.orders_scanned} invoiced order{data.orders_scanned === 1 ? '' : 's'} scanned
          {data.capped ? ` (capped ${data.orders_scanned}/${data.orders_total})` : ''}
          {data.service_fetch_failed ? ` · ${data.service_fetch_failed} skipped` : ''}
        </div>
        <button onClick={() => load(true)} disabled={busy} style={{ fontSize: '12px', padding: '6px 14px' }}>{busy ? 'Scanning…' : 'Refresh'}</button>
      </div>

      <div className="stat-grid" style={{ marginBottom: '16px' }}>
        <Tile label="Leak exposure" val={money(s.leak_exposure)} color={s.leak_exposure > 0 ? 'var(--danger)' : undefined} />
        <Tile label="Under-billed" val={money(s.underbilled_exposure)} color={s.underbilled_exposure > 0 ? 'var(--warning)' : undefined} />
        <Tile label="Leaks / under-billed" val={`${s.leak_count} / ${s.underbilled_count}`} />
        <Tile label="Parts checked" val={s.parts} />
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
        {[['all', `All flagged (${data.items.length})`], ['leak', `Leaks (${s.leak_count})`], ['under_billed', `Under-billed (${s.underbilled_count})`], ['bundled', `Bundled (${s.bundled_count})`]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} className={filter === k ? 'primary' : ''} style={{ fontSize: '12px', padding: '5px 12px' }}>{l}</button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="card" style={{ color: 'var(--text3)', textAlign: 'center', padding: '24px' }}>Nothing in this bucket this month. 🎉</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg3)', color: 'var(--text3)', textAlign: 'left' }}>
                  <th style={th}>RO</th><th style={th}>Inv</th><th style={th}>Part</th><th style={th}>Service</th>
                  <th style={{ ...th, textAlign: 'right' }}>Qty</th><th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...th, textAlign: 'right' }}>Billed</th><th style={{ ...th, textAlign: 'right' }}>Margin</th>
                  <th style={th}>Flag</th><th style={{ ...th, textAlign: 'right' }}>Exposure</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => {
                  const c = CLASS[r.class] || CLASS.bundled;
                  return (
                    <tr key={i} style={{ borderTop: '0.5px solid var(--border)' }}>
                      <td style={td}>{r.order_number}</td>
                      <td style={{ ...td, color: 'var(--text3)' }}>{fmtDate(r.invoiced_date)}</td>
                      <td style={td}><div style={{ fontWeight: 600 }}>{r.part_name}</div>{r.part_number && <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{r.part_number}</div>}</td>
                      <td style={{ ...td, color: 'var(--text2)' }}>{r.service || '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{r.qty}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(r.cost)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(r.retail)}</td>
                      <td style={{ ...td, textAlign: 'right', color: r.margin_pct == null ? 'var(--text3)' : r.margin_pct < 0 ? 'var(--danger)' : 'var(--text2)' }}>{r.margin_pct == null ? '—' : `${r.margin_pct}%`}</td>
                      <td style={td}><span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '10px', color: c.color, background: c.bg, whiteSpace: 'nowrap' }}>{c.label}</span></td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: r.exposure > 0 ? c.color : 'var(--text3)' }}>{r.exposure > 0 ? money(r.exposure) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>
        <b>Leak</b> = paid for, $0 billed, not on a flat-rate job. <b>Under-billed</b> = billed below cost. <b>Bundled</b> = $0 part inside a lump-sum/flat-rate service (normal — shown for review). {data.cached ? 'Cached' : 'Fresh'} as of {new Date(data.generated_at).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}.
      </div>
    </div>
  );
}
