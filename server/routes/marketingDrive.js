const express = require('express');
const { authenticateToken, requireOwnerOrPartner } = require('../middleware/auth');
const { JWT } = require('google-auth-library');
const heicConvert = require('heic-convert');

// Marketing: Google Drive photo library. Dump phone photos into a shared Drive folder
// (native Drive app — reliable on any connection), then the dashboard lists them and
// imports the one you pick: server-side pull -> HEIC->JPEG -> captions -> draft in the
// approval queue. No browser upload, so it sidesteps the mobile "failed to fetch".
//
// Setup: a Google Cloud service account (same project as the Maps key), Drive API enabled,
// and the target folder SHARED with the service account's email. Env:
//   GOOGLE_SERVICE_ACCOUNT_JSON  - the downloaded service-account key file (full JSON)
//   GOOGLE_DRIVE_FOLDER_ID       - default folder id (per-location override:
//                                  locations.google_drive_folder_id)
// Ships dark: missing creds -> /status configured:false, the UI hides the panel.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const FOLDER_ENV = process.env.GOOGLE_DRIVE_FOLDER_ID || null;
const OK_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let _sa = null;
try { _sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : null; } catch { _sa = null; }
const SA_OK = !!(_sa && _sa.client_email && _sa.private_key);

// Same brand voice as the capture flow (kept in sync with marketingPosts.js).
const CAPTION_SYSTEM = `You write social media captions for an automotive TRANSMISSION repair shop
(Mister Transmission — Parkland Transmission, Red Deer & Kelowna). You are given a photo from the
shop floor and an optional short note. Write platform-specific captions for the photo.

Brand voice: expert and plain-spoken, honest, no hype or clickbait. Red Seal technicians; happy to
give an honest second opinion; "we fix it right." Never invent specifics that aren't in the photo
or note (no fake prices, names, or claims).

Output ONLY a single JSON object, no prose, no fences:
{
  "instagram": "punchy, 1-3 short lines, end with 4-6 relevant hashtags",
  "facebook": "conversational, 2-4 sentences, a soft call-to-action, no hashtag spam",
  "gbp": "Google Business Profile post: 1-2 sentences, informative, a clear call-to-action"
}`;

module.exports = (pool) => {
  const router = express.Router();

  let _init = false;
  const ensure = async () => {
    if (_init) return;
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS google_drive_folder_id VARCHAR(255)');
    await pool.query(`CREATE TABLE IF NOT EXISTS marketing_post (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
        location_name VARCHAR(255), status VARCHAR(20) NOT NULL DEFAULT 'draft',
        note TEXT, image_data BYTEA, image_mime VARCHAR(60),
        caption_ig TEXT, caption_fb TEXT, caption_gbp TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), actioned_at TIMESTAMPTZ)`);
    _init = true;
  };

  // ── Google Drive (service account, read-only) ──
  const accessToken = async () => {
    const client = new JWT({
      email: _sa.client_email,
      key: String(_sa.private_key).replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const { token } = await client.getAccessToken();
    if (!token) throw Object.assign(new Error('Could not get a Google access token'), { status: 502 });
    return token;
  };

  const drive = async (path, params) => {
    const tok = await accessToken();
    const qs = params ? `?${new URLSearchParams({ supportsAllDrives: 'true', ...params })}` : '';
    const r = await fetch(`https://www.googleapis.com/drive/v3/${path}${qs}`, { headers: { Authorization: `Bearer ${tok}` } });
    return r;
  };

  const folderFor = async (locId) => {
    const { rows } = await pool.query('SELECT google_drive_folder_id FROM locations WHERE id=$1', [locId]);
    if (!rows.length) throw Object.assign(new Error('Location not found'), { status: 404 });
    return rows[0].google_drive_folder_id || FOLDER_ENV;
  };

  const listImages = async (folderId) => {
    const r = await drive('files', {
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: 'files(id,name,mimeType,createdTime,size,hasThumbnail)',
      orderBy: 'createdTime desc', pageSize: '60', includeItemsFromAllDrives: 'true',
    });
    const d = await r.json();
    if (!r.ok) throw Object.assign(new Error(`Drive ${r.status}: ${JSON.stringify(d).slice(0, 200)}`), { status: 502 });
    return d.files || [];
  };

  const getMeta = async (fileId) => {
    const r = await drive(`files/${fileId}`, { fields: 'id,name,mimeType,thumbnailLink' });
    const d = await r.json();
    if (!r.ok) throw Object.assign(new Error(`Drive meta ${r.status}`), { status: 502 });
    return d;
  };

  const download = async (fileId) => {
    const r = await drive(`files/${fileId}`, { alt: 'media' });
    if (!r.ok) throw Object.assign(new Error(`Drive download ${r.status}`), { status: 502 });
    return Buffer.from(await r.arrayBuffer());
  };

  const isHeic = (mime, name) => /image\/(heic|heif)/i.test(mime || '') || /\.(heic|heif)$/i.test(name || '');
  const toJpegIfHeic = async (buf, mime, name) => {
    if (!isHeic(mime, name)) return { buf, mime: (mime || '').toLowerCase() };
    const out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.62 });
    return { buf: Buffer.from(out), mime: 'image/jpeg' };
  };

  // ── Captions (Anthropic vision; kept in sync with marketingPosts.js) ──
  const generate = async (imageBase64, mime, note) => {
    if (!ANTHROPIC_KEY) throw Object.assign(new Error('ANTHROPIC_API_KEY not set'), { status: 503 });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1200, system: CAPTION_SYSTEM,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: imageBase64 } },
          { type: 'text', text: `Write the captions.${note ? ` Shop note: "${note}".` : ''}` },
        ] }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(`Anthropic ${res.status}: ${JSON.stringify(body).slice(0, 300)}`), { status: 502 });
    let raw = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
    const j = JSON.parse(raw);
    return { ig: j.instagram || '', fb: j.facebook || '', gbp: j.gbp || '' };
  };

  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });
  const gate = [authenticateToken, requireOwnerOrPartner];

  router.get('/status', ...gate, (req, res) => res.json({ configured: SA_OK, hasDefaultFolder: !!FOLDER_ENV }));

  // List images in the location's Drive folder.
  router.get('/:locationId/list', ...gate, async (req, res) => {
    try {
      await ensure();
      if (!SA_OK) return res.status(503).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not set' });
      const folderId = await folderFor(req.params.locationId);
      if (!folderId) return res.status(503).json({ error: 'No Drive folder set for this location (locations.google_drive_folder_id or GOOGLE_DRIVE_FOLDER_ID)' });
      const files = await listImages(folderId);
      res.json({ files: files.map(f => ({ id: f.id, name: f.name, mime: f.mimeType, createdTime: f.createdTime, size: f.size, hasThumbnail: !!f.hasThumbnail })) });
    } catch (e) { fail(res, e); }
  });

  // Auth'd thumbnail proxy (img tags can't send a Bearer header, so the client fetches
  // this via authenticated fetch -> blob). Prefers Drive's thumbnail; falls back to the
  // full file (converted if HEIC).
  router.get('/:locationId/thumb/:fileId', ...gate, async (req, res) => {
    try {
      if (!SA_OK) return res.status(503).end();
      const meta = await getMeta(req.params.fileId);
      if (meta.thumbnailLink) {
        const tok = await accessToken();
        const url = meta.thumbnailLink.replace(/=s\d+$/, '=s400').replace(/=w\d+(-h\d+)?$/, '=w400');
        const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
        if (r.ok) {
          res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
          res.set('Cache-Control', 'private, max-age=3600');
          return res.send(Buffer.from(await r.arrayBuffer()));
        }
      }
      const { buf, mime } = await toJpegIfHeic(await download(req.params.fileId), meta.mimeType, meta.name);
      res.set('Content-Type', mime || 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(buf);
    } catch (e) { fail(res, e); }
  });

  // Import a chosen Drive image -> draft + captions in the approval queue.
  router.post('/:locationId/import', ...gate, async (req, res) => {
    try {
      await ensure();
      if (!SA_OK) return res.status(503).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not set' });
      const { fileId, note: rawNote } = req.body || {};
      if (!fileId) return res.status(400).json({ error: 'fileId required' });

      const { rows: lr } = await pool.query('SELECT name FROM locations WHERE id=$1', [req.params.locationId]);
      if (!lr.length) return res.status(404).json({ error: 'Location not found' });
      const name = lr[0].name;
      const note = (rawNote || '').toString().slice(0, 500);

      const meta = await getMeta(fileId);
      const { buf, mime } = await toJpegIfHeic(await download(fileId), meta.mimeType, meta.name);
      if (!OK_MIME.includes(mime)) return res.status(415).json({ error: `Unsupported image type "${mime}".` });

      const { rows } = await pool.query(
        `INSERT INTO marketing_post (location_id, location_name, status, note, image_data, image_mime)
         VALUES ($1,$2,'draft',$3,$4,$5) RETURNING id`,
        [req.params.locationId, name, note || null, buf, mime]
      );
      const id = rows[0].id;

      let captionError = null;
      try {
        const caps = await generate(buf.toString('base64'), mime, note);
        await pool.query('UPDATE marketing_post SET caption_ig=$1, caption_fb=$2, caption_gbp=$3 WHERE id=$4', [caps.ig, caps.fb, caps.gbp, id]);
      } catch (e) { captionError = String(e.message || e); }

      res.json({ ok: true, id, captionError });
    } catch (e) { fail(res, e); }
  });

  return router;
};
