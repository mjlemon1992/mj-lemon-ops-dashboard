import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import WaitingRail from './WaitingRail';
import { Eyebrow, Dot } from './ui';
import { showToast } from './Feedback';
import { alertId, alertTitle, alertSub } from '../utils/alerts';
import { money0 } from '../utils/format';

// The unified Inbox (Phase 2 of the redesign): ONE drawer where the three
// notification systems land — the "waiting on you" queue (inline actions,
// via the embedded WaitingRail), the Watch feed (stale vehicles + margin
// flags from the sync), and whatever a push notification pointed at.
//
// Watch "Resolve" is undo-not-confirm: the row dims for a 6s grace window
// with an inline Undo, and the server ack fires only when the window lapses.
// (Deliberate: /cos/alerts/unack is owner/partner-only, so a manager's undo must
// never need it — cancelling before send works for every role.)
const GRACE_MS = 6000;

export default function Inbox({
  open, onClose, detail, api, onAction, onDismiss, multiLoc,
  alerts, onAlertAcked,
}) {
  const navigate = useNavigate();
  const closeRef = useRef(null);
  // Move focus into the dialog on open; hand it back on close.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    closeRef.current && closeRef.current.focus();
    return () => { prev && prev.focus && prev.focus(); };
  }, [open]);
  // id -> deadline for rows in their grace window
  const [pending, setPending] = useState({});
  const timers = useRef({});
  const [tick, setTick] = useState(0);

  // Esc closes; timers keep running (grace commits even if the drawer shuts).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.ops-dialog')) return;   // let the confirm own Esc
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 1s tick so the countdown labels stay honest while the drawer is open.
  useEffect(() => {
    if (!open || !Object.keys(pending).length) return undefined;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [open, pending]);

  // Commit: row stays dimmed as 'committing' through the round-trip (no
  // flicker back to Resolve), failures restore the row WITH a toast, and
  // success removes it only once the server confirmed.
  const commit = React.useCallback((id) => {
    delete timers.current[id];
    setPending(prev => ({ ...prev, [id]: 'committing' }));
    api('/cos/alerts/ack', { method: 'POST', body: JSON.stringify({ keys: [id] }) })
      .then(() => {
        onAlertAcked && onAlertAcked(id);
        setPending(prev => { const n = { ...prev }; delete n[id]; return n; });
      })
      .catch(() => {
        setPending(prev => { const n = { ...prev }; delete n[id]; return n; });
        showToast("Couldn't resolve the alert — it's back in the list", 'error');
      });
  }, [api, onAlertAcked]);
  const resolve = (a) => {
    const id = alertId(a);
    setPending(prev => ({ ...prev, [id]: Date.now() + GRACE_MS }));
    timers.current[id] = setTimeout(() => commit(id), GRACE_MS);
  };
  const undo = (id) => {
    setPending(prev => {
      if (typeof prev[id] !== 'number') return prev;   // already committing — too late
      clearTimeout(timers.current[id]);
      delete timers.current[id];
      const n = { ...prev }; delete n[id]; return n;
    });
  };

  // A reload/close/app-switch inside the grace window must not lose an ack the
  // user watched succeed: flush in-flight graces with keepalive fetches (the
  // api() wrapper can't outlive the page). Same flush on unmount (logout).
  const flushAll = React.useCallback(() => {
    Object.keys(timers.current).forEach((id) => {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
      try {
        fetch('/api/cos/alerts/ack', {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('ops_token') || ''}` },
          body: JSON.stringify({ keys: [id] }),
        }).catch(() => {});
      } catch (e) { /* best effort */ }
    });
  }, []);
  useEffect(() => {
    window.addEventListener('pagehide', flushAll);
    return () => { window.removeEventListener('pagehide', flushAll); flushAll(); };
  }, [flushAll]);

  if (!open) return null;

  const needsCount = detail
    ? ['timeoff', 'edits', 'fuel', 'reorders', 'clockq', 'bonus', 'parts'].reduce((n, k) => n + (detail[k] || []).length, 0)
    : 0;
  const fuelTotal = (detail?.fuel || []).reduce((a, r) => a + (Number(r.total) || 0), 0);
  const watch = alerts || [];
  const total = needsCount + watch.length;

  const sectionLabel = (text, tone) => (
    <div style={{ padding: '14px 16px 8px' }}>
      <Eyebrow tone={tone}>{text}</Eyebrow>
    </div>
  );

  return (
    <>
      <div className="inbox-scrim" onClick={onClose} />
      <div className="inbox-panel" role="dialog" aria-modal="true" aria-label="Inbox">
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '16px 16px 12px', borderBottom: '0.5px solid var(--border)', flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--font-disp)', fontSize: '17px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Inbox</span>
          {total > 0 && (
            <span className="badge warning" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {total}{fuelTotal > 0 ? ` · ${money0(fuelTotal)}` : ''}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button ref={closeRef} onClick={onClose} aria-label="Close inbox"
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 'var(--fz-title)', padding: '4px 6px', lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {total === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text3)', fontSize: 'var(--fz-body)' }}>
              Nothing needs you — all clear ✓
            </div>
          )}

          {needsCount > 0 && (
            <>
              {sectionLabel(`Needs you · ${needsCount}`, 'var(--accent)')}
              <div style={{ padding: '0 12px' }}>
                <WaitingRail embedded detail={detail} api={api} onAction={onAction}
                  onDismiss={onDismiss} multiLoc={multiLoc} onNavigate={onClose} />
              </div>
            </>
          )}

          {watch.length > 0 && (
            <>
              {sectionLabel(`Watch · ${watch.length}`, 'var(--text2)')}
              <div style={{ padding: '0 12px 4px' }}>
                {watch.map((a) => {
                  const id = alertId(a);
                  const deadline = pending[id];
                  const committing = deadline === 'committing';
                  const secs = typeof deadline === 'number' ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
                  return (
                    <div key={id} className="wr-card" style={{ opacity: deadline ? 0.55 : 1 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '9px' }}>
                        <span style={{ marginTop: 5 }}>
                          <Dot tone={a.type === 'stale' ? 'var(--warning)' : 'var(--danger)'} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="wr-card-title" style={{ marginBottom: 2 }}>{alertTitle(a)}</div>
                          <div className="wr-card-body">
                            {committing
                              ? <>Resolving…</>
                              : deadline
                              ? <>Resolved · <span onClick={() => undo(id)} role="button" tabIndex={0}
                                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); undo(id); } }}
                                  style={{ color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }}>Undo</span> · {secs}s</>
                              : <>{alertSub(a)}{multiLoc && a.location && <span className="wr-loc"> · {a.location}</span>}</>}
                          </div>
                        </div>
                        {!deadline && (
                          <button onClick={() => resolve(a)}
                            style={{ fontSize: 'var(--fz-label)', padding: '4px 10px', flexShrink: 0 }}>
                            Resolve
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div onClick={() => { navigate('/alerts'); onClose(); }} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/alerts'); onClose(); } }}
                  style={{ fontSize: 'var(--fz-label)', color: 'var(--accent)', cursor: 'pointer', padding: '6px 4px 10px' }}>
                  Alert history →
                </div>
              </div>
            </>
          )}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '0.5px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontSize: 'var(--fz-micro)', fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text3)', lineHeight: 1.7 }}>
            One inbox — the waiting-on-you queue and live alerts, one place
          </div>
        </div>
      </div>
    </>
  );
}
