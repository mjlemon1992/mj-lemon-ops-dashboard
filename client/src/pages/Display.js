import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';

const REFRESH_MS = 60 * 1000;          // DB-only server-side — cheap to poll, and the
                                       // live clock chips need to track the bay closely
const PERIOD_FLIP_MS = 15 * 1000;      // tech panel holds each of MTD / YTD this long
const NOTICE_FLIP_MS = 10 * 1000;      // text-banner rotation on the board page
const BOARD_MS = 40 * 1000;            // revenue/tech page holds this long...
const POSTER_MS = 15 * 1000;           // ...then each poster takes the full screen
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-CA');
const hrs = n => (n == null ? '—' : `${Math.round(Number(n) * 10) / 10}`);

const NOTICE_STYLE = {
  notice:      { icon: 'ℹ', color: 'var(--accent)',  label: 'NOTICE' },
  celebration: { icon: '🎉', color: 'var(--success)', label: 'SHOUT-OUT' },
  safety:      { icon: '⚠', color: 'var(--danger)',  label: 'SAFETY' },
  poster:      { icon: '', color: 'var(--accent)',    label: '' }
};

export default function Display() {
  const { locationId } = useParams();
  const pinKey = `display_pin_${locationId}`;
  const [pin, setPin] = useState(() => sessionStorage.getItem(pinKey) || '');
  const [entered, setEntered] = useState(() => !!sessionStorage.getItem(pinKey));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [period, setPeriod] = useState('mtd');   // flips mtd <-> ytd when ytd data exists
  const [fade, setFade] = useState(true);        // fade the tech panel through the flip
  const [noticeIdx, setNoticeIdx] = useState(0);
  const [posterIdx, setPosterIdx] = useState(0);
  const [showPoster, setShowPoster] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async (thePin) => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/display/${locationId}?pin=${encodeURIComponent(thePin)}`, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { setError('Incorrect PIN'); setEntered(false); sessionStorage.removeItem(pinKey); setLoading(false); return; }
      if (!res.ok) { setError(body.error || `Error ${res.status}`); setLoading(false); return; }
      sessionStorage.setItem(pinKey, thePin);
      setData(body); setEntered(true); setUpdatedAt(new Date());
    } catch (e) {
      setError('Network error — retrying on next refresh');
    }
    setLoading(false);
  }, [locationId, pinKey]);

  // Initial load + auto-refresh while unlocked.
  useEffect(() => {
    if (!entered || !pin) return undefined;
    load(pin);
    timer.current = setInterval(() => load(pin), REFRESH_MS);
    return () => timer.current && clearInterval(timer.current);
  }, [entered, pin, load]);

  // Cycle the tech panel between this-month and year-to-date. Only flip when
  // there is YTD data to show; fade out, swap, fade back in.
  const hasYtd = !!(data && data.techs_ytd && data.techs_ytd.length);
  useEffect(() => {
    if (!hasYtd) { setPeriod('mtd'); return undefined; }
    const t = setInterval(() => {
      setFade(false);
      setTimeout(() => { setPeriod(p => (p === 'mtd' ? 'ytd' : 'mtd')); setFade(true); }, 400);
    }, PERIOD_FLIP_MS);
    return () => clearInterval(t);
  }, [hasYtd]);

  // Posters (image posts) take over the FULL screen on a page-flip cycle so
  // they never bury the numbers: board page for BOARD_MS, then each poster
  // for POSTER_MS, then back. Text notices stay as a slim banner on the board.
  const notices = (data && data.notices) || [];
  const posters = notices.filter(n => n.kind === 'poster' && (n.image || n.image_url));
  const banners = notices.filter(n => !(n.kind === 'poster' && (n.image || n.image_url)));

  // Rotate text banners on the board page.
  useEffect(() => {
    if (banners.length < 2) { setNoticeIdx(0); return undefined; }
    const t = setInterval(() => setNoticeIdx(i => (i + 1) % banners.length), NOTICE_FLIP_MS);
    return () => clearInterval(t);
  }, [banners.length]);

  // Page-flip: board <-> full-screen poster(s).
  useEffect(() => {
    if (!posters.length) { setShowPoster(false); return undefined; }
    let t;
    let cancelled = false;
    const showBoard = () => {
      t = setTimeout(() => {
        if (cancelled) return;
        setShowPoster(true);
        t = setTimeout(() => {
          if (cancelled) return;
          setShowPoster(false);
          setPosterIdx(i => (i + 1) % posters.length);
          showBoard();
        }, POSTER_MS);
      }, BOARD_MS);
    };
    showBoard();
    return () => { cancelled = true; clearTimeout(t); };
  }, [posters.length]);

  // PIN entry screen
  if (!entered) {
    return (
      <div style={wrap}>
        <form onSubmit={e => { e.preventDefault(); if (pin) setEntered(true); }} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '-1px', marginBottom: '6px' }}>OPS DISPLAY</div>
          <div style={{ color: 'var(--text3)', fontSize: '14px', marginBottom: '24px' }}>Enter the display PIN for this location</div>
          <input
            autoFocus type="text" inputMode="text" value={pin}
            onChange={e => setPin(e.target.value.slice(0, 12))}
            placeholder="PIN"
            style={{ fontSize: '32px', letterSpacing: '8px', textAlign: 'center', padding: '12px 20px', width: '220px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)' }}
          />
          <div><button className="primary" type="submit" style={{ marginTop: '20px', fontSize: '16px', padding: '10px 28px' }}>Show board</button></div>
          {error && <div style={{ color: 'var(--danger)', marginTop: '16px', fontSize: '14px' }}>{error}</div>}
        </form>
      </div>
    );
  }

  if (!data) {
    return <div style={wrap}><div style={{ color: 'var(--text3)', fontSize: '18px' }}>{error || 'Loading board…'}</div></div>;
  }

  const target = data.target;
  const pct = data.pct_to_target;
  const barPct = pct == null ? 0 : Math.max(2, Math.min(100, pct));
  const over = target != null && data.revenue >= target;
  const onPace = data.pace_pct != null && data.pace_pct >= 100;
  const barColor = over ? 'var(--success)' : (onPace ? 'var(--success)' : (data.pace_pct != null && data.pace_pct >= 90 ? 'var(--warning)' : 'var(--danger)'));
  const effTarget = data.efficiency_target || 80;

  const showYtd = period === 'ytd' && hasYtd;
  const techRows = showYtd ? data.techs_ytd : data.techs;
  const notice = banners.length ? banners[Math.min(noticeIdx, banners.length - 1)] : null;
  const nStyle = notice ? (NOTICE_STYLE[notice.kind] || NOTICE_STYLE.notice) : null;
  const poster = posters.length ? posters[posterIdx % posters.length] : null;

  // Full-screen poster page — flips back to the board automatically.
  if (showPoster && poster) {
    return (
      <div style={{ ...wrap, alignItems: 'stretch', justifyContent: 'flex-start', padding: '24px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
            <span style={{ fontSize: '26px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '-1px' }}>OPS</span>
            <span style={{ fontFamily: 'var(--font-disp)', fontSize: '26px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', color: 'var(--text)' }}>{data.location.name}</span>
          </div>
          {posters.length > 1 && <NoticeDots count={posters.length} idx={posterIdx % posters.length} />}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
          {/* No title/body caption here: the poster IS the message (AI posters bake
              the words into the design), so a caption just echoed the same text. */}
          <img src={poster.image || poster.image_url} alt={poster.title || 'Poster'}
            style={{ maxWidth: '96%', maxHeight: '84vh', objectFit: 'contain', borderRadius: '14px' }} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...wrap, alignItems: 'stretch', justifyContent: 'flex-start', padding: '32px 40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
          <span style={{ fontSize: '26px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '-1px' }}>OPS</span>
          <span style={{ fontFamily: 'var(--font-disp)', fontSize: '26px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', color: 'var(--text)' }}>{data.location.name}</span>
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text3)' }}>
          {loading ? 'Refreshing…' : `Updated ${updatedAt ? updatedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : ''}`} · auto-refresh 1 min
        </div>
      </div>

      {/* Text notices — slim banner above the numbers; posters get their own
          full-screen page on the flip cycle instead of living here. */}
      {notice ? (
        <div key={notice.id} style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', marginBottom: '28px', background: 'var(--bg2)', border: `1px solid ${nStyle.color}`, borderLeft: `8px solid ${nStyle.color}`, borderRadius: '16px', padding: '20px 28px' }}>
          <div style={{ fontSize: '40px', lineHeight: 1 }}>{nStyle.icon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '11px', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: nStyle.color, marginBottom: '4px' }}>{nStyle.label}</div>
            {notice.title && <div style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text)' }}>{notice.title}</div>}
            {notice.body && <div style={{ fontSize: '19px', color: 'var(--text2)', marginTop: '6px', whiteSpace: 'pre-wrap' }}>{notice.body}</div>}
          </div>
          {(notice.image || notice.image_url) && <img src={notice.image || notice.image_url} alt="" style={{ maxHeight: '120px', maxWidth: '200px', objectFit: 'contain', borderRadius: '10px' }} />}
          {banners.length > 1 && <NoticeDots count={banners.length} idx={noticeIdx} vertical />}
        </div>
      ) : null}

      {/* Revenue vs target bar */}
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', padding: '28px 32px', marginBottom: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <div style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>Revenue this month</div>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: '72px', fontWeight: 700, color: 'var(--text)', lineHeight: 1.02, fontVariantNumeric: 'tabular-nums' }}>{money(data.revenue)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>Target</div>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: '44px', fontWeight: 700, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{target != null ? money(target) : 'Not set'}</div>
          </div>
        </div>

        <div style={{ height: '34px', background: 'var(--bg3)', borderRadius: '17px', overflow: 'hidden', position: 'relative' }}>
          <div style={{ width: `${barPct}%`, height: '100%', background: barColor, borderRadius: '17px', transition: 'width 0.6s ease' }} />
          {pct != null && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: 700, color: 'var(--text)' }}>
              {pct}% of target
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '14px', fontSize: '18px' }}>
          <div style={{ color: barColor, fontWeight: 700 }}>
            {target == null ? 'Set a monthly target' : over ? `${money(data.revenue - target)} over target 🎉` : `${money(data.gap)} to go`}
          </div>
          {data.pace_pct != null && (
            <div style={{ color: 'var(--text3)' }}>{data.pace_pct}% of pace</div>
          )}
        </div>
      </div>

      {/* Google reviews — rating + new reviews this month */}
      {data.reviews && data.reviews.rating != null && (
        <div style={{ display: 'flex', gap: '28px', marginBottom: '28px' }}>
          <div style={{ flex: 1, background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', padding: '24px 32px' }}>
            <div style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>Google rating</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px', marginTop: '8px' }}>
              <span style={{ fontFamily: 'var(--font-disp)', fontSize: '60px', fontWeight: 700, lineHeight: 1 }}>{Number(data.reviews.rating).toFixed(1)}</span>
              <span style={{ fontSize: '28px', color: 'var(--accent)', letterSpacing: '2px' }}>★★★★★</span>
            </div>
            <div style={{ fontSize: '16px', color: 'var(--text3)', marginTop: '10px' }}>
              {data.reviews.total != null ? `${Number(data.reviews.total).toLocaleString('en-CA')} reviews total` : ''}
            </div>
          </div>
          <div style={{ flex: 1, background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', padding: '24px 32px' }}>
            <div style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>New reviews this month</div>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: '60px', fontWeight: 700, lineHeight: 1, marginTop: '8px', color: data.reviews.delta > 0 ? 'var(--success)' : 'var(--text)' }}>
              {data.reviews.delta > 0 ? `+${data.reviews.delta}` : (data.reviews.delta || 0)}
            </div>
            <div style={{ fontSize: '16px', color: 'var(--text3)', marginTop: '10px' }}>month to date</div>
          </div>
        </div>
      )}

      {/* Tech leaderboard — cycles between this month and year-to-date */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
          Technicians · hours sold {!showYtd && data.totals && `(${hrs(data.totals.hours_sold)} sold / ${hrs(data.totals.hours_billed)} billed)`}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '13px', fontWeight: 800, letterSpacing: '0.1em', padding: '4px 14px', borderRadius: '12px', background: !showYtd ? 'var(--accent)' : 'var(--bg3)', color: !showYtd ? '#1a1a1a' : 'var(--text3)', transition: 'all 0.3s' }}>THIS MONTH</span>
          {hasYtd && <span style={{ fontSize: '13px', fontWeight: 800, letterSpacing: '0.1em', padding: '4px 14px', borderRadius: '12px', background: showYtd ? 'var(--accent)' : 'var(--bg3)', color: showYtd ? '#1a1a1a' : 'var(--text3)', transition: 'all 0.3s' }}>YEAR TO DATE</span>}
        </div>
      </div>
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', overflow: 'hidden', opacity: fade ? 1 : 0, transition: 'opacity 0.4s ease' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.2fr', padding: '12px 24px', borderBottom: '0.5px solid var(--border)', fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          <div>Technician</div>
          <div style={{ textAlign: 'right' }}>Billed</div>
          <div style={{ textAlign: 'right' }}>Sold</div>
          <div style={{ textAlign: 'right' }}>Efficiency</div>
        </div>
        {techRows.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text3)' }}>{showYtd ? 'No YTD tech hours yet.' : 'No tech hours yet this month.'}</div>
        )}
        {techRows.map(t => {
          const eff = t.efficiency;
          const effColor = eff == null ? 'var(--text3)' : (eff >= effTarget ? 'var(--success)' : (eff >= effTarget - 10 ? 'var(--warning)' : 'var(--danger)'));
          // Live kiosk status: mirror the time clock on the board (matched by
          // folded first name, same rule the bonus pull uses).
          const nf = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/)[0];
          const c = (data.clock || []).find(x => nf(x.name) && nf(t.tech_name).startsWith(nf(x.name)));
          const tmin = ts => Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
          const tfmt = ts => new Date(ts).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
          const chip = !c ? null
            : c.status === 'on' ? { txt: `🟢 In since ${tfmt(c.clock_in)}`, col: 'var(--success)' }
            : c.status === 'break' ? { txt: `🟡 Break · ${tmin(c.break_started_at)} min`, col: 'var(--warning)' }
            : { txt: '⚫ Clocked out', col: 'var(--text3)' };
          return (
            <div key={t.tech_id || t.tech_name} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.2fr', padding: '16px 24px', borderBottom: '0.5px solid var(--border)', alignItems: 'center' }}>
              <div style={{ fontSize: '22px', fontWeight: 600, color: (c && c.color) || 'var(--text)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                {c && c.photo && <img src={c.photo} alt="" style={{ width: '34px', height: '34px', borderRadius: '50%', objectFit: 'cover', border: c.color ? `2px solid ${c.color}` : 'none' }} />}
                {t.tech_name}
                {chip && <span style={{ fontSize: '13px', fontWeight: 600, color: chip.col, whiteSpace: 'nowrap' }}>{chip.txt}</span>}
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-disp)', fontSize: '24px', fontWeight: 700, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{hrs(t.hours_billed)}</div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-disp)', fontSize: '24px', fontWeight: 700, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{hrs(t.hours_sold)}</div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-disp)', fontSize: '27px', fontWeight: 700, color: effColor, fontVariantNumeric: 'tabular-nums' }}>{eff == null ? '—' : `${eff}%`}</div>
            </div>
          );
        })}
      </div>

      {/* All-locations revenue standings (revenue only) */}
      {data.leaderboard && data.leaderboard.length >= 2 && (
        <div style={{ marginTop: '28px' }}>
          <div style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: '10px' }}>
            Group standings · revenue to date
          </div>
          <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', overflow: 'hidden' }}>
            {data.leaderboard.map(loc => (
              <div key={loc.id} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '14px 24px', borderBottom: '0.5px solid var(--border)', background: loc.is_current ? 'var(--bg3)' : 'transparent' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: 800, color: loc.rank === 1 ? '#1a1a1a' : 'var(--text2)', background: loc.rank === 1 ? 'var(--accent)' : 'var(--bg3)' }}>{loc.rank}</div>
                <div style={{ flex: 1, fontSize: '22px', fontWeight: loc.is_current ? 700 : 500, color: 'var(--text)' }}>
                  {loc.name}{loc.is_current ? ' (this shop)' : ''}
                </div>
                <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--text)' }}>{money(loc.revenue)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 'auto', paddingTop: '20px', fontSize: '12px', color: 'var(--text3)', textAlign: 'center' }}>
        Efficiency = hours sold ÷ available hours ({data.location.weekly_hours || 40}h/wk base, minus {data.location.province?.toUpperCase()} stat holidays) · target {effTarget}%
      </div>
    </div>
  );
}

function NoticeDots({ count, idx, vertical }) {
  return (
    <div style={{ display: 'flex', flexDirection: vertical ? 'column' : 'row', gap: '6px', justifyContent: 'center', padding: vertical ? 0 : '0 0 12px' }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ width: '8px', height: '8px', borderRadius: '50%', background: i === idx ? 'var(--accent)' : 'var(--bg3)' }} />
      ))}
    </div>
  );
}

const wrap = {
  minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px'
};
