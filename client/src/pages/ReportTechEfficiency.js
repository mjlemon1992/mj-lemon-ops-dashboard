import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ReportTechEfficiency() {
  const { api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('mtd');
  const navigate = useNavigate();
  const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;
  const hrsNum = x => (Math.round(num(x) * 10) / 10).toLocaleString();

  useEffect(() => {
    api('/locations').then(locs => {
      setLocations(locs || []);
      const first = (locs || []).find(l => l.active) || (locs || [])[0];
      if (first) setLocId(first.id);
    }).catch(() => {});
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!locId) return;
    setLoading(true);
    api(`/technicians/${locId}?period=${period}`).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, [locId, period]); // eslint-disable-line

  const loc = locations.find(l => l.id === locId);
  const _hidden = new Set(((data && data.hidden) || []).map(h => h.tech_id || h.tech_name));
  const techs = ((data && data.technicians) || []).filter(t => !_hidden.has(t.tech_id || t.tech_name));
  const totalSold = techs.reduce((s, t) => s + num(t.hours_sold), 0);
  const totalWorked = techs.reduce((s, t) => s + num(t.hours_worked), 0);
  const groupEff = totalWorked > 0 ? Math.round((totalSold / totalWorked) * 100) : null;
  const effTarget = num(loc?.efficiency_target) || 80;
  const cell = { padding: '8px 12px', textAlign: 'right' };
  const cellL = { padding: '8px 12px', textAlign: 'left' };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
        <button onClick={() => navigate('/reports')} style={{ fontSize: '12px', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>&larr; Reports</button>
      </div>
      <h2 style={{ fontSize: '20px', margin: '0 0 2px' }}>Technician efficiency</h2>
      <div style={{ fontSize: '12px', color: 'var(--text2)', marginBottom: '16px' }}>{loc ? loc.name : ''} · live from Shopmonkey · sold hours / worked hours</div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <button onClick={() => setPeriod('mtd')} className="badge" style={{ cursor: 'pointer', background: period === 'mtd' ? 'var(--accent)' : 'var(--bg3)', color: period === 'mtd' ? '#000' : 'var(--text2)' }}>This month</button>
        <button onClick={() => setPeriod('ytd')} className="badge" style={{ cursor: 'pointer', background: period === 'ytd' ? 'var(--accent)' : 'var(--bg3)', color: period === 'ytd' ? '#000' : 'var(--text2)' }}>YTD</button>
      </div>

      {loading ? <div style={{ color: 'var(--text3)' }}>Loading…</div> : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '0.5px solid var(--border)', color: 'var(--text3)', fontSize: '11px' }}>
                <th style={cellL}>Technician</th>
                <th style={cell}>Hours sold</th>
                <th style={cell}>Hours worked</th>
                <th style={cell}>Efficiency</th>
              </tr>
            </thead>
            <tbody>
              {techs.map(t => (
                <tr key={t.tech_id || t.tech_name} style={{ borderTop: '0.5px solid var(--border)' }}>
                  <td style={{ ...cellL, color: 'var(--text)', fontWeight: 500 }}>{t.tech_name}</td>
                  <td style={cell}>{hrsNum(t.hours_sold)}</td>
                  <td style={cell}>{t.hours_worked != null ? hrsNum(t.hours_worked) : '\u2014'}</td>
                  <td style={cell}>{t.efficiency != null ? <span style={{ color: t.efficiency >= effTarget ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>{Math.round(t.efficiency)}%</span> : '\u2014'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '0.5px solid var(--border2)', background: 'var(--bg3)' }}>
                <td style={{ ...cellL, fontWeight: 600 }}>Group</td>
                <td style={{ ...cell, fontWeight: 600 }}>{hrsNum(totalSold)}</td>
                <td style={{ ...cell, fontWeight: 600 }}>{hrsNum(totalWorked)}</td>
                <td style={{ ...cell, fontWeight: 600 }}>{groupEff != null ? `${groupEff}%` : '\u2014'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
