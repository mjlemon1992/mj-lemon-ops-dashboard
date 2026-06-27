import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Google Drive photo library. Browse the location's shared Drive folder, preview a photo
// full-size, then "Add to posts" (server pulls it -> HEIC->JPEG -> captions -> approval
// queue). Thumbnails/preview load via authenticated fetch (an <img> tag can't send a
// Bearer header), so each is fetched as a blob. Self-hides when Drive isn't configured.

function AuthImg({ url, token, alt, style }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let obj; let cancel = false;
    setSrc(null);
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('img'))))
      .then(b => { if (!cancel) { obj = URL.createObjectURL(b); setSrc(obj); } })
      .catch(() => {});
    return () => { cancel = true; if (obj) URL.revokeObjectURL(obj); };
  }, [url, token]);
  return src
    ? <img src={src} alt={alt} style={style} />
    : <div style={{ ...style, background: 'var(--bg3)' }} />;
}

const when = (d) => { try { return new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); } catch { return ''; } };

export default function DriveLibrary({ locId, onImported }) {
  const { api, token } = useAuth();
  const [hidden, setHidden] = useState(false);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState({});
  const [done, setDone] = useState({});
  const [open, setOpen] = useState(true);
  const [previewIdx, setPreviewIdx] = useState(null);   // index into files, or null
  const [note, setNote] = useState('');

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
      await api(`/marketing/drive/${locId}/import`, { method: 'POST', body: JSON.stringify({ fileId: f.id, note }) });
      setDone(d => ({ ...d, [f.id]: true }));
      setPreviewIdx(null); setNote('');
      if (onImported) onImported();
    } catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(b => { const n = { ...b }; delete n[f.id]; return n; }); }
  };

  if (hidden) return null;
  const preview = previewIdx != null ? files[previewIdx] : null;
  const step = (d) => setPreviewIdx(i => (i + d + files.length) % files.length);

  return (
    <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>Photo library</div>
        <span style={{ fontSize: '11px', color: 'var(--text3)' }}>from Google Drive · tap to preview</span>
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
              {files.map((f, idx) => (
                <button key={f.id} onClick={() => setPreviewIdx(idx)} title={`Preview ${f.name}`}
                  style={{ position: 'relative', padding: 0, border: '0.5px solid var(--border2)', borderRadius: '8px', overflow: 'hidden', aspectRatio: '1 / 1', cursor: 'pointer', background: 'var(--bg3)' }}>
                  <AuthImg url={`/api/marketing/drive/${locId}/thumb/${f.id}`} token={token} alt={f.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  {done[f.id] && (
                    <span style={{ position: 'absolute', top: 4, right: 4, background: 'var(--success)', color: '#0d1410', fontSize: '10px', fontWeight: 600, padding: '1px 5px', borderRadius: '10px' }}>✓</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Preview lightbox — look at the photo full-size, browse, then add it to posts */}
      {preview && (
        <div onClick={() => setPreviewIdx(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px', maxWidth: '720px', width: '100%', maxHeight: '92vh', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview.name}</div>
              <span style={{ fontSize: '11px', color: 'var(--text3)' }}>{when(preview.createdTime)} · {previewIdx + 1}/{files.length}</span>
              <button onClick={() => setPreviewIdx(null)} style={{ marginLeft: 'auto', border: 0, background: 'none', color: 'var(--text3)', fontSize: '18px', cursor: 'pointer' }} title="Close">✕</button>
            </div>

            <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', borderRadius: '8px', overflow: 'hidden' }}>
              <AuthImg url={`/api/marketing/drive/${locId}/thumb/${preview.id}?size=1200`} token={token} alt={preview.name}
                style={{ maxWidth: '100%', maxHeight: '64vh', objectFit: 'contain' }} />
              {files.length > 1 && <>
                <button onClick={() => step(-1)} title="Previous" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', border: 0, background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: '50%', width: 34, height: 34, fontSize: 18, cursor: 'pointer' }}>‹</button>
                <button onClick={() => step(1)} title="Next" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 0, background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: '50%', width: 34, height: 34, fontSize: 18, cursor: 'pointer' }}>›</button>
              </>}
            </div>

            <input value={note} onChange={e => setNote(e.target.value)} placeholder="optional note — e.g. 10R80 valve body, bay 3" />
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button className="primary" disabled={!!busy[preview.id]} onClick={() => importFile(preview)}>
                {busy[preview.id] ? 'Adding…' : '＋ Add to posts'}
              </button>
              {done[preview.id] && <span style={{ fontSize: '12px', color: 'var(--success)' }}>Added to the queue ✓</span>}
              <span style={{ flex: 1 }} />
              <button onClick={() => setPreviewIdx(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
