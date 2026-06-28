import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';
import ApprovalQueue from '../components/ApprovalQueue';
import ShotsList from '../components/ShotsList';
import ReviewsScorecard from '../components/ReviewsScorecard';

const fmt = n => (n == null ? '—' : Number(n).toLocaleString('en-CA'));
const monthLabel = (d) => {
  if (!d) return '—';
  // period_start may arrive as a bare date ("2026-05-01") or a full ISO timestamp
  // from Postgres ("2026-05-01T06:00:00.000Z") — normalize to the date part.
  const dt = new Date(String(d).slice(0, 10) + 'T00:00:00');
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
};
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
const delta = (x) => x == null ? null : (x >= 0 ? `+${x}%` : `${x}%`);

// Attention-cluster tile. A 2px colored top rule (rail) is the glance signal; dimmed "soon"
// when the feature isn't live. No fake fill bars — color carries the urgency, not a fake gauge.
function Gauge({ label, value, sub, tone, rail, onClick, soon }) {
  const clickable = onClick && !soon;
  return (
    <div onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }) : undefined}
      style={{
        background: 'var(--bg2)', border: '0.5px solid var(--border)',
        borderTop: `2px solid ${soon ? 'var(--border2)' : (rail || 'var(--accent)')}`,
        borderRadius: 'var(--radius)', padding: '12px 13px',
        opacity: soon ? 0.6 : 1, cursor: clickable ? 'pointer' : 'default',
      }}>
      <div style={{ fontSize: '10px', letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: '26px', fontWeight: 600, lineHeight: 1.1, marginTop: '7px', color: tone || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '5px' }}>{soon ? 'soon' : sub}</div>
    </div>
  );
}

function MarketingView({ locId }) {
  const { api, token } = useAuth();
  const { locations } = useLocations();
  const navigate = useNavigate();
  const [status, setStatus] = useState({ configured: true, slack: false });
  const [summary, setSummary] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [counts, setCounts] = useState({ drafts: 0, approved: 0 });
  const [shotsCount, setShotsCount] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [captureSeed, setCaptureSeed] = useState(null);
  const fileRef = useRef(null);
  const queueRef = useRef(null);
  const shotsRef = useRef(null);
  const detailRef = useRef(null);

  useEffect(() => { api('/marketing/calls/status').then(setStatus).catch(() => {}); }, [api]);

  const refresh = useCallback(() => {
    if (!locId) return;
    setLoading(true); setErr(null);
    Promise.all([
      api(`/marketing/calls/${locId}/summary`).catch(() => null),
      api(`/marketing/calls/${locId}/periods`).catch(() => []),
    ]).then(([s, p]) => { setSummary(s); setPeriods(p || []); setLoading(false); });
  }, [locId, api]);

  useEffect(() => { refresh(); }, [refresh]);

  // Upload one or many PDFs, sequentially (each is its own extraction call).
  const onPick = async (files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    setUploading(true); setErr(null); setMsg(null);
    const done = [];
    try {
      for (const file of list) {
        const res = await fetch(`/api/marketing/calls/${locId}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf', Authorization: `Bearer ${token}` },
          body: file,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`${file.name}: ${data.error || 'Ingestion failed'}`);
        done.push(`${monthLabel(data.period?.start)} (${fmt(data.totals?.total)} calls)`);
      }
      setMsg(`Ingested ${done.length} report${done.length > 1 ? 's' : ''}: ${done.join(', ')}.`);
    } catch (e) {
      setErr(String(e.message || e) + (done.length ? ` — ${done.length} succeeded first.` : ''));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
      refresh();
    }
  };

  const t = summary?.totals;
  const prev = summary?.prev?.totals;
  const ppcCh = summary?.channels?.find(c => c.channel === 'PPC');
  const orgShare = t && t.total ? Math.round((t.organic / t.total) * 100) : 0;
  const locName = locations.find(l => l.id === locId)?.name;
  const scrollTo = (ref) => ref.current && ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const openDetail = () => { setShowDetail(true); setTimeout(() => scrollTo(detailRef), 50); };

  // Click a "shot to grab" -> seed the capture note with its context and jump to the queue,
  // so the next photo you add is already tagged. Nonce makes repeat clicks re-trigger.
  const useShot = (s) => {
    const tag = [s.shot, s.ro ? `RO #${s.ro}` : (s.vehicle || '')].filter(Boolean).join(' · ');
    // Seed both paths: the capture note AND the poster topic, so the next photo OR a
    // generated poster picks up the shot's context. type=educational fits teardown content.
    setCaptureSeed({ note: tag, topic: s.shot || tag, type: 'educational', n: Date.now() });
    scrollTo(queueRef);
  };

  return (
    <div>
      {/* Command layout: queue (left) + side rail (right) */}
      <div className="mkt-grid">

        {/* LEFT: attention quadrant + the daily driver */}
        <div>
          <div className="mkt-gauges">
            <Gauge label="Approvals waiting" value={counts.drafts}
              rail="var(--accent)" tone={counts.drafts > 0 ? 'var(--accent)' : 'var(--text)'}
              sub={counts.drafts > 0 ? 'tap to review all' : 'all clear'} onClick={() => navigate('/marketing/approvals')} />
            <Gauge label="Ready to post" value={counts.approved}
              rail="var(--success)" tone={counts.approved > 0 ? 'var(--success)' : 'var(--text)'}
              sub={counts.approved > 0 ? 'approved & waiting' : 'none yet'} onClick={() => navigate('/marketing/approvals')} />
            <Gauge label="Shots to grab" value={shotsCount}
              rail="var(--warning)" tone={shotsCount > 0 ? 'var(--warning)' : 'var(--text)'}
              sub={shotsCount > 0 ? 'ideas from the bench' : 'none yet'} onClick={() => scrollTo(shotsRef)} />
            <Gauge label="Scheduled" value="—" soon />
          </div>

          <div ref={queueRef}>
            <ApprovalQueue locId={locId} locName={locName} onCount={setCounts} seed={captureSeed}
              previewLimit={1} onViewAll={() => navigate('/marketing/approvals')} />
          </div>
        </div>

        {/* RIGHT: shots, calls glance, reviews */}
        <div className="mkt-rail">
          <div ref={shotsRef}>
            <ShotsList locId={locId} onCount={setShotsCount} onUse={useShot} />
          </div>

          {/* Calls glance — the read; full tables behind "View detail" */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px', marginBottom: '9px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>Calls</span>
              <span style={{ fontSize: '11px', color: 'var(--text3)' }}>{summary ? `${monthLabel(summary.period_start)} · Marchex` : 'Marchex'}</span>
            </div>

            {loading && !summary && <div style={{ color: 'var(--text3)', padding: '8px 0' }}>Loading…</div>}

            {!loading && !summary && (
              <div style={{ fontSize: '12px', color: 'var(--text3)' }}>
                No call reports yet.
                <button onClick={openDetail} style={{ marginLeft: '8px', fontSize: '12px', padding: '4px 9px' }}>Upload a PDF</button>
              </div>
            )}

            {summary && t && (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span style={{ fontSize: '29px', fontWeight: 600, letterSpacing: '-.02em', lineHeight: 1 }}>{fmt(t.total)}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text3)' }}>total</span>
                  {prev && <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text3)' }}>{delta(pct(t.total, prev.total)) || '—'} MoM</span>}
                </div>
                <div style={{ height: '7px', borderRadius: '5px', overflow: 'hidden', display: 'flex', margin: '11px 0 8px', border: '0.5px solid var(--border)' }}>
                  <div style={{ width: `${orgShare}%`, background: 'var(--info)' }} />
                  <div style={{ width: `${100 - orgShare}%`, background: 'var(--accent)' }} />
                </div>
                <div style={{ display: 'flex', gap: '14px', fontSize: '11.5px', color: 'var(--text2)', flexWrap: 'wrap' }}>
                  <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: 'var(--info)', marginRight: 5 }} />Organic <b style={{ color: 'var(--text)' }}>{fmt(t.organic)}</b></span>
                  <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: 'var(--accent)', marginRight: 5 }} />Paid <b style={{ color: 'var(--text)' }}>{fmt(t.paid)}</b></span>
                </div>
                {ppcCh?.qualified_calls != null && (
                  <div style={{ marginTop: '10px', paddingTop: '9px', borderTop: '0.5px solid var(--border)', fontSize: '11.5px', color: 'var(--text2)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Qualified PPC (≥{status.qualifiedMinSeconds || 60}s)</span>
                    <span><b style={{ color: 'var(--text)' }}>{fmt(ppcCh.qualified_calls)}</b> of {fmt(ppcCh.total_calls)}</span>
                  </div>
                )}
                <div onClick={() => (showDetail ? setShowDetail(false) : openDetail())}
                  role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail ? setShowDetail(false) : openDetail(); } }}
                  style={{ marginTop: '10px', fontSize: '11.5px', color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}>
                  {showDetail ? '▴ Hide detail' : '▾ View detail'}
                </div>
              </>
            )}
          </div>

          {/* Live Google review scorecard (self-hides until configured) */}
          <ReviewsScorecard locId={locId} />
        </div>
      </div>

      {/* Calls detail — upload + full tables, on demand */}
      {showDetail && (
        <div ref={detailRef} style={{ marginTop: '20px', borderTop: '0.5px solid var(--border)', paddingTop: '18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Call tracking detail</div>
            <div style={{ flex: 1 }} />
            <input ref={fileRef} type="file" accept="application/pdf" multiple style={{ display: 'none' }}
              onChange={e => onPick(e.target.files)} />
            <button className="primary" disabled={!status.configured || uploading || !locId}
              onClick={() => fileRef.current && fileRef.current.click()}>
              {uploading ? 'Extracting…' : '⬆ Upload call PDF(s)'}
            </button>
          </div>

          {!status.configured && (
            <div className="alert-strip" style={{ background: 'rgba(77,184,255,0.06)', borderColor: 'rgba(77,184,255,0.3)' }}>
              <span style={{ color: 'var(--info)' }}>Call-tracking extraction not configured yet.</span>
              <span style={{ fontSize: '12px', color: 'var(--text2)' }}>Set <code>ANTHROPIC_API_KEY</code> in the dashboard env to enable PDF ingestion.</span>
            </div>
          )}
          {msg && <div className="alert-strip" style={{ background: 'rgba(77,255,145,0.07)', borderColor: 'rgba(77,255,145,0.3)' }}><span style={{ color: 'var(--success)' }}>{msg}</span></div>}
          {err && <div className="alert-strip" style={{ background: 'rgba(255,77,77,0.07)', borderColor: 'rgba(255,77,77,0.3)' }}><span style={{ color: 'var(--danger)' }}>{err}</span></div>}

          {summary && (
            <div className="card" style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '10px' }}>By channel · {monthLabel(summary.period_start)}</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Channel</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Answered</th><th style={{ textAlign: 'right' }}>Missed</th><th style={{ textAlign: 'right' }}>Unique</th><th style={{ textAlign: 'right' }}>Qualified</th></tr>
                  </thead>
                  <tbody>
                    {['ORGANIC', 'PPC', 'CALL_EXTENSION'].map(k => {
                      const c = summary.channels.find(x => x.channel === k);
                      if (!c) return null;
                      return (
                        <tr key={k}>
                          <td className="strong">{k === 'CALL_EXTENSION' ? 'Call Extension' : k.charAt(0) + k.slice(1).toLowerCase()}</td>
                          <td style={{ textAlign: 'right' }}>{fmt(c.total_calls)}</td>
                          <td style={{ textAlign: 'right' }}>{fmt(c.answered_calls)}</td>
                          <td style={{ textAlign: 'right' }}>{fmt(c.missed_calls)}</td>
                          <td style={{ textAlign: 'right' }}>{fmt(c.unique_callers)}</td>
                          <td style={{ textAlign: 'right' }}>{c.qualified_calls == null ? '—' : fmt(c.qualified_calls)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {periods.length > 1 && (
            <div className="card">
              <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '10px' }}>History</div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Period</th><th style={{ textAlign: 'right' }}>Total calls</th><th style={{ textAlign: 'right' }}>Ingested</th></tr></thead>
                  <tbody>
                    {periods.map(p => (
                      <tr key={p.period_start}>
                        <td className="strong">{monthLabel(p.period_start)}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(p.total_calls)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text3)' }}>{p.ingested_at ? new Date(p.ingested_at).toLocaleDateString('en-CA') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* System-trust line */}
      <div style={{ marginTop: '20px', paddingTop: '12px', borderTop: '0.5px solid var(--border)', fontSize: '11px', color: 'var(--text3)', lineHeight: 1.5 }}>
        Pulls from Shopmonkey, Marchex, Google. Nothing posts automatically yet — approvals wait here until Meta/GBP access is live.
      </div>
    </div>
  );
}

// One shop's marketing summary in the all-locations overview. Marketing actions
// are per-shop, so "All" shows a read-only glance per location with a drill-in.
function ShopMarketingCard({ loc, onOpen }) {
  const { api } = useAuth();
  const [rev, setRev] = useState(null);
  const [drafts, setDrafts] = useState(null);
  const [shots, setShots] = useState(null);
  useEffect(() => {
    let on = true;
    api(`/marketing/reviews/${loc.id}`).then(d => { if (on) setRev(d); }).catch(() => { if (on) setRev(null); });
    api(`/marketing/posts/${loc.id}/queue?status=draft`).then(d => { if (on) setDrafts((d || []).length); }).catch(() => { if (on) setDrafts(0); });
    api(`/marketing/shots/${loc.id}/shots`).then(d => { if (on) setShots((d.shots || []).length); }).catch(() => { if (on) setShots(0); });
    return () => { on = false; };
  }, [loc.id, api]);
  const Row = ({ label, value, tone }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '5px 0' }}>
      <span style={{ color: 'var(--text3)' }}>{label}</span>
      <span style={{ color: tone || 'var(--text)', fontWeight: 500 }}>{value}</span>
    </div>
  );
  return (
    <div className="card">
      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>{loc.name}</div>
      <Row label="Google rating" value={rev && rev.rating ? `★ ${rev.rating} (${fmt(rev.total)})` : 'not connected'} tone={rev && rev.rating ? 'var(--success)' : 'var(--text3)'} />
      <Row label="Awaiting approval" value={drafts == null ? '…' : drafts} tone={drafts ? 'var(--accent)' : undefined} />
      <Row label="Shots to grab" value={shots == null ? '…' : shots} tone={shots ? 'var(--warning)' : undefined} />
      <button onClick={() => onOpen(loc.id)} style={{ marginTop: '10px', width: '100%' }}>Open workspace →</button>
    </div>
  );
}

// All-locations marketing: per-shop overview + a reserved broadcast lane (compose
// once, publish to every shop's Meta + GBP — lights up once channel posting is connected).
function MarketingOverview() {
  const { scopeLocations, select } = useLocations();
  return (
    <div>
      <div className="section-label" style={{ marginBottom: '12px' }}>Marketing overview · all locations</div>
      <div className="stat-grid">
        {scopeLocations.map(l => <ShopMarketingCard key={l.id} loc={l} onOpen={select} />)}
      </div>
      <div className="card" style={{ marginTop: '16px', opacity: 0.6 }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>Broadcast post → all locations</div>
        <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '4px', lineHeight: 1.5 }}>
          Compose once, publish to every location's Meta + Google Business Profile. Available once channel posting is connected.
        </div>
        <button disabled style={{ marginTop: '10px' }}>Compose broadcast (soon)</button>
      </div>
    </div>
  );
}

export default function Marketing() {
  const { isAll, selectedId } = useLocations();
  if (isAll) return <MarketingOverview />;
  if (!selectedId) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Select a location.</div>;
  return <MarketingView locId={selectedId} />;
}
