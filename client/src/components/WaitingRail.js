import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocations } from '../context/LocationContext';
import { useAuth } from '../context/AuthContext';
import { showToast, askConfirm } from './Feedback';
import { fmtShortDate, fmtClock, monthLabel, money, OFF_LABEL } from '../utils/format';

// "Waiting on you" rail — every decision from every page lands here. Pinned on
// the right on desktop; the topbar pill toggles it. Cards act inline: holiday
// requests approve/deny, punch changes apply/dismiss, fuel + bonus deep-link.
const fmtD = fmtShortDate;
const fmtT = fmtClock;

export default function WaitingRail({ detail, api, onAction, onClose, onDismiss, multiLoc }) {
  const navigate = useNavigate();
  const { select } = useLocations();
  const { user } = useAuth();
  const ownerish = ['owner', 'partner'].includes(user?.role);
  const [busy, setBusy] = useState(false);
  const dismiss = (key) => onDismiss && onDismiss(key);
  const { timeoff = [], edits = [], fuel = [], reorders = [], clockq = [], bonus = [] } = detail || {};
  const total = timeoff.length + edits.length + fuel.length + reorders.length + clockq.length + bonus.length;
  // Deep-links must land on the card's own shop, not whatever is globally selected.
  const goTo = (locationId, path) => { select(locationId); navigate(path); };

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
  const decideReorder = (r, action) => act(
    () => api(`/clock/reorder/${r.id}`, { method: 'PUT', body: JSON.stringify({ action }) }),
    action === 'ordered' ? `Ordered — ${r.item}` : action === 'received' ? `Received — ${r.item} cleared` : 'Dismissed'
  );
  const decideClockq = (r, action) => act(
    () => api(`/clock/followup/${r.id}/decide`, { method: 'PUT', body: JSON.stringify({ action }) }),
    action === 'approve' ? 'Applied to pay' : 'Dismissed'
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
            {fmtD(r.start_date)}–{fmtD(r.end_date)} · {r.hours} h
            {r.type === 'vacation' && r.allowance != null && (
              <> · <span style={{ color: (r.vacation_used + r.hours) > r.allowance ? 'var(--danger)' : 'var(--warning)' }}>
                {Math.round((r.vacation_used + r.hours) * 10) / 10} of {r.allowance} h used</span></>
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
            <button className="primary"
              disabled={busy || (r.entry_id
                ? (!r.proposed_clock_in && !r.proposed_clock_out && r.proposed_break_minutes == null)
                : !(r.proposed_clock_in && r.proposed_clock_out))}
              title={!r.entry_id && !(r.proposed_clock_in && r.proposed_clock_out) ? 'A missing punch needs both proposed times — fix it from Time Clock' : undefined}
              onClick={() => decideEdit(r, 'apply')}>Apply</button>
            <button disabled={busy} onClick={() => decideEdit(r, 'dismissed')}>Dismiss</button>
          </div>
        </div>
      ))}

      {fuel.map((r) => (
        <div key={`fuel-${r.location_id}`} className="wr-card">
          <div className="wr-card-title">{r.n} unassigned fuel purchase{r.n === 1 ? '' : 's'}
            <button className="wr-x" title="Dismiss — reappears if new purchases land" onClick={() => dismiss(`fuel-${r.location_id}-${r.n}-${r.total}`)}>✕</button></div>
          <div className="wr-card-body">{money(r.total)} on the card, nobody assigned{multiLoc && <span className="wr-loc"> · {r.location_name}</span>}</div>
          <div className="wr-actions"><button onClick={() => goTo(r.location_id, '/fuel-card')}>Assign →</button></div>
        </div>
      ))}

      {reorders.map((r) => (
        <div key={`reorder-${r.id}`} className="wr-card hot">
          <div className="wr-card-title">Re-order: {r.item}{r.qty ? ` (${r.qty})` : ''}</div>
          <div className="wr-card-body">
            {r.status === 'ordered' && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>Ordered · </span>}
            {r.person_name ? `flagged by ${r.person_name.split(' ')[0]}` : 'low stock flagged'}
            {multiLoc && <span className="wr-loc"> · {r.location_name}</span>}
          </div>
          <div className="wr-actions">
            {r.status === 'ordered'
              ? <button className="primary" disabled={busy} onClick={() => decideReorder(r, 'received')}>Mark received</button>
              : <button className="primary" disabled={busy} onClick={() => decideReorder(r, 'ordered')}>Mark ordered</button>}
            {/* Killing a tech's request is an owner/manager call — advisors order and receive. */}
            {user?.role !== 'advisor' && <button disabled={busy} onClick={() => decideReorder(r, 'dismissed')}>Dismiss</button>}
          </div>
        </div>
      ))}

      {clockq.map((r) => (
        <div key={`clockq-${r.id}`} className="wr-card hot">
          <div className="wr-card-title">{r.person_name} — {r.kind === 'overtime' ? 'overtime' : 'missed break'}</div>
          <div className="wr-card-body">
            {fmtD(r.work_date)} · {r.kind === 'overtime'
              ? `+${r.answer_hours} h claimed`
              : (r.took_break ? `${Math.round((r.answer_hours || 0) * 60)} min break` : 'no break taken')}
            {multiLoc && <span className="wr-loc"> · {r.location_name}</span>}
          </div>
          <div className="wr-actions">
            <button className="primary" disabled={busy} onClick={() => decideClockq(r, 'approve')}>Apply to pay</button>
            <button disabled={busy} onClick={() => decideClockq(r, 'dismiss')}>Dismiss</button>
          </div>
        </div>
      ))}

      {bonus.map((b) => (
        <div key={`bonus-${b.location_id}`} className="wr-card">
          <div className="wr-card-title">{monthLabel(b.month)} bonus{multiLoc ? ` — ${b.location_name}` : ''}
            <button className="wr-x" title="Dismiss until next month" onClick={() => dismiss(`bonus-${b.location_id}-${b.month}`)}>✕</button></div>
          <div className="wr-card-body">{ownerish
            ? (b.status === 'draft' ? 'Draft is calculated — review and lock it' : 'Net profit is one number from calculating')
            : (b.status === 'draft' ? 'Draft calculated — waiting on the owner to lock it' : 'Waiting on the owner for net profit from month-end close')}</div>
          <div className="wr-actions"><button onClick={() => goTo(b.location_id, '/bonus')}>{ownerish ? (b.status === 'draft' ? 'Review →' : 'Enter net →') : 'View →'}</button></div>
        </div>
      ))}

      <div className="wr-foot">Every decision from every page lands here. Approvals update payroll, the kiosk and Shopmonkey instantly.</div>
    </div>
  );
}
