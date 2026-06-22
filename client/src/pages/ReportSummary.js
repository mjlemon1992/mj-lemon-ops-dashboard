import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const PERIODS = {
  weekly: { title: 'Weekly summary', blurb: 'Revenue, car count, and margins for the current month to date.' },
  'mid-month': { title: 'Mid month summary', blurb: 'MTD pace against your monthly targets.' },
  'end-of-month': { title: 'End of month', blurb: 'Full month performance vs target.' },
};

export default function ReportSummary() {
  const { api } = useAuth();
  const { kind } = useParams();
  const navigate = useNavigate();
  const meta = PERIODS[kind] || PERIODS.weekly;
  const [locations, setLocations] = useState([]);
  const [metrics, setMetrics] = useState({});
  const [loading, setLoading] = useState(true);
  const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;
  const money0 = v => '$' + Math.round(num(v)).toLocaleString();

  useEffect(() => {
    api('/locations').then(locs => {
      setLocations(locs || []);
      return Promise.all((locs || []).map(loc =>
        api(`/metrics/${loc.id}/summary`).then(m => setMetrics(prev => ({ ...prev, [loc.id]: m }))).catch(() => {})
      ));
    }).then(() => setLoading(false)).catch(() => setLoading(false));
  }, []); // eslint-disable-line

  const rows = locations.map(loc => ({ loc, m: metrics[loc.id] })).filter(r => r.m);
  const cell = { padding: '8px 12px', textAlign: 'right' };
  const cellL = { padding: '8px 12px', textAlign: 'left' };

  return (
    <div>
      <button onClick={() => navigate('/reports')} style={{ fontSize: '12px', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>&larr; Reports</button>
      <h2 style={{ fontSize: '20px', margin: '4px 0 2px' }}>{meta.title}</h2>
      <div style={{ fontSize: '12px', color: 'var(--text2)', marginBottom: '16px' }}>{meta.blurb} · live from Shopmonkey</div>
      {loading ? <div style={{ color: 'var(--text3)' }}>Loading…</div> : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '0.5px solid var(--border)', color: 'var(--text3)', fontSize: '11px' }}>
                <th style={cellL}>Location</th><th style={cell}>Revenue MTD</th><th style={cell}>Cars</th>
                <th style={cell}>Parts margin</th><th style={cell}>Labour margin</th><th style={cell}>Avg RO</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ loc, m }) => (
                <tr key={loc.id} style={{ borderTop: '0.5px solid var(--border)' }}>
                  <td style={{ ...cellL, color: 'var(--text)', fontWeight: 500 }}>{loc.name}</td>
                  <td style={cell}>{money0(m.revenue_mtd)}</td>
                  <td style={cell}>{num(m.car_count_mtd)}</td>
                  <td style={cell}>{num(m.parts_margin).toFixed(1)}%</td>
                  <td style={cell}>{num(m.labour_margin).toFixed(1)}%</td>
                  <td style={cell}>{money0(m.avg_ro_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
