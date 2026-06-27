import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

const ORANGE = '#F05423';

const loadImg = (src) => new Promise((res, rej) => {
  const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
});

const wrapLines = (ctx, text, maxW) => {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
    }
    if (line) out.push(line);
  }
  return out;
};

// Render a branded 1080x1080 poster from generated copy -> JPEG Blob.
// Three distinct layouts (seasonal = bold dark, educational = clean light,
// testimonial = review card) all on the Mister Transmission palette.
async function renderPoster({ type, headline, subline, cta, locName }) {
  const S = 1080, M = 92;
  const INK = '#15171A', WHITE = '#FFFFFF', MUTE = '#6B7178';
  const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d');

  const roundRect = (x, y, w, h, r) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  };
  const para = (txt, font, color, x, y, maxW, lh) => {
    ctx.font = font; ctx.fillStyle = color;
    for (const ln of wrapLines(ctx, txt, maxW)) { ctx.fillText(ln, x, y); y += lh; }
    return y;
  };
  let logo = null; try { logo = await loadImg('/mt-logo.png'); } catch {}
  const drawLogo = (x, y, w) => { if (!logo) return 0; const h = w * logo.height / logo.width; ctx.drawImage(logo, x, y, w, h); return h; };
  const ctaPill = (bg, fg) => {
    const h = 96, y = S - 156;
    ctx.fillStyle = bg; roundRect(M, y, S - 2 * M, h, 16); ctx.fill();
    ctx.fillStyle = fg; ctx.font = `700 38px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(cta || 'Book your transmission check', S / 2, y + h / 2);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };
  const footer = (color) => { ctx.fillStyle = color; ctx.font = `500 26px ${FONT}`; ctx.fillText(locName || 'Parkland Transmission · Red Deer, AB', M, S - 36); };

  if (type === 'educational') {
    ctx.fillStyle = WHITE; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = ORANGE; ctx.fillRect(0, 0, S, 156);
    ctx.fillStyle = WHITE; ctx.font = `800 42px ${FONT}`; ctx.textBaseline = 'middle';
    ctx.fillText('DID YOU KNOW?', M, 80); ctx.textBaseline = 'alphabetic';
    let y = 320;
    y = para(headline, `800 72px ${FONT}`, INK, M, y, S - 2 * M, 84) + 20;
    para(subline, `400 36px ${FONT}`, '#454B52', M, y, S - 2 * M, 50);
    drawLogo(M, S - 320, 270);
    ctaPill(ORANGE, WHITE); footer(MUTE);
  } else if (type === 'testimonial') {
    ctx.fillStyle = WHITE; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = ORANGE; ctx.fillRect(0, 0, S, 14);
    const lh = drawLogo(M, M, 290);
    let y = M + lh + 78;
    ctx.fillStyle = ORANGE; ctx.font = `700 52px ${FONT}`; ctx.fillText('★★★★★', M, y); y += 40;
    ctx.fillStyle = 'rgba(240,84,35,0.16)'; ctx.font = `800 150px Georgia, serif`; ctx.fillText('“', M - 10, y + 96);
    y += 70;
    y = para(headline, `800 58px ${FONT}`, INK, M, y, S - 2 * M, 72) + 24;
    para(subline, `500 32px ${FONT}`, MUTE, M, y, S - 2 * M, 44);
    ctaPill(ORANGE, WHITE); footer(MUTE);
  } else { // seasonal — bold dark
    ctx.fillStyle = INK; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = ORANGE; ctx.beginPath(); ctx.moveTo(S, 0); ctx.lineTo(S, 240); ctx.lineTo(S - 240, 0); ctx.closePath(); ctx.fill();
    const lh = drawLogo(M, M, 300);
    let y = M + lh + 86;
    ctx.fillStyle = ORANGE; ctx.font = `800 30px ${FONT}`; ctx.fillText('SEASONAL', M, y);
    ctx.fillStyle = ORANGE; ctx.fillRect(M, y + 16, 84, 5); y += 70;
    y = para(headline, `800 78px ${FONT}`, WHITE, M, y, S - 2 * M, 90) + 22;
    para(subline, `400 36px ${FONT}`, '#B9BEC4', M, y, S - 2 * M, 50);
    ctaPill(ORANGE, WHITE); footer('#8A9099');
  }
  return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
}

// Capture a bay photo -> AI captions -> review/approve. Posting to FB/IG/GBP is
// deferred until Meta/GBP access clears, so "Approve" marks ready-to-post for now.
export default function ApprovalQueue({ locId, locName, onCount }) {
  const { api, token } = useAuth();
  const [configured, setConfigured] = useState(true);
  const [posts, setPosts] = useState([]);
  const [approved, setApproved] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState({});          // per-post regenerate-in-flight
  const [drafts, setDrafts] = useState({});      // per-post local caption edits
  const [posterType, setPosterType] = useState('seasonal');
  const [posterTopic, setPosterTopic] = useState('');
  const [genPoster, setGenPoster] = useState(false);
  const [ideas, setIdeas] = useState([]);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => { api('/marketing/posts/status').then(s => setConfigured(!!s.configured)).catch(() => {}); }, [api]);

  const refresh = useCallback(() => {
    if (!locId) return;
    setLoading(true); setErr(null);
    Promise.all([
      api(`/marketing/posts/${locId}/queue?status=draft`).catch(() => []),
      api(`/marketing/posts/${locId}/queue?status=approved`).catch(() => []),
    ]).then(([d, a]) => { setPosts(d || []); setApproved(a || []); setLoading(false); if (onCount) onCount({ drafts: (d || []).length, approved: (a || []).length }); });
  }, [locId, api, onCount]);
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
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic)$/i.test(file.name || '')) {
      setErr('That doesn’t look like an image file.'); return;
    }
    setUploading(true); setErr(null); setNotice(null);
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
      if (data.captionError) setNotice('Photo saved — but auto-captions failed. Write them in below, or hit Regenerate.');
      refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) onPick(f);
  };

  const regen = async (id) => {
    setBusy(s => ({ ...s, [id]: true })); setErr(null);
    try { await api(`/marketing/posts/post/${id}/regenerate`, { method: 'POST' }); refresh(); }
    catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(s => { const n = { ...s }; delete n[id]; return n; }); }
  };

  // Manual-post helpers (until Kelowna's Meta/GBP access is live).
  const copy = (text) => {
    if (!text) return;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => setNotice('Caption copied.')).catch(() => {});
    else setNotice('Copy not available in this browser.');
  };
  const download = (p) => {
    if (!p.image) return;
    const a = document.createElement('a');
    a.href = p.image; a.download = `marketing-${(p.location_name || 'post').toLowerCase().replace(/\s+/g, '-')}-${p.id.slice(0, 8)}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  // Generate a branded poster: AI writes the copy, we render it to an image,
  // then it goes through the normal intake -> becomes a draft (with captions).
  const makePoster = async () => {
    if (!locId) return;
    setGenPoster(true); setErr(null); setNotice(null);
    try {
      const copy = await api('/marketing/posts/poster-copy', { method: 'POST', body: JSON.stringify({ type: posterType, topic: posterTopic }) });
      const blob = await renderPoster({ type: posterType, ...copy, locName });
      const res = await fetch(`/api/marketing/posts/${locId}/intake?note=${encodeURIComponent(posterType + ' poster')}`, {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` }, body: blob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Poster upload failed');
      setPosterTopic('');
      setNotice(data.captionError ? 'Poster created — captions failed; write them in or hit Regenerate.' : 'Poster created — it’s in the queue below.');
      refresh();
    } catch (e) { setErr(String(e.message || e)); }
    finally { setGenPoster(false); }
  };

  // Ask AI for timely, seasonal poster ideas to build.
  const suggestIdeas = async () => {
    setIdeasLoading(true); setErr(null);
    try {
      const month = new Date().toLocaleDateString('en-CA', { month: 'long' });
      const res = await api('/marketing/posts/poster-ideas', { method: 'POST', body: JSON.stringify({ month }) });
      setIdeas(Array.isArray(res.ideas) ? res.ideas : []);
    } catch (e) { setErr(String(e.message || e)); }
    finally { setIdeasLoading(false); }
  };
  const useIdea = (idea) => {
    if (idea.type) setPosterType(idea.type);
    setPosterTopic(idea.topic || '');
    setIdeas([]);
  };

  const act = async (id, what) => {
    try {
      await api(`/marketing/posts/post/${id}/${what}`, { method: 'POST' });
      if (what === 'approve') setNotice('Approved — moved to “Ready to post” below.');
      refresh();
    } catch (e) { setErr(String(e.message || e)); }
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
    <div style={{ marginBottom: '22px', borderRadius: 'var(--radius-lg)', outline: dragOver ? '2px dashed var(--accent)' : 'none', outlineOffset: '6px' }}
      onDragOver={e => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={onDrop}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Approve &amp; post</div>
        <span style={{ fontSize: '11px', color: 'var(--text3)' }}>{posts.length} in queue · posting goes live once Meta/GBP access clears</span>
        <div style={{ flex: 1 }} />
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="optional note — e.g. 10R80 valve body, bay 3"
          style={{ width: '240px', maxWidth: '50vw' }} />
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
          onChange={e => onPick(e.target.files[0])} />
        <button className="primary" disabled={!configured || uploading || !locId}
          onClick={() => fileRef.current && fileRef.current.click()}>
          {uploading ? 'Generating…' : '📷 Capture / add photo'}
        </button>
      </div>
      <div style={{ fontSize: '11px', color: dragOver ? 'var(--accent)' : 'var(--text3)', marginBottom: '12px' }}>
        {dragOver ? 'Drop the photo to add it' : 'Tip: drag a photo straight from Photos or Finder anywhere onto this panel.'}
      </div>
      {notice && <div className="alert-strip" style={{ background: 'rgba(255,184,0,0.08)', borderColor: 'rgba(255,184,0,0.35)' }}><span style={{ color: 'var(--warning)' }}>{notice}</span></div>}

      {/* Generate a branded poster/ad (AI copy -> rendered to your brand template) */}
      <div style={{ marginBottom: '14px', padding: '10px 12px', background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: 'var(--text2)', fontWeight: 500 }}>Generate a poster</span>
          <select value={posterType} onChange={e => setPosterType(e.target.value)} style={{ width: 'auto' }}>
            <option value="seasonal">Seasonal</option>
            <option value="educational">Educational</option>
            <option value="testimonial">Testimonial</option>
          </select>
          <input value={posterTopic} onChange={e => setPosterTopic(e.target.value)}
            placeholder={posterType === 'testimonial' ? 'paste a customer quote (optional)' : 'topic / offer (optional)'}
            style={{ flex: 1, minWidth: '160px' }} />
          <button onClick={suggestIdeas} disabled={!configured || ideasLoading}>{ideasLoading ? 'Thinking…' : '💡 Suggest ideas'}</button>
          <button className="primary" disabled={!configured || genPoster || !locId} onClick={makePoster}>
            {genPoster ? 'Designing…' : '🎨 Generate poster'}
          </button>
        </div>
        {ideas.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
            <span style={{ fontSize: '11px', color: 'var(--text3)', alignSelf: 'center' }}>Timely ideas — click to use:</span>
            {ideas.map((idea, i) => (
              <button key={i} onClick={() => useIdea(idea)} title={idea.why || ''}
                style={{ fontSize: '12px', textAlign: 'left', maxWidth: '280px' }}>
                <span style={{ color: 'var(--accent)', textTransform: 'capitalize' }}>{idea.type}</span> · {idea.label || idea.topic}
              </button>
            ))}
          </div>
        )}
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
                  ? <img src={p.image} alt="" onClick={() => setLightbox(p.image)} title="Click to enlarge" style={{ width: 130, height: 130, objectFit: 'cover', borderRadius: 8, border: '0.5px solid var(--border)', flexShrink: 0, cursor: 'zoom-in' }} />
                  : <div style={{ width: 130, height: 130, borderRadius: 8, background: 'var(--bg3)', flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {p.note && <div style={{ fontSize: '12px', color: 'var(--text3)' }}>note: {p.note}</div>}
                  {CAPS.map(([k, label]) => (
                    <div key={k}>
                      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 3 }}>
                        <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
                        <button onClick={() => copy(cur[k])} style={{ marginLeft: 'auto', fontSize: '10px', padding: '1px 8px', border: 0, background: 'none', color: 'var(--info)' }}>Copy</button>
                      </div>
                      <textarea value={cur[k] || ''} onChange={e => editField(p.id, k, e.target.value, p.captions)}
                        rows={2}
                        style={{ width: '100%', resize: 'vertical', fontSize: '12.5px', lineHeight: 1.45 }} />
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '11px 14px', borderTop: '0.5px solid var(--border)', background: 'var(--bg3)' }}>
                <button className="primary" onClick={() => act(p.id, 'approve')}>Approve</button>
                {dirty && <button onClick={() => saveEdits(p.id)}>Save edits</button>}
                <button onClick={() => regen(p.id)} disabled={!!busy[p.id]}>{busy[p.id] ? 'Regenerating…' : '✨ Regenerate'}</button>
                <button onClick={() => download(p)}>⬇ Image</button>
                <span style={{ marginLeft: 'auto' }} />
                <span className="badge neutral">{p.location_name}</span>
                <button onClick={() => act(p.id, 'skip')} style={{ color: 'var(--text3)', border: 0, background: 'none' }}>Skip</button>
              </div>
            </div>
          );
        })}
      </div>

      {approved.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>
            Ready to post <span style={{ color: 'var(--text3)', fontWeight: 400 }}>({approved.length})</span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', margin: '2px 0 10px' }}>
            Approved and waiting — these publish automatically once Meta/GBP access is live.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {approved.map(p => (
              <div className="card" key={p.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '10px 12px', flexWrap: 'wrap' }}>
                {p.image
                  ? <img src={p.image} alt="" onClick={() => setLightbox(p.image)} title="Click to enlarge" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, flexShrink: 0, cursor: 'zoom-in' }} />
                  : <div style={{ width: 44, height: 44, borderRadius: 6, background: 'var(--bg3)', flexShrink: 0 }} />}
                <div style={{ flex: '1 1 160px', minWidth: 0, fontSize: '12px', color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.captions?.ig || p.note || '(no caption)'}
                </div>
                <span className="badge success">approved</span>
                <button onClick={() => download(p)} style={{ fontSize: '12px' }}>⬇ Image</button>
                <button onClick={() => copy(p.captions?.ig)} style={{ fontSize: '12px' }} title="Copy Instagram caption">IG</button>
                <button onClick={() => copy(p.captions?.fb)} style={{ fontSize: '12px' }} title="Copy Facebook caption">FB</button>
                <button onClick={() => copy(p.captions?.gbp)} style={{ fontSize: '12px' }} title="Copy Google caption">GBP</button>
                <button onClick={() => act(p.id, 'unapprove')} title="Back to drafts" style={{ color: 'var(--text3)', border: 0, background: 'none', fontSize: '13px' }}>↩</button>
                <button onClick={() => act(p.id, 'skip')} title="Remove" style={{ color: 'var(--text3)', border: 0, background: 'none', fontSize: '13px' }}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', cursor: 'zoom-out' }}>
          <img src={lightbox} alt="" style={{ maxWidth: '92vw', maxHeight: '92vh', borderRadius: 8, boxShadow: '0 10px 50px rgba(0,0,0,0.6)' }} />
        </div>
      )}
    </div>
  );
}
