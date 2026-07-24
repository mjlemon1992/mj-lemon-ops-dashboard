import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Google Drive photo library, shown as a modal you open from the capture row. Browse the
// location's shared Drive folder, preview a photo full-size, then "Add to posts" (server
// pulls it -> HEIC->JPEG -> captions -> approval queue). Images load via authenticated
// fetch (an <img> tag can't send a Bearer header), so each is fetched as a blob.

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
  return src ? <img src={src} alt={alt} style={style} /> : <div style={{ ...style, background: 'var(--bg3)' }} />;
}

const when = (d) => { try { return new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); } catch { return ''; } };

export default function DriveLibrary({ locId, onImported, onClose, defaultNote }) {
  const { api, token } = useAuth();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState({});
  const [done, setDone] = useState({});
  const [previewIdx, setPreviewIdx] = useState(null);
  const [note, setNote] = useState(defaultNote || '');   // inherit a seeded shot note

  const load = useCallback(() => {
    if (!locId) return;
    let cancel = false;
    setLoading(true); setErr(null);
    api(`/marketing/drive/${locId}/list`)
      .then(d => { if (!cancel) setFiles(d.files || []); })
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

  const preview = previewIdx != null ? files[previewIdx] : null;
  const step = (d) => setPreviewIdx(i => (i + d + files.length) % files.length);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px' }}>
        <div onClick={e => e.stopPropagation()}
          style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 16px', maxWidth: '760px', width: '100%', maxHeight: '84vh', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ fontSize: 'var(--fz-body)', fontWeight: 600, color: 'var(--text)' }}>Photo library</div>
            <span style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)' }}>Google Drive · tap to preview, then add</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => load()} disabled={loading} style={{ fontSize: 'var(--fz-label)', padding: '4px 9px' }}>{loading ? 'Loading…' : '↻'}</button>
            <button onClick={onClose} title="Close" style={{ border: 0, background: 'none', color: 'var(--text3)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
          </div>

          {err && <div style={{ fontSize: 'var(--fz-label)', color: 'var(--danger)' }}>{err}</div>}
          {!loading && !err && !files.length && (
            <div style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)', padding: '12px 0' }}>
              No photos in the Drive folder yet — add some from your phone's Drive app, then hit ↻.
            </div>
          )}

          <div style={{ overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: '8px' }}>
            {files.map((f, idx) => (
              <button key={f.id} onClick={() => setPreviewIdx(idx)} title={`Preview ${f.name}`}
                style={{ position: 'relative', padding: 0, border: '0.5px solid var(--border2)', borderRadius: 'var(--radius)', overflow: 'hidden', aspectRatio: '1 / 1', cursor: 'pointer', background: 'var(--bg3)' }}>
                <AuthImg url={`/api/marketing/drive/${locId}/thumb/${f.id}`} token={token} alt={f.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                {done[f.id] && (
                  <span style={{ position: 'absolute', top: 4, right: 4, background: 'var(--success)', color: '#0d1410', fontSize: 'var(--fz-micro)', fontWeight: 600, padding: '1px 5px', borderRadius: 'var(--radius)' }}>✓</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Full-size preview — browse + add */}
      {preview && (
        <div onClick={() => setPreviewIdx(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px', maxWidth: '720px', width: '100%', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ fontSize: 'var(--fz-body)', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview.name}</div>
              <span style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)' }}>{when(preview.createdTime)} · {previewIdx + 1}/{files.length}</span>
              <button onClick={() => setPreviewIdx(null)} style={{ marginLeft: 'auto', border: 0, background: 'none', color: 'var(--text3)', fontSize: '18px', cursor: 'pointer' }} title="Back to grid">✕</button>
            </div>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              <AuthImg url={`/api/marketing/drive/${locId}/thumb/${preview.id}?size=1200`} token={token} alt={preview.name}
                style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain' }} />
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
              {done[preview.id] && <span style={{ fontSize: 'var(--fz-label)', color: 'var(--success)' }}>Added ✓</span>}
              <span style={{ flex: 1 }} />
              <button onClick={() => setPreviewIdx(null)}>Back</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
