import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';

// Time Clock admin (owner + that location's manager). Review the month's punches,
// fix missed/wrong ones, add a manual entry, and set each tech's kiosk PIN. The
// shop-floor kiosk lives at /clock/:locationId. Monthly paid hours feed the bonus.

const monthLabel = (m) => m ? new Date(m + '-15T12:00:00Z').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' }) : '';
const fmtDT = (t) => t ? new Date(t).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const forInput = (t) => { if (!t) return ''; const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

export default function TimeClock() {
  const { isAll, selectedId, scopeLocations, select } = useLocations();
  if (isAll) {
    return (
      <div>
        <h1 style={{ marginBottom: '6px' }}>Time Clock</h1>
        <div style={{ color: 'var(--text3)', marginBottom: '16px' }}>Time clock is per-location — pick a shop:</div>
        {(scopeLocations || []).map((l) => (
          <button key={l.id} onClick={() => select(l.id)} style={{ display: 'block', marginBottom: '8px', padding: '10px 18px' }}>{l.name}</button>
        ))}
      </div>
    );
  }
  if (!selectedId) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Select a location.</div>;
  return <ClockAdmin locId={selectedId} />;
}

function ClockAdmin({ locId }) {
  const { api } = useAuth();
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [people, setPeople] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api(`/clock/${locId}/entries?month=${month}`),
      api(`/bonus/${locId}/overview?month=${month}`).catch(() => ({ people: [] })),
    ]).then(([e, ov]) => { setData(e); setPeople((ov.people || []).filter((p) => p.active)); setErr(null); })
      .catch((ex) => setErr(ex.message));
  }, [api, locId, month]);
  useEffect(() => { load(); }, [load]);

  const monthOptions = (() => {
    const now = new Date(); const out = [];
    for (let i = 0; i < 14; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 15); out.push(d.toISOString().slice(0, 7)); }
    return out;
  })();

  const setPin = async (p) => {
    const v = window.prompt(`Set kiosk PIN for ${p.name} (4–6 digits, blank to clear):`, '');
    if (v === null) return;
    setBusy(true); setErr(null);
    try { await api(`/clock/${locId}/person/${p.id}/pin`, { method: 'PUT', body: JSON.stringify({ pin: v.trim() === '' ? null : v.trim() }) }); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const saveEntry = async (id, body) => {
    setBusy(true); setErr(null);
    try { await api(`/clock/entries/${id}`, { method: 'PUT', body: JSON.stringify(body) }); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const delEntry = async (id) => {
    if (!window.confirm('Delete this punch?')) return;
    setBusy(true); setErr(null);
    try { await api(`/clock/entries/${id}`, { method: 'DELETE' }); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const addEntry = async (body) => {
    setBusy(true); setErr(null);
    try { await api(`/clock/${locId}/entries`, { method: 'POST', body: JSON.stringify(body) }); setAdding(false); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (err && !data) return <div className="card" style={{ color: 'var(--danger)' }}>{err}</div>;
  if (!data) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading…</div>;

  const summary = data.summary || {};
  const kioskUrl = `${window.location.origin}/clock/${locId}`;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' }}>
        <h1>Time Clock — {monthLabel(month)}</h1>
        <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ marginLeft: 'auto', width: 'auto' }}>
          {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '16px' }}>
        Kiosk for the shop tablet: <code>{kioskUrl}</code> — opens with the shop's display PIN, then each tech uses their own PIN. Monthly paid hours flow into the bonus.
      </div>

      {err && <div className="alert-strip" style={{ marginBottom: '12px' }}><span style={{ color: 'var(--danger)' }}>{err}</span></div>}

      {/* Per-person paid hours + PIN status */}
      <div className="card" style={{ marginBottom: '16px' }}>
        <div style={{ fontWeight: 600, marginBottom: '10px' }}>Paid hours this month</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px' }}>
          {people.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', background: 'var(--bg3)', borderRadius: '10px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: '12px', color: 'var(--text3)' }}>{summary[p.id] != null ? `${summary[p.id]} h clocked` : 'no punches — bonus uses schedule'}</div>
              </div>
              <button onClick={() => setPin(p)} disabled={busy} style={{ fontSize: '11px', padding: '4px 10px' }}>Set PIN</button>
            </div>
          ))}
        </div>
      </div>

      {/* Entries */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>Punches</span>
          <button onClick={() => setAdding(true)} style={{ marginLeft: 'auto', fontSize: '12px', padding: '5px 12px' }}>＋ Add manual entry</button>
        </div>
        {adding && <AddRow people={people} onCancel={() => setAdding(false)} onSave={addEntry} busy={busy} />}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead><tr style={{ color: 'var(--text3)', fontSize: '11px', textTransform: 'uppercase' }}>
              {['Person', 'Clock in', 'Clock out', 'Break', 'Paid', ''].map((h) => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '0.5px solid var(--border)' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {(data.entries || []).map((e) => <EntryRow key={e.id} e={e} onSave={saveEntry} onDelete={delEntry} busy={busy} />)}
              {!data.entries.length && <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)' }}>No punches this month yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function EntryRow({ e, onSave, onDelete, busy }) {
  const [edit, setEdit] = useState(false);
  const [ci, setCi] = useState(forInput(e.clock_in));
  const [co, setCo] = useState(forInput(e.clock_out));
  const [brk, setBrk] = useState(Math.round((e.break_seconds || 0) / 60));
  if (edit) {
    return (
      <tr style={{ background: 'var(--bg3)' }}>
        <td style={{ padding: '8px 12px' }}>{e.person_name}</td>
        <td style={{ padding: '8px 12px' }}><input type="datetime-local" value={ci} onChange={(ev) => setCi(ev.target.value)} /></td>
        <td style={{ padding: '8px 12px' }}><input type="datetime-local" value={co} onChange={(ev) => setCo(ev.target.value)} /></td>
        <td style={{ padding: '8px 12px' }}><input type="number" value={brk} onChange={(ev) => setBrk(ev.target.value)} style={{ width: '64px' }} /> min</td>
        <td />
        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
          <button className="primary" disabled={busy} onClick={() => onSave(e.id, { clock_in: new Date(ci).toISOString(), clock_out: co ? new Date(co).toISOString() : null, break_minutes: Number(brk) })} style={{ fontSize: '11px', padding: '3px 8px' }}>Save</button>{' '}
          <button onClick={() => setEdit(false)} style={{ fontSize: '11px', padding: '3px 8px' }}>Cancel</button>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)' }}>{e.person_name}{e.source === 'manual' ? ' ✎' : ''}</td>
      <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)' }}>{fmtDT(e.clock_in)}</td>
      <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)' }}>{e.clock_out ? fmtDT(e.clock_out) : <span style={{ color: 'var(--warning)' }}>on shift</span>}</td>
      <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)' }}>{Math.round((e.break_seconds || 0) / 60)} min</td>
      <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}>{e.paid_hours != null ? `${e.paid_hours} h` : '—'}</td>
      <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', whiteSpace: 'nowrap' }}>
        <button onClick={() => setEdit(true)} style={{ fontSize: '11px', padding: '3px 8px' }}>Edit</button>{' '}
        <button onClick={() => onDelete(e.id)} style={{ fontSize: '11px', padding: '3px 8px', color: 'var(--danger)' }}>Delete</button>
      </td>
    </tr>
  );
}

function AddRow({ people, onCancel, onSave, busy }) {
  const [pid, setPid] = useState((people[0] || {}).id || '');
  const [ci, setCi] = useState('');
  const [co, setCo] = useState('');
  const [brk, setBrk] = useState(0);
  return (
    <div style={{ padding: '12px 16px', background: 'var(--bg3)', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', borderBottom: '0.5px solid var(--border)' }}>
      <select value={pid} onChange={(e) => setPid(e.target.value)}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <label style={{ fontSize: '12px', color: 'var(--text3)' }}>In <input type="datetime-local" value={ci} onChange={(e) => setCi(e.target.value)} /></label>
      <label style={{ fontSize: '12px', color: 'var(--text3)' }}>Out <input type="datetime-local" value={co} onChange={(e) => setCo(e.target.value)} /></label>
      <label style={{ fontSize: '12px', color: 'var(--text3)' }}>Break <input type="number" value={brk} onChange={(e) => setBrk(e.target.value)} style={{ width: '60px' }} /> min</label>
      <button className="primary" disabled={busy || !pid || !ci} onClick={() => onSave({ person_id: pid, clock_in: new Date(ci).toISOString(), clock_out: co ? new Date(co).toISOString() : null, break_minutes: Number(brk) })} style={{ fontSize: '12px', padding: '5px 12px' }}>Add</button>
      <button onClick={onCancel} style={{ fontSize: '12px', padding: '5px 12px' }}>Cancel</button>
    </div>
  );
}
