import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';

// Public shop-floor time clock — runs on a shared tablet in the bay. Opened once
// with the location PIN (same one the display boards use), then each tech taps
// their name, enters their own 4–6 digit PIN, and clocks in/out or takes a break.
// No account login. Mirrors Display.js's PIN pattern.

const REFRESH_MS = 20 * 1000;
const fmtTime = (t) => t ? new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '';
const fmtDay = (t) => t ? new Date(t).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
// Tapping anywhere in a date field pops the native calendar (tablet-friendly);
// browsers without showPicker() just fall back to the field's own behaviour.
const openPicker = (e) => { try { e.target.showPicker(); } catch { /* unsupported */ } };
// Must match the server's PALETTE list exactly.
const PALETTE = ['#0a84ff', '#34c759', '#ff9f0a', '#ff375f', '#bf5af2', '#5ac8fa', '#ffd60a', '#ff6b35', '#64d2ff', '#30d158'];
// Square-crop + shrink a camera shot to 256px JPEG before upload.
const resizePhoto = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => {
    const s = Math.min(img.width, img.height);
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    canvas.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
    URL.revokeObjectURL(img.src);
    resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
  };
  img.onerror = reject;
  img.src = URL.createObjectURL(file);
});
// Compact hour/minute/AM-PM selects for proposing corrected punch times.
const p2 = (n) => String(n).padStart(2, '0');
function TimeSel({ v, onChange }) {
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
      <select value={v.h} onChange={(e) => set({ h: Number(e.target.value) })} style={{ width: 'auto', fontSize: '15px' }}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((h) => <option key={h} value={h}>{h}</option>)}
      </select>:
      <select value={v.m} onChange={(e) => set({ m: Number(e.target.value) })} style={{ width: 'auto', fontSize: '15px' }}>
        {Array.from({ length: 60 }, (_, i) => i).map((m) => <option key={m} value={m}>{p2(m)}</option>)}
      </select>
      <select value={v.ap} onChange={(e) => set({ ap: e.target.value })} style={{ width: 'auto', fontSize: '15px', fontWeight: 600 }}>
        <option>AM</option><option>PM</option>
      </select>
    </span>
  );
}
const timeToIso = (dateStr, t) => new Date(`${dateStr}T${p2((t.h % 12) + (t.ap === 'PM' ? 12 : 0))}:${p2(t.m)}:00`).toISOString();
const isoToTime = (iso, fallback) => {
  if (!iso) return fallback;
  const d = new Date(iso);
  return { h: ((d.getHours() + 11) % 12) + 1, m: d.getMinutes(), ap: d.getHours() >= 12 ? 'PM' : 'AM' };
};
const localDateOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

// Photo if they have one, otherwise initials in their colour.
function Avatar({ p, size = 44 }) {
  const st = { width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 };
  if (p.photo) return <img src={p.photo} alt="" style={{ ...st, border: `2px solid ${p.color || 'var(--border)'}` }} />;
  return (
    <div style={{ ...st, background: p.color || 'var(--bg3)', color: p.color ? '#fff' : 'var(--text3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size * 0.4 }}>
      {String(p.name || '?').trim().slice(0, 1).toUpperCase()}
    </div>
  );
}
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
  const [view, setView] = useState('roster');       // roster | timeoff | request | timesheet | profile
  const [board, setBoard] = useState([]);           // time-off requests for the calendar
  const [holidays, setHolidays] = useState([]);     // province stat holidays in the window
  const [reqForm, setReqForm] = useState({ person: null, start: '', end: '', type: 'vacation', pin: '' });
  const [sheet, setSheet] = useState(null);         // my-timesheet payload (keeps person+pin for requests)
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
      if (res.ok) { setBoard(body.requests || []); setHolidays(body.holidays || []); }
    } catch { /* board is best-effort */ }
  }, [locationId, locPin]);
  useEffect(() => { if (entered && view === 'timeoff') loadBoard(); }, [entered, view, loadBoard]);

  // ── Tech self-service (uses the PIN already typed on the person screen) ──
  const openTimesheet = async () => {
    if (!active || pin.length < 4) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/timesheet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, person_id: active.id, pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Failed'); setBusy(false); return; }
      setSheet({ ...body, person: active, pin });
      // The person/PIN screen renders ahead of every other view — it must be
      // dismissed or the timesheet never shows.
      setActive(null); setPin('');
      setView('timesheet');
    } catch { setError('Network error'); }
    setBusy(false);
  };
  // Change-request form state: which entry (null = missing punch), note, and
  // optionally the corrected times the tech proposes.
  const [editReq, setEditReq] = useState(null);
  const openEditReq = (entry) => {
    const date = entry ? localDateOf(entry.clock_in) : new Date().toLocaleDateString('en-CA');
    setEditReq({
      entry: entry || null, note: '', date, useTimes: !entry,
      tin: isoToTime(entry && entry.clock_in, { h: 8, m: 0, ap: 'AM' }),
      tout: isoToTime(entry && entry.clock_out, { h: 4, m: 30, ap: 'PM' }),
      brk: entry ? Math.round((entry.break_seconds || 0) / 60) : 0,
    });
    setError('');
  };
  const submitEditReq = async () => {
    const f = editReq;
    if (!f.note.trim()) { setError('Say what needs changing'); return; }
    setBusy(true); setError('');
    try {
      const body = { loc_pin: locPin, person_id: sheet.person.id, pin: sheet.pin, entry_id: f.entry ? f.entry.id : null, note: f.note };
      if (f.useTimes) {
        body.proposed_clock_in = timeToIso(f.date, f.tin);
        body.proposed_clock_out = timeToIso(f.date, f.tout);
        body.proposed_break_minutes = Number(f.brk) || 0;
      }
      const res = await fetch(`/api/clock/${locationId}/edit-request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.error || 'Failed'); setBusy(false); return; }
      setEditReq(null);
      setFlash('Change requested — the owner will review it');
      setTimeout(() => setFlash(''), 3000);
    } catch { setError('Network error'); }
    setBusy(false);
  };
  const saveProfile = async (patch) => {
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, person_id: sheet.person.id, pin: sheet.pin, ...patch }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Failed'); setBusy(false); return; }
      await loadRoster(locPin);
      setFlash('Saved ✓'); setTimeout(() => setFlash(''), 2000);
    } catch { setError('Network error'); }
    setBusy(false);
  };
  const openProfile = async () => {
    if (!active || pin.length < 4) return;
    // Verify the PIN by loading the timesheet (cheap), then show profile.
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/timesheet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, person_id: active.id, pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Failed'); setBusy(false); return; }
      setSheet({ ...body, person: active, pin });
      setActive(null); setPin('');   // dismiss the person screen (renders first)
      setView('profile');
    } catch { setError('Network error'); }
    setBusy(false);
  };

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Avatar p={people.find((p) => p.id === active.id) || active} size={52} />
          <div style={{ fontSize: '24px', fontWeight: 700, color: active.color || 'var(--text1)' }}>{active.name}</div>
        </div>
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
        <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
          <button disabled={busy} onClick={() => (pin.length < 4 ? setError('Enter your PIN first, then tap again') : openTimesheet())} style={{ fontSize: '14px', padding: '9px 16px' }}>📋 My timesheet</button>
          <button disabled={busy} onClick={() => (pin.length < 4 ? setError('Enter your PIN first, then tap again') : openProfile())} style={{ fontSize: '14px', padding: '9px 16px' }}>🎨 My profile</button>
        </div>
        {pin.length < 4 && <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '8px' }}>Punching, timesheet, and profile all unlock with your PIN.</div>}
      </div>
    );
  }

  // ── My timesheet (this pay period) + change requests ──
  if (view === 'timesheet' && sheet) {
    return (
      <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '26px' }}>
        <div style={{ fontSize: '22px', fontWeight: 700 }}>📋 {sheet.person.name} — my timesheet</div>
        <div style={{ color: 'var(--text3)', margin: '4px 0 14px' }}>
          {fmtDay(sheet.from + 'T12:00:00')} → {fmtDay(sheet.to + 'T12:00:00')} (this pay period) · <b style={{ color: 'var(--text1)' }}>{sheet.total_paid} h paid</b>
        </div>
        {flash && <div style={{ ...pill, background: 'rgba(52,199,89,0.16)', color: 'var(--success)', marginBottom: '10px' }}>✓ {flash}</div>}
        <div style={{ width: '100%', maxWidth: '640px' }}>
          {(sheet.entries || []).length === 0 && <div style={{ color: 'var(--text3)', textAlign: 'center', padding: '20px' }}>No punches this period yet.</div>}
          {(sheet.entries || []).map((e) => (
            <div key={e.id} style={{ background: 'var(--bg2)', borderRadius: '10px', marginBottom: '6px', padding: '10px 14px' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, minWidth: '110px' }}>{fmtDay(e.clock_in)}</span>
                <span style={{ color: 'var(--text2)', fontSize: '14px' }}>
                  {fmtTime(e.clock_in)} → {e.clock_out ? fmtTime(e.clock_out) : 'on shift'}
                  {Array.isArray(e.breaks) && e.breaks.length
                    ? ` · break${e.breaks.length > 1 ? 's' : ''} ${e.breaks.map((b) => `${fmtTime(b.start)}–${b.end ? fmtTime(b.end) : '…'}`).join(', ')}`
                    : (e.break_seconds > 0 ? ` · break ${Math.round(e.break_seconds / 60)} min` : '')}
                </span>
                <span style={{ marginLeft: 'auto', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{e.paid_hours != null ? `${e.paid_hours} h` : '—'}</span>
                <button disabled={busy} onClick={() => (editReq && editReq.entry && editReq.entry.id === e.id ? setEditReq(null) : openEditReq(e))} style={{ fontSize: '11px', padding: '4px 10px' }}>✋ Request change</button>
              </div>
              {editReq && editReq.entry && editReq.entry.id === e.id && (
                <div style={{ marginTop: '10px', padding: '10px', background: 'var(--bg3)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <input placeholder="What needs changing?" value={editReq.note} onChange={(ev) => setEditReq((s) => ({ ...s, note: ev.target.value }))} style={{ fontSize: '15px', padding: '8px' }} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={editReq.useTimes} onChange={(ev) => setEditReq((s) => ({ ...s, useTimes: ev.target.checked }))} />
                    Suggest the corrected times
                  </label>
                  {editReq.useTimes && (
                    <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', fontSize: '13px', color: 'var(--text3)' }}>
                      <span>In <TimeSel v={editReq.tin} onChange={(v) => setEditReq((s) => ({ ...s, tin: v }))} /></span>
                      <span>Out <TimeSel v={editReq.tout} onChange={(v) => setEditReq((s) => ({ ...s, tout: v }))} /></span>
                      <span>Break <input type="number" min="0" value={editReq.brk} onChange={(ev) => setEditReq((s) => ({ ...s, brk: ev.target.value }))} style={{ width: '58px' }} /> min</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="primary" disabled={busy} onClick={submitEditReq} style={{ fontSize: '13px', padding: '7px 16px' }}>Send request</button>
                    <button onClick={() => setEditReq(null)} style={{ fontSize: '13px', padding: '7px 14px' }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {editReq && !editReq.entry ? (
            <div style={{ marginTop: '8px', padding: '12px', background: 'var(--bg3)', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>＋ Report a missing punch</div>
              <input placeholder="What happened? (e.g. forgot to clock in Tuesday)" value={editReq.note} onChange={(ev) => setEditReq((s) => ({ ...s, note: ev.target.value }))} style={{ fontSize: '15px', padding: '8px' }} />
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', fontSize: '13px', color: 'var(--text3)' }}>
                <span>Day <input type="date" value={editReq.date} onClick={openPicker} onFocus={openPicker} onChange={(ev) => setEditReq((s) => ({ ...s, date: ev.target.value }))} /></span>
                <span>In <TimeSel v={editReq.tin} onChange={(v) => setEditReq((s) => ({ ...s, tin: v }))} /></span>
                <span>Out <TimeSel v={editReq.tout} onChange={(v) => setEditReq((s) => ({ ...s, tout: v }))} /></span>
                <span>Break <input type="number" min="0" value={editReq.brk} onChange={(ev) => setEditReq((s) => ({ ...s, brk: ev.target.value }))} style={{ width: '58px' }} /> min</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="primary" disabled={busy} onClick={submitEditReq} style={{ fontSize: '13px', padding: '7px 16px' }}>Send request</button>
                <button onClick={() => setEditReq(null)} style={{ fontSize: '13px', padding: '7px 14px' }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button disabled={busy} onClick={() => openEditReq(null)} style={{ fontSize: '13px', padding: '8px 14px', marginTop: '6px' }}>＋ Report a missing punch</button>
          )}
        </div>
        {error && <div style={{ color: 'var(--danger)', marginTop: '12px' }}>{error}</div>}
        <button onClick={() => { setView('roster'); setSheet(null); setActive(null); setPin(''); setError(''); }} style={{ marginTop: '18px', fontSize: '15px', padding: '10px 18px' }}>← Done</button>
      </div>
    );
  }

  // ── My profile: name colour + photo ──
  if (view === 'profile' && sheet) {
    const me = people.find((p) => p.id === sheet.person.id) || sheet.person;
    return (
      <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '26px' }}>
        <div style={{ fontSize: '22px', fontWeight: 700, marginBottom: '10px' }}>🎨 {sheet.person.name} — my profile</div>
        {flash && <div style={{ ...pill, background: 'rgba(52,199,89,0.16)', color: 'var(--success)', marginBottom: '10px' }}>✓ {flash}</div>}
        <Avatar p={me} size={110} />
        <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
          <label style={{ fontSize: '13px', padding: '8px 14px', background: 'var(--bg3)', borderRadius: '10px', cursor: 'pointer' }}>
            📷 Take / choose photo
            <input type="file" accept="image/*" capture="user" style={{ display: 'none' }}
              onChange={async (ev) => {
                const f = ev.target.files && ev.target.files[0];
                ev.target.value = '';
                if (!f) return;
                try { const b64 = await resizePhoto(f); saveProfile({ photo_base64: b64, photo_mime: 'image/jpeg' }); }
                catch { setError('Could not read that photo'); }
              }} />
          </label>
          {me.photo && <button disabled={busy} onClick={() => saveProfile({ clear_photo: true })} style={{ fontSize: '13px', padding: '8px 14px' }}>Remove photo</button>}
        </div>
        <div style={{ fontSize: '14px', color: 'var(--text3)', margin: '18px 0 8px' }}>My colour — shows on the clock and the performance boards</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '420px' }}>
          {PALETTE.map((c) => (
            <button key={c} disabled={busy} onClick={() => saveProfile({ color: c })}
              style={{ width: '46px', height: '46px', borderRadius: '50%', background: c, cursor: 'pointer',
                border: me.color === c ? '4px solid var(--text1)' : '2px solid transparent' }} aria-label={c} />
          ))}
        </div>
        {error && <div style={{ color: 'var(--danger)', marginTop: '12px' }}>{error}</div>}
        <button onClick={() => { setView('roster'); setSheet(null); setActive(null); setPin(''); setError(''); }} style={{ marginTop: '20px', fontSize: '15px', padding: '10px 18px' }}>← Done</button>
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
          <OffMonth offset={0} board={board} holidays={holidays} />
          <OffMonth offset={1} board={board} holidays={holidays} />
        </div>
        {holidays.length > 0 && (
          <div style={{ fontSize: '12px', color: 'var(--accent)', marginTop: '10px', textAlign: 'center' }}>
            🎌 {holidays.map((h) => `${h.name} — ${new Date(h.date + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`).join(' · ')}
          </div>
        )}
        <div style={{ width: '100%', maxWidth: '820px', marginTop: '16px' }}>
          {board.length === 0 && <div style={{ color: 'var(--text3)', textAlign: 'center' }}>No time off booked.</div>}
          {board.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 12px', background: 'var(--bg2)', borderRadius: '10px', marginBottom: '6px', opacity: r.status === 'pending' ? 0.65 : 1, border: r.type === 'closure' ? '1px solid var(--danger)' : 'none' }}>
              <span style={{ fontWeight: 700 }}>{r.type === 'closure' ? '🚪 Shop closed' : r.person_name}</span>
              <span style={{ color: 'var(--text3)', fontSize: '13px' }}>{r.start_date === r.end_date ? r.start_date : `${r.start_date} → ${r.end_date}`}{r.type !== 'closure' ? ` · ${r.type}` : ''} · {r.working_days} day{r.working_days === 1 ? '' : 's'}</span>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'center' }}>
              <Avatar p={p} size={40} />
              <div style={{ fontSize: '18px', fontWeight: 700, color: p.color || 'var(--text1)' }}>{p.name}</div>
            </div>
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
// with a "?", stat holidays flagged 🎌, closures painted across the cell.
function OffMonth({ offset, board, holidays }) {
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
  const holByDay = {};
  for (const h of holidays || []) holByDay[h.date] = h;
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
          const hol = holByDay[dd];
          const closed = offs.some((r) => r.type === 'closure' && r.status === 'approved');
          return (
            <div key={i} title={hol ? hol.name : undefined} style={{ minHeight: '44px', borderRadius: '6px', padding: '3px', fontSize: '10px',
              background: closed ? 'rgba(255,69,58,0.16)' : hol ? 'rgba(10,132,255,0.12)' : dd === todayIso ? 'rgba(10,132,255,0.18)' : weekend ? 'transparent' : 'var(--bg3)',
              opacity: weekend && !hol ? 0.45 : 1, border: dd === todayIso ? '1px solid var(--accent)' : closed ? '1px solid var(--danger)' : '1px solid transparent' }}>
              <div style={{ color: 'var(--text3)', fontSize: '10px' }}>{d}{hol ? ' 🎌' : ''}</div>
              {hol && <div style={{ color: 'var(--accent)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hol.name}</div>}
              {closed && <div style={{ color: 'var(--danger)', fontWeight: 700 }}>CLOSED</div>}
              {offs.filter((r) => r.type !== 'closure').map((r, j) => (
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
