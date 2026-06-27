import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Google Drive photo library. Lists images from the location's shared Drive folder and
// imports the one you tap (server pulls it -> HEIC->JPEG -> captions -> approval queue).
// Thumbnails load via authenticated fetch (an <img> tag can't send a Bearer header), so
// each one is fetched as a blob. Self-hides when Drive isn't configured.

function DriveThumb({ url, token, alt }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let obj; let cancel = false;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('thumb'))))
      .then(b => { if (!cancel) { obj = URL.createObjectURL(b); setSrc(obj); } })
      .catch(() => {});
    return () => { cancel = true; if (obj) URL.revokeObjectURL(obj); };
  }, [url, token]);
  return src
    ? <img src={src} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    : <div style={{ width: '100%', height: '100%', background: 'var(--bg3)' }} />;
}

export default function DriveLibrary({ locId, onImported }) {
  const { api, token } = useAuth();
  const [hidden, setHidden] = useState(false);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState({});
  const [done, setDone] = useState({});
  const [open, setOpen] = useState(true);

  const load = useCallback(() => {
    if (!locId) return;
    let cancel = false;
    setLoading(true); setErr(null); setHidden(false);
    api('/marketing/drive/status')
      .then(s => {
        if (!s.configured) { if (!cancel) setHidden(true); return null; }
        return api(`/marketing/drive/${locId}/list`);
      })
      .then(d => { if (d && !cancel) setFiles(d.files || []); })
      .catch(e => { if (!cancel) setErr(String(e.message || e)); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [locId, api]);
  useEffect(() => { const c = load(); return c; }, [load]);

  const importFile = async (f) => {
    setBusy(b => ({ ...b, [f.id]: true })); setErr(null);
    try {
      await api(`/marketing/drive/${locId}/import`, { method: 'POST', body: JSON.stringify({ fileId: f.id }) });
      setDone(d => ({ ...d, [f.id]: true }));
      if (onImported) onImported();
    } catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(b => { const n = { ...b }; delete n[f.id]; return n; }); }
  };

  if (hidden) return null;

  return (
    <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>Photo library</div>
        <span style={{ fontSize: '11px', color: 'var(--text3)' }}>from Google Drive · tap to import</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => load()} disabled={loading} style={{ fontSize: '12px', padding: '4px 9px' }}>{loading ? 'Loading…' : '↻'}</button>
        <button onClick={() => setOpen(o => !o)} style={{ fontSize: '12px', padding: '4px 9px' }}>{open ? 'Hide' : `Show (${files.length})`}</button>
      </div>

      {err && <div style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--danger)' }}>{err}</div>}

      {open && (
        <>
          {!loading && !err && !files.length && (
            <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text3)' }}>
              No photos in the Drive folder yet — add some from your phone's Drive app, then hit ↻.
            </div>
          )}
          {!!files.length && (
            <div style={{ marginTop: '10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(78px, 1fr))', gap: '8px' }}>
              {files.map(f => (
                <button key={f.id} onClick={() => importFile(f)} disabled={!!busy[f.id]} title={`Import ${f.name}`}
                  style={{ position: 'relative', padding: 0, border: '0.5px solid var(--border2)', borderRadius: '8px', overflow: 'hidden', aspectRatio: '1 / 1', cursor: 'pointer', background: 'var(--bg3)' }}>
                  <DriveThumb url={`/api/marketing/drive/${locId}/thumb/${f.id}`} token={token} alt={f.name} />
                  {(busy[f.id] || done[f.id]) && (
                    <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: '11px', fontWeight: 600 }}>
                      {busy[f.id] ? '…' : '✓ added'}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
