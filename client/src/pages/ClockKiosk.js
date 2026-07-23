import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';

// Public shop-floor time clock — runs on a shared tablet in the bay. Opened once
// with the location PIN (same one the display boards use), then each tech taps
// their name, enters their own 4–6 digit PIN, and clocks in/out or takes a break.
// No account login. Mirrors Display.js's PIN pattern.

const REFRESH_MS = 20 * 1000;
const fmtTime = (t) => t ? new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '';
const fmtDay = (t) => t ? new Date(t).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
const fmtDayShort = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
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
  const [view, setView] = useState('home');         // home | roster | timeoff | request | timesheet | profile | reorder
  const [reorderBoard, setReorderBoard] = useState([]);
  const [reorderForm, setReorderForm] = useState({ person: null, item: '', qty: '', note: '' });
  const [board, setBoard] = useState([]);           // time-off requests for the calendar
  const [holidays, setHolidays] = useState([]);     // province stat holidays in the window
  const [reqForm, setReqForm] = useState({ person: null, start: '', end: '', type: 'vacation', pin: '', paid: true });
  const [sheet, setSheet] = useState(null);         // my-timesheet payload (keeps person+pin for requests)
  const [rfid, setRfid] = useState(null);           // { tag, person, queue } — active fob card
  const [rfidEnabled, setRfidEnabled] = useState(false);   // OctaCard tap-to-clock on for this location?
  // Kiosk theme comes from the URL, not the in-app toggle (no Layout here):
  //   /clock/<id>             → dark (default, matches the display board)
  //   /clock/<id>?theme=light → light, for brightly-lit counters
  // Point Fully Kiosk's start URL at whichever reads best in the shop.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('theme');
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
    return () => { if (t === 'light') document.documentElement.removeAttribute('data-theme'); };
  }, []);
  const [fuHours, setFuHours] = useState('');       // follow-up answer inputs
  const [fuMins, setFuMins] = useState('');
  const [fuTook, setFuTook] = useState(null);
  const timer = useRef(null);
  const rfidBusy = useRef(false);

  const loadRoster = useCallback(async (lp) => {
    try {
      const res = await fetch(`/api/clock/${locationId}/roster?pin=${encodeURIComponent(lp)}`);
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { setError('Incorrect PIN'); setEntered(false); sessionStorage.removeItem(pinKey); return; }
      if (!res.ok) { setError(body.error || `Error ${res.status}`); return; }
      sessionStorage.setItem(pinKey, lp);
      setPeople(body.people || []); setRfidEnabled(!!body.rfid_enabled); setEntered(true); setError('');
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
  // The hub's "Today" strip needs the board too — load on entry and keep it
  // gently fresh (5 min; approvals during the day should show up unprompted).
  useEffect(() => {
    if (!entered) return undefined;
    loadBoard();
    const t = setInterval(loadBoard, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [entered, loadBoard]);

  const loadReorder = useCallback(async () => {
    try {
      const res = await fetch(`/api/clock/${locationId}/reorder-board?pin=${encodeURIComponent(locPin)}`);
      const body = await res.json().catch(() => ({}));
      if (res.ok) setReorderBoard(body.requests || []);
    } catch { /* best-effort */ }
  }, [locationId, locPin]);
  useEffect(() => { if (entered && view === 'reorder') loadReorder(); }, [entered, view, loadReorder]);

  const submitReorder = async () => {
    const f = reorderForm;
    if (!f.item.trim()) { setError('What are we low on? Enter an item.'); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/reorder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, person_id: f.person ? f.person.id : null, item: f.item, qty: f.qty, note: f.note }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Failed'); setBusy(false); return; }
      setFlash(`Re-order sent: ${body.item}`);
      setReorderForm({ person: null, item: '', qty: '', note: '' });
      loadReorder();
      setTimeout(() => setFlash(''), 3000);
    } catch { setError('Network error'); }
    setBusy(false);
  };

  // ── My work: this month's invoiced labour (hours only, per shop-floor rule) ──
  const [myWork, setMyWork] = useState(null);
  const openMyWork = async (auth) => {
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/my-work`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, ...auth }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Failed'); setBusy(false); return; }
      setMyWork(body);
      setActive(null); setPin(''); setRfid(null);
      setView('mywork');
    } catch { setError('Network error'); }
    setBusy(false);
  };

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
    if (!f.start || !f.end) { setError('Pick your first and last day off'); return; }
    if (f.pin.length < 4) { setError(`Enter your own 4–6 digit clock PIN, ${String(f.person.name || '').split(' ')[0]} — the one you punch in with`); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/timeoff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, person_id: f.person.id, pin: f.pin, start_date: f.start, end_date: f.end, type: f.type, paid: f.type === 'unpaid' ? false : !!f.paid }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Failed'); setBusy(false); return; }
      setFlash(`${f.person.name} — time off requested (${body.hours} h), awaiting approval`);
      setReqForm({ person: null, start: '', end: '', type: 'vacation', pin: '', paid: true });
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

  // ── RFID fob quick-clock (Bluetooth HID reader "types" the tag + Enter) ──
  const rfidCall = useCallback(async (tag, action) => {
    setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/rfid`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, tag, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Fob error'); return null; }
      return body;
    } catch { setError('Network error'); return null; }
  }, [locationId, locPin]);

  const finishAction = (name, action, body) => {
    const verb = action === 'in' ? 'IN ✓'
      : action === 'out' ? `OUT · ${body.paid_hours} h${body.overtime_flagged ? ' · overtime to confirm' : ''}${body.break_flagged ? ' · break to confirm' : ''}`
      : action === 'break_start' ? 'on break'
      : 'back from break';
    setFlash(`${name} — ${verb}`);
    setRfid(null); setView('home'); setBusy(false);
    loadRoster(locPin);
    setTimeout(() => setFlash(''), 3200);
  };

  const onScan = useCallback(async (tag) => {
    if (rfidBusy.current) return;
    rfidBusy.current = true; setBusy(true);
    try {
      const body = await rfidCall(tag, null);
      if (!body) { setView('home'); setTimeout(() => setError(''), 2500); return; }
      const queue = body.followups || [];
      setFuHours(''); setFuMins(''); setFuTook(null);
      if (queue.length) { setRfid({ tag, person: body, queue }); setView('rfid'); }
      else if (body.status === 'off') { const done = await rfidCall(tag, 'in'); if (done) finishAction(body.name, 'in', done); else setView('home'); }
      else { setRfid({ tag, person: body, queue: [] }); setView('rfid'); }
    } finally { rfidBusy.current = false; setBusy(false); }
  }, [rfidCall, locPin]);

  const answerFollowup = async (payload) => {
    const q = rfid.queue[0];
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/clock/${locationId}/followup/${q.id}/answer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc_pin: locPin, ...payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Failed'); setBusy(false); return; }
      const rest = rfid.queue.slice(1);
      setFuHours(''); setFuMins(''); setFuTook(null);
      if (rest.length) { setRfid({ ...rfid, queue: rest }); setBusy(false); }
      else if (rfid.person.status === 'off') { const done = await rfidCall(rfid.tag, 'in'); if (done) finishAction(rfid.person.name, 'in', done); else setBusy(false); }
      else { setRfid({ ...rfid, queue: [] }); setBusy(false); }
    } catch { setError('Network error'); setBusy(false); }
  };

  // Keyboard-wedge capture: a fast burst of chars ending in Enter = a fob scan.
  // Slow (human) typing resets the buffer; keystrokes inside inputs are ignored.
  useEffect(() => {
    // Only listen for OctaCard taps when the owner has switched the feature on
    // for this location — otherwise the shop runs PIN-only.
    if (!entered || !rfidEnabled) return undefined;
    let buf = '', last = 0;
    const onKey = (e) => {
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const now = Date.now();
      if (now - last > 120) buf = '';
      last = now;
      if (e.key === 'Enter') { if (buf.length >= 4) { const t = buf; buf = ''; onScan(t); } return; }
      if (e.key && e.key.length === 1 && /[A-Za-z0-9]/.test(e.key)) buf += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entered, rfidEnabled, onScan]);

  // ── Location PIN gate ──
  if (!entered) {
    return (
      <div style={wrap}>
        <div style={{ ...eyebrow, marginBottom: '8px' }}>OPS · Shop floor</div>
        <div style={{ ...kh, fontSize: '30px', marginBottom: '18px' }}>Shop Time Clock</div>
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
          <div style={{ fontSize: '24px', fontWeight: 700, color: active.color || 'var(--text)' }}>{active.name}</div>
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
            {active.track_break !== false && <button disabled={busy || pin.length < 4} onClick={() => punch('break_start')} style={{ ...bigBtn, background: 'var(--warning)', color: '#000', fontWeight: 700 }}>Start break</button>}
            <button className="primary" disabled={busy || pin.length < 4} onClick={() => punch('out')} style={bigBtn}>Clock out</button>
          </>}
          {s === 'break' && <>
            <button disabled={busy || pin.length < 4} onClick={() => punch('break_end')} style={{ ...bigBtn, background: 'var(--success)', color: '#000', fontWeight: 700 }}>End break</button>
            <button className="primary" disabled={busy || pin.length < 4} onClick={() => punch('out')} style={bigBtn}>Clock out</button>
          </>}
        </div>
        <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
          <button disabled={busy} onClick={() => (pin.length < 4 ? setError('Enter your PIN first, then tap again') : openTimesheet())} style={{ fontSize: '14px', padding: '9px 16px' }}>📋 My timesheet</button>
          <button disabled={busy} onClick={() => (pin.length < 4 ? setError('Enter your PIN first, then tap again') : openMyWork({ person_id: active.id, pin }))} style={{ fontSize: '14px', padding: '9px 16px' }}>🔧 My work</button>
          <button disabled={busy} onClick={() => (pin.length < 4 ? setError('Enter your PIN first, then tap again') : openProfile())} style={{ fontSize: '14px', padding: '9px 16px' }}>🎨 My profile</button>
        </div>
        {pin.length < 4 && <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '8px' }}>Punching, timesheet, and profile all unlock with your PIN.</div>}
      </div>
    );
  }

  // ── RFID fob card: identified by a fob, choose the action (or answer a question first) ──
  if (view === 'rfid' && rfid) {
    const p = rfid.person;
    const q = rfid.queue[0];
    const st = STATUS[p.status] || STATUS.off;
    return (
      <div style={wrap}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Avatar p={p} size={52} />
          <div style={{ fontSize: '24px', fontWeight: 700, color: p.color || 'var(--text)' }}>{p.name}</div>
        </div>

        {q ? (
          <div style={{ marginTop: '20px', width: '100%', maxWidth: '480px', background: 'var(--bg2)', borderRadius: '14px', padding: '20px', border: '1px solid var(--accent)' }}>
            <div style={{ ...eyebrow, marginBottom: '10px' }}>Quick question before you clock in</div>
            {q.kind === 'overtime' ? (
              <>
                <div style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>Did you work overtime on {fmtDayShort(q.work_date)}?</div>
                <div style={{ color: 'var(--text3)', fontSize: '13px', marginBottom: '16px' }}>Extra hours past your normal finish. Enter 0 if none.</div>
                <input autoFocus type="number" step="0.25" min="0" inputMode="decimal" value={fuHours} placeholder="0" onChange={(e) => setFuHours(e.target.value)} style={{ ...inp, fontSize: '24px', width: '130px', textAlign: 'center' }} />
                <span style={{ marginLeft: '10px', color: 'var(--text3)' }}>hours</span>
                <button className="primary" disabled={busy} onClick={() => answerFollowup({ hours: Number(fuHours) || 0 })} style={{ ...bigBtn, display: 'block', marginTop: '20px' }}>Submit</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>Did you take a break on {fmtDayShort(q.work_date)}?</div>
                <div style={{ color: 'var(--text3)', fontSize: '13px', marginBottom: '16px' }}>It wasn't logged. Breaks are unpaid — tell us so your pay is right.</div>
                {fuTook !== true ? (
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <button className="primary" disabled={busy} onClick={() => setFuTook(true)} style={bigBtn}>Yes, I did</button>
                    <button disabled={busy} onClick={() => answerFollowup({ took_break: false })} style={bigBtn}>No, I didn't</button>
                  </div>
                ) : (
                  <div>
                    <input autoFocus type="number" min="1" inputMode="numeric" value={fuMins} placeholder={String(p.break_minutes || 30)} onChange={(e) => setFuMins(e.target.value)} style={{ ...inp, fontSize: '24px', width: '130px', textAlign: 'center' }} />
                    <span style={{ marginLeft: '10px', color: 'var(--text3)' }}>minutes</span>
                    <button className="primary" disabled={busy || !(Number(fuMins) > 0)} onClick={() => answerFollowup({ took_break: true, minutes: Number(fuMins) })} style={{ ...bigBtn, display: 'block', marginTop: '20px' }}>Submit</button>
                  </div>
                )}
              </>
            )}
            {error && <div style={{ color: 'var(--danger)', marginTop: '14px' }}>{error}</div>}
          </div>
        ) : (
          <>
            <div style={{ ...pill, background: st.bg, color: st.color, marginTop: '10px' }}>
              {p.status === 'break' ? `On break since ${fmtTime(p.since)}` : p.status === 'on' ? `Clocked in ${fmtTime(p.clock_in)}` : 'Clocked out'}
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '24px' }}>
              {p.status === 'on' && <>
                {p.track_break && <button disabled={busy} onClick={() => rfidCall(rfid.tag, 'break_start').then((b) => b && finishAction(p.name, 'break_start', b))} style={{ ...bigBtn, background: 'var(--warning)', color: '#000', fontWeight: 700 }}>Start break</button>}
                <button className="primary" disabled={busy} onClick={() => rfidCall(rfid.tag, 'out').then((b) => b && finishAction(p.name, 'out', b))} style={bigBtn}>Clock out</button>
              </>}
              {p.status === 'break' && <button disabled={busy} onClick={() => rfidCall(rfid.tag, 'break_end').then((b) => b && finishAction(p.name, 'break_end', b))} style={{ ...bigBtn, background: 'var(--success)', color: '#000', fontWeight: 700 }}>Back from break</button>}
              {p.status === 'off' && <button className="primary" disabled={busy} onClick={() => rfidCall(rfid.tag, 'in').then((b) => b && finishAction(p.name, 'in', b))} style={bigBtn}>Clock in</button>}
            </div>
            <button disabled={busy} onClick={() => openMyWork({ tag: rfid.tag })} style={{ marginTop: '16px', fontSize: '14px', padding: '9px 16px' }}>🔧 My work this month</button>
            {error && <div style={{ color: 'var(--danger)', marginTop: '12px' }}>{error}</div>}
          </>
        )}
        <button onClick={() => { setRfid(null); setView('home'); setError(''); }} style={{ marginTop: '22px', fontSize: '15px', padding: '10px 18px' }}>Cancel</button>
      </div>
    );
  }

  // ── My work: month's invoiced labour — vehicle · RO · hours (no dollars) ──
  if (view === 'mywork' && myWork) {
    const monthLbl = new Date(myWork.month + '-15T12:00:00Z').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
    const Stat = ({ label, value, accent }) => (
      <div style={{ background: 'var(--bg2)', borderRadius: '12px', padding: '12px 18px', textAlign: 'center', border: '1px solid var(--border)', minWidth: '120px' }}>
        <div style={{ fontFamily: 'var(--font-disp)', fontWeight: 700, fontSize: '30px', color: accent ? 'var(--accent)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        <div style={{ ...eyebrow, color: 'var(--text3)' }}>{label}</div>
      </div>
    );
    return (
      <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', width: '100%', maxWidth: '760px' }}>
          <div style={{ ...kh, fontSize: '24px' }}>{myWork.name.split(' ')[0]} — my work · {monthLbl}</div>
          <button onClick={() => { setMyWork(null); setView('home'); setError(''); }} style={{ marginLeft: 'auto', fontSize: '15px', padding: '10px 18px' }}>← Home</button>
        </div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '16px' }}>
          <Stat label="Hours flagged" value={myWork.total_hours} accent />
          <Stat label="Cars" value={myWork.vehicles} />
          <Stat label="Hours clocked" value={myWork.clocked_hours} />
        </div>
        <div style={{ width: '100%', maxWidth: '760px', marginTop: '18px' }}>
          {myWork.rows.length === 0 && <div style={{ color: 'var(--text3)', textAlign: 'center' }}>No invoiced labour yet this month — this list fills as ROs are invoiced.</div>}
          {myWork.rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: '12px', alignItems: 'center', padding: '10px 14px', background: 'var(--bg2)', borderRadius: '10px', marginBottom: '6px' }}>
              <span style={{ color: 'var(--text3)', fontSize: '13px', minWidth: '72px' }}>{r.date ? fmtDayShort(r.date) : '—'}</span>
              <span style={{ fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vehicle || 'Vehicle'}</span>
              {r.ro && <span style={{ color: 'var(--text3)', fontSize: '12px' }}>RO {r.ro}</span>}
              <span style={{ fontFamily: 'var(--font-disp)', fontWeight: 700, fontSize: '18px', fontVariantNumeric: 'tabular-nums' }}>{r.hours} h</span>
            </div>
          ))}
        </div>
        {myWork.synced_at && <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>Fresh as of {fmtTime(myWork.synced_at)} — updates with the 2-hour Shopmonkey sync.</div>}
      </div>
    );
  }

  // ── My timesheet (this pay period) + change requests ──
  if (view === 'timesheet' && sheet) {
    return (
      <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '26px' }}>
        <div style={{ ...kh, fontSize: '24px' }}>{sheet.person.name} — timesheet</div>
        <div style={{ color: 'var(--text3)', margin: '4px 0 6px' }}>
          {fmtDay(sheet.from + 'T12:00:00')} → {fmtDay(sheet.to + 'T12:00:00')} (this pay period) · <b style={{ color: 'var(--text)' }}>{sheet.total_paid} h paid</b>
        </div>
        {sheet.holidays && (
          <div style={{ ...pill, marginBottom: '12px',
            background: sheet.holidays.allowance != null && sheet.holidays.used >= sheet.holidays.allowance ? 'rgba(255,69,58,0.14)' : 'rgba(10,132,255,0.12)',
            color: sheet.holidays.allowance != null && sheet.holidays.used >= sheet.holidays.allowance ? 'var(--danger)' : 'var(--accent)' }}>
            🏖 Holidays this year: {sheet.holidays.allowance != null
              ? `${sheet.holidays.used} h used of ${sheet.holidays.allowance} h — ${sheet.holidays.left} h left`
              : `${sheet.holidays.used} h used`}
          </div>
        )}
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
                border: me.color === c ? '4px solid var(--text)' : '2px solid transparent' }} aria-label={c} />
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
          <div style={{ ...kh, fontSize: '24px' }}>Who's off</div>
          <button onClick={() => { setView('request'); setError(''); }} className="primary" style={{ marginLeft: 'auto', fontSize: '15px', padding: '10px 18px' }}>Request time off</button>
          <button onClick={() => { setView('home'); setError(''); }} style={{ fontSize: '15px', padding: '10px 18px' }}>← Home</button>
        </div>
        {flash && <div style={{ ...pill, background: 'rgba(52,199,89,0.16)', color: 'var(--success)', margin: '10px 0 0' }}>✓ {flash}</div>}
        <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '18px' }}>
          <OffMonth offset={0} board={board} holidays={holidays} />
          <OffMonth offset={1} board={board} holidays={holidays} />
        </div>
        <CalLegend />
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
              <span style={{ color: 'var(--text3)', fontSize: '13px' }}>{r.start_date === r.end_date ? r.start_date : `${r.start_date} → ${r.end_date}`}{r.type !== 'closure' ? ` · ${r.type}` : ''}{r.type !== 'closure' ? ` · ${r.hours} h` : ''}</span>
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
        <div style={{ ...kh, fontSize: '24px', marginBottom: '14px' }}>Request time off</div>
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
            {f.type !== 'unpaid' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!f.paid} onChange={(e) => setReqForm((s) => ({ ...s, paid: e.target.checked }))} />
                Use as PAID time off (your daily hours are paid for these days)
              </label>
            )}
            <label style={lbl}>Your PIN<input type="password" inputMode="numeric" value={f.pin} onChange={(e) => setReqForm((s) => ({ ...s, pin: e.target.value.replace(/\D/g, '').slice(0, 6) }))} style={{ ...inp, letterSpacing: '6px', textAlign: 'center' }} /></label>
            {error && <div style={{ color: 'var(--danger)', textAlign: 'center' }}>{error}</div>}
            <button className="primary" disabled={busy} onClick={submitTimeOff} style={{ ...bigBtn, width: '100%' }}>Submit request</button>
          </div>
        )}
        <button onClick={() => { setView('timeoff'); setReqForm({ person: null, start: '', end: '', type: 'vacation', pin: '', paid: true }); setError(''); }} style={{ marginTop: '18px', fontSize: '15px', padding: '10px 18px' }}>← Back</button>
      </div>
    );
  }

  // ── Home: three big tiles ──
  if (view === 'home') {
    const openReorders = reorderBoard.filter((r) => r.status === 'requested').length;
    const onNow = people.filter((p) => p.status !== 'off').length;
    const Tile = ({ icon, title, sub, onClick, accent }) => (
      <button onClick={onClick} style={{ ...card, borderColor: accent ? 'var(--accent)' : 'var(--border)', borderWidth: '2px', padding: '30px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', minHeight: '190px', justifyContent: 'center' }}>
        <div style={{ fontSize: '46px', lineHeight: 1 }}>{icon}</div>
        <div style={{ ...kh, fontSize: '22px' }}>{title}</div>
        <div style={{ fontSize: '13px', color: 'var(--text3)' }}>{sub}</div>
      </button>
    );
    return (
      <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '40px' }}>
        <div style={{ ...eyebrow, marginBottom: '6px' }}>OPS · Shop floor</div>
        <div style={{ ...kh, fontSize: '30px', marginBottom: '24px' }}>Shop hub</div>
        {flash && <div style={{ ...pill, background: 'rgba(52,199,89,0.16)', color: 'var(--success)', marginBottom: '16px' }}>✓ {flash}</div>}

        {/* Today strip — who's away right now, closures, next stat holiday.
            Same data as the Time Off calendar, surfaced where everyone looks. */}
        {(() => {
          const todayIso = new Date().toLocaleDateString('en-CA');
          const offToday = board.filter((r) => r.status === 'approved' && r.start_date <= todayIso && r.end_date >= todayIso);
          const closed = offToday.some((r) => r.type === 'closure');
          const away = offToday.filter((r) => r.type !== 'closure');
          const nextHol = (holidays || []).filter((h) => h.date >= todayIso).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
          if (!closed && !away.length && !nextHol) return null;
          const chip = (border, color) => ({ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, background: 'var(--bg2)', border: `1px solid ${border}`, color });
          return (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center', width: '100%', maxWidth: '820px', marginBottom: '18px' }}>
              {closed && <span style={chip('var(--danger)', 'var(--danger)')}>🚪 Shop closed today</span>}
              {away.map((r) => (
                <span key={r.id} style={chip('rgba(255,184,0,0.5)', 'var(--warning)')}>
                  🏖 {r.person_name.split(' ')[0]} off{r.end_date > todayIso ? ` until ${fmtDayShort(r.end_date)}` : ' today'}
                </span>
              ))}
              {nextHol && <span style={chip('rgba(10,132,255,0.5)', '#5aa9ff')}>🎌 {nextHol.name} — {fmtDayShort(nextHol.date)}</span>}
            </div>
          );
        })()}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '18px', width: '100%', maxWidth: '820px' }}>
          <Tile icon="🕐" title="Clock" sub={onNow ? `${onNow} on the clock now` : 'Clock in / out & breaks'} onClick={() => { setView('roster'); loadRoster(locPin); setError(''); }} accent />
          <Tile icon="📅" title="Time off" sub="Request & who's away" onClick={() => { setView('timeoff'); loadBoard(); setError(''); }} />
          <Tile icon="📦" title="Re-order" sub={openReorders ? `${openReorders} awaiting order` : 'Flag low stock'} onClick={() => { setView('reorder'); loadReorder(); setError(''); }} />
        </div>

        {/* Crew now — live status under the tiles so a fob tap's result is
            visible at a glance (updates every 20s with the roster). */}
        {people.length > 0 && (
          <div style={{ width: '100%', maxWidth: '820px', marginTop: '26px' }}>
            <div style={{ ...eyebrow, marginBottom: '10px' }}>Crew now</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' }}>
              {people.map((p) => {
                const st = STATUS[p.status] || STATUS.off;
                const on = p.status !== 'off';
                return (
                  <button key={p.id} onClick={() => { setActive(p); setPin(''); setError(''); }}
                    title={`${p.name} — tap to punch`}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '12px', textAlign: 'left',
                      background: 'var(--bg2)', border: `1px solid ${p.status === 'on' ? 'rgba(52,199,89,0.45)' : p.status === 'break' ? 'rgba(255,184,0,0.5)' : 'var(--border)'}`,
                      opacity: on ? 1 : 0.62, cursor: 'pointer' }}>
                    <Avatar p={p} size={34} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 700, fontSize: '14px', color: p.color || 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name.split(' ')[0]}</span>
                      <span style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: st.color }}>
                        {p.status === 'on' ? `IN · ${fmtTime(p.clock_in)}` : p.status === 'break' ? `BREAK · ${fmtTime(p.since)}` : 'OUT'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Re-order board: flag low misc stock, tagged to a name ──
  if (view === 'reorder') {
    const STATUS_CHIP = { requested: { t: 'Requested', c: 'var(--warning)' }, ordered: { t: 'Ordered ✓', c: 'var(--accent)' }, received: { t: 'Received ✓', c: 'var(--success)' }, dismissed: { t: 'Dismissed', c: 'var(--text3)' } };
    return (
      <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', width: '100%', maxWidth: '760px' }}>
          <div style={{ ...kh, fontSize: '24px' }}>Re-order board</div>
          <button onClick={() => { setView('home'); setError(''); }} style={{ marginLeft: 'auto', fontSize: '15px', padding: '10px 18px' }}>← Home</button>
        </div>
        {flash && <div style={{ ...pill, background: 'rgba(52,199,89,0.16)', color: 'var(--success)', margin: '10px 0 0' }}>✓ {flash}</div>}

        {/* Request form */}
        <div style={{ width: '100%', maxWidth: '760px', marginTop: '16px', background: 'var(--bg2)', borderRadius: '14px', padding: '16px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '10px' }}>We're running low on…</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ ...lbl, flex: '2 1 220px' }}>Item
              <input value={reorderForm.item} placeholder="e.g. ATF Dexron VI, brake clean, shop rags" onChange={(e) => setReorderForm((s) => ({ ...s, item: e.target.value }))} style={inp} /></label>
            <label style={{ ...lbl, flex: '1 1 120px' }}>How much? (optional)
              <input value={reorderForm.qty} placeholder="2 cases, 1L…" onChange={(e) => setReorderForm((s) => ({ ...s, qty: e.target.value }))} style={inp} /></label>
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text3)', margin: '12px 0 6px' }}>Who's flagging it?</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {people.map((p) => (
              <button key={p.id} onClick={() => setReorderForm((s) => ({ ...s, person: s.person && s.person.id === p.id ? null : p }))}
                style={{ fontSize: '14px', padding: '8px 14px', border: reorderForm.person && reorderForm.person.id === p.id ? '2px solid var(--accent)' : '1px solid var(--border)', background: reorderForm.person && reorderForm.person.id === p.id ? 'rgba(240,84,35,0.12)' : 'var(--bg3)' }}>
                {p.name.split(' ')[0]}
              </button>
            ))}
          </div>
          <button className="primary" disabled={busy || !reorderForm.item.trim()} onClick={submitReorder} style={{ ...bigBtn, marginTop: '14px' }}>Send re-order</button>
          {error && <div style={{ color: 'var(--danger)', marginTop: '10px' }}>{error}</div>}
        </div>

        {/* Board — so techs see it's handled */}
        <div style={{ width: '100%', maxWidth: '760px', marginTop: '18px' }}>
          <div style={{ ...eyebrow, marginBottom: '8px' }}>On the board</div>
          {reorderBoard.length === 0 && <div style={{ color: 'var(--text3)' }}>Nothing flagged right now.</div>}
          {reorderBoard.map((r) => {
            const chip = STATUS_CHIP[r.status] || STATUS_CHIP.requested;
            return (
              <div key={r.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '10px 12px', background: 'var(--bg2)', borderRadius: '10px', marginBottom: '6px' }}>
                <span style={{ fontWeight: 700 }}>{r.item}</span>
                {r.qty && <span style={{ color: 'var(--text3)', fontSize: '13px' }}>· {r.qty}</span>}
                {r.person_name && <span style={{ color: 'var(--text3)', fontSize: '12px' }}>· {r.person_name.split(' ')[0]}</span>}
                <span style={{ ...pill, marginLeft: 'auto', fontSize: '11px', color: chip.c, background: 'var(--bg3)' }}>{chip.t}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Roster grid ──
  return (
    <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: '30px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', width: '100%', maxWidth: '760px', justifyContent: 'center' }}>
        <button onClick={() => { setView('home'); setError(''); }} style={{ fontSize: '14px', padding: '8px 14px' }}>← Home</button>
        <div style={{ ...kh, fontSize: '24px', marginBottom: '4px' }}>Who's clocking?</div>
      </div>
      {flash && <div style={{ ...pill, background: 'rgba(52,199,89,0.16)', color: 'var(--success)', margin: '6px 0 14px' }}>✓ {flash}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '14px', width: '100%', maxWidth: '760px', marginTop: '10px' }}>
        {people.map((p) => (
          <button key={p.id} onClick={() => { if (!p.has_pin) { setError(`${p.name} has no PIN set yet`); return; } setActive(p); setPin(''); setError(''); }}
            style={{ ...card, opacity: p.has_pin ? 1 : 0.5, borderColor: STATUS[p.status].color }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'center' }}>
              <Avatar p={p} size={40} />
              <div style={{ fontSize: '18px', fontWeight: 700, color: p.color || 'var(--text)' }}>{p.name}</div>
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
    <div style={{ background: 'var(--bg2)', borderRadius: '16px', padding: '16px', width: '390px', border: '1px solid var(--border)' }}>
      <div style={{ fontFamily: 'var(--font-disp)', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 700, fontSize: '19px', color: 'var(--text)', marginBottom: '12px', textAlign: 'center' }}>{first.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textAlign: 'center', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i} style={{ color: i >= 5 ? 'var(--text3)' : 'var(--text2)' }}>{d}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
        {cells.map((d, i) => {
          if (d == null) return <div key={i} />;
          const dd = iso(d);
          const dow = new Date(first.getFullYear(), first.getMonth(), d).getDay();
          const weekend = dow === 0 || dow === 6;
          const offs = byDay[dd] || [];
          const hol = holByDay[dd];
          const closed = offs.some((r) => r.type === 'closure' && r.status === 'approved');
          const isToday = dd === todayIso;
          const bg = closed ? 'rgba(255,77,77,0.18)' : isToday ? 'rgba(240,84,35,0.16)' : hol ? 'rgba(10,132,255,0.16)' : weekend ? 'var(--bg)' : 'var(--bg3)';
          const border = isToday ? '1.5px solid var(--accent)' : closed ? '1px solid var(--danger)' : hol ? '1px solid rgba(10,132,255,0.45)' : '1px solid var(--border)';
          const numColor = isToday ? 'var(--accent)' : hol ? '#5aa9ff' : weekend ? 'var(--text2)' : 'var(--text)';
          return (
            <div key={i} title={hol ? hol.name : undefined} style={{ minHeight: '50px', borderRadius: '8px', padding: '4px 5px', background: bg, border }}>
              <div style={{ color: numColor, fontSize: '15px', fontWeight: isToday ? 800 : 600, lineHeight: 1.05 }}>{d}{hol ? ' 🎌' : ''}</div>
              {hol && <div style={{ color: '#5aa9ff', fontWeight: 600, fontSize: '9.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hol.name}</div>}
              {closed && <div style={{ color: 'var(--danger)', fontWeight: 700, fontSize: '10px' }}>CLOSED</div>}
              {offs.filter((r) => r.type !== 'closure').map((r, j) => (
                <div key={j} style={{ color: r.status === 'approved' ? 'var(--warning)' : 'var(--text2)', fontWeight: 600, fontSize: '10.5px', fontStyle: r.status === 'pending' ? 'italic' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.person_name.split(' ')[0]}{r.status === 'pending' ? ' ?' : ''}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Colour key so the calendar reads at a glance from across the bay.
function CalLegend() {
  const sw = (bg, border) => ({ display: 'inline-block', width: '11px', height: '11px', borderRadius: '3px', background: bg, border: border || 'none', marginRight: '6px', verticalAlign: 'middle' });
  const item = { display: 'inline-flex', alignItems: 'center', fontSize: '12px', color: 'var(--text2)' };
  return (
    <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '14px' }}>
      <span style={item}><span style={sw('rgba(240,84,35,0.35)', '1.5px solid var(--accent)')} />Today</span>
      <span style={item}><span style={sw('rgba(10,132,255,0.5)', '1px solid rgba(10,132,255,0.6)')} />Stat holiday</span>
      <span style={item}><span style={sw('var(--warning)')} />Off — approved</span>
      <span style={{ ...item, fontStyle: 'italic' }}><span style={sw('var(--text2)')} />Pending  ?</span>
    </div>
  );
}

const kh = { fontFamily: 'var(--font-disp)', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 700 };
const eyebrow = { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '10px', letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--accent)' };
const wrap = { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px', background: 'var(--bg)', color: 'var(--text)' };
const lbl = { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--text3)' };
const inp = { fontSize: '17px', padding: '10px' };
const pill = { display: 'inline-block', padding: '4px 12px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 };
const card = { padding: '18px', borderRadius: '14px', background: 'var(--bg2)', border: '2px solid var(--border)', cursor: 'pointer', textAlign: 'center' };
const key = { height: '72px', fontSize: '28px', fontFamily: 'var(--font-disp)', fontWeight: 700, borderRadius: '12px', background: 'var(--bg3)', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text)' };
const bigBtn = { fontSize: '19px', fontFamily: 'var(--font-disp)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '12px 26px', borderRadius: '12px', minWidth: '130px' };
