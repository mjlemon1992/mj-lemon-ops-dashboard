import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Capture a bay photo -> AI captions -> review/approve. Posting to FB/IG/GBP is
// deferred until Meta/GBP access clears, so "Approve" marks ready-to-post for now.
export default function ApprovalQueue({ locId }) {
  const { api, token } = useAuth();
  const [configured, setConfigured] = useState(true);
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  const [drafts, setDrafts] = useState({});      // per-post local caption edits
  const fileRef = useRef(null);

  useEffect(() => { api('/marketing/posts/status').then(s => setConfigured(!!s.configured)).catch(() => {}); }, [api]);

  const refresh = useCallback(() => {
    if (!locId) return;
    setLoading(true); setErr(null);
    api(`/marketing/posts/${locId}/queue`).then(p => { setPosts(p || []); setLoading(false); })
      .catch(e => { setErr(String(e.message || e)); setLoading(false); });
  }, [locId, api]);
  useEffect(() => { refresh(); }, [refresh]);

  // Downscale to a sane JPEG before upload: keeps the request small (a full-res
  // phone photo can reset the connection -> "Failed to fetch"), speeds the vision
  // call, and normalizes format. Falls back to the original if it can't decode
  // (e.g. HEIC in Chrome) so the server can return a clear unsupported-type error.
  const prepImage = async (file) => {
    try {
      const bmp = await createImageBitmap(file);
      const max = 1600;
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      return blob && blob.size ? blob : file;
    } catch { return file; }
  };

  const onPick = async (file) => {
    if (!file) return;
    setUploading(true); setErr(null);
    try {
      const img = await prepImage(file);
      const res = await fetch(`/api/marketing/posts/${locId}/intake?note=${encodeURIComponent(note)}`, {
        method: 'POST',
        headers: { 'Content-Type': img.type || 'image/jpeg', Authorization: `Bearer ${token}` },
        body: img,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setNote('');
      refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const act = async (id, what) => {
    try { await api(`/marketing/posts/post/${id}/${what}`, { method: 'POST' }); refresh(); }
    catch (e) { setErr(String(e.message || e)); }
  };
  const saveEdits = async (id) => {
    const d = drafts[id]; if (!d) return;
    try {
      await api(`/marketing/posts/post/${id}`, { method: 'PATCH', body: JSON.stringify(d) });
      setDrafts(s => { const n = { ...s }; delete n[id]; return n; });
      refresh();
    } catch (e) { setErr(String(e.message || e)); }
  };
  const editField = (id, key, val, current) =>
    setDrafts(s => ({ ...s, [id]: { ig: current.ig, fb: current.fb, gbp: current.gbp, ...s[id], [key]: val } }));

  const CAPS = [['ig', 'Instagram'], ['fb', 'Facebook'], ['gbp', 'Google']];

  return (
    <div style={{ marginBottom: '22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Approve &amp; post</div>
        <span style={{ fontSize: '11px', color: 'var(--text3)' }}>{posts.length} in queue · posting goes live once Meta/GBP access clears</span>
        <div style={{ flex: 1 }} />
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="optional note — e.g. 10R80 valve body, bay 3"
          style={{ width: '260px', maxWidth: '50vw' }} />
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
          onChange={e => onPick(e.target.files[0])} />
        <button className="primary" disabled={!configured || uploading || !locId}
          onClick={() => fileRef.current && fileRef.current.click()}>
          {uploading ? 'Generating…' : '📷 Capture / add photo'}
        </button>
      </div>

      {!configured && (
        <div className="alert-strip" style={{ background: 'rgba(77,184,255,0.06)', borderColor: 'rgba(77,184,255,0.3)' }}>
          <span style={{ color: 'var(--info)' }}>Caption generation not configured.</span>
          <span style={{ fontSize: '12px', color: 'var(--text2)' }}>Set <code>ANTHROPIC_API_KEY</code> to enable photo → captions.</span>
        </div>
      )}
      {err && <div className="alert-strip" style={{ background: 'rgba(255,77,77,0.07)', borderColor: 'rgba(255,77,77,0.3)' }}><span style={{ color: 'var(--danger)' }}>{err}</span></div>}

      {loading && <div style={{ color: 'var(--text3)', padding: '20px' }}>Loading queue…</div>}

      {!loading && posts.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text3)', padding: '28px' }}>
          Nothing waiting. Snap a photo on the floor — AI drafts the captions, you approve.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {posts.map(p => {
          const cur = drafts[p.id] || p.captions;
          const dirty = !!drafts[p.id];
          return (
            <div className="card" key={p.id} style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'flex', gap: '14px', padding: '14px' }}>
                {p.image
                  ? <img src={p.image} alt="" style={{ width: 130, height: 130, objectFit: 'cover', borderRadius: 8, border: '0.5px solid var(--border)', flexShrink: 0 }} />
                  : <div style={{ width: 130, height: 130, borderRadius: 8, background: 'var(--bg3)', flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {p.note && <div style={{ fontSize: '12px', color: 'var(--text3)' }}>note: {p.note}</div>}
                  {CAPS.map(([k, label]) => (
                    <div key={k}>
                      <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{label}</div>
                      <textarea value={cur[k] || ''} onChange={e => editField(p.id, k, e.target.value, p.captions)}
                        rows={k === 'gbp' ? 2 : 2}
                        style={{ width: '100%', resize: 'vertical', fontSize: '12.5px', lineHeight: 1.45 }} />
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '11px 14px', borderTop: '0.5px solid var(--border)', background: 'var(--bg3)' }}>
                <button className="primary" onClick={() => act(p.id, 'approve')}>Approve</button>
                {dirty && <button onClick={() => saveEdits(p.id)}>Save edits</button>}
                <span style={{ marginLeft: 'auto' }} />
                <span className="badge neutral">{p.location_name}</span>
                <button onClick={() => act(p.id, 'skip')} style={{ color: 'var(--text3)', border: 0, background: 'none' }}>Skip</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
