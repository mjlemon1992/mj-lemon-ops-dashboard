import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';

// Public shop-floor time clock — runs on a shared tablet in the bay. Opened once
// with the location PIN (same one the display boards use), then each tech taps
// their name, enters their own 4–6 digit PIN, and clocks in/out or takes a break.
// No account login. Mirrors Display.js's PIN pattern.

const REFRESH_MS = 20 * 1000;
const fmtTime = (t) => t ? new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '';
// Tapping anywhere in a date field pops the native calendar (tablet-friendly);
// browsers without showPicker() just fall back to the field's own behaviour.
const openPicker = (e) => { try { e.target.showPicker(); } catch { /* unsupported */ } };
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
  const [view, setView] = useState('roster');       // roster | timeoff | request
  const [board, setBoard] = useState([]);           // time-off requests for the calendar
  const [reqForm, setReqForm] = useState({ person: null, start: '', end: '', type: 'vacation', pin: '' });
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

  const loadBoard = useCallback(async () => {
    try {
      const res = await fetch(`/api/clock/${locationId}/timeoff-board?pin=${encodeURIComponent(locPin)}`);
      const body = await res.json().catch(() => ({}));
      if (res.ok) setBoard(body.requests || []);
    } catch { /* board is best-effort */ }
  }, [locationId, locPin]);
  useEffect(() => { if (entered && view === 'timeoff') loadBoard(); }, [entered, view, loadBoard]);

  const submitTimeOff = async () => {
    const f = reqForm;
    if (!f.person || !f.start || !f.end || f.pin.length < 4) { setError('Fill the dates and your PIN'); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/timeoff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, person_id: f.person.id, pin: f.pin, start_date: f.start, end_date: f.end, type: f.type }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Failed'); setBusy(false); return; }
      setFlash(`${f.person.name} — time off requested (${body.working_days} working day${body.working_days === 1 ? '' : 's'}), awaiting approval`);
      setReqForm({ person: null, start: '', end: '', type: 'vacation', pin: '' });
      setView('timeoff'); loadBoard();
      setTimeout(() => setFlash(''), 4000);
    } catch { setError('Network error'); }
    setBusy(false);
  };

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
      const verb = action === 'in' ? 'clocked in'
        : action === 'out' ? `clocked out · ${body.paid_hours} h today`
        : action === 'break_start' ? 'on break — your shift keeps counting from your clock-in'
        : `back from break — still on your ${fmtTime(body.clock_in)} clock-in`;
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
        <div style={{ ...pill, background: STATUS[s].bg, color: STATUS[s].color, marginTop: '8px' }}>
          {s === 'break'
            ? `On break since ${fmtTime(active.since)} · clocked in ${fmtTime(active.clock_in)}`
            : `${STATUS[s].label}${active.since ? ` · since ${fmtTime(active.since)}` : ''}`}
        </div>
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

  // ── Time-off board: who's off, next couple of months ──
  if (view === 'timeoff') {
    return (
      <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', width: '100%', maxWidth: '820px' }}>
          <div style={{ fontSize: '22px', fontWeight: 700 }}>📅 Who's off</div>
          <button onClick={() => { setView('request'); setError(''); }} className="primary" style={{ marginLeft: 'auto', fontSize: '15px', padding: '10px 18px' }}>Request time off</button>
          <button onClick={() => { setView('roster'); setError(''); }} style={{ fontSize: '15px', padding: '10px 18px' }}>← Clock</button>
        </div>
        {flash && <div style={{ ...pill, background: 'rgba(52,199,89,0.16)', color: 'var(--success)', margin: '10px 0 0' }}>✓ {flash}</div>}
        <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '18px' }}>
          <OffMonth offset={0} board={board} />
          <OffMonth offset={1} board={board} />
        </div>
        <div style={{ width: '100%', maxWidth: '820px', marginTop: '16px' }}>
          {board.length === 0 && <div style={{ color: 'var(--text3)', textAlign: 'center' }}>No time off booked.</div>}
          {board.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 12px', background: 'var(--bg2)', borderRadius: '10px', marginBottom: '6px', opacity: r.status === 'pending' ? 0.65 : 1 }}>
              <span style={{ fontWeight: 700 }}>{r.person_name}</span>
              <span style={{ color: 'var(--text3)', fontSize: '13px' }}>{r.start_date === r.end_date ? r.start_date : `${r.start_date} → ${r.end_date}`} · {r.type}</span>
              <span style={{ ...pill, marginLeft: 'auto', fontSize: '11px', background: r.status === 'approved' ? 'rgba(52,199,89,0.14)' : 'var(--bg3)', color: r.status === 'approved' ? 'var(--success)' : 'var(--text3)' }}>{r.status === 'approved' ? '✓ approved' : 'awaiting approval'}</span>
            </div>
          ))}
        </div>
        {error && <div style={{ color: 'var(--danger)', marginTop: '12px' }}>{error}</div>}
      </div>
    );
  }

  // ── Time-off request form ──
  if (view === 'request') {
    const f = reqForm;
    return (
      <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '26px' }}>
        <div style={{ fontSize: '22px', fontWeight: 700, marginBottom: '14px' }}>🏖 Request time off</div>
        {!f.person ? (
          <>
            <div style={{ color: 'var(--text3)', marginBottom: '12px' }}>Who's asking?</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px', width: '100%', maxWidth: '640px' }}>
              {people.map((p) => (
                <button key={p.id} onClick={() => setReqForm((s) => ({ ...s, person: p }))} style={{ ...card, opacity: p.has_pin ? 1 : 0.5 }} disabled={!p.has_pin}>
                  <div style={{ fontSize: '17px', fontWeight: 700 }}>{p.name}</div>
                  {!p.has_pin && <div style={{ fontSize: '11px', color: 'var(--text3)' }}>no PIN set</div>}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div style={{ width: '100%', maxWidth: '420px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ fontWeight: 700, fontSize: '18px', textAlign: 'center' }}>{f.person.name}</div>
            <label style={lbl}>First day off<input type="date" value={f.start} onClick={openPicker} onFocus={openPicker} onChange={(e) => setReqForm((s) => ({ ...s, start: e.target.value, end: s.end || e.target.value }))} style={inp} /></label>
            <label style={lbl}>Last day off<input type="date" value={f.end} min={f.start} onClick={openPicker} onFocus={openPicker} onChange={(e) => setReqForm((s) => ({ ...s, end: e.target.value }))} style={inp} /></label>
            <label style={lbl}>Type
              <select value={f.type} onChange={(e) => setReqForm((s) => ({ ...s, type: e.target.value }))} style={inp}>
                <option value="vacation">Holiday / vacation</option>
                <option value="sick">Sick</option>
                <option value="unpaid">Unpaid leave</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label style={lbl}>Your PIN<input type="password" inputMode="numeric" value={f.pin} onChange={(e) => setReqForm((s) => ({ ...s, pin: e.target.value.replace(/\D/g, '').slice(0, 6) }))} style={{ ...inp, letterSpacing: '6px', textAlign: 'center' }} /></label>
            {error && <div style={{ color: 'var(--danger)', textAlign: 'center' }}>{error}</div>}
            <button className="primary" disabled={busy} onClick={submitTimeOff} style={{ ...bigBtn, width: '100%' }}>Submit request</button>
          </div>
        )}
        <button onClick={() => { setView('timeoff'); setReqForm({ person: null, start: '', end: '', type: 'vacation', pin: '' }); setError(''); }} style={{ marginTop: '18px', fontSize: '15px', padding: '10px 18px' }}>← Back</button>
      </div>
    );
  }

  // ── Roster grid ──
  return (
    <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '30px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', width: '100%', maxWidth: '760px', justifyContent: 'center' }}>
        <div style={{ fontSize: '22px', fontWeight: 700, marginBottom: '4px' }}>🕐 Who's clocking?</div>
        <button onClick={() => { setView('timeoff'); setError(''); }} style={{ fontSize: '14px', padding: '8px 14px' }}>📅 Time off</button>
      </div>
      {flash && <div style={{ ...pill, background: 'rgba(52,199,89,0.16)', color: 'var(--success)', margin: '6px 0 14px' }}>✓ {flash}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '14px', width: '100%', maxWidth: '760px', marginTop: '10px' }}>
        {people.map((p) => (
          <button key={p.id} onClick={() => { if (!p.has_pin) { setError(`${p.name} has no PIN set yet`); return; } setActive(p); setPin(''); setError(''); }}
            style={{ ...card, opacity: p.has_pin ? 1 : 0.5, borderColor: STATUS[p.status].color }}>
            <div style={{ fontSize: '18px', fontWeight: 700 }}>{p.name}</div>
            <div style={{ ...pill, background: STATUS[p.status].bg, color: STATUS[p.status].color, marginTop: '8px' }}>
              {p.status === 'break'
                ? `On break · in at ${fmtTime(p.clock_in)}`
                : `${STATUS[p.status].label}${p.status !== 'off' && p.since ? ` · ${fmtTime(p.since)}` : ''}`}
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

// One month of the who's-off calendar. Approved names solid, pending dimmed
// with a "?" — so the crew can see the real schedule at a glance.
function OffMonth({ offset, board }) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const iso = (d) => `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const byDay = {};
  for (const r of board) {
    for (let d = 1; d <= daysIn; d++) {
      const dd = iso(d);
      if (dd >= r.start_date && dd <= r.end_date) (byDay[dd] = byDay[dd] || []).push(r);
    }
  }
  const cells = [];
  for (let i = 0; i < (first.getDay() + 6) % 7; i++) cells.push(null);   // Monday-first
  for (let d = 1; d <= daysIn; d++) cells.push(d);
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return (
    <div style={{ background: 'var(--bg2)', borderRadius: '14px', padding: '14px', width: '390px' }}>
      <div style={{ fontWeight: 700, marginBottom: '8px', textAlign: 'center' }}>{first.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '3px', fontSize: '10px', color: 'var(--text3)', textAlign: 'center', marginBottom: '4px' }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '3px' }}>
        {cells.map((d, i) => {
          if (d == null) return <div key={i} />;
          const dd = iso(d);
          const dow = new Date(first.getFullYear(), first.getMonth(), d).getDay();
          const weekend = dow === 0 || dow === 6;
          const offs = byDay[dd] || [];
          return (
            <div key={i} style={{ minHeight: '44px', borderRadius: '6px', padding: '3px', fontSize: '10px',
              background: dd === todayIso ? 'rgba(10,132,255,0.18)' : weekend ? 'transparent' : 'var(--bg3)',
              opacity: weekend ? 0.45 : 1, border: dd === todayIso ? '1px solid var(--accent)' : '1px solid transparent' }}>
              <div style={{ color: 'var(--text3)', fontSize: '10px' }}>{d}</div>
              {offs.map((r, j) => (
                <div key={j} style={{ color: r.status === 'approved' ? 'var(--warning)' : 'var(--text3)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.person_name.split(' ')[0]}{r.status === 'pending' ? '?' : ''}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const wrap = { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px', background: 'var(--bg1)', color: 'var(--text1)' };
const lbl = { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--text3)' };
const inp = { fontSize: '17px', padding: '10px' };
const pill = { display: 'inline-block', padding: '4px 12px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 };
const card = { padding: '18px', borderRadius: '14px', background: 'var(--bg2)', border: '2px solid var(--border)', cursor: 'pointer', textAlign: 'center' };
const key = { height: '72px', fontSize: '26px', borderRadius: '12px', background: 'var(--bg3)', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text1)' };
const bigBtn = { fontSize: '18px', padding: '12px 26px', borderRadius: '12px', minWidth: '130px' };
