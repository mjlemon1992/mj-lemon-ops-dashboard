import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

const fmt = n => (n == null ? '—' : Number(n).toLocaleString('en-CA'));
const monthLabel = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' }) : '—';
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
const delta = (x) => x == null ? null : (x >= 0 ? `+${x}%` : `${x}%`);

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
  const fileRef = useRef(null);

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
  const orgShare = t && t.total ? Math.round((t.organic / t.total) * 100) : 0;

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        {locations.length > 1 ? (
          <select value={locId || ''} onChange={e => setLocId(e.target.value)} style={{ width: 'auto' }}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>{locations.find(l => l.id === locId)?.name || 'Location'}</div>
        )}
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
            <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>Call tracking — {monthLabel(summary.period_start)}</div>
            <div style={{ fontSize: '11px', color: 'var(--text3)' }}>Marchex · monthly · lagging trend</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '16px' }}>
            <div className="metric-card">
              <div className="metric-label">Total calls</div>
              <div className="metric-value">{fmt(t.total)}</div>
              <div className="metric-sub">{prev ? `${delta(pct(t.total, prev.total)) || '—'} MoM` : 'first month'}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Organic</div>
              <div className="metric-value">{fmt(t.organic)}</div>
              <div className="metric-sub good">{orgShare}% of total{prev ? ` · ${delta(pct(t.organic, prev.organic)) || '—'}` : ''}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Paid (PPC + Call Ext)</div>
              <div className="metric-value">{fmt(t.paid)}</div>
              <div className="metric-sub">{prev ? `${delta(pct(t.paid, prev.paid)) || '—'} MoM` : 'PPC + call extension'}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Qualified (≥{status.qualifiedMinSeconds || 60}s)</div>
              <div className="metric-value">{t.qualified == null ? '—' : fmt(t.qualified)}</div>
              <div className="metric-sub">{t.qualified == null ? 'no call detail in PDF' : 'answered & long enough'}</div>
            </div>
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
