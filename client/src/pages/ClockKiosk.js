import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';

// Public shop-floor time clock — runs on a shared tablet in the bay. Opened once
// with the location PIN (same one the display boards use), then each tech taps
// their name, enters their own 4–6 digit PIN, and clocks in/out or takes a break.
// No account login. Mirrors Display.js's PIN pattern.

const REFRESH_MS = 20 * 1000;
const fmtTime = (t) => t ? new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '';
const STATUS = {
  off:   { label: 'Off',       color: 'var(--text3)',   bg: 'var(--bg3)' },
  on:    { label: 'On the clock', color: 'var(--success)', bg: 'rgba(52,199,89,0.14)' },
  break: { label: 'On break',   color: 'var(--warning)', bg: 'rgba(255,184,0,0.16)' },
};

export default function ClockKiosk() {
  const { locationId } = useParams();
  const pinKey = `clock_locpin_${locationId}`;
  const [locPin, setLocPin] = useState(() => sessionStorage.getItem(pinKey) || '');
  const [entered, setEntered] = useState(() => !!sessionStorage.getItem(pinKey));
  const [people, setPeople] = useState([]);
  const [error, setError] = useState('');
  const [entryPin, setEntryPin] = useState('');
  const [active, setActive] = useState(null);     // person being punched
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const timer = useRef(null);

  const loadRoster = useCallback(async (lp) => {
    try {
      const res = await fetch(`/api/clock/${locationId}/roster?pin=${encodeURIComponent(lp)}`);
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { setError('Incorrect PIN'); setEntered(false); sessionStorage.removeItem(pinKey); return; }
      if (!res.ok) { setError(body.error || `Error ${res.status}`); return; }
      sessionStorage.setItem(pinKey, lp);
      setPeople(body.people || []); setEntered(true); setError('');
    } catch { setError('Network error'); }
  }, [locationId, pinKey]);

  useEffect(() => {
    if (!entered || !locPin) return undefined;
    loadRoster(locPin);
    timer.current = setInterval(() => loadRoster(locPin), REFRESH_MS);
    return () => timer.current && clearInterval(timer.current);
  }, [entered, locPin, loadRoster]);

  const punch = async (action) => {
    if (!active) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/punch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, person_id: active.id, pin, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Failed'); setBusy(false); return; }
      const verb = action === 'in' ? 'clocked in' : action === 'out' ? 'clocked out' : action === 'break_start' ? 'on break' : 'back from break';
      setFlash(`${active.name} — ${verb}`);
      setActive(null); setPin('');
      await loadRoster(locPin);
      setTimeout(() => setFlash(''), 2500);
    } catch { setError('Network error'); }
    setBusy(false);
  };

  // ── Location PIN gate ──
  if (!entered) {
    return (
      <div style={wrap}>
        <div style={{ fontSize: '22px', fontWeight: 700, marginBottom: '18px' }}>🕐 Shop Time Clock</div>
        <form onSubmit={(e) => { e.preventDefault(); setLocPin(entryPin); loadRoster(entryPin); }} style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text3)', marginBottom: '10px' }}>Enter the shop PIN</div>
          <input autoFocus type="password" inputMode="numeric" value={entryPin} onChange={(e) => setEntryPin(e.target.value)}
            style={{ fontSize: '28px', textAlign: 'center', width: '180px', letterSpacing: '8px', padding: '10px' }} />
          <div><button className="primary" style={{ marginTop: '16px', fontSize: '18px', padding: '10px 28px' }}>Open</button></div>
          {error && <div style={{ color: 'var(--danger)', marginTop: '12px' }}>{error}</div>}
        </form>
      </div>
    );
  }

  // ── Per-person PIN pad ──
  if (active) {
    const s = active.status;
    return (
      <div style={wrap}>
        <div style={{ fontSize: '24px', fontWeight: 700 }}>{active.name}</div>
        <div style={{ ...pill, background: STATUS[s].bg, color: STATUS[s].color, marginTop: '8px' }}>{STATUS[s].label}{active.since ? ` · since ${fmtTime(active.since)}` : ''}</div>
        <div style={{ fontSize: '15px', color: 'var(--text3)', margin: '18px 0 8px' }}>Enter your PIN</div>
        <div style={{ fontSize: '30px', letterSpacing: '10px', height: '38px', fontFamily: 'monospace' }}>{pin.replace(/./g, '•')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: '10px', margin: '14px 0' }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <button key={n} onClick={() => setPin((p) => (p.length < 6 ? p + n : p))} style={key}>{n}</button>
          ))}
          <button onClick={() => setPin((p) => p.slice(0, -1))} style={key}>⌫</button>
          <button onClick={() => setPin((p) => (p.length < 6 ? p + '0' : p))} style={key}>0</button>
          <button onClick={() => { setActive(null); setPin(''); setError(''); }} style={{ ...key, fontSize: '15px' }}>Cancel</button>
        </div>
        {error && <div style={{ color: 'var(--danger)', marginBottom: '10px' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
          {s === 'off' && <button className="primary" disabled={busy || pin.length < 4} onClick={() => punch('in')} style={bigBtn}>Clock in</button>}
          {s === 'on' && <>
            <button disabled={busy || pin.length < 4} onClick={() => punch('break_start')} style={{ ...bigBtn, background: 'var(--warning)', color: '#000', fontWeight: 700 }}>Start break</button>
            <button className="primary" disabled={busy || pin.length < 4} onClick={() => punch('out')} style={bigBtn}>Clock out</button>
          </>}
          {s === 'break' && <>
            <button disabled={busy || pin.length < 4} onClick={() => punch('break_end')} style={{ ...bigBtn, background: 'var(--success)', color: '#000', fontWeight: 700 }}>End break</button>
            <button className="primary" disabled={busy || pin.length < 4} onClick={() => punch('out')} style={bigBtn}>Clock out</button>
          </>}
        </div>
      </div>
    );
  }

  // ── Roster grid ──
  return (
    <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '30px' }}>
      <div style={{ fontSize: '22px', fontWeight: 700, marginBottom: '4px' }}>🕐 Who's clocking?</div>
      {flash && <div style={{ ...pill, background: 'rgba(52,199,89,0.16)', color: 'var(--success)', margin: '6px 0 14px' }}>✓ {flash}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '14px', width: '100%', maxWidth: '760px', marginTop: '10px' }}>
        {people.map((p) => (
          <button key={p.id} onClick={() => { if (!p.has_pin) { setError(`${p.name} has no PIN set yet`); return; } setActive(p); setPin(''); setError(''); }}
            style={{ ...card, opacity: p.has_pin ? 1 : 0.5, borderColor: STATUS[p.status].color }}>
            <div style={{ fontSize: '18px', fontWeight: 700 }}>{p.name}</div>
            <div style={{ ...pill, background: STATUS[p.status].bg, color: STATUS[p.status].color, marginTop: '8px' }}>
              {STATUS[p.status].label}{p.status !== 'off' && p.since ? ` · ${fmtTime(p.since)}` : ''}
            </div>
            {!p.has_pin && <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '6px' }}>no PIN set</div>}
          </button>
        ))}
      </div>
      {error && <div style={{ color: 'var(--danger)', marginTop: '16px' }}>{error}</div>}
      {!people.length && <div style={{ color: 'var(--text3)', marginTop: '30px' }}>No crew set up for this location yet.</div>}
    </div>
  );
}

const wrap = { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px', background: 'var(--bg1)', color: 'var(--text1)' };
const pill = { display: 'inline-block', padding: '4px 12px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 };
const card = { padding: '18px', borderRadius: '14px', background: 'var(--bg2)', border: '2px solid var(--border)', cursor: 'pointer', textAlign: 'center' };
const key = { height: '72px', fontSize: '26px', borderRadius: '12px', background: 'var(--bg3)', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text1)' };
const bigBtn = { fontSize: '18px', padding: '12px 26px', borderRadius: '12px', minWidth: '130px' };
