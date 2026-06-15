import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const TECHS = [
  { name: 'John Smith', avail: 160, worked: 160, sold: 144, wage: 45, labRev: 24480, partsGP: 11020 },
  { name: 'Mike Jones', avail: 160, worked: 160, sold: 116, wage: 40, labRev: 19720, partsGP: 8880 },
  { name: 'Dave Wilson', avail: 160, worked: 160, sold: 138, wage: 42, labRev: 23460, partsGP: 10560 },
  { name: 'Chris Brown', avail: 160, worked: 152, sold: 122, wage: 40, labRev: 20740, partsGP: 9330 },
  { name: 'Tom Harris', avail: 160, worked: 160, sold: 128, wage: 38, labRev: 21760, partsGP: 9790 },
];

function techEff(t) { return Math.round(t.sold / t.worked * 100); }
function techPPH(t) { return Math.round((t.labRev - t.wage * t.worked + t.partsGP) / t.worked); }

export default function Performance() {
  const { user, api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [period, setPeriod] = useState('month');

  useEffect(() => { api('/locations').then(setLocations).catch(() => {}); }, []);

  const avgEff = Math.round(TECHS.reduce((s, t) => s + techEff(t), 0) / TECHS.length);
  const groupPPH = Math.round(TECHS.reduce((s, t) => s + (t.labRev - t.wage * t.worked + t.partsGP), 0) / TECHS.reduce((s, t) => s + t.worked, 0));
  const showFinancials = user?.role !== 'manager';

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <select style={{ width: 'auto' }}>
          {locations.map(l => <option key={l.id}>{l.name}</option>)}
          {locations.length === 0 && <option>Hwy 97 Mister Transmission</option>}
        </select>
        <select value={period} onChange={e => setPeriod(e.target.value)} style={{ width: 'auto' }}>
          <option value="month">This month</option>
          <option value="week">This week</option>
          <option value="today">Today</option>
        </select>
      </div>

      <div style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>Profit per hour</div>
          <div style={{ fontSize: '30px', fontWeight: '500', color: 'var(--text)' }}>${groupPPH}<span style={{ fontSize: '13px', color: 'var(--text3)', fontWeight: '400' }}>/hr</span></div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>vs $254 target</div>
          <div style={{ fontSize: '14px', color: 'var(--warning)', fontWeight: '500' }}>-${254 - groupPPH}/hr</div>
          <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{Math.round(groupPPH/254*100)}% of target</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>Group efficiency</div>
          <div style={{ fontSize: '30px', fontWeight: '500', color: 'var(--text)' }}>{avgEff}%</div>
          <div style={{ fontSize: '11px', color: 'var(--success)' }}>above 80% target ✓</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '16px' }}>
        <div className="metric-card"><div className="metric-label">Revenue</div><div className="metric-value">$187,420</div><div className="metric-sub warn">vs $190,250 — -1.5%</div></div>
        {showFinancials && <div className="metric-card"><div className="metric-label">Total profit</div><div className="metric-value">$89,140</div><div className="metric-sub good">47.6% margin</div></div>}
        <div className="metric-card"><div className="metric-label">Parts margin</div><div className="metric-value">54.2%</div><div className="metric-sub warn">vs 55% target ⚠</div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
        <div className="card">
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '12px' }}>Metrics vs target</div>
          {[
            ['Car count', '96 / 97', '99% ✓', true],
            ['Parts margin', '54.2%', 'vs 55% ⚠', false],
            ['Labour margin', '71.4%', 'vs 70% ✓', true],
            ['Avg RO value', '$1,952', 'vs $1,961 ✓', true],
            ['Labour hours sold', '464', 'vs 472 target', false],
          ].map(([l,a,t,ok]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text2)' }}>{l}</div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>{a}</div>
                <div style={{ fontSize: '11px', color: ok ? 'var(--success)' : 'var(--warning)' }}>{t}</div>
              </div>
            </div>
          ))}
        </div>
        {showFinancials && (
          <div className="card">
            <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '12px' }}>Revenue split</div>
            {[
              ['Labour revenue', '$78,960', '42.1%'],
              ['Parts revenue', '$105,240', '56.2%'],
              ['Parts COGS', '$47,358', '45% of parts'],
              ['Tech wages', '$22,480', 'payroll MTD'],
              ['Shop supplies', '$3,220', '1.7%'],
            ].map(([l,a,t]) => (
              <div key={l} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: '12px', color: 'var(--text2)' }}>{l}</div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>{a}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{t}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '14px' }}>Technician efficiency & profit per hour</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Technician</th>
                <th>Available</th>
                <th>Worked</th>
                <th>Sold</th>
                <th>Efficiency</th>
                <th>Profit/hr</th>
              </tr>
            </thead>
            <tbody>
              {TECHS.map(t => {
                const eff = techEff(t);
                const pph = techPPH(t);
                const effOk = eff >= 80;
                const pphOk = pph >= 254;
                return (
                  <tr key={t.name}>
                    <td className="strong">{t.name}</td>
                    <td>{t.avail} hrs</td>
                    <td>{t.worked} hrs</td>
                    <td>{t.sold} hrs</td>
                    <td>
                      <span style={{ color: effOk ? 'var(--success)' : 'var(--warning)', fontWeight: '500' }}>{eff}%</span>
                      <span className="eff-bar"><span className="eff-fill" style={{ width: `${Math.min(eff, 100)}%`, background: effOk ? 'var(--success)' : 'var(--warning)' }}></span></span>
                    </td>
                    <td style={{ fontWeight: '500', color: pphOk ? 'var(--success)' : 'var(--warning)' }}>${pph}/hr</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '0.5px solid var(--border2)' }}>
                <td className="strong">Group average</td>
                <td>800 hrs</td>
                <td>{TECHS.reduce((s,t)=>s+t.worked,0)} hrs</td>
                <td>{TECHS.reduce((s,t)=>s+t.sold,0)} hrs</td>
                <td style={{ fontWeight: '500', color: avgEff >= 80 ? 'var(--success)' : 'var(--warning)' }}>{avgEff}%</td>
                <td style={{ fontWeight: '500', color: groupPPH >= 254 ? 'var(--success)' : 'var(--warning)' }}>${groupPPH}/hr</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
