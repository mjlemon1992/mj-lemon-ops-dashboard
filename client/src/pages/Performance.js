import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const money0 = n => '$' + Math.round(num(n)).toLocaleString('en-CA');
const hrsNum = n => (Math.round(num(n) * 10) / 10).toLocaleString('en-CA');

export default function Performance() {
  const { user, api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [target, setTarget] = useState(null);
  const [techData, setTechData] = useState(null);
  const [loading, setLoading] = useState(true);

  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  useEffect(() => {
    api('/locations').then(locs => {
      setLocations(locs);
      const active = locs.filter(l => l.active);
      const first = active[0] || locs[0];
      if (first) setLocId(first.id);
      else setLoading(false);
    }).catch(() => setLoading(false));
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!locId) return;
    setLoading(true);
    Promise.all([
      api(`/metrics/${locId}/summary`).catch(() => null),
      api(`/technicians/${locId}`).catch(() => null),
      api(`/targets/${locId}/${year}`).catch(() => []),
    ]).then(([m, t, tg]) => {
      setMetrics(m);
      setTechData(t);
      setTarget(Array.isArray(tg) ? (tg.find(r => r.month === month) || null) : null);
      setLoading(false);
    });
  }, [locId]); // eslint-disable-line

  const loc = locations.find(l => l.id === locId);
  const showFinancials = user?.role !== 'manager';

  if (loading) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading&hellip;</div>;

  const hasMetrics = !!metrics && num(metrics.revenue_mtd) > 0;
  const revenue = num(metrics?.revenue_mtd);
  const profit = num(metrics?.total_profit);
  const profitMargin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const partsMargin = num(metrics?.parts_margin);
  const labourMargin = num(metrics?.labour_margin);
  const carCount = num(metrics?.car_count_mtd);
  const avgRO = num(metrics?.avg_ro_value);
  const labourHoursSold = num(metrics?.labour_hours_sold);
  const labourHoursWorked = num(metrics?.labour_hours_worked);
  const labourHoursComped = num(metrics?.labour_hours_comped);
  const pph = num(metrics?.pph);
  const efficiency = metrics?.efficiency_avg == null ? null : num(metrics.efficiency_avg);
  const labourRate = num(loc?.labour_rate) || 170;
  // Real net labour revenue from Shopmonkey (rate-aware: handles $170/$200 mix).
  // Falls back to hours*rate only if the field isn't present yet.
  const labourRevenue = metrics?.labour_revenue != null ? num(metrics.labour_revenue) : labourHoursSold * labourRate;
  const partsOtherRevenue = revenue - labourRevenue;

  const pphTarget = num(loc?.pph_target) || 254;
  const effTarget = num(loc?.efficiency_target) || 80;
  const pmTarget = num(loc?.parts_margin_target) || 55;
  const _now = new Date();
  const _daysInMonth = new Date(_now.getFullYear(), _now.getMonth() + 1, 0).getDate();
  const _paceFrac = _now.getDate() / _daysInMonth;
  const pacePct = (actual, tgt) => { if (!tgt || tgt <= 0 || !actual) return null; const e = tgt * _paceFrac; return e > 0 ? Math.round((actual / e) * 100) : null; };
  const targetPct = (actual, tgt) => { if (!tgt || tgt <= 0 || !actual) return null; return Math.round((actual / tgt) * 100); };

  const techs = (techData && techData.technicians) || [];
  const techCount = techData?.count ?? (loc ? loc.num_technicians : 0);
  const hasHours = !!(techData && techData.has_hours);
  const totalSold = techs.reduce((s, t) => s + num(t.hours_sold), 0);
  const totalBilled = techs.reduce((s, t) => s + num(t.hours_billed), 0);
  const totalVehicles = techs.reduce((s, t) => s + num(t.vehicle_count), 0);
  const distinctVehicles = techData && techData.distinct_vehicles_mtd != null ? techData.distinct_vehicles_mtd : null;
  const totalLabRev = techs.reduce((s, t) => s + num(t.labour_revenue), 0);

  const metricsVsTarget = [
    ['Car count', hasMetrics ? (String(carCount) + (target && target.car_count ? ` / ${target.car_count}` : '')) : '\u2014', (target && target.car_count) ? `${pacePct(carCount, num(target.car_count))}% of pace` : 'this month', (target && target.car_count) ? pacePct(carCount, num(target.car_count)) >= 90 : true],
    ['Parts margin', partsMargin > 0 ? `${partsMargin.toFixed(1)}%` : '\u2014', `vs ${pmTarget}%`, partsMargin >= pmTarget],
    ['Labour margin', labourMargin > 0 ? `${labourMargin.toFixed(1)}%` : '\u2014', target && target.labour_margin ? `vs ${num(target.labour_margin)}%` : 'vs 70%', labourMargin >= num((target && target.labour_margin) || 70)],
    ['Avg RO value', avgRO > 0 ? money0(avgRO) : '\u2014', (target && target.avg_ro_value) ? `${targetPct(avgRO, num(target.avg_ro_value))}% of target` : 'per car', target && target.avg_ro_value ? avgRO >= num(target.avg_ro_value) : true],
    ['Labour hours billed', labourHoursSold > 0 ? hrsNum(labourHoursSold) : '\u2014', labourHoursComped > 0 ? `${hrsNum(labourHoursWorked)} worked, ${hrsNum(labourHoursComped)} comped` : 'this month', target && target.labour_hours ? labourHoursSold >= num(target.labour_hours) : true],
    ['Efficiency', efficiency != null && efficiency > 0 ? `${Math.round(efficiency)}%` : '\u2014', efficiency != null && efficiency > 0 ? `vs ${effTarget}%` : 'pending QBO Time', efficiency != null ? efficiency >= effTarget : true],
  ];

  const profitRows = [
    ['Total profit', hasMetrics ? money0(profit) : '\u2014', `${profitMargin.toFixed(1)}% margin`],
    ['Labour revenue', hasMetrics ? money0(labourRevenue) : '\u2014', 'billed, pre-tax'],
    ['Parts & other revenue', hasMetrics ? money0(partsOtherRevenue) : '\u2014', 'revenue \u2212 labour'],
    ['Labour hours billed', labourHoursSold > 0 ? hrsNum(labourHoursSold) : '\u2014', 'revenue-generating lines'],
    ['Labour hours comped', labourHoursComped > 0 ? hrsNum(labourHoursComped) : '\u2014', 'discounted to $0 (give-away)'],
    ['Profit per hour', pph > 0 ? `$${Math.round(pph)}` : '\u2014', 'billed-hours basis'],
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        {locations.length > 1 ? (
          <select value={locId || ''} onChange={e => setLocId(e.target.value)} style={{ width: 'auto' }}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>{loc?.name || 'Location'}</div>
        )}
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>This month &middot; {hasMetrics ? 'live from Shopmonkey \u00b7 pre-tax' : 'awaiting sync'}</div>
      </div>

      <div style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>Profit per hour</div>
          <div style={{ fontSize: '30px', fontWeight: '500', color: 'var(--text)' }}>{pph > 0 ? `$${Math.round(pph)}` : '\u2014'}<span style={{ fontSize: '13px', color: 'var(--text3)', fontWeight: '400' }}>/hr</span></div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>vs ${pphTarget} target</div>
          {pph > 0 ? (
            <>
              <div style={{ fontSize: '14px', color: pph >= pphTarget ? 'var(--success)' : 'var(--warning)', fontWeight: '500' }}>{pph >= pphTarget ? '+' : '-'}${Math.abs(Math.round(pphTarget - pph))}/hr</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{Math.round(pph / pphTarget * 100)}% of target</div>
            </>
          ) : <div style={{ fontSize: '12px', color: 'var(--text3)' }}>awaiting sync</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>Group efficiency</div>
          <div style={{ fontSize: '30px', fontWeight: '500', color: 'var(--text)' }}>{efficiency != null && efficiency > 0 ? `${Math.round(efficiency)}%` : '\u2014'}</div>
          <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{efficiency != null && efficiency > 0 ? (efficiency >= effTarget ? `above ${effTarget}% target \u2713` : `below ${effTarget}% target`) : 'pending QBO Time'}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '16px' }}>
        <div className="metric-card">
          <div className="metric-label">Revenue MTD (pre-tax)</div>
          <div className="metric-value">{hasMetrics ? money0(revenue) : '\u2014'}</div>
          <div className="metric-sub">{(hasMetrics && target && target.revenue) ? `${pacePct(revenue, num(target.revenue))}% of pace` : (target && target.revenue ? `vs $${Math.round(num(target.revenue) / 1000)}k target` : (hasMetrics ? 'live from Shopmonkey' : 'awaiting sync'))}</div>
        </div>
        {showFinancials && (
          <div className="metric-card">
            <div className="metric-label">Total profit</div>
            <div className="metric-value">{hasMetrics ? money0(profit) : '\u2014'}</div>
            <div className={`metric-sub ${profitMargin > 0 ? 'good' : ''}`}>{hasMetrics ? `${profitMargin.toFixed(1)}% margin` : 'awaiting sync'}</div>
          </div>
        )}
        <div className="metric-card">
          <div className="metric-label">Parts margin</div>
          <div className="metric-value">{partsMargin > 0 ? `${partsMargin.toFixed(1)}%` : '\u2014'}</div>
          <div className={`metric-sub ${partsMargin >= pmTarget ? 'good' : 'warn'}`}>{partsMargin > 0 ? (partsMargin >= pmTarget ? `above ${pmTarget}% target \u2713` : `vs ${pmTarget}% target \u26a0`) : 'awaiting sync'}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: showFinancials ? '1fr 1fr' : '1fr', gap: '12px', marginBottom: '16px' }}>
        <div className="card">
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '12px' }}>Metrics vs target</div>
          {metricsVsTarget.map(([l, a, t, ok]) => (
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
            <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '12px' }}>Profit &amp; labour</div>
            {profitRows.map(([l, a, t]) => (
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>Technicians ({techCount})</div>
          <div style={{ fontSize: '11px', color: 'var(--text3)' }}>live roster from Shopmonkey</div>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '12px' }}>
          Hours sold = booked on tickets; hours billed = completed lines. The gap is labour discounted down (road tests, multi-checks). Hours billed counts only revenue-generating lines, so the gap is labour discounted to $0. Worked hours, efficiency and profit/hour need clocked time (QBO Time) &mdash; connecting at close.
        </div>
        {techs.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)', fontSize: '12px' }}>
            {techData && techData.roster_error ? `Roster unavailable: ${techData.roster_error}` : 'No technicians returned from Shopmonkey yet.'}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Technician</th>
                  <th>Hours sold</th>
                  <th>Hours billed</th>
                  <th>Vehicles</th>
                  {showFinancials && <th>Labour revenue</th>}
                  <th>Efficiency</th>
                </tr>
              </thead>
              <tbody>
                {techs.map(t => (
                  <tr key={t.tech_id || t.tech_name}>
                    <td className="strong">{t.tech_name}</td>
                    <td>{t.hours_sold != null ? hrsNum(t.hours_sold) : <span style={{ color: 'var(--text3)' }}>{'\u2014'}</span>}</td>
                    <td>{t.hours_billed != null ? hrsNum(t.hours_billed) : <span style={{ color: 'var(--text3)' }}>{'\u2014'}</span>}</td>
                    <td>{t.vehicle_count != null ? t.vehicle_count : <span style={{ color: 'var(--text3)' }}>{'\u2014'}</span>}</td>
                    {showFinancials && <td>{t.labour_revenue != null ? money0(t.labour_revenue) : <span style={{ color: 'var(--text3)' }}>{'\u2014'}</span>}</td>}
                    <td style={{ color: 'var(--text3)' }}>awaiting payroll</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '0.5px solid var(--border2)' }}>
                  <td className="strong">Group total</td>
                  <td className="strong">{hasHours ? hrsNum(totalSold) : '\u2014'}</td>
                  <td className="strong">{hasHours ? hrsNum(totalBilled) : '\u2014'}</td>
                  <td className="strong">{distinctVehicles != null ? distinctVehicles : '\u2014'}</td>
                  {showFinancials && <td className="strong">{hasHours ? money0(totalLabRev) : '\u2014'}</td>}
                  <td style={{ color: 'var(--text3)' }}>{'\u2014'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {!hasHours && techs.length > 0 && (
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>
            Roster is live. Per-tech figures populate after the next tech sync (same schedule as metrics).
          </div>
        )}
      </div>
    </div>
  );
}
