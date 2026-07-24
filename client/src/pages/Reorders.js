import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import PerLocationPage from '../components/PerLocationPage';
import { showToast, Skeleton } from '../components/Feedback';
import { fmtShortDate } from '../utils/format';

// Re-order board — the SERVICE ADVISOR's page (owners/managers see the same
// board inside Time Clock). Techs flag low stock on the kiosk; whoever places
// the order marks it Ordered, then Received when it lands — received clears it
// from every surface. Advisors cannot dismiss a request (owner/manager call)
// and nothing on this page carries a dollar figure.
export default function Reorders() {
  return <PerLocationPage>{(locId) => <Board locId={locId} />}</PerLocationPage>;
}

function Board({ locId }) {
  const { api } = useAuth();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api(`/clock/${locId}/reorders`)
      .then((d) => { setRows(d.requests || []); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [api, locId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60 * 1000);   // techs flag from the kiosk all day
    return () => clearInterval(t);
  }, [load]);

  const act = async (r, action) => {
    setBusy(true); setErr(null);
    try {
      await api(`/clock/reorder/${r.id}`, { method: 'PUT', body: JSON.stringify({ action }) });
      showToast(action === 'ordered' ? `Ordered — ${r.item}` : `Received — ${r.item} cleared`);
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (rows === null && !err) return <Skeleton rows={4} />;
  const requested = (rows || []).filter((r) => r.status === 'requested');
  const ordered = (rows || []).filter((r) => r.status === 'ordered');

  const Row = ({ r }) => (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', marginBottom: '6px' }}>
      <span style={{ fontWeight: 700 }}>{r.item}</span>
      {r.qty && <span style={{ color: 'var(--text2)', fontSize: 'var(--fz-body)' }}>· {r.qty}</span>}
      {r.person_name && <span style={{ color: 'var(--text3)', fontSize: 'var(--fz-label)' }}>· flagged by {r.person_name.split(' ')[0]}</span>}
      {r.note && <span style={{ color: 'var(--text3)', fontSize: 'var(--fz-label)', fontStyle: 'italic' }}>"{r.note}"</span>}
      {/* created_at is a full timestamp — trim to the date part for fmtShortDate */}
      <span style={{ color: 'var(--text3)', fontSize: 'var(--fz-label)' }}>{fmtShortDate(String(r.created_at || '').slice(0, 10))}</span>
      <span style={{ marginLeft: 'auto' }}>
        {r.status === 'requested'
          ? <button className="primary" disabled={busy} onClick={() => act(r, 'ordered')} style={{ fontSize: 'var(--fz-label)', padding: '5px 14px' }}>Mark ordered</button>
          : <button className="primary" disabled={busy} onClick={() => act(r, 'received')} style={{ fontSize: 'var(--fz-label)', padding: '5px 14px' }}>Mark received</button>}
      </span>
    </div>
  );

  return (
    <div>
      <div className="card" style={{ marginBottom: '16px' }}>
        <div style={{ fontWeight: 600, marginBottom: '4px' }}>Waiting to be ordered <span style={{ color: 'var(--text3)', fontWeight: 400, fontSize: 'var(--fz-label)' }}>· flagged by the crew on the shop kiosk</span></div>
        <div style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)', marginBottom: '12px' }}>Mark ordered when you place it — the tech sees the status flip on the kiosk board.</div>
        {requested.length === 0 && <div style={{ color: 'var(--text3)', fontSize: 'var(--fz-body)' }}>Nothing waiting — the crew hasn't flagged anything.</div>}
        {requested.map((r) => <Row key={r.id} r={r} />)}
      </div>
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: '12px' }}>On order <span style={{ color: 'var(--text3)', fontWeight: 400, fontSize: 'var(--fz-label)' }}>· mark received when it lands — that clears it everywhere</span></div>
        {ordered.length === 0 && <div style={{ color: 'var(--text3)', fontSize: 'var(--fz-body)' }}>Nothing on order.</div>}
        {ordered.map((r) => <Row key={r.id} r={r} />)}
      </div>
      {err && <div style={{ color: 'var(--danger)', marginTop: '12px' }}>{err}</div>}
    </div>
  );
}
