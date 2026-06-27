import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// "This week's shots" — AI shoot list from today's open repair orders (Shopmonkey).
export default function ShotsList({ locId, onCount }) {
  const { api } = useAuth();
  const [shots, setShots] = useState([]);
  const [openOrders, setOpenOrders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback((force) => {
    if (!locId) return;
    setLoading(true); setErr(null);
    api(`/marketing/shots/${locId}/shots${force ? '?force=1' : ''}`)
      .then(d => { setShots(d.shots || []); setOpenOrders(d.open_orders); if (onCount) onCount((d.shots || []).length); })
      .catch(e => setErr(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [locId, api, onCount]);
  useEffect(() => { load(false); }, [load]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>This week's shots</div>
        <span style={{ fontSize: '11px', color: 'var(--text3)' }}>
          {openOrders != null ? `from ${openOrders} open jobs · grounded in the bench` : 'from your open repair orders'}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={() => load(true)} disabled={loading}>{loading ? 'Thinking…' : '↻ Refresh'}</button>
      </div>

      {err && <div className="alert-strip" style={{ background: 'rgba(255,77,77,0.07)', borderColor: 'rgba(255,77,77,0.3)' }}><span style={{ color: 'var(--danger)' }}>{err}</span></div>}
      {loading && !shots.length && <div style={{ color: 'var(--text3)', padding: '20px' }}>Reading the floor…</div>}
      {!loading && !shots.length && !err && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text3)', padding: '24px' }}>No shots suggested yet — hit Refresh.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {shots.map((s, i) => (
          <div className="card" key={i} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '12px 14px' }}>
            <div style={{ width: 34, height: 34, flexShrink: 0, borderRadius: 8, border: '0.5px solid var(--border2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', fontSize: 16 }}>📷</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>{s.shot}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: 1 }}>
                {s.vehicle || 'Vehicle'}{s.ro ? ` · RO #${s.ro}` : ''}
              </div>
              {s.why && <div style={{ fontSize: '12px', color: 'var(--text2)', marginTop: 4 }}>{s.why}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
