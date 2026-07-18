import React, { useEffect, useState, useRef } from 'react';

// App-wide feedback layer: toasts + themed confirm/input dialogs that replace
// browser prompt()/confirm(). Event-based singleton so any module can call
// showToast/askConfirm/askInput without context plumbing; <FeedbackHost/> is
// mounted once in Layout and does the rendering.

export function showToast(message, kind = 'success') {
  window.dispatchEvent(new CustomEvent('ops:toast', { detail: { message, kind, id: Math.random() } }));
}

export function askConfirm({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent('ops:dialog', { detail: { mode: 'confirm', title, body, confirmLabel, danger, resolve } }));
  });
}

export function askInput({ title, body, label, initial = '', placeholder = '', type = 'text' }) {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent('ops:dialog', { detail: { mode: 'input', title, body, label, initial, placeholder, type, resolve } }));
  });
}

export function FeedbackHost() {
  const [toasts, setToasts] = useState([]);
  const [dlg, setDlg] = useState(null);
  const [val, setVal] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const onToast = (e) => {
      const t = e.detail;
      setToasts((ts) => [...ts, t]);
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), 3500);
    };
    const onDialog = (e) => { setDlg(e.detail); setVal(e.detail.initial || ''); };
    window.addEventListener('ops:toast', onToast);
    window.addEventListener('ops:dialog', onDialog);
    return () => { window.removeEventListener('ops:toast', onToast); window.removeEventListener('ops:dialog', onDialog); };
  }, []);

  useEffect(() => { if (dlg && dlg.mode === 'input' && inputRef.current) inputRef.current.focus(); }, [dlg]);

  const close = (result) => { if (dlg) dlg.resolve(result); setDlg(null); };

  return (
    <>
      {/* Toast stack */}
      <div style={{ position: 'fixed', bottom: 18, right: 18, zIndex: 200, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
        {toasts.map((t) => (
          <div key={t.id} className={`ops-toast ${t.kind}`}>{t.message}</div>
        ))}
      </div>

      {/* Dialog */}
      {dlg && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 190, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => close(dlg.mode === 'confirm' ? false : null)}>
          <div className="ops-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            {dlg.title && <div className="ops-dialog-title">{dlg.title}</div>}
            {dlg.body && <div className="ops-dialog-body">{dlg.body}</div>}
            {dlg.mode === 'input' && (
              <form onSubmit={(e) => { e.preventDefault(); close(val); }}>
                {dlg.label && <label className="ops-dialog-label">{dlg.label}</label>}
                <input ref={inputRef} type={dlg.type} value={val} placeholder={dlg.placeholder}
                  onChange={(e) => setVal(e.target.value)} style={{ width: '100%' }} />
              </form>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => close(dlg.mode === 'confirm' ? false : null)}>Cancel</button>
              <button className="primary" style={dlg.danger ? { background: 'var(--danger)' } : undefined}
                onClick={() => close(dlg.mode === 'confirm' ? true : val)}>
                {dlg.confirmLabel || 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Simple shimmer skeleton: n bars sized like content rows.
export function Skeleton({ rows = 4, height = 16 }) {
  return (
    <div style={{ padding: '8px 0' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width: `${88 - (i % 3) * 14}%`, marginBottom: 12 }} />
      ))}
    </div>
  );
}
