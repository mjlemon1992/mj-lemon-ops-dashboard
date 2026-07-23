import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

// Live Google review scorecard, OPS-styled. Shows the honest aggregate
// (rating, count, monthly delta), FEATURES only 4★+ quotes, and surfaces
// recent sub-4★ reviews in a "Needs response" strip.
//
// Replies: the server-side watcher AUTO-DRAFTS a reply when a new review
// lands (and pushes a notification), so watched reviews arrive here with
// the draft already written — editable box + Copy + Google link + Mark
// posted. Unwatched/older reviews keep the on-demand "Draft reply" button.
// Pasting is deliberately the human's job — nothing is ever posted from
// here (future Google Business API auto-post slots in at "Mark posted").
// Self-hides if the endpoint isn't configured.
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

const Stars = ({ rating, size = 14 }) => {
  const full = Math.round(rating || 0);
  return (
    <span role="img" aria-label={`${rating ?? 0} of 5 stars`}
      style={{ color: 'var(--accent)', fontSize: size, letterSpacing: '2px' }}>
      {'★★★★★'.slice(0, full)}<span style={{ opacity: 0.25 }}>{'★★★★★'.slice(full)}</span>
    </span>
  );
};

// Copy that never lies: clipboard API first, execCommand fallback for
// non-secure/older mobile contexts, and the promise REJECTS on failure so the
// button can say so instead of showing a false "Copied ✓".
const copyText = (t) => new Promise((resolve, reject) => {
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy blocked'));
    } catch (e) { reject(e); }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(resolve, fallback);
  } else fallback();
});

// Per-review reply flow. `stored` is the watcher's row for this review
// (auto-draft + lifecycle status), when one exists.
function ReplyDraft({ locId, review, stored }) {
  const { api } = useAuth();
  const [draft, setDraft] = useState(stored && stored.status !== 'dismissed' ? stored.draft : null);
  const [status, setStatus] = useState((stored && stored.status) || null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState(null);

  // The watcher's auto-draft can arrive AFTER first paint (data refresh without
  // a remount) — adopt it only where the user hasn't typed or decided anything,
  // so a stored draft never clobbers an in-progress edit.
  useEffect(() => {
    if (!stored) return;
    setStatus((s) => s || stored.status || null);
    setDraft((d) => (d == null && stored.status !== 'dismissed' ? stored.draft : d));
  }, [stored]);

  const generate = () => {
    setBusy(true); setErr(null);
    api(`/marketing/reviews/${locId}/draft-reply`, {
      method: 'POST',
      body: JSON.stringify({
        author: review.author, rating: review.rating, text: review.text,
        ...(stored ? { review_time: stored.review_time } : {}),
      }),
    })
      .then((d) => setDraft((d && d.draft) || ''))
      .catch((e) => setErr(String(e.message || e)))
      .finally(() => setBusy(false));
  };

  const copy = () => {
    copyText(draft || '')
      .then(() => { setErr(null); setCopied(true); setTimeout(() => setCopied(false), 1600); })
      .catch(() => setErr("Couldn't copy — select the text and copy manually."));
  };

  const markPosted = () => {
    setBusy(true); setErr(null);
    api(`/marketing/reviews/${locId}/reply-status`, {
      method: 'POST',
      body: JSON.stringify({ review_time: stored.review_time, author: review.author, status: 'posted' }),
    })
      .then(() => setStatus('posted'))
      .catch((e) => setErr(String(e.message || e)))
      .finally(() => setBusy(false));
  };

  if (status === 'posted') {
    return (
      <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--success)' }}>
        Replied ✓ — posted on Google
      </div>
    );
  }

  if (draft == null) {
    return (
      <div style={{ marginTop: '7px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button onClick={generate} disabled={busy} style={{ fontSize: '11px', padding: '3px 9px' }}>
          {busy ? 'Drafting…' : '✍ Draft reply'}
        </button>
        {err && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{err}</span>}
      </div>
    );
  }
  return (
    <div style={{ marginTop: '7px' }}>
      {stored && stored.draft && (
        <div style={{ fontFamily: MONO, fontSize: '9.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: '3px' }}>
          Auto-drafted
        </div>
      )}
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3}
        style={{ width: '100%', fontSize: '12px', lineHeight: 1.5, padding: '7px 9px', boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '5px', flexWrap: 'wrap' }}>
        <button className="primary" onClick={copy} style={{ fontSize: '11px', padding: '3px 10px' }}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <a href="https://business.google.com/reviews" target="_blank" rel="noreferrer"
          style={{ fontSize: '11px', color: 'var(--accent)' }}>
          Paste on Google ↗
        </a>
        {stored && (
          <button onClick={markPosted} disabled={busy} title="I've pasted this reply on Google"
            style={{ fontSize: '11px', padding: '3px 9px' }}>
            Mark posted
          </button>
        )}
        <button onClick={generate} disabled={busy} style={{ fontSize: '11px', padding: '3px 9px', marginLeft: 'auto' }}>
          {busy ? '…' : 'Redraft'}
        </button>
      </div>
      {err && <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

export default function ReviewsScorecard({ locId }) {
  const { api } = useAuth();
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!locId) return;
    let cancelled = false;
    setData(null); setHidden(false);
    api(`/marketing/reviews/${locId}`)
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setHidden(true); });   // not configured -> hide
    return () => { cancelled = true; };
  }, [locId, api]);

  if (hidden || !data) return null;

  const { rating, total, delta, reviews, demo, low_recent, attention, drafts } = data;
  const featured = (reviews || []).slice(0, 2);
  const lows = (attention || []).slice(0, 2);
  const storedFor = (rv) => (drafts || []).find(d =>
    Number(d.review_time) === Number(rv.time) && (d.author || '') === (rv.author || ''));

  return (
    <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px', marginBottom: '12px' }}>
        <span style={{ fontFamily: MONO, fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text3)' }}>Google reviews</span>
        <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: demo ? 'var(--warning)' : 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: demo ? 'var(--warning)' : 'var(--success)', display: 'inline-block' }} />
          {demo ? 'sample' : 'live'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontFamily: 'var(--font-disp)', fontSize: '38px', fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {rating != null ? Number(rating).toFixed(1) : '—'}
        </span>
        <div>
          <Stars rating={rating} />
          <div style={{ fontFamily: MONO, fontSize: '10.5px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text3)', marginTop: '3px' }}>
            {total != null ? `${Number(total).toLocaleString('en-CA')} reviews` : '—'}
            {delta > 0 && <span style={{ color: 'var(--success)' }}> · +{delta} this mo</span>}
          </div>
        </div>
      </div>

      {featured.map((rv, i) => (
        <div key={rv.time || i} style={{ marginTop: '12px', padding: '10px 12px', background: 'var(--bg3)', borderRadius: '9px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' }}>
            <Stars rating={rv.rating} size={11} />
            <span style={{ fontFamily: MONO, fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text3)' }}>
              {rv.author || 'Customer'}{rv.when ? ` · ${rv.when}` : ''}
            </span>
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--text2)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {rv.text}
          </div>
          {!demo && <ReplyDraft locId={locId} review={rv} stored={storedFor(rv)} />}
        </div>
      ))}

      {/* The reviews that most need a response — low-star recents, with the
          same drafting flow. Tone rules live server-side. */}
      {lows.length > 0 && !demo && (
        <div style={{ marginTop: '12px' }}>
          <div style={{ fontFamily: MONO, fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--warning)', marginBottom: '6px' }}>
            Needs response
          </div>
          {lows.map((rv, i) => (
            <div key={rv.time || i} style={{ marginTop: i ? '8px' : 0, padding: '10px 12px', background: 'var(--bg3)', borderRadius: '9px', borderLeft: '2px solid var(--warning)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' }}>
                <Stars rating={rv.rating} size={11} />
                <span style={{ fontFamily: MONO, fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text3)' }}>
                  {rv.author || 'Customer'}{rv.when ? ` · ${rv.when}` : ''}
                </span>
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--text2)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {rv.text || '(star rating only, no text)'}
              </div>
              <ReplyDraft locId={locId} review={rv} stored={storedFor(rv)} />
            </div>
          ))}
        </div>
      )}
      {low_recent > lows.length && !demo && (
        <div style={{ marginTop: '10px', fontSize: '11.5px', color: 'var(--warning)' }}>
          {low_recent - lows.length} more under 4★ · handle on Google
        </div>
      )}

      {demo && (
        <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--warning)' }}>
          Sample data — set the Google API key + place_id to go live.
        </div>
      )}
    </div>
  );
}
