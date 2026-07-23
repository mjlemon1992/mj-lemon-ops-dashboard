import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Review request texts — Marketing rail card. Centre of the card is the PICKUP
// QUEUE: recent invoiced ROs, each with Send / Skip. The counter workflow: ask
// the customer how the visit went; good answer → Send (they get the Google
// review link by text, right there); anything else → Skip (that RO is never
// asked). Owner/partner + managers (their location). Owner-only controls:
// enable, auto-send mode, link override. Live sending additionally needs env
// REVIEW_REQUESTS_LIVE=1 — until then Send logs a dry-run row, nothing texts.
// Self-hides on error (e.g. advisor role) like ReviewsScorecard.
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

const STATUS_TONE = {
  sent: 'var(--success)', dry_run: 'var(--warning)',
  skipped: 'var(--text3)', failed: 'var(--danger)',
};
const STATUS_LABEL = { sent: 'sent', dry_run: 'dry run', skipped: 'skipped', failed: 'failed' };

const ago = (d) => {
  if (!d) return '';
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (60 * 24))}d ago`;
};

export default function ReviewRequestsCard({ locId }) {
  const { api, user } = useAuth();
  const isOwner = user?.role === 'owner';
  const [data, setData] = useState(null);
  const [queue, setQueue] = useState([]);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(null);      // order_id being acted on, or 'card'
  const [msg, setMsg] = useState(null);
  const [editLink, setEditLink] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');

  const load = useCallback(() => {
    if (!locId) return;
    api(`/marketing/review-requests/${locId}`)
      .then((d) => {
        setData(d); setLinkDraft(d.custom_link || '');
        if (d.enabled) api(`/marketing/review-requests/${locId}/queue`)
          .then((q) => setQueue((q && q.queue) || [])).catch(() => setQueue([]));
        else setQueue([]);
      })
      .catch(() => setHidden(true));
  }, [locId, api]);

  useEffect(() => { setData(null); setQueue([]); setHidden(false); setMsg(null); setEditLink(false); load(); }, [load]);

  if (hidden || !data) return null;

  const mode = !data.enabled ? 'off' : (data.live ? 'live' : 'dry run');
  const dot = mode === 'live' ? 'var(--success)' : mode === 'dry run' ? 'var(--warning)' : 'var(--text3)';

  const act = async (key, fn, okMsg) => {
    setBusy(key); setMsg(null);
    try { const r = await fn(); setMsg(okMsg(r)); load(); }
    catch (e) { setMsg(String(e.message || e)); }
    finally { setBusy(null); }
  };

  // Pickup actions. Send with cooldown 409 → the message explains; owner can
  // retry via the same button after reading (server accepts force from body).
  const sendOrder = (row, force) => act(row.order_id,
    () => api(`/marketing/review-requests/${locId}/orders/${row.order_id}/send${force ? '?force=1' : ''}`, { method: 'POST' }),
    (r) => r.status === 'sent'
      ? `Review link texted to ${r.customer || row.customer_name || 'customer'}.`
      : r.status === 'dry_run'
        ? `Dry run logged for ${r.customer || row.customer_name || 'customer'} — nothing sent (burn-in mode).`
        : `Not sent: ${r.reason || r.status}.`);

  const skipOrder = (row) => act(row.order_id,
    () => api(`/marketing/review-requests/${locId}/orders/${row.order_id}/skip`, {
      method: 'POST',
      body: JSON.stringify({ number: row.number, customer_name: row.customer_name }),
    }),
    () => `Skipped RO ${row.number || ''} — it won't be asked.`);

  const toggle = () => act('card',
    () => api(`/marketing/review-requests/${locId}/config`, { method: 'PUT', body: JSON.stringify({ enabled: !data.enabled }) }),
    () => (data.enabled ? 'Review requests disabled.' : `Enabled — ${data.live ? 'ready to send from the queue.' : 'dry-run mode: Send logs the message, nothing texts yet.'}`));

  const toggleAuto = () => act('card',
    () => api(`/marketing/review-requests/${locId}/config`, { method: 'PUT', body: JSON.stringify({ auto: !data.auto }) }),
    () => (data.auto ? 'Auto-send off — queue only (send at pickup).' : 'Auto-send ON — the scheduler will ask eligible customers itself.'));

  const saveLink = () => act('card',
    () => api(`/marketing/review-requests/${locId}/config`, { method: 'PUT', body: JSON.stringify({ link: linkDraft }) }),
    () => { setEditLink(false); return 'Review link saved.'; });

  return (
    <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px', marginBottom: '10px' }}>
        <span style={{ fontFamily: MONO, fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text3)' }}>Review requests</span>
        {data.enabled && (
          <span style={{ fontFamily: MONO, fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text3)' }}>
            {data.auto ? 'auto' : 'at pickup'}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, display: 'inline-block' }} />
          {mode}
        </span>
      </div>

      {data.enabled && !data.live && (
        <div style={{ marginBottom: '9px', fontSize: '11.5px', color: 'var(--warning)' }}>
          Burn-in mode — Send logs the exact message below, nothing is texted. Set <code>REVIEW_REQUESTS_LIVE=1</code> to go live.
        </div>
      )}
      {data.enabled && !data.link && (
        <div style={{ marginBottom: '9px', fontSize: '11.5px', color: 'var(--danger)' }}>
          No review link — set this location's Google place ID or a custom link below.
        </div>
      )}

      {/* THE PICKUP QUEUE — "how was your visit?" ... good answer → Send */}
      {data.enabled && queue.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '4px' }}>
          <div style={{ fontFamily: MONO, fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text3)' }}>
            Ready to ask · {queue.length}
          </div>
          {queue.slice(0, 6).map((row) => (
            <div key={row.order_id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', background: 'var(--bg3)', borderRadius: '8px' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '12.5px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.customer_name || 'Customer'}
                </div>
                <div style={{ fontFamily: MONO, fontSize: '10px', letterSpacing: '0.05em', color: 'var(--text3)' }}>
                  {row.number ? `RO ${row.number}` : ''}{row.invoiced_at ? ` · invoiced ${ago(row.invoiced_at)}` : ''}
                </div>
              </div>
              <button className="primary" disabled={busy != null || !data.link} onClick={() => sendOrder(row)}
                style={{ fontSize: '11.5px', padding: '4px 11px', flexShrink: 0 }}>
                {busy === row.order_id ? '…' : 'Send'}
              </button>
              <button disabled={busy != null} onClick={() => skipOrder(row)} title="Don't ask for this RO"
                style={{ fontSize: '11.5px', padding: '4px 8px', flexShrink: 0, color: 'var(--text3)' }}>
                ✕
              </button>
            </div>
          ))}
          {queue.length > 6 && (
            <div style={{ fontSize: '10.5px', color: 'var(--text3)' }}>+{queue.length - 6} more in the queue</div>
          )}
        </div>
      )}
      {data.enabled && queue.length === 0 && (
        <div style={{ fontSize: '11.5px', color: 'var(--text3)', marginBottom: '4px' }}>
          Queue clear — invoiced ROs show up here to ask at pickup.
        </div>
      )}

      {msg && <div style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--text2)' }}>{msg}</div>}

      {/* 30d tally + recent decisions */}
      <div style={{ marginTop: '10px', paddingTop: '9px', borderTop: '0.5px solid var(--border)', display: 'flex', alignItems: 'baseline', gap: '10px', fontFamily: MONO, fontSize: '10.5px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text3)' }}>
        <span><b style={{ color: 'var(--text)', fontSize: '13px' }}>{data.live ? data.stats.sent30 : data.stats.dry30}</b> {data.live ? 'sent' : 'dry'} · 30d</span>
        {data.stats.failed30 > 0 && <span style={{ color: 'var(--danger)' }}>{data.stats.failed30} failed</span>}
        {data.stats.last_at && <span style={{ marginLeft: 'auto' }}>last {ago(data.stats.last_at)}</span>}
      </div>

      {(data.recent || []).length > 0 && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {data.recent.slice(0, 4).map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '7px', fontSize: '11px' }} title={r.detail || ''}>
              <span style={{ fontFamily: MONO, fontSize: '9.5px', letterSpacing: '0.06em', textTransform: 'uppercase', color: STATUS_TONE[r.status] || 'var(--text3)', minWidth: '50px' }}>
                {STATUS_LABEL[r.status] || r.status}
              </span>
              <span style={{ color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.customer_name || 'Customer'}{r.order_number ? ` · RO ${r.order_number}` : ''}
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--text3)', fontSize: '10px', flexShrink: 0 }}>{ago(r.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {isOwner && (
        <div style={{ marginTop: '10px', paddingTop: '9px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: '7px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button disabled={busy != null} onClick={toggle} style={{ fontSize: '11.5px', padding: '4px 10px' }}>
            {data.enabled ? 'Disable' : 'Enable'}
          </button>
          {data.enabled && (
            <button disabled={busy != null} onClick={toggleAuto} style={{ fontSize: '11.5px', padding: '4px 10px' }}
              title={data.auto ? 'Scheduler sends automatically — switch back to pickup-only' : 'Hands-off mode: the scheduler asks eligible customers itself'}>
              {data.auto ? 'Auto: on' : 'Auto: off'}
            </button>
          )}
          <button disabled={busy != null} onClick={() => setEditLink(!editLink)} style={{ fontSize: '11.5px', padding: '4px 10px' }}>
            {editLink ? 'Cancel' : 'Link…'}
          </button>
          {editLink && (
            <div style={{ display: 'flex', gap: '6px', width: '100%', marginTop: '6px' }}>
              <input value={linkDraft} onChange={(e) => setLinkDraft(e.target.value)}
                placeholder={data.link_source === 'place_id' ? 'Using Google place ID link — override here' : 'https://g.page/r/…'}
                style={{ flex: 1, fontSize: '11.5px', padding: '5px 8px' }} />
              <button className="primary" disabled={busy != null} onClick={saveLink} style={{ fontSize: '11.5px', padding: '4px 10px' }}>Save</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
