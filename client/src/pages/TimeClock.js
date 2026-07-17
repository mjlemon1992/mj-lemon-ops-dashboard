import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';

// Time Clock admin (owner + that location's manager). Review the month's punches,
// fix missed/wrong ones, add a manual entry, and set each tech's kiosk PIN. The
// shop-floor kiosk lives at /clock/:locationId. Monthly paid hours feed the bonus.

const fmtDT = (t) => t ? new Date(t).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const fmtD = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
const forInput = (t) => { if (!t) return ''; const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const OFF_LABEL = { vacation: 'Holiday', sick: 'Sick', unpaid: 'Unpaid', other: 'Other' };

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
  const { api, user } = useAuth();
  const [periods, setPeriods] = useState(null);   // biweekly pay periods (techs paid biweekly)
  const [sel, setSel] = useState(null);           // selected period {from,to}
  const [data, setData] = useState(null);
  const [people, setPeople] = useState([]);
  const [timeoff, setTimeoff] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const isOwner = user?.role === 'owner';

  // Load the pay-period list once (and after an anchor change).
  const loadPeriods = useCallback(() => {
    api(`/clock/${locId}/pay-periods`).then((p) => {
      setPeriods(p);
      setSel((s) => s || (p.periods || []).find((x) => x.current) || (p.periods || [])[0] || null);
    }).catch((e) => setErr(e.message));
  }, [api, locId]);
  useEffect(() => { loadPeriods(); }, [loadPeriods]);

  const load = useCallback(() => {
    if (!sel) return;
    Promise.all([
      api(`/clock/${locId}/entries?from=${sel.from}&to=${sel.to}`),
      api(`/bonus/${locId}/overview`).catch(() => ({ people: [] })),
      api(`/clock/${locId}/timeoff`).catch(() => null),
    ]).then(([e, ov, toff]) => { setData(e); setPeople((ov.people || []).filter((p) => p.active)); setTimeoff(toff); setErr(null); })
      .catch((ex) => setErr(ex.message));
  }, [api, locId, sel]);
  useEffect(() => { load(); }, [load]);

  const setAnchor = async () => {
    const v = window.prompt('Biweekly period START date (YYYY-MM-DD) — pick the first day of any real pay period; all periods count 14 days from it:', (periods && periods.anchor) || '2026-01-04');
    if (!v) return;
    setBusy(true); setErr(null);
    try { await api(`/clock/${locId}/pay-anchor`, { method: 'PUT', body: JSON.stringify({ anchor: v.trim() }) }); setSel(null); loadPeriods(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const decide = async (r, action) => {
    if (action === 'approve' && !window.confirm(`Approve ${r.person_name}'s ${OFF_LABEL[r.type] || r.type} — ${fmtD(r.start_date)} to ${fmtD(r.end_date)} (${r.working_days} working day${r.working_days === 1 ? '' : 's'})?\n\nIt will show on the kiosk calendar and the Shopmonkey calendar, and the bonus schedule adjusts so it doesn't count against them.`)) return;
    setBusy(true); setErr(null);
    try {
      const out = await api(`/clock/timeoff/${r.id}/decide`, { method: 'PUT', body: JSON.stringify({ action }) });
      if (out.shopmonkey && /failed/.test(out.shopmonkey)) setErr(`Approved, but Shopmonkey calendar ${out.shopmonkey}`);
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const cancelOff = async (r) => {
    if (!window.confirm(`Cancel ${r.person_name}'s time off ${fmtD(r.start_date)}–${fmtD(r.end_date)}? Removes the calendar entry too.`)) return;
    setBusy(true); setErr(null);
    try { await api(`/clock/timeoff/${r.id}`, { method: 'DELETE' }); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

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

  const pending = ((timeoff || {}).requests || []).filter((r) => r.status === 'pending');
  const upcoming = ((timeoff || {}).requests || []).filter((r) => r.status === 'approved' && r.end_date >= new Date().toISOString().slice(0, 10));
  const totals = (timeoff || {}).totals || {};

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' }}>
        <h1>Time Clock</h1>
        {/* Techs are paid biweekly — payroll views run on 14-day periods. */}
        <select value={sel ? sel.from : ''} onChange={(e) => setSel((periods.periods || []).find((p) => p.from === e.target.value))} style={{ marginLeft: 'auto', width: 'auto' }}>
          {((periods || {}).periods || []).map((p) => (
            <option key={p.from} value={p.from}>{fmtD(p.from)} – {fmtD(p.to)}{p.current ? ' (current)' : ''}</option>
          ))}
        </select>
        {isOwner && <button onClick={setAnchor} disabled={busy} title="Set the biweekly cycle start date" style={{ fontSize: '12px', padding: '6px 10px' }}>⚙ Pay cycle</button>}
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '16px' }}>
        Kiosk for the shop tablet: <code>{kioskUrl}</code> — shop PIN opens it, each tech uses their own PIN to clock and to request time off. Hours feed the bonus; this page shows biweekly pay periods for payroll.
      </div>

      {err && <div className="alert-strip" style={{ marginBottom: '12px' }}><span style={{ color: 'var(--danger)' }}>{err}</span></div>}

      {/* Time-off approvals */}
      {pending.length > 0 && (
        <div className="card" style={{ marginBottom: '16px', border: '1px solid var(--warning)' }}>
          <div style={{ fontWeight: 600, marginBottom: '10px' }}>🏖 Time-off requests awaiting your decision</div>
          {pending.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', background: 'var(--bg3)', borderRadius: '10px', marginBottom: '6px' }}>
              <span style={{ fontWeight: 700 }}>{r.person_name}</span>
              <span style={{ fontSize: '13px', color: 'var(--text2)' }}>{OFF_LABEL[r.type] || r.type} · {fmtD(r.start_date)} – {fmtD(r.end_date)} · {r.working_days} working day{r.working_days === 1 ? '' : 's'}</span>
              {r.note && <span style={{ fontSize: '12px', color: 'var(--text3)', fontStyle: 'italic' }}>"{r.note}"</span>}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                <button className="primary" disabled={busy} onClick={() => decide(r, 'approve')} style={{ fontSize: '12px', padding: '5px 14px' }}>✓ Approve</button>
                <button disabled={busy} onClick={() => decide(r, 'deny')} style={{ fontSize: '12px', padding: '5px 14px', color: 'var(--danger)' }}>Deny</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Per-person paid hours (this pay period) + PIN + time off taken this year */}
      <div className="card" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
          <span style={{ fontWeight: 600 }}>Paid hours — {sel ? `${fmtD(sel.from)} – ${fmtD(sel.to)}` : 'period'} <span style={{ color: 'var(--text3)', fontWeight: 400, fontSize: '12px' }}>(biweekly pay period)</span></span>
          {(data.stat_holidays || []).length > 0 && (
            <span style={{ fontSize: '12px', color: 'var(--warning)', marginLeft: 'auto' }}>
              🎌 Stat holiday{data.stat_holidays.length > 1 ? 's' : ''} this period: {data.stat_holidays.map((h) => `${h.name} (${fmtD(h.date)})`).join(', ')}
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '10px' }}>
          {people.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', background: 'var(--bg3)', borderRadius: '10px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: '12px', color: 'var(--text3)' }}>
                  {summary[p.id] != null ? `${summary[p.id]} h this period` : 'no punches this period'}
                  {(data.off_days || {})[p.id] ? ` · 🏖 ${data.off_days[p.id]} day${data.off_days[p.id] === 1 ? '' : 's'} off this period` : ''}
                  {totals[p.id] ? ` · ${totals[p.id]} day${totals[p.id] === 1 ? '' : 's'} off this year` : ''}
                </div>
              </div>
              <button onClick={() => setPin(p)} disabled={busy} style={{ fontSize: '11px', padding: '4px 10px' }}>Set PIN</button>
            </div>
          ))}
        </div>
      </div>

      {/* Upcoming approved time off */}
      {upcoming.length > 0 && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <div style={{ fontWeight: 600, marginBottom: '10px' }}>Upcoming time off</div>
          {upcoming.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '6px 10px', borderRadius: '8px', marginBottom: '4px' }}>
              <span style={{ fontWeight: 600 }}>{r.person_name}</span>
              <span style={{ fontSize: '13px', color: 'var(--text2)' }}>{OFF_LABEL[r.type] || r.type} · {fmtD(r.start_date)} – {fmtD(r.end_date)} · <b>{r.working_days} day{r.working_days === 1 ? '' : 's'} used</b></span>
              {r.sm_appointment_id && <span style={{ fontSize: '11px', color: 'var(--text3)' }}>📅 on Shopmonkey</span>}
              <button disabled={busy} onClick={() => cancelOff(r)} style={{ marginLeft: 'auto', fontSize: '11px', padding: '3px 10px', color: 'var(--danger)' }}>Cancel</button>
            </div>
          ))}
        </div>
      )}

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
              {!data.entries.length && <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)' }}>No punches this pay period yet.</td></tr>}
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
