import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import ApprovalQueue from '../components/ApprovalQueue';

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

// Attention-cluster tile. Clickable when it has real data; dimmed "soon" otherwise.
function Gauge({ label, value, sub, tone, onClick, soon }) {
  const clickable = onClick && !soon;
  return (
    <div onClick={clickable ? onClick : undefined}
      style={{
        background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)',
        padding: '14px 15px', opacity: soon ? 0.5 : 1, cursor: clickable ? 'pointer' : 'default',
      }}>
      <div style={{ fontSize: '10px', letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: '28px', fontWeight: 600, lineHeight: 1, marginTop: '8px', color: tone || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '6px' }}>{soon ? 'soon' : sub}</div>
    </div>
  );
}

export default function Marketing() {
  const { api, token } = useAuth();
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState(null);
  const [status, setStatus] = useState({ configured: true, slack: false });
  const [summary, setSummary] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [counts, setCounts] = useState({ drafts: 0, approved: 0 });
  const fileRef = useRef(null);
  const queueRef = useRef(null);

  useEffect(() => { api('/marketing/calls/status').then(setStatus).catch(() => {}); }, [api]);

  useEffect(() => {
    api('/locations').then(locs => {
      setLocations(locs);
      const first = locs.filter(l => l.active)[0] || locs[0];
      if (first) setLocId(first.id); else setLoading(false);
    }).catch(() => setLoading(false));
  }, [api]);

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
  const chan = (k) => summary?.channels?.find(c => c.channel === k)?.total_calls || 0;
  const ppcCh = summary?.channels?.find(c => c.channel === 'PPC');
  const orgShare = t && t.total ? Math.round((t.organic / t.total) * 100) : 0;
  const locName = locations.find(l => l.id === locId)?.name;
  const toQueue = () => queueRef.current && queueRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div>
      {/* Location */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '18px', alignItems: 'center', flexWrap: 'wrap' }}>
        {locations.length > 1 ? (
          <select value={locId || ''} onChange={e => setLocId(e.target.value)} style={{ width: 'auto' }}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>{locations.find(l => l.id === locId)?.name || 'Location'}</div>
        )}
      </div>

      {/* Attention cluster — glance, then act */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '22px' }}>
        <Gauge label="Approvals waiting" value={counts.drafts}
          tone={counts.drafts > 0 ? 'var(--accent)' : 'var(--text)'}
          sub={counts.drafts > 0 ? 'ready to review' : 'all clear'} onClick={toQueue} />
        <Gauge label="Ready to post" value={counts.approved}
          tone={counts.approved > 0 ? 'var(--success)' : 'var(--text)'}
          sub={counts.approved > 0 ? 'approved & waiting' : 'none yet'} onClick={toQueue} />
        <Gauge label="Shots to grab" value="—" soon />
        <Gauge label="Scheduled" value="—" soon />
      </div>

      {/* Capture → caption → approve (the daily driver) */}
      <div ref={queueRef}>
        <ApprovalQueue locId={locId} locName={locName} onCount={setCounts} />
      </div>

      <div style={{ borderTop: '0.5px solid var(--border)', margin: '4px 0 18px' }} />

      {/* Call tracking */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Call tracking</div>
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

      {loading && <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading&hellip;</div>}

      {!loading && !summary && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text3)', padding: '40px' }}>
          No call reports yet. Upload a monthly Marchex/Telmetrics PDF to get started.
        </div>
      )}

      {!loading && summary && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>{monthLabel(summary.period_start)}</div>
            <div style={{ fontSize: '11px', color: 'var(--text3)' }}>Marchex · monthly · lagging trend</div>
          </div>

          <div className="card" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '34px', fontWeight: 600, lineHeight: 1, letterSpacing: '-.02em' }}>{fmt(t.total)}</div>
              <div style={{ fontSize: '12px', color: 'var(--text3)' }}>total calls</div>
              <div style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text3)' }}>{prev ? `${delta(pct(t.total, prev.total)) || '—'} MoM` : 'first month'}</div>
            </div>
            {/* organic vs paid split bar */}
            <div style={{ height: '9px', borderRadius: '6px', overflow: 'hidden', display: 'flex', margin: '14px 0 10px', border: '0.5px solid var(--border)' }}>
              <div style={{ width: `${orgShare}%`, background: 'var(--info)' }} />
              <div style={{ width: `${100 - orgShare}%`, background: 'var(--accent)' }} />
            </div>
            <div style={{ display: 'flex', gap: '20px', fontSize: '12px', color: 'var(--text2)', flexWrap: 'wrap' }}>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--info)', marginRight: 6 }} />Organic <b style={{ color: 'var(--text)' }}>{fmt(t.organic)}</b> ({orgShare}%)</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--accent)', marginRight: 6 }} />Paid <b style={{ color: 'var(--text)' }}>{fmt(t.paid)}</b></span>
            </div>
            {ppcCh?.qualified_calls != null && (
              <div style={{ marginTop: '12px', paddingTop: '11px', borderTop: '0.5px solid var(--border)', fontSize: '12px', color: 'var(--text2)', display: 'flex', justifyContent: 'space-between' }}>
                <span>PPC qualified (≥{status.qualifiedMinSeconds || 60}s) — real paid-search leads</span>
                <span><b style={{ color: 'var(--text)' }}>{fmt(ppcCh.qualified_calls)}</b> of {fmt(ppcCh.total_calls)}</span>
              </div>
            )}
          </div>

          <div className="card" style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '10px' }}>By channel</div>
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
        </>
      )}
    </div>
  );
}
