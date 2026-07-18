import { askConfirm, showToast } from './Feedback';
import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import DriveLibrary from './DriveLibrary';

const ORANGE = '#F05423';

// Caption textarea that grows to fit its full content, so the whole caption is
// visible without scrolling inside the box (IG captions with hashtags can run
// well past two lines). Re-measures on every value change.
function AutoTextarea({ value, onChange, minRows = 3, style, ...rest }) {
  const ref = useRef(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [value]);
  // Refit when the box width changes (window resize / layout shift), else a rewrap
  // clips the caption because overflow is hidden.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => { onChange(e); fit(); }}
      rows={minRows}
      style={{ ...style, overflow: 'hidden', resize: 'none' }}
      {...rest}
    />
  );
}

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

// ── Poster rendering via SVG (richer than flat canvas), rasterized to JPEG ──
const FF = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const _measure = (() => { try { return document.createElement('canvas').getContext('2d'); } catch { return null; } })();
const wrapFor = (text, font, maxW) => { if (_measure) _measure.font = font; return _measure ? wrapLines(_measure, text, maxW) : [String(text || '')]; };
const tspans = (lines, x, lineH) => lines.map((ln, i) => `<tspan x="${x}" dy="${i ? lineH : 0}">${esc(ln)}</tspan>`).join('');

// Display type = Archivo (the brand font). A rasterized SVG can't see web fonts,
// so we embed Archivo 600/800 as base64 @font-face directly in the SVG. Fetched
// once from Google Fonts, cached. If anything fails we fall back to the system
// stack — same as before, so a network hiccup never breaks poster generation.
const DISP = "'ArchivoP', " + FF;
let _fontCss;
async function getFontFaceCss() {
  if (_fontCss !== undefined) return _fontCss;
  try {
    const css = await (await fetch('https://fonts.googleapis.com/css2?family=Archivo:wght@600;800')).text();
    const faces = [];
    for (const seg of css.split('/* ').slice(1)) {
      if (!seg.startsWith('latin */')) continue;            // latin subset only (smallest, all we need)
      const w = (seg.match(/font-weight:\s*(\d+)/) || [])[1];
      const url = (seg.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
      if (w && url) faces.push({ w, url });
    }
    const out = [];
    for (const f of faces) {
      const blob = await (await fetch(f.url)).blob();
      const data = await new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = j; fr.readAsDataURL(blob); });
      out.push(`@font-face{font-family:'ArchivoP';font-style:normal;font-weight:${f.w};src:url(${data}) format('woff2')}`);
    }
    _fontCss = out.join('');
  } catch { return ''; }   // transient failure: don't cache, retry next poster
  return _fontCss;
}

// Eyebrow/kicker label by poster type — the small tracked line above the
// headline that makes a layout read as designed rather than just text on a box.
const KICK = { seasonal: 'SEASONAL', educational: 'SHOP TIP', testimonial: 'FROM OUR CUSTOMERS' };

let _logo = null;
// Crop the transparent margins off the logo PNG so the white badge can hug the
// actual artwork instead of leaving a big empty box around it.
function trimTransparent(im) {
  const w = im.width, h = im.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0);
  let px; try { px = ctx.getImageData(0, 0, w, h).data; } catch { return null; }
  let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > 12) { found = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (!found) return null;
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const o = document.createElement('canvas'); o.width = cw; o.height = ch;
  o.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
  return { data: o.toDataURL('image/png'), aspect: ch / cw };
}
async function getLogo() {
  if (_logo) return _logo;
  try {
    const blob = await (await fetch('/mt-logo-v2.png')).blob();   // tightly-cropped from the .ai vector; new name busts the asset cache
    const raw = await new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = j; fr.readAsDataURL(blob); });
    const im = await loadImg(raw);
    _logo = trimTransparent(im) || { data: raw, aspect: im.height / im.width };
  } catch { return { data: null, aspect: 0.58 }; }   // transient failure: don't cache, retry next poster
  return _logo;
}

async function svgToBlob(svg, S, bg) {
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  if (bg) {
    // Photo poster: draw the AI hero image cover-fit, then the transparent SVG
    // (scrim + text + logo) goes on top.
    ctx.fillStyle = '#0E0F12'; ctx.fillRect(0, 0, S, S);
    try {
      const b = await loadImg(bg);
      const ar = b.width / b.height; let dw = S, dh = S, dx = 0, dy = 0;
      if (ar > 1) { dh = S; dw = S * ar; dx = (S - dw) / 2; } else { dw = S; dh = S / ar; dy = (S - dh) / 2; }
      ctx.drawImage(b, dx, dy, dw, dh);
    } catch { /* fall through to the SVG, which still has the scrim */ }
  } else { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S); }
  const img = await loadImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  ctx.drawImage(img, 0, 0, S, S);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Poster render failed (canvas returned no blob)');
  return blob;
}

// A rotating library of distinct layouts so output isn't repetitive. No CTAs.
async function renderPoster({ type, headline, subline, locName, bg }) {
  // Ensure Archivo is loaded before we MEASURE wraps with it; otherwise lines are
  // measured at fallback (Helvetica) widths but render in wider Archivo and overflow.
  try { await document.fonts.load('800 76px Archivo'); await document.fonts.ready; } catch {}
  const S = 1080, M = 92;
  const { data: logo, aspect } = await getLogo();
  const img = (x, y, w, op) => logo ? `<image xlink:href="${logo}" x="${x}" y="${y}" width="${w}" height="${w * aspect}"${op != null ? ` opacity="${op}"` : ''}/>` : '';
  const chip = (x, y, w, p = 13) => {
    if (!logo) return '';
    const cw = w + 2 * p, ch = w * aspect + 2 * p;
    // soft shadow (offset translucent rect) so the white badge reads as a card
    // sitting on the photo rather than a flat sticker.
    return `<rect x="${x - p + 3}" y="${y - p + 5}" width="${cw}" height="${ch}" rx="15" fill="#000" opacity="0.18"/>`
      + `<rect x="${x - p}" y="${y - p}" width="${cw}" height="${ch}" rx="15" fill="#fff"/>${img(x, y, w)}`;
  };
  const foot = esc(locName || 'Parkland Transmission · Red Deer, AB');
  const footEl = (x, y, anchor, color) => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FF}" font-weight="500" font-size="24" fill="${color}">${foot}</text>`;
  const stars = (x, y, size, fill) => `<text x="${x}" y="${y}" font-family="${FF}" font-weight="700" font-size="${size}" letter-spacing="${size * 0.12}" fill="${fill}">&#9733;&#9733;&#9733;&#9733;&#9733;</text>`;
  const fontCss = await getFontFaceCss();
  const kick = KICK[type] || 'MISTER TRANSMISSION';
  const kicker = (x, y, anchor, color) => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${DISP}" font-weight="800" font-size="25" letter-spacing="3.5" fill="${color}">${esc(kick)}</text>`;
  // Measure wraps with Archivo (loaded in the document) so line breaks match the
  // embedded display font, not the old Arial fallback.
  const wHL = (px, w) => wrapFor(headline, `800 ${px}px Archivo, ${FF}`, w);
  const wSL = (px, w) => wrapFor(subline, `400 ${px}px ${FF}`, w);
  const head = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>
    <style type="text/css"><![CDATA[${fontCss}]]></style>
    <linearGradient id="dk" x1="0" y1="0" x2="0.5" y2="1"><stop offset="0" stop-color="#23262B"/><stop offset="1" stop-color="#0A0B0D"/></linearGradient>
    <linearGradient id="or" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F8703B"/><stop offset="1" stop-color="#E14313"/></linearGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0A0B0D" stop-opacity="0.15"/><stop offset="0.5" stop-color="#0A0B0D" stop-opacity="0.4"/><stop offset="1" stop-color="#0A0B0D" stop-opacity="0.92"/></linearGradient></defs>`;

  // ── Layouts (general pool) ──
  const editorial = () => { const hl = wHL(76, S - 2 * M), sl = wSL(34, S - 2 * M), hy = 640;
    return `<rect width="${S}" height="${S}" fill="#F6F5F3"/><rect width="${S}" height="10" fill="url(#or)"/>
      ${img(M, M, 250)}${kicker(M, hy - 80, 'start', '#F05423')}
      <text x="${M}" y="${hy}" font-family="${DISP}" font-weight="800" font-size="76" letter-spacing="-1.5" fill="#16181B">${tspans(hl, M, 86)}</text>
      <text x="${M}" y="${hy + hl.length * 86 + 26}" font-family="${FF}" font-weight="400" font-size="34" fill="#525860">${tspans(sl, M, 48)}</text>
      ${footEl(M, S - 50, 'start', '#9AA0A7')}`; };
  const darkCentered = () => { const cx = S / 2, hl = wHL(74, S - 2 * M), sl = wSL(32, S - 2 * M), hy = 540;
    return `<rect width="${S}" height="${S}" fill="url(#dk)"/>${img(515, 560, 760, 0.05)}${img(cx - 110, 150, 220)}
      ${kicker(cx, hy - 64, 'middle', '#F8703B')}
      <text x="${cx}" y="${hy}" text-anchor="middle" font-family="${DISP}" font-weight="800" font-size="74" letter-spacing="-1.5" fill="#fff">${tspans(hl, cx, 84)}</text>
      <rect x="${cx - 45}" y="${hy + hl.length * 84 + 6}" width="90" height="6" fill="#F05423"/>
      <text x="${cx}" y="${hy + hl.length * 84 + 72}" text-anchor="middle" font-family="${FF}" font-weight="400" font-size="32" fill="#B9BEC4">${tspans(sl, cx, 46)}</text>
      ${footEl(cx, S - 50, 'middle', '#7C828A')}`; };
  const orangeRail = () => { const rail = 380, tx = rail + 56, mw = S - tx - M, hl = wHL(62, mw), sl = wSL(31, mw), hy = 410;
    return `<rect width="${S}" height="${S}" fill="#F6F5F3"/><rect width="${rail}" height="${S}" fill="url(#or)"/>
      ${chip(58, 90, rail - 150)}<text x="58" y="${S - 64}" font-family="${DISP}" font-weight="800" font-size="20" letter-spacing="2" fill="#fff" opacity="0.92">MISTER TRANSMISSION</text>
      ${kicker(tx, hy - 56, 'start', '#F05423')}
      <text x="${tx}" y="${hy}" font-family="${DISP}" font-weight="800" font-size="62" letter-spacing="-1.2" fill="#16181B">${tspans(hl, tx, 74)}</text>
      <text x="${tx}" y="${hy + hl.length * 74 + 24}" font-family="${FF}" font-weight="400" font-size="31" fill="#525860">${tspans(sl, tx, 44)}</text>
      ${footEl(S - M, S - 50, 'end', '#9AA0A7')}`; };
  const fullOrange = () => { const hl = wHL(80, S - 2 * M), sl = wSL(34, S - 2 * M), hy = 540;
    return `<rect width="${S}" height="${S}" fill="url(#or)"/>${chip(M, M, 240)}
      ${kicker(M, hy - 74, 'start', 'rgba(255,255,255,0.92)')}
      <text x="${M}" y="${hy}" font-family="${DISP}" font-weight="800" font-size="80" letter-spacing="-1.8" fill="#fff">${tspans(hl, M, 90)}</text>
      <text x="${M}" y="${hy + hl.length * 90 + 26}" font-family="${FF}" font-weight="400" font-size="34" fill="#FFE7DC">${tspans(sl, M, 48)}</text>
      ${footEl(M, S - 50, 'start', 'rgba(255,255,255,0.82)')}`; };
  const diagonal = () => { const hl = wHL(72, S - 2 * M), sl = wSL(32, S - 2 * M);
    return `<rect width="${S}" height="${S}" fill="url(#dk)"/><polygon points="0,${S} 0,730 ${S},560 ${S},${S}" fill="url(#or)"/>
      ${img(M, M, 270)}${kicker(M, 372, 'start', '#F8703B')}
      <text x="${M}" y="440" font-family="${DISP}" font-weight="800" font-size="72" letter-spacing="-1.5" fill="#fff">${tspans(hl, M, 84)}</text>
      <text x="${M}" y="840" font-family="${FF}" font-weight="500" font-size="32" fill="#fff">${tspans(sl, M, 46)}</text>
      ${footEl(S - M, S - 50, 'end', 'rgba(255,255,255,0.85)')}`; };

  // ── Testimonial layouts ──
  const quoteLight = () => { const hl = wHL(56, S - 2 * M), sl = wSL(32, S - 2 * M), qy = 470;
    return `<rect width="${S}" height="${S}" fill="#F6F5F3"/><rect width="${S}" height="12" fill="url(#or)"/>
      <text x="${M - 16}" y="440" font-family="Georgia, serif" font-weight="800" font-size="300" fill="#F05423" opacity="0.12">&#8220;</text>
      ${stars(M, 300, 54, '#F05423')}
      <text x="${M}" y="${qy}" font-family="${DISP}" font-weight="800" font-size="56" letter-spacing="-1" fill="#16181B">${tspans(hl, M, 70)}</text>
      <text x="${M}" y="${qy + hl.length * 70 + 28}" font-family="${FF}" font-weight="500" font-size="32" fill="#6B7178">${tspans(sl, M, 44)}</text>
      ${img(M, S - 300, 240)}${footEl(S - M, S - 50, 'end', '#9AA0A7')}`; };
  const quoteDark = () => { const hl = wHL(58, S - 2 * M), sl = wSL(32, S - 2 * M), qy = 520;
    return `<rect width="${S}" height="${S}" fill="url(#dk)"/>${img(S - M - 210, M, 210)}
      <text x="${M - 16}" y="500" font-family="Georgia, serif" font-weight="800" font-size="300" fill="#F8703B" opacity="0.18">&#8220;</text>
      ${stars(M, 360, 54, '#F8703B')}
      <text x="${M}" y="${qy}" font-family="${DISP}" font-weight="800" font-size="58" letter-spacing="-1" fill="#fff">${tspans(hl, M, 72)}</text>
      <text x="${M}" y="${qy + hl.length * 72 + 28}" font-family="${FF}" font-weight="500" font-size="32" fill="#B9BEC4">${tspans(sl, M, 44)}</text>
      ${footEl(M, S - 50, 'start', '#7C828A')}`; };

  // ── Photo layout (used when an AI hero image is supplied) ──
  // Transparent except a bottom scrim so the photo shows through; logo on a
  // white chip top-left, kicker + headline + subline over the darkened lower band.
  const photo = () => { const hl = wHL(74, S - 2 * M), sl = wSL(32, S - 2 * M), hy = 678;
    return `<rect width="${S}" height="${S}" fill="url(#scrim)"/>${img(M, M, 220)}
      ${kicker(M, hy - 80, 'start', '#F8703B')}
      <text x="${M}" y="${hy}" font-family="${DISP}" font-weight="800" font-size="74" letter-spacing="-1.5" fill="#fff">${tspans(hl, M, 84)}</text>
      <text x="${M}" y="${hy + hl.length * 84 + 26}" font-family="${FF}" font-weight="400" font-size="32" fill="#E7E9EC">${tspans(sl, M, 46)}</text>
      ${footEl(M, S - 50, 'start', 'rgba(255,255,255,0.85)')}`; };

  const pool = type === 'testimonial' ? [quoteLight, quoteDark] : [editorial, darkCentered, orangeRail, fullOrange, diagonal];
  const body = bg ? photo() : pool[Math.floor(Math.random() * pool.length)]();
  return await svgToBlob(head + body + '</svg>', S, bg);
}

// Capture a bay photo -> AI captions -> review/approve. Posting to FB/IG/GBP is
// deferred until Meta/GBP access clears, so "Approve" marks ready-to-post for now.
export default function ApprovalQueue({ locId, locName, onCount, seed, reloadKey, previewLimit, onViewAll }) {
  const { api, token } = useAuth();
  const [configured, setConfigured] = useState(true);
  const [imageGen, setImageGen] = useState(false);   // AI poster art available (OpenAI key set)
  const [posts, setPosts] = useState([]);
  const [approved, setApproved] = useState([]);
  const [deleted, setDeleted] = useState([]);
  const [showDeleted, setShowDeleted] = useState(false);
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
  const [driveOn, setDriveOn] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => { api('/marketing/posts/status').then(s => { setConfigured(!!s.configured); setImageGen(!!s.imageGen); }).catch(() => {}); }, [api]);
  useEffect(() => { api('/marketing/drive/status').then(s => setDriveOn(!!s.configured)).catch(() => {}); }, [api]);

  const reqRef = useRef(0);
  const refresh = useCallback(() => {
    if (!locId) return;
    const rid = ++reqRef.current;              // ignore this result if a newer refresh/location-switch supersedes it
    setLoading(true); setErr(null);
    let failed = false;
    const grab = (s) => api(`/marketing/posts/${locId}/queue?status=${s}`).catch(() => { failed = true; return []; });
    Promise.all([grab('draft'), grab('approved'), grab('deleted')]).then(([d, a, x]) => {
      if (rid !== reqRef.current) return;
      setPosts(d || []); setApproved(a || []); setDeleted(x || []); setLoading(false);
      if (failed) setErr('Could not load the marketing queue — check your connection.');
      if (onCount) onCount({ drafts: (d || []).length, approved: (a || []).length });
    });
  }, [locId, api, onCount]);
  useEffect(() => { refresh(); }, [refresh]);

  // A "shot to grab" was clicked in the rail: prefill the capture note + nudge the user.
  useEffect(() => {
    if (seed && seed.note) {
      setNote(seed.note);
      if (seed.topic) setPosterTopic(seed.topic);
      if (seed.type) setPosterType(seed.type);
      setNotice(`Tagged “${seed.note}”. Add a photo, or hit Generate poster — both will use this.`);
    }
  }, [seed]);

  // A Drive photo was imported elsewhere on the page — pull the new draft in.
  useEffect(() => { if (reloadKey) refresh(); }, [reloadKey, refresh]);

  // Downscale to a sane JPEG before upload: keeps the request small (a full-res
  // phone photo can reset the connection -> "Failed to fetch"), speeds the vision
  // call, and normalizes format. Falls back to the original if it can't decode
  // (e.g. HEIC in Chrome) so the server can return a clear unsupported-type error.
  const isHeic = (f) => /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name || '');
  const downscale = async (input) => {
    const bmp = await createImageBitmap(input);
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size ? blob : input;
  };
  const prepImage = async (file) => {
    try {
      return await downscale(file);                 // Safari decodes HEIC here too
    } catch {
      // Likely HEIC on a non-Safari browser: lazy-load the codec, convert, retry.
      if (isHeic(file)) {
        try {
          const heic2any = (await import('heic2any')).default;
          const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
          return await downscale(Array.isArray(out) ? out[0] : out);
        } catch { return file; }
      }
      return file;
    }
  };

  const onPick = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || '')) {
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
      const copyData = await api('/marketing/posts/poster-copy', { method: 'POST', body: JSON.stringify({ type: posterType, topic: posterTopic }) });
      // AI hero art (when an OpenAI key is set) — the photographic background the
      // copy is laid over. Best-effort: if it fails or is off, fall back to the
      // flat brand template so a poster always renders.
      let bg = null;
      if (imageGen) {
        setNotice('Generating poster art… (this can take ~15s)');
        try { const im = await api('/marketing/posts/poster-image', { method: 'POST', body: JSON.stringify({ type: posterType, topic: posterTopic }) }); bg = (im && im.image) || null; }
        catch (e) { /* fall back to flat template */ }
      }
      const blob = await renderPoster({ type: posterType, ...copyData, locName, bg });
      const res = await fetch(`/api/marketing/posts/${locId}/intake?note=${encodeURIComponent(posterType + ' poster')}`, {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` }, body: blob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Poster upload failed');
      setPosterTopic('');
      setNotice(data.captionError ? 'Poster created — captions failed; write them in or hit Regenerate.' : 'Poster created — it’s in the queue below.');
      refresh();
    } catch (e) { setErr(String(e.message || e)); setNotice(null); }
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
  // Soft delete — for when the wrong image got imported. Recoverable from
  // "Recently deleted" below, so this no longer destroys anything outright.
  const del = async (id) => {
    if (!await askConfirm({ title: 'Delete post', body: 'You can restore it from "Recently deleted" below.', confirmLabel: 'Delete', danger: true })) return;
    try { await api(`/marketing/posts/post/${id}`, { method: 'DELETE' }); refresh(); showToast('Post deleted'); }
    catch (e) { setErr(String(e.message || e)); }
  };
  const restore = async (id) => {
    try { await api(`/marketing/posts/post/${id}/restore`, { method: 'POST' }); setNotice('Post restored.'); refresh(); }
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

  // Per-channel publish chips for approved cards. States: sent ✓ / failed ✗
  // (hover = error) / not_connected ○ (publishing not wired yet) / none —.
  const retryPublish = async (id) => {
    try { const out = await api(`/marketing/posts/post/${id}/publish`, { method: 'POST' }); showToast('Publish re-attempted'); refresh(); }
    catch (e) { showToast(String(e.message || e), 'error'); }
  };
  const PubChips = ({ p }) => {
    const pub = p.publish || {};
    const anyFailed = Object.values(pub).some(x => x.status === 'failed');
    const chip = (ch, label) => {
      const st = pub[ch] && pub[ch].status;
      const col = st === 'sent' ? 'var(--success)' : st === 'failed' ? 'var(--danger)' : 'var(--text3)';
      const mark = st === 'sent' ? '✓' : st === 'failed' ? '✗' : '○';
      const title = st === 'failed' ? (pub[ch].error || 'failed') : st === 'sent' ? 'posted' : 'not connected yet';
      return <span key={ch} title={`${label}: ${title}`} style={{ fontSize: '10.5px', fontFamily: "ui-monospace, Menlo, monospace", color: col, letterSpacing: '0.04em' }}>{label} {mark}</span>;
    };
    return (
      <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
        {chip('fb', 'FB')}{chip('ig', 'IG')}{chip('gbp', 'GBP')}
        {anyFailed && <button onClick={() => retryPublish(p.id)} style={{ fontSize: '10.5px', padding: '2px 8px' }}>Retry</button>}
      </span>
    );
  };
  const shownDrafts = previewLimit ? posts.slice(0, previewLimit) : posts;

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
        <input ref={fileRef} type="file" accept="image/*,.heic,.heif" style={{ display: 'none' }}
          onChange={e => onPick(e.target.files[0])} />
        <button className="primary" disabled={!configured || uploading || !locId}
          onClick={() => fileRef.current && fileRef.current.click()}>
          {uploading ? 'Generating…' : '📷 Capture / add photo'}
        </button>
        {driveOn && (
          <button disabled={!locId} onClick={() => setLibOpen(true)}>🖼 Photo library</button>
        )}
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
        {shownDrafts.map(p => {
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
                      <AutoTextarea value={cur[k] || ''} onChange={e => editField(p.id, k, e.target.value, p.captions)}
                        style={{ width: '100%', fontSize: '12.5px', lineHeight: 1.45 }} />
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
                <button onClick={() => del(p.id)} title="Delete (wrong image)" style={{ color: 'var(--danger)', border: 0, background: 'none' }}>🗑</button>
              </div>
            </div>
          );
        })}
      </div>

      {previewLimit && posts.length > shownDrafts.length && (
        <button onClick={onViewAll} style={{ marginTop: '12px', width: '100%', fontSize: '13px' }}>
          View all {posts.length} awaiting approval →
        </button>
      )}

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
                <PubChips p={p} />
                <button onClick={() => download(p)} style={{ fontSize: '12px' }}>⬇ Image</button>
                <button onClick={() => copy(p.captions?.ig)} style={{ fontSize: '12px' }} title="Copy Instagram caption">IG</button>
                <button onClick={() => copy(p.captions?.fb)} style={{ fontSize: '12px' }} title="Copy Facebook caption">FB</button>
                <button onClick={() => copy(p.captions?.gbp)} style={{ fontSize: '12px' }} title="Copy Google caption">GBP</button>
                <button onClick={() => act(p.id, 'unapprove')} title="Back to drafts" style={{ color: 'var(--text3)', border: 0, background: 'none', fontSize: '13px' }}>↩</button>
                <button onClick={() => act(p.id, 'skip')} title="Archive" style={{ color: 'var(--text3)', border: 0, background: 'none', fontSize: '13px' }}>✕</button>
                <button onClick={() => del(p.id)} title="Delete" style={{ color: 'var(--danger)', border: 0, background: 'none', fontSize: '13px' }}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {deleted.length > 0 && (
        <div style={{ marginTop: '18px' }}>
          <button onClick={() => setShowDeleted(v => !v)}
            style={{ border: 0, background: 'none', color: 'var(--text3)', fontSize: '12px', cursor: 'pointer', padding: '4px 0' }}>
            {showDeleted ? '▾' : '▸'} Recently deleted ({deleted.length})
          </button>
          {showDeleted && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
              {deleted.map(p => (
                <div className="card" key={p.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '10px 12px', flexWrap: 'wrap', opacity: 0.75 }}>
                  {p.image
                    ? <img src={p.image} alt="" onClick={() => setLightbox(p.image)} title="Click to enlarge" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, flexShrink: 0, cursor: 'zoom-in' }} />
                    : <div style={{ width: 44, height: 44, borderRadius: 6, background: 'var(--bg3)', flexShrink: 0 }} />}
                  <div style={{ flex: '1 1 160px', minWidth: 0, fontSize: '12px', color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.captions?.ig || p.note || '(no caption)'}
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text3)' }}>
                    {p.deleted_via === 'purge' ? 'auto-expired' : 'deleted'}
                  </span>
                  <button onClick={() => restore(p.id)} style={{ fontSize: '12px' }}>↩ Restore</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', cursor: 'zoom-out' }}>
          <img src={lightbox} alt="" style={{ maxWidth: '92vw', maxHeight: '92vh', borderRadius: 8, boxShadow: '0 10px 50px rgba(0,0,0,0.6)' }} />
        </div>
      )}

      {libOpen && (
        <DriveLibrary locId={locId} onClose={() => setLibOpen(false)} onImported={refresh} defaultNote={note} />
      )}
    </div>
  );
}
