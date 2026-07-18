import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { showToast, askConfirm } from './Feedback';

// "Waiting on you" rail — every decision from every page lands here. Pinned on
// the right on desktop; the topbar pill toggles it. Cards act inline: holiday
// requests approve/deny, punch changes apply/dismiss, fuel + bonus deep-link.
const fmtD = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
const fmtT = (t) => t ? new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : null;
const OFF_LABEL = { vacation: 'holiday', sick: 'sick day', unpaid: 'unpaid leave', other: 'time off' };
const monthLabel = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-CA', { month: 'long' });

// Nudge cards (fuel, bonus) can be dismissed — hidden on this device until the
// key changes (bonus keys include the month, so next month prompts fresh).
const DISMISS_KEY = 'ops_rail_dismissed';
const loadDismissed = () => { try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch { return new Set(); } };

export default function WaitingRail({ detail, api, onAction, onClose, multiLoc }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(loadDismissed);
  const dismiss = (key) => {
    const next = new Set(dismissed); next.add(key);
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
    setDismissed(next);
  };
  const { timeoff = [], edits = [] } = detail || {};
  const fuel = ((detail || {}).fuel || []).filter(r => !dismissed.has(`fuel-${r.location_id}`));
  const bonus = ((detail || {}).bonus || []).filter(b => !dismissed.has(`bonus-${b.location_id}-${b.month}`));
  const total = timeoff.length + edits.length + fuel.length;

  const act = async (fn, doneMsg) => {
    setBusy(true);
    try { await fn(); if (doneMsg) showToast(doneMsg); onAction && onAction(); }
    catch (e) { showToast(String(e.message || e), 'error'); }
    setBusy(false);
  };

  const decideOff = (r, action) => act(
    () => api(`/clock/timeoff/${r.id}/decide`, { method: 'PUT', body: JSON.stringify({ action }) }),
    action === 'approve' ? `Approved — ${r.person_name} on the calendars` : 'Request denied'
  );
  const decideEdit = (r, action) => act(
    () => api(`/clock/edit-requests/${r.id}`, { method: 'PUT', body: JSON.stringify({ action }) }),
    action === 'apply' ? `Punch corrected — ${r.person_name}` : 'Dismissed'
  );

  return (
    <div className="wr-rail">
      <div className="wr-head">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div className="wr-title">Waiting on you</div>
          <button onClick={onClose} title="Hide the rail — the ⏳ pill up top brings it back"
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: '16px', padding: '0 2px', lineHeight: 1 }}>✕</button>
        </div>
        <div className="wr-sub">{total} item{total === 1 ? '' : 's'}</div>
      </div>

      {timeoff.map((r) => (
        <div key={r.id} className="wr-card hot">
          <div className="wr-card-title">{r.person_name} — {OFF_LABEL[r.type] || r.type}</div>
          <div className="wr-card-body">
            {fmtD(r.start_date)}–{fmtD(r.end_date)} · {r.working_days} day{r.working_days === 1 ? '' : 's'}
            {r.type === 'vacation' && r.allowance != null && (
              <> · <span style={{ color: (r.vacation_used + r.working_days) > r.allowance ? 'var(--danger)' : 'var(--warning)' }}>
                {r.vacation_used + r.working_days} of {r.allowance} used</span></>
            )}
            {multiLoc && <span className="wr-loc"> · {r.location_name}</span>}
          </div>
          <div className="wr-actions">
            <button className="primary" disabled={busy} onClick={() => decideOff(r, 'approve')}>Approve</button>
            <button disabled={busy} onClick={async () => {
              if (await askConfirm({ title: 'Deny request', body: `Deny ${r.person_name}'s request for ${fmtD(r.start_date)}–${fmtD(r.end_date)}?`, confirmLabel: 'Deny', danger: true })) decideOff(r, 'deny');
            }}>Deny</button>
          </div>
        </div>
      ))}

      {edits.map((r) => (
        <div key={r.id} className="wr-card hot">
          <div className="wr-card-title">{r.person_name} — punch change</div>
          <div className="wr-card-body">
            {r.entry_id
              ? [fmtT(r.proposed_clock_in) && `in → ${fmtT(r.proposed_clock_in)}`, fmtT(r.proposed_clock_out) && `out → ${fmtT(r.proposed_clock_out)}`, r.proposed_break_minutes != null && `break → ${r.proposed_break_minutes}m`].filter(Boolean).join(' · ') || 'see note'
              : 'missing punch'}
            {r.note && <> · “{r.note}”</>}
            {multiLoc && <span className="wr-loc"> · {r.location_name}</span>}
          </div>
          <div className="wr-actions">
            <button className="primary" disabled={busy || (!r.proposed_clock_in && !r.proposed_clock_out && r.proposed_break_minutes == null)} onClick={() => decideEdit(r, 'apply')}>Apply</button>
            <button disabled={busy} onClick={() => decideEdit(r, 'dismissed')}>Dismiss</button>
          </div>
        </div>
      ))}

      {fuel.map((r) => (
        <div key={`fuel-${r.location_id}`} className="wr-card">
          <div className="wr-card-title">{r.n} unassigned fuel purchase{r.n === 1 ? '' : 's'}
            <button className="wr-x" title="Dismiss" onClick={() => dismiss(`fuel-${r.location_id}`)}>✕</button></div>
          <div className="wr-card-body">${Number(r.total).toFixed(2)} on the card, nobody assigned{multiLoc && <span className="wr-loc"> · {r.location_name}</span>}</div>
          <div className="wr-actions"><button onClick={() => navigate('/fuel-card')}>Assign →</button></div>
        </div>
      ))}

      {bonus.map((b) => (
        <div key={`bonus-${b.location_id}`} className="wr-card">
          <div className="wr-card-title">{monthLabel(b.month)} bonus{multiLoc ? ` — ${b.location_name}` : ''}
            <button className="wr-x" title="Dismiss until next month" onClick={() => dismiss(`bonus-${b.location_id}-${b.month}`)}>✕</button></div>
          <div className="wr-card-body">{b.status === 'draft' ? 'Draft is calculated — review and lock it' : 'Net profit is one number from calculating'}</div>
          <div className="wr-actions"><button onClick={() => navigate('/bonus')}>{b.status === 'draft' ? 'Review →' : 'Enter net →'}</button></div>
        </div>
      ))}

      <div className="wr-foot">Every decision from every page lands here. Approvals update payroll, the kiosk and Shopmonkey instantly.</div>
    </div>
  );
}
