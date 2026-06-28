import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';

const money = n => '$' + Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = s => {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
};

function ComebacksView({ locId }) {
  const { api } = useAuth();
  const [data, setData] = useState(null);
  const [revenueCount, setRevenueCount] = useState(null); // for comeback-rate denominator
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!locId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      api(`/sync/${locId}/comebacks`).catch(() => null),
      api(`/metrics/${locId}/summary`).catch(() => null),
    ]).then(([cb, metrics]) => {
      setData(cb);
      setRevenueCount(metrics && metrics.car_count_mtd != null ? metrics.car_count_mtd : null);
      setLoading(false);
    });
  }, [locId]); // eslint-disable-line

  const count = data?.count || 0;
  const hours = data?.total_unbilled_hours || 0;
  const cost = data?.total_unbilled_wage_cost || 0;
  const rows = data?.comebacks || [];
  const byTech = data?.by_tech || [];

  // Comeback rate = comebacks / (comebacks + revenue jobs)
  const totalJobs = revenueCount != null ? revenueCount + count : null;
  const rate = totalJobs && totalJobs > 0 ? (count / totalJobs) * 100 : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: '600', color: 'var(--text)', margin: 0 }}>Comebacks &amp; $0 invoices</h1>
          <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '3px' }}>
            Warranty re-dos, goodwill work and internal tickets — unbilled labour the shop absorbs this month.
          </div>
        </div>
      </div>

      {data?.snapshot_date && (
        <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '16px' }}>
          Snapshot: {new Date(data.snapshot_date).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' })}
        </div>
      )}

      {error && <div className="card" style={{ padding: '14px', color: 'var(--danger)', marginBottom: '12px' }}>{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)' }}>Loading…</div>
      ) : count === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)' }}>
          No comebacks recorded this month ✓
          <div style={{ fontSize: '11px', marginTop: '6px' }}>
            (If you expect some, run the comebacks sync — they refresh on the same schedule as metrics.)
          </div>
        </div>
      ) : (
        <>
          {/* Headline stat cards: the two signals */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '18px' }}>
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Comebacks</div>
              <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--text)', marginTop: '4px' }}>{count}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>this month</div>
            </div>
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Comeback rate</div>
              <div style={{ fontSize: '24px', fontWeight: '600', color: rate != null && rate > 10 ? 'var(--warning)' : 'var(--text)', marginTop: '4px' }}>
                {rate != null ? rate.toFixed(1) + '%' : '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>
                {totalJobs != null ? `${count} of ${totalJobs} jobs` : 'quality signal'}
              </div>
            </div>
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Unbilled hours</div>
              <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--text)', marginTop: '4px' }}>{hours.toFixed(1)}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>labour given away</div>
            </div>
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Cost leakage</div>
              <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--danger)', marginTop: '4px' }}>{money(cost)}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>wage cost of those hours</div>
            </div>
          </div>

          {/* Per-tech rollup */}
          {byTech.length > 0 && (
            <div style={{ marginBottom: '18px' }}>
              <div style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>By technician</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {byTech.map(t => (
                  <div key={t.tech_name} className="card" style={{ padding: '10px 14px', flex: '0 0 auto' }}>
                    <div style={{ fontSize: '12px', fontWeight: '500', color: 'var(--text)' }}>{t.tech_name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>
                      {t.count} {t.count === 1 ? 'job' : 'jobs'} · {Number(t.hours).toFixed(1)}h · {money(t.cost)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Detail list */}
          <div style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>Detail</div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg3)', color: 'var(--text3)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px', fontWeight: '500' }}>RO</th>
                  <th style={{ padding: '8px 12px', fontWeight: '500' }}>Invoiced</th>
                  <th style={{ padding: '8px 12px', fontWeight: '500' }}>Customer / Vehicle</th>
                  <th style={{ padding: '8px 12px', fontWeight: '500' }}>Tech</th>
                  <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Hours</th>
                  <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Wage cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.order_id || i} style={{ borderTop: '0.5px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{r.order_number ? '#' + r.order_number : '—'}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--text3)' }}>{fmtDate(r.invoiced_date)}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--text)' }}>
                      <div>{r.customer_name || '—'}</div>
                      {r.vehicle_name && <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{r.vehicle_name}</div>}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{r.tech_name || 'Unassigned'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text2)' }}>{Number(r.labour_hours || 0).toFixed(1)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text2)' }}>{money(r.unbilled_wage_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>
            Note: these orders are invoiced at $0, so they're correctly excluded from revenue, parts-margin and PPH.
            This page exists so that unbilled work stays visible rather than disappearing.
          </div>
        </>
      )}
    </div>
  );
}

export default function Comebacks() {
  const { isAll, scopeLocations, selectedId } = useLocations();
  if (!isAll) {
    if (!selectedId) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Select a location.</div>;
    return <ComebacksView locId={selectedId} />;
  }
  return (
    <div>
      {scopeLocations.map(l => (
        <div key={l.id} style={{ marginBottom: '32px' }}>
          <div className="section-label" style={{ marginBottom: '12px' }}>{l.name}</div>
          <ComebacksView locId={l.id} />
        </div>
      ))}
    </div>
  );
}
