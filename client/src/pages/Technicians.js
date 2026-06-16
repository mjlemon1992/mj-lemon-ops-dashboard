import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const money0 = n => '$' + Math.round(num(n)).toLocaleString('en-CA');
const hrsNum = n => (Math.round(num(n) * 10) / 10).toLocaleString('en-CA');

export default function Technicians() {
  const { user, api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const showFinancials = user?.role !== 'manager';

  useEffect(() => {
    api('/locations').then(locs => {
      const active = locs.filter(l => l.active);
      setLocations(active.length ? active : locs);
      const first = active[0] || locs[0];
      if (first) setLocId(first.id);
      else setLoading(false);
    }).catch(() => { setError('Could not load locations'); setLoading(false); });
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!locId) return;
    setLoading(true); setError(null);
    api(`/technicians/${locId}`).then(d => { setData(d); setLoading(false); })
      .catch(err => { setError(err.message || 'Could not load technicians'); setLoading(false); });
  }, [locId]); // eslint-disable-line

  const techs = (data && data.technicians) || [];
  const count = data?.count ?? 0;
  const hasHours = !!(data && data.has_hours);
  const totalSold = techs.reduce((s, t) => s + num(t.hours_sold), 0);
  const totalBilled = techs.reduce((s, t) => s + num(t.hours_billed), 0);
  const totalRev = techs.reduce((s, t) => s + num(t.labour_revenue), 0);
  const totalVehicles = techs.reduce((s, t) => s + num(t.vehicle_count), 0);

  const cols = showFinancials ? 6 : 5;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: '600', color: 'var(--text)', margin: 0 }}>Technicians</h1>
          <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '3px' }}>
            Live roster pulled from Shopmonkey. Add or remove techs in Shopmonkey and this follows on the next sync &mdash; no manual list to maintain.
          </div>
        </div>
        {locations.length > 1 && (
          <select value={locId || ''} onChange={e => setLocId(e.target.value)} style={{ fontSize: '12px' }}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
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
                  <tr key={t.tech_id || t.tech_name} style={{ borderTop: '0.5px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text)' }} className="strong">{t.tech_name}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: t.hours_sold != null ? 'var(--text)' : 'var(--text3)' }}>{t.hours_sold != null ? hrsNum(t.hours_sold) : '\u2014'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: t.hours_billed != null ? 'var(--text)' : 'var(--text3)' }}>{t.hours_billed != null ? hrsNum(t.hours_billed) : '\u2014'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: t.vehicle_count != null ? 'var(--text)' : 'var(--text3)' }}>{t.vehicle_count != null ? t.vehicle_count : '\u2014'}</td>
                    {showFinancials && <td style={{ padding: '8px 12px', textAlign: 'right', color: t.labour_revenue != null ? 'var(--text)' : 'var(--text3)' }}>{t.labour_revenue != null ? money0(t.labour_revenue) : '\u2014'}</td>}
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text3)' }}>awaiting payroll</td>
                  </tr>
                ))}
              </tbody>
              {techs.length > 0 && hasHours && (
                <tfoot>
                  <tr style={{ borderTop: '0.5px solid var(--border2)', background: 'var(--bg3)' }}>
                    <td style={{ padding: '8px 12px' }} className="strong">Group total</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }} className="strong">{hrsNum(totalSold)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }} className="strong">{hrsNum(totalBilled)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text3)' }} className="strong">{'\u2014'}</td>
                    {showFinancials && <td style={{ padding: '8px 12px', textAlign: 'right' }} className="strong">{money0(totalRev)}</td>}
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text3)' }}>&mdash;</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>
            Hours sold = booked on tickets; hours billed = completed lines. The gap is labour discounted down (road tests, multi-checks, goodwill). Labour revenue is pre-tax, after discounts. Efficiency and profit/hour need clocked hours from payroll (QBO Time), which connects at close. Multi-tech jobs attribute each labour line to the tech who performed it, matching Shopmonkey&rsquo;s per-technician report.
          </div>
        </>
      )}
    </div>
  );
}
