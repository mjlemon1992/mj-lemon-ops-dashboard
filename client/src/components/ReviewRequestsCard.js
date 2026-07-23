import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Review request texts — owner/partner card for the Marketing rail. Shows the
// pipeline's state (off / dry-run burn-in / live), 30-day counts and the recent
// log; owner can toggle the location flag, override the review link and fire a
// manual run. Live sending additionally needs env REVIEW_REQUESTS_LIVE=1 — the
// card says so instead of pretending a toggle here is the whole story.
// Self-hides on error (e.g. role gate) like ReviewsScorecard.
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
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [editLink, setEditLink] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');

  const load = useCallback(() => {
    if (!locId) return;
    api(`/marketing/review-requests/${locId}`)
      .then((d) => { setData(d); setLinkDraft(d.custom_link || ''); })
      .catch(() => setHidden(true));
  }, [locId, api]);

  useEffect(() => { setData(null); setHidden(false); setMsg(null); setEditLink(false); load(); }, [load]);

  if (hidden || !data) return null;

  const mode = !data.enabled ? 'off' : (data.live ? 'live' : 'dry run');
  const dot = mode === 'live' ? 'var(--success)' : mode === 'dry run' ? 'var(--warning)' : 'var(--text3)';

  const act = async (fn, okMsg) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg(okMsg(r)); load(); }
    catch (e) { setMsg(String(e.message || e)); }
    finally { setBusy(false); }
  };

  const toggle = () => act(
    () => api(`/marketing/review-requests/${locId}/config`, { method: 'PUT', body: JSON.stringify({ enabled: !data.enabled }) }),
    () => (data.enabled ? 'Review requests disabled.' : `Enabled — ${data.live ? 'texts will go out after invoicing.' : 'dry-run mode: messages are logged, not sent.'}`));

  const saveLink = () => act(
    () => api(`/marketing/review-requests/${locId}/config`, { method: 'PUT', body: JSON.stringify({ link: linkDraft }) }),
    () => { setEditLink(false); return 'Review link saved.'; });

  const runNow = () => act(
    () => api(`/marketing/review-requests/${locId}/run?force=1`, { method: 'POST' }),
    (r) => (r && r.ran
      ? `Run complete — ${r.sent} sent, ${r.dry_run} dry-run, ${r.skipped} skipped, ${r.failed} failed (${r.picked} eligible of ${r.considered}).`
      : `Did not run: ${(r && r.reason) || 'unknown'}.`));

  return (
    <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px', marginBottom: '10px' }}>
        <span style={{ fontFamily: MONO, fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text3)' }}>Review requests</span>
        <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, display: 'inline-block' }} />
          {mode}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontFamily: 'var(--font-disp)', fontSize: '38px', fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {data.live ? data.stats.sent30 : data.stats.dry30}
        </span>
        <div style={{ fontFamily: MONO, fontSize: '10.5px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text3)' }}>
          {data.live ? 'texts sent' : 'dry-run texts'} · 30d
          {data.stats.failed30 > 0 && <div style={{ color: 'var(--danger)' }}>{data.stats.failed30} failed</div>}
          {data.stats.last_at && <div>last {ago(data.stats.last_at)}</div>}
        </div>
      </div>

      {data.enabled && !data.live && (
        <div style={{ marginTop: '9px', fontSize: '11.5px', color: 'var(--warning)' }}>
          Burn-in mode — messages are logged below, nothing is texted. Set <code>REVIEW_REQUESTS_LIVE=1</code> to go live.
        </div>
      )}
      {data.enabled && !data.link && (
        <div style={{ marginTop: '9px', fontSize: '11.5px', color: 'var(--danger)' }}>
          No review link — set this location's Google place ID or a custom link below.
        </div>
      )}

      {(data.recent || []).length > 0 && (
        <div style={{ marginTop: '11px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {data.recent.slice(0, 5).map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '7px', fontSize: '11.5px' }}
              title={r.detail || ''}>
              <span style={{ fontFamily: MONO, fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', color: STATUS_TONE[r.status] || 'var(--text3)', minWidth: '52px' }}>
                {STATUS_LABEL[r.status] || r.status}
              </span>
              <span style={{ color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.customer_name || 'Customer'}{r.order_number ? ` · RO ${r.order_number}` : ''}
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--text3)', fontSize: '10.5px', flexShrink: 0 }}>{ago(r.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {msg && <div style={{ marginTop: '10px', fontSize: '11.5px', color: 'var(--text2)' }}>{msg}</div>}

      {isOwner && (
        <div style={{ marginTop: '11px', paddingTop: '10px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: '7px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button disabled={busy} onClick={toggle} style={{ fontSize: '11.5px', padding: '4px 10px' }}>
            {data.enabled ? 'Disable' : 'Enable'}
          </button>
          <button disabled={busy || !data.enabled || !data.link} onClick={runNow} style={{ fontSize: '11.5px', padding: '4px 10px' }}>
            Run now
          </button>
          <button disabled={busy} onClick={() => setEditLink(!editLink)} style={{ fontSize: '11.5px', padding: '4px 10px' }}>
            {editLink ? 'Cancel' : 'Link…'}
          </button>
          {editLink && (
            <div style={{ display: 'flex', gap: '6px', width: '100%', marginTop: '6px' }}>
              <input value={linkDraft} onChange={(e) => setLinkDraft(e.target.value)}
                placeholder={data.link_source === 'place_id' ? 'Using Google place ID link — override here' : 'https://g.page/r/…'}
                style={{ flex: 1, fontSize: '11.5px', padding: '5px 8px' }} />
              <button className="primary" disabled={busy} onClick={saveLink} style={{ fontSize: '11.5px', padding: '4px 10px' }}>Save</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
