import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Shop-floor notice board admin. What you post here rotates on the PIN-gated
// /display board in the bay — updates, shout-outs, safety notes, or full
// posters (paste an image URL, e.g. a marketing poster). Atlas can post too.
const KINDS = [
  { value: 'notice', label: 'ℹ Notice' },
  { value: 'celebration', label: '🎉 Shout-out' },
  { value: 'safety', label: '⚠ Safety' },
  { value: 'poster', label: '🖼 Poster (image)' }
];

const EXPIRY = [
  { value: '', label: 'Until turned off' },
  { value: '1', label: '1 day' },
  { value: '3', label: '3 days' },
  { value: '7', label: '1 week' },
  { value: '30', label: '30 days' }
];

// ── AI poster rendering (Claude designs the SVG server-side; we brand + rasterize) ──
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// Archivo embedded as base64 @font-face so the rasterized SVG uses the real
// brand font (a canvas-rendered SVG can't see webfonts). Best-effort; falls
// back to system sans. Not negatively cached — a transient failure retries.
let _fontCss;
async function getFontCss() {
  if (_fontCss !== undefined) return _fontCss;
  try {
    const css = await (await fetch('https://fonts.googleapis.com/css2?family=Archivo:wght@800')).text();
    const url = (css.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
    if (!url) return '';
    const blob = await (await fetch(url)).blob();
    const data = await new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = j; fr.readAsDataURL(blob); });
    _fontCss = `@font-face{font-family:'Archivo';font-style:normal;font-weight:800;src:url(${data}) format('woff2')}`;
    return _fontCss;
  } catch { return ''; }
}

// Brand the raw SVG (embed font, overlay the real logo) and rasterize to JPEG.
async function renderNoticePoster(svg, S = 1080) {
  const fontCss = await getFontCss();
  if (fontCss) svg = svg.replace(/<svg([^>]*)>/, (m, attrs) => `<svg${attrs}><defs><style>${fontCss}</style></defs>`);
  try {
    const blob = await (await fetch('/mt-logo-v2.png')).blob();
    const logoData = await new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = j; fr.readAsDataURL(blob); });
    const im = await loadImg(logoData);
    const w = 230, h = Math.round(w * (im.height / im.width));
    svg = svg.replace('</svg>', `<image href="${logoData}" x="44" y="44" width="${w}" height="${h}"/></svg>`);
  } catch { /* logo overlay is best-effort */ }
  const img = await loadImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0A0B0D'; ctx.fillRect(0, 0, S, S);
  ctx.drawImage(img, 0, 0, S, S);
  const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  if (!out) throw new Error('Poster render failed');
  return out;
}

export default function Notices() {
  const { api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState(null);
  const [designing, setDesigning] = useState(false);
  const [genBlob, setGenBlob] = useState(null);       // AI-designed poster, ready to upload
  const [genPreview, setGenPreview] = useState(null); // object URL for the preview <img>
  const [form, setForm] = useState({ location_id: '', kind: 'notice', title: '', body: '', image_url: '', expires_days: '' });

  const [ideas, setIdeas] = useState([]);
  const [ideasLoading, setIdeasLoading] = useState(false);

  const clearGenerated = () => {
    if (genPreview) URL.revokeObjectURL(genPreview);
    setGenBlob(null); setGenPreview(null);
  };

  // Board-flavoured idea suggestions: safety reminder, metrics-aware team
  // encouragement, seasonal/culture piece, wildcard. Picking one fills the form.
  const suggestIdeas = async () => {
    setIdeasLoading(true); setError('');
    try {
      const d = await api('/notices/poster-ideas', { method: 'POST', body: JSON.stringify({ location_id: form.location_id || null }) });
      setIdeas(Array.isArray(d.ideas) ? d.ideas : []);
    } catch (e2) { setError(e2.message || 'Could not fetch ideas'); }
    setIdeasLoading(false);
  };
  const useIdea = (idea) => {
    setForm(f => ({ ...f, kind: idea.kind || 'notice', title: idea.title || '', body: idea.body || '' }));
    clearGenerated();
    setIdeas([]);
  };

  // Claude designs the poster from the title/message/type above; we brand it
  // (font + real logo), rasterize, and hold it as the pending upload.
  const generatePoster = async () => {
    if (!form.title.trim()) { setError('Give the poster a title first — that becomes the headline.'); return; }
    setDesigning(true); setError('');
    try {
      // Board selection drives the branding: one location -> that shop's line,
      // All locations -> the combined Red Deer & Kelowna line.
      const d = await api('/notices/design-poster', { method: 'POST', body: JSON.stringify({ title: form.title, body: form.body, kind: form.kind, location_id: form.location_id || null }) });
      const blob = await renderNoticePoster(d.svg);
      if (genPreview) URL.revokeObjectURL(genPreview);
      setGenBlob(blob); setGenPreview(URL.createObjectURL(blob));
      setFile(null);   // generated poster replaces any picked file
    } catch (e2) { setError(e2.message || 'Poster generation failed — try again'); }
    setDesigning(false);
  };

  const load = useCallback(() => {
    api('/notices').then(setItems).catch(e => setError(e.message || 'Failed to load'));
  }, [api]);

  useEffect(() => {
    api('/locations').then(setLocations).catch(() => {});
    load();
  }, [api, load]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    const upload = genBlob || file;   // AI-designed poster or a picked file
    if (!form.title && !form.body && !form.image_url && !upload) { setError('Add a title, message, image URL or upload a poster'); return; }
    // A poster with no image renders as a text banner on the board — the exact
    // confusion this guard prevents. Require an image (or generate one) first.
    if (form.kind === 'poster' && !upload && !form.image_url) {
      setError('A poster needs an image — upload one, paste a URL, or hit ✨ Generate poster.');
      return;
    }
    setSaving(true); setError('');
    try {
      const expires_at = form.expires_days
        ? new Date(Date.now() + Number(form.expires_days) * 86400000).toISOString()
        : null;
      const created = await api('/notices', {
        method: 'POST',
        body: JSON.stringify({
          location_id: form.location_id || null,
          // A generated image is a full poster: publish as kind 'poster' so the
          // board page-flips it full-screen (the chosen kind still set its mood).
          kind: genBlob ? 'poster' : form.kind,
          title: form.title || null,
          body: form.body || null,
          image_url: form.image_url || null,
          pending_image: !!upload,
          expires_at
        })
      });
      // Poster bytes upload as a raw image body (same pattern as marketing intake).
      if (upload && created && created.id) {
        try {
          await api(`/notices/${created.id}/image`, {
            method: 'POST',
            headers: { 'Content-Type': (upload.type || 'image/jpeg') },
            body: upload
          });
        } catch (upErr) {
          // Don't leave an empty notice on the board if the file didn't make it.
          try { await api(`/notices/${created.id}`, { method: 'DELETE' }); } catch (e3) {}
          throw upErr;
        }
      }
      setForm({ location_id: '', kind: 'notice', title: '', body: '', image_url: '', expires_days: '' });
      setFile(null);
      clearGenerated();
      load();
    } catch (e2) { setError(e2.message || 'Failed to save'); }
    setSaving(false);
  };

  const toggle = async (id) => { try { await api(`/notices/${id}/toggle`, { method: 'POST' }); load(); } catch (e) {} };
  const remove = async (id) => { try { await api(`/notices/${id}`, { method: 'DELETE' }); load(); } catch (e) {} };

  const locName = (id) => (locations.find(l => l.id === id) || {}).name || 'Unknown';

  const input = { width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)', fontSize: '14px' };
  const label = { fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px', display: 'block' };

  return (
    <div>
      <h1 style={{ marginBottom: '4px' }}>Shop Notices</h1>
      <div style={{ color: 'var(--text3)', fontSize: '14px', marginBottom: '24px' }}>
        Whatever is active here rotates on the shop-floor display so the techs see it — updates, shout-outs, safety notes, or full posters.
      </div>

      <form onSubmit={submit} style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '14px', padding: '20px', marginBottom: '28px', display: 'grid', gap: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px' }}>
          <div>
            <span style={label}>Board</span>
            <select value={form.location_id} onChange={e => set('location_id', e.target.value)} style={input}>
              <option value="">All locations</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <span style={label}>Type</span>
            <select value={form.kind} onChange={e => set('kind', e.target.value)} style={input}>
              {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </div>
          <div>
            <span style={label}>Runs for</span>
            <select value={form.expires_days} onChange={e => set('expires_days', e.target.value)} style={input}>
              {EXPIRY.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <span style={label}>Title</span>
          <input value={form.title} onChange={e => set('title', e.target.value.slice(0, 200))} placeholder="e.g. Great job on the June numbers" style={input} />
        </div>
        <div>
          <span style={label}>Message</span>
          <textarea value={form.body} onChange={e => set('body', e.target.value)} rows={3} placeholder="Optional detail shown under the title" style={{ ...input, resize: 'vertical' }} />
        </div>
        <div style={{ padding: '12px 14px', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <button type="button" className="primary" onClick={generatePoster} disabled={designing || !form.title.trim()}
              style={{ padding: '9px 18px', fontSize: '14px' }}>
              {designing ? 'Designing…' : '✨ Generate poster'}
            </button>
            <button type="button" onClick={suggestIdeas} disabled={ideasLoading}
              style={{ padding: '9px 18px', fontSize: '14px' }}>
              {ideasLoading ? 'Thinking…' : '💡 Suggest ideas'}
            </button>
            <span style={{ fontSize: '12px', color: 'var(--text3)' }}>
              Claude designs a board poster from the title, message and type above. Branding follows the Board choice — one shop gets its own line, “All locations” gets the combined brand.
            </span>
          </div>
          {ideas.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
              {ideas.map((idea, i) => (
                <button key={i} type="button" onClick={() => useIdea(idea)} title={idea.why || ''}
                  style={{ textAlign: 'left', padding: '10px 14px', borderRadius: '10px', border: '0.5px solid var(--border)', background: 'var(--bg2)', cursor: 'pointer' }}>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)' }}>
                    {(KINDS.find(k => k.value === idea.kind) || KINDS[0]).label} · {idea.title}
                  </span>
                  {idea.body && <span style={{ display: 'block', fontSize: '12px', color: 'var(--text2)', marginTop: '3px' }}>{idea.body}</span>}
                  {idea.why && <span style={{ display: 'block', fontSize: '11px', color: 'var(--text3)', marginTop: '3px' }}>why now: {idea.why}</span>}
                </button>
              ))}
            </div>
          )}
          {genPreview && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', marginTop: '12px' }}>
              <img src={genPreview} alt="Generated poster preview"
                style={{ width: '220px', height: '220px', objectFit: 'cover', borderRadius: '10px', border: '0.5px solid var(--border)' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <button type="button" onClick={generatePoster} disabled={designing} style={{ padding: '7px 14px', fontSize: '13px' }}>
                  {designing ? 'Designing…' : '↻ Regenerate'}
                </button>
                <button type="button" onClick={clearGenerated} style={{ padding: '7px 14px', fontSize: '13px', color: 'var(--danger)' }}>✕ Discard</button>
                <span style={{ fontSize: '12px', color: 'var(--text3)', maxWidth: '260px' }}>
                  Happy with it? Hit “Post to board” — it publishes full-screen on the shop display.
                </span>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <div>
            <span style={label}>…or upload a poster {form.kind === 'poster' ? '(shown full size)' : '(optional, shown small)'}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={e => { const f = e.target.files && e.target.files[0] ? e.target.files[0] : null; setFile(f); if (f) clearGenerated(); }}
              style={{ ...input, padding: '8px 12px' }} />
            {file && <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '4px' }}>{file.name} · {Math.round(file.size / 1024)} KB</div>}
          </div>
          <div>
            <span style={label}>…or image URL</span>
            <input value={form.image_url} onChange={e => set('image_url', e.target.value)} placeholder="https://…" style={input} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button className="primary" type="submit" disabled={saving} style={{ padding: '10px 28px', fontSize: '15px' }}>
            {saving ? 'Posting…' : 'Post to board'}
          </button>
          {error && <span style={{ color: 'var(--danger)', fontSize: '14px' }}>{error}</span>}
        </div>
      </form>

      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '14px', overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px', borderBottom: '0.5px solid var(--border)', fontSize: '13px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Posted notices
        </div>
        {items.length === 0 && <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text3)' }}>Nothing posted yet.</div>}
        {items.map(n => {
          const kind = KINDS.find(k => k.value === n.kind) || KINDS[0];
          const expired = n.expires_at && new Date(n.expires_at) < new Date();
          const live = n.active && !expired;
          return (
            <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '14px 20px', borderBottom: '0.5px solid var(--border)', opacity: live ? 1 : 0.55 }}>
              <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.08em', padding: '3px 10px', borderRadius: '10px', background: live ? 'var(--success)' : 'var(--bg3)', color: live ? '#1a1a1a' : 'var(--text3)', flexShrink: 0 }}>
                {live ? 'LIVE' : (expired ? 'EXPIRED' : 'OFF')}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {kind.label} · {n.title || n.body || (n.image_url || n.has_image ? 'Image poster' : '(empty)')}{n.has_image ? ' · 🖼' : ''}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '2px' }}>
                  {n.location_id ? locName(n.location_id) : 'All locations'} · by {n.created_by || '—'} · {new Date(n.created_at).toLocaleDateString('en-CA')}
                  {n.expires_at ? ` · until ${new Date(n.expires_at).toLocaleDateString('en-CA')}` : ''}
                </div>
              </div>
              <button onClick={() => toggle(n.id)} style={{ padding: '6px 14px', fontSize: '13px' }}>{n.active ? 'Turn off' : 'Turn on'}</button>
              <button onClick={() => remove(n.id)} style={{ padding: '6px 14px', fontSize: '13px', color: 'var(--danger)' }}>Delete</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
