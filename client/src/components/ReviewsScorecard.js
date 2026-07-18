import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

// Live Google review scorecard (read-only), OPS-styled. Shows the honest
// aggregate (rating, count, monthly delta) and FEATURES only 4★+ quotes —
// the server filters them. Low-star recents surface as a count line so the
// owner still knows to go handle them on the Google Business profile.
// Self-hides if the endpoint isn't configured (no API key / place_id).
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

const Stars = ({ rating, size = 14 }) => {
  const full = Math.round(rating || 0);
  return (
    <span style={{ color: 'var(--accent)', fontSize: size, letterSpacing: '2px' }}>
      {'★★★★★'.slice(0, full)}<span style={{ opacity: 0.25 }}>{'★★★★★'.slice(full)}</span>
    </span>
  );
};

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

  const { rating, total, delta, reviews, demo, low_recent } = data;
  const featured = (reviews || []).slice(0, 2);

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
        <div key={i} style={{ marginTop: '12px', padding: '10px 12px', background: 'var(--bg3)', borderRadius: '9px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' }}>
            <Stars rating={rv.rating} size={11} />
            <span style={{ fontFamily: MONO, fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text3)' }}>
              {rv.author || 'Customer'}{rv.when ? ` · ${rv.when}` : ''}
            </span>
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--text2)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {rv.text}
          </div>
        </div>
      ))}

      {low_recent > 0 && !demo && (
        <div style={{ marginTop: '10px', fontSize: '11.5px', color: 'var(--warning)' }}>
          {low_recent} recent review{low_recent === 1 ? '' : 's'} under 4★
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
