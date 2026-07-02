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

export default function Notices() {
  const { api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({ location_id: '', kind: 'notice', title: '', body: '', image_url: '', expires_days: '' });

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
    if (!form.title && !form.body && !form.image_url && !file) { setError('Add a title, message, image URL or upload a poster'); return; }
    setSaving(true); setError('');
    try {
      const expires_at = form.expires_days
        ? new Date(Date.now() + Number(form.expires_days) * 86400000).toISOString()
        : null;
      const created = await api('/notices', {
        method: 'POST',
        body: JSON.stringify({
          location_id: form.location_id || null,
          kind: form.kind,
          title: form.title || null,
          body: form.body || null,
          image_url: form.image_url || null,
          pending_image: !!file,
          expires_at
        })
      });
      // Poster file uploads as a raw image body (same pattern as marketing intake).
      if (file && created && created.id) {
        try {
          await api(`/notices/${created.id}/image`, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'image/jpeg' },
            body: file
          });
        } catch (upErr) {
          // Don't leave an empty notice on the board if the file didn't make it.
          try { await api(`/notices/${created.id}`, { method: 'DELETE' }); } catch (e3) {}
          throw upErr;
        }
      }
      setForm({ location_id: '', kind: 'notice', title: '', body: '', image_url: '', expires_days: '' });
      setFile(null);
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <div>
            <span style={label}>Upload poster {form.kind === 'poster' ? '(shown full size)' : '(optional, shown small)'}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={e => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
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
