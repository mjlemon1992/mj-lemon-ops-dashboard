import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

// Live Google review scorecard (read-only). Pulls rating + count + recent reviews from the
// /marketing/reviews endpoint (Google Places, cached server-side). No reply controls — those
// live in Shopmonkey. Self-hides if the endpoint isn't configured yet (no API key / place_id),
// so the rail stays clean until Google is wired up.
const Stars = ({ rating }) => {
  const full = Math.round(rating || 0);
  return (
    <span style={{ color: 'var(--accent)', fontSize: '13px', letterSpacing: '1px' }}>
      {'★★★★★'.slice(0, full)}<span style={{ color: 'var(--border2)' }}>{'★★★★★'.slice(full)}</span>
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
      .catch(() => { if (!cancelled) setHidden(true); });   // not configured / no place_id -> hide
    return () => { cancelled = true; };
  }, [locId, api]);

  if (hidden || !data) return null;

  const { rating, total, delta, reviews, demo } = data;
  const recent = (reviews || [])[0];

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px', marginBottom: '10px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>Google reviews</span>
        {demo ? (
          <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)', display: 'inline-block' }} />sample
          </span>
        ) : (
          <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />live
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '29px', fontWeight: 600, letterSpacing: '-.02em', lineHeight: 1 }}>
          {rating != null ? Number(rating).toFixed(1) : '—'}
        </span>
        <div>
          <Stars rating={rating} />
          <div style={{ fontSize: '11px', color: 'var(--text3)' }}>
            {total != null ? `${Number(total).toLocaleString('en-CA')} reviews` : '—'}
            {delta > 0 && <span style={{ color: 'var(--success)' }}> · +{delta} this mo</span>}
          </div>
        </div>
      </div>

      {recent && (
        <div style={{ marginTop: '11px', paddingTop: '10px', borderTop: '0.5px solid var(--border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '3px' }}>
            {recent.author || 'Customer'}{recent.when ? ` · ${recent.when}` : ''}{recent.rating ? ` · ${'★'.repeat(recent.rating)}` : ''}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text2)', lineHeight: 1.45 }}>{recent.text}</div>
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
