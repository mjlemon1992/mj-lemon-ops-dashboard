import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import PerLocationPage from '../components/PerLocationPage';
import Icon from '../components/Icon';
import { showToast, askConfirm, askInput, Skeleton } from '../components/Feedback';
import { fmtShortDate, OFF_LABEL } from '../utils/format';
import { crewPaidHours } from '../utils/pay';

// Time Clock admin (owner + that location's manager). Review the month's punches,
// fix missed/wrong ones, add a manual entry, and set each tech's kiosk PIN. The
// shop-floor kiosk lives at /clock/:locationId. Monthly paid hours feed the bonus.

const fmtDT = (t) => t ? new Date(t).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const fmtD = fmtShortDate;
// Tap anywhere in a date field to pop the native calendar (graceful fallback).
const openPicker = (e) => { try { e.target.showPicker(); } catch { /* unsupported */ } };

export default function TimeClock() {
  return <PerLocationPage>{(locId) => <ClockAdmin locId={locId} />}</PerLocationPage>;
}

function ClockAdmin({ locId }) {
  const { api, user, token } = useAuth();
  const [periods, setPeriods] = useState(null);   // biweekly pay periods (techs paid biweekly)
  const [sel, setSel] = useState(null);           // selected period {from,to}
  const [data, setData] = useState(null);
  const [people, setPeople] = useState([]);
  const [timeoff, setTimeoff] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState('punches');   // punches | crew | timeoff workspace tabs
  const isOwner = user?.role === 'owner';

  // Load the pay-period list once (and after an anchor change).
  const loadPeriods = useCallback(() => {
    api(`/clock/${locId}/pay-periods`).then((p) => {
      setPeriods(p);
      setSel((s) => s || (p.periods || []).find((x) => x.current) || (p.periods || [])[0] || null);
    }).catch((e) => setErr(e.message));
  }, [api, locId]);
  useEffect(() => { loadPeriods(); }, [loadPeriods]);

  const [allPeople, setAllPeople] = useState([]);   // incl. removed — for re-add
  const [editReqs, setEditReqs] = useState([]);     // pending timesheet-alteration requests
  const [live, setLive] = useState([]);             // who's on the clock right now (summary strip)
  const load = useCallback(() => {
    if (!sel) return;
    Promise.all([
      api(`/clock/${locId}/entries?from=${sel.from}&to=${sel.to}`),
      api(`/bonus/${locId}/overview`).catch(() => ({ people: [] })),
      api(`/clock/${locId}/timeoff`).catch(() => null),
      api(`/clock/${locId}/edit-requests`).catch(() => ({ requests: [] })),
      api(`/clock/${locId}/status`).catch(() => ({ people: [] })),
    ]).then(([e, ov, toff, er, st]) => { setData(e); setAllPeople(ov.people || []); setPeople((ov.people || []).filter((p) => p.active)); setTimeoff(toff); setEditReqs(er.requests || []); setLive(st.people || []); setErr(null); })
      .catch((ex) => setErr(ex.message));
  }, [api, locId, sel]);
  useEffect(() => { load(); }, [load]);

  const setAnchor = async () => {
    const v = await askInput({ title: 'Pay cycle', body: 'Pick the first day of any real biweekly pay period — all periods count 14 days from it.', label: 'Period start date (YYYY-MM-DD)', initial: (periods && periods.anchor) || '2026-01-04' });
    if (!v) return;
    setBusy(true); setErr(null);
    try { await api(`/clock/${locId}/pay-anchor`, { method: 'PUT', body: JSON.stringify({ anchor: v.trim() }) }); setSel(null); loadPeriods(); showToast('Pay cycle updated'); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const decide = async (r, action) => {
    if (action === 'approve' && !await askConfirm({ title: 'Approve time off', body: `${r.person_name} — ${OFF_LABEL[r.type] || r.type}, ${fmtD(r.start_date)} to ${fmtD(r.end_date)} (${r.hours} h).\n\nShows on the kiosk and Shopmonkey calendars; the bonus schedule adjusts so it doesn't count against them.`, confirmLabel: 'Approve' })) return;
    setBusy(true); setErr(null);
    try {
      const out = await api(`/clock/timeoff/${r.id}/decide`, { method: 'PUT', body: JSON.stringify({ action }) });
      if (out.shopmonkey && /failed/.test(out.shopmonkey)) setErr(`Approved, but Shopmonkey calendar ${out.shopmonkey}`);
      else showToast(action === 'approve' ? 'Approved — calendars updated' : 'Request denied');
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  // Annual holiday allowance per person, in HOURS (matches QuickBooks PTO).
  const setAllowance = async (p) => {
    const v = await askInput({ title: `Holiday allowance — ${p.name}`, body: 'Paid vacation HOURS per year (e.g. 80 = two 40-hour weeks). Stat holidays are separate. Leave blank for no allowance.', label: 'Hours per year', initial: p.vacation_hours_per_year != null ? String(p.vacation_hours_per_year) : '' });
    if (v === null) return;
    setBusy(true); setErr(null);
    try { await api(`/bonus/people/${p.id}`, { method: 'PUT', body: JSON.stringify({ vacation_hours_per_year: v.trim() === '' ? null : Number(v) }) }); load(); showToast(`Allowance saved for ${p.name}`); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Paid vs unpaid on a time-off request (asked of the tech, recorded here).
  const setPaidFlag = async (r, paid) => {
    setBusy(true); setErr(null);
    try { await api(`/clock/timeoff/${r.id}/paid`, { method: 'PUT', body: JSON.stringify({ paid }) }); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const cancelOff = async (r) => {
    const what = r.type === 'closure' ? 'the shop closure' : `${r.person_name}'s time off`;
    if (!await askConfirm({ title: 'Cancel time off', body: `Cancel ${what} ${fmtD(r.start_date)}–${fmtD(r.end_date)}? Removes the calendar entry too.`, confirmLabel: 'Cancel it', danger: true })) return;
    setBusy(true); setErr(null);
    try { await api(`/clock/timeoff/${r.id}`, { method: 'DELETE' }); load(); showToast('Time off cancelled'); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Shop shut for a stretch (holidays week, renovation): one booking covers the
  // whole crew — shows on both calendars, adjusts the bonus, and doesn't touch
  // anyone's personal days-off total. Calendar-picker form, not prompts.
  const [closure, setClosure] = useState(null);   // {start, end, note} while the form is open
  const bookClosure = async () => {
    if (!closure || !closure.start || !closure.end) { setErr('Pick the first and last closed day'); return; }
    setBusy(true); setErr(null);
    try {
      const out = await api(`/clock/${locId}/closure`, { method: 'POST', body: JSON.stringify({ start_date: closure.start, end_date: closure.end, note: closure.note || '' }) });
      if (out.shopmonkey && /failed/.test(out.shopmonkey)) setErr(`Closure booked, but Shopmonkey calendar ${out.shopmonkey}`);
      setClosure(null);
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // One-tap: put this year's remaining stat holidays on the Shopmonkey calendar.
  const [holNote, setHolNote] = useState(null);
  const syncHolidays = async () => {
    setBusy(true); setErr(null); setHolNote(null);
    try {
      const out = await api(`/clock/${locId}/sync-holidays`, { method: 'POST' });
      setHolNote(`${out.pushed.length ? out.pushed.length + ' added to Shopmonkey (' + out.pushed.join(', ') + ')' : 'Nothing new to add'}${out.already ? ` · ${out.already} already there` : ''}${out.failed.length ? ` · failed: ${out.failed.join('; ')}` : ''}`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const setPin = async (p) => {
    const v = await askInput({ title: `Kiosk PIN — ${p.name}`, label: 'PIN (4–6 digits, blank to clear)', type: 'tel' });
    if (v === null) return;
    setBusy(true); setErr(null);
    try { await api(`/clock/${locId}/person/${p.id}/pin`, { method: 'PUT', body: JSON.stringify({ pin: v.trim() === '' ? null : v.trim() }) }); load(); showToast(v.trim() === '' ? `PIN cleared for ${p.name}` : `PIN set for ${p.name}`); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Punch-list filter: one tech or the whole crew.
  const [personFilter, setPersonFilter] = useState('all');

  // Crew management from the clock side: add someone so they can punch (clock-
  // only by default — probation hires clock in without joining the bonus),
  // remove leavers, re-add returners.
  const [addingPerson, setAddingPerson] = useState(null);   // {name, role, in_bonus} while form open
  const addPerson = async () => {
    if (!addingPerson || !addingPerson.name.trim()) { setErr('Enter a name'); return; }
    setBusy(true); setErr(null);
    try {
      await api(`/bonus/${locId}/people`, { method: 'POST', body: JSON.stringify({ name: addingPerson.name.trim(), role: addingPerson.role, in_bonus: !!addingPerson.in_bonus }) });
      setAddingPerson(null); load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const setPersonActive = async (p, active) => {
    if (!active && !await askConfirm({ title: `Remove ${p.name}`, body: "Their punch history stays; they just can't clock in until re-added.", confirmLabel: 'Remove', danger: true })) return;
    setBusy(true); setErr(null);
    try { await api(`/bonus/people/${p.id}`, { method: 'PUT', body: JSON.stringify({ active }) }); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Photo fallback: owner/manager uploads a picture when the kiosk camera
  // isn't an option. Client shrinks to 256px JPEG first (same as the kiosk).
  const uploadPhoto = (p) => new Promise(() => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const img = new Image();
        img.onload = async () => {
          const s = Math.min(img.width, img.height);
          const canvas = document.createElement('canvas');
          canvas.width = 256; canvas.height = 256;
          canvas.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
          URL.revokeObjectURL(img.src);
          const b64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
          setBusy(true); setErr(null);
          try { await api(`/clock/${locId}/person/${p.id}/photo`, { method: 'PUT', body: JSON.stringify({ photo_base64: b64, photo_mime: 'image/jpeg' }) }); load(); }
          catch (e) { setErr(e.message); }
          setBusy(false);
        };
        img.src = URL.createObjectURL(f);
      } catch { setErr('Could not read that image'); }
    };
    inp.click();
  });

  const resolveEditReq = async (r, action) => {
    setBusy(true); setErr(null);
    try { await api(`/clock/edit-requests/${r.id}`, { method: 'PUT', body: JSON.stringify({ action }) }); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Period exports: the current tech/period selection as a PDF — download or email.
  const exportPdf = async () => {
    setErr(null);
    try {
      const res = await fetch(`/api/clock/${locId}/export-pdf?from=${sel.from}&to=${sel.to}&person=${personFilter}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `timesheet-${sel.from}-to-${sel.to}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { setErr(e.message); }
  };
  const emailPdf = async () => {
    const to = await askInput({ title: 'Email timesheet', label: 'Send the PDF to', initial: user?.email || '', type: 'email' });
    if (!to) return;
    setBusy(true); setErr(null);
    try {
      const out = await api(`/clock/${locId}/email-timesheet`, { method: 'POST', body: JSON.stringify({ from: sel.from, to: sel.to, person: personFilter, email: to.trim() }) });
      setHolNote(`Timesheet PDF sent to ${out.sent_to}`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Returns true on success so the edit row can close itself.
  const saveEntry = async (id, body) => {
    setBusy(true); setErr(null);
    try { await api(`/clock/entries/${id}`, { method: 'PUT', body: JSON.stringify(body) }); load(); setBusy(false); return true; }
    catch (e) { setErr(e.message); setBusy(false); return false; }
  };
  const delEntry = async (id) => {
    if (!await askConfirm({ title: 'Delete punch', body: 'This removes the punch permanently.', confirmLabel: 'Delete', danger: true })) return;
    setBusy(true); setErr(null);
    try { await api(`/clock/entries/${id}`, { method: 'DELETE' }); load(); showToast('Punch deleted'); }
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
  if (!data) return <Skeleton rows={6} height={18} />;

  const summary = data.summary || {};
  const kioskUrl = `${window.location.origin}/clock/${locId}`;

  // Punch list under the current filters, plus payroll totals for it.
  const shown = (data.entries || []).filter((e) => personFilter === 'all' || e.person_id === personFilter);
  const totBreakMin = Math.round(shown.reduce((s, e) => s + (e.break_seconds || 0), 0) / 60);
  const totPaid = Math.round(shown.reduce((s, e) => s + (e.paid_hours != null ? Number(e.paid_hours) : 0), 0) * 100) / 100;
  const openShifts = shown.filter((e) => !e.clock_out).length;
  // Holidays and stat days appear as rows in the punch list too — payroll reads
  // one table. Both respect the tech filter; the footer adds them in.
  const nameOf = (pid) => (people.find((p) => p.id === pid) || {}).name || '—';
  const holidayRows = (data.paid_timeoff_rows || []).filter((r) => personFilter === 'all' || r.person_id === personFilter);
  const statRows = data.stat_pay_days || [];
  const statPer = Number(data.stat_pay_hours || 0);
  const holidayTot = Math.round(holidayRows.reduce((s, r) => s + Number(r.hours), 0) * 100) / 100;
  const statTot = Math.round(statPer * (personFilter === 'all' ? people.length : 1) * 100) / 100;
  const grandPaid = Math.round((totPaid + holidayTot + statTot) * 100) / 100;

  const pending = ((timeoff || {}).requests || []).filter((r) => r.status === 'pending');
  const upcoming = ((timeoff || {}).requests || []).filter((r) => r.status === 'approved' && r.end_date >= new Date().toISOString().slice(0, 10));
  const totals = (timeoff || {}).totals || {};

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
        <a href={kioskUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
          <button style={{ fontSize: '12px', padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="external" size={13} /> Open kiosk</button>
        </a>
        <button onClick={() => { navigator.clipboard && navigator.clipboard.writeText(kioskUrl); setHolNote('Kiosk link copied'); setTimeout(() => setHolNote(''), 2500); }}
          title={kioskUrl} style={{ fontSize: '12px', padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="copy" size={13} /> Copy link</button>
        <span style={{ marginLeft: 'auto' }} />
        {isOwner && <button onClick={setAnchor} disabled={busy} title="Set the biweekly cycle start date" style={{ fontSize: '12px', padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="gear" size={13} /> Pay cycle</button>}
        <button onClick={() => { setTab('timeoff'); setClosure(closure ? null : { start: '', end: '', note: '' }); }} disabled={busy} title="Book a shop-wide closure period" style={{ fontSize: '12px', padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="calendar" size={13} /> Book closure</button>
        <button onClick={syncHolidays} disabled={busy} title="Put this year's stat holidays on the Shopmonkey calendar" style={{ fontSize: '12px', padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="flag" size={13} /> Holidays → Shopmonkey</button>
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '16px' }}>
        The shop tablet runs the kiosk — shop PIN opens it, each tech uses their own PIN to clock in/out and request time off. Hours feed the bonus; this page shows biweekly pay periods for payroll.
      </div>

      {err && <div className="alert-strip" style={{ marginBottom: '12px' }}><span style={{ color: 'var(--danger)' }}>{err}</span></div>}
      {holNote && <div style={{ fontSize: '12px', color: 'var(--success)', marginBottom: '12px' }}>{holNote}</div>}

      {/* The period at a glance — one compact strip, always visible up top */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {(() => {
          const holAll = Object.values(data.paid_timeoff_hours || {}).reduce((s, v) => s + Number(v || 0), 0);
          const crewPaid = crewPaidHours(data, people.length);
          const breaksH = Math.round((data.entries || []).reduce((s, e) => s + (e.break_seconds || 0), 0) / 36) / 100;
          const onNow = live.filter((p) => p.status !== 'off').length;
          const mini = { minWidth: '128px', padding: '10px 14px', opacity: (crewPaid === 0 && onNow === 0) ? 0.55 : 1 };
          return (<>
            <div className="metric-card" style={mini}><div className="metric-label">Crew paid</div><div className="metric-value" style={{ fontSize: '20px' }}>{crewPaid} h</div></div>
            <div className="metric-card" style={mini}><div className="metric-label">Breaks</div><div className="metric-value" style={{ fontSize: '20px' }}>{breaksH} h</div></div>
            <div className="metric-card" style={mini}><div className="metric-label">Stat pay</div><div className="metric-value" style={{ fontSize: '20px' }}>{Number(data.stat_pay_hours || 0)} h</div></div>
            <div className="metric-card" style={mini}><div className="metric-label">Paid holiday</div><div className="metric-value" style={{ fontSize: '20px' }}>{Math.round(holAll * 100) / 100} h</div></div>
            <div className="metric-card" style={mini}><div className="metric-label">On the clock</div><div className="metric-value" style={{ fontSize: '20px', color: onNow ? 'var(--success)' : undefined }}>{onNow} <span style={{ fontSize: '12px', color: 'var(--text2)', fontWeight: 500 }}>of {live.length || people.length}</span></div></div>
          </>);
        })()}
      </div>

      {/* Workspace tabs — the page was one long scroll; related blocks now live together */}
      <div className="tc-tabs">
        {[['punches', 'Punches'], ['crew', 'Crew'], ['timeoff', 'Time off']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'tc-tab active' : 'tc-tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {/* Closure booking — calendar pickers, one booking covers the whole crew */}
      {closure && (
        <div className="card" style={{ marginBottom: '16px', border: '1px solid var(--danger)' }}>
          <div style={{ fontWeight: 600, marginBottom: '8px' }}>Book a shop closure</div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--text3)' }}>First closed day
              <input type="date" value={closure.start} onClick={openPicker} onFocus={openPicker}
                onChange={(e) => setClosure((c) => ({ ...c, start: e.target.value, end: c.end || e.target.value }))} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--text3)' }}>Last closed day
              <input type="date" value={closure.end} min={closure.start} onClick={openPicker} onFocus={openPicker}
                onChange={(e) => setClosure((c) => ({ ...c, end: e.target.value }))} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--text3)', flex: 1, minWidth: '200px' }}>What for
              <input placeholder="e.g. Christmas shutdown, renovation" value={closure.note}
                onChange={(e) => setClosure((c) => ({ ...c, note: e.target.value }))} />
            </label>
            <button className="primary" disabled={busy || !closure.start || !closure.end} onClick={bookClosure} style={{ padding: '8px 18px' }}>Book closure</button>
            <button onClick={() => setClosure(null)} style={{ padding: '8px 14px' }}>Cancel</button>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '8px' }}>
            Shows CLOSED on the kiosk calendar and the Shopmonkey calendar, counts in payroll, adjusts everyone's bonus schedule — and doesn't use anyone's personal days off.
          </div>
        </div>
      )}

      {/* Needs attention — holiday approvals + timesheet change requests, one card */}
      {(pending.length > 0 || editReqs.length > 0) && (
        <div className="card" style={{ marginBottom: '16px', border: '1px solid var(--warning)' }}>
          <div style={{ fontWeight: 600, marginBottom: '10px' }}>Needs attention <span style={{ color: 'var(--text3)', fontWeight: 400, fontSize: '12px' }}>· {pending.length + editReqs.length} item{pending.length + editReqs.length === 1 ? '' : 's'}</span></div>
          {pending.map((r) => {
            // Allowance check: what would approving this vacation leave them at?
            const person = people.find((p) => p.id === r.person_id);
            const allowance = person && person.vacation_hours_per_year;
            const used = ((timeoff || {}).vacation_used || {})[r.person_id] || 0;
            const wouldBe = Math.round((used + (r.hours || 0)) * 10) / 10;
            const over = r.type === 'vacation' && allowance != null && wouldBe > allowance;
            return (
            <div key={r.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', background: 'var(--bg3)', borderRadius: '10px', marginBottom: '6px', border: over ? '1px solid var(--danger)' : 'none' }}>
              <span style={{ fontWeight: 700 }}>{r.person_name}</span>
              <span style={{ fontSize: '13px', color: 'var(--text2)' }}>{OFF_LABEL[r.type] || r.type} · {fmtD(r.start_date)} – {fmtD(r.end_date)} · <b>{r.hours} h</b></span>
              {r.type === 'vacation' && allowance != null && (
                <span style={{ fontSize: '12px', fontWeight: 700, color: over ? 'var(--danger)' : 'var(--success)' }}>
                  {over ? `⚠ exceeds allowance by ${Math.round((wouldBe - allowance) * 10) / 10} h (${wouldBe}/${allowance} h)` : `would use ${wouldBe} of ${allowance} h`}
                </span>
              )}
              {r.note && <span style={{ fontSize: '12px', color: 'var(--text3)', fontStyle: 'italic' }}>"{r.note}"</span>}
              {/* Paid or unpaid — the tech chose on the kiosk; flip it here after talking to them */}
              <button disabled={busy} onClick={() => setPaidFlag(r, !(r.paid === true))}
                style={{ fontSize: '11px', padding: '4px 10px', fontWeight: 700, color: r.paid === true ? 'var(--success)' : r.paid === false ? 'var(--text3)' : 'var(--warning)' }}>
                {r.paid === true ? 'PAID' : r.paid === false ? 'UNPAID' : '❓ paid? tap to set'}
              </button>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                <button className="primary" disabled={busy} onClick={() => decide(r, 'approve')} style={{ fontSize: '12px', padding: '5px 14px' }}>✓ Approve</button>
                <button disabled={busy} onClick={() => decide(r, 'deny')} style={{ fontSize: '12px', padding: '5px 14px', color: 'var(--danger)' }}>Deny</button>
              </span>
            </div>
            );
          })}
          {/* change requests flow in the same card, under the holiday items */}
          {editReqs.map((r) => {
            const hasProposal = r.proposed_clock_in || r.proposed_clock_out || r.proposed_break_minutes != null;
            return (
              <div key={r.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', background: 'var(--bg3)', borderRadius: '10px', marginBottom: '6px' }}>
                <span style={{ fontWeight: 700 }}>{r.person_name}</span>
                <span style={{ fontSize: '13px', color: 'var(--text2)' }}>
                  {r.entry_id ? `Punch ${fmtDT(r.clock_in)}${r.clock_out ? ` → ${fmtDT(r.clock_out)}` : ''}` : 'Missing punch'}
                </span>
                <span style={{ fontSize: '13px', fontStyle: 'italic', color: 'var(--text2)' }}>"{r.note}"</span>
                {hasProposal && (
                  <span style={{ fontSize: '13px', color: 'var(--accent)', fontWeight: 600 }}>
                    proposes {r.proposed_clock_in ? fmtDT(r.proposed_clock_in) : '—'} → {r.proposed_clock_out ? fmtDT(r.proposed_clock_out) : '—'}
                    {r.proposed_break_minutes != null ? ` · break ${r.proposed_break_minutes} min` : ''}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                  {hasProposal && <button className="primary" disabled={busy} onClick={() => resolveEditReq(r, 'apply')} title="Apply the proposed times and mark resolved" style={{ fontSize: '12px', padding: '5px 12px' }}>✓ Apply & resolve</button>}
                  <button disabled={busy} onClick={() => resolveEditReq(r, 'resolved')} title="Mark done after fixing the punch by hand below" style={{ fontSize: '12px', padding: '5px 12px' }}>Resolved</button>
                  <button disabled={busy} onClick={() => resolveEditReq(r, 'dismissed')} style={{ fontSize: '12px', padding: '5px 12px', color: 'var(--danger)' }}>Dismiss</button>
                </span>
              </div>
            );
          })}
          <div style={{ fontSize: '11px', color: 'var(--text3)' }}>"Apply & resolve" uses the tech's proposed times in one tap; otherwise fix the punch below and mark resolved.</div>
        </div>
      )}

      {/* Per-person paid hours (this pay period) + PIN + time off taken this year */}
      {tab === 'crew' && (
      <div className="card" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
          <span style={{ fontWeight: 600 }}>Paid hours — {sel ? `${fmtD(sel.from)} – ${fmtD(sel.to)}` : 'period'} <span style={{ color: 'var(--text3)', fontWeight: 400, fontSize: '12px' }}>(biweekly pay period)</span></span>
          <button onClick={() => setAddingPerson(addingPerson ? null : { name: '', role: 'tech', in_bonus: false })} disabled={busy} style={{ fontSize: '11px', padding: '3px 10px' }} title="Add a technician to the time clock"><Icon name="plus" size={11} /> Add technician</button>
          <span style={{ fontSize: '12px', marginLeft: 'auto', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
            {(data.closure_days || 0) > 0 && <span style={{ color: 'var(--danger)' }}>🚪 Shop closed {data.closure_days} day{data.closure_days === 1 ? '' : 's'} this period</span>}
            {(data.stat_holidays || []).length > 0 && (
              <span style={{ color: 'var(--warning)' }}>
                🎌 Stat holiday{data.stat_holidays.length > 1 ? 's' : ''}: {data.stat_holidays.map((h) => `${h.name} (${fmtD(h.date)})`).join(', ')}
              </span>
            )}
          </span>
        </div>
        {addingPerson && (
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: 'var(--bg3)', borderRadius: '10px', marginBottom: '10px' }}>
            <input autoFocus placeholder="Name (as in Shopmonkey)" value={addingPerson.name} onChange={(e) => setAddingPerson((s) => ({ ...s, name: e.target.value }))} style={{ width: '190px' }} />
            <select value={addingPerson.role} onChange={(e) => setAddingPerson((s) => ({ ...s, role: e.target.value }))}>
              <option value="tech">Tech</option><option value="advisor">Advisor</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!addingPerson.in_bonus} onChange={(e) => setAddingPerson((s) => ({ ...s, in_bonus: e.target.checked }))} />
              also in the bonus program
            </label>
            <button className="primary" disabled={busy} onClick={addPerson} style={{ fontSize: '12px', padding: '5px 14px' }}>Add</button>
            <button onClick={() => setAddingPerson(null)} style={{ fontSize: '12px', padding: '5px 12px' }}>Cancel</button>
            <span style={{ fontSize: '11px', color: 'var(--text3)', flexBasis: '100%' }}>Unticked = clock-only (probation): they punch in/out and request time off, but stay out of the profit-share until you include them.</span>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '10px' }}>
          {people.map((p) => {
            const clocked = summary[p.id] != null ? Number(summary[p.id]) : 0;
            const stat = Number(data.stat_pay_hours || 0);
            const holiday = Number((data.paid_timeoff_hours || {})[p.id] || 0);
            const totalPay = Math.round((clocked + stat + holiday) * 100) / 100;
            return (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', background: 'var(--bg3)', borderRadius: '10px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{p.name}{p.in_bonus === false && <span style={{ fontSize: '10px', color: 'var(--text3)', fontWeight: 400 }}> · clock only</span>}
                  {(stat > 0 || holiday > 0 || clocked > 0) && <span style={{ float: 'right', fontVariantNumeric: 'tabular-nums' }}>{totalPay} h</span>}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text3)' }}>
                  {clocked ? `${clocked} h clocked` : 'no punches'}
                  {stat > 0 ? ` + ${stat} h stat` : ''}
                  {holiday > 0 ? ` + ${holiday} h paid holiday` : ''}
                  {(data.off_days || {})[p.id] ? ` · 🏖 ${data.off_days[p.id]} day${data.off_days[p.id] === 1 ? '' : 's'} off` : ''}
                  {p.vacation_hours_per_year != null
                    ? <span style={{ color: (((timeoff || {}).vacation_used || {})[p.id] || 0) > p.vacation_hours_per_year ? 'var(--danger)' : 'var(--text3)' }}> · holidays {((timeoff || {}).vacation_used || {})[p.id] || 0}/{p.vacation_hours_per_year} h</span>
                    : (totals[p.id] ? ` · ${totals[p.id]} day${totals[p.id] === 1 ? '' : 's'} this year` : '')}
                </div>
              </div>
              <button onClick={() => setAllowance(p)} disabled={busy} title="Set annual holiday allowance (hours/year)" style={{ fontSize: '11px', padding: '4px 8px' }}><Icon name="sun" size={12} /></button>
              <button onClick={() => setPin(p)} disabled={busy} title="Set kiosk PIN" style={{ fontSize: '11px', padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Icon name="key" size={12} /> PIN</button>
              <button onClick={() => uploadPhoto(p)} disabled={busy} title="Upload a profile photo" style={{ fontSize: '11px', padding: '4px 8px' }}><Icon name="camera" size={12} /></button>
              <button onClick={() => setPersonActive(p, false)} disabled={busy} title="Remove from the time clock" style={{ fontSize: '11px', padding: '4px 8px', color: 'var(--danger)', borderColor: 'rgba(255,77,77,0.4)', marginLeft: '10px' }}><Icon name="x" size={12} /></button>
            </div>
            );
          })}
        </div>
        {allPeople.some((p) => !p.active) && (
          <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '10px' }}>
            Removed:{' '}
            {allPeople.filter((p) => !p.active).map((p) => (
              <button key={p.id} onClick={() => setPersonActive(p, true)} disabled={busy} style={{ fontSize: '11px', padding: '2px 10px', marginRight: '6px' }}>↩ {p.name}</button>
            ))}
          </div>
        )}
      </div>
      )}

      {/* Entries — filterable by technician and pay period. */}
      {tab === 'punches' && (
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>Punches</span>
          <select value={personFilter} onChange={(e) => setPersonFilter(e.target.value)} style={{ width: 'auto', fontSize: '13px' }}>
            <option value="all">All technicians</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={sel ? sel.from : ''} onChange={(e) => setSel((periods.periods || []).find((p) => p.from === e.target.value))} style={{ width: 'auto', fontSize: '13px' }}>
            {((periods || {}).periods || []).map((p) => (
              <option key={p.from} value={p.from}>{fmtD(p.from)} – {fmtD(p.to)}{p.current ? ' (current)' : ''}</option>
            ))}
          </select>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            <button onClick={exportPdf} disabled={busy || !sel} title="Download this selection as a PDF" style={{ fontSize: '12px', padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="download" size={13} /> PDF</button>
            <button onClick={emailPdf} disabled={busy || !sel} title="Email this selection as a PDF" style={{ fontSize: '12px', padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="mail" size={13} /> Email</button>
            <button onClick={() => setAdding(true)} style={{ fontSize: '12px', padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="plus" size={13} /> Add manual entry</button>
          </span>
        </div>
        {adding && <AddRow people={people} onCancel={() => setAdding(false)} onSave={addEntry} busy={busy} />}
        <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead><tr style={{ color: 'var(--text3)', fontSize: '11px', textTransform: 'uppercase' }}>
              {['Person', 'Clock in', 'Clock out', 'Break', 'Paid', ''].map((h) => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '0.5px solid var(--border)' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {shown.map((e) => <EntryRow key={e.id} e={e} onSave={saveEntry} onDelete={delEntry} busy={busy} />)}
              {/* Paid holidays in this period — read-only pay rows */}
              {holidayRows.map((r, i) => (
                <tr key={'hol' + i} style={{ background: 'rgba(255,184,0,0.06)' }}>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', fontWeight: 600 }}>{nameOf(r.person_id)}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', color: 'var(--warning)' }}>🏖 Paid holiday</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', color: 'var(--text2)' }}>{fmtD(r.from)} – {fmtD(r.to)} ({r.days} day{r.days === 1 ? '' : 's'})</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', color: 'var(--text3)' }}>—</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}>{r.hours} h</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', fontSize: '11px', color: 'var(--text3)' }}>from approved request</td>
                </tr>
              ))}
              {/* Stat holidays — paid to the whole crew (or the filtered tech) */}
              {statRows.map((h, i) => (
                <tr key={'stat' + i} style={{ background: 'rgba(10,132,255,0.06)' }}>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', fontWeight: 600 }}>{personFilter === 'all' ? 'Everyone' : nameOf(personFilter)}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', color: 'var(--accent)' }}>🎌 {h.name}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', color: 'var(--text2)' }}>{fmtD(h.date)}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', color: 'var(--text3)' }}>—</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}>{statPer} h{personFilter === 'all' ? ' each' : ''}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', fontSize: '11px', color: 'var(--text3)' }}>stat holiday pay</td>
                </tr>
              ))}
              {!shown.length && !holidayRows.length && !statRows.length &&
                <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)' }}>No punches {personFilter === 'all' ? 'this pay period' : 'for this technician in this pay period'} yet.</td></tr>}
            </tbody>
            {(shown.length > 0 || holidayRows.length > 0 || statRows.length > 0) && (
              <tfoot>
                <tr style={{ fontWeight: 700, background: 'var(--bg3)' }}>
                  <td style={{ padding: '10px 12px' }}>
                    Total — {personFilter === 'all' ? 'all technicians' : (people.find((p) => p.id === personFilter) || {}).name}
                    <span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: '11px' }}> · {shown.length} punch{shown.length === 1 ? '' : 'es'}{openShifts ? ` (${openShifts} still on shift)` : ''}</span>
                  </td>
                  <td /><td />
                  <td style={{ padding: '10px 12px' }}>{totBreakMin} min</td>
                  <td style={{ padding: '10px 12px', fontVariantNumeric: 'tabular-nums' }}>
                    {grandPaid} h
                    {(holidayTot > 0 || statTot > 0) && <span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: '11px' }}> ({totPaid} clocked{statTot ? ` + ${statTot} stat` : ''}{holidayTot ? ` + ${holidayTot} holiday` : ''})</span>}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
      )}

      {/* Upcoming approved time off */}
      {tab === 'timeoff' && upcoming.length === 0 && !closure && (
        <div className="card" style={{ color: 'var(--text3)', textAlign: 'center', padding: '28px' }}>
          No upcoming time off. Techs request holidays from the kiosk; approvals appear here and in "Needs attention".
        </div>
      )}
      {tab === 'timeoff' && upcoming.length > 0 && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <div style={{ fontWeight: 600, marginBottom: '10px' }}>Upcoming time off</div>
          {upcoming.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '6px 10px', borderRadius: '8px', marginBottom: '4px' }}>
              <span style={{ fontWeight: 600 }}>{r.type === 'closure' ? 'Shop closed' : r.person_name}</span>
              <span style={{ fontSize: '13px', color: 'var(--text2)' }}>{r.type === 'closure' ? '' : (OFF_LABEL[r.type] || r.type) + ' · '}{fmtD(r.start_date)} – {fmtD(r.end_date)} · <b>{r.type === 'closure' ? `${r.working_days} day${r.working_days === 1 ? '' : 's'}` : `${r.hours} h`}</b></span>
              {r.type !== 'closure' && (
                <button disabled={busy} onClick={() => setPaidFlag(r, !(r.paid === true))}
                  style={{ fontSize: '11px', padding: '3px 10px', fontWeight: 700, color: r.paid === true ? 'var(--success)' : r.paid === false ? 'var(--text3)' : 'var(--warning)' }}>
                  {r.paid === true ? '💰 PAID' : r.paid === false ? 'UNPAID' : 'paid?'}
                </button>
              )}
              {r.sm_appointment_id && <span style={{ fontSize: '11px', color: 'var(--text3)' }}>on Shopmonkey ✓</span>}
              <button disabled={busy} onClick={() => cancelOff(r)} style={{ marginLeft: 'auto', fontSize: '11px', padding: '3px 10px', color: 'var(--danger)' }}>Cancel</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Date + time picker with an explicit AM/PM control — tapping the date pops the
// calendar; hour/minute/AM-PM are big dropdowns (no 24h guessing on the tablet).
const p2 = (n) => String(n).padStart(2, '0');
function DTPicker({ value, onChange }) {
  const d = value ? new Date(value) : null;
  const dateStr = d ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : '';
  const h24 = d ? d.getHours() : 8;
  const ap = h24 >= 12 ? 'PM' : 'AM';
  const h12 = ((h24 + 11) % 12) + 1;
  const min = d ? d.getMinutes() : 0;
  const emit = (ds, h, m, a) => {
    if (!ds) { onChange(null); return; }
    const hh = (Number(h) % 12) + (a === 'PM' ? 12 : 0);
    onChange(new Date(`${ds}T${p2(hh)}:${p2(m)}:00`).toISOString());
  };
  return (
    <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="date" value={dateStr} onClick={openPicker} onFocus={openPicker}
        onChange={(ev) => emit(ev.target.value, h12, min, ap)} style={{ width: '130px' }} />
      <select value={h12} disabled={!dateStr} onChange={(ev) => emit(dateStr, ev.target.value, min, ap)} style={{ width: 'auto' }}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <span>:</span>
      <select value={min} disabled={!dateStr} onChange={(ev) => emit(dateStr, h12, ev.target.value, ap)} style={{ width: 'auto' }}>
        {Array.from({ length: 60 }, (_, i) => i).map((m) => <option key={m} value={m}>{p2(m)}</option>)}
      </select>
      <select value={ap} disabled={!dateStr} onChange={(ev) => emit(dateStr, h12, min, ev.target.value)} style={{ width: 'auto', fontWeight: 600 }}>
        <option>AM</option><option>PM</option>
      </select>
    </span>
  );
}

function EntryRow({ e, onSave, onDelete, busy }) {
  const [edit, setEdit] = useState(false);
  const [ci, setCi] = useState(e.clock_in);
  const [co, setCo] = useState(e.clock_out);
  const [brk, setBrk] = useState(Math.round((e.break_seconds || 0) / 60));
  const [paid, setPaid] = useState(e.paid_hours != null ? String(e.paid_hours) : '');
  const beginEdit = () => { setCi(e.clock_in); setCo(e.clock_out); setBrk(Math.round((e.break_seconds || 0) / 60)); setPaid(e.paid_hours != null ? String(e.paid_hours) : ''); setEdit(true); };
  const save = async () => {
    const body = { clock_in: ci, clock_out: co || null, break_minutes: Number(brk) };
    // Paid edited? Send it — the server keeps the punch times and back-computes
    // the break so paid = (out − in) − break stays true.
    if (paid !== '' && Number(paid) !== Number(e.paid_hours)) body.paid_hours = Number(paid);
    const ok = await onSave(e.id, body);
    if (ok) setEdit(false);   // save lands you back on the normal list — no extra Cancel click
  };
  if (edit) {
    return (
      <tr style={{ background: 'var(--bg3)' }}>
        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{e.person_name}</td>
        <td style={{ padding: '8px 12px' }}><DTPicker value={ci} onChange={setCi} /></td>
        <td style={{ padding: '8px 12px' }}><DTPicker value={co} onChange={setCo} /></td>
        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}><input type="number" min="0" value={brk} onChange={(ev) => setBrk(ev.target.value)} style={{ width: '64px' }} /> min</td>
        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
          {e.clock_out ? <><input type="number" min="0" step="0.25" value={paid} onChange={(ev) => setPaid(ev.target.value)} style={{ width: '72px' }} /> h</> : '—'}
        </td>
        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
          <button className="primary" disabled={busy} onClick={save} style={{ fontSize: '11px', padding: '3px 8px' }}>Save</button>{' '}
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
      <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)' }}
        title={Array.isArray(e.breaks) && e.breaks.length ? e.breaks.map((b) => `${fmtDT(b.start)} → ${b.end ? fmtDT(b.end) : 'open'}`).join('\n') : undefined}>
        {Math.round((e.break_seconds || 0) / 60)} min{Array.isArray(e.breaks) && e.breaks.length > 1 ? ` (${e.breaks.length})` : ''}
      </td>
      <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}>{e.paid_hours != null ? `${e.paid_hours} h` : '—'}</td>
      <td style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', whiteSpace: 'nowrap' }}>
        <button onClick={beginEdit} style={{ fontSize: '11px', padding: '3px 8px' }}>Edit</button>{' '}
        <button onClick={() => onDelete(e.id)} style={{ fontSize: '11px', padding: '3px 8px', color: 'var(--danger)' }}>Delete</button>
      </td>
    </tr>
  );
}

function AddRow({ people, onCancel, onSave, busy }) {
  const [pid, setPid] = useState((people[0] || {}).id || '');
  const [ci, setCi] = useState(null);
  const [co, setCo] = useState(null);
  const [brk, setBrk] = useState(0);
  return (
    <div style={{ padding: '12px 16px', background: 'var(--bg3)', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end', borderBottom: '0.5px solid var(--border)' }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--text3)' }}>Technician
        <select value={pid} onChange={(e) => setPid(e.target.value)}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--text3)' }}>Clock in
        <DTPicker value={ci} onChange={setCi} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--text3)' }}>Clock out
        <DTPicker value={co} onChange={setCo} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--text3)' }}>Break (min)
        <input type="number" min="0" value={brk} onChange={(e) => setBrk(e.target.value)} style={{ width: '70px' }} />
      </label>
      <button className="primary" disabled={busy || !pid || !ci} onClick={() => onSave({ person_id: pid, clock_in: ci, clock_out: co || null, break_minutes: Number(brk) })} style={{ fontSize: '12px', padding: '6px 14px' }}>Add</button>
      <button onClick={onCancel} style={{ fontSize: '12px', padding: '6px 14px' }}>Cancel</button>
    </div>
  );
}
