const crypto = require('crypto');
const { JWT_SECRET } = require('../middleware/auth');

// Social publishing engine — Facebook Page + Instagram Business (Meta Graph
// API) and Google Business Profile (Business Profile API v4 localPosts).
//
// SHIPS DARK by design: with no credentials each channel reports
// 'not_connected' and nothing leaves the building. Per-location channel IDs
// live on the locations row (fb_page_id, ig_user_id, gbp_location_name);
// account-level credentials live in env:
//
//   META_PAGE_TOKEN   – Meta system-user token (Business Manager) with
//                       pages_manage_posts + pages_read_engagement +
//                       instagram_basic + instagram_content_publish,
//                       granted on each shop's Page/IG account.
//   GBP_CLIENT_ID / GBP_CLIENT_SECRET / GBP_REFRESH_TOKEN
//                     – OAuth client + refresh token for the Google account
//                       that owns the Business Profiles (requires Google's
//                       Business Profile API access approval, one-time).
//   PUBLISH_DRY_RUN=1 – simulate success end-to-end (records dry-run ids,
//                       posts nothing). For pipeline testing.
//   PUBLIC_BASE_URL   – base for signed public image URLs (IG/GBP fetch the
//                       image over HTTPS; defaults to the Railway domain).

const GRAPH = 'https://graph.facebook.com/v21.0';
const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://mj-lemon-ops-dashboard-production.up.railway.app').replace(/\/$/, '');
const DRY = /^(1|true|yes)$/i.test(process.env.PUBLISH_DRY_RUN || '');

// Signed, expiring public URL for a post's image — no auth header needed, so
// Meta/Google can fetch it, but it's not enumerable and it dies after 24h.
function imageSig(postId, exp) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`post-image:${postId}:${exp}`).digest('base64url');
}
function signedImageUrl(postId) {
  const exp = Date.now() + 24 * 60 * 60 * 1000;
  return `${BASE_URL}/api/marketing/posts/public-image/${postId}?exp=${exp}&sig=${imageSig(postId, exp)}`;
}
function verifyImageSig(postId, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = imageSig(postId, String(exp));
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

async function ensurePublishTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS marketing_post_publish (
    post_id UUID NOT NULL,
    channel VARCHAR(10) NOT NULL,              -- fb | ig | gbp
    status VARCHAR(15) NOT NULL,               -- sent | failed | not_connected
    external_id TEXT,
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (post_id, channel)
  )`);
}

const record = (pool, postId, channel, status, externalId, error) => pool.query(
  `INSERT INTO marketing_post_publish (post_id, channel, status, external_id, error, updated_at)
   VALUES ($1,$2,$3,$4,$5,NOW())
   ON CONFLICT (post_id, channel) DO UPDATE SET status=$3, external_id=$4, error=$5, updated_at=NOW()`,
  [postId, channel, status, externalId || null, error ? String(error).slice(0, 500) : null]
);

async function graphPost(path, params) {
  const r = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.error) throw new Error(`Meta ${r.status}: ${(b.error && b.error.message) || JSON.stringify(b).slice(0, 200)}`);
  return b;
}

async function publishFacebook(pageId, token, imageUrl, caption) {
  if (DRY) return `dry-fb-${Date.now()}`;
  const b = await graphPost(`/${pageId}/photos`, { url: imageUrl, caption, access_token: token });
  return b.post_id || b.id;
}

async function publishInstagram(igUserId, token, imageUrl, caption) {
  if (DRY) return `dry-ig-${Date.now()}`;
  const c = await graphPost(`/${igUserId}/media`, { image_url: imageUrl, caption, access_token: token });
  const p = await graphPost(`/${igUserId}/media_publish`, { creation_id: c.id, access_token: token });
  return p.id;
}

async function gbpAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GBP_CLIENT_ID,
      client_secret: process.env.GBP_CLIENT_SECRET,
      refresh_token: process.env.GBP_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`GBP OAuth ${r.status}: ${JSON.stringify(b).slice(0, 200)}`);
  return b.access_token;
}

// gbpLocationName format: 'accounts/{accountId}/locations/{locationId}'
async function publishGbp(gbpLocationName, imageUrl, summary) {
  if (DRY) return `dry-gbp-${Date.now()}`;
  const token = await gbpAccessToken();
  const r = await fetch(`https://mybusiness.googleapis.com/v4/${gbpLocationName}/localPosts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      languageCode: 'en-CA',
      topicType: 'STANDARD',
      summary: String(summary).slice(0, 1500),
      media: [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }],
    }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GBP ${r.status}: ${JSON.stringify(b).slice(0, 200)}`);
  return b.name;
}

// Publish an approved post to every channel its location has configured.
// Never throws: each channel's outcome is recorded on marketing_post_publish.
async function publishPost(pool, postId) {
  await ensurePublishTable(pool);
  const { rows } = await pool.query(
    `SELECT p.id, p.location_id, p.caption_fb, p.caption_ig, p.caption_gbp, p.image_data,
            l.fb_page_id, l.ig_user_id, l.gbp_location_name
       FROM marketing_post p JOIN locations l ON l.id = p.location_id
      WHERE p.id = $1 AND p.deleted_at IS NULL`, [postId]);
  if (!rows.length) return { error: 'post not found' };
  const p = rows[0];
  if (!p.image_data) return { error: 'post has no image' };
  const imageUrl = signedImageUrl(p.id);
  const metaToken = process.env.META_PAGE_TOKEN;
  const gbpReady = process.env.GBP_CLIENT_ID && process.env.GBP_CLIENT_SECRET && process.env.GBP_REFRESH_TOKEN;

  const run = async (channel, configured, connected, fn) => {
    if (!configured || (!connected && !DRY)) { await record(pool, p.id, channel, 'not_connected', null, null); return; }
    try {
      const id = await fn();
      await record(pool, p.id, channel, 'sent', id, null);
    } catch (e) {
      await record(pool, p.id, channel, 'failed', null, e.message);
    }
  };

  await Promise.all([
    run('fb', p.fb_page_id && p.caption_fb, metaToken, () => publishFacebook(p.fb_page_id, metaToken, imageUrl, p.caption_fb)),
    run('ig', p.ig_user_id && p.caption_ig, metaToken, () => publishInstagram(p.ig_user_id, metaToken, imageUrl, p.caption_ig)),
    run('gbp', p.gbp_location_name && p.caption_gbp, gbpReady, () => publishGbp(p.gbp_location_name, imageUrl, p.caption_gbp)),
  ]);

  const { rows: results } = await pool.query('SELECT channel, status, external_id, error FROM marketing_post_publish WHERE post_id=$1', [p.id]);
  return { results };
}

module.exports = { publishPost, ensurePublishTable, signedImageUrl, verifyImageSig, DRY };
