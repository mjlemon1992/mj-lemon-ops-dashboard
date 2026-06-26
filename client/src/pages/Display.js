import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';

const TWO_HOURS = 2 * 60 * 60 * 1000;
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-CA');
const hrs = n => (n == null ? '—' : `${Math.round(Number(n) * 10) / 10}`);

export default function Display() {
  const { locationId } = useParams();
  const pinKey = `display_pin_${locationId}`;
  const [pin, setPin] = useState(() => sessionStorage.getItem(pinKey) || '');
  const [entered, setEntered] = useState(() => !!sessionStorage.getItem(pinKey));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async (thePin) => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/display/${locationId}?pin=${encodeURIComponent(thePin)}`, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { setError('Incorrect PIN'); setEntered(false); sessionStorage.removeItem(pinKey); setLoading(false); return; }
      if (!res.ok) { setError(body.error || `Error ${res.status}`); setLoading(false); return; }
      sessionStorage.setItem(pinKey, thePin);
      setData(body); setEntered(true); setUpdatedAt(new Date());
    } catch (e) {
      setError('Network error — retrying on next refresh');
    }
    setLoading(false);
  }, [locationId, pinKey]);

  // Initial load + 2-hour auto-refresh while unlocked.
  useEffect(() => {
    if (!entered || !pin) return undefined;
    load(pin);
    timer.current = setInterval(() => load(pin), TWO_HOURS);
    return () => timer.current && clearInterval(timer.current);
  }, [entered, pin, load]);

  // PIN entry screen
  if (!entered) {
    return (
      <div style={wrap}>
        <form onSubmit={e => { e.preventDefault(); if (pin) setEntered(true); }} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '-1px', marginBottom: '6px' }}>OPS DISPLAY</div>
          <div style={{ color: 'var(--text3)', fontSize: '14px', marginBottom: '24px' }}>Enter the display PIN for this location</div>
          <input
            autoFocus type="text" inputMode="text" value={pin}
            onChange={e => setPin(e.target.value.slice(0, 12))}
            placeholder="PIN"
            style={{ fontSize: '32px', letterSpacing: '8px', textAlign: 'center', padding: '12px 20px', width: '220px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)' }}
          />
          <div><button className="primary" type="submit" style={{ marginTop: '20px', fontSize: '16px', padding: '10px 28px' }}>Show board</button></div>
          {error && <div style={{ color: 'var(--danger)', marginTop: '16px', fontSize: '14px' }}>{error}</div>}
        </form>
      </div>
    );
  }

  if (!data) {
    return <div style={wrap}><div style={{ color: 'var(--text3)', fontSize: '18px' }}>{error || 'Loading board…'}</div></div>;
  }

  const target = data.target;
  const pct = data.pct_to_target;
  const barPct = pct == null ? 0 : Math.max(2, Math.min(100, pct));
  const over = target != null && data.revenue >= target;
  const onPace = data.pace_pct != null && data.pace_pct >= 100;
  const barColor = over ? 'var(--success)' : (onPace ? 'var(--success)' : (data.pace_pct != null && data.pace_pct >= 90 ? 'var(--warning)' : 'var(--danger)'));
  const effTarget = data.efficiency_target || 80;

  return (
    <div style={{ ...wrap, alignItems: 'stretch', justifyContent: 'flex-start', padding: '32px 40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
          <span style={{ fontSize: '26px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '-1px' }}>OPS</span>
          <span style={{ fontSize: '24px', fontWeight: 600, color: 'var(--text)' }}>{data.location.name}</span>
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text3)' }}>
          {loading ? 'Refreshing…' : `Updated ${updatedAt ? updatedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : ''}`} · auto-refresh 2h
        </div>
      </div>

      {/* Revenue vs target bar */}
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', padding: '28px 32px', marginBottom: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <div style={{ fontSize: '13px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Revenue this month</div>
            <div style={{ fontSize: '64px', fontWeight: 800, color: 'var(--text)', lineHeight: 1.05 }}>{money(data.revenue)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Target</div>
            <div style={{ fontSize: '40px', fontWeight: 700, color: 'var(--text2)' }}>{target != null ? money(target) : 'Not set'}</div>
          </div>
        </div>

        <div style={{ height: '34px', background: 'var(--bg3)', borderRadius: '17px', overflow: 'hidden', position: 'relative' }}>
          <div style={{ width: `${barPct}%`, height: '100%', background: barColor, borderRadius: '17px', transition: 'width 0.6s ease' }} />
          {pct != null && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: 700, color: 'var(--text)' }}>
              {pct}% of target
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '14px', fontSize: '18px' }}>
          <div style={{ color: barColor, fontWeight: 700 }}>
            {target == null ? 'Set a monthly target' : over ? `${money(data.revenue - target)} over target 🎉` : `${money(data.gap)} to go`}
          </div>
          {data.pace_pct != null && (
            <div style={{ color: 'var(--text3)' }}>{data.pace_pct}% of pace</div>
          )}
        </div>
      </div>

      {/* Tech leaderboard */}
      <div style={{ fontSize: '13px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px' }}>
        Technicians · hours sold {data.totals && `(${hrs(data.totals.hours_sold)} sold / ${hrs(data.totals.hours_billed)} billed)`}
      </div>
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.2fr', padding: '12px 24px', borderBottom: '0.5px solid var(--border)', fontSize: '13px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          <div>Technician</div>
          <div style={{ textAlign: 'right' }}>Billed</div>
          <div style={{ textAlign: 'right' }}>Sold</div>
          <div style={{ textAlign: 'right' }}>Efficiency</div>
        </div>
        {data.techs.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text3)' }}>No tech hours yet this month.</div>
        )}
        {data.techs.map(t => {
          const eff = t.efficiency;
          const effColor = eff == null ? 'var(--text3)' : (eff >= effTarget ? 'var(--success)' : (eff >= effTarget - 10 ? 'var(--warning)' : 'var(--danger)'));
          return (
            <div key={t.tech_id || t.tech_name} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.2fr', padding: '16px 24px', borderBottom: '0.5px solid var(--border)', alignItems: 'center' }}>
              <div style={{ fontSize: '22px', fontWeight: 600, color: 'var(--text)' }}>{t.tech_name}</div>
              <div style={{ textAlign: 'right', fontSize: '22px', color: 'var(--text2)' }}>{hrs(t.hours_billed)}</div>
              <div style={{ textAlign: 'right', fontSize: '22px', color: 'var(--text2)' }}>{hrs(t.hours_sold)}</div>
              <div style={{ textAlign: 'right', fontSize: '24px', fontWeight: 700, color: effColor }}>{eff == null ? '—' : `${eff}%`}</div>
            </div>
          );
        })}
      </div>

      {/* All-locations revenue standings (revenue only) */}
      {data.leaderboard && data.leaderboard.length >= 2 && (
        <div style={{ marginTop: '28px' }}>
          <div style={{ fontSize: '13px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px' }}>
            Group standings · revenue to date
          </div>
          <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', overflow: 'hidden' }}>
            {data.leaderboard.map(loc => (
              <div key={loc.id} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '14px 24px', borderBottom: '0.5px solid var(--border)', background: loc.is_current ? 'var(--bg3)' : 'transparent' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: 800, color: loc.rank === 1 ? '#1a1a1a' : 'var(--text2)', background: loc.rank === 1 ? 'var(--accent)' : 'var(--bg3)' }}>{loc.rank}</div>
                <div style={{ flex: 1, fontSize: '22px', fontWeight: loc.is_current ? 700 : 500, color: 'var(--text)' }}>
                  {loc.name}{loc.is_current ? ' (this shop)' : ''}
                </div>
                <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--text)' }}>{money(loc.revenue)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 'auto', paddingTop: '20px', fontSize: '12px', color: 'var(--text3)', textAlign: 'center' }}>
        Efficiency = hours sold ÷ available hours ({data.location.weekly_hours || 40}h/wk base, minus {data.location.province?.toUpperCase()} stat holidays) · target {effTarget}%
      </div>
    </div>
  );
}

const wrap = {
  minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px'
};
